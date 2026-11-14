// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";

// Acceptance evidence for the public surface on the LangGraph runtime
// (docs/adr/0001-langgraph-runtime.md): the real app (createApp over the local
// vector store, an in-memory run store and a stand-in model) answers these
// requests with everything the agent schedules on LangGraph: the outer plan
// and the /chat/stream relay (the only path since phase 7 removed the native
// loop and the route's native branch). What the removed native loop did on
// each request is frozen, masked exactly as below, under
// test/fixtures/graph-goldens/langgraph-routes/, and the app is held to those
// goldens with deepStrictEqual (assertMatchesGraphGolden; rewriting one is a
// decision, see test/langgraph-support/graph-goldens.mjs): document QA, its
// stream with GET and POST /chat, and the Capability approval, from commit
// 3313b40b with the outer plan on the native loop, before phase 7.
//
//   - POST /chat on the outer plan;
//   - GET and POST /chat, POST /chat/stream (the bytes on the wire, with
//     answer drafts);
//   - the Capability approval through POST /agent-runs/:runId/actions/approve.
//
// Until ADR 0001 phase 10 removed the v3 unified graph, this suite also held
// five goldens of that graph through the routes (approve and deny, its stream
// up to the approval pause, a background task's approval re-entry, startup
// recovery). What the routes' services do with a run that graph stored is in
// test/agent-stored-unified-graph-runs.test.mjs.
//
// The on-demand imports of both LangGraph schedulers are redirected to the
// phase-2/3 counting taps, so each request also proves what LangGraph really
// scheduled (the outer plan, and no execution graph); the route's import of
// the stream relay is tapped too, so a stream is seen to have gone through
// streamAgentRun.

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
const { writeQaAnswer } = await import("../rag/answer-writer.js");
const { createCapabilityRegistry } = await import("../rag/capabilities/index.js");
const { CAPABILITY_IDS } = await import("../rag/capabilities/shared.js");
const { assertMatchesGraphGolden } = await import("./langgraph-support/graph-goldens.mjs");
const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");

// Every request runs with the answer-rate flags off and nothing in the
// ambient environment pointing at another tier, a gateway, a timeout or a
// rollout (the two removed runtime dials unset).
const BASE_ENV = Object.freeze({
  ...ANSWER_RATE_FLAGS_OFF,
  AGENT_CANCEL_ON_DISCONNECT: undefined,
  AGENT_OUTER_PLAN_RUNTIME: undefined,
  AGENT_PLANNER_ROLLOUT: "deterministic",
  AGENT_REQUEST_TIMEOUT_MS: undefined,
  AGENT_RUNTIME: undefined,
  AGENT_RUN_RECOVERY_MODE: undefined,
  AGENT_SERVICE_URL: undefined,
  AGENT_UNIFIED_GRAPH_ROLLOUT: undefined,
  ARCHIVE_RAG_ROLE: undefined,
  MODEL_GATEWAY_URL: undefined,
  POSTGRES_DATABASE_URL: undefined,
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

// Startup recovery is skipped where a test does not exercise it, so an
// earlier test's store can never be recovered by accident.
const noRecovery = {
  recoverOnStartup: async () => ({ mode: "manual", recoveredCount: 0, runs: [] }),
};

const onLangGraph = (work, env = {}) => withEnv({ ...BASE_ENV, ...env }, work);

// ---------------------------------------------------------------------------
// Masking: what two runs never share, and nothing else (the rules the
// goldens were frozen with). Random ids (UUIDs, also inside composite ids),
// timestamps,
// wall-clock measurements, the checkpoint seal and everything hashed from it
// (the gate id, its approval object hash), and, for run-bound comparisons,
// the typed-output and answer digests (the task node's output names the run
// id, so its digest differs between any two runs).
// ---------------------------------------------------------------------------

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const APPROVAL_HASH_PATTERN = /(?<!v1:)sha256:[0-9a-f]{64}/g;
const GATE_ID_PATTERN = /graph-approval:[0-9a-f]{64}/g;
// A goal deliverable's approval gate id: approval:<capability>:<version>:<sha256
// of an approval object that names the run>, so it differs between runs.
const DELIVERABLE_GATE_ID_PATTERN = /\bapproval:([a-z][a-z0-9._-]*):(\d[0-9.]*):[0-9a-f]{64}/g;
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
      .replace(GATE_ID_PATTERN, "graph-approval:<approval-hash>")
      .replace(DELIVERABLE_GATE_ID_PATTERN, "approval:$1:$2:<approval-hash>");
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
  ragService,
  recovery = noRecovery,
}) => {
  takeLangGraphInvocations();
  takePlanGraphInvocations();

  const app = await createApp({
    ...(recovery ? { agentRunRecoveryService: recovery } : {}),
    agentRunService,
    ...(capabilityRegistry ? { capabilityRegistry } : {}),
    chatMcp: async () => ({ text: "web" }),
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService: okHealthService,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService,
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

test("POST /chat answers a document question as the native loop's golden records, with the outer plan scheduled on LangGraph", async (t) => {
  installStreamingModel(t);

  const langgraph = await onLangGraph(() =>
    withApp({ agentRunService: newService(newStore()), ragService: createQaRagService() }, async (app) => {
      const answer = await postJson(`${app.baseUrl}/chat`, qaRequest, scopeHeaders(qaScope));
      const invocations = takeInvocations();
      const run = await loadRun(app.agentRunService, qaScope, answer.body.agentRunId);

      return { answer, invocations, run };
    })
  );

  assert.equal(langgraph.answer.status, 200);
  assert.equal(langgraph.answer.body.agentMode, "document");
  for (const sentence of QA_SENTENCES) {
    assert.ok(langgraph.answer.body.agentAnswer.includes(sentence), sentence);
  }
  assert.equal(langgraph.run.run.status, "completed");
  // The answer and the run are what the native outer loop left (the golden).
  assertMatchesGraphGolden("langgraph-routes", "v1-chat-document-question", {
    answer: mask(langgraph.answer),
    run: mask(langgraph.run),
  });
  // The plan was scheduled on LangGraph once, bound to the run; no
  // custom-Skill graph exists on this request.
  assert.deepStrictEqual(langgraph.invocations.graph, []);
  assert.equal(langgraph.invocations.plan.length, 1);
  assert.equal(langgraph.invocations.plan[0].boundToRun, true);
  assert.ok(langgraph.invocations.plan[0].stepIds.includes("document_rag"));
});

test("POST /chat/stream relays the SSE bytes the native branch's golden records, drafts included; its result equals GET /chat and POST /chat; GET /chat/stream is no route", async (t) => {
  installStreamingModel(t);

  const langgraph = await onLangGraph(() =>
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
      // a GET of the stream path is a 404.
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

  assert.equal(langgraph.stream.status, 200);
  assert.equal(langgraph.getStreamStatus, 404);
  assert.equal(langgraph.get.status, 200);
  assert.equal(langgraph.post.status, 200);
  const events = langgraph.stream.frames.map((frame) => frame.event);
  assert.ok(events.includes("trace_step"));
  assert.deepStrictEqual(events.slice(-2), ["result", "done"]);
  assert.deepStrictEqual(
    langgraph.stream.frames
      .filter((frame) => frame.event === "answer_draft")
      .map((frame) => frame.data.draft.text),
    QA_SENTENCES
  );
  // The result frame is the /chat answer, whichever method asked.
  assert.deepStrictEqual(mask(langgraph.stream.frames.at(-2).data), mask(langgraph.post));
  assert.deepStrictEqual(mask(langgraph.get), mask(langgraph.post));
  assert.equal(langgraph.runs.length, 3);
  // The bytes, both /chat answers and the three runs are what the native
  // route branch and loop left (the golden).
  assertMatchesGraphGolden("langgraph-routes", "v1-chat-stream-document-question", {
    get: mask(langgraph.get),
    post: mask(langgraph.post),
    runs: mask(langgraph.runs),
    stream: {
      frames: mask(langgraph.stream.frames),
      status: langgraph.stream.status,
      text: maskVolatileText(langgraph.stream.text),
    },
  });
  // The stream went through the relay generator, and the stream and GET
  // /chat each scheduled the outer plan on LangGraph (the POST /chat after
  // them is not in the count).
  assert.equal(langgraph.relayCalls, 1);
  assert.equal(langgraph.invocations.plan.length, 2);
  assert.deepStrictEqual(langgraph.invocations.graph, []);
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

test("the V1 Capability approval pauses the run and resumes it through POST /agent-runs/:runId/actions/approve as the native loop's golden records", async () => {
  const langgraph = await onLangGraph(async () => {
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

        assert.equal(paused.status, 200);
        assert.equal(paused.body.clarification?.reason, "capability_approval_required");
        assert.equal(gate?.capabilityId, CAPABILITY_IDS.webSearch);
        assert.deepStrictEqual(calls, []);

        const refused = await postJson(
          `${app.baseUrl}/agent-runs/${runId}/actions/approve`,
          { approvalObjectHash: `sha256:${"0".repeat(64)}`, gateId: gate.id },
          headers
        );
        assert.equal(refused.status, 409);
        assert.deepStrictEqual(calls, []);

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

  assert.deepStrictEqual(langgraph.calls, [WEB_QUESTION]);
  // The pause, the paused run, the approval answer and the finished run are
  // what the native outer loop left (the golden).
  assertMatchesGraphGolden("langgraph-routes", "v1-capability-approval", {
    approved: mask(langgraph.approved),
    calls: langgraph.calls,
    finished: mask(langgraph.finished),
    paused: mask(langgraph.paused),
    pausedRun: mask(langgraph.pausedRun),
  });
  assert.equal(langgraph.approved.status, 200);
  assert.equal(langgraph.approved.body.response.agentMode, "web");
  assert.equal(langgraph.approved.body.run.status, "completed");
  assert.equal(langgraph.finished.run.approvalGates[0].status, "approved");
  assert.deepStrictEqual(
    langgraph.finished.run.events.map((event) => event.type),
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
  // The V1 plan was scheduled on LangGraph for the request that parked the
  // Capability. The approval action resumes the paused step itself (the step
  // executor, no outer plan).
  assert.equal(langgraph.pauseInvocations.plan.length, 1);
  assert.ok(
    langgraph.pauseInvocations.plan[0].stepIds.includes("web_search"),
    JSON.stringify(langgraph.pauseInvocations)
  );
  assert.deepStrictEqual(langgraph.pauseInvocations.graph, []);
  assert.deepStrictEqual(langgraph.decisionInvocations, { graph: [], plan: [] });
});
