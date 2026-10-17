import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { Command, RunControl } from "@langchain/langgraph";

import {
  EXECUTION_GRAPH_NODE_STATUSES,
  createExecutionGraphNodeContext,
  createExecutionGraphNodeStates,
  createExecutionGraphRunControl,
} from "../agent-execution-graph-node.js";
import {
  admitExecutionGraphRun,
  finishExecutionGraphRun,
} from "../agent-execution-graph-runner.js";
import { EXECUTION_GRAPH_LIMITS } from "../agent-execution-graph.js";
import { assertAgentRuntimeSupported } from "../config.js";
import {
  LANGGRAPH_CHECKPOINT_RETENTION,
  RunStoreCheckpointSaver,
  deriveLangGraphThreadId,
} from "./checkpointer.js";
import {
  buildExecutionGraphReceipt,
  compileExecutionGraphOnLangGraph,
  toExecutionGraphReceiptKey,
} from "./compile-execution-graph.js";
import { createExecutionGraphConcurrencyGate } from "./concurrency-gate.js";
import { bridgeRequestSignalToDrain, resolveDrainedInvocationError } from "./drain-bridge.js";
import { assertLangSmithTracingDisabled } from "./langsmith-guard.js";
import { RUNTIME_RESUME_MARKER } from "./unified-graph-approval.js";
import {
  UNIFIED_GRAPH_RESUME_ERROR_CODES,
  prepareUnifiedGraphApprovalResume,
} from "./unified-graph-resume.js";

// The scheduler of every guarded execution graph: the custom-Skill DAG
// (agent-custom-skill-stage.js, since phase 2 of
// docs/adr/0001-langgraph-runtime.md) and the v3 unified graph
// (agent-unified-graph-stage.js, since phase 3). Phase 6 deleted the native
// scheduler (runExecutionGraph in agent-execution-graph-runner.js) that was
// the AGENT_RUNTIME=native rollback, and with it the dial; what it did on the
// parity suites' scenarios is frozen in test/fixtures/graph-goldens/, which
// LangGraph is now compared with. "Natively" below means that deleted
// scheduler, whose contract this one kept.
//
// Admission, the node states (and with them checkpoint reuse and denied
// nodes), each node's work and the end of the run are the shared modules'
// functions (agent-execution-graph-runner.js, agent-execution-graph-node.js);
// this file only schedules. LangGraph enters the nodes superstep by
// superstep, and the in-process gate (concurrency-gate.js) holds each one to
// the concurrency cap, side-effect exclusivity and queue order. The queue is
// the validator's layer order (orderExecutionGraphNodeStatesByLayer), so the
// supersteps are that queue cut at its layer boundaries. A node is decided
// once its whole superstep has finished, not the moment its own dependencies
// have. Against the native scheduler, which decided a node as soon as its
// dependencies settled, that changed when a node is decided, never what a
// node may do:
//   - a dependant starts only after the slowest node of the superstep before
//     it, so steps, run events, trace, Skill calls and per-Skill
//     observations can come in another order than natively, and the
//     request's latency follows the slowest sibling;
//   - a fail_fast failure in that superstep can skip a node the native loop
//     might already have launched (native took the same branch whenever the
//     failure landed first);
//   - a skip whose cause the native pass saw in the same pass (a node it had
//     just skipped) is recorded a superstep later;
//   - a cancellation stops before a superstep the native loop would have
//     settled without launching anything.
// All four are pinned in test/langgraph-execution-graph-runtime.test.mjs.
//
// The first two are races the native scheduler had too (which Skill finishes
// first), which LangGraph always settles the way native did when every node
// of a superstep finished before any dependant started; that also decides
// which nodes a budget that cannot fund them all funds. The others change
// what is recorded and when, never which node runs. No difference changes
// which nodes run without a race: with the queue in layer order the native
// scan reached a later layer's node ahead of an earlier layer's only when
// that earlier node was not ready yet, i.e. waited for a dependency still in
// flight beside a sibling that already settled, which is race 1.
//
// An approval pause binds to the settled nodes the native scheduler's pause
// did. A graph pauses once nothing else can run; a parked v3 node interrupts
// the thread only when every pending node of a later layer depends on it
// (compile-execution-graph.js hasExecutionGraphWorkBeforePause). When
// something could still run (an independent node of a later layer, or a node
// that would be skipped), the parked node returns its receipt instead, those
// layers run, and the stage persists the pause through pauseForApproval with
// the thread dropped: the continuation is then a fresh invocation. Both
// shapes are pinned in test/langgraph-unified-graph.test.mjs.
//
// Durability. The agent run's graph checkpoint stays the authority: node
// outputs, reuse, recovery, fencing and replay safety are decided from it.
// LangGraph's own thread checkpoint
// (RunStoreCheckpointSaver, on the same run row) is secondary: it holds
// receipts, and a call is a fresh invocation -- a replan or a startup
// recovery starts a new thread, seeded from the graph checkpoint's completed
// runs, after the previous thread is tombstoned -- except the continuation of
// an approval the graph parked on this thread (phase 3,
// unified-graph-resume.js): that one resumes the thread's pending interrupt
// with Command({ resume }), after the thread's receipts were checked against
// the graph checkpoint, so the nodes that settled before the pause are not
// entered again and the parked node re-runs from its first line into the
// stage's preflight, which now holds the decided gate. A thread that has no
// such interrupt (the pause was persisted without one), or that is behind the
// checkpoint, gets the fresh invocation; a thread that contradicts the
// checkpoint refuses the continuation.
//
// The invocation is always a root one. With the outer plan on LangGraph too
// (AGENT_OUTER_PLAN_RUNTIME=langgraph), the custom-Skill graph is invoked from
// inside the outer execution plan's custom_skills node
// (execution-plan-graph.js), where LangGraph's ambient config carries that
// node's nesting keys; invoked there as is, the graph would run as a subgraph
// and checkpoint into a namespace named after the outer task
// ("custom_skills:<task id>"), which readLangGraphThread (namespace "") never
// finds. So the invoke runs under an empty LangChain async context, with
// every option it needs passed explicitly, and the thread is in namespace ""
// whoever calls the executor.
//
// Cancellation is a drain (ADR, accepted decision; drain-bridge.js): the
// request's signal is never handed to LangGraph, which would abandon the node
// in flight and run it again on resume. It asks RunControl to stop at the
// next superstep boundary, each node passes the run's safe points (on entry,
// and again once the gate admits it), and every node in flight settles before
// the run fails with the request's cancellation.

export const LANGGRAPH_RUNNER_ERROR_CODES = Object.freeze({
  receiptMismatch: "AGENT_LANGGRAPH_RECEIPT_MISMATCH",
  threadConflict: UNIFIED_GRAPH_RESUME_ERROR_CODES.threadConflict,
});

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

const isPending = (state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.pending;

// A receipt the thread wrote before a resume says `completed` for a node
// this invocation reuses from the graph checkpoint; the digest is the same
// typed output. Everything else must be the receipt the state builds now.
const receiptMatchesState = ({ nodeOutputs, receipt, state }) => {
  const expected = buildExecutionGraphReceipt({ nodeOutputs, state });

  return (
    isDeepStrictEqual(receipt, expected) ||
    (state.status === EXECUTION_GRAPH_NODE_STATUSES.reused &&
      receipt?.status === EXECUTION_GRAPH_NODE_STATUSES.completed &&
      receipt.reason === null &&
      receipt.outputDigest === expected.outputDigest)
  );
};

// Every node is entered once and returns its receipt, so a missing or
// different one means LangGraph lost or reordered work. After an interrupt
// the parked node and the nodes behind it have none yet (they are pending or
// parked in process), and only the receipts that exist are checked.
const assertReceipts = ({ interrupted, nodeOutputs, receipts, states }) => {
  for (const state of states) {
    const key = toExecutionGraphReceiptKey(state.node.nodeId);

    if (!Object.hasOwn(receipts, key)) {
      if (
        interrupted &&
        (isPending(state) || state.status === EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval)
      ) {
        continue;
      }

      throw createReceiptMismatchError();
    }

    if (!receiptMatchesState({ nodeOutputs, receipt: receipts[key], state })) {
      throw createReceiptMismatchError();
    }
  }
};

/**
 * Runs a validated execution graph: the graph options of
 * createExecutionGraphNodeContext plus admission's, and
 * { agentRunService, agentRunId, runCursor } for the thread checkpointer. With
 * a run service and run id, LangGraph checkpoints into that run
 * (RunStoreCheckpointSaver bound to `graphResumeClaimId`, so its writes are
 * fenced exactly like the node steps); otherwise it runs without one (an ephemeral
 * thread nothing reads back), and a parked node returns its receipt instead
 * of calling interrupt(), so the caller persists the pause through
 * pauseForApproval once nothing else can run.
 *
 * `approvalResume` ({ gateId, nodeId }, the stored approval boundary) says
 * this call continues a decided approval gate: the thread is resumed when
 * it still holds that node's pause (see prepareApprovalResume), and a fresh
 * invocation runs otherwise.
 */
export const runExecutionGraphOnLangGraph = async ({
  agentRunId = null,
  agentRunService = null,
  approvalResume = null,
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
  runCursor = null,
  // accessScope, the observability and lifecycle hooks, the request values
  // and the services every node reads: createExecutionGraphNodeContext.
  ...nodeOptions
} = {}) => {
  // Before LangGraph or LangChain configures anything: a graph invocation
  // attaches the LangSmith tracer, with the graph's input, before any node or
  // adapter code could refuse it (langsmith-guard.js).
  assertLangSmithTracingDisabled();
  // Every graph is scheduled here, whoever called (a route, a task, startup
  // recovery, an evaluation runner calling runAgentRag directly): a removed
  // AGENT_RUNTIME value asked for the native scheduler, and running LangGraph
  // instead would ignore it silently (ADR 0001 phase 6).
  assertAgentRuntimeSupported();

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
  // here, with nothing changed.
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

  // Nothing left to launch (every node reused or denied): there is nothing to
  // schedule, and an invocation could only add a drain stop between nodes
  // that never run. Decided before the thread is touched:
  // a graph with nothing to run has no LangGraph writer (a settled graph,
  // replayed for its finalization, is fenced off the thread record).
  if (!states.some(isPending)) {
    return finishExecutionGraphRun({
      context,
      control,
      graph,
      pauseForApproval,
      states,
      statesByNodeId,
    });
  }

  const checkpointer = agentRunService && agentRunId
    ? new RunStoreCheckpointSaver({
        accessScope: nodeOptions.accessScope,
        agentRunService,
        graphResumeClaimId: nodeOptions.graphResumeClaimId ?? null,
        // Only the newest checkpoint of the thread and its parent are kept
        // (checkpointer.js, "Retention"): the record rides on the run row and
        // is rewritten whole by every later CAS of the run, and nothing here
        // reads further back than the newest checkpoint and its pending
        // writes -- a resume of a parked node's interrupt
        // (unified-graph-resume.js), the recovery read (unified-graph-
        // thread.js) and the receipts check after invoke.
        retainCheckpoints: LANGGRAPH_CHECKPOINT_RETENTION,
        runCursor,
        runId: agentRunId,
      })
    : null;
  // Always explicit. A graph without a run gets a thread of its own that
  // nothing ever reads back.
  const threadId = checkpointer?.threadId ??
    deriveLangGraphThreadId(nodeOptions.accessScope, `ephemeral:${randomUUID()}`);

  const resume = checkpointer && approvalResume
    ? await prepareUnifiedGraphApprovalResume({
        approvalResume,
        context,
        graph,
        nodeOutputs,
        saver: checkpointer,
        states,
        statesByNodeId,
      })
    : null;

  if (checkpointer && !resume) {
    // Every other call starts a new thread: an earlier invocation's record
    // (the graph before a replan, a crashed attempt, a pause persisted
    // without an interrupt) must not be resumed or mistaken for this one.
    // The tombstone is fenced like any saver write, so only the graph's
    // current owner can drop it.
    await checkpointer.deleteThread(threadId);
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
    compiled,
    context,
    control,
    gate: createExecutionGraphConcurrencyGate(concurrencyCap),
    graph,
    // A parked node stops the thread only where a thread exists to resume.
    interruptOnApproval: Boolean(checkpointer),
    nodeOutputs,
    states,
    statesByNodeId,
    trackNode,
  });
  const runControl = new RunControl();
  const removeDrainBridge = bridgeRequestSignalToDrain(runControl);
  let output;

  try {
    // Under an empty LangChain async context (see the header): LangGraph
    // merges the ambient config of an enclosing node into an invoke, nesting
    // keys included, and a thread_id alone does not stop that inside a
    // task. Nothing of this invocation reads that context; the agent event
    // sink and the request deadline are their own async stores.
    output = await AsyncLocalStorageProviderSingleton.runWithConfig(
      undefined,
      () =>
        app.invoke(
          // A resume answers the thread's one pending interrupt by id,
          // always with the runtime's own marker
          // (unified-graph-approval.js): no client value is ever persisted
          // as the thread's __resume__ write, and the node reads its
          // decision from the run store.
          resume
            ? new Command({ resume: { [resume.interruptId]: RUNTIME_RESUME_MARKER } })
            : { receipts: {} },
          {
            // The root namespace, explicitly: readLangGraphThread reads it.
            configurable: { thread_id: threadId, checkpoint_ns: "" },
            control: runControl,
            // Each superstep is checkpointed before the next one starts.
            durability: "sync",
            // Never the runtime cap (see concurrency-gate.js): every node of
            // a superstep must be started, and the gate decides when it
            // proceeds.
            maxConcurrency: graph.nodes.length,
            // One superstep per topological layer, plus the input step
            // (counted from the thread's current step on a resume).
            recursionLimit: compiled.depth + 1,
          }
        ),
      true
    );
  } catch (error) {
    // Nothing that started may still run once the caller fails the run.
    await Promise.allSettled([...inFlight]);
    throw resolveDrainedInvocationError({ error, fatalError: control.fatalError });
  } finally {
    removeDrainBridge();
  }

  const interrupts = Array.isArray(output?.__interrupt__) ? output.__interrupt__ : [];
  const parked = states.filter(
    (state) => state.status === EXECUTION_GRAPH_NODE_STATUSES.awaitingApproval
  );

  // A parked node stopped the graph: its superstep's other nodes settled and
  // were committed to the thread before invoke returned (durability sync).
  // Each interrupt must be a parked node's and no other, or the thread
  // cannot be resumed for the pause the stage is about to persist.
  if (
    interrupts.length > 0 &&
    (interrupts.length !== parked.length ||
      interrupts.some(
        (pending) => !parked.some((state) => state.node.nodeId === pending?.value?.nodeId)
      ))
  ) {
    throw createReceiptMismatchError();
  }

  assertReceipts({
    interrupted: interrupts.length > 0,
    nodeOutputs,
    receipts: output?.receipts ?? {},
    states,
  });

  if (checkpointer && interrupts.length === 0 && parked.length > 0) {
    // The parked node returned its receipt because later layers still had
    // work to run before the pause (compile-execution-graph.js); the graph
    // ran them and stops here, once nothing else can run. The thread holds
    // no interrupt to resume, so it is dropped now: the continuation starts
    // a fresh invocation, and no thread without a pause outlives the pause
    // the stage persists next.
    await checkpointer.deleteThread(threadId);
  }

  // On a pause: the stage's pauseForApproval, now that nothing else can run
  // (or the parked node's abandonment after a failure).
  return finishExecutionGraphRun({
    context,
    control,
    graph,
    pauseForApproval,
    states,
    statesByNodeId,
  });
};
