import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import { createApp as createProductionApp } from "../app.js";
import { continueAgentExecutionGraphApproval, runAgentRag } from "../rag/agent.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import { createAgentRunStepExecutor } from "../rag/agent-run-step-executor.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { DependencyOutageError } from "../rag/dependency-outage.js";
import { completeText, configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import {
  getRequestDeadline,
  getRequestSignal,
  RequestCancelledError,
  runWithRequestDeadline,
} from "../rag/request-deadline.js";
import { ServiceTimeoutError, ServiceUnavailableError } from "../rag/service-client.js";
import {
  APPROVAL_TASK_QUESTION,
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  createApprovalGatedTaskProposal,
  createDocumentLoopProposal,
  createDocumentLoopRagService,
  createProposalAdapter,
  createTaskCapabilityRegistry,
} from "./fixtures/unified-graph-run-fixtures.mjs";

// The deadline and collector timers are unref'd so they never hold a process
// open. A test that awaits one needs something else keeping the event loop
// alive: on Node 20 (CI) the loop drains first and every later test in the
// file is cancelled.
let keepEventLoopAlive = null;
before(() => {
  keepEventLoopAlive = setInterval(() => {}, 60_000);
});
after(() => clearInterval(keepEventLoopAlive));

// Cancellation and outages through the agent run, in one process: runAgentRag
// under a request deadline, and the monolith's /chat and /chat/stream with
// AGENT_REQUEST_TIMEOUT_MS and AGENT_CANCEL_ON_DISCONNECT. The model is
// either a local HTTP server that never answers (so an abort is observable on
// the wire) or a stand-in provider that waits until it is released or its
// signal aborts. Every run lives in an in-memory run store this file reads.

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const QUESTION = "What does remote work require?";
const CITATION = {
  docId: "doc-1",
  excerpt: "Remote work requires manager approval.",
  fileName: "policy.pdf",
  pageNumber: 2,
  sourceLabel: "Source 1",
  text: "Remote work requires manager approval.",
};
const ANSWER_TEXT = "Remote work requires manager approval. [Source 1]";
const accessScope = { userId: "alice", workspaceId: "workspace-a" };

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const withEnv = (t, values) => {
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

// The document answer goes through openai.js completeText, so whatever model
// is configured (an HTTP server, a stand-in) is the call a cancellation aborts.
const createRagService = ({ chat } = {}) => ({
  chat:
    chat ??
    (async (docIds, question) => ({
      abstained: false,
      citations: [CITATION],
      memoryApplied: false,
      resolvedQuery: question,
      text: await completeText(`Answer from the evidence: ${question}`),
    })),
  clearDocuments: async () => [],
  clearSessionMemory: () => true,
  deleteDocument: async () => null,
  getDocument: (docId) => (docId === "doc-1" ? { docId: "doc-1", fileName: "policy.pdf" } : null),
  ingestDocument: async () => null,
  initializeDocumentRegistry: async () => [],
  initializeSessionMemory: async () => true,
  listDocuments: () => [{ docId: "doc-1", fileName: "policy.pdf" }],
});

// A stand-in chat model: each call waits until release() or until its signal
// aborts, and records what happened to it.
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
        release.promise.then(() => resolve(ANSWER_TEXT));
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

// A model server that takes every request and never answers.
const startHangingModel = async (t) => {
  const requests = [];
  const open = new Set();
  const server = createServer((req, res) => {
    const closed = createDeferred();
    const entry = { closed: closed.promise, closedAt: null };

    requests.push(entry);
    open.add(res);
    req.resume();
    res.on("close", () => {
      entry.closedAt = Date.now();
      open.delete(res);
      closed.resolve();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const res of open) res.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return { requests, url: `http://127.0.0.1:${server.address().port}` };
};

const createRunService = () => {
  const agentRunStore = createInMemoryAgentRunStore();

  return { agentRunService: createAgentRunService({ agentRunStore }), agentRunStore };
};

const runOneAgent = ({ agentRunService, ragService }) =>
  runAgentRag({
    accessScope,
    agentRunService,
    docIds: ["doc-1"],
    executionPlannerAdapter: deterministicPlannerAdapter,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    question: QUESTION,
    ragService,
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search must not run.");
    },
  });

const pickRunError = (error) => ({
  code: error?.code,
  reason: error?.reason,
  retryable: error?.retryable,
});

test("a deadline that passes mid-run aborts the in-flight model call and ends the run failed, never to be recovered", { timeout: 20_000 }, async (t) => {
  const model = await startHangingModel(t);

  withEnv(t, {
    MODEL_GATEWAY_URL: undefined,
    OPENAI_API_BASE: undefined,
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: `${model.url}/v1`,
    OPENAI_CHAT_FALLBACK_MODEL: "",
    RAG_LLM_REQUEST_TIMEOUT_MS: "10000",
  });
  resetOpenAIProvider();
  t.after(() => resetOpenAIProvider());

  const { agentRunService } = createRunService();
  const startedAt = Date.now();
  const error = await runWithRequestDeadline({ deadlineAt: startedAt + 250 }, () =>
    runOneAgent({ agentRunService, ragService: createRagService() })
  ).then(
    () => assert.fail("the run should not complete"),
    (rejection) => rejection
  );

  assert.ok(error instanceof RequestCancelledError, String(error));
  assert.equal(error.reason, "deadline_exceeded");
  assert.equal(typeof error.agentRunId, "string");

  // The model request was aborted on the wire, once, at the deadline -- not
  // after the 10 s request timeout and not retried.
  await model.requests[0].closed;
  assert.equal(model.requests.length, 1);
  assert.ok(model.requests[0].closedAt - startedAt < 3_000);

  const run = await agentRunService.getRun({ accessScope, runId: error.agentRunId });

  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.deepEqual(pickRunError(run.error), {
    code: "AGENT_DEADLINE_EXCEEDED",
    reason: "deadline_exceeded",
    retryable: true,
  });
  assert.equal(run.events.at(-1).type, "run_failed");
  assert.deepEqual(
    run.steps.map(({ id, status }) => ({ id, status })),
    [{ id: "document_rag:primary", status: "failed" }],
    "the step that was running settled; nothing is left running"
  );

  // Startup recovery lists only running and waiting runs: this one is not
  // picked up, and an automatic recovery pass leaves it as it is.
  const { runs } = await agentRunService.listRecoverableRuns();

  assert.ok(!runs.some((listed) => listed.runId === error.agentRunId));

  await createAgentRunRecoveryService({ agentRunService }).recoverOnStartup({ mode: "auto" });
  const after = await agentRunService.getRun({ accessScope, runId: error.agentRunId });

  assert.equal(after.status, AGENT_RUN_STATUSES.failed);
  assert.equal(after.revision, run.revision);
});

test("a run whose request is already cancelled starts no step and calls nothing", async () => {
  const { agentRunService } = createRunService();
  let chatCalls = 0;
  const ragService = createRagService({
    chat: async () => {
      chatCalls += 1;
      return { citations: [CITATION], text: ANSWER_TEXT };
    },
  });

  const error = await runWithRequestDeadline({ deadlineAt: Date.now() - 1 }, () =>
    runOneAgent({ agentRunService, ragService })
  ).then(
    () => assert.fail("the run should not complete"),
    (rejection) => rejection
  );

  assert.equal(error.reason, "deadline_exceeded");
  assert.equal(chatCalls, 0);

  const run = await agentRunService.getRun({ accessScope, runId: error.agentRunId });

  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.deepEqual(run.steps, []);

  // The lifecycle refuses to start a step for a cancelled request and records
  // nothing.
  let recorded = 0;
  const lifecycle = createAgentRunStepLifecycle({
    agentRunService: { recordRunStep: async () => (recorded += 1) },
    runId: "run-x",
  });

  await assert.rejects(
    runWithRequestDeadline({ deadlineAt: Date.now() - 1 }, async () =>
      lifecycle.startStep({ id: "step-1", label: "Step", type: "document_rag" })
    ),
    RequestCancelledError
  );
  assert.equal(recorded, 0);
});

test("a bound deadline that is not reached adds no run store calls to /chat", async () => {
  const memoryStore = createInMemoryAgentRunStore({ now: () => "2026-10-01T00:00:00.000Z" });
  const counts = {};
  const countingStore = Object.fromEntries(
    Object.entries(memoryStore).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args) => {
            counts[name] = (counts[name] ?? 0) + 1;
            return value.apply(memoryStore, args);
          }
        : value,
    ])
  );
  const agentRunService = createAgentRunService({ agentRunStore: countingStore });
  const response = await runWithRequestDeadline({ deadlineAt: Date.now() + 60_000 }, () =>
    runOneAgent({
      agentRunService,
      ragService: createRagService({
        chat: async () => ({ abstained: false, citations: [CITATION], resolvedQuery: QUESTION, text: ANSWER_TEXT }),
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.agentRunStatus, AGENT_RUN_STATUSES.completed);
  // The same counts test/agent-run-chat-statement-count.test.mjs pins.
  assert.deepEqual(counts, { appendEvent: 2, createWithEvent: 1, updateWithEvent: 3 });
});

const startMonolith = async (t, { env = {}, ragService } = {}) => {
  withEnv(t, {
    AGENT_CANCEL_ON_DISCONNECT: undefined,
    AGENT_REQUEST_TIMEOUT_MS: undefined,
    AGENT_SERVICE_URL: undefined,
    ARCHIVE_RAG_ROLE: undefined,
    MODEL_GATEWAY_URL: undefined,
    RETRIEVAL_SERVICE_URL: undefined,
    ...env,
  });

  const { agentRunService } = createRunService();
  const app = await createProductionApp({
    agentRunRecoveryService: { recoverOnStartup: async () => ({ mode: "manual", recoveredCount: 0, runs: [] }) },
    agentRunService,
    chatMcp: async () => ({ text: "web" }),
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService: okHealthService,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService: ragService ?? createRagService(),
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
    body: JSON.stringify({ docId: "doc-1", question: QUESTION }),
    headers: { "content-type": "application/json" },
    method: "POST",
    ...init,
  });

const parseEvents = (text) =>
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

const listRuns = async (agentRunService) => (await agentRunService.listRuns({ accessScope: {} })).runs;

test("with AGENT_REQUEST_TIMEOUT_MS /chat answers 504 when the run passes its deadline, and /chat/stream ends with an error event", { timeout: 20_000 }, async (t) => {
  const model = installSlowModel(t);
  const { agentRunService, baseUrl } = await startMonolith(t, { env: { AGENT_REQUEST_TIMEOUT_MS: "250" } });

  const response = await postChat(baseUrl);
  const body = await response.json();

  assert.equal(response.status, 504);
  assert.equal(body.code, "AGENT_DEADLINE_EXCEEDED");
  assert.equal(body.reason, "deadline_exceeded");
  assert.equal(body.retryable, true);
  assert.equal(model.calls[0].aborted, true, "the in-flight model call was aborted");

  const [run] = await listRuns(agentRunService);

  assert.equal(run.runId, body.agentRunId);
  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.equal(run.error.reason, "deadline_exceeded");

  model.reset();

  const stream = await postChat(baseUrl, "/chat/stream");
  const events = parseEvents(await stream.text());

  assert.equal(stream.status, 200);
  assert.deepEqual(events.slice(-2).map(({ event }) => event), ["error", "done"]);
  assert.ok(!events.some(({ event }) => event === "result"));
  assert.equal(events.at(-2).data.code, "AGENT_DEADLINE_EXCEEDED");
  assert.equal(events.at(-2).data.status, 504);
  assert.equal(events.at(-2).data.retryable, true);
});

test("with AGENT_CANCEL_ON_DISCONNECT on a client that leaves /chat/stream cancels its run; off, the run completes", { timeout: 20_000 }, async (t) => {
  const model = installSlowModel(t);

  await t.test("on", async (t) => {
    const { agentRunService, baseUrl } = await startMonolith(t, { env: { AGENT_CANCEL_ON_DISCONNECT: "on" } });
    const client = new AbortController();
    const stream = await postChat(baseUrl, "/chat/stream", { signal: client.signal });

    assert.equal(stream.status, 200);

    const call = await model.arrived;

    client.abort();
    await stream.body?.cancel().catch(() => {});

    const run = await waitFor(
      async () => (await listRuns(agentRunService)).find((listed) => listed.status === AGENT_RUN_STATUSES.canceled),
      { label: "the run to end canceled" }
    );

    assert.equal(call.aborted, true, "the in-flight model call was aborted");
    assert.equal(call.reason.reason, "client_cancelled");
    assert.deepEqual(pickRunError(run.error), {
      code: "AGENT_CLIENT_CANCELLED",
      reason: "client_cancelled",
      retryable: false,
    });
    assert.ok(run.steps.every((step) => step.status !== "running"));
    model.reset();
  });

  await t.test("off (the default)", async (t) => {
    const { agentRunService, baseUrl } = await startMonolith(t);
    const client = new AbortController();
    const stream = await postChat(baseUrl, "/chat/stream", { signal: client.signal });

    assert.equal(stream.status, 200);

    const call = await model.arrived;

    client.abort();
    await stream.body?.cancel().catch(() => {});
    // The client is gone; the model answers anyway and the run completes.
    model.release();

    const run = await waitFor(
      async () => (await listRuns(agentRunService)).find((listed) => listed.status === AGENT_RUN_STATUSES.completed),
      { label: "the run to complete" }
    );

    assert.equal(call.aborted, false);
    assert.equal(call.signal, undefined, "no request signal is bound by default");
    assert.equal(run.error ?? null, null);
    model.reset();
  });
});

const throwing = (error) => async () => {
  throw error;
};

test("a dependency outage is answered 503/504 with a stable code and Retry-After, the run failed retryable, no Web approval offered", { timeout: 20_000 }, async (t) => {
  const cases = [
    {
      body: { causeCode: "SERVICE_UNREACHABLE", code: "AGENT_DEPENDENCY_UNAVAILABLE", dependency: "retrieval" },
      error: new ServiceUnavailableError("The retrieval service is unreachable.", {
        code: "SERVICE_UNREACHABLE",
        service: "retrieval",
      }),
      status: 503,
    },
    {
      body: { causeCode: "SERVICE_TIMEOUT", code: "AGENT_DEPENDENCY_TIMEOUT", dependency: "retrieval" },
      error: new ServiceTimeoutError("The retrieval service did not answer within 60000 ms.", { service: "retrieval" }),
      status: 504,
    },
    {
      body: { causeCode: "CIRCUIT_OPEN", code: "AGENT_DEPENDENCY_UNAVAILABLE", dependency: "model" },
      error: Object.assign(new Error("Circuit open for https://model.internal.example/v1|chat."), {
        code: "CIRCUIT_OPEN",
        status: 503,
      }),
      status: 503,
    },
    {
      body: { causeCode: "57P01", code: "AGENT_DEPENDENCY_UNAVAILABLE", dependency: "database" },
      error: Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }),
      status: 503,
    },
  ];

  for (const { body: expected, error, status } of cases) {
    await t.test(expected.causeCode, async (t) => {
      const { agentRunService, baseUrl } = await startMonolith(t, {
        ragService: createRagService({ chat: throwing(error) }),
      });
      const response = await postChat(baseUrl);
      const text = await response.text();
      const body = JSON.parse(text);

      assert.equal(response.status, status, text);
      assert.equal(response.headers.get("retry-after"), "5");
      assert.equal(body.code, expected.code);
      assert.equal(body.causeCode, expected.causeCode);
      assert.equal(body.dependency, expected.dependency);
      assert.equal(body.retryable, true);
      assert.equal(body.clarification, undefined);
      assert.ok(!text.includes("model.internal.example"), "the cause's message stays inside");

      const [run] = await listRuns(agentRunService);

      assert.equal(run.runId, body.agentRunId);
      assert.equal(run.status, AGENT_RUN_STATUSES.failed);
      assert.deepEqual(pickRunError(run.error), {
        code: expected.code,
        reason: "dependency_unavailable",
        retryable: true,
      });
      assert.equal(run.steps.find((step) => step.id === "document_rag:primary")?.status, "failed");
      assert.ok(!run.steps.some((step) => step.type === "web_search"), "no Web step stands in");

      const stream = await postChat(baseUrl, "/chat/stream");
      const events = parseEvents(await stream.text());
      const errorEvent = events.find(({ event }) => event === "error");

      assert.deepEqual(events.slice(-2).map(({ event }) => event), ["error", "done"]);
      assert.equal(errorEvent.data.code, expected.code);
      assert.equal(errorEvent.data.status, status);
      assert.equal(errorEvent.data.retryable, true);
      assert.equal(errorEvent.data.retryAfterSeconds, 5);
    });
  }
});

test("an ordinary evidence gap keeps its clarification", async (t) => {
  const { baseUrl } = await startMonolith(t, {
    ragService: createRagService({
      chat: async () => ({
        abstainReason: "insufficient_evidence",
        abstained: true,
        citations: [],
        resolvedQuery: QUESTION,
        text: "I could not find this in the selected documents.",
      }),
    }),
  });
  const response = await postChat(baseUrl);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.clarification?.needed, true);
  assert.equal(body.code, undefined);
});

test("an ordinary failure keeps its answer: no outage code for an error that is not one", async (t) => {
  const { baseUrl } = await startMonolith(t, {
    ragService: createRagService({ chat: throwing(Object.assign(new Error("Bad request."), { status: 400 })) }),
  });
  const response = await postChat(baseUrl);
  const body = await response.json();

  assert.notEqual(response.status, 503);
  assert.equal(body.code, undefined);
  assert.equal(response.headers.get("retry-after"), null);
});

test("a guarded v3 graph whose primary document node fails on an outage ends the run with that outage", async (t) => {
  withEnv(t, {
    AGENT_PLANNER_ROLLOUT: "deterministic",
    AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_LONG_MEMORY_ENABLED: "false",
  });

  const { agentRunService } = createRunService();
  let webCalls = 0;
  const ragService = createDocumentLoopRagService({
    onChat: async ({ phase }) => {
      if (phase === "primary") {
        throw new ServiceUnavailableError("The retrieval service is unreachable.", {
          code: "SERVICE_UNREACHABLE",
          service: "retrieval",
        });
      }
    },
  });
  const error = await runAgentRag({
    accessScope: UNIFIED_ACCESS_SCOPE,
    agentRunService,
    docIds: [UNIFIED_DOC_ID],
    question: DOCUMENT_LOOP_QUESTION,
    ragService,
    sessionId: UNIFIED_SESSION_ID,
    unifiedGraphPlannerAdapter: createProposalAdapter(createDocumentLoopProposal),
    userId: UNIFIED_ACCESS_SCOPE.userId,
    webChatService: async () => {
      webCalls += 1;
      return { text: "web" };
    },
  }).then(
    () => assert.fail("the run should not complete"),
    (rejection) => rejection
  );

  assert.ok(error instanceof DependencyOutageError, String(error));
  assert.equal(error.status, 503);
  assert.equal(error.causeCode, "SERVICE_UNREACHABLE");
  assert.equal(webCalls, 0);

  const run = await agentRunService.getRun({ accessScope: UNIFIED_ACCESS_SCOPE, runId: error.agentRunId });

  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.equal(run.error.reason, "dependency_unavailable");
  assert.equal(run.error.retryable, true);
  assert.ok(run.events.some((event) => event.type === "unified_graph_planned" && event.payload.status === "selected"));
  assert.ok(run.steps.some((step) => step.type === "graph_node" && step.status === "failed"));
  assert.ok(run.steps.every((step) => step.status !== "running"));
});

test("a custom-Skill stage whose every Skill failed on an outage ends the run with that outage", async () => {
  const { agentRunService } = createRunService();
  const error = await runAgentRag({
    accessScope,
    agentRunService,
    docIds: ["doc-1"],
    executionPlannerAdapter: deterministicPlannerAdapter,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    question: "Summarize this contract.",
    ragService: createRagService({
      chat: throwing(Object.assign(new Error("Model gateway: the gateway is unavailable."), {
        code: "MODEL_GATEWAY_UNAVAILABLE",
        status: 503,
      })),
    }),
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search must not run.");
    },
  }).then(
    () => assert.fail("the run should not complete"),
    (rejection) => rejection
  );

  assert.ok(error instanceof DependencyOutageError, String(error));
  assert.equal(error.dependency, "model");

  const run = await agentRunService.getRun({ accessScope, runId: error.agentRunId });

  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.deepEqual(
    run.steps.map(({ id, status }) => ({ id, status })),
    [{ id: "custom_skill:summarize_contract", status: "failed" }]
  );
});

test("a deadline that passes inside a guarded custom-Skill graph node settles that node and ends the run", { timeout: 20_000 }, async (t) => {
  withEnv(t, { AGENT_SKILL_GRAPH_ROLLOUT: "guarded" });

  const model = installSlowModel(t);
  const { agentRunService } = createRunService();
  const error = await runWithRequestDeadline({ deadlineAt: Date.now() + 200 }, () =>
    runAgentRag({
      accessScope,
      agentRunService,
      docIds: ["doc-1"],
      executionPlannerAdapter: deterministicPlannerAdapter,
      intentPlannerAdapter: deterministicIntentPlannerAdapter,
      question: "Summarize this contract.",
      ragService: createRagService(),
      sessionId: "session-1",
      userId: "alice",
      webChatService: async () => {
        throw new Error("Web search must not run.");
      },
    })
  ).then(
    () => assert.fail("the run should not complete"),
    (rejection) => rejection
  );

  assert.equal(error.reason, "deadline_exceeded");
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].aborted, true);

  const run = await agentRunService.getRun({ accessScope, runId: error.agentRunId });

  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.equal(run.error.reason, "deadline_exceeded");
  assert.deepEqual(
    run.steps.map(({ id, status }) => ({ id, status })),
    [{ id: "custom_skill:summarize_contract", status: "failed" }]
  );
  // The node ran on the guarded graph: its checkpoint exists, and the run's
  // terminal status keeps startup recovery away from it.
  const loaded = await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId: error.agentRunId });

  assert.ok(loaded?.checkpoint, "a guarded graph checkpoint was written");
  assert.ok(!(await agentRunService.listRecoverableRuns()).runs.some((listed) => listed.runId === error.agentRunId));
});

// The approval endpoint continuing a guarded v3 graph (routes/tasks.js binds
// the request's deadline around it, as /chat does). The gated node is
// task.create, a Capability that writes.
const pauseAtTaskApproval = async (t, { onWrite } = {}) => {
  withEnv(t, {
    AGENT_PLANNER_ROLLOUT: "deterministic",
    AGENT_UNIFIED_GRAPH_CAPABILITIES: "task.create",
    AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_LONG_MEMORY_ENABLED: "false",
  });

  const { agentRunService } = createRunService();
  const ragService = createDocumentLoopRagService({ primary: "supported" });
  const { registry, writes } = await createTaskCapabilityRegistry({ onWrite, ragService });
  const paused = await runAgentRag({
    accessScope: UNIFIED_ACCESS_SCOPE,
    agentRunService,
    capabilityRegistry: registry,
    docIds: [UNIFIED_DOC_ID],
    question: APPROVAL_TASK_QUESTION,
    ragService,
    sessionId: UNIFIED_SESSION_ID,
    unifiedGraphAllowedCapabilityIds: ["task.create"],
    unifiedGraphPlannerAdapter: createProposalAdapter(createApprovalGatedTaskProposal),
    userId: UNIFIED_ACCESS_SCOPE.userId,
  });
  const gate = paused.body.approvalGates[0];
  const runId = paused.body.agentRunId;

  assert.equal((await agentRunService.getRun({ accessScope: UNIFIED_ACCESS_SCOPE, runId })).status, "waiting_for_user");

  const approve = () =>
    createAgentRunStepExecutor({
      agentRunService,
      capabilityRegistry: registry,
      continueExecutionGraphApproval: (args) =>
        continueAgentExecutionGraphApproval({ ...args, agentRunService, capabilityRegistry: registry, ragService }),
    }).applyApprovalAction({
      accessScope: UNIFIED_ACCESS_SCOPE,
      action: "approve",
      gateId: gate.id,
      payload: { approvalObjectHash: gate.approvalObjectHash },
      runId,
    });

  return { agentRunService, approve, runId, writes };
};

test("an approval continuation whose request is already cancelled ends the run with the reason, never for an operator", async (t) => {
  const { agentRunService, approve, runId, writes } = await pauseAtTaskApproval(t);
  const error = await runWithRequestDeadline({ deadlineAt: Date.now() - 1 }, approve).then(
    () => assert.fail("the continuation should stop"),
    (rejection) => rejection
  );

  assert.ok(error instanceof RequestCancelledError, String(error));
  assert.equal(error.reason, "deadline_exceeded");
  assert.equal(error.agentRunId, runId);
  // The approved node never launched: nothing was written.
  assert.equal(writes.length, 0);

  const run = await agentRunService.getRun({ accessScope: UNIFIED_ACCESS_SCOPE, runId });

  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.deepEqual(pickRunError(run.error), {
    code: "AGENT_DEADLINE_EXCEEDED",
    reason: "deadline_exceeded",
    retryable: true,
  });
  assert.ok(
    !run.events.some((event) => event.type === "manual_recovery_required"),
    "not handed to an operator"
  );
  assert.ok(run.steps.every((step) => step.status !== "running"));
  assert.ok(!(await agentRunService.listRecoverableRuns()).runs.some((listed) => listed.runId === runId));
});

test("an approved Capability that writes is never cut by the deadline: it runs once, outside the request's signal", { timeout: 20_000 }, async (t) => {
  const inside = [];
  const { agentRunService, approve, runId, writes } = await pauseAtTaskApproval(t, {
    onWrite: async () => {
      inside.push({ deadline: getRequestDeadline(), signal: getRequestSignal() });
      // Still writing when the request's deadline passes.
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  });
  const deadlineAt = Date.now() + 50;
  const approved = await runWithRequestDeadline({ deadlineAt }, approve);

  assert.ok(Date.now() > deadlineAt, "the write outlived the deadline");
  assert.deepEqual(inside, [{ deadline: null, signal: null }]);
  assert.equal(writes.length, 1);
  // The write was the graph's last node: its step completed and, with no safe
  // point left, the run completed with it rather than reporting a deadline
  // over a write that happened.
  assert.equal(approved.run.status, AGENT_RUN_STATUSES.completed);

  const run = await agentRunService.getRun({ accessScope: UNIFIED_ACCESS_SCOPE, runId });

  assert.equal(run.steps.find((step) => step.type === "graph_node" && /dGFzaw/.test(step.id))?.status, "completed");
  assert.ok(!(await agentRunService.listRecoverableRuns()).runs.some((listed) => listed.runId === runId));
});

test("a research brief whose every question failed on an outage ends the run with that outage, never as missing evidence", async () => {
  const research = async ({ chat }) => {
    const { agentRunService } = createRunService();
    const outcome = await runAgentRag({
      accessScope,
      agentRunService,
      docIds: ["doc-1"],
      executionPlannerAdapter: deterministicPlannerAdapter,
      intentPlannerAdapter: deterministicIntentPlannerAdapter,
      question: "Write a research brief on the key risks in this policy.",
      ragService: createRagService({ chat }),
      sessionId: "session-1",
      userId: "alice",
      webChatService: async () => {
        throw new Error("Web search must not run.");
      },
    }).catch((error) => error);

    return { agentRunService, outcome };
  };
  const retrievalDown = () =>
    new ServiceUnavailableError("The retrieval service is unreachable.", {
      code: "SERVICE_UNREACHABLE",
      service: "retrieval",
    });

  const { agentRunService, outcome: error } = await research({ chat: throwing(retrievalDown()) });

  assert.ok(error instanceof DependencyOutageError, String(error?.body?.agentAnswer ?? error));
  assert.equal(error.status, 503);
  assert.equal(error.dependency, "retrieval");
  assert.equal(error.causeCode, "SERVICE_UNREACHABLE");

  const run = await agentRunService.getRun({ accessScope, runId: error.agentRunId });

  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.equal(run.error.reason, "dependency_unavailable");
  assert.equal(run.error.retryable, true);
  assert.ok(run.steps.length > 0);
  assert.ok(run.steps.every((step) => step.type === "research_question" && step.status === "failed"));

  // One question answered: the brief keeps what it found, as before.
  let calls = 0;
  const { outcome: partial } = await research({
    chat: async (docIds, question) => {
      calls += 1;

      if (calls > 1) {
        throw retrievalDown();
      }

      return { abstained: false, citations: [CITATION], resolvedQuery: question, text: ANSWER_TEXT };
    },
  });

  assert.ok(calls > 1, "the plan has more than one question");
  assert.equal(partial.status, 200);
  assert.equal(partial.body.agentMode, "research_brief");
});
