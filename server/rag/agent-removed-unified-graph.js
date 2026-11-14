// The v3 unified graph answered a whole request as one graph (documents, Web,
// Skills and one approval-gated Capability) when
// AGENT_UNIFIED_GRAPH_ROLLOUT=guarded. It was removed in ADR 0001 phase 10
// (docs/adr/0001-langgraph-runtime.md): every request now runs the outer
// execution plan, and the dial's `guarded` and `shadow` values refuse startup.
//
// A deployment that ran `guarded` may still hold runs that graph stored. This
// module is what is left of the graph: how such a run is recognized and what
// the runtime does with one. Nothing here runs a node or decides a gate.
//
// - A settled run is left as it is, and a request that continues it starts a
//   new run (agent-runs.js). Settled means the run ended (completed, failed
//   or canceled, whatever its graph looked like when it did) or was finalized
//   as a question for the user.
// - An unfinished run cannot be continued. Startup recovery hands it to an
//   operator, also when an earlier recovery claimed its graph: no process of
//   this version can own that claim. An approval decision, and a request that
//   re-enters a run parked at its gate, are refused after the run is listed
//   for an operator. The operator can cancel it, which settles it.
// - A request that re-enters an interrupted run stays fenced by the run store
//   (AGENT_GRAPH_EXECUTION_FENCED), as for any run that holds a graph, until
//   the run is settled.
import { AGENT_RUN_STATUSES } from "./agent-run-state-machine.js";
import { AGENT_RUN_STEP_STATUSES } from "./agent-run-steps.js";

/**
 * Why an unfinished stored run needs an operator (its manual-recovery
 * reason), and the `code` of the error that refuses to continue one. Over
 * HTTP the refusal is a 409 whose body carries the message, not the code.
 */
export const UNIFIED_GRAPH_REMOVED_REASON = "unified_graph_removed";

// A node step that was still running when the process died: whether it wrote
// anything is unknown. The reason is the one a graph that still exists gets
// for the same state (agent-execution-graph-checkpoint.js).
const IN_FLIGHT_NODE_REASON = "unknown_in_flight_node";

const STORED_CHECKPOINT_VERSION = "v2";
const STORED_NODE_STEP_TYPE = "graph_node";

const IN_FLIGHT_STEP_STATUSES = new Set([
  AGENT_RUN_STEP_STATUSES.paused,
  AGENT_RUN_STEP_STATUSES.pending,
  AGENT_RUN_STEP_STATUSES.running,
]);

const ENDED_RUN_STATUSES = new Set([
  AGENT_RUN_STATUSES.canceled,
  AGENT_RUN_STATUSES.completed,
  AGENT_RUN_STATUSES.failed,
]);

const toArray = (value) => (Array.isArray(value) ? value : []);

/**
 * The graph checkpoint of a run the removed unified graph stored. Only that
 * graph ever wrote this checkpoint version; the custom-Skill graph writes v1.
 */
export const isRemovedUnifiedGraphCheckpoint = (checkpoint) =>
  checkpoint?.version === STORED_CHECKPOINT_VERSION;

/** Such a checkpoint parked at its approval gate, waiting for a decision. */
export const isRemovedUnifiedGraphApprovalPause = (checkpoint) =>
  isRemovedUnifiedGraphCheckpoint(checkpoint) && checkpoint.phase === "awaiting_approval";

/**
 * The resume claim an earlier startup recovery left on the checkpoint, or
 * null. The run store marks a claimed run for manual recovery only for the
 * caller that names the claim.
 */
export const getRemovedUnifiedGraphClaimId = (checkpoint) =>
  isRemovedUnifiedGraphCheckpoint(checkpoint)
    ? checkpoint.resumeClaim?.claimId ?? null
    : null;

/**
 * Finalized as a question for the user: the receipt was written and the run
 * completed as waiting for the answer. Nothing crashed. A run that was still
 * running when an operator hand-over made it `waiting_for_user` is not this:
 * its receipt was written but the run never completed.
 */
export const isRemovedUnifiedGraphClarification = ({ checkpoint, run } = {}) =>
  isRemovedUnifiedGraphCheckpoint(checkpoint) &&
  checkpoint.phase === "completed" &&
  checkpoint.finalization !== undefined &&
  run?.status === AGENT_RUN_STATUSES.waitingForUser &&
  !toArray(run?.approvalGates).some((gate) => gate?.status === "pending") &&
  (run?.result?.recovery?.mode !== "manual" ||
    run.result.recovery.originalStatus === AGENT_RUN_STATUSES.waitingForUser);

/**
 * Nothing is left to do for the run, so a request that continues it is a new
 * request with a new run: the run ended, or it was finalized as a question.
 */
export const isSettledRemovedUnifiedGraphRun = ({ checkpoint, run } = {}) =>
  isRemovedUnifiedGraphCheckpoint(checkpoint) &&
  (ENDED_RUN_STATUSES.has(run?.status) ||
    isRemovedUnifiedGraphClarification({ checkpoint, run }));

/** Why an unfinished stored run needs an operator. */
export const explainRemovedUnifiedGraphRun = ({ run } = {}) =>
  toArray(run?.steps).some(
    (step) => step.type === STORED_NODE_STEP_TYPE && IN_FLIGHT_STEP_STATUSES.has(step.status)
  )
    ? IN_FLIGHT_NODE_REASON
    : UNIFIED_GRAPH_REMOVED_REASON;

/**
 * Refuse to continue an unfinished stored run: list it for an operator, then
 * throw. The listing is a no-op for a run that already is listed. A run that
 * has ended is not refused here (returns false): what its caller does next
 * decides what such a request gets.
 */
export const refuseRemovedUnifiedGraphRun = async ({ accessScope, agentRunService, runId } = {}) => {
  const run = await agentRunService?.getRun?.({ accessScope, runId });

  if (ENDED_RUN_STATUSES.has(run?.status)) {
    return false;
  }

  await agentRunService?.markManualRecovery?.({
    accessScope,
    recovery: {
      reason: UNIFIED_GRAPH_REMOVED_REASON,
      recoveredAt: new Date().toISOString(),
    },
    runId,
  });

  const error = new Error(
    "This run belongs to the v3 unified graph, which was removed; an operator must resolve it."
  );
  error.code = UNIFIED_GRAPH_REMOVED_REASON;
  error.status = 409;
  throw error;
};
