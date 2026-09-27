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
import { hasUnifiedGuardedGraphPath } from "./agent-unified-graph-run.js";
import { getAgentUnifiedGraphRollout } from "./config.js";

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

// The legacy startup continuation reconstructs only the custom-Skill stage.
const hasLegacyResumableGraphContract = (checkpoint) =>
  checkpoint?.version === "v1" &&
  ["v1", "v2"].includes(checkpoint.graph?.version);

// A heterogeneous v3 graph (v2 checkpoint) owns its whole request. It has a
// dedicated continuation only when the run's durable events prove that the
// guarded unified path took the request and the V1 outer plan never ran;
// anything else (a shadow or foreign checkpoint) stays manual.
const isUnifiedGraphCheckpoint = (checkpoint) =>
  checkpoint?.version === "v2" && checkpoint.graph?.version === "v3";

// A resumed v3 run may legitimately settle as a clarification: the whole
// request was answered with a question for the user, or the graph reached its
// approval gate and now waits for the decision. That counts as settled only
// when the completion or gate event follows this recovery's claim.
const SETTLED_WAITING_EVENTS = new Set([
  "graph_approval_gate_created",
  "run_waiting_for_user",
]);

const hasSettledAfterResumeClaim = (run = {}) => {
  if ([AGENT_RUN_STATUSES.completed, AGENT_RUN_STATUSES.failed].includes(run?.status)) {
    return true;
  }

  const events = toArray(run?.events);
  const claimIndex = events.findLastIndex(
    (event) => event.type === "skill_graph_resume_claimed"
  );

  return run?.status === AGENT_RUN_STATUSES.waitingForUser &&
    claimIndex >= 0 &&
    events.slice(claimIndex + 1).some((event) => SETTLED_WAITING_EVENTS.has(event.type));
};

// A v3 graph parked at its approval gate is waiting for a person, not
// crashed: the paused checkpoint, its one pending gate, and no active graph
// step. Startup leaves it for the approval decision.
const isCleanGraphApprovalPause = ({ checkpoint, run } = {}) => {
  const pendingGates = toArray(run?.approvalGates).filter(
    (gate) => normalizeText(gate.status).toLowerCase() === "pending"
  );

  return isUnifiedGraphCheckpoint(checkpoint) &&
    checkpoint.phase === "awaiting_approval" &&
    !checkpoint.resumeClaim &&
    run?.status === AGENT_RUN_STATUSES.waitingForUser &&
    pendingGates.length === 1 &&
    pendingGates[0].id === checkpoint.approvalBoundary?.gateId &&
    !toArray(run?.steps).some(
      (step) =>
        step.type === "graph_node" &&
        AUTO_RECOVERY_STEP_STATUSES.has(step.status)
    );
};

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
  // This callback must continue the persisted graph directly: the custom_skills
  // stage for a v1 checkpoint, the whole guarded v3 request for a v2 one.
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
      expectedGraphResumeClaimId = null,
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
        ...(expectedGraphResumeClaimId ? { expectedGraphResumeClaimId } : {}),
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

        if (!hasSettledAfterResumeClaim(resumed)) {
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
          // This worker owns the claim and its resume has stopped, so it may
          // hand the run to an operator under that same claim. Without the
          // claim id the run store refuses, and a run whose resume failed
          // before any node started would stay `running` and unlisted.
          await markManualRecovery({
            accessScope,
            expectedGraphResumeClaimId: checkpoint?.resumeClaim?.claimId ?? null,
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

            const unifiedGraph = isUnifiedGraphCheckpoint(loadedGraph?.checkpoint);
            const unifiedGraphPath = unifiedGraph && hasUnifiedGuardedGraphPath(run);
            // An operator who rolls the unified graph back to `off` (or
            // `shadow`) also stops startup recovery from executing or
            // finalizing a v3 graph; such runs wait for an operator.
            const unifiedRolloutGuarded = getAgentUnifiedGraphRollout() === "guarded";

            if (
              unifiedGraphPath &&
              loadedGraph.checkpoint.phase === "completed" &&
              loadedGraph.checkpoint.finalization &&
              run.status === AGENT_RUN_STATUSES.waitingForUser &&
              toArray(run.events).some((event) => event.type === "run_waiting_for_user")
            ) {
              // Already finalized as a clarification: the receipt was written
              // and the run completed. Nothing crashed, so nothing is resumed.
              skippedCount += 1;
              return;
            }

            if (
              unifiedGraphPath &&
              isCleanGraphApprovalPause({ checkpoint: loadedGraph.checkpoint, run })
            ) {
              if (unifiedRolloutGuarded) {
                // Parked at its approval gate: the decision continues it.
                skippedCount += 1;
                return;
              }

              // After a rollback no decision can continue this graph (the
              // approval continuation refuses outside `guarded`), so it would
              // wait forever unlisted. Hand it to an operator; the run is
              // unclaimed and keeps waiting, and the cancel action applies.
              await markManualRecovery({
                accessScope,
                fallbackReason: "unified_graph_rollout_not_guarded",
                requestedMode: "auto",
                run,
              });
              return;
            }
            const reconciliation = loadedGraph
              ? sealExecutionGraphCheckpoint(loadedGraph.checkpoint).digest !==
                  loadedGraph.checkpoint.digest
                ? { ok: false, reason: "checkpoint_digest_mismatch" }
                : loadedGraph.checkpoint.phase !== "running" &&
                    // A completed v3 graph whose run was not yet completed is
                    // finalized from its reused nodes or its finalization
                    // receipt; a partial one never is.
                    !(unifiedGraphPath && loadedGraph.checkpoint.phase === "completed")
                  ? { ok: false, reason: "graph_finalization_requires_recovery" }
                  : reconcileExecutionGraphCheckpoint(loadedGraph)
              : { ok: false, reason: "graph_checkpoint_missing" };
            const resumableContract = unifiedGraph
              ? unifiedGraphPath && unifiedRolloutGuarded
              : hasLegacyResumableGraphContract(loadedGraph?.checkpoint) &&
                hasGraphOnlyStoredExecutionPlan(run);

            if (
              reconciliation.ok &&
              resumableContract &&
              !hasPendingApprovalGate(run) &&
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
                : unifiedGraph
                  ? !unifiedGraphPath
                    ? "graph_checkpoint_version_not_resumable"
                    : !unifiedRolloutGuarded
                      ? "unified_graph_rollout_not_guarded"
                    : hasPendingApprovalGate(run)
                      ? "pending_approval_gate"
                      : "graph_resume_executor_unavailable"
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
