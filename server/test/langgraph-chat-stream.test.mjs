// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";

// Phase-3 evidence for /chat/stream with the outer plan on LangGraph
// (rag/langgraph/agent-stream.js, routes/chat.js; behind the experimental
// AGENT_OUTER_PLAN_RUNTIME=langgraph since the phase-3 load test, config.js
// says why): the real app (createApp over the local store, an in-memory run
// store and a stand-in model) answers the same request natively, with the
// outer plan on LangGraph, and under AGENT_RUNTIME=langgraph with the outer
// dial unset (the production setting: the native route and loop), and the SSE
// bytes must be identical after masking -- every trace_step and answer_draft
// event in order, the result event (which equals the /chat answer), then
// done. Answer drafts carry only sentences the finalizer's claim check
// supports; a deadline ends the stream with the same error/done frames; a
// client that leaves cancels the run to the same terminal record; with the
// outer plan on LangGraph a LangSmith tracer switched on is refused as an
// error/done sequence before the run starts, and AGENT_RUNTIME=langgraph
// alone, which builds no graph for a document question, answers it natively.
//
// The runner's on-demand import of the plan graph is redirected to a tap, so
// the suite also proves the outer-dial pass scheduled the outer plan on
// LangGraph and the AGENT_RUNTIME=langgraph pass did not (a stream identical
// because every pass ran natively would prove nothing); the route's import of
// the stream relay is tapped too, so each pass also shows which branch of the
// route answered.
const PLAN_GRAPH_TAP_URL = new URL(
  "./langgraph-execution-plan-graph/plan-graph-tap.mjs",
  import.meta.url
).href;
const AGENT_STREAM_TAP_URL = new URL(
  "./langgraph-execution-plan-graph/agent-stream-tap.mjs",
  import.meta.url
).href;

register("./langgraph-runtime-parity/redirect-hooks.mjs", import.meta.url, {
  data: {
    redirects: [
      {
        capture: PLAN_GRAPH_TAP_URL,
        fromPrefix: new URL("../rag/", import.meta.url).href,
        target: new URL("../rag/langgraph/execution-plan-graph.js", import.meta.url).href,
      },
      {
        capture: AGENT_STREAM_TAP_URL,
        fromPrefix: new URL("../routes/", import.meta.url).href,
        target: new URL("../rag/langgraph/agent-stream.js", import.meta.url).href,
      },
    ],
  },
});

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const {
  ANSWER_RATE_FLAGS_OFF,
  maskVolatile,
  maskVolatileText,
  projectAgentRun,
  withEnv,
} = await import("./langgraph-execution-plan-graph/mask.mjs");
const { takePlanGraphInvocations } = await import(PLAN_GRAPH_TAP_URL);
const { takeAgentStreamRelayCalls } = await import(AGENT_STREAM_TAP_URL);
const { createApp } = await import("../app.js");
const { emitAgentEvent, runWithAgentEventSink } = await import("../rag/agent-event-stream.js");
const { deterministicPlannerAdapter } = await import("../rag/agent-execution-plan.js");
const { deterministicIntentPlannerAdapter } = await import("../rag/agent-intent-planner.js");
const { AGENT_RUN_STATUSES, createAgentRunService, createInMemoryAgentRunStore } = await import(
  "../rag/agent-runs.js"
);
const { writeQaAnswer } = await import("../rag/answer-writer.js");
const { LANGSMITH_TRACING_ENABLED_CODE } = await import("../rag/langgraph/langsmith-guard.js");
const {
  AGENT_STREAM_EVENT_TYPES,
  AGENT_STREAM_RELAY_KEY,
  forwardAgentStreamChunk,
  relayAgentEventsThroughWriter,
  streamAgentRun,
  toAgentStreamFrame,
} = await import("../rag/langgraph/agent-stream.js");
const { completeText, configureOpenAIProvider, resetOpenAIProvider } = await import(
  "../rag/openai.js"
);
const { describeAgentRouteError } = await import("../routes/chat.js");
const { getRequestSignal } = await import("../rag/request-deadline.js");

// The three passes, by the two dials they pin: everything native; the outer
// plan (and with it the stream relay) on LangGraph, with AGENT_RUNTIME=
// langgraph as well; and AGENT_RUNTIME=langgraph alone, which keeps the outer
// plan on the native loop and the route on its native branch.
const PASSES = Object.freeze({
  native: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: undefined, AGENT_RUNTIME: "native" }),
  langgraph: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: "langgraph", AGENT_RUNTIME: "langgraph" }),
  outerNative: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: undefined, AGENT_RUNTIME: "langgraph" }),
});
const PASS_NAMES = Object.freeze(Object.keys(PASSES));
const QUESTION = "What are the renewal term and the monthly fee?";
const CITATION = Object.freeze({
  docId: "contract-1",
  excerpt:
    "The agreement renews every 12 months unless either party gives 30 days notice. The monthly fee is 12.5 thousand dollars.",
  fileName: "services-agreement.pdf",
  pageNumber: 3,
});
const SUPPORTED_SENTENCES = Object.freeze([
  "The agreement renews every 12 months. [Source 1]",
  "The monthly fee is 12.5 thousand dollars. [Source 1]",
]);
const UNSUPPORTED_SENTENCE = "The contract was signed in Paris. [Source 1]";

const BASE_ENV = Object.freeze({
  ...ANSWER_RATE_FLAGS_OFF,
  AGENT_CANCEL_ON_DISCONNECT: undefined,
  AGENT_OUTER_PLAN_RUNTIME: undefined,
  AGENT_REQUEST_TIMEOUT_MS: undefined,
  AGENT_SERVICE_URL: undefined,
  AGENT_UNIFIED_GRAPH_ROLLOUT: "off",
  ARCHIVE_RAG_ROLE: undefined,
  MODEL_GATEWAY_URL: undefined,
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
  RAG_QA_ANSWER_VERDICT: undefined,
  RAG_QA_VERDICT_OVERRIDE: undefined,
  RETRIEVAL_SERVICE_URL: undefined,
});

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const pinEnv = (t, values) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const waitFor = async (check, { label = "condition", timeoutMs = 5_000 } = {}) => {
  const startedAt = Date.now();

  for (;;) {
    const value = await check();

    if (value) {
      return value;
    }

    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(`Timed out waiting for ${label}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// The ragService the route hands the agent: `chat` answers the question
// through the configured model (so drafts stream, or a hang is observable),
// everything else is inert.
const createRagService = ({ chat }) => ({
  chat,
  clearDocuments: async () => [],
  clearSessionMemory: () => true,
  deleteDocument: async () => null,
  getDocument: (docId) =>
    docId === CITATION.docId ? { docId: CITATION.docId, fileName: CITATION.fileName } : null,
  ingestDocument: async () => null,
  initializeDocumentRegistry: async () => [],
  initializeSessionMemory: async () => true,
  listDocuments: () => [{ docId: CITATION.docId, fileName: CITATION.fileName }],
});

// The document answer is written by writeQaAnswer over the fixture evidence,
// so the configured model streams it token by token and the draft channel
// checks each completed sentence, exactly as in production.
const createDraftingRagService = () =>
  createRagService({
    chat: async (docIds, question) => {
      const written = await writeQaAnswer({
        bundle: { citations: [CITATION], context: `[Source 1]\n${CITATION.excerpt}` },
        query: question,
        resolvedQuery: question,
      });

      return { ...written, abstained: false, memoryApplied: false, resolvedQuery: question };
    },
  });

// A stand-in model that streams `answer` in small pieces, as a streaming
// completion does.
const installStreamingModel = (t, getAnswer) => {
  configureOpenAIProvider({
    completeText: async (_input, { onAttemptStart, onTextDelta } = {}) => {
      const answer = getAnswer();

      onAttemptStart?.();
      for (const piece of answer.match(/[\s\S]{1,6}/g) ?? []) onTextDelta?.(piece);
      return answer;
    },
  });
  t.after(() => resetOpenAIProvider());
};

// A stand-in model whose every call waits until release() or until its
// signal aborts, recording what happened to it (test/agent-cancellation).
const installSlowModel = (t) => {
  const calls = [];
  let arrived = createDeferred();
  let release = createDeferred();

  configureOpenAIProvider({
    completeText: (input, { signal } = {}) =>
      new Promise((resolve, reject) => {
        const call = { aborted: false, reason: null, signal };

        calls.push(call);
        arrived.resolve(call);
        signal?.addEventListener(
          "abort",
          () => {
            call.aborted = true;
            call.reason = signal.reason;
            reject(signal.reason);
          },
          { once: true }
        );
        release.promise.then(() => resolve(SUPPORTED_SENTENCES[0]));
      }),
  });
  t.after(() => resetOpenAIProvider());

  return {
    calls,
    get arrived() {
      return arrived.promise;
    },
    release: () => release.resolve(),
    reset: () => {
      arrived = createDeferred();
      release = createDeferred();
    },
  };
};

const createSlowRagService = () =>
  createRagService({
    chat: async (docIds, question) => ({
      abstained: false,
      citations: [{ ...CITATION, sourceLabel: "Source 1", text: CITATION.excerpt }],
      memoryApplied: false,
      resolvedQuery: question,
      text: await completeText(`Answer from the evidence: ${question}`),
    }),
  });

const startMonolith = async (t, { env = {}, ragService } = {}) => {
  pinEnv(t, { ...BASE_ENV, ...env });

  const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const app = await createApp({
    agentRunRecoveryService: {
      recoverOnStartup: async () => ({ mode: "manual", recoveredCount: 0, runs: [] }),
    },
    agentRunService,
    chatMcp: async () => ({ text: "web" }),
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService: okHealthService,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService,
  });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return { agentRunService, baseUrl: `http://127.0.0.1:${server.address().port}` };
};

const postChat = (baseUrl, path = "/chat", init = {}) =>
  fetch(`${baseUrl}${path}`, {
    body: JSON.stringify({ docId: CITATION.docId, question: QUESTION }),
    headers: { "content-type": "application/json" },
    method: "POST",
    ...init,
  });

const parseFrames = (text) =>
  text
    .split("\n\n")
    .filter((block) => block.trim() && !block.startsWith(":"))
    .map((block) => {
      const lines = block.split("\n");
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);

      return {
        data: data ? JSON.parse(data) : null,
        event: lines.find((line) => line.startsWith("event: "))?.slice("event: ".length),
      };
    });

const listRuns = async (agentRunService) =>
  (await agentRunService.listRuns({ accessScope: {} })).runs;

const readRuns = async (agentRunService) => {
  const runs = [];

  for (const listed of await listRuns(agentRunService)) {
    runs.push(
      await agentRunService.getRun({ accessScope: listed.accessScope ?? {}, runId: listed.runId })
    );
  }

  return runs;
};

const draftTexts = (frames) =>
  frames.filter((frame) => frame.event === "answer_draft").map((frame) => frame.data.draft.text);

/**
 * One /chat/stream request per pass against a fresh monolith, returning the
 * raw SSE text, its frames, the plan-graph invocations, the route's relay
 * calls and every run.
 */
const streamOnEveryPass = async (t, { env = {}, ragService, request = {} } = {}) => {
  const passes = {};

  for (const pass of PASS_NAMES) {
    const monolith = await startMonolith(t, { env: { ...env, ...PASSES[pass] }, ragService });

    takePlanGraphInvocations();
    takeAgentStreamRelayCalls();

    const response = await postChat(monolith.baseUrl, "/chat/stream", request);
    const text = await response.text();

    passes[pass] = {
      frames: parseFrames(text),
      invocations: takePlanGraphInvocations(),
      relayCalls: takeAgentStreamRelayCalls(),
      runs: (await readRuns(monolith.agentRunService)).map(projectAgentRun),
      status: response.status,
      text,
    };
  }

  return passes;
};

// Only the outer dial moves the outer plan and the route's stream onto
// LangGraph: the native pass and the AGENT_RUNTIME=langgraph pass without it
// ran the native loop behind the route's native branch.
const assertOuterPlanFollowsItsOwnDial = ({ langgraph, native, outerNative }) => {
  assert.deepStrictEqual(native.invocations, []);
  assert.deepStrictEqual(outerNative.invocations, []);
  assert.equal(langgraph.invocations.length, 1, "the outer-dial pass scheduled the outer plan");
  assert.equal(native.relayCalls, 0);
  assert.equal(outerNative.relayCalls, 0, "AGENT_RUNTIME=langgraph alone streams on the native branch");
  assert.equal(langgraph.relayCalls, 1, "the outer-dial pass streamed through the LangGraph relay");
};

const assertStreamsIdentical = (passes) => {
  const { native } = passes;

  assert.equal(native.status, 200);

  for (const pass of ["langgraph", "outerNative"]) {
    const other = passes[pass];

    assert.equal(other.status, 200, pass);
    // The bytes on the wire, masked, and the frames they parse into.
    assert.equal(maskVolatileText(other.text), maskVolatileText(native.text), pass);
    assert.deepStrictEqual(maskVolatile(other.frames), maskVolatile(native.frames), pass);
    assert.deepStrictEqual(maskVolatile(other.runs), maskVolatile(native.runs), pass);
  }

  assertOuterPlanFollowsItsOwnDial(passes);
};

test("a fully supported answer streams the same trace steps, drafts, result and done on both runtimes, and the result equals /chat", async (t) => {
  installStreamingModel(t, () => SUPPORTED_SENTENCES.join("\n"));

  const passes = await streamOnEveryPass(t, { ragService: createDraftingRagService() });
  const { langgraph, native } = passes;

  assertStreamsIdentical(passes);

  const eventNames = native.frames.map((frame) => frame.event);

  assert.ok(eventNames.includes("trace_step"));
  assert.deepStrictEqual(eventNames.slice(-2), ["result", "done"]);
  assert.deepStrictEqual(draftTexts(native.frames), SUPPORTED_SENTENCES);
  assert.deepStrictEqual(draftTexts(langgraph.frames), SUPPORTED_SENTENCES);
  // Drafts arrive before the finalizer step, and each appears verbatim in
  // the final answer.
  const firstDraft = eventNames.indexOf("answer_draft");
  const finalizer = native.frames.findIndex(
    (frame) => frame.event === "trace_step" && frame.data.step.type === "answer_finalizer"
  );
  const result = native.frames.at(-2).data;

  assert.ok(firstDraft >= 0 && finalizer > firstDraft);
  assert.equal(result.status, 200);
  assert.equal(result.body.agentMode, "document");
  for (const draft of SUPPORTED_SENTENCES) {
    assert.ok(result.body.agentAnswer.includes(draft), draft);
  }
  // The result event is the /chat answer: the same request through /chat,
  // with the outer plan on LangGraph and under AGENT_RUNTIME=langgraph alone,
  // gives the same status and body.
  for (const pass of ["langgraph", "outerNative"]) {
    const monolith = await startMonolith(t, {
      env: PASSES[pass],
      ragService: createDraftingRagService(),
    });

    takePlanGraphInvocations();

    const plain = await postChat(monolith.baseUrl);

    assert.equal(plain.status, 200, pass);
    assert.deepStrictEqual(
      maskVolatile(await plain.json()),
      maskVolatile(langgraph.frames.at(-2).data.body),
      pass
    );
    assert.equal(takePlanGraphInvocations().length, pass === "langgraph" ? 1 : 0, pass);
  }
});

test("a sentence the claim check does not support is never drafted on either runtime, and the drafts are identical", async (t) => {
  installStreamingModel(t, () =>
    [SUPPORTED_SENTENCES[0], UNSUPPORTED_SENTENCE, SUPPORTED_SENTENCES[1]].join("\n")
  );

  const passes = await streamOnEveryPass(t, { ragService: createDraftingRagService() });
  const { langgraph, native } = passes;

  assertStreamsIdentical(passes);
  assert.ok(draftTexts(native.frames).length > 0, "some sentence was drafted");
  for (const text of [...draftTexts(native.frames), ...draftTexts(langgraph.frames)]) {
    assert.ok(SUPPORTED_SENTENCES.includes(text), text);
    assert.notEqual(text, UNSUPPORTED_SENTENCE);
  }
  // The unsupported claim is reported, never streamed.
  assert.ok(
    !native.text.includes("signed in Paris") || native.frames.at(-2).event === "result",
    "the unsupported sentence can only appear in the final result's own fields"
  );
  assert.deepStrictEqual(native.frames.map((frame) => frame.event).slice(-2), ["result", "done"]);
});

test("a deadline that passes mid-run ends the stream with the same error and done frames on both runtimes", { timeout: 30_000 }, async (t) => {
  const model = installSlowModel(t);
  const passes = {};

  for (const pass of PASS_NAMES) {
    const monolith = await startMonolith(t, {
      env: { AGENT_REQUEST_TIMEOUT_MS: "1500", ...PASSES[pass] },
      ragService: createSlowRagService(),
    });

    takePlanGraphInvocations();
    takeAgentStreamRelayCalls();

    const response = await postChat(monolith.baseUrl, "/chat/stream");
    const text = await response.text();

    passes[pass] = {
      frames: parseFrames(text),
      invocations: takePlanGraphInvocations(),
      relayCalls: takeAgentStreamRelayCalls(),
      runs: (await readRuns(monolith.agentRunService)).map(projectAgentRun),
      status: response.status,
      text,
    };
    model.reset();
  }

  assertStreamsIdentical(passes);

  const { frames, runs } = passes.native;

  assert.deepStrictEqual(frames.slice(-2).map(({ event }) => event), ["error", "done"]);
  assert.ok(!frames.some(({ event }) => event === "result"));
  assert.equal(frames.at(-2).data.code, "AGENT_DEADLINE_EXCEEDED");
  assert.equal(frames.at(-2).data.status, 504);
  assert.equal(frames.at(-2).data.retryable, true);
  assert.equal(runs[0].status, AGENT_RUN_STATUSES.failed);
  assert.equal(runs[0].error.reason, "deadline_exceeded");
  assert.equal(model.calls.length, PASS_NAMES.length);
  assert.ok(model.calls.every((call) => call.aborted), "every in-flight model call was aborted");
});

// The deadline passes while the primary answer is produced, and that answer
// holds an unsupported claim, so the document stage emits its document_rag,
// self_check and gap_analysis steps and then throws at the follow-up step's
// start, a safe point inside the same stage. With the outer plan on
// LangGraph those steps travel as custom stream chunks, which LangGraph
// drops when it errors its stream after the failed node unless the node
// waits for them to be forwarded: every trace_step frame must still precede
// the error and done frames, byte for byte as natively.
test("a deadline that throws inside a stage right after a burst of trace steps streams every frame before error and done on both runtimes", { timeout: 30_000 }, async (t) => {
  const ragService = createRagService({
    chat: async (docIds, question) => {
      const signal = getRequestSignal();

      assert.ok(signal, "the route bound the request's deadline");
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", resolve, { once: true });
        }
      });

      // The answer still arrives: the call did not read the signal.
      return {
        abstained: false,
        citations: [{ ...CITATION, sourceLabel: "Source 1", text: CITATION.excerpt }],
        memoryApplied: false,
        resolvedQuery: question,
        text: [SUPPORTED_SENTENCES[0], UNSUPPORTED_SENTENCE].join("\n"),
      };
    },
  });
  const passes = await streamOnEveryPass(t, {
    env: { AGENT_REQUEST_TIMEOUT_MS: "200" },
    ragService,
  });

  assertStreamsIdentical(passes);

  const { frames, runs } = passes.native;

  assert.deepStrictEqual(
    frames
      .filter(({ event }) => event === "trace_step")
      .slice(-3)
      .map(({ data }) => data.step.type),
    ["document_rag", "self_check", "gap_analysis"]
  );
  assert.deepStrictEqual(frames.slice(-2).map(({ event }) => event), ["error", "done"]);
  assert.equal(frames.at(-2).data.code, "AGENT_DEADLINE_EXCEEDED");
  assert.equal(runs[0].status, AGENT_RUN_STATUSES.failed);
});

test("with AGENT_CANCEL_ON_DISCONNECT on, a client that leaves /chat/stream cancels the run to the same terminal record on both runtimes", { timeout: 30_000 }, async (t) => {
  const model = installSlowModel(t);
  const records = {};

  for (const pass of PASS_NAMES) {
    const monolith = await startMonolith(t, {
      env: { AGENT_CANCEL_ON_DISCONNECT: "on", ...PASSES[pass] },
      ragService: createSlowRagService(),
    });
    const client = new AbortController();

    takePlanGraphInvocations();
    takeAgentStreamRelayCalls();

    const stream = await postChat(monolith.baseUrl, "/chat/stream", { signal: client.signal });

    assert.equal(stream.status, 200);

    const call = await model.arrived;

    client.abort();
    await stream.body?.cancel().catch(() => {});

    const run = await waitFor(
      async () =>
        (await listRuns(monolith.agentRunService)).find(
          (listed) => listed.status === AGENT_RUN_STATUSES.canceled
        ),
      { label: `the ${pass} run to end canceled` }
    );

    assert.equal(call.aborted, true, "the in-flight model call was aborted");
    assert.equal(call.reason.reason, "client_cancelled");

    const [stored] = (await readRuns(monolith.agentRunService)).filter(
      (candidate) => candidate.runId === run.runId
    );

    records[pass] = {
      invocations: takePlanGraphInvocations(),
      relayCalls: takeAgentStreamRelayCalls(),
      run: projectAgentRun(stored),
    };
    model.reset();
  }

  assert.deepStrictEqual(records.native.run.error, {
    ...records.native.run.error,
    code: "AGENT_CLIENT_CANCELLED",
    reason: "client_cancelled",
    retryable: false,
  });
  assert.ok(records.native.run.steps.every((step) => step.status !== "running"));
  assert.deepStrictEqual(maskVolatile(records.langgraph.run), maskVolatile(records.native.run));
  assert.deepStrictEqual(maskVolatile(records.outerNative.run), maskVolatile(records.native.run));
  assertOuterPlanFollowsItsOwnDial(records);
});

// The refusal belongs to the paths that still build a LangGraph graph: with
// the outer plan on LangGraph the stream refuses before the run exists;
// AGENT_RUNTIME=langgraph alone streams a document question on the native
// branch and loop, which build no graph and have no tracer to refuse (a
// custom-Skill DAG or a v3 graph on that request refuses at its own entry).
test("a LangSmith tracing variable makes the LangGraph stream refuse with an error frame and done before the run starts; native and AGENT_RUNTIME=langgraph alone are unaffected", async (t) => {
  installStreamingModel(t, () => SUPPORTED_SENTENCES.join("\n"));

  const monolith = await startMonolith(t, { ragService: createDraftingRagService() });
  const requestUnderTracer = (pass) =>
    withEnv({ ...PASSES[pass], LANGSMITH_TRACING: "true" }, async () => {
      takeAgentStreamRelayCalls();

      const response = await postChat(monolith.baseUrl, "/chat/stream");

      return {
        frames: parseFrames(await response.text()),
        relayCalls: takeAgentStreamRelayCalls(),
        status: response.status,
      };
    });

  const refused = await requestUnderTracer("langgraph");

  assert.equal(refused.status, 200);
  assert.deepStrictEqual(refused.frames.map(({ event }) => event), ["error", "done"]);
  assert.equal(refused.frames[0].data.status, 500);
  assert.match(refused.frames[0].data.error, /LangSmith tracing must stay off/);
  assert.match(refused.frames[0].data.error, /LANGSMITH_TRACING/);
  // Refused before the run started: no run was recorded.
  assert.deepStrictEqual(await listRuns(monolith.agentRunService), []);
  assert.equal(refused.relayCalls, 1);

  const native = await requestUnderTracer("native");

  assert.deepStrictEqual(native.frames.map(({ event }) => event).slice(-2), ["result", "done"]);
  assert.equal(native.frames.at(-2).data.status, 200);

  takePlanGraphInvocations();

  const outerNative = await requestUnderTracer("outerNative");

  assert.equal(outerNative.status, 200);
  assert.equal(outerNative.relayCalls, 0);
  assert.deepStrictEqual(takePlanGraphInvocations(), []);
  assert.deepStrictEqual(
    maskVolatile(outerNative.frames),
    maskVolatile(native.frames),
    "the native stream under AGENT_RUNTIME=langgraph alone"
  );
  assert.equal((await listRuns(monolith.agentRunService)).length, 2);
});

// --- The generator and the bridge on their own ----------------------------

test("streamAgentRun yields the run's events in order, then result and done; a failed run yields the route's error then done", async () => {
  const answer = async () => {
    emitAgentEvent({ step: { id: "1-plan", type: "plan" }, type: "trace_step" });
    await Promise.resolve();
    emitAgentEvent({ draft: { index: 0, text: "A sentence. [Source 1]" }, type: "answer_draft" });
    return { body: { agentAnswer: "A sentence. [Source 1]" }, status: 200 };
  };
  const events = [];

  for await (const event of streamAgentRun({ answer, describeError: describeAgentRouteError })) {
    events.push(event);
  }

  assert.deepStrictEqual(events, [
    { step: { id: "1-plan", type: "plan" }, type: "trace_step" },
    { draft: { index: 0, text: "A sentence. [Source 1]" }, type: "answer_draft" },
    { body: { agentAnswer: "A sentence. [Source 1]" }, status: 200, type: "result" },
    { type: "done" },
  ]);
  assert.deepStrictEqual(events.map(toAgentStreamFrame), [
    { data: { step: { id: "1-plan", type: "plan" }, type: "trace_step" }, event: "trace_step" },
    {
      data: { draft: { index: 0, text: "A sentence. [Source 1]" }, type: "answer_draft" },
      event: "answer_draft",
    },
    { data: { body: { agentAnswer: "A sentence. [Source 1]" }, status: 200 }, event: "result" },
    { data: {}, event: "done" },
  ]);

  const failure = Object.assign(new Error("boom"), { status: 418 });
  const failed = [];

  for await (const event of streamAgentRun({
    answer: async () => {
      emitAgentEvent({ step: { id: "1-plan", type: "plan" }, type: "trace_step" });
      throw failure;
    },
    describeError: describeAgentRouteError,
  })) {
    failed.push(event);
  }

  assert.deepStrictEqual(failed, [
    { step: { id: "1-plan", type: "plan" }, type: "trace_step" },
    { body: { error: "boom" }, status: 418, type: AGENT_STREAM_EVENT_TYPES.error },
    { type: "done" },
  ]);
  assert.deepStrictEqual(toAgentStreamFrame(failed[1]), {
    data: { error: "boom", status: 418 },
    event: "error",
  });

  await assert.rejects(
    (async () => {
      for await (const _event of streamAgentRun({ answer })) {
        // never reached
      }
    })(),
    TypeError
  );
});

test("the writer relay nests the sink only inside a declared relay with a streaming client, and a custom chunk reaches the outer sink", async () => {
  const outer = [];
  const written = [];
  const writer = (event) => written.push(event);
  const relayConfig = { configurable: { [AGENT_STREAM_RELAY_KEY]: true }, writer };

  // No streaming client: nothing is nested, the writer never sees an event.
  await relayAgentEventsThroughWriter(relayConfig, async () => {
    emitAgentEvent({ type: "trace_step" });
  });
  assert.deepStrictEqual(written, []);

  await runWithAgentEventSink(
    (event) => outer.push(event),
    async () => {
      // A node of an invocation that did not declare the relay keeps the
      // outer sink (config.writer would drop the event).
      await relayAgentEventsThroughWriter({ writer }, async () => {
        emitAgentEvent({ id: "direct", type: "trace_step" });
      });
      // A declared relay hands the event to the writer instead.
      await relayAgentEventsThroughWriter(relayConfig, async () => {
        emitAgentEvent({ id: "relayed", type: "trace_step" });
      });
      // The consumer loop hands a custom chunk to the outer sink; an updates
      // chunk is returned, anything else ignored.
      assert.equal(forwardAgentStreamChunk(["custom", written[0]]), null);
      assert.deepStrictEqual(forwardAgentStreamChunk(["updates", { stage: { receipts: {} } }]), {
        stage: { receipts: {} },
      });
      assert.equal(forwardAgentStreamChunk(["values", {}]), null);
      assert.equal(forwardAgentStreamChunk(null), null);
    }
  );

  assert.deepStrictEqual(written, [{ id: "relayed", type: "trace_step" }]);
  assert.deepStrictEqual(outer, [
    { id: "direct", type: "trace_step" },
    { id: "relayed", type: "trace_step" },
  ]);
  assert.equal(LANGSMITH_TRACING_ENABLED_CODE, "LANGSMITH_TRACING_ENABLED");
});
