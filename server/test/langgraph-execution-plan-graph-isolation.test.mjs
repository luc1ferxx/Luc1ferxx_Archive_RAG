// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import { setImmediate as nextMacrotask, setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { getConfig } from "@langchain/langgraph";
import { Pregel } from "@langchain/langgraph/pregel";

import { emitAgentEvent, runWithAgentEventSink } from "../rag/agent-event-stream.js";
import { AGENT_EXECUTION_STEP_IDS } from "../rag/agent-execution-plan.js";
import {
  EXECUTION_PLAN_GRAPH_CACHE_LIMIT,
  LANGGRAPH_EXECUTION_PLAN_ERROR_CODES,
  compileAgentExecutionPlanGraph,
  createEventRelay,
  runExecutionPlanStagesOnLangGraph,
  selectScheduledExecutionPlanStages,
} from "../rag/langgraph/execution-plan-graph.js";
import { LANGSMITH_TRACING_ENABLED_CODE } from "../rag/langgraph/langsmith-guard.js";
import {
  REQUEST_CANCELLATION_REASONS,
  RequestCancelledError,
  createRequestCancellation,
  getRequestDeadline,
  runWithRequestCancellation,
} from "../rag/request-deadline.js";

// The outer plan's LangGraph Pregel is compiled once per plan shape and
// shared by every request with that shape (rag/langgraph/execution-plan-
// graph.js). That is only sound if nothing of a request lives in the compiled
// graph: the stages, the execution state the routing reads, the control flags,
// the in-flight set and the event relay must all come from the invocation.
// These tests run many requests at once on one compiled shape -- each with its
// own stages, delays, early exit, failure or cancellation, event sink or none
// -- and require every result, every error object, every stage entered and
// every agent event to belong to its own request.

const SHAPE = Object.freeze([
  AGENT_EXECUTION_STEP_IDS.researchBrief,
  AGENT_EXECUTION_STEP_IDS.customSkills,
  AGENT_EXECUTION_STEP_IDS.documentRag,
  AGENT_EXECUTION_STEP_IDS.webSearch,
]);
const ACCESS_SCOPE = Object.freeze({ userId: "alice", workspaceId: "workspace-a" });

// A deterministic generator, so a failure reproduces.
const createRandom = (seed) => {
  let value = seed >>> 0;

  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
};

const DELAYS = Object.freeze([
  () => undefined,
  () => Promise.resolve(),
  () => nextMacrotask(),
  () => sleep(0),
  () => sleep(1),
  () => sleep(2),
]);

// Every outer-plan graph LangGraph streams, by identity; `afterStream`, when
// a test sets it, runs once the stream is exhausted and before its consumer
// sees the end.
const streamedGraphs = new Set();
const streamPregel = Pregel.prototype.stream;
let afterStream = null;

Pregel.prototype.stream = async function streamRecordingGraph(...args) {
  streamedGraphs.add(this);

  const stream = await streamPregel.apply(this, args);
  const hook = afterStream;

  if (!hook) {
    return stream;
  }

  return (async function* streamThenHook() {
    yield* stream;
    hook();
  })();
};

const createRequest = (index, random) => {
  const requestId = `request-${index}`;
  const pickStage = () => Math.floor(random() * SHAPE.length);
  const ending = random();
  // At most one of: an early response, a failure, a cancellation; or none.
  const respondAt = ending < 0.3 ? pickStage() : null;
  const failAt = ending >= 0.3 && ending < 0.5 ? pickStage() : null;
  const cancelAt = ending >= 0.5 && ending < 0.7 ? pickStage() : null;
  const withSink = random() < 0.75;
  const delays = SHAPE.map(() => DELAYS[Math.floor(random() * DELAYS.length)]);
  const failure = Object.assign(new Error(`${requestId} failed`), { code: "STAGE_FAILED" });
  const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });
  const state = { requestId, response: null };
  const entered = [];
  const stopAt = respondAt ?? failAt ?? cancelAt ?? SHAPE.length - 1;
  const expectedStages = SHAPE.slice(0, stopAt + 1);

  const getStage = (step) => async () => {
    const position = SHAPE.indexOf(step.id);

    entered.push(step.id);
    // The request's own async context reaches the stage, and no LangChain
    // config is ambient in it.
    assert.equal(getConfig(), undefined);
    assert.equal(getRequestDeadline(), cancellation.store.deadlineAt);
    emitAgentEvent({ at: "start", requestId, stage: step.id, type: "trace_step" });
    await delays[position]();
    emitAgentEvent({ at: "end", requestId, stage: step.id, type: "trace_step" });

    if (position === failAt) {
      throw failure;
    }

    if (position === respondAt) {
      state.response = { requestId };
    }

    if (position === cancelAt) {
      cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);
    }
  };

  const run = async () => {
    const events = [];
    const invoke = () =>
      runWithRequestCancellation(cancellation, () =>
        runExecutionPlanStagesOnLangGraph({
          accessScope: ACCESS_SCOPE,
          agentRunId: requestId,
          executionPlan: SHAPE.map((id) => ({ id })),
          getStage,
          state,
        })
      );
    let outcome;

    try {
      const result = await (withSink
        ? runWithAgentEventSink((event) => events.push(event), invoke)
        : invoke());

      outcome = { result };
    } catch (error) {
      outcome = { error };
    } finally {
      cancellation.dispose();
    }

    return { entered, events, outcome };
  };

  const check = ({ entered: stages, events, outcome }) => {
    const label = JSON.stringify({ cancelAt, failAt, requestId, respondAt, withSink });

    assert.deepStrictEqual(stages, expectedStages, label);
    assert.deepStrictEqual(
      events,
      withSink
        ? expectedStages.flatMap((stage) => [
            { at: "start", requestId, stage, type: "trace_step" },
            { at: "end", requestId, stage, type: "trace_step" },
          ])
        : [],
      label
    );

    if (failAt !== null) {
      assert.equal(outcome.error, failure, label);
    } else if (cancelAt !== null && cancelAt < SHAPE.length - 1) {
      // The request's own cancellation, not another request's.
      assert.ok(outcome.error instanceof RequestCancelledError, label);
      assert.equal(outcome.error, cancellation.signal.reason, label);
    } else {
      // A cancellation raised inside the last stage has no safe point left
      // after it: natively the loop returns the state, and so does the graph.
      assert.equal(outcome.error, undefined, label);
      assert.equal(outcome.result, state, label);
      assert.deepStrictEqual(state.response, respondAt === null ? null : { requestId }, label);
    }
  };

  return { check, run };
};

test("concurrent requests on one compiled plan shape keep their own stages, state, results, errors, cancellations and agent events", async () => {
  const graph = compileAgentExecutionPlanGraph({ executionPlan: SHAPE.map((id) => ({ id })) });
  const random = createRandom(20261016);
  const total = 1024;
  const inFlight = 64;

  streamedGraphs.clear();

  for (let start = 0; start < total; start += inFlight) {
    const requests = Array.from({ length: inFlight }, (_, offset) =>
      createRequest(start + offset, random)
    );
    const observed = await Promise.all(requests.map((request) => request.run()));

    requests.forEach((request, offset) => request.check(observed[offset]));
  }

  // Every request ran on the one graph compiled for the shape.
  assert.deepStrictEqual([...streamedGraphs], [graph]);
  assert.equal(
    compileAgentExecutionPlanGraph({ executionPlan: SHAPE.map((id) => ({ id })) }),
    graph
  );
});

test("a plan shape is compiled once and kept in a bounded LRU", () => {
  const shapeOf = (ids) => ids.map((id) => ({ id }));
  const first = compileAgentExecutionPlanGraph({ executionPlan: shapeOf(SHAPE) });

  assert.equal(compileAgentExecutionPlanGraph({ executionPlan: shapeOf(SHAPE) }), first);
  assert.deepStrictEqual(Object.keys(first.nodes), [...SHAPE]);

  // EXECUTION_PLAN_GRAPH_CACHE_LIMIT other shapes push the first one out.
  const stageIds = Object.values(AGENT_EXECUTION_STEP_IDS);
  const otherShapes = [];

  for (let mask = 1; otherShapes.length < EXECUTION_PLAN_GRAPH_CACHE_LIMIT; mask += 1) {
    const ids = stageIds.filter((_, bit) => mask & (1 << bit));

    if (JSON.stringify(ids) !== JSON.stringify(SHAPE)) {
      otherShapes.push(ids);
    }
  }

  // Touching the first shape halfway keeps it the most recently used.
  otherShapes.forEach((ids, index) => {
    compileAgentExecutionPlanGraph({ executionPlan: shapeOf(ids) });

    if (index === EXECUTION_PLAN_GRAPH_CACHE_LIMIT / 2) {
      assert.equal(compileAgentExecutionPlanGraph({ executionPlan: shapeOf(SHAPE) }), first);
    }
  });
  assert.equal(compileAgentExecutionPlanGraph({ executionPlan: shapeOf(SHAPE) }), first);

  for (const ids of otherShapes) {
    compileAgentExecutionPlanGraph({ executionPlan: shapeOf(ids) });
  }

  assert.notEqual(compileAgentExecutionPlanGraph({ executionPlan: shapeOf(SHAPE) }), first);

  for (const executionPlan of [[], [{ id: "a" }, { id: "a" }], [{ id: "" }], [{}], undefined]) {
    assert.throws(() => compileAgentExecutionPlanGraph({ executionPlan }), /distinct stage ids/);
  }
});

test("the scheduled stages leave out the inert ones in plan order, and a plan of inert stages keeps its first", async () => {
  const plan = SHAPE.map((id) => ({ id }));
  const inert = new Set([AGENT_EXECUTION_STEP_IDS.researchBrief, AGENT_EXECUTION_STEP_IDS.webSearch]);

  assert.deepStrictEqual(
    selectScheduledExecutionPlanStages(plan, (step) => inert.has(step.id)),
    [plan[1], plan[2]]
  );
  assert.deepStrictEqual(selectScheduledExecutionPlanStages(plan, () => true), [plan[0]]);
  assert.deepStrictEqual(selectScheduledExecutionPlanStages(plan), plan);

  // Through the runner: only the scheduled stages are entered, and the graph
  // streamed is the one compiled for that shape.
  const entered = [];
  const state = { response: null };

  streamedGraphs.clear();

  const result = await runExecutionPlanStagesOnLangGraph({
    accessScope: ACCESS_SCOPE,
    executionPlan: plan,
    getStage: (step) => async () => {
      entered.push(step.id);
    },
    isStageInert: (step) => inert.has(step.id),
    state,
  });

  assert.equal(result, state);
  assert.deepStrictEqual(entered, [AGENT_EXECUTION_STEP_IDS.customSkills, AGENT_EXECUTION_STEP_IDS.documentRag]);
  assert.deepStrictEqual(
    [...streamedGraphs].map((graph) => Object.keys(graph.nodes)),
    [[AGENT_EXECUTION_STEP_IDS.customSkills, AGENT_EXECUTION_STEP_IDS.documentRag]]
  );
});

// The receipts check after the stream: a plan that stopped before its last
// stage must have stopped at the response. Here a stage's response is taken
// back once the stream has ended, so LangGraph ended the plan early for a
// reason the final state no longer shows; the run must fail rather than
// report a result. With the response kept, the same plan succeeds.
test("a plan that ends before its last stage without a response fails with the receipt mismatch", async () => {
  const runRespondingAtTheSecondStage = (state) =>
    runExecutionPlanStagesOnLangGraph({
      accessScope: ACCESS_SCOPE,
      executionPlan: SHAPE.map((id) => ({ id })),
      getStage: (step) => async () => {
        if (step.id === SHAPE[1]) {
          state.response = { status: 200 };
        }
      },
      state,
    });
  const kept = { response: null };

  assert.equal(await runRespondingAtTheSecondStage(kept), kept);

  const takenBack = { response: null };

  afterStream = () => {
    takenBack.response = null;
  };

  try {
    await assert.rejects(runRespondingAtTheSecondStage(takenBack), (error) => {
      assert.equal(error.code, LANGGRAPH_EXECUTION_PLAN_ERROR_CODES.receiptMismatch);
      assert.equal(error.status, 500);
      return true;
    });
  } finally {
    afterStream = null;
  }
});

// Every agent event a stage relays reaches the client before the run ends,
// however many there are and however the plan ends. LangGraph errors its
// stream a microtask after a node fails or a drain stops the loop, and a
// ReadableStream that errors drops every chunk not yet read, so a node may
// settle only once the consumer has forwarded what it relayed. Natively the
// sink receives each event as it is emitted, so these are the native events.
const BURST_PLAN = Object.freeze(SHAPE.slice(0, 3).map((id) => Object.freeze({ id })));
const BURST_ENDINGS = Object.freeze([
  // The stage throws right after its burst.
  "throw",
  // The request is cancelled during the stage, which then emits its burst
  // and settles; the drain stops the loop after that superstep.
  "drain",
  // The stage settles after its burst and the next one fails at once.
  "next_stage_throws",
  // The stage sets the response after its burst (the stream closes).
  "respond",
]);

const runBurst = async ({ count, ending, interleaved }) => {
  const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });
  const failure = Object.assign(new Error("stage failed"), { code: "STAGE_FAILED" });
  const state = { response: null };
  const entered = [];
  const events = [];
  const [first, second] = BURST_PLAN;
  const getStage = (step) => async () => {
    entered.push(step.id);

    if (step.id === second.id && ending === "next_stage_throws") {
      throw failure;
    }

    if (step.id !== first.id) {
      return;
    }

    if (ending === "drain") {
      cancellation.cancel(REQUEST_CANCELLATION_REASONS.deadlineExceeded);
    }

    for (let index = 0; index < count; index += 1) {
      emitAgentEvent({ index, type: "trace_step" });

      if (interleaved && index % 2 === 1) {
        await Promise.resolve();
      }
    }

    if (ending === "throw") {
      throw failure;
    }

    if (ending === "respond") {
      state.response = { status: 200 };
    }
  };
  let outcome;

  try {
    const result = await runWithAgentEventSink(
      (event) => events.push(event),
      () =>
        runWithRequestCancellation(cancellation, () =>
          runExecutionPlanStagesOnLangGraph({
            accessScope: ACCESS_SCOPE,
            agentRunId: `burst-${ending}-${count}`,
            executionPlan: BURST_PLAN,
            getStage,
            state,
          })
        )
    );

    outcome = { result };
  } catch (error) {
    outcome = { error };
  } finally {
    cancellation.dispose();
  }

  return { cancellation, entered, events, failure, outcome, state };
};

test("every agent event a stage emits reaches the sink before the run ends: after a throw, a drain, the next stage's failure or a response", async () => {
  for (const ending of BURST_ENDINGS) {
    for (const count of [1, 3, 8, 64]) {
      for (const interleaved of [false, true]) {
        const label = JSON.stringify({ count, ending, interleaved });
        const { cancellation, entered, events, failure, outcome, state } = await runBurst({
          count,
          ending,
          interleaved,
        });

        assert.deepStrictEqual(
          events,
          Array.from({ length: count }, (_, index) => ({ index, type: "trace_step" })),
          label
        );

        if (ending === "throw" || ending === "next_stage_throws") {
          assert.equal(outcome.error, failure, label);
        } else if (ending === "drain") {
          assert.ok(outcome.error instanceof RequestCancelledError, label);
          assert.equal(outcome.error, cancellation.signal.reason, label);
        } else {
          assert.equal(outcome.error, undefined, label);
          assert.equal(outcome.result, state, label);
        }

        assert.deepStrictEqual(
          entered,
          BURST_PLAN.slice(0, ending === "next_stage_throws" ? 2 : 1).map((step) => step.id),
          label
        );
      }
    }
  }
});

test("the event relay holds a node only while a counted chunk is unread, and close() releases it for good", async () => {
  const relay = createEventRelay();
  const written = [];
  const writer = relay.countWrites((chunk) => written.push(chunk));

  // Nothing written: nothing to wait for.
  assert.equal(relay.whenForwarded(), null);
  // Not a writer: passed through, never counted.
  assert.equal(relay.countWrites(undefined), undefined);

  writer("a");
  writer("b");

  let released = false;
  const waiting = relay.whenForwarded().then(() => {
    released = true;
  });

  relay.acknowledge();
  await nextMacrotask();
  assert.equal(released, false, "one of two chunks forwarded");

  relay.acknowledge();
  await waiting;
  assert.deepStrictEqual(written, ["a", "b"]);
  assert.equal(relay.whenForwarded(), null);

  // A write LangGraph refused never reaches the consumer: not counted.
  const refusing = relay.countWrites(() => {
    throw new Error("stream closed");
  });

  assert.throws(() => refusing("c"), /stream closed/);
  assert.equal(relay.whenForwarded(), null);

  // A consumer that stopped reading releases a pending wait, and every later
  // one.
  writer("d");

  const abandoned = relay.whenForwarded();

  assert.ok(abandoned instanceof Promise);
  relay.close();
  await abandoned;
  writer("e");
  assert.equal(relay.whenForwarded(), null);
});

// The exported scheduling core is an outer entry of its own: app.stream()
// configures LangChain's callbacks, and hands a tracer the graph and its
// first node, before any node's own check runs, so it refuses first.
// LANGCHAIN_VERBOSE is one of the refused variables and only attaches a
// local console handler, so the refusal is checked without any network.
test("runExecutionPlanStagesOnLangGraph refuses a LangSmith tracing variable before LangGraph starts", async () => {
  const previous = process.env.LANGCHAIN_VERBOSE;
  const entered = [];

  streamedGraphs.clear();
  process.env.LANGCHAIN_VERBOSE = "true";

  try {
    await assert.rejects(
      runExecutionPlanStagesOnLangGraph({
        accessScope: ACCESS_SCOPE,
        agentRunId: "langsmith-refused",
        executionPlan: BURST_PLAN,
        getStage: (step) => async () => {
          entered.push(step.id);
        },
        state: { response: null },
      }),
      (error) => {
        assert.equal(error.code, LANGSMITH_TRACING_ENABLED_CODE);
        return true;
      }
    );
  } finally {
    if (previous === undefined) {
      delete process.env.LANGCHAIN_VERBOSE;
    } else {
      process.env.LANGCHAIN_VERBOSE = previous;
    }
  }

  assert.deepStrictEqual([...streamedGraphs], []);
  assert.deepStrictEqual(entered, []);
});
