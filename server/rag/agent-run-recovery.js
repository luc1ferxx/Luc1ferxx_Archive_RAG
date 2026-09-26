import { AGENT_RUN_STATUSES } from "./agent-runs.js";
import {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
} from "./agent-run-steps.js";
import {
  buildStepReplaySafetyAssessment,
  getAutoReplaySafeStepTypes,
} from "./agent-run-step-replay-safety.js";
import { recordRagTrace } from "./observability.js";
import { runAsDatabaseSystem, runWithDatabaseTenant } from "./postgres-tenant.js";
import { normalizeText } from "../lib/normalize-text.js";
import {
  reconcileExecutionGraphCheckpoint,
  sealExecutionGraphCheckpoint,
} from "./agent-execution-graph-checkpoint.js";

const normalizeMode = (value) => {
  const mode = normalizeText(value).toLowerCase();

  return ["auto", "manual", "off"].includes(mode) ? mode : "manual";
};

const toArray = (value) => (Array.isArray(value) ? value : []);

export const MANUAL_RECOVERY_EVENT = "manual_recovery_required";
const AUTO_RECOVERY_STARTED_EVENT = "auto_recovery_started";
const AUTO_RECOVERY_COMPLETED_EVENT = "auto_recovery_completed";
const AUTO_RECOVERY_FAILED_EVENT = "auto_recovery_failed";

export const DEFAULT_AUTO_RECOVERY_STEP_TYPES = Object.freeze(
  getAutoReplaySafeStepTypes()
);

export const AUTO_RECOVERY_STEP_STATUS_VALUES = Object.freeze([
  AGENT_RUN_STEP_STATUSES.paused,
  AGENT_RUN_STEP_STATUSES.pending,
  AGENT_RUN_STEP_STATUSES.running,
]);

const AUTO_RECOVERY_STEP_STATUSES = new Set(AUTO_RECOVERY_STEP_STATUS_VALUES);

const hasManualRecoveryEvent = (run = {}) =>
  toArray(run.events).some((event) => event.type === MANUAL_RECOVERY_EVENT);

const hasPendingApprovalGate = (run = {}) =>
  toArray(run.approvalGates).some(
    (gate) => normalizeText(gate.status).toLowerCase() === "pending"
  ) ||
  toArray(run.steps).some(
    (step) =>
      step.kind === AGENT_RUN_STEP_KINDS.approvalGate &&
      AUTO_RECOVERY_STEP_STATUSES.has(step.status)
  );

const hasExecutedGuardedGraph = (run = {}) =>
  toArray(run.events).some(
    (event) =>
      event.type === "skill_graph_planned" &&
      event.payload?.mode === "guarded" &&
      event.payload?.executed === true
  );

const hasGraphOnlyStoredExecutionPlan = (run = {}) => {
  const planningEvents = toArray(run.events).filter(
    (event) => event.type === "execution_planned"
  );
  const stepIds = planningEvents.at(-1)?.payload?.planner?.stepIds;

  return Array.isArray(stepIds) &&
    stepIds.length === 1 &&
    stepIds[0] === "custom_skills";
};

// The current startup continuation reconstructs only the legacy custom-Skill
// stage. A heterogeneous v3 graph has a distinct checkpoint and must remain
// manual until its complete outer-stage continuation is wired end to end.
const hasLegacyResumableGraphContract = (checkpoint) =>
  checkpoint?.version === "v1" &&
  ["v1", "v2"].includes(checkpoint.graph?.version);

export const findAutoRecoverableStep = ({
  run = {},
  safeStepTypes = DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} = {}) => {
  if (hasPendingApprovalGate(run)) {
    return {
      reason: "pending_approval_gate",
      safety: null,
      step: null,
    };
  }

  const assessments = toArray(run.steps)
    .filter((runStep) => AUTO_RECOVERY_STEP_STATUSES.has(runStep.status))
    .map((runStep) =>
      buildStepReplaySafetyAssessment({
        autoReplayStepTypes: safeStepTypes,
        run,
        step: runStep,
      })
    );
  const safeAssessment =
    assessments.find((assessment) => assessment.canAutoReplay) ?? null;
  const blockedAssessment =
    assessments.find((assessment) => assessment.reasonCodes.length > 0) ?? null;
  const step = safeAssessment
    ? toArray(run.steps).find((runStep) => runStep.id === safeAssessment.stepId)
    : null;

  return {
    reason: safeAssessment
      ? "safe_step_ready"
      : blockedAssessment?.reasonCodes[0] ?? "no_safe_recoverable_step",
    safety: safeAssessment ?? blockedAssessment,
    step: step ?? null,
  };
};

const serializeError = (error, fallbackMessage) =>
  error instanceof Error ? error.message : fallbackMessage;

const buildRecoveryPatch = ({
  mode,
  now,
  requestedMode = mode,
  reason,
  run,
  step,
} = {}) => {
  const recovery = {
    mode,
    originalStatus: run.status,
    reason,
    recoveredAt: now(),
  };

  if (requestedMode && requestedMode !== mode) {
    recovery.requestedMode = requestedMode;
  }

  if (step?.id) {
    recovery.stepId = step.id;
    recovery.stepType = step.type ?? null;
  }

  return {
    result: {
      recovery,
    },
    status:
      mode === "auto"
        ? run.status
        : run.status === AGENT_RUN_STATUSES.running
          ? AGENT_RUN_STATUSES.waitingForUser
          : run.status,
  };
};

export const createAgentRunRecoveryService = ({
  agentRunService,
  agentRunStepExecutor,
  // This callback must continue the persisted custom_skills graph directly.
  // Calling runAgentRag here would regenerate the outer plan and repeat work.
  resumeExecutionGraph = null,
  now = () => new Date().toISOString(),
  recordRecoveryTrace = recordRagTrace,
  safeAutoRecoveryStepTypes = DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} = {}) => ({
  async recoverOnStartup({
    mode = "manual",
    reason = "server_startup_recovery",
    statuses = [
      AGENT_RUN_STATUSES.running,
      AGENT_RUN_STATUSES.waitingForUser,
    ],
  } = {}) {
    const recoveryMode = normalizeMode(mode);

    if (recoveryMode === "off") {
      return {
        autoRecoveredCount: 0,
        failedCount: 0,
        manualRecoveredCount: 0,
        mode: recoveryMode,
        recoveredCount: 0,
        skippedCount: 0,
        runs: [],
      };
    }

    if (!agentRunService?.listRecoverableRuns) {
      return {
        autoRecoveredCount: 0,
        failedCount: 0,
        manualRecoveredCount: 0,
        mode: recoveryMode,
        recoveredCount: 0,
        skippedCount: 0,
        runs: [],
      };
    }

    // The scan crosses tenants by nature; it runs as the owner role.
    const recoverableRuns = await runAsDatabaseSystem(() =>
      agentRunService.listRecoverableRuns({
        includeAccessScope: true,
        statuses,
      })
    );
    const recovered = [];
    let autoRecoveredCount = 0;
    let failedCount = 0;
    let manualRecoveredCount = 0;
    let skippedCount = 0;

    const markManualRecovery = async ({
      accessScope = {},
      fallbackReason,
      requestedMode,
      run,
      step,
    } = {}) => {
      const recoveryPatch = buildRecoveryPatch({
        mode: "manual",
        now,
        reason: fallbackReason,
        requestedMode,
        run,
        step,
      });
      if (typeof agentRunService.markManualRecovery !== "function") {
        throw new Error("Atomic manual recovery is unavailable for agent runs.");
      }

      const mutation = await agentRunService.markManualRecovery({
        accessScope,
        recovery: recoveryPatch.result.recovery,
        runId: run.runId,
      });

      if (!mutation.marked) {
        // A concurrent graph owner, terminal transition, or another recovery
        // worker won the same run-revision CAS. Never overwrite that winner.
        skippedCount += 1;
        return;
      }

      manualRecoveredCount += 1;
      recovered.push(
        (await agentRunService.getRun?.({
          accessScope,
          runId: run.runId,
        })) ?? mutation.run
      );
    };

    const runAutoRecovery = async ({ accessScope = {}, run, step } = {}) => {
      const recoveryPatch = buildRecoveryPatch({
        mode: "auto",
        now,
        reason,
        requestedMode: "auto",
        run,
        step,
      });

      await agentRunService.updateRun({
        accessScope,
        runId: run.runId,
        patch: recoveryPatch,
      });
      await agentRunService.appendRunEvent?.({
        accessScope,
        runId: run.runId,
        type: AUTO_RECOVERY_STARTED_EVENT,
        payload: {
          originalStatus: run.status,
          reason,
          stepId: step.id,
          stepType: step.type,
        },
      });

      try {
        const result = await agentRunStepExecutor.resumeStep({
          accessScope,
          runId: run.runId,
          stepId: step.id,
        });

        await agentRunService.appendRunEvent?.({
          accessScope,
          runId: run.runId,
          type: AUTO_RECOVERY_COMPLETED_EVENT,
          payload: {
            status: result.run?.status ?? null,
            stepId: step.id,
            stepType: step.type,
          },
        });

        autoRecoveredCount += 1;
        recovered.push(
          (await agentRunService.getRun?.({
            accessScope,
            runId: run.runId,
          })) ?? result.run
        );
      } catch (error) {
        await agentRunService.appendRunEvent?.({
          accessScope,
          runId: run.runId,
          type: AUTO_RECOVERY_FAILED_EVENT,
          payload: {
            error: serializeError(error, "Auto recovery failed."),
            status: error?.status ?? 500,
            stepId: step.id,
            stepType: step.type,
          },
        });
        failedCount += 1;
      }
    };

    const runAutoGraphRecovery = async ({
      accessScope = {},
      checkpoint,
      run,
    } = {}) => {
      await agentRunService.updateRun({
        accessScope,
        runId: run.runId,
        patch: buildRecoveryPatch({
          mode: "auto",
          now,
          reason,
          requestedMode: "auto",
          run,
        }),
      });
      await agentRunService.appendRunEvent?.({
        accessScope,
        runId: run.runId,
        type: AUTO_RECOVERY_STARTED_EVENT,
        payload: { originalStatus: run.status, reason, type: "execution_graph" },
      });

      try {
        await resumeExecutionGraph({
          accessScope,
          checkpoint,
          run,
          runId: run.runId,
        });
        const resumed = await agentRunService.getRun?.({
          accessScope,
          runId: run.runId,
        });

        if (
          ![AGENT_RUN_STATUSES.completed, AGENT_RUN_STATUSES.failed].includes(
            resumed?.status
          )
        ) {
          throw new Error("Graph resume did not settle the agent run.");
        }

        await agentRunService.appendRunEvent?.({
          accessScope,
          runId: run.runId,
          type: AUTO_RECOVERY_COMPLETED_EVENT,
          payload: { status: resumed.status, type: "execution_graph" },
        });
        autoRecoveredCount += 1;
        recovered.push(
          await agentRunService.getRun?.({ accessScope, runId: run.runId })
        );
      } catch (error) {
        await agentRunService.appendRunEvent?.({
          accessScope,
          runId: run.runId,
          type: AUTO_RECOVERY_FAILED_EVENT,
          payload: {
            error: serializeError(error, "Graph auto recovery failed."),
            status: error?.status ?? 500,
            type: "execution_graph",
          },
        });
        failedCount += 1;
        const current =
          (await agentRunService.getRun?.({ accessScope, runId: run.runId })) ?? run;

        if (
          [AGENT_RUN_STATUSES.running, AGENT_RUN_STATUSES.waitingForUser].includes(
            current.status
          )
        ) {
          await markManualRecovery({
            accessScope,
            fallbackReason: "graph_resume_failed",
            requestedMode: "auto",
            run: current,
          });
        } else {
          recovered.push(current);
        }
      }
    };

    for (const listedRun of recoverableRuns.runs ?? []) {
      // Each run is recovered acting for its own scope, so the row policies
      // cover the replayed work exactly as they covered the original request.
      await runWithDatabaseTenant(listedRun.accessScope ?? {}, async () => {
        const accessScope = listedRun.accessScope ?? {};
        const run =
          (await agentRunService.getRun?.({
            accessScope,
            runId: listedRun.runId,
          })) ?? listedRun;

        if (hasManualRecoveryEvent(run)) {
          skippedCount += 1;
          return;
        }

        if (recoveryMode === "auto") {
          const loadedGraph = await agentRunService.getExecutionGraphCheckpoint?.({
            accessScope,
            runId: run.runId,
          });

          if (loadedGraph || hasExecutedGuardedGraph(run)) {
            if (loadedGraph?.checkpoint?.resumeClaim) {
              // A claimed graph may still be running in another worker. The
              // claim prevents a second replay, but it does not prove that the
              // owner crashed; changing the run to manual recovery here would
              // race the owner and could interrupt its completion.
              skippedCount += 1;
              return;
            }

            const reconciliation = loadedGraph
              ? sealExecutionGraphCheckpoint(loadedGraph.checkpoint).digest !==
                  loadedGraph.checkpoint.digest
                ? { ok: false, reason: "checkpoint_digest_mismatch" }
                : loadedGraph.checkpoint.phase !== "running"
                  ? { ok: false, reason: "graph_finalization_requires_recovery" }
                  : reconcileExecutionGraphCheckpoint(loadedGraph)
              : { ok: false, reason: "graph_checkpoint_missing" };

            if (
              reconciliation.ok &&
              hasLegacyResumableGraphContract(loadedGraph?.checkpoint) &&
              !hasPendingApprovalGate(run) &&
              hasGraphOnlyStoredExecutionPlan(run) &&
              typeof resumeExecutionGraph === "function" &&
              typeof agentRunService.claimExecutionGraphResume === "function"
            ) {
              const claim = await agentRunService.claimExecutionGraphResume({
                accessScope,
                checkpointDigest: loadedGraph.checkpoint.digest,
                runId: run.runId,
              });

              if (!claim.claimed) {
                // Another recovery worker won the persisted CAS. Do not alter
                // its run status or race it with a second execution.
                skippedCount += 1;
                return;
              }

              await runAutoGraphRecovery({
                accessScope,
                checkpoint: claim.checkpoint,
                run,
              });
              return;
            }

            await markManualRecovery({
              accessScope,
              fallbackReason: !reconciliation.ok
                ? reconciliation.reason
                : !hasLegacyResumableGraphContract(loadedGraph?.checkpoint)
                  ? "graph_checkpoint_version_not_resumable"
                : hasPendingApprovalGate(run)
                  ? "pending_approval_gate"
                  : !hasGraphOnlyStoredExecutionPlan(run)
                    ? "graph_outer_plan_not_resumable"
                    : "graph_resume_executor_unavailable",
              requestedMode: "auto",
              run,
            });
            return;
          }

          const autoCandidate = findAutoRecoverableStep({
            run,
            safeStepTypes: safeAutoRecoveryStepTypes,
          });

          if (autoCandidate.step && agentRunStepExecutor?.resumeStep) {
            await runAutoRecovery({
              accessScope,
              run,
              step: autoCandidate.step,
            });
            return;
          }

          await markManualRecovery({
            accessScope,
            fallbackReason: agentRunStepExecutor?.resumeStep
              ? autoCandidate.reason
              : "auto_recovery_executor_unavailable",
            requestedMode: "auto",
            run,
            step: autoCandidate.step,
          });
          return;
        }

        await markManualRecovery({
          accessScope,
          fallbackReason: reason,
          requestedMode: recoveryMode,
          run,
        });
      });
    }

    await recordRecoveryTrace?.({
      traceType: "agent_run_recovery",
      timestamp: now(),
      eventType: "startup_recovery_completed",
      mode: recoveryMode,
      reason,
      recoverableRunCount: recoverableRuns.runs?.length ?? 0,
      recoveredCount: recovered.length,
      manualRecoveryCount: manualRecoveredCount,
      skippedCount,
      autoReplayAttemptCount: autoRecoveredCount + failedCount,
      autoReplaySuccessCount: autoRecoveredCount,
      autoReplayFailureCount: failedCount,
    });

    return {
      autoRecoveredCount,
      failedCount,
      manualRecoveredCount,
      mode: recoveryMode,
      recoveredCount: recovered.length,
      skippedCount,
      runs: recovered,
    };
  },
});
