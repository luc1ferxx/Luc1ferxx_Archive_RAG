import { randomUUID } from "node:crypto";

import { Runnable } from "@langchain/core/runnables";
import { GraphDrained, RunControl, isGraphDrained } from "@langchain/langgraph";
import { BinaryOperatorAggregate, EphemeralValue } from "@langchain/langgraph/channels";
import { Channel, Pregel } from "@langchain/langgraph/pregel";

import {
  createAgentExecutionPlanStages,
  hasAgentExecutionPlanResponse,
  isAgentExecutionPlanStageStaticallyInert,
  tagAgentExecutionPlanError,
} from "../agent-execution-plan-runner.js";
import { getRequestCancellation } from "../request-deadline.js";
import {
  AGENT_STREAM_RELAY_KEY,
  forwardAgentStreamChunk,
  relayAgentEventsThroughWriter,
} from "./agent-stream.js";
import { deriveLangGraphThreadId } from "./checkpointer.js";
import { bridgeRequestSignalToDrain, resolveDrainedInvocationError } from "./drain-bridge.js";
import { assertLangSmithTracingDisabled } from "./langsmith-guard.js";

// The V1 outer execution plan on LangGraph.js (docs/adr/0001-langgraph-
// runtime.md, phase 3), selected by the experimental
// AGENT_OUTER_PLAN_RUNTIME=langgraph at the one call site in agent.js (never
// by AGENT_RUNTIME, which since phase 6 only refuses removed values). Same
// options and result as runAgentExecutionPlan, same errors.
//
// Built on LangGraph's public low-level Pregel API (@langchain/langgraph/
// pregel and /channels), not on StateGraph. The phase-3 load test measured the
// StateGraph version at about +1.2 ms CPU per /chat: StateGraph wraps every
// stage in a RunnableSequence of a node RunnableCallable, a state-update
// ChannelWrite, a control branch and the conditional edge's path, and each of
// those builds a LangSmith RunTree even with tracing off (about seven per
// stage), plus a START superstep. Here a stage is one Pregel node: a trigger
// channel, the stage as a Runnable whose invoke calls it directly (no
// runWithConfig around the stage, so no RunTree and no ambient LangChain
// config inside it), and one ChannelWrite.
//
// The validated plan (agent-execution-plan.js, decided by the deterministic
// or LLM execution planner before this module is called, never re-derived
// here) becomes one node per scheduled stage, in plan order: the input
// triggers the first node, and each node triggers the next one through an
// ephemeral channel, unless the stage set the response (the native loop's
// early return, hasAgentExecutionPlanResponse) -- then the write is skipped
// and the plan ends there. The routing reads the stages' own execution state,
// handed to this invocation, never the graph's. Each stage is the native stage
// body of createAgentExecutionPlanStages, called unchanged, and the native
// safe point at every stage boundary (throwIfRequestCancelled) is kept at
// every node's entry.
//
// Scheduled stages: every stage of the plan except those
// isAgentExecutionPlanStageStaticallyInert says would return at once without
// any effect (a built-in stage whose Skill was not selected; five of the
// seven stages of a document question). Skipping one leaves out only its
// safe point, which the next node's safe point covers: nothing could have
// changed in between. The custom-Skill, document and Web stages always run,
// because each decides at run time. A plan of inert stages only keeps its
// first stage, so every plan still runs on LangGraph and passes a safe point.
//
// Compiled once per shape: the graph depends only on the scheduled stage ids,
// so it is kept in a small LRU keyed by them. Nothing of a request lives in
// the compiled graph -- the execution state, the stages, the step objects,
// the run's control flags and in-flight set travel in config.configurable
// under one private key, read by every node and write mapper of that
// invocation. Channels are instantiated from their specs per invocation, and
// RunControl, the thread id and the drain bridge are per invocation already.
//
// LangGraph's state is one channel of stage receipts, keyed by step id:
// { status, reason } -- never a result, a question or an answer. After the
// stream, the stages entered must be the scheduled stages in plan order, up
// to the last one or to the one that set the response, each with its
// receipt, or the run fails rather than reports a result.
//
// No checkpointer (checkpointer: false): the V1 outer path keeps its
// step-based durability -- the agent run's persisted steps and the replay
// matrix decide what may be retried or resumed (agent-run-step-executor.js),
// and the custom-Skill stage keeps its own graph checkpoint -- so a LangGraph
// thread record would be a second, unused source of truth. Nothing resumes
// from this graph; the explicit thread_id only keeps the invocation off any
// ambient configurable. No retry policy: a stage runs at most once.
//
// Streaming: the graph always runs through graph.stream with streamMode
// ["updates", "custom"] (never "messages"). Inside a node the agent event
// sink is pointed at config.writer when a streaming client is attached
// (agent-stream.js; the node is handed its config explicitly, since there is
// no ambient LangChain config to read it from), so trace steps and verified
// answer drafts come out of the stream as custom chunks, in emission order,
// and are handed to the sink bound around the run. Without a client the
// writer is never called. A node settles only once the consumer has handed
// every chunk it relayed to that sink (createEventRelay below): when a stage
// fails, or a drain stops the loop after it, LangGraph errors its internal
// stream a microtask later, and a ReadableStream that errors discards every
// chunk not yet read -- the trace steps a stage emitted just before it threw
// would never reach the client, which the native loop always delivers.
//
// Cancellation is a drain (drain-bridge.js): the request's signal asks
// RunControl to start no further superstep, the stage in flight settles, and
// the run fails with the request's own RequestCancelledError; an
// AgentRunInterruptError (an approval) and every other stage error leave the
// invocation as the original error object, with the execution state attached
// for an interrupt as natively.

export const LANGGRAPH_EXECUTION_PLAN_ERROR_CODES = Object.freeze({
  receiptMismatch: "AGENT_LANGGRAPH_PLAN_RECEIPT_MISMATCH",
  // What LangGraph sees of a stage that stopped the plan (see below).
  stageStopped: "AGENT_LANGGRAPH_STAGE_STOPPED",
});

export const EXECUTION_PLAN_RECEIPT_STATUSES = Object.freeze({
  completed: "completed",
});

export const EXECUTION_PLAN_RECEIPT_REASONS = Object.freeze({
  // The stage set the response: the plan ends here.
  responded: "responded",
});

/** The configurable key under which one invocation's context travels. */
export const EXECUTION_PLAN_GRAPH_CONTEXT_KEY = "archive_rag_execution_plan_context";

/** What starts an invocation: written to the input channel, read by nobody. */
export const EXECUTION_PLAN_GRAPH_INPUT = true;

/** How many compiled plan shapes are kept. */
export const EXECUTION_PLAN_GRAPH_CACHE_LIMIT = 64;

const INPUT_CHANNEL = "plan:input";
const RECEIPTS_CHANNEL = "receipts";
const triggerChannelOf = (stageId) => `plan:to:${stageId}`;

// A stage only ever writes its own key, so a keyed merge is the whole reducer.
const mergeReceipts = (current = {}, update = {}) => ({ ...current, ...update });

/** The receipt a stage returns to LangGraph once its body has settled. */
export const buildExecutionPlanReceipt = (state) => ({
  reason: hasAgentExecutionPlanResponse(state)
    ? EXECUTION_PLAN_RECEIPT_REASONS.responded
    : null,
  status: EXECUTION_PLAN_RECEIPT_STATUSES.completed,
});

const createReceiptMismatchError = () => {
  const error = new Error(
    "LangGraph finished the execution plan without a matching receipt for every stage."
  );
  error.code = LANGGRAPH_EXECUTION_PLAN_ERROR_CODES.receiptMismatch;
  error.status = 500;
  return error;
};

// What LangGraph is allowed to see of a stage that stopped the plan: a stable
// code. The original error (an approval interrupt with its private detail, an
// outage, a cancellation) stays in this process, on control.fatalError, and is
// the one the run throws.
const createStageStoppedError = (cause) => {
  const rawCode = typeof cause?.code === "string" ? cause.code : cause?.name;
  const code = /^[A-Za-z0-9_.-]{1,80}$/.test(String(rawCode ?? ""))
    ? String(rawCode)
    : "error";
  const error = new Error(`An execution stage stopped the plan (${code}).`);
  error.name = "ExecutionStageStopped";
  error.code = LANGGRAPH_EXECUTION_PLAN_ERROR_CODES.stageStopped;
  return error;
};

// The native loop's safe point before a stage, as a drain: the cancellation
// becomes the run's fatal error (what the loop would have thrown), and the
// GraphDrained stops LangGraph without an error write or a receipt.
const passSafePoint = (control) => {
  const cancellation = getRequestCancellation();

  if (cancellation) {
    control.fatalError ??= cancellation;
    throw new GraphDrained(cancellation.reason);
  }
};

// A Runnable whose invoke calls its function directly (public
// @langchain/core API). Unlike LangGraph's RunnableCallable it neither opens
// an ambient LangChain config around the call nor builds a RunTree, and it
// holds nothing but its shape-level function.
class ExecutionPlanGraphStep extends Runnable {
  lc_namespace = ["archive_rag", "execution_plan_graph"];

  constructor(name, func) {
    super();
    this.name = name;
    this.func = func;
  }

  async invoke(input, config) {
    return this.func(input, config);
  }
}

/**
 * The handshake between a node that relays agent events through LangGraph's
 * config.writer and the loop that consumes the stream: `countWrites(writer)`
 * is the node's writer, counting each chunk handed to LangGraph;
 * `acknowledge()` is called by the consumer for each custom chunk it has
 * handed to the outer sink; `whenForwarded()` is null when nothing is pending,
 * else a promise that resolves once the consumer caught up. `close()` releases
 * every wait for good, once the consumer stopped reading (it failed or the
 * stream ended), so a node never waits on a consumer that is gone.
 *
 * Only an invocation that streams the "custom" mode, declares the relay and
 * consumes the stream may carry one: a chunk counted but never read would
 * hold its node until close().
 */
export const createEventRelay = () => {
  let relayed = 0;
  let forwarded = 0;
  let open = true;
  let waiters = [];

  const caughtUp = () => !open || forwarded >= relayed;
  const wake = () => {
    if (waiters.length > 0 && caughtUp()) {
      const resolved = waiters;

      waiters = [];
      resolved.forEach((resolve) => resolve());
    }
  };

  return {
    acknowledge() {
      forwarded += 1;
      wake();
    },
    close() {
      open = false;
      wake();
    },
    countWrites(writer) {
      if (typeof writer !== "function") {
        return writer;
      }

      // Counted once LangGraph took it: a write that throws never reaches
      // the consumer, so it must not hold the node.
      return (chunk) => {
        const written = writer(chunk);

        relayed += 1;
        return written;
      };
    },
    whenForwarded() {
      return caughtUp()
        ? null
        : new Promise((resolve) => {
            waiters.push(resolve);
          });
    },
  };
};

// Holds a node until the consumer has forwarded every event it relayed (see
// createEventRelay); costs nothing when no event is pending.
const waitUntilRelayed = async (relay) => {
  const pending = relay?.whenForwarded() ?? null;

  if (pending) {
    await pending;
  }
};

const readInvocationContext = (config) => {
  const context = config?.configurable?.[EXECUTION_PLAN_GRAPH_CONTEXT_KEY];

  if (!context) {
    throw new Error("The execution plan graph was invoked without its invocation context.");
  }

  return context;
};

const runStageNode = async (stageId, context, config) => {
  // A tracer switched on since the outer entry checked must not see the next
  // stage.
  assertLangSmithTracingDisabled();

  const { control, getStage, relay, state, stepsById } = context;
  const step = stepsById.get(stageId);
  const runStage = getStage(step);
  // The node's writer, counted when this invocation relays (see
  // createEventRelay); relayAgentEventsThroughWriter still decides whether
  // the stage's events go through it at all.
  const relayConfig = relay
    ? { configurable: config?.configurable, writer: relay.countWrites(config?.writer) }
    : config;

  control.entered.push(stageId);

  try {
    passSafePoint(control);
    await relayAgentEventsThroughWriter(relayConfig, () => runStage(step));
  } catch (error) {
    if (!isGraphDrained(error)) {
      // As the native loop's catch: the first error ends the plan, and the
      // original error object is what the run throws.
      control.fatalError ??= tagAgentExecutionPlanError(error, state);
    }

    // Every event the stage emitted before it failed reaches the client
    // before LangGraph errors its stream.
    await waitUntilRelayed(relay);

    if (isGraphDrained(error)) {
      throw error;
    }

    throw createStageStoppedError(error);
  }

  // And before the receipt: a drain requested meanwhile errors the stream
  // right after this superstep, and so does the next stage's failure.
  await waitUntilRelayed(relay);

  return buildExecutionPlanReceipt(state);
};

// One scheduled stage as a Pregel node: triggered by `trigger`, it runs the
// stage, then writes its receipt and, unless the stage set the response, the
// next stage's trigger. Only shape-level values (ids, channel names) are
// closed over; everything of a request is read from the invocation's config.
const createStageNode = ({ nextStageId, stageId, trigger }) => {
  const writes = {
    [RECEIPTS_CHANNEL]: new ExecutionPlanGraphStep(`${stageId}:receipt`, (receipt) => ({
      [stageId]: receipt,
    })),
  };

  if (nextStageId !== null) {
    // The loop's early return: a stage that set the response ends the plan
    // (undefined skips the write, so the next stage is never triggered);
    // otherwise the next stage in plan order. The decision reads this
    // invocation's execution state, as the loop does.
    writes[triggerChannelOf(nextStageId)] = new ExecutionPlanGraphStep(
      `${stageId}:next`,
      (_receipt, config) =>
        hasAgentExecutionPlanResponse(readInvocationContext(config).state) ? undefined : true
    );
  }

  return Channel.subscribeTo(trigger)
    .pipe(
      new ExecutionPlanGraphStep(stageId, (_input, config) => {
        const context = readInvocationContext(config);

        return context.trackStage(runStageNode(stageId, context, config));
      })
    )
    .pipe(Channel.writeTo([], writes));
};

const buildExecutionPlanGraph = (stageIds) => {
  const channels = {
    [INPUT_CHANNEL]: new EphemeralValue(),
    [RECEIPTS_CHANNEL]: new BinaryOperatorAggregate(mergeReceipts, () => ({})),
  };
  const nodes = {};

  stageIds.forEach((stageId, index) => {
    const trigger = index === 0 ? INPUT_CHANNEL : triggerChannelOf(stageId);

    if (index > 0) {
      channels[trigger] = new EphemeralValue();
    }

    nodes[stageId] = createStageNode({
      nextStageId: index + 1 < stageIds.length ? stageIds[index + 1] : null,
      stageId,
      trigger,
    });
  });

  return new Pregel({
    channels,
    checkpointer: false,
    inputChannels: INPUT_CHANNEL,
    nodes,
    outputChannels: [RECEIPTS_CHANNEL],
    streamChannels: [RECEIPTS_CHANNEL],
  });
};

const compiledGraphs = new Map();

/**
 * The compiled graph of a plan shape: `executionPlan` is the list of stages
 * to schedule (validated steps, or anything with an `id`), in order. The same
 * shape returns the same graph (an LRU of EXECUTION_PLAN_GRAPH_CACHE_LIMIT
 * shapes); an invocation must carry its own context
 * (bindExecutionPlanGraphContext) in config.configurable.
 */
export const compileAgentExecutionPlanGraph = ({ executionPlan } = {}) => {
  const stageIds = (Array.isArray(executionPlan) ? executionPlan : []).map((step) => step?.id);

  if (
    stageIds.length === 0 ||
    stageIds.some((stageId) => typeof stageId !== "string" || stageId.length === 0) ||
    new Set(stageIds).size !== stageIds.length
  ) {
    throw new Error("The execution plan graph needs one or more distinct stage ids.");
  }

  const key = JSON.stringify(stageIds);
  const cached = compiledGraphs.get(key);

  if (cached) {
    compiledGraphs.delete(key);
    compiledGraphs.set(key, cached);
    return cached;
  }

  const graph = buildExecutionPlanGraph(stageIds);

  compiledGraphs.set(key, graph);

  if (compiledGraphs.size > EXECUTION_PLAN_GRAPH_CACHE_LIMIT) {
    compiledGraphs.delete(compiledGraphs.keys().next().value);
  }

  return graph;
};

/**
 * The configurable entry of one invocation of a compiled plan graph:
 * `executionPlan` the scheduled stages (the shape the graph was compiled
 * for), `getStage` and `state` what createAgentExecutionPlanStages returned,
 * `control` the invocation's flags ({ entered: [], fatalError: null }),
 * `trackStage(promise)` registers a stage's in-flight work and returns it,
 * and `relay` the invocation's event relay (createEventRelay), only for an
 * invocation whose consumer acknowledges every custom chunk; without one a
 * node never waits.
 */
export const bindExecutionPlanGraphContext = ({
  control,
  executionPlan,
  getStage,
  relay = null,
  state,
  trackStage = (task) => task,
}) => ({
  [EXECUTION_PLAN_GRAPH_CONTEXT_KEY]: {
    control,
    getStage,
    relay,
    state,
    stepsById: new Map(executionPlan.map((step) => [step.id, step])),
    trackStage,
  },
});

/**
 * The stages a LangGraph invocation schedules: every stage `isStageInert`
 * does not mark, in plan order; a plan of inert stages only keeps its first.
 */
export const selectScheduledExecutionPlanStages = (
  executionPlan,
  isStageInert = () => false
) => {
  const scheduled = executionPlan.filter((step) => !isStageInert(step));

  return scheduled.length > 0 ? scheduled : executionPlan.slice(0, 1);
};

/**
 * The scheduling part of runAgentExecutionPlanOnLangGraph, over stages
 * already built: `executionPlan`, `getStage` and `state` as
 * createAgentExecutionPlanStages returned them, `isStageInert(step)` the
 * pruning predicate. Resolves to `state`, or throws the run's error.
 * Exported for tests and measurements; production goes through
 * runAgentExecutionPlanOnLangGraph. An outer entry of its own, so it refuses
 * a LangSmith tracer before LangGraph configures any callback.
 */
export const runExecutionPlanStagesOnLangGraph = async ({
  accessScope,
  agentRunId,
  executionPlan,
  getStage,
  isStageInert,
  state,
}) => {
  // app.stream() configures the callbacks -- and hands the tracer the graph
  // and its first node -- before any node's own check could refuse it.
  assertLangSmithTracingDisabled();

  const scheduledPlan = selectScheduledExecutionPlanStages(executionPlan, isStageInert);
  const app = compileAgentExecutionPlanGraph({ executionPlan: scheduledPlan });
  const control = { entered: [], fatalError: null };
  const inFlight = new Set();
  const trackStage = (task) => {
    inFlight.add(task);
    task.then(
      () => inFlight.delete(task),
      () => inFlight.delete(task)
    );
    return task;
  };
  // Always explicit: a root invocation with a thread_id ignores whatever
  // LangChain configurable is ambient in the caller's async context. Without
  // a checkpointer nothing ever reads it back, so a run without an id gets
  // one of its own.
  const threadId = deriveLangGraphThreadId(
    accessScope,
    agentRunId ?? `ephemeral:${randomUUID()}`
  );
  const runControl = new RunControl();
  const removeDrainBridge = bridgeRequestSignalToDrain(runControl);
  const receipts = {};
  // This loop reads every chunk and acknowledges every custom one, so the
  // nodes may wait on it (createEventRelay).
  const relay = createEventRelay();

  try {
    const stream = await app.stream(EXECUTION_PLAN_GRAPH_INPUT, {
      configurable: {
        thread_id: threadId,
        [AGENT_STREAM_RELAY_KEY]: true,
        ...bindExecutionPlanGraphContext({
          control,
          executionPlan: scheduledPlan,
          getStage,
          relay,
          state,
          trackStage,
        }),
      },
      control: runControl,
      durability: "sync",
      // Never below a superstep's width (LangGraph 1.5.0 drops tasks past
      // it); a stage is a superstep of its own, so the scheduled stage count
      // is more than enough.
      maxConcurrency: scheduledPlan.length,
      // One superstep per scheduled stage, plus one spare.
      recursionLimit: scheduledPlan.length + 1,
      streamMode: ["updates", "custom"],
    });

    for await (const chunk of stream) {
      const update = forwardAgentStreamChunk(chunk);

      if (Array.isArray(chunk) && chunk[0] === "custom") {
        // Handed to the outer sink: the node that relayed it may settle.
        relay.acknowledge();
        continue;
      }

      for (const nodeUpdate of Object.values(update ?? {})) {
        Object.assign(receipts, nodeUpdate?.[RECEIPTS_CHANNEL] ?? {});
      }
    }
  } catch (error) {
    // Nothing reads the stream any more (the sink or the stream failed): no
    // node may wait for it, or the wait below would never end.
    relay.close();
    // Nothing that started may still run once the caller fails the run.
    await Promise.allSettled([...inFlight]);
    throw resolveDrainedInvocationError({ error, fatalError: control.fatalError });
  } finally {
    relay.close();
    removeDrainBridge();
  }

  // The stages entered are the scheduled ones in plan order, up to the last
  // or to the one that set the response, and each returned its receipt while
  // no other stage did: LangGraph neither lost, reordered nor added a stage.
  // Only the last stage entered can have set the response: the plan ends at
  // the first one that does.
  const { entered } = control;
  const lastReceipt = buildExecutionPlanReceipt(state);
  const matchesReceipt = (stageId, index) => {
    const receipt = receipts[stageId];
    const expectedReason = index === entered.length - 1 ? lastReceipt.reason : null;

    return (
      stageId === scheduledPlan[index]?.id &&
      receipt?.status === EXECUTION_PLAN_RECEIPT_STATUSES.completed &&
      (receipt.reason ?? null) === expectedReason
    );
  };
  const reachedTheEnd =
    entered.length === scheduledPlan.length ||
    lastReceipt.reason === EXECUTION_PLAN_RECEIPT_REASONS.responded;

  if (
    entered.length === 0 ||
    !reachedTheEnd ||
    Object.keys(receipts).length !== entered.length ||
    !entered.every(matchesReceipt)
  ) {
    throw createReceiptMismatchError();
  }

  return state;
};

/**
 * runAgentExecutionPlan on LangGraph: the same options, the same execution
 * state as its result, and the same errors.
 */
export const runAgentExecutionPlanOnLangGraph = async (options = {}) => {
  // Before LangGraph or LangChain configures anything (langsmith-guard.js).
  assertLangSmithTracingDisabled();

  // Validation and the stages exactly as the native loop builds them; an
  // invalid plan throws here with nothing changed.
  const { executionPlan, getStage, state } = createAgentExecutionPlanStages(options);

  return runExecutionPlanStagesOnLangGraph({
    accessScope: options.accessScope,
    agentRunId: options.agentRunId,
    executionPlan,
    getStage,
    // The same lookup over the same options the stage bodies make.
    isStageInert: (step) => isAgentExecutionPlanStageStaticallyInert(step, options),
    state,
  });
};
