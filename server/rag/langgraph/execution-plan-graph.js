import { randomUUID } from "node:crypto";

import {
  Annotation,
  END,
  GraphDrained,
  RunControl,
  START,
  StateGraph,
  isGraphDrained,
} from "@langchain/langgraph";

import {
  createAgentExecutionPlanStages,
  hasAgentExecutionPlanResponse,
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
// AGENT_OUTER_PLAN_RUNTIME=langgraph at the one call site in agent.js (not by
// AGENT_RUNTIME, which leaves the outer plan on the native loop: the phase-3
// load test measured this graph at about +1.2 ms CPU per /chat, see
// config.js). Same options and result as runAgentExecutionPlan, same errors.
//
// The validated plan (agent-execution-plan.js, decided by the deterministic
// or LLM execution planner before this module is called, never re-derived
// here) becomes a StateGraph with one node per stage in plan order: START
// into the first stage, and after each stage a conditional edge that routes
// to the next stage or, once a stage produced the response (the native
// loop's early return, hasAgentExecutionPlanResponse), to END. The edge
// reads the closure-owned execution state the stages write, never the
// graph's state. Each stage is the native stage body of
// createAgentExecutionPlanStages, called unchanged; a stage decides for
// itself whether its Skill runs, exactly as under the native loop, because a
// stage without its selected Skill is not always a no-op (the custom stage
// may run authorized Skills the intent did not select; the Web stage is the
// fallback of the document result), and the native safe point at every
// stage boundary (throwIfRequestCancelled) is kept at every node's entry.
//
// LangGraph's state is one channel of stage receipts, keyed by step id:
// { status, reason } -- never a result, a question or an answer. After the
// stream, every stage entered must have returned its receipt, or the run
// fails rather than reports a result.
//
// No checkpointer (checkpointer: false): the V1 outer path keeps its
// step-based durability -- the agent run's persisted steps and the replay
// matrix decide what may be retried or resumed (agent-run-step-executor.js),
// and the custom-Skill stage keeps its own graph checkpoint -- so a LangGraph
// thread record would be a second, unused source of truth. Nothing resumes
// from this graph; the explicit thread_id only keeps the invocation off any
// ambient configurable.
//
// Streaming: the graph always runs through graph.stream with streamMode
// ["updates", "custom"] (never "messages"). Inside a node the agent event
// sink is pointed at config.writer when a streaming client is attached
// (agent-stream.js), so trace steps and verified answer drafts come out of
// the stream as custom chunks, in emission order, and are handed to the sink
// bound around the run. Without a client the writer is never called.
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

// A stage only ever writes its own key, so a keyed merge is the whole reducer.
const mergeReceipts = (current = {}, update = {}) => ({ ...current, ...update });

export const ExecutionPlanReceiptState = Annotation.Root({
  receipts: Annotation({ default: () => ({}), reducer: mergeReceipts }),
});

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

const createStageNode = ({ control, getStage, state, step, trackStage }) => {
  const stageId = step.id;

  return (_graphState, config) => {
    const task = (async () => {
      // LangGraph configures a node's callbacks before calling it; a tracer
      // switched on since the outer entry checked must not see the next one.
      assertLangSmithTracingDisabled();

      const runStage = getStage(step);

      control.entered.push(stageId);

      try {
        passSafePoint(control);
        await relayAgentEventsThroughWriter(config, () => runStage(step));
      } catch (error) {
        if (isGraphDrained(error)) {
          throw error;
        }

        // As the native loop's catch: the first error ends the plan, and the
        // original error object is what the run throws.
        control.fatalError ??= tagAgentExecutionPlanError(error, state);
        throw createStageStoppedError(error);
      }

      return { receipts: { [stageId]: buildExecutionPlanReceipt(state) } };
    })();

    return trackStage(task);
  };
};

/**
 * Compiles the validated plan: `executionPlan` and `getStage` are what
 * createAgentExecutionPlanStages returned, `state` its execution state,
 * `control` the invocation's flags, `trackStage(promise)` registers a stage's
 * in-flight work and returns it. Exported for tests; production goes
 * through runAgentExecutionPlanOnLangGraph.
 */
export const compileAgentExecutionPlanGraph = ({
  control,
  executionPlan,
  getStage,
  state,
  trackStage = (task) => task,
}) => {
  const builder = new StateGraph(ExecutionPlanReceiptState);

  executionPlan.forEach((step) => {
    builder.addNode(step.id, createStageNode({ control, getStage, state, step, trackStage }));
  });

  builder.addEdge(START, executionPlan[0].id);

  executionPlan.forEach((step, index) => {
    const next = index + 1 < executionPlan.length ? executionPlan[index + 1].id : END;

    // The loop's early return: a stage that set the response ends the plan;
    // otherwise the next stage in plan order, or END after the last one. The
    // decision reads the stages' own state, as the loop does.
    builder.addConditionalEdges(
      step.id,
      () => (hasAgentExecutionPlanResponse(state) ? END : next),
      next === END ? [END] : [next, END]
    );
  });

  return builder.compile({ checkpointer: false });
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
  const app = compileAgentExecutionPlanGraph({
    control,
    executionPlan,
    getStage,
    state,
    trackStage,
  });
  // Always explicit: a root invocation with a thread_id ignores whatever
  // LangChain configurable is ambient in the caller's async context. Without
  // a checkpointer nothing ever reads it back, so a run without an id gets
  // one of its own.
  const threadId = deriveLangGraphThreadId(
    options.accessScope,
    options.agentRunId ?? `ephemeral:${randomUUID()}`
  );
  const runControl = new RunControl();
  const removeDrainBridge = bridgeRequestSignalToDrain(runControl);
  const receipts = {};

  try {
    const stream = await app.stream(
      { receipts: {} },
      {
        configurable: { thread_id: threadId, [AGENT_STREAM_RELAY_KEY]: true },
        control: runControl,
        durability: "sync",
        // Never below a superstep's width (LangGraph 1.5.0 drops tasks past
        // it); a stage is a superstep of its own, so the plan's length is
        // more than enough.
        maxConcurrency: executionPlan.length,
        // One superstep per stage, plus the input step.
        recursionLimit: executionPlan.length + 1,
        streamMode: ["updates", "custom"],
      }
    );

    for await (const chunk of stream) {
      const update = forwardAgentStreamChunk(chunk);

      for (const nodeUpdate of Object.values(update ?? {})) {
        Object.assign(receipts, nodeUpdate?.receipts ?? {});
      }
    }
  } catch (error) {
    // Nothing that started may still run once the caller fails the run.
    await Promise.allSettled([...inFlight]);
    throw resolveDrainedInvocationError({ error, fatalError: control.fatalError });
  } finally {
    removeDrainBridge();
  }

  // Every stage entered returned its receipt and no other stage did, so
  // LangGraph neither lost nor reordered a stage. Only the last stage can
  // have set the response: the plan ends at the first one that does.
  const lastReceipt = buildExecutionPlanReceipt(state);
  const matchesReceipt = (stageId, index) => {
    const receipt = receipts[stageId];
    const expectedReason = index === control.entered.length - 1 ? lastReceipt.reason : null;

    return (
      receipt?.status === EXECUTION_PLAN_RECEIPT_STATUSES.completed &&
      (receipt.reason ?? null) === expectedReason
    );
  };

  if (
    Object.keys(receipts).length !== control.entered.length ||
    !control.entered.every(matchesReceipt)
  ) {
    throw createReceiptMismatchError();
  }

  return state;
};
