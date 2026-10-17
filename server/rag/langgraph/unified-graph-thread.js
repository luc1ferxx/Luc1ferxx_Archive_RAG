import { INTERRUPT } from "@langchain/langgraph";

import { EXECUTION_GRAPH_NODE_STATUSES } from "../agent-execution-graph-node.js";
import { isApprovalInterruptPayload } from "./unified-graph-approval.js";

// Reading a run's LangGraph thread back (docs/adr/0001-langgraph-runtime.md,
// phase 3), for the two callers that must know what the thread holds before
// they act on the run: the executor continuing an approval on the same thread
// (run-execution-graph.js) and startup recovery (unified-graph-recovery.js).
//
// The thread is read through the run's RunStoreCheckpointSaver, exactly as
// LangGraph itself would read it: the latest checkpoint tuple, its channel
// values and the pending writes of the superstep that was in flight when the
// thread last stopped. A thread stopped by an interrupt holds the sibling
// nodes' receipts as pending writes (LangGraph commits a superstep's
// checkpoint only once every task of it returned), so the receipts are
// merged from both.
//
// Nothing read here is authority. The run's graph checkpoint
// (run.result.__skillGraphCheckpoint) decides what ran and what may be
// reused; the thread's receipts are compared against it and a thread that
// contradicts it is refused, a thread behind it is dropped for a fresh
// invocation, and a thread that agrees with it may be resumed.

// What LangGraph writes a keyed Command({ resume }) as. Not exported by
// @langchain/langgraph, so pinned here (pregel/io.js mapCommand).
export const LANGGRAPH_RESUME_CHANNEL = "__resume__";
export const LANGGRAPH_RECEIPTS_CHANNEL = "receipts";
const RECEIPT_KEY_PREFIX = "node:";

export const LANGGRAPH_THREAD_RECONCILIATION_REASONS = Object.freeze({
  // A receipt for a node the graph does not have.
  foreignReceipt: "receipt_for_unknown_node",
  // A receipt claims a completed output the checkpoint does not hold, or
  // holds with another digest.
  receiptWithoutCheckpoint: "completed_receipt_without_checkpoint",
  receiptDigestMismatch: "completed_receipt_digest_mismatch",
  // A failed receipt for a node the checkpoint does not hold as failed.
  failedReceipt: "failed_receipt",
  invalidReceipt: "invalid_receipt",
});

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const RECEIPT_STATUSES = new Set(Object.values(EXECUTION_GRAPH_NODE_STATUSES));

const isReceipt = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 3 &&
  RECEIPT_STATUSES.has(value.status) &&
  (value.reason === null || typeof value.reason === "string") &&
  (value.outputDigest === null || typeof value.outputDigest === "string");

const collectReceipts = (receipts, channelValue) => {
  if (!isRecord(channelValue)) {
    return;
  }

  for (const [key, value] of Object.entries(channelValue)) {
    if (key.startsWith(RECEIPT_KEY_PREFIX)) {
      receipts.set(key.slice(RECEIPT_KEY_PREFIX.length), value);
    }
  }
};

/**
 * The run's thread as its saver holds it, or null when the run has no
 * thread (none was ever written, or it was tombstoned). `saver` is the run's
 * RunStoreCheckpointSaver; the read is a fresh one and is never fenced.
 *
 * Returns { checkpointId, interrupts, receipts, resumeWrites }:
 *   - receipts: Map nodeId -> receipt as the graph's nodes returned them
 *     (compile-execution-graph.js buildExecutionGraphReceipt), the committed
 *     channel merged with the pending writes of the stopped superstep;
 *   - interrupts: every pending __interrupt__ write, { id, taskId, value };
 *   - resumeWrites: every pending __resume__ write's value, so a caller can
 *     check that nothing but the runtime's marker was ever written.
 */
export const readLangGraphThread = async (saver) => {
  const tuple = await saver.getTuple({ configurable: { thread_id: saver.threadId } });

  if (!tuple) {
    return null;
  }

  const receipts = new Map();
  const interrupts = [];
  const resumeWrites = [];

  collectReceipts(receipts, tuple.checkpoint?.channel_values?.[LANGGRAPH_RECEIPTS_CHANNEL]);

  for (const [taskId, channel, value] of tuple.pendingWrites ?? []) {
    if (channel === LANGGRAPH_RECEIPTS_CHANNEL) {
      collectReceipts(receipts, value);
    } else if (channel === INTERRUPT) {
      interrupts.push({ id: value?.id ?? null, taskId, value: value?.value });
    } else if (channel === LANGGRAPH_RESUME_CHANNEL) {
      resumeWrites.push(value);
    }
  }

  return {
    checkpointId: tuple.checkpoint?.id ?? null,
    interrupts,
    receipts,
    resumeWrites,
  };
};

/**
 * The thread's one pending approval interrupt for `nodeId`, or null. A thread
 * with any other interrupt, or more than one, has no pause this runtime
 * knows how to continue (a graph parks at most one node, and the executor
 * resumes exactly one interrupt by id).
 */
export const findPendingApprovalInterrupt = ({ interrupts = [], nodeId }) => {
  if (
    interrupts.length !== 1 ||
    typeof interrupts[0].id !== "string" ||
    interrupts[0].id === "" ||
    !isApprovalInterruptPayload(interrupts[0].value) ||
    interrupts[0].value.nodeId !== nodeId
  ) {
    return null;
  }

  return interrupts[0];
};

/**
 * Compares a thread's receipts with what the graph checkpoint holds.
 * `completedDigests` maps each node the checkpoint has as completed or reused
 * to the digest of its typed output (digestExecutionGraphTypedOutput),
 * `failedNodeIds` are the nodes it holds as failed (none for a continuation,
 * whose states never start out failed), and `nodeIds` are the graph's node
 * ids.
 *
 * Returns { ok, reason, behind, derived }. A thread that claims a completed
 * node the checkpoint lacks or holds differently, a failed node the
 * checkpoint does not hold as failed, a node the graph does not have, or a
 * malformed receipt, contradicts the checkpoint: ok is false with the
 * reason. Otherwise ok is true; `behind` says the checkpoint holds completed
 * nodes the thread has no receipt for yet, and `derived` holds the receipts
 * that are not checkpoint-backed (skipped, pending, parked) for the caller to
 * re-derive from the reused outputs. A failed receipt the checkpoint agrees
 * with is neither: what to do with a failed node is the checkpoint's
 * reconciliation's decision, as natively.
 */
export const reconcileLangGraphThreadReceipts = ({
  completedDigests,
  failedNodeIds = new Set(),
  nodeIds,
  receipts,
}) => {
  const derived = new Map();
  const refuse = (reason) => ({ behind: false, derived: new Map(), ok: false, reason });

  for (const [nodeId, receipt] of receipts) {
    if (!nodeIds.has(nodeId)) {
      return refuse(LANGGRAPH_THREAD_RECONCILIATION_REASONS.foreignReceipt);
    }

    if (!isReceipt(receipt)) {
      return refuse(LANGGRAPH_THREAD_RECONCILIATION_REASONS.invalidReceipt);
    }

    switch (receipt.status) {
      case EXECUTION_GRAPH_NODE_STATUSES.completed:
      case EXECUTION_GRAPH_NODE_STATUSES.reused: {
        if (!completedDigests.has(nodeId)) {
          return refuse(LANGGRAPH_THREAD_RECONCILIATION_REASONS.receiptWithoutCheckpoint);
        }

        if (
          receipt.reason !== null ||
          receipt.outputDigest === null ||
          completedDigests.get(nodeId) !== receipt.outputDigest
        ) {
          return refuse(LANGGRAPH_THREAD_RECONCILIATION_REASONS.receiptDigestMismatch);
        }

        break;
      }
      case EXECUTION_GRAPH_NODE_STATUSES.failed:
        if (
          !failedNodeIds.has(nodeId) ||
          receipt.reason !== null ||
          receipt.outputDigest !== null
        ) {
          return refuse(LANGGRAPH_THREAD_RECONCILIATION_REASONS.failedReceipt);
        }

        break;
      default:
        // Skipped, pending or parked: decided by the scheduler from the
        // reused outputs, never checkpoint-backed. The caller re-derives it.
        if (completedDigests.has(nodeId)) {
          return refuse(LANGGRAPH_THREAD_RECONCILIATION_REASONS.receiptDigestMismatch);
        }

        derived.set(nodeId, receipt);
    }
  }

  return {
    behind: [...completedDigests.keys()].some((nodeId) => !receipts.has(nodeId)),
    derived,
    ok: true,
    reason: null,
  };
};
