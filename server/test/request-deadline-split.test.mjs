import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp as createProductionApp } from "../app.js";
import { createAgentApp } from "../rag/agent-service/app.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { resetModelGatewayClient } from "../rag/model-gateway/client.js";
import { completeText, resetOpenAIProvider } from "../rag/openai.js";
import { retrieveGlobalContextRemotely } from "../rag/retrieval-service/remote-retrieval.js";
import { encodeWireValue } from "../rag/retrieval-service/wire.js";
import { resetServiceClients } from "../rag/service-client.js";

// A split deployment in one process with a short edge timeout:
//
//   client -> edge (ARCHIVE_RAG_ROLE=api) -> agent tier -> retrieval tier
//                                                      \-> model gateway
//
// The edge and the agent tier are the production apps. The retrieval tier
// and the model gateway are local stand-ins that record the deadline header
// each call carries and whether the caller dropped the connection; they never
// answer, or answer what the case needs. The agent's document answer goes
// through the real outbound clients (remote-retrieval.js, then openai.js
// through the gateway client), so whatever reaches the stand-ins is what the
// production code sends.
//
// AGENT_SERVICE_TIMEOUT_MS is 1000 ms (its minimum): the edge gives up after
// it, and the agent tier, which received the same budget as its deadline,
// stops the run at the same time and aborts the call in flight.

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const SECRET = `${"s".repeat(24)}-split-deadline-0123456789`;
const EDGE_TIMEOUT_MS = 1000;
const QUESTION = "How many paid annual leave days do employees receive?";
const CITATION = {
  docId: "doc-1",
  excerpt: "Employees receive twelve paid annual leave days each year.",
  fileName: "handbook.pdf",
  pageNumber: 1,
  sourceLabel: "Source 1",
  text: "Employees receive twelve paid annual leave days each year.",
};

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

const waitFor = async (check, { label = "condition", timeoutMs = 8_000 } = {}) => {
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

const listen = async (t, handler) => {
  const open = new Set();
  const server = createServer((req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    handler(req, res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const res of open) res.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return `http://127.0.0.1:${server.address().port}`;
};

// A stand-in tier: `answer(entry, res)` decides; without one it never
// answers. Every request is recorded with its deadline header and when the
// caller dropped it.
const startStandIn = async (t, answer = null) => {
  const requests = [];
  const url = await listen(t, (req, res) => {
    const closed = createDeferred();
    const entry = {
      closed: closed.promise,
      closedAt: null,
      deadlineMs: Number(req.headers["x-archive-service-deadline-ms"]),
      path: req.url,
      receivedAt: Date.now(),
    };

    requests.push(entry);
    res.on("close", () => {
      entry.closedAt = Date.now();
      closed.resolve();
    });
    req.resume();
    req.on("end", () => answer?.(entry, res));
  });

  return { requests, url };
};

const answerRetrievalWithNoResults = (entry, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(encodeWireValue({ results: [], retrieval: null })));
};

// The agent's document answer: one remote retrieval, then one model call
// through the gateway, both with the production clients.
const createAgentRagService = () => ({
  chat: async (docIds, question, { accessScope } = {}) => {
    await retrieveGlobalContextRemotely({
      accessScope,
      docIds,
      retrievalQueries: [{ id: "primary", primary: true, query: question }],
    });

    return {
      abstained: false,
      citations: [CITATION],
      memoryApplied: false,
      resolvedQuery: question,
      text: await completeText(`Answer from the evidence: ${question}`),
    };
  },
  clearDocuments: async () => [],
  clearSessionMemory: () => true,
  deleteDocument: async () => null,
  getDocument: (docId) => (docId === "doc-1" ? { docId: "doc-1", fileName: "handbook.pdf" } : null),
  ingestDocument: async () => null,
  initializeDocumentRegistry: async () => [],
  initializeSessionMemory: async () => true,
  listDocuments: () => [{ docId: "doc-1", fileName: "handbook.pdf" }],
});

const baseOptions = (overrides = {}) => ({
  agentRunRecoveryService: { recoverOnStartup: async () => ({ mode: "manual", recoveredCount: 0, runs: [] }) },
  chatMcp: async () => ({ text: "web" }),
  executionPlannerAdapter: deterministicPlannerAdapter,
  healthService: okHealthService,
  intentPlannerAdapter: deterministicIntentPlannerAdapter,
  ...overrides,
});

const startSplitDeployment = async (t, { gateway, retrieval }) => {
  withEnv(t, {
    AGENT_CANCEL_ON_DISCONNECT: undefined,
    AGENT_REQUEST_TIMEOUT_MS: undefined,
    AGENT_SERVICE_TIMEOUT_MS: String(EDGE_TIMEOUT_MS),
    AGENT_SERVICE_URL: undefined,
    ARCHIVE_RAG_ROLE: undefined,
    INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
    MODEL_GATEWAY_TIMEOUT_MS: undefined,
    MODEL_GATEWAY_URL: gateway.url,
    OPENAI_API_KEY: "test-key",
    RETRIEVAL_SERVICE_TIMEOUT_MS: undefined,
    RETRIEVAL_SERVICE_URL: retrieval.url,
  });
  resetOpenAIProvider();
  resetModelGatewayClient();
  resetServiceClients();
  t.after(() => {
    resetOpenAIProvider();
    resetModelGatewayClient();
    resetServiceClients();
  });

  const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });

  process.env.ARCHIVE_RAG_ROLE = "agent";
  const agentApp = await createAgentApp(
    baseOptions({ agentRunService, ragService: createAgentRagService() })
  );
  const agentUrl = await listen(t, agentApp);

  process.env.ARCHIVE_RAG_ROLE = "api";
  process.env.AGENT_SERVICE_URL = agentUrl;
  resetServiceClients();
  const edgeApp = await createProductionApp(baseOptions({ ragService: createAgentRagService() }));
  const edgeUrl = await listen(t, edgeApp);

  // The agent tier's own outbound calls are issued as the agent.
  process.env.ARCHIVE_RAG_ROLE = "agent";

  return { agentRunService, edgeUrl };
};

const postChat = (edgeUrl, path = "/chat") =>
  fetch(`${edgeUrl}${path}`, {
    body: JSON.stringify({ docId: "doc-1", question: QUESTION }),
    headers: { "content-type": "application/json" },
    method: "POST",
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

const waitForTerminalRun = (agentRunService) =>
  waitFor(
    async () =>
      (await agentRunService.listRuns({ accessScope: {} })).runs.find(
        (run) => ![AGENT_RUN_STATUSES.running, AGENT_RUN_STATUSES.waitingForUser].includes(run.status)
      ),
    { label: "the agent run to end" }
  );

const assertDeadlineRun = (run) => {
  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.equal(run.error.code, "AGENT_DEADLINE_EXCEEDED");
  assert.equal(run.error.reason, "deadline_exceeded");
  assert.equal(run.error.retryable, true);
  assert.ok(run.steps.every((step) => step.status !== "running"));
};

test("the edge's timeout reaches the retrieval tier as a shrunken deadline, and the call is aborted when it passes", { timeout: 20_000 }, async (t) => {
  const retrieval = await startStandIn(t);
  const gateway = await startStandIn(t);
  const { agentRunService, edgeUrl } = await startSplitDeployment(t, { gateway, retrieval });
  const startedAt = Date.now();
  const response = await postChat(edgeUrl);
  const body = await response.json();

  assert.equal(response.status, 504, JSON.stringify(body));
  assert.ok(["SERVICE_TIMEOUT", "AGENT_DEADLINE_EXCEEDED"].includes(body.code), body.code);

  const [call] = retrieval.requests;

  assert.ok(call.deadlineMs > 0 && call.deadlineMs <= EDGE_TIMEOUT_MS, `deadline header ${call.deadlineMs}`);
  await call.closed;
  assert.ok(call.closedAt - startedAt < EDGE_TIMEOUT_MS + 2_000, "aborted at the deadline, not after 60 s");
  assert.equal(gateway.requests.length, 0, "the model was never called");
  assertDeadlineRun(await waitForTerminalRun(agentRunService));
});

test("a model call through the gateway gets what is left of the edge's deadline and is aborted with the run", { timeout: 20_000 }, async (t) => {
  const retrieval = await startStandIn(t, answerRetrievalWithNoResults);
  const gateway = await startStandIn(t);
  const { agentRunService, edgeUrl } = await startSplitDeployment(t, { gateway, retrieval });
  const startedAt = Date.now();
  const response = await postChat(edgeUrl);

  assert.equal(response.status, 504);

  const [retrievalCall] = retrieval.requests;
  const [modelCall] = await waitFor(() => (gateway.requests.length > 0 ? gateway.requests : null), {
    label: "the gateway call",
  });

  assert.ok(retrievalCall.deadlineMs <= EDGE_TIMEOUT_MS);
  // Later in the run, so less is left than the retrieval call was given --
  // and far less than MODEL_GATEWAY_TIMEOUT_MS (10 minutes).
  assert.ok(modelCall.deadlineMs > 0 && modelCall.deadlineMs <= retrievalCall.deadlineMs, `${modelCall.deadlineMs}`);
  await modelCall.closed;
  assert.ok(modelCall.closedAt - startedAt < EDGE_TIMEOUT_MS + 2_000);
  assertDeadlineRun(await waitForTerminalRun(agentRunService));
});

test("a stream that runs out of time ends with an error event and done, and its run ends with the deadline", { timeout: 20_000 }, async (t) => {
  const retrieval = await startStandIn(t);
  const gateway = await startStandIn(t);
  const { agentRunService, edgeUrl } = await startSplitDeployment(t, { gateway, retrieval });
  const stream = await postChat(edgeUrl, "/chat/stream");
  const events = parseEvents(await stream.text());

  assert.equal(stream.status, 200);
  assert.deepEqual(events.slice(-2).map(({ event }) => event), ["error", "done"]);
  assert.ok(!events.some(({ event }) => event === "result"));
  assert.ok(["SERVICE_TIMEOUT", "AGENT_DEADLINE_EXCEEDED"].includes(events.at(-2).data.code));
  assert.equal(events.at(-2).data.status, 504);
  await retrieval.requests[0].closed;
  assertDeadlineRun(await waitForTerminalRun(agentRunService));
});

test("a dependency outage behind the agent tier is a 503 with Retry-After at the edge, for /chat and /chat/stream", { timeout: 20_000 }, async (t) => {
  // The retrieval tier's own dependency (the gateway) is down: it answers 424
  // with the dependency's status, as rag/retrieval-service/app.js does.
  const retrieval = await startStandIn(t, (entry, res) => {
    res.writeHead(424, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        code: "MODEL_GATEWAY_UNAVAILABLE",
        dependencyStatus: 503,
        error: "A dependency of the retrieval service is unavailable.",
      })
    );
  });
  const gateway = await startStandIn(t);
  const { agentRunService, edgeUrl } = await startSplitDeployment(t, { gateway, retrieval });
  const response = await postChat(edgeUrl);
  const body = await response.json();

  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(body.code, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(body.dependency, "retrieval");
  assert.equal(body.causeCode, "MODEL_GATEWAY_UNAVAILABLE");
  assert.equal(body.retryable, true);
  assert.equal(body.clarification, undefined);

  const run = await waitForTerminalRun(agentRunService);

  assert.equal(run.runId, body.agentRunId);
  assert.equal(run.status, AGENT_RUN_STATUSES.failed);
  assert.equal(run.error.reason, "dependency_unavailable");
  assert.equal(run.error.retryable, true);

  const stream = await postChat(edgeUrl, "/chat/stream");
  const events = parseEvents(await stream.text());

  assert.deepEqual(events.slice(-2).map(({ event }) => event), ["error", "done"]);
  assert.equal(events.at(-2).data.code, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(events.at(-2).data.status, 503);
  assert.equal(events.at(-2).data.retryAfterSeconds, 5);
  assert.equal(gateway.requests.length, 0);
});
