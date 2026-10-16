// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-spike/langsmith-off.mjs";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";

// Phase-3 acceptance evidence for the public surface on the LangGraph runtime
// (docs/adr/0001-langgraph-runtime.md): the real app (createApp over the local
// vector store, an in-memory run store, in-memory task and artifact stores and
// a stand-in model) answers the same requests under AGENT_RUNTIME=native and
// AGENT_RUNTIME=langgraph, and everything a client or a later process can see
// must be identical after masking what two runs never share. Since the
// phase-3 load test AGENT_RUNTIME=langgraph keeps the V1 outer plan (and the
// /chat/stream route) on the native loop and puts only the custom-Skill DAG
// and the v3 graph on LangGraph; the requests the outer plan answers also run
// a third pass, `outerPlan`, with the experimental
// AGENT_OUTER_PLAN_RUNTIME=langgraph that schedules the outer plan on
// LangGraph and streams through the LangGraph relay (config.js says why it is
// opt-in):
//
//   - POST /chat on the V1 outer plan (on LangGraph only in the outerPlan
//     pass);
//   - GET and POST /chat/stream (the bytes on the wire, with answer drafts);
//   - a guarded v3 unified graph parked at its approval gate through POST
//     /chat and decided through POST /agent-runs/:runId/actions/approve|deny
//     (on LangGraph the pause is the thread's pending interrupt, the decision
//     continues the same thread, and a finished run carries no thread);
//   - the V1 Capability approval on the same endpoint;
//   - a background task (POST /agent-tasks, the task runner app-services
//     wires) whose v3 graph pauses for approval and whose task action
//     re-enters the same graph;
//   - startup recovery (the app's own recoverOnStartup) of a v3 run another
//     app instance left at a node boundary.
//
// The on-demand imports of both LangGraph schedulers are redirected to the
// phase-2/3 counting taps, so each LangGraph pass also proves that LangGraph
// really scheduled the graph (identical results from two native passes would
// prove nothing), and each native pass proves it never did; the route's
// import of the stream relay is tapped too, so a stream pass also shows which
// branch of routes/chat.js answered.

const RAG_PREFIX = new URL("../rag/", import.meta.url).href;
const EXECUTOR_TAP_URL = new URL(
  "./langgraph-runtime-parity/langgraph-executor-tap.mjs",
  import.meta.url
).href;
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
        capture: EXECUTOR_TAP_URL,
        fromPrefix: RAG_PREFIX,
        target: new URL("../rag/langgraph/run-execution-graph.js", import.meta.url).href,
      },
      {
        capture: PLAN_GRAPH_TAP_URL,
        fromPrefix: RAG_PREFIX,
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

const { ANSWER_RATE_FLAGS_OFF, maskVolatileText, withEnv } = await import(
  "./langgraph-execution-plan-graph/mask.mjs"
);
const { takeLangGraphInvocations } = await import(EXECUTOR_TAP_URL);
const { takePlanGraphInvocations } = await import(PLAN_GRAPH_TAP_URL);
const { takeAgentStreamRelayCalls } = await import(AGENT_STREAM_TAP_URL);
const { createApp } = await import("../app.js");
const { deterministicPlannerAdapter } = await import("../rag/agent-execution-plan.js");
const { deterministicIntentPlannerAdapter } = await import("../rag/agent-intent-planner.js");
const { createAgentRunService, createInMemoryAgentRunStore } = await import("../rag/agent-runs.js");
const { AGENT_TASK_ACTIONS } = await import("../rag/agent-tasks.js");
const { writeQaAnswer } = await import("../rag/answer-writer.js");
const { createCapabilityRegistry } = await import("../rag/capabilities/index.js");
const { CAPABILITY_IDS } = await import("../rag/capabilities/shared.js");
const { LANGGRAPH_CHECKPOINT_RESULT_KEY, RunStoreCheckpointSaver } = await import(
  "../rag/langgraph/checkpointer.js"
);
const { RUNTIME_RESUME_MARKER, buildApprovalInterruptPayload } = await import(
  "../rag/langgraph/unified-graph-approval.js"
);
const { readLangGraphThread } = await import("../rag/langgraph/unified-graph-thread.js");
const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const { createInMemoryTaskStore } = await import("../rag/tasks.js");
const { createInMemoryWorkspaceArtifactStore } = await import(
  "../rag/workspace-artifacts/index.js"
);
const {
  APPROVAL_TASK_QUESTION,
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  checkpointHasNodeRun,
  createApprovalGatedTaskProposal,
  createCrashingRunService,
  createDocumentLoopProposal,
  createDocumentLoopRagService,
  createProposalAdapter,
  createTaskCapabilityRegistry,
} = await import("./fixtures/unified-graph-run-fixtures.mjs");

// `langgraph` is AGENT_RUNTIME=langgraph alone, the production setting;
// `outerPlan` adds the experimental AGENT_OUTER_PLAN_RUNTIME=langgraph.
const RUNTIMES = Object.freeze(["native", "langgraph"]);
const OUTER_PLAN_PASSES = Object.freeze([...RUNTIMES, "outerPlan"]);
const PASS_ENV = Object.freeze({
  langgraph: Object.freeze({ AGENT_RUNTIME: "langgraph" }),
  native: Object.freeze({ AGENT_RUNTIME: "native" }),
  outerPlan: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: "langgraph", AGENT_RUNTIME: "langgraph" }),
});

// Every pass runs with the answer-rate flags off and nothing in the ambient
// environment pointing at another tier, a gateway, a timeout or a rollout.
const BASE_ENV = Object.freeze({
  ...ANSWER_RATE_FLAGS_OFF,
  AGENT_CANCEL_ON_DISCONNECT: undefined,
  AGENT_OUTER_PLAN_RUNTIME: undefined,
  AGENT_PLANNER_ROLLOUT: "deterministic",
  AGENT_REQUEST_TIMEOUT_MS: undefined,
  AGENT_RUN_RECOVERY_MODE: undefined,
  AGENT_SERVICE_URL: undefined,
  AGENT_UNIFIED_GRAPH_CAPABILITIES: undefined,
  AGENT_UNIFIED_GRAPH_ROLLOUT: "off",
  ARCHIVE_RAG_ROLE: undefined,
  MODEL_GATEWAY_URL: undefined,
  POSTGRES_DATABASE_URL: undefined,
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
  RAG_QA_ANSWER_VERDICT: undefined,
  RAG_QA_VERDICT_OVERRIDE: undefined,
  RETRIEVAL_SERVICE_URL: undefined,
});

// The guarded v3 unified graph with the task.create Capability allowed, as
// the unified-graph suites run it.
const UNIFIED_ENV = Object.freeze({
  AGENT_UNIFIED_GRAPH_CAPABILITIES: "task.create",
  AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
});

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

// Startup recovery is skipped where a test does not exercise it, so an
// earlier test's store can never be recovered by accident.
const noRecovery = {
  recoverOnStartup: async () => ({ mode: "manual", recoveredCount: 0, runs: [] }),
};

const onRuntime = (pass, work, env = {}) =>
  withEnv({ ...BASE_ENV, ...env, ...PASS_ENV[pass] }, work);

// ---------------------------------------------------------------------------
// Masking: what two runs never share, and nothing else (the unified-graph
// suite's rules). Random ids (UUIDs, also inside composite ids), timestamps,
// wall-clock measurements, the checkpoint seal and everything hashed from it
// (the gate id, its approval object hash), and, for run-bound comparisons,
// the typed-output and answer digests (the task node's output names the run
// id, so its digest differs between any two runs).
// ---------------------------------------------------------------------------

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const APPROVAL_HASH_PATTERN = /(?<!v1:)sha256:[0-9a-f]{64}/g;
const GATE_ID_PATTERN = /graph-approval:[0-9a-f]{64}/g;
const SEAL_PATTERN = /^[0-9a-f]{64}$/;
const SEAL_KEYS = new Set(["digest", "graphDigest"]);
const DIGEST_KEYS = new Set(["typedOutputDigest", "outputDigest", "answerDigest"]);
const WALL_CLOCK_KEY_PATTERN = /(?:duration|latency|elapsed)Ms$/i;

const mask = (value, key = "") => {
  if (typeof value === "string") {
    if (SEAL_KEYS.has(key) && SEAL_PATTERN.test(value)) {
      return "<seal>";
    }

    if (DIGEST_KEYS.has(key)) {
      return "<typed-digest>";
    }

    return value
      .replace(UUID_PATTERN, "<id>")
      .replace(ISO_TIMESTAMP_PATTERN, "<time>")
      .replace(APPROVAL_HASH_PATTERN, "sha256:<approval-hash>")
      .replace(GATE_ID_PATTERN, "graph-approval:<approval-hash>");
  }

  if (typeof value === "number" && WALL_CLOCK_KEY_PATTERN.test(key)) {
    return "<elapsed>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => mask(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, mask(item, name)])
    );
  }

  return value;
};

// The same rules over raw SSE text: a v3 pause carries the gate id, its
// approval object hash and the checkpoint seal (graphDigest), all hashed from
// the sealed checkpoint, so they differ between any two runs.
const maskText = (text) =>
  maskVolatileText(text)
    .replace(APPROVAL_HASH_PATTERN, "sha256:<approval-hash>")
    .replace(GATE_ID_PATTERN, "graph-approval:<approval-hash>")
    .replace(/"graphDigest":"[0-9a-f]{64}"/g, '"graphDigest":"<seal>"')
    .replace(/"(typedOutputDigest|outputDigest|answerDigest)":"[^"]*"/g, '"$1":"<typed-digest>"');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const newStore = () => createInMemoryAgentRunStore();
const newService = (store) => createAgentRunService({ agentRunStore: store });

const scopeHeaders = (scope) => ({
  "x-user-id": scope.userId,
  ...(scope.workspaceId ? { "x-workspace-id": scope.workspaceId } : {}),
});

// A ragService the app accepts: the fixture's `chat`, `getDocument` and
// `listDocuments` (scope-checked), the rest inert.
const appRagService = (fixture) => ({
  clearDocuments: async () => [],
  clearSessionMemory: () => true,
  deleteDocument: async () => null,
  ingestDocument: async () => null,
  initializeDocumentRegistry: async () => [],
  initializeSessionMemory: async () => true,
  ...fixture,
});

/**
 * The real app on one runtime (the caller pins the environment), listening
 * on a loopback port. `stop()` closes it.
 */
const startApp = async ({
  agentRunService,
  capabilityRegistry,
  jobSchedule,
  ragService,
  recovery = noRecovery,
  taskStore,
  unifiedGraphPlannerAdapter,
  workspaceArtifactStore,
  createAgentTaskId,
}) => {
  takeLangGraphInvocations();
  takePlanGraphInvocations();

  const app = await createApp({
    ...(recovery ? { agentRunRecoveryService: recovery } : {}),
    agentRunService,
    ...(capabilityRegistry ? { capabilityRegistry } : {}),
    chatMcp: async () => ({ text: "web" }),
    ...(createAgentTaskId ? { createAgentTaskId } : {}),
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService: okHealthService,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ...(jobSchedule ? { jobSchedule } : {}),
    ragService,
    ...(taskStore ? { taskStore } : {}),
    ...(unifiedGraphPlannerAdapter ? { unifiedGraphPlannerAdapter } : {}),
    ...(workspaceArtifactStore ? { workspaceArtifactStore } : {}),
  });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    agentRunService,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    startupInvocations: {
      graph: takeLangGraphInvocations(),
      plan: takePlanGraphInvocations(),
    },
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const withApp = async (options, work) => {
  const app = await startApp(options);

  try {
    return await work(app);
  } finally {
    await app.stop();
  }
};

const postJson = async (url, body, headers = {}) => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

  return { body: await response.json(), status: response.status };
};

const getJson = async (url, headers = {}) => {
  const response = await fetch(url, { headers });

  return { body: await response.json(), status: response.status };
};

/** What LangGraph was asked to schedule since the last take, ids only. */
const takeInvocations = () => ({
  graph: takeLangGraphInvocations(),
  plan: takePlanGraphInvocations(),
});

/** Everything a run leaves in the store, and its graph checkpoint. */
const loadRun = async (agentRunService, accessScope, runId) => {
  const run = await agentRunService.getRun({ accessScope, runId });

  return {
    checkpoint:
      (await agentRunService.getExecutionGraphCheckpoint?.({ accessScope, runId }))
        ?.checkpoint ?? null,
    run: {
      approvalGates: run?.approvalGates ?? [],
      error: run?.error ?? null,
      events: run?.events ?? [],
      result: run?.result ?? null,
      status: run?.status ?? null,
      steps: run?.steps ?? [],
    },
  };
};

// The run's LangGraph thread as the production saver reads it, and the raw
// private record (null on native, and on a finished run).
const readThread = (agentRunService, accessScope, runId) =>
  readLangGraphThread(new RunStoreCheckpointSaver({ accessScope, agentRunService, runId }));

const rawRecord = async (store, accessScope, runId) =>
  (await store.get({ accessScope, runId }))?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY] ?? null;

const receiptStatuses = (thread) =>
  Object.fromEntries([...thread.receipts].map(([nodeId, receipt]) => [nodeId, receipt.status]));

const assertNoText = (record, texts) => {
  const serialized = JSON.stringify(record);

  for (const text of texts) {
    assert.equal(serialized.includes(text), false, `the thread record must not hold ${JSON.stringify(text)}`);
  }
};

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

// ---------------------------------------------------------------------------
// V1 document QA through a stand-in model (answer drafts stream from it)
// ---------------------------------------------------------------------------

const QA_QUESTION = "What are the renewal term and the monthly fee?";
const QA_CITATION = Object.freeze({
  docId: "contract-1",
  excerpt:
    "The agreement renews every 12 months unless either party gives 30 days notice. The monthly fee is 12.5 thousand dollars.",
  fileName: "services-agreement.pdf",
  pageNumber: 3,
});
const QA_SENTENCES = Object.freeze([
  "The agreement renews every 12 months. [Source 1]",
  "The monthly fee is 12.5 thousand dollars. [Source 1]",
]);

// The document answer is written by writeQaAnswer over the fixture evidence,
// so the configured model streams it and the draft channel sees each
// completed sentence, exactly as in production.
const createQaRagService = () =>
  appRagService({
    chat: async (docIds, question) => {
      const written = await writeQaAnswer({
        bundle: { citations: [QA_CITATION], context: `[Source 1]\n${QA_CITATION.excerpt}` },
        query: question,
        resolvedQuery: question,
      });

      return { ...written, abstained: false, memoryApplied: false, resolvedQuery: question };
    },
    getDocument: (docId) =>
      docId === QA_CITATION.docId ? { docId: QA_CITATION.docId, fileName: QA_CITATION.fileName } : null,
    listDocuments: () => [{ docId: QA_CITATION.docId, fileName: QA_CITATION.fileName }],
  });

// A stand-in model that streams the answer in small pieces, as a streaming
// completion does.
const installStreamingModel = (t) => {
  configureOpenAIProvider({
    completeText: async (_input, { onAttemptStart, onTextDelta } = {}) => {
      const answer = QA_SENTENCES.join("\n");

      onAttemptStart?.();
      for (const piece of answer.match(/[\s\S]{1,6}/g) ?? []) onTextDelta?.(piece);
      return answer;
    },
  });
  t.after(() => resetOpenAIProvider());
};

const qaRequest = { docId: QA_CITATION.docId, question: QA_QUESTION, sessionId: "routes-session" };
const qaScope = Object.freeze({ userId: "routes-user", workspaceId: "" });

test("POST /chat answers a document question identically on every pass, and only the outer-plan dial schedules the outer plan on LangGraph", async (t) => {
  installStreamingModel(t);
  const passes = {};

  for (const runtime of OUTER_PLAN_PASSES) {
    passes[runtime] = await onRuntime(runtime, () =>
      withApp({ agentRunService: newService(newStore()), ragService: createQaRagService() }, async (app) => {
        const answer = await postJson(`${app.baseUrl}/chat`, qaRequest, scopeHeaders(qaScope));
        const invocations = takeInvocations();
        const run = await loadRun(app.agentRunService, qaScope, answer.body.agentRunId);

        return { answer, invocations, run };
      })
    );
  }

  const { langgraph, native, outerPlan } = passes;

  assert.equal(native.answer.status, 200);
  assert.equal(native.answer.body.agentMode, "document");
  for (const sentence of QA_SENTENCES) {
    assert.ok(native.answer.body.agentAnswer.includes(sentence), sentence);
  }
  assert.equal(native.run.run.status, "completed");
  for (const [pass, other] of [["langgraph", langgraph], ["outerPlan", outerPlan]]) {
    assert.deepStrictEqual(mask(other.answer), mask(native.answer), pass);
    assert.deepStrictEqual(mask(other.run), mask(native.run), pass);
  }
  // AGENT_RUNTIME=langgraph alone kept the outer plan on the native loop.
  // With the outer dial the plan was scheduled on LangGraph once, bound to
  // the run; no custom-Skill or unified graph exists on this request.
  assert.deepStrictEqual(native.invocations, { graph: [], plan: [] });
  assert.deepStrictEqual(langgraph.invocations, { graph: [], plan: [] });
  assert.deepStrictEqual(outerPlan.invocations.graph, []);
  assert.equal(outerPlan.invocations.plan.length, 1);
  assert.equal(outerPlan.invocations.plan[0].boundToRun, true);
  assert.ok(outerPlan.invocations.plan[0].stepIds.includes("document_rag"));
});

test("POST /chat/stream relays identical SSE bytes on every pass, drafts included; its result equals GET /chat and POST /chat; GET /chat/stream is no route", async (t) => {
  installStreamingModel(t);
  const passes = {};

  for (const runtime of OUTER_PLAN_PASSES) {
    passes[runtime] = await onRuntime(runtime, () =>
      withApp({ agentRunService: newService(newStore()), ragService: createQaRagService() }, async (app) => {
        const headers = scopeHeaders(qaScope);

        takeAgentStreamRelayCalls();

        const streamed = await fetch(`${app.baseUrl}/chat/stream`, {
          body: JSON.stringify(qaRequest),
          headers: { "content-type": "application/json", ...headers },
          method: "POST",
        });
        const text = await streamed.text();
        const relayCalls = takeAgentStreamRelayCalls();
        const query = new URLSearchParams(qaRequest).toString();
        // The router mounts GET /chat and POST /chat/stream (routes/chat.js);
        // a GET of the stream path is a 404 on both runtimes.
        const getStream = await fetch(`${app.baseUrl}/chat/stream?${query}`, { headers });
        await getStream.text();
        const got = await getJson(`${app.baseUrl}/chat?${query}`, headers);
        const invocations = takeInvocations();
        const posted = await postJson(`${app.baseUrl}/chat`, qaRequest, headers);
        const runs = [];

        for (const listed of (await app.agentRunService.listRuns({ accessScope: qaScope })).runs) {
          runs.push((await loadRun(app.agentRunService, qaScope, listed.runId)).run);
        }

        return {
          get: got,
          getStreamStatus: getStream.status,
          invocations,
          post: posted,
          relayCalls,
          runs,
          stream: { frames: parseFrames(text), status: streamed.status, text },
        };
      })
    );
  }

  const { langgraph, native, outerPlan } = passes;

  for (const [runtime, pass] of Object.entries(passes)) {
    assert.equal(pass.stream.status, 200, runtime);
    assert.equal(pass.getStreamStatus, 404, runtime);
    assert.equal(pass.get.status, 200, runtime);
    assert.equal(pass.post.status, 200, runtime);
    const events = pass.stream.frames.map((frame) => frame.event);
    assert.ok(events.includes("trace_step"), runtime);
    assert.deepStrictEqual(events.slice(-2), ["result", "done"], runtime);
    assert.deepStrictEqual(
      pass.stream.frames.filter((frame) => frame.event === "answer_draft").map((frame) => frame.data.draft.text),
      QA_SENTENCES,
      runtime
    );
    // The result frame is the /chat answer, whichever method asked.
    assert.deepStrictEqual(mask(pass.stream.frames.at(-2).data), mask(pass.post), runtime);
    assert.deepStrictEqual(mask(pass.get), mask(pass.post), runtime);
  }

  for (const [pass, other] of [["langgraph", langgraph], ["outerPlan", outerPlan]]) {
    assert.equal(maskVolatileText(other.stream.text), maskVolatileText(native.stream.text), pass);
    assert.deepStrictEqual(mask(other.get), mask(native.get), pass);
    assert.deepStrictEqual(mask(other.post), mask(native.post), pass);
    assert.deepStrictEqual(mask(other.runs), mask(native.runs), pass);
  }
  assert.equal(native.runs.length, 3);
  assert.deepStrictEqual(native.invocations, { graph: [], plan: [] });
  // AGENT_RUNTIME=langgraph alone: the native route branch and the native
  // outer loop for the stream and both /chat methods.
  assert.deepStrictEqual(langgraph.invocations, { graph: [], plan: [] });
  assert.equal(native.relayCalls, 0);
  assert.equal(langgraph.relayCalls, 0);
  // With the outer dial the stream went through the LangGraph relay, and the
  // stream and GET /chat each scheduled the outer plan on LangGraph (the
  // POST /chat after them is not in the count).
  assert.equal(outerPlan.relayCalls, 1);
  assert.equal(outerPlan.invocations.plan.length, 2);
  assert.deepStrictEqual(outerPlan.invocations.graph, []);
});

// ---------------------------------------------------------------------------
// The guarded v3 unified graph through the routes
// ---------------------------------------------------------------------------

const unifiedHeaders = scopeHeaders(UNIFIED_ACCESS_SCOPE);
const unifiedRequest = (question) => ({
  docId: UNIFIED_DOC_ID,
  question,
  sessionId: UNIFIED_SESSION_ID,
});

// Text the thread record must never hold.
const privateTexts = (gate) => [
  gate?.approvalObjectHash ?? "sha256:never",
  APPROVAL_TASK_QUESTION,
  "30 days written notice",
];

/** A fresh app over the approval-gated proposal and the task.create Capability. */
const withUnifiedApp = async ({ onWrite = async () => {}, store = newStore(), ...rest }, work) => {
  const ragService = appRagService(createDocumentLoopRagService({ primary: "supported" }));
  const { registry, writes } = await createTaskCapabilityRegistry({ onWrite, ragService });

  return withApp(
    {
      agentRunService: newService(store),
      capabilityRegistry: registry,
      ragService,
      unifiedGraphPlannerAdapter: createProposalAdapter(createApprovalGatedTaskProposal),
      ...rest,
    },
    (app) => work({ ...app, ragService, registry, store, writes })
  );
};

const decideGate = (app, { action, gate, hash = gate.approvalObjectHash, runId }) =>
  postJson(
    `${app.baseUrl}/agent-runs/${encodeURIComponent(runId)}/actions/${action}`,
    { approvalObjectHash: hash, gateId: gate.id },
    unifiedHeaders
  );

test("a v3 graph parked at its approval gate through POST /chat is approved or denied through POST /agent-runs/:runId/actions/:action identically on both runtimes", async () => {
  for (const action of ["approve", "deny"]) {
    const passes = {};

    for (const runtime of RUNTIMES) {
      passes[runtime] = await onRuntime(
        runtime,
        () =>
          withUnifiedApp({}, async (app) => {
            const paused = await postJson(
              `${app.baseUrl}/chat`,
              unifiedRequest(APPROVAL_TASK_QUESTION),
              unifiedHeaders
            );
            const pauseInvocations = takeInvocations();
            const runId = paused.body.agentRunId;
            const gate = paused.body.approvalGates?.[0];

            assert.equal(paused.status, 200, runtime);
            assert.equal(paused.body.clarification?.reason, "capability_approval_required", runtime);
            assert.ok(gate?.id, runtime);
            assert.equal(app.writes.length, 0, runtime);

            const pausedRun = await loadRun(app.agentRunService, UNIFIED_ACCESS_SCOPE, runId);
            const pausedThread = await readThread(app.agentRunService, UNIFIED_ACCESS_SCOPE, runId);
            const pausedRecord = await rawRecord(app.store, UNIFIED_ACCESS_SCOPE, runId);

            // A wrong approval object is refused before anything is decided.
            const refused = await decideGate(app, {
              action,
              gate,
              hash: `sha256:${"0".repeat(64)}`,
              runId,
            });
            assert.equal(refused.status, 409, runtime);
            assert.equal(app.writes.length, 0, runtime);
            assert.deepStrictEqual(
              await rawRecord(app.store, UNIFIED_ACCESS_SCOPE, runId),
              pausedRecord,
              `${runtime}: a refused decision leaves the thread record untouched`
            );

            const decided = await decideGate(app, { action, gate, runId });
            const decisionInvocations = takeInvocations();
            const finished = await loadRun(app.agentRunService, UNIFIED_ACCESS_SCOPE, runId);

            // The same gate cannot be decided twice.
            const again = await decideGate(app, { action, gate, runId });
            assert.equal(again.status, 409, runtime);

            return {
              decided,
              decisionInvocations,
              finished,
              finishedRecord: await rawRecord(app.store, UNIFIED_ACCESS_SCOPE, runId),
              gate,
              pauseInvocations,
              paused,
              pausedRecord,
              pausedRun,
              pausedThread: pausedThread
                ? {
                    interrupts: pausedThread.interrupts.map((pending) => pending.value),
                    receipts: receiptStatuses(pausedThread),
                    resumeWrites: pausedThread.resumeWrites,
                  }
                : null,
              writes: app.writes.length,
            };
          }),
        UNIFIED_ENV
      );
    }

    const { langgraph, native } = passes;
    const label = `action=${action}`;

    // Identical to a client and to a later process: the pause response, the
    // paused run, the decision response, and the finished run with its
    // checkpoint.
    assert.deepStrictEqual(mask(langgraph.paused), mask(native.paused), label);
    assert.deepStrictEqual(mask(langgraph.pausedRun), mask(native.pausedRun), label);
    assert.deepStrictEqual(mask(langgraph.decided), mask(native.decided), label);
    assert.deepStrictEqual(mask(langgraph.finished), mask(native.finished), label);
    assert.equal(native.pausedRun.run.status, "waiting_for_user", label);
    assert.equal(native.pausedRun.checkpoint.phase, "awaiting_approval", label);
    assert.equal(native.decided.status, 200, label);
    assert.equal(native.decided.body.run.status, "completed", label);
    assert.equal(native.finished.run.status, "completed", label);
    assert.equal(native.finished.checkpoint.phase, "completed", label);
    assert.ok(native.finished.checkpoint.finalization, label);

    if (action === "approve") {
      assert.equal(native.writes, 1, label);
      assert.equal(langgraph.writes, 1, label);
      assert.equal(native.decided.body.response.agentMode, "workspace_action", label);
      assert.match(native.decided.body.response.agentAnswer, /^Task recorded as task /, label);
      assert.deepStrictEqual(
        native.finished.run.events
          .filter((event) => event.type === "unified_graph_executed")
          .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
        [["document", "reused"], ["evidence_check", "reused"], ["task", "completed"]],
        label
      );
      assert.equal(native.finished.run.approvalGates[0].status, "approved", label);
    } else {
      assert.equal(native.writes, 0, label);
      assert.equal(langgraph.writes, 0, label);
      assert.equal(
        native.decided.body.response.agentAnswer,
        "Create Task was not run: the approval was denied.",
        label
      );
      assert.deepStrictEqual(
        native.finished.run.events
          .filter((event) => event.type === "unified_graph_executed")
          .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status, nodeRun.reason]),
        [["document", "reused", null], ["evidence_check", "reused", null], ["task", "skipped", "approval_denied"]],
        label
      );
      assert.equal(native.finished.run.approvalGates[0].status, "denied", label);
    }

    // Native never touched LangGraph and wrote no thread. On LangGraph the
    // graph was scheduled there at the pause and again at the decision, both
    // bound to the run; the parked thread held exactly one pending
    // interrupt of public ids for the task node, the receipts of the two
    // nodes that ran, no resume value, and no text; the finished run carries
    // no thread on either runtime.
    assert.deepStrictEqual(native.pauseInvocations, { graph: [], plan: [] }, label);
    assert.deepStrictEqual(native.decisionInvocations, { graph: [], plan: [] }, label);
    assert.equal(native.pausedThread, null, label);
    assert.equal(native.pausedRecord, null, label);
    assert.equal(langgraph.pauseInvocations.graph.length, 1, label);
    assert.deepStrictEqual(langgraph.pauseInvocations.plan, [], label);
    assert.deepStrictEqual(
      langgraph.pauseInvocations.graph[0],
      { boundToRun: true, nodeIds: ["document", "evidence_check", "task"], reusedNodeIds: [] },
      label
    );
    assert.equal(langgraph.decisionInvocations.graph.length, 1, label);
    assert.equal(langgraph.decisionInvocations.graph[0].boundToRun, true, label);
    assert.deepStrictEqual(langgraph.pausedThread, {
      interrupts: [buildApprovalInterruptPayload({ nodeId: "task" })],
      receipts: { document: "completed", evidence_check: "completed" },
      resumeWrites: [],
    }, label);
    assert.notEqual(langgraph.pausedRecord, null, label);
    assertNoText(langgraph.pausedRecord, privateTexts(langgraph.gate));
    assert.equal(langgraph.finishedRecord, null, label);
    assert.equal(native.finishedRecord, null, label);
  }
});

test("on LangGraph the approval continues the parked thread itself: the Capability runs once inside the resumed node with the runtime's own resume marker", async () => {
  let seen = null;
  const observe = { app: null, runId: null };

  await onRuntime(
    "langgraph",
    () =>
      withUnifiedApp(
        {
          onWrite: async () => {
            const thread = await readThread(observe.app.agentRunService, UNIFIED_ACCESS_SCOPE, observe.runId);

            seen = {
              interrupts: thread?.interrupts.map((pending) => pending.value) ?? null,
              receipts: thread ? receiptStatuses(thread) : null,
              record: await rawRecord(observe.app.store, UNIFIED_ACCESS_SCOPE, observe.runId),
              resumeWrites: thread?.resumeWrites ?? null,
            };
          },
        },
        async (app) => {
          observe.app = app;
          const paused = await postJson(`${app.baseUrl}/chat`, unifiedRequest(APPROVAL_TASK_QUESTION), unifiedHeaders);
          const gate = paused.body.approvalGates[0];

          observe.runId = paused.body.agentRunId;
          const decided = await decideGate(app, { action: "approve", gate, runId: observe.runId });

          assert.equal(decided.status, 200);
          assert.equal(app.writes.length, 1);
          assert.equal(
            app.writes[0].taskId,
            `capability-artifact:${observe.runId}:task:capability:task.create`
          );
          // Seen from inside the Capability's write: the receipts the first
          // invocation wrote are still "completed" (a fresh invocation would
          // re-enter those nodes as "reused"), the pause is still the pending
          // interrupt (the node has not returned), the resume value is the
          // runtime's marker and nothing else, and no text is in the record.
          assert.deepStrictEqual(seen.receipts, { document: "completed", evidence_check: "completed" });
          assert.deepStrictEqual(seen.interrupts, [buildApprovalInterruptPayload({ nodeId: "task" })]);
          assert.deepStrictEqual(seen.resumeWrites, [[RUNTIME_RESUME_MARKER]]);
          assertNoText(seen.record, privateTexts(gate));
          assert.equal(await rawRecord(app.store, UNIFIED_ACCESS_SCOPE, observe.runId), null);
        }
      ),
    UNIFIED_ENV
  );
});

// Under AGENT_RUNTIME=langgraph alone the route streams on its native branch
// (no relay), and the v3 graph LangGraph schedules is invoked without the
// relay, so its nodes emit to the sink the native branch bound around the
// run: the graph's steps must reach the client exactly as natively. With the
// outer dial as well, the route streams through the LangGraph relay, and the
// same bytes come out.
test("POST /chat/stream over the v3 graph relays identical SSE bytes on every pass up to the approval pause, and the graph's events reach the client in order", async () => {
  const passes = {};

  for (const runtime of OUTER_PLAN_PASSES) {
    passes[runtime] = await onRuntime(
      runtime,
      () =>
        withUnifiedApp({}, async (app) => {
          takeAgentStreamRelayCalls();

          const streamed = await fetch(`${app.baseUrl}/chat/stream`, {
            body: JSON.stringify(unifiedRequest(APPROVAL_TASK_QUESTION)),
            headers: { "content-type": "application/json", ...unifiedHeaders },
            method: "POST",
          });
          const text = await streamed.text();
          const frames = parseFrames(text);
          const invocations = takeInvocations();
          const result = frames.at(-2)?.data;
          const runId = result?.body?.agentRunId;

          return {
            frames,
            invocations,
            relayCalls: takeAgentStreamRelayCalls(),
            run: runId ? await loadRun(app.agentRunService, UNIFIED_ACCESS_SCOPE, runId) : null,
            status: streamed.status,
            text,
          };
        }),
      UNIFIED_ENV
    );
  }

  const { langgraph, native, outerPlan } = passes;

  assert.equal(native.status, 200);
  for (const [pass, other] of [["langgraph", langgraph], ["outerPlan", outerPlan]]) {
    assert.equal(other.status, 200, pass);
    assert.equal(maskText(other.text), maskText(native.text), pass);
    assert.deepStrictEqual(mask(other.frames), mask(native.frames), pass);
    assert.deepStrictEqual(mask(other.run), mask(native.run), pass);
  }
  const events = native.frames.map((frame) => frame.event);
  assert.deepStrictEqual(events.slice(-2), ["result", "done"]);
  assert.equal(native.frames.at(-2).data.status, 200);
  assert.equal(native.frames.at(-2).data.body.clarification?.reason, "capability_approval_required");
  assert.equal(native.run.run.status, "waiting_for_user");
  // The graph's own steps were streamed (the document node and its check),
  // before the result; nothing of the answer text other than through the
  // compact step summaries the native stream carries too.
  const stepTypes = native.frames
    .filter((frame) => frame.event === "trace_step")
    .map((frame) => frame.data.step?.type);
  assert.ok(stepTypes.length > 0, JSON.stringify(events));
  // One graph_node step per node that ran before the pause (the document node
  // and its check), each emitted from inside a graph node -- on LangGraph,
  // inside a LangGraph node -- between the plan and the approval gate.
  assert.deepStrictEqual(stepTypes, ["plan", "graph_node", "graph_node", "capability_approval_gate"]);
  assert.deepStrictEqual(native.run.run.steps.map((step) => step.type), ["graph_node", "graph_node"]);
  assert.deepStrictEqual(native.invocations, { graph: [], plan: [] });
  // Both LangGraph passes scheduled the v3 graph on LangGraph and never the
  // outer plan (the graph answers the request); only the outer dial moved
  // the stream onto the relay.
  for (const [pass, other] of [["langgraph", langgraph], ["outerPlan", outerPlan]]) {
    assert.equal(other.invocations.graph.length, 1, pass);
    assert.equal(other.invocations.graph[0].boundToRun, true, pass);
    assert.deepStrictEqual(other.invocations.plan, [], pass);
  }
  assert.equal(native.relayCalls, 0);
  assert.equal(langgraph.relayCalls, 0);
  assert.equal(outerPlan.relayCalls, 1);
});

// ---------------------------------------------------------------------------
// The V1 Capability approval on the same endpoint
// ---------------------------------------------------------------------------

const WEB_QUESTION = "Search the web for the current launch date of the product and summarize it.";

const createWebSearchRegistry = () => {
  const calls = [];
  const registry = createCapabilityRegistry([
    {
      accessScope: { required: false },
      approvalPolicy: {
        mode: "user_confirmation",
        userConfirmationRequired: true,
        writesWorkspace: false,
      },
      execute: async ({ input }) => {
        calls.push(input.question);

        return { text: `Approved web answer for: ${input.question}` };
      },
      id: CAPABILITY_IDS.webSearch,
      inputSchema: {
        properties: { question: { type: "string" } },
        required: ["question"],
        type: "object",
      },
      label: "Web Search",
      privacyPolicy: { externalCall: true, sanitizedInputFields: ["question"], storesResult: false },
      version: "1.0.0",
    },
  ]);

  return { calls, registry };
};

const webScope = Object.freeze({ userId: "web-user", workspaceId: "" });

test("the V1 Capability approval pauses the run and resumes it through POST /agent-runs/:runId/actions/approve identically on every pass", async () => {
  const passes = {};

  for (const runtime of OUTER_PLAN_PASSES) {
    passes[runtime] = await onRuntime(runtime, async () => {
      const { calls, registry } = createWebSearchRegistry();

      return withApp(
        {
          agentRunService: newService(newStore()),
          capabilityRegistry: registry,
          ragService: appRagService({
            chat: async () => {
              throw new Error("Document RAG should not run for direct web prompts.");
            },
            getDocument: () => null,
            listDocuments: () => [],
          }),
        },
        async (app) => {
          const headers = scopeHeaders(webScope);
          const paused = await postJson(`${app.baseUrl}/chat`, { question: WEB_QUESTION }, headers);
          const pauseInvocations = takeInvocations();
          const runId = paused.body.agentRunId;
          const gate = paused.body.approvalGates?.[0];

          assert.equal(paused.status, 200, runtime);
          assert.equal(paused.body.clarification?.reason, "capability_approval_required", runtime);
          assert.equal(gate?.capabilityId, CAPABILITY_IDS.webSearch, runtime);
          assert.deepStrictEqual(calls, [], runtime);

          const refused = await postJson(
            `${app.baseUrl}/agent-runs/${runId}/actions/approve`,
            { approvalObjectHash: `sha256:${"0".repeat(64)}`, gateId: gate.id },
            headers
          );
          assert.equal(refused.status, 409, runtime);
          assert.deepStrictEqual(calls, [], runtime);

          const pausedRun = await loadRun(app.agentRunService, webScope, runId);
          const approved = await postJson(
            `${app.baseUrl}/agent-runs/${runId}/actions/approve`,
            { approvalObjectHash: gate.approvalObjectHash, gateId: gate.id },
            headers
          );
          const decisionInvocations = takeInvocations();
          const finished = await loadRun(app.agentRunService, webScope, runId);

          return { approved, calls, decisionInvocations, finished, pauseInvocations, paused, pausedRun };
        }
      );
    });
  }

  const { langgraph, native, outerPlan } = passes;

  for (const [pass, other] of [["langgraph", langgraph], ["outerPlan", outerPlan]]) {
    assert.deepStrictEqual(mask(other.paused), mask(native.paused), pass);
    assert.deepStrictEqual(mask(other.pausedRun), mask(native.pausedRun), pass);
    assert.deepStrictEqual(mask(other.approved), mask(native.approved), pass);
    assert.deepStrictEqual(mask(other.finished), mask(native.finished), pass);
    assert.deepStrictEqual(other.calls, native.calls, pass);
  }
  assert.deepStrictEqual(native.calls, [WEB_QUESTION]);
  assert.equal(native.approved.status, 200);
  assert.equal(native.approved.body.response.agentMode, "web");
  assert.equal(native.approved.body.run.status, "completed");
  assert.equal(native.finished.run.approvalGates[0].status, "approved");
  assert.deepStrictEqual(
    native.finished.run.events.map((event) => event.type),
    [
      "run_created",
      "run_prepared",
      "execution_planned",
      "step_started",
      "step_paused",
      "approval_gate_created",
      "approval_gate_approved",
      "step_started",
      "step_completed",
      "run_completed",
    ]
  );
  // With the outer dial the V1 plan was scheduled on LangGraph for the
  // request that parked the Capability; AGENT_RUNTIME=langgraph alone kept it
  // on the native loop. The approval action resumes the paused step itself
  // (the step executor, no outer plan) on every pass.
  assert.deepStrictEqual(native.pauseInvocations, { graph: [], plan: [] });
  assert.deepStrictEqual(native.decisionInvocations, { graph: [], plan: [] });
  assert.deepStrictEqual(langgraph.pauseInvocations, { graph: [], plan: [] });
  assert.deepStrictEqual(langgraph.decisionInvocations, { graph: [], plan: [] });
  assert.equal(outerPlan.pauseInvocations.plan.length, 1);
  assert.ok(outerPlan.pauseInvocations.plan[0].stepIds.includes("web_search"), JSON.stringify(outerPlan.pauseInvocations));
  assert.deepStrictEqual(outerPlan.pauseInvocations.graph, []);
  assert.deepStrictEqual(outerPlan.decisionInvocations, { graph: [], plan: [] });
});

// ---------------------------------------------------------------------------
// A background task whose v3 graph pauses for approval
// ---------------------------------------------------------------------------

test("a background task runs the v3 graph, parks at the gate, and its approve action re-enters the SAME graph identically on both runtimes", async () => {
  const passes = {};

  for (const runtime of RUNTIMES) {
    passes[runtime] = await onRuntime(
      runtime,
      async () => {
        const scheduled = [];
        const drain = async () => {
          while (scheduled.length > 0) {
            await Promise.all(scheduled.splice(0));
          }
        };

        return withUnifiedApp(
          {
            createAgentTaskId: () => "routes-approval",
            jobSchedule: (work) => {
              scheduled.push(Promise.resolve().then(work));
            },
            taskStore: createInMemoryTaskStore(),
            workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
          },
          async (app) => {
            const taskUrl = `${app.baseUrl}/tasks/${encodeURIComponent("agent_goal:routes-approval")}`;
            const created = await postJson(
              `${app.baseUrl}/agent-tasks`,
              {
                docIds: [UNIFIED_DOC_ID],
                maxIterations: 2,
                question: APPROVAL_TASK_QUESTION,
                sessionId: UNIFIED_SESSION_ID,
                userId: UNIFIED_ACCESS_SCOPE.userId,
              },
              unifiedHeaders
            );

            assert.equal(created.status, 202, runtime);
            await drain();

            const waiting = await getJson(taskUrl, unifiedHeaders);
            const pauseInvocations = takeInvocations();
            const runId = waiting.body.result?.agentRunId;
            const gate = waiting.body.result?.approvalGates?.[0];

            assert.equal(waiting.status, 200, runtime);
            assert.equal(waiting.body.status, "waiting_for_user", runtime);
            assert.equal(waiting.body.requiredUserAction, "approve_capability", runtime);
            assert.ok(gate?.id, runtime);
            assert.equal(app.writes.length, 0, runtime);

            const pausedRun = await loadRun(app.agentRunService, UNIFIED_ACCESS_SCOPE, runId);
            const pausedThread = await readThread(app.agentRunService, UNIFIED_ACCESS_SCOPE, runId);
            const approved = await postJson(
              `${taskUrl}/actions/${AGENT_TASK_ACTIONS.approve}`,
              { approvalObjectHash: gate.approvalObjectHash, gateId: gate.id },
              unifiedHeaders
            );

            assert.equal(approved.status, 202, runtime);
            assert.equal(approved.body.task.status, "queued", runtime);
            await drain();

            const completed = await getJson(taskUrl, unifiedHeaders);
            const decisionInvocations = takeInvocations();
            const finished = await loadRun(app.agentRunService, UNIFIED_ACCESS_SCOPE, runId);

            return {
              completed,
              decisionInvocations,
              finished,
              finishedRecord: await rawRecord(app.store, UNIFIED_ACCESS_SCOPE, runId),
              pauseInvocations,
              pausedRun,
              pausedThread: pausedThread
                ? { interrupts: pausedThread.interrupts.map((pending) => pending.value), receipts: receiptStatuses(pausedThread) }
                : null,
              waiting,
              writes: app.writes.length,
            };
          }
        );
      },
      UNIFIED_ENV
    );
  }

  const { langgraph, native } = passes;

  assert.deepStrictEqual(mask(langgraph.waiting), mask(native.waiting));
  assert.deepStrictEqual(mask(langgraph.pausedRun), mask(native.pausedRun));
  assert.deepStrictEqual(mask(langgraph.completed), mask(native.completed));
  assert.deepStrictEqual(mask(langgraph.finished), mask(native.finished));
  // The approved iteration is the parked run's own answer: one agent run in
  // all, re-entered rather than re-planned. (What the task does after that
  // is the goal-deliverable step of agent-goal-deliverables.js, the same on
  // both runtimes and no part of the graph; it is compared above, not pinned
  // here.)
  const iterations = native.completed.body.items.filter((item) => /^iteration-/.test(item.id));
  assert.deepStrictEqual(
    iterations.map((item) => [item.id, item.status, item.result.agentMode]),
    [["iteration-1", "waiting_for_user", "clarification"], ["iteration-2", "completed", "workspace_action"]]
  );
  assert.match(iterations[1].summary, /^Task recorded as task /);
  assert.equal(native.completed.body.result.agentRunId, native.waiting.body.result.agentRunId);
  assert.equal(native.completed.body.counts.agentRuns, 1);
  assert.equal(native.finished.run.status, "completed");
  assert.equal(native.finished.checkpoint.phase, "completed");
  assert.equal(native.writes, 1);
  assert.equal(langgraph.writes, 1);
  assert.deepStrictEqual(
    native.finished.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    [["document", "reused"], ["evidence_check", "reused"], ["task", "completed"]]
  );
  assert.deepStrictEqual(native.pauseInvocations, { graph: [], plan: [] });
  assert.deepStrictEqual(native.decisionInvocations, { graph: [], plan: [] });
  assert.equal(native.pausedThread, null);
  assert.equal(langgraph.pauseInvocations.graph.length, 1);
  assert.equal(langgraph.decisionInvocations.graph.length, 1);
  assert.deepStrictEqual(langgraph.pauseInvocations.plan, []);
  assert.deepStrictEqual(langgraph.decisionInvocations.plan, []);
  assert.deepStrictEqual(langgraph.pausedThread, {
    interrupts: [buildApprovalInterruptPayload({ nodeId: "task" })],
    receipts: { document: "completed", evidence_check: "completed" },
  });
  assert.equal(langgraph.finishedRecord, null);
  assert.equal(native.finishedRecord, null);
});

// ---------------------------------------------------------------------------
// Startup recovery through the app's own recoverOnStartup
// ---------------------------------------------------------------------------

test("startup recovery of a v3 run another app instance left at a node boundary resumes it identically on both runtimes", async () => {
  const passes = {};

  for (const runtime of RUNTIMES) {
    passes[runtime] = await onRuntime(
      runtime,
      async () => {
        const store = newStore();
        const planner = createProposalAdapter(createDocumentLoopProposal);
        // The first instance exits right after the primary check's
        // checkpoint write; every later write of that process fails.
        const { service: crashing, state } = createCrashingRunService(newService(store), {
          crashAfter: (method, args) =>
            method === "saveExecutionGraphCheckpoint" &&
            checkpointHasNodeRun(args.checkpoint, "primary_check") &&
            !checkpointHasNodeRun(args.checkpoint, "follow_up"),
        });
        const firstRag = createDocumentLoopRagService({ followUp: "resolves" });
        const crashed = await withApp(
          {
            agentRunService: crashing,
            ragService: appRagService(firstRag),
            unifiedGraphPlannerAdapter: planner,
          },
          async (app) => {
            const response = await postJson(
              `${app.baseUrl}/chat`,
              unifiedRequest(DOCUMENT_LOOP_QUESTION),
              unifiedHeaders
            );

            return { invocations: takeInvocations(), response };
          }
        );

        assert.equal(crashed.response.status, 500, runtime);
        assert.equal(state.runIds.length, 1, runtime);
        assert.deepStrictEqual(firstRag.calls.map((call) => call.phase), ["primary"], runtime);
        const runId = state.runIds[0];
        const before = await loadRun(newService(store), UNIFIED_ACCESS_SCOPE, runId);
        const beforeRecord = await rawRecord(store, UNIFIED_ACCESS_SCOPE, runId);

        assert.equal(before.run.status, "running", runtime);
        assert.equal(before.checkpoint.phase, "running", runtime);

        // The second instance's startup recovery (createApp runs it before
        // the routes exist) finds the run and resumes it.
        const secondRag = createDocumentLoopRagService({ followUp: "resolves" });
        const recovered = await withApp(
          {
            agentRunService: newService(store),
            ragService: appRagService(secondRag),
            recovery: null,
            unifiedGraphPlannerAdapter: planner,
          },
          async (app) => ({
            after: await loadRun(app.agentRunService, UNIFIED_ACCESS_SCOPE, runId),
            afterRecord: await rawRecord(store, UNIFIED_ACCESS_SCOPE, runId),
            startupInvocations: app.startupInvocations,
          })
        );

        return {
          ...recovered,
          before,
          beforeRecord,
          crashInvocations: crashed.invocations,
          secondCalls: secondRag.calls.map((call) => call.phase),
        };
      },
      { ...UNIFIED_ENV, AGENT_RUN_RECOVERY_MODE: "auto" }
    );
  }

  const { langgraph, native } = passes;
  const countEvents = (run, type) => run.events.filter((event) => event.type === type).length;

  assert.deepStrictEqual(mask(langgraph.before), mask(native.before));
  assert.deepStrictEqual(mask(langgraph.after), mask(native.after));
  assert.deepStrictEqual(langgraph.secondCalls, native.secondCalls);
  assert.deepStrictEqual(native.secondCalls, ["follow_up"]);
  assert.equal(native.after.run.status, "completed");
  assert.equal(native.after.checkpoint.phase, "completed");
  assert.ok(native.after.checkpoint.finalization);
  assert.equal(countEvents(native.after.run, "skill_graph_resume_claimed"), 1);
  assert.equal(countEvents(native.after.run, "auto_recovery_completed"), 1);
  assert.equal(countEvents(native.after.run, "manual_recovery_required"), 0);
  assert.deepStrictEqual(
    native.after.run.events
      .filter((event) => event.type === "unified_graph_executed")
      .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
    [
      ["primary", "reused"],
      ["primary_check", "reused"],
      ["follow_up", "completed"],
      ["follow_up_check", "completed"],
    ]
  );
  // Native: no thread at any time, nothing on LangGraph. LangGraph: the
  // crashed instance left its thread on the run row; recovery read it before
  // claiming, then resumed on a fresh invocation seeded from the checkpoint
  // (the two settled nodes reused), and the completed run carries no thread.
  assert.deepStrictEqual(native.crashInvocations, { graph: [], plan: [] });
  assert.deepStrictEqual(native.startupInvocations, { graph: [], plan: [] });
  assert.equal(native.beforeRecord, null);
  assert.equal(langgraph.crashInvocations.graph.length, 1);
  assert.notEqual(langgraph.beforeRecord, null);
  assertNoText(langgraph.beforeRecord, [DOCUMENT_LOOP_QUESTION, "60 days notice", "30 days written notice"]);
  assert.deepStrictEqual(langgraph.startupInvocations.plan, []);
  assert.deepStrictEqual(langgraph.startupInvocations.graph, [
    {
      boundToRun: true,
      nodeIds: ["primary", "primary_check", "follow_up", "follow_up_check"],
      reusedNodeIds: ["primary", "primary_check"],
    },
  ]);
  assert.equal(langgraph.afterRecord, null);
  assert.equal(native.afterRecord, null);
});
