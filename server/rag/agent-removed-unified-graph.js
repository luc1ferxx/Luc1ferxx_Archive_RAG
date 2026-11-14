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
// - A settled run (finalized with an answer or a question, or failed) is left
//   as it is; a request that continues it starts a new run (agent-runs.js).
// - An unfinished run cannot be continued: startup recovery, an approval
//   decision, and a request that re-enters it at its gate all hand it to an
//   operator, who can cancel it.
// - A request that re-enters an interrupted run stays fenced by the run store
//   (AGENT_GRAPH_EXECUTION_FENCED), as for any run that holds a graph.
import { AGENT_RUN_STEP_STATUSES } from "./agent-run-steps.js";

/** Manual-recovery reason and HTTP error code of an unfinished stored run. */
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

/**
 * The graph checkpoint of a run the removed unified graph stored. Only that
 * graph ever wrote this checkpoint version; the custom-Skill graph writes v1.
 */
export const isRemovedUnifiedGraphCheckpoint = (checkpoint) =>
  checkpoint?.version === STORED_CHECKPOINT_VERSION;

/** Such a run parked at its approval gate, waiting for a decision. */
export const isRemovedUnifiedGraphApprovalPause = (checkpoint) =>
  isRemovedUnifiedGraphCheckpoint(checkpoint) && checkpoint.phase === "awaiting_approval";

/**
 * Finalized as a question for the user: the receipt was written and the run
 * waits for an answer. Nothing crashed, so startup leaves it alone.
 */
export const isRemovedUnifiedGraphClarification = ({ checkpoint, run } = {}) =>
  isRemovedUnifiedGraphCheckpoint(checkpoint) &&
  checkpoint.phase === "completed" &&
  checkpoint.finalization !== undefined &&
  run?.status === "waiting_for_user" &&
  (Array.isArray(run?.events) ? run.events : []).some(
    (event) => event.type === "run_waiting_for_user"
  );

/** Why an unfinished stored run needs an operator. */
export const explainRemovedUnifiedGraphRun = ({ run } = {}) =>
  (Array.isArray(run?.steps) ? run.steps : []).some(
    (step) => step.type === STORED_NODE_STEP_TYPE && IN_FLIGHT_STEP_STATUSES.has(step.status)
  )
    ? IN_FLIGHT_NODE_REASON
    : UNIFIED_GRAPH_REMOVED_REASON;

/**
 * Refuse to continue an unfinished stored run. The run is listed for an
 * operator first (the mark is a no-op for a run that already is, or that
 * another worker claimed), so a decision that can never be applied does not
 * leave it waiting unseen.
 */
export const refuseRemovedUnifiedGraphRun = async ({ accessScope, agentRunService, runId } = {}) => {
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
