import { digestExecutionGraphTypedOutput } from "../agent-execution-graph-checkpoint.js";
import {
  EXECUTION_GRAPH_NODE_STATUSES,
  EXECUTION_GRAPH_SCHEDULE_DECISIONS,
  EXECUTION_GRAPH_SKIP_REASONS,
  decideExecutionGraphNode,
  recordExecutionGraphNodeSkip,
} from "../agent-execution-graph-node.js";
import {
  findPendingApprovalInterrupt,
  readLangGraphThread,
  reconcileLangGraphThreadReceipts,
} from "./unified-graph-thread.js";

// Continuing a v3 graph's decided approval on the LangGraph thread it parked
// on (docs/adr/0001-langgraph-runtime.md, phase 3): the one place the
// executor (run-execution-graph.js) resumes a thread instead of starting a
// fresh invocation. The executor is generic (custom-Skill v2 and v3 graphs
// alike); what is v3-only -- the pending approval interrupt, the receipts the
// thread wrote before the pause, the skips the native continuation would
// re-derive -- lives here, so the executor only asks whether the thread may
// be resumed and with which interrupt id.
//
// Nothing read from the thread is authority: the graph checkpoint decided the
// node states this call reuses (createExecutionGraphNodeStates) and the run
// store holds the decision; the thread must agree with them or it is not
// resumed.

export const UNIFIED_GRAPH_RESUME_ERROR_CODES = Object.freeze({
  // The thread claims work the checkpoint does not hold, or holds differently.
  threadConflict: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY",
});

const isPending = (state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.pending;

// Neither the thread nor the checkpoint can be trusted to continue; the
// continuation's caller hands the run to an operator. Fixed message: it
// reaches logs and the run's recovery record.
const createThreadConflictError = () => {
  const error = new Error(
    "The run's LangGraph thread contradicts its graph checkpoint; manual recovery is required."
  );
  error.code = UNIFIED_GRAPH_RESUME_ERROR_CODES.threadConflict;
  error.status = 409;
  return error;
};

/**
 * Decides whether the thread can be resumed for the decided approval of
 * `approvalResume.nodeId`, and prepares the in-process states for it.
 *
 * Resumable when the thread holds exactly that node's pending approval
 * interrupt and every receipt it wrote agrees with this invocation's states:
 * a completed receipt is a node the checkpoint lets this call reuse, with the
 * same typed-output digest; a skipped receipt is a node the native pass would
 * skip again now, for the same reason, from the reused outputs (it is settled
 * here exactly as that pass would settle it, since LangGraph will not enter
 * it again); a pending receipt is a node that stays pending, as it did on
 * the native scheduler phase 6 deleted ("native" below means that scheduler,
 * whose results the graph goldens pin).
 * Returns { interruptId } then. Returns null for a thread that has no such
 * interrupt (the pause happened natively, or the executor persisted it
 * natively because later layers still had work), is behind the checkpoint, or
 * holds a skip the native pass would not derive (a budget skip it would
 * attempt again): a fresh invocation then gives the native result. Throws the
 * thread-conflict error for a thread that contradicts the checkpoint.
 *
 * `saver` is the run's RunStoreCheckpointSaver; `context`, `graph`,
 * `nodeOutputs`, `states` and `statesByNodeId` are the executor's.
 */
export const prepareUnifiedGraphApprovalResume = async ({
  approvalResume,
  context,
  graph,
  nodeOutputs,
  saver,
  states,
  statesByNodeId,
}) => {
  const thread = await readLangGraphThread(saver);

  if (!thread) {
    return null;
  }

  const pending = findPendingApprovalInterrupt({
    interrupts: thread.interrupts,
    nodeId: approvalResume.nodeId,
  });
  const parked = statesByNodeId.get(approvalResume.nodeId);

  // The parked node is either still to run (approved) or settled as denied
  // before scheduling; anything else is not the pause this decision decided.
  if (
    !pending ||
    !parked ||
    !(
      isPending(parked) ||
      (parked.status === EXECUTION_GRAPH_NODE_STATUSES.skipped &&
        parked.reason === EXECUTION_GRAPH_SKIP_REASONS.approvalDenied)
    )
  ) {
    return null;
  }

  const reconciled = reconcileLangGraphThreadReceipts({
    completedDigests: new Map(
      states
        .filter((state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.reused)
        .map((state) => [
          state.node.nodeId,
          digestExecutionGraphTypedOutput(nodeOutputs.get(state.node.nodeId)),
        ])
    ),
    nodeIds: new Set(states.map((state) => state.node.nodeId)),
    receipts: thread.receipts,
  });

  if (!reconciled.ok) {
    throw createThreadConflictError();
  }

  if (reconciled.behind || thread.receipts.has(approvalResume.nodeId)) {
    return null;
  }

  // Derived receipts, in declaration order, as the native pass re-derives
  // them on a continuation: each skip must come out the same way from the
  // reused outputs and the states settled before it (a skip derived here
  // counts for the ones after it). Decided whole before any state is
  // settled, so a thread this call will not resume leaves the states as
  // the fresh invocation expects them.
  const derivedStatuses = new Map();
  const seeds = [];

  for (const state of states) {
    const receipt = reconciled.derived.get(state.node.nodeId);

    if (receipt === undefined) {
      continue;
    }

    if (!isPending(state)) {
      return null;
    }

    if (receipt.status === EXECUTION_GRAPH_NODE_STATUSES.pending) {
      continue;
    }

    if (receipt.status !== EXECUTION_GRAPH_NODE_STATUSES.skipped) {
      return null;
    }

    const { decision, reason } = decideExecutionGraphNode({
      aborted: false,
      dependencyStatuses: (state.node.dependsOn ?? []).map(
        (dependencyId) =>
          derivedStatuses.get(dependencyId) ?? statesByNodeId.get(dependencyId)?.status
      ),
      graphVersion: graph.version,
      interrupted: false,
      node: state.node,
      nodeOutputs,
    });

    if (decision !== EXECUTION_GRAPH_SCHEDULE_DECISIONS.skip || reason !== receipt.reason) {
      return null;
    }

    derivedStatuses.set(state.node.nodeId, EXECUTION_GRAPH_NODE_STATUSES.skipped);
    seeds.push({ reason, state });
  }

  // Recorded before the thread is resumed, where the native continuation's
  // first pass recorded them (before it launched anything): a continuation
  // that then fails leaves these skips in the trace, as it did natively. They
  // must be settled before LangGraph enters their dependants, which read the
  // in-process states.
  for (const { reason, state } of seeds) {
    recordExecutionGraphNodeSkip({ context, reason, state });
  }

  return { interruptId: pending.id };
};
