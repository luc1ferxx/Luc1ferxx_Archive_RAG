import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { RunControl, isGraphDrained } from "@langchain/langgraph";

import {
  EXECUTION_GRAPH_NODE_STATUSES,
  createExecutionGraphNodeContext,
  createExecutionGraphNodeStates,
  createExecutionGraphRunControl,
} from "../agent-execution-graph-node.js";
import {
  admitExecutionGraphRun,
  finishExecutionGraphRun,
  runExecutionGraph,
} from "../agent-execution-graph-runner.js";
import { EXECUTION_GRAPH_LIMITS } from "../agent-execution-graph.js";
import { resolveAgentRunTermination } from "../dependency-outage.js";
import {
  REQUEST_CANCELLATION_REASONS,
  getRequestSignal,
  isRequestCancelledError,
} from "../request-deadline.js";
import { RunStoreCheckpointSaver, deriveLangGraphThreadId } from "./checkpointer.js";
import {
  buildExecutionGraphReceipt,
  canScheduleExecutionGraphOnLangGraph,
  compileExecutionGraphOnLangGraph,
  toExecutionGraphReceiptKey,
} from "./compile-execution-graph.js";
import { createExecutionGraphConcurrencyGate } from "./concurrency-gate.js";
import { assertLangSmithTracingDisabled } from "./langsmith-guard.js";

// runExecutionGraph on LangGraph.js (docs/adr/0001-langgraph-runtime.md,
// phase 2), selected by AGENT_RUNTIME=langgraph in agent-custom-skill-stage.js.
//
// Same options, same result, same errors. Admission, the node states (and
// with them checkpoint reuse and denied nodes), each node's work and the end
// of the run are the native modules' own functions; only the scheduling
// changes hands. LangGraph enters the nodes superstep by superstep, and the
// in-process gate (concurrency-gate.js) holds each one to the native cap,
// side-effect exclusivity and queue order. What that changes is when a node
// is decided, never what a node may do: a node is decided once its whole
// superstep has finished, not the moment its own dependencies have. So
//   - a dependant starts only after the slowest node of the superstep before
//     it, so steps, run events, trace, Skill calls and per-Skill
//     observations can come in another order than natively, and the
//     request's latency follows the slowest sibling;
//   - a fail_fast failure in that superstep can skip a node the native loop
//     might already have launched (native takes the same branch whenever the
//     failure lands first);
//   - a skip whose cause the native pass saw in the same pass (a node it had
//     just skipped) is recorded a superstep later;
//   - a cancellation stops before a superstep the native loop would have
//     settled without launching anything.
// All four are pinned in test/langgraph-execution-graph-runtime.test.mjs.
//
// The first two are races native itself has (which Skill finishes first),
// which LangGraph always settles the way native does when every node of a
// superstep finishes before any dependant starts; that also decides which
// nodes a budget that cannot fund them all funds. The last two change what
// is recorded and when, never which node runs. A difference that changes
// which nodes run without any race is not accepted: where the native queue
// would hold a ready node back while a node of a later layer is declared
// ahead of one of an earlier layer, native starts the later one first on
// every run (canScheduleExecutionGraphOnLangGraph). Such an invocation is
// handed to the native scheduler whole, after the previous thread is dropped
// so no record outlives the call, and its result is exactly the native one.
//
// Durability. The agent run's graph checkpoint stays the authority: node
// outputs, reuse, recovery, fencing and replay safety are decided from it
// exactly as natively. LangGraph's own thread checkpoint
// (RunStoreCheckpointSaver, on the same run row) is secondary: it holds
// receipts, and every call is a fresh invocation -- a replan or a startup
// recovery starts a new thread, seeded from the graph checkpoint's completed
// runs, after the previous thread is tombstoned. Nothing resumes from a
// LangGraph checkpoint in this phase.
//
// Cancellation is a drain (ADR, accepted decision): the request's signal is
// never handed to LangGraph, which would abandon the node in flight and run it
// again on resume. It asks RunControl to stop at the next superstep boundary,
// each node keeps the native safe points (on entry, and again once the gate
// admits it), and every node in flight settles before the run fails with the
// request's cancellation.

export const LANGGRAPH_RUNNER_ERROR_CODES = Object.freeze({
  receiptMismatch: "AGENT_LANGGRAPH_RECEIPT_MISMATCH",
});

const noop = () => {};

const createReceiptMismatchError = () => {
  // A node LangGraph never ran (1.5.0 drops tasks under some configurations)
  // or a receipt that disagrees with the node's own state: the run cannot
  // tell what happened, so it fails instead of reporting a result.
  const error = new Error(
    "LangGraph finished a graph without a matching receipt for every node."
  );
  error.code = LANGGRAPH_RUNNER_ERROR_CODES.receiptMismatch;
  error.status = 500;
  return error;
};

// The error a failed invocation ends with: the run's first fatal error (the
// one the native scheduler throws), else LangGraph's own. A drain is a
// request cancellation: resolveAgentRunTermination reads the request's
// signal and deadline and returns its RequestCancelledError
// (AGENT_DEADLINE_EXCEEDED / AGENT_CLIENT_CANCELLED).
const resolveInvocationError = ({ control, error }) => {
  const original = control.fatalError ?? error;

  if (isRequestCancelledError(original)) {
    return original;
  }

  if (isGraphDrained(original)) {
    const termination = resolveAgentRunTermination(original);

    if (isRequestCancelledError(termination)) {
      return termination;
    }
  }

  return original;
};

// RunControl.requestDrain once the request is cancelled: LangGraph then
// starts no further superstep and the one in flight still commits. The node
// safe points are the second, independent stop (they also catch a deadline
// whose timer has not fired yet). Returns the listener's removal.
const bridgeRequestSignalToDrain = (runControl) => {
  const requestSignal = getRequestSignal();

  if (!requestSignal) {
    return noop;
  }

  const requestDrain = () =>
    runControl.requestDrain(
      requestSignal.reason?.reason ?? REQUEST_CANCELLATION_REASONS.clientCancelled
    );

  if (requestSignal.aborted) {
    requestDrain();
    return noop;
  }

  requestSignal.addEventListener("abort", requestDrain, { once: true });
  return () => requestSignal.removeEventListener("abort", requestDrain);
};

/**
 * runExecutionGraph's contract on LangGraph: the same options and result, plus
 * { agentRunService, agentRunId, runCursor } for the thread checkpointer. With
 * a run service and run id, LangGraph checkpoints into that run
 * (RunStoreCheckpointSaver bound to `graphResumeClaimId`, so its writes are
 * fenced exactly like the node steps); otherwise it runs without one. A graph
 * not declared in layer order runs on runExecutionGraph (see above).
 */
export const runExecutionGraphOnLangGraph = async ({
  agentRunId = null,
  agentRunService = null,
  runCursor = null,
  ...executorOptions
} = {}) => {
  // Before LangGraph or LangChain configures anything: a graph invocation
  // attaches the LangSmith tracer, with the graph's input, before any node or
  // adapter code could refuse it (langsmith-guard.js).
  assertLangSmithTracingDisabled();

  const {
    authorizedDocIds,
    authorizedSkillIds = null,
    completedNodeRuns = [],
    deniedNodeIds = [],
    docIds = [],
    graph,
    limits = EXECUTION_GRAPH_LIMITS,
    maxConcurrency,
    pauseForApproval = null,
    registry,
    // accessScope, the observability and lifecycle hooks, the request values
    // and the services every node reads: createExecutionGraphNodeContext.
    ...nodeOptions
  } = executorOptions;
  const { compiled, concurrencyCap, rejected, scopedDocIds } = admitExecutionGraphRun({
    authorizedDocIds,
    authorizedSkillIds,
    docIds,
    graph,
    limits,
    maxConcurrency,
    registry,
  });

  if (rejected) {
    return rejected;
  }

  // Built before anything is written: an invalid reuse or denial list throws
  // here, as natively, with nothing changed.
  const { nodeOutputs, states, statesByNodeId } = createExecutionGraphNodeStates({
    completedNodeRuns,
    deniedNodeIds,
    graph,
    registry,
  });
  const context = createExecutionGraphNodeContext({
    ...nodeOptions,
    authorizedDocIds: scopedDocIds,
    docIds,
    graph,
  });
  const control = createExecutionGraphRunControl();
  const checkpointer = agentRunService && agentRunId
    ? new RunStoreCheckpointSaver({
        accessScope: nodeOptions.accessScope,
        agentRunService,
        graphResumeClaimId: nodeOptions.graphResumeClaimId ?? null,
        runCursor,
        runId: agentRunId,
      })
    : null;
  // Always explicit: a root invoke with a thread_id ignores whatever
  // LangChain configurable is ambient in the caller's async context. A graph
  // without a run gets a thread of its own that nothing ever reads back.
  const threadId = checkpointer?.threadId ??
    deriveLangGraphThreadId(nodeOptions.accessScope, `ephemeral:${randomUUID()}`);

  if (checkpointer) {
    // Every call starts a new thread: an earlier invocation's record (the
    // graph before a replan, a crashed attempt) must not be resumed or
    // mistaken for this one. The tombstone is fenced like any saver write,
    // so only the graph's current owner can drop it.
    await checkpointer.deleteThread(threadId);
  }

  if (!canScheduleExecutionGraphOnLangGraph({ compiled, concurrencyCap, graph, states })) {
    // The native scheduler, given exactly what the stage gave this call.
    // Admission and the node states are pure, so building them twice
    // changes nothing.
    return runExecutionGraph(executorOptions);
  }

  // Nothing left to launch (every node reused or denied): the native loop
  // does not run a single pass, and an invocation could only add a drain the
  // native scheduler would not stop at.
  if (!states.some((state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.pending)) {
    return finishExecutionGraphRun({
      context,
      control,
      graph,
      pauseForApproval,
      states,
      statesByNodeId,
    });
  }

  const inFlight = new Set();
  const trackNode = (task) => {
    inFlight.add(task);
    task.then(
      () => inFlight.delete(task),
      () => inFlight.delete(task)
    );
    return task;
  };
  const app = compileExecutionGraphOnLangGraph({
    checkpointer: checkpointer ?? false,
    context,
    control,
    gate: createExecutionGraphConcurrencyGate(concurrencyCap),
    graph,
    nodeOutputs,
    states,
    statesByNodeId,
    trackNode,
  });
  const runControl = new RunControl();
  const removeDrainBridge = bridgeRequestSignalToDrain(runControl);
  let output;

  try {
    output = await app.invoke(
      { receipts: {} },
      {
        configurable: { thread_id: threadId },
        control: runControl,
        // Each superstep is checkpointed before the next one starts.
        durability: "sync",
        // Never the runtime cap (see concurrency-gate.js): every node of a
        // superstep must be started, and the gate decides when it proceeds.
        maxConcurrency: graph.nodes.length,
        // One superstep per topological layer, plus the input step.
        recursionLimit: compiled.depth + 1,
      }
    );
  } catch (error) {
    // Nothing that started may still run once the caller fails the run.
    await Promise.allSettled([...inFlight]);
    throw resolveInvocationError({ control, error });
  } finally {
    removeDrainBridge();
  }

  // Every node is entered once and returns its receipt, so a missing or
  // different one means LangGraph lost or reordered work.
  const receipts = output?.receipts ?? {};

  for (const state of states) {
    const key = toExecutionGraphReceiptKey(state.node.nodeId);

    if (
      !Object.hasOwn(receipts, key) ||
      !isDeepStrictEqual(receipts[key], buildExecutionGraphReceipt({ nodeOutputs, state }))
    ) {
      throw createReceiptMismatchError();
    }
  }

  return finishExecutionGraphRun({
    context,
    control,
    graph,
    pauseForApproval,
    states,
    statesByNodeId,
  });
};
