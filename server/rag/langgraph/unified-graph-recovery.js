import { digestExecutionGraphTypedOutput } from "../agent-execution-graph-checkpoint.js";
import { LANGGRAPH_SAVER_ERROR_CODES, RunStoreCheckpointSaver } from "./checkpointer.js";
import { readLangGraphThread, reconcileLangGraphThreadReceipts } from "./unified-graph-thread.js";
import { assertLangSmithTracingDisabled } from "./langsmith-guard.js";

// Startup recovery's look at a v3 run's LangGraph thread
// (docs/adr/0001-langgraph-runtime.md, phase 3), called by
// agent-run-recovery.js before the graph is claimed (on every recovery since
// phase 6 removed the native runtime, which ignored the thread). The graph
// checkpoint stays the authority: this only refuses to resume a run whose
// thread tells another story than its checkpoint, which
// means some writer other than the run's own graph execution touched one of
// the two. Such a run goes to an operator with a reason code and nothing
// else (no ids of nodes or gates in the run row, no text anywhere).
//
// A run without a thread, or with a thread behind its checkpoint (the crash
// landed between a node's checkpoint write and its superstep's commit), is
// fine: the continuation starts a fresh invocation seeded from the
// checkpoint and the stale thread is tombstoned under the recovery claim.
//
// Only a record the saver itself refuses (malformed, another thread's or
// owner's, another tenant's, too large) is "unreadable": that is a durable
// fault of the row, and the run goes to an operator. Any other failure of
// the read (the store, the connection, a run that vanished) is thrown, like
// every other pre-claim read of the recovery scan, so a transient fault
// leaves the run resumable at the next startup instead of marking it manual
// for good.

export const LANGGRAPH_RECOVERY_REASONS = Object.freeze({
  threadMismatch: "langgraph_thread_mismatch",
  threadUnreadable: "langgraph_thread_unreadable",
});

const COMPLETED_STATUSES = new Set(["completed", "reused"]);

// The saver's own verdicts on the stored record (rag/langgraph/checkpointer.js).
const THREAD_RECORD_ERROR_CODES = new Set([
  LANGGRAPH_SAVER_ERROR_CODES.invalidRecord,
  LANGGRAPH_SAVER_ERROR_CODES.ownerMismatch,
  LANGGRAPH_SAVER_ERROR_CODES.tenantMismatch,
  LANGGRAPH_SAVER_ERROR_CODES.threadScopeMismatch,
  LANGGRAPH_SAVER_ERROR_CODES.tooLarge,
]);

/**
 * Whether the run's thread agrees with its v2 graph checkpoint. Returns
 * { ok: true, thread } with thread null (no thread) or { behind, checkpointId,
 * interruptCount }, or { ok: false, reason } with one of
 * LANGGRAPH_RECOVERY_REASONS (and the reconciliation's or saver's own code as
 * `detail`, for the caller's log, never for the run row). Throws what the
 * read threw when the fault is not the record's (see above).
 */
export const verifyLangGraphThreadForRecovery = async ({
  accessScope,
  agentRunService,
  checkpoint,
  runId,
} = {}) => {
  let thread;

  // The saver refuses to exist while LangSmith tracing is on; recovery runs
  // at startup, after server.js refused such a process already, and a
  // process that got here regardless must not recover anything on LangGraph.
  assertLangSmithTracingDisabled();

  try {
    thread = await readLangGraphThread(
      new RunStoreCheckpointSaver({ accessScope, agentRunService, runId })
    );
  } catch (error) {
    if (!THREAD_RECORD_ERROR_CODES.has(error?.code)) {
      throw error;
    }

    return {
      detail: error.code,
      ok: false,
      reason: LANGGRAPH_RECOVERY_REASONS.threadUnreadable,
    };
  }

  if (thread === null) {
    return { ok: true, reason: null, thread: null };
  }

  const nodeRuns = checkpoint?.nodeRuns ?? [];
  const reconciled = reconcileLangGraphThreadReceipts({
    completedDigests: new Map(
      nodeRuns
        .filter((nodeRun) => COMPLETED_STATUSES.has(nodeRun.status))
        .map((nodeRun) => [
          nodeRun.nodeId,
          digestExecutionGraphTypedOutput(nodeRun.result?.graphOutput),
        ])
    ),
    // A failed node the checkpoint holds is no contradiction; the
    // checkpoint's own reconciliation decides what a failed node means.
    failedNodeIds: new Set(
      nodeRuns.filter((nodeRun) => nodeRun.status === "failed").map((nodeRun) => nodeRun.nodeId)
    ),
    nodeIds: new Set((checkpoint?.graph?.nodes ?? []).map((node) => node.nodeId)),
    receipts: thread.receipts,
  });

  if (!reconciled.ok) {
    return {
      detail: reconciled.reason,
      ok: false,
      reason: LANGGRAPH_RECOVERY_REASONS.threadMismatch,
    };
  }

  return {
    ok: true,
    reason: null,
    thread: {
      behind: reconciled.behind,
      checkpointId: thread.checkpointId,
      interruptCount: thread.interrupts.length,
    },
  };
};
