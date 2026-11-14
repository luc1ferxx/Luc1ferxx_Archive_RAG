import { AGENT_RUN_STATUSES } from "./agent-runs.js";
import {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
} from "./agent-run-steps.js";
import { buildStepReplaySafetyAssessment } from "./agent-run-step-replay-safety.js";
import { recordRagTrace } from "./observability.js";
import { runAsDatabaseSystem, runWithDatabaseTenant } from "./postgres-tenant.js";
import { normalizeText } from "../lib/normalize-text.js";
import {
  reconcileExecutionGraphCheckpoint,
  sealExecutionGraphCheckpoint,
} from "./agent-execution-graph-checkpoint.js";
import {
  explainRemovedUnifiedGraphRun,
  getRemovedUnifiedGraphClaimId,
  isRemovedUnifiedGraphCheckpoint,
  isRemovedUnifiedGraphClarification,
} from "./agent-removed-unified-graph.js";

const normalizeMode = (value) => {
  const mode = normalizeText(value).toLowerCase();

  return ["auto", "manual", "off"].includes(mode) ? mode : "manual";
};

const toArray = (value) => (Array.isArray(value) ? value : []);

export const MANUAL_RECOVERY_EVENT = "manual_recovery_required";
const AUTO_RECOVERY_STARTED_EVENT = "auto_recovery_started";
const AUTO_RECOVERY_COMPLETED_EVENT = "auto_recovery_completed";
const AUTO_RECOVERY_FAILED_EVENT = "auto_recovery_failed";

// A step in one of these statuses was still in flight when its run stopped.
export const INTERRUPTED_STEP_STATUS_VALUES = Object.freeze([
  AGENT_RUN_STEP_STATUSES.paused,
  AGENT_RUN_STEP_STATUSES.pending,
  AGENT_RUN_STEP_STATUSES.running,
]);

const INTERRUPTED_STEP_STATUSES = new Set(INTERRUPTED_STEP_STATUS_VALUES);

const hasManualRecoveryEvent = (run = {}) =>
  toArray(run.events).some((event) => event.type === MANUAL_RECOVERY_EVENT);

const hasPendingApprovalGate = (run = {}) =>
  toArray(run.approvalGates).some(
    (gate) => normalizeText(gate.status).toLowerCase() === "pending"
  ) ||
  toArray(run.steps).some(
    (step) =>
      step.kind === AGENT_RUN_STEP_KINDS.approvalGate &&
      INTERRUPTED_STEP_STATUSES.has(step.status)
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

// Startup continues one kind of graph: the custom-Skill stage's.
const hasResumableGraphContract = (checkpoint) =>
  checkpoint?.version === "v1" &&
  ["v1", "v2"].includes(checkpoint.graph?.version);

// A resumed graph settles its run: completed, failed, or answered with a
// question for the user. The last counts only when the run started waiting
// after this recovery's claim.
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
    events.slice(claimIndex + 1).some((event) => event.type === "run_waiting_for_user");
};

// Why a run that has no graph to continue needs an operator: its pending
// approval gate, or what replaying its first interrupted step would risk.
// Nothing here is replayed. The only automatic continuation is the whole-graph
// resume in recoverOnStartup; until ADR 0001 phase 9 this function also picked
// a step startup could replay on its own, and the only step type that
// qualified was the `custom_skill` step of the deleted V1 sequential chain.
export const explainInterruptedRun = ({ run = {} } = {}) => {
  if (hasPendingApprovalGate(run)) {
    return {
      reason: "pending_approval_gate",
      safety: null,
    };
  }

  const interruptedStep = toArray(run.steps).find((runStep) =>
    INTERRUPTED_STEP_STATUSES.has(runStep.status)
  );
  const safety = interruptedStep
    ? buildStepReplaySafetyAssessment({ run, step: interruptedStep })
    : null;

  return {
    reason: safety?.reasonCodes[0] ?? "no_safe_recoverable_step",
    safety,
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

// Startup recovery. In `auto` mode it does one thing by itself: continue an
// interrupted execution graph, under a claim. Every other interrupted run is
// handed to an operator (manual recovery), and in `manual` mode every run is.
export const createAgentRunRecoveryService = ({
  agentRunService,
  // This callback must continue the persisted graph directly: the custom_skills
  // stage. Calling runAgentRag here would regenerate the outer plan and repeat
  // work.
  resumeExecutionGraph = null,
  now = () => new Date().toISOString(),
  recordRecoveryTrace = recordRagTrace,
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
    } = {}) => {
      const recoveryPatch = buildRecoveryPatch({
        mode: "manual",
        now,
        reason: fallbackReason,
        requestedMode,
        run,
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

        // Read in both modes: a run of the removed v3 unified graph
        // (agent-removed-unified-graph.js) is handed over under the resume
        // claim an earlier startup may have left on it, which the run store
        // requires before it marks a claimed run.
        const loadedGraph = await agentRunService.getExecutionGraphCheckpoint?.({
          accessScope,
          runId: run.runId,
        });
        const removedGraphClaimId = getRemovedUnifiedGraphClaimId(loadedGraph?.checkpoint);

        if (recoveryMode === "auto") {
          if (isRemovedUnifiedGraphCheckpoint(loadedGraph?.checkpoint)) {
            // One already finalized as a question for the user is settled:
            // nothing crashed. Any other can never be continued, so it goes to
            // an operator; it would otherwise wait forever unlisted. That
            // includes a graph an earlier startup claimed and never settled:
            // elsewhere a claim means its owner may still be running, but no
            // process of this version can own this one.
            if (
              isRemovedUnifiedGraphClarification({
                checkpoint: loadedGraph.checkpoint,
                run,
              })
            ) {
              skippedCount += 1;
              return;
            }

            await markManualRecovery({
              accessScope,
              expectedGraphResumeClaimId: removedGraphClaimId,
              fallbackReason: explainRemovedUnifiedGraphRun({ run }),
              requestedMode: "auto",
              run,
            });
            return;
          }

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
            const resumableContract =
              hasResumableGraphContract(loadedGraph?.checkpoint) &&
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
                : !hasResumableGraphContract(loadedGraph?.checkpoint)
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

          // No graph to continue: no step is replayed on its own, so the run
          // goes to an operator with the reason its interrupted step gives.
          await markManualRecovery({
            accessScope,
            fallbackReason: explainInterruptedRun({ run }).reason,
            requestedMode: "auto",
            run,
          });
          return;
        }

        await markManualRecovery({
          accessScope,
          expectedGraphResumeClaimId: removedGraphClaimId,
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
      // The field names are older than what they count. An "auto replay" is
      // an interrupted graph continued automatically: startup replays nothing
      // else (ADR 0001 phase 9).
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
