import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";

import express from "express";

import { createApp as createProductionApp } from "../app.js";
import { createAgentApp as createProductionAgentApp } from "../rag/agent-service/app.js";
import {
  ADMIN_PERMISSION_CLAIM,
  AGENT_EDGE_ERROR_CODES,
  AGENT_SERVICE_PING_PATH,
} from "../rag/agent-service/contract.js";
import { AGENT_EDGE_ROUTES, createAgentEdgeRouter } from "../rag/agent-service/edge-router.js";
import { ADMIN_ROLE_IDS } from "../rag/admin-permissions.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { AGENT_RUN_STATUSES } from "../rag/agent-runs.js";
import { resetServiceClients, SERVICE_CLIENT_ERROR_CODES } from "../rag/service-client.js";
import {
  SERVICE_DEADLINE_HEADER,
  SERVICE_IDENTITY_ERROR_CODES,
  SERVICE_REQUEST_ID_HEADER,
  SERVICE_TOKEN_HEADER,
  signServiceToken,
} from "../rag/service-identity.js";
import { createChatRouter } from "../routes/chat.js";
import { createTasksRouter } from "../routes/tasks.js";

// A split deployment in one process: the public edge (createApp with
// ARCHIVE_RAG_ROLE=api and AGENT_SERVICE_URL) in front of the agent tier
// (createAgentApp), both on port 0 over the same stubbed services the app
// tests use, compared with the monolith (createApp with no role).

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const SERVICE_KEYS = `roles-test:${"r".repeat(48)}`;
process.env.INTERNAL_SERVICE_KEYS = SERVICE_KEYS;

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const CITED_ANSWER = {
  citations: [
    {
      docId: "doc-1",
      fileName: "notes.pdf",
      pageNumber: 1,
      sourceLabel: "Source 1",
      text: "The allocation amount is 5 units.",
    },
  ],
  text: "The allocation amount is 5 units [Source 1].",
};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const createStubRagService = ({ chat, chatCalls = [], scopes = [] } = {}) => {
  const documents = new Map([["doc-1", { docId: "doc-1", fileName: "notes.pdf" }]]);

  return {
    chat: async (docIds, question, options = {}) => {
      chatCalls.push({ docIds, options, question });

      return chat ? chat(docIds, question, options) : CITED_ANSWER;
    },
    clearDocuments: async () => [],
    clearSessionMemory: () => true,
    deleteDocument: async () => null,
    getDocument: (docId, accessScope) => {
      scopes.push(accessScope);

      return documents.get(docId) ?? null;
    },
    ingestDocument: async () => null,
    initializeDocumentRegistry: async () => [],
    initializeSessionMemory: async () => true,
    listDocuments: () => [...documents.values()],
  };
};

const baseOptions = (overrides = {}) => ({
  chatMcp: async () => ({ text: "web" }),
  executionPlannerAdapter: deterministicPlannerAdapter,
  healthService: okHealthService,
  intentPlannerAdapter: deterministicIntentPlannerAdapter,
  ...overrides,
});

const withEnvironment = async (overrides, work) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

// A port nothing listens on.
const findClosedPort = async () => {
  const server = createServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  return port;
};

const createMonolith = (options) =>
  withEnvironment({ AGENT_SERVICE_URL: undefined, ARCHIVE_RAG_ROLE: undefined }, () =>
    createProductionApp(baseOptions(options))
  );

// The edge is built while the environment names the agent tier; its service
// client is fixed then, and the signing key stays in process.env throughout.
const createEdge = (agentUrl, options) =>
  withEnvironment({ AGENT_SERVICE_URL: agentUrl, ARCHIVE_RAG_ROLE: "api" }, () => {
    resetServiceClients();

    return createProductionApp(baseOptions(options));
  });

/**
 * The agent tier behind a recorder that keeps, for every request it receives,
 * the headers as they arrived and whether its response finished or was cut.
 */
const startAgentTier = async (options) => {
  const agentApp = await withEnvironment({ ARCHIVE_RAG_ROLE: "agent" }, () =>
    createProductionAgentApp(baseOptions(options))
  );
  const requests = [];
  const outer = express();

  outer.use((req, res, next) => {
    const record = { closed: false, finished: null, headers: { ...req.headers }, method: req.method, path: req.path };

    requests.push(record);
    res.on("close", () => {
      record.closed = true;
      record.finished = res.writableFinished;
    });
    next();
  });
  outer.use(agentApp);

  const server = await startServer(outer);

  return { ...server, app: agentApp, requests };
};

const startSplitDeployment = async ({ agentOptions = {}, edgeOptions = {} } = {}) => {
  const agent = await startAgentTier(agentOptions);
  const edgeApp = await createEdge(agent.baseUrl, edgeOptions);
  const edge = await startServer(edgeApp);

  return {
    agent,
    close: async () => {
      await edge.close();
      await agent.close();
    },
    edge: { ...edge, app: edgeApp },
  };
};

const postJson = (url, body, headers = {}) =>
  fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

const VOLATILE_KEY = /(?:At|DurationMs|durationMs)$/u;

// Run ids, timestamps, and measured durations differ between any two runs.
const normalizeAnswer = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalizeAnswer);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        VOLATILE_KEY.test(key) || key === "agentRunId" || key === "runId"
          ? "<volatile>"
          : normalizeAnswer(entry),
      ])
    );
  }

  return value;
};

const parseEvents = (text) =>
  text
    .split("\n\n")
    .filter((block) => block.trim() && !block.startsWith(":"))
    .map((block) => {
      const lines = block.split("\n");
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");

      return {
        data: data ? JSON.parse(data) : null,
        event: lines.find((line) => line.startsWith("event: "))?.slice("event: ".length),
      };
    });

const readUntil = async (reader, predicate) => {
  const decoder = new TextDecoder();
  let text = "";

  while (!predicate(text)) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    text += decoder.decode(value, { stream: true });
  }

  return text;
};

const waitFor = async (check, { timeoutMs = 5000, label = "condition" } = {}) => {
  const startedAt = Date.now();

  while (!(await check())) {
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(`Timed out waiting for ${label}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const signAgentToken = (overrides = {}) =>
  signServiceToken({
    accessScope: { authenticated: false, userId: "", workspaceId: "" },
    audience: "agent",
    issuer: "api",
    ...overrides,
  });

test("the edge answers /chat through the agent tier exactly as the monolith does", async () => {
  const monolith = await startServer(await createMonolith({ ragService: createStubRagService() }));
  const split = await startSplitDeployment({
    agentOptions: { ragService: createStubRagService() },
    edgeOptions: { ragService: createStubRagService() },
  });

  try {
    const question = { docId: "doc-1", question: "What is the allocation amount?" };
    const [expected, actual] = await Promise.all([
      postJson(`${monolith.baseUrl}/chat`, question),
      postJson(`${split.edge.baseUrl}/chat`, question),
    ]);

    assert.equal(actual.status, expected.status);
    assert.equal(actual.status, 200);
    assert.equal(actual.headers.get("content-type"), expected.headers.get("content-type"));

    const expectedBody = await expected.json();
    const actualBody = await actual.json();

    assert.deepEqual(normalizeAnswer(actualBody), normalizeAnswer(expectedBody));
    assert.match(actualBody.agentAnswer ?? actualBody.ragAnswer, /allocation amount is 5/u);

    // GET /chat carries its question in the query string.
    const query = "docId=doc-1&question=What%20is%20the%20allocation%20amount%3F";
    const [expectedGet, actualGet] = await Promise.all([
      fetch(`${monolith.baseUrl}/chat?${query}`),
      fetch(`${split.edge.baseUrl}/chat?${query}`),
    ]);

    assert.equal(actualGet.status, expectedGet.status);
    assert.deepEqual(normalizeAnswer(await actualGet.json()), normalizeAnswer(await expectedGet.json()));

    // A request the edge refuses never reaches the agent tier.
    const forwardedBefore = split.agent.requests.length;
    const [expectedInvalid, actualInvalid] = await Promise.all([
      postJson(`${monolith.baseUrl}/chat`, { docId: "doc-1" }),
      postJson(`${split.edge.baseUrl}/chat`, { docId: "doc-1" }),
    ]);

    assert.equal(actualInvalid.status, 400);
    assert.equal(actualInvalid.status, expectedInvalid.status);
    assert.deepEqual(await actualInvalid.json(), await expectedInvalid.json());
    assert.equal(split.agent.requests.length, forwardedBefore);

    // A missing document is the agent's 404, passed through unchanged.
    const [expectedMissing, actualMissing] = await Promise.all([
      postJson(`${monolith.baseUrl}/chat`, { docId: "doc-9", question: "Anything?" }),
      postJson(`${split.edge.baseUrl}/chat`, { docId: "doc-9", question: "Anything?" }),
    ]);

    assert.equal(actualMissing.status, 404);
    assert.deepEqual(await actualMissing.json(), await expectedMissing.json());
  } finally {
    await split.close();
    await monolith.close();
  }
});

test("the edge relays /chat/stream event by event, ending with the /chat result", async () => {
  const monolith = await startServer(await createMonolith({ ragService: createStubRagService() }));
  const split = await startSplitDeployment({
    agentOptions: { ragService: createStubRagService() },
    edgeOptions: { ragService: createStubRagService() },
  });

  try {
    const question = { docId: "doc-1", question: "What is the allocation amount?" };
    const [expected, actual, plain] = await Promise.all([
      postJson(`${monolith.baseUrl}/chat/stream`, question),
      postJson(`${split.edge.baseUrl}/chat/stream`, question),
      postJson(`${monolith.baseUrl}/chat`, question),
    ]);

    assert.equal(actual.status, 200);
    assert.equal(actual.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(actual.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(actual.headers.get("x-accel-buffering"), "no");

    const expectedEvents = parseEvents(await expected.text());
    const actualEvents = parseEvents(await actual.text());

    assert.deepEqual(
      actualEvents.map(({ event }) => event),
      expectedEvents.map(({ event }) => event)
    );
    assert.deepEqual(normalizeAnswer(actualEvents), normalizeAnswer(expectedEvents));
    assert.ok(actualEvents.some(({ event }) => event === "trace_step"));
    assert.deepEqual(actualEvents.at(-1), { data: {}, event: "done" });

    const result = actualEvents.find(({ event }) => event === "result");

    assert.equal(result.data.status, plain.status);
    assert.deepEqual(normalizeAnswer(result.data.body), normalizeAnswer(await plain.json()));
  } finally {
    await split.close();
    await monolith.close();
  }
});

test("a client leaving /chat/stream aborts the upstream request while the run still finishes", async () => {
  const release = createDeferred();
  const chatStarted = createDeferred();
  const split = await startSplitDeployment({
    agentOptions: {
      ragService: createStubRagService({
        chat: async () => {
          chatStarted.resolve();
          await release.promise;

          return CITED_ANSWER;
        },
      }),
    },
    edgeOptions: { ragService: createStubRagService() },
  });

  try {
    const controller = new AbortController();
    const response = await postJson(
      `${split.edge.baseUrl}/chat/stream`,
      { docId: "doc-1", question: "What is the allocation amount?" },
      {}
    );
    // A second request with an abortable signal; the first proves the route
    // works when the client stays.
    const abortable = await fetch(`${split.edge.baseUrl}/chat/stream`, {
      body: JSON.stringify({ docId: "doc-1", question: "What is the allocation amount?" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    const reader = abortable.body.getReader();
    const seen = await readUntil(reader, (text) => text.includes("event: trace_step"));

    assert.match(seen, /event: trace_step/u);
    await chatStarted.promise;

    const upstream = () =>
      split.agent.requests.filter((record) => record.path === "/chat/stream");

    await waitFor(() => upstream().length === 2, { label: "both streams upstream" });
    controller.abort();

    // The edge aborted its upstream request: one agent-side response closed
    // before it finished, while the run is still waiting on the model.
    await waitFor(
      () => upstream().some((record) => record.closed && record.finished === false),
      { label: "the upstream stream to be cut" }
    );

    release.resolve();

    // The client that stayed gets the whole answer.
    const events = parseEvents(await response.text());

    assert.equal(events.at(-1).event, "done");
    assert.equal(events.find(({ event }) => event === "result").data.status, 200);

    // The abandoned run finished anyway, as it does in the monolith.
    const { agentRunService } = split.agent.app.locals.services;

    await waitFor(
      async () => {
        const { runs = [] } = await agentRunService.listRuns({
          accessScope: { authenticated: false, userId: "", workspaceId: "" },
        });

        return (
          runs.length === 2 &&
          runs.every((run) => run.status === AGENT_RUN_STATUSES.completed)
        );
      },
      { label: "both runs to complete" }
    );
  } finally {
    release.resolve();
    await split.close();
  }
});

test("an agent tier that stops mid-stream ends the client's stream with error and done", async () => {
  const fakeAgent = createServer((req, res) => {
    req.resume();
    res.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
    });
    res.write('event: trace_step\ndata: {"step":{"id":"1-plan"},"type":"trace_step"}\n\n');
    // Half an event, then the connection drops.
    res.write('event: trace_step\ndata: {"step":{"id":"2-qu');
    setTimeout(() => res.socket.destroy(), 30);
  });

  await new Promise((resolve) => fakeAgent.listen(0, "127.0.0.1", resolve));

  const edge = await startServer(
    await createEdge(`http://127.0.0.1:${fakeAgent.address().port}`, {
      ragService: createStubRagService(),
    })
  );

  try {
    const response = await postJson(`${edge.baseUrl}/chat/stream`, {
      docId: "doc-1",
      question: "What is the allocation amount?",
    });

    assert.equal(response.status, 200);

    const events = parseEvents(await response.text());

    assert.deepEqual(
      events.map(({ event }) => event),
      ["trace_step", "error", "done"]
    );
    assert.equal(events[1].data.code, AGENT_EDGE_ERROR_CODES.streamInterrupted);
    assert.equal(events[1].data.status, 502);
  } finally {
    await edge.close();
    fakeAgent.closeAllConnections();
    await new Promise((resolve) => fakeAgent.close(resolve));
  }
});

// Two fake agent replicas that record what reaches them.
const startFakeAgentReplicas = async (answer) => {
  const replicas = await Promise.all(
    ["a", "b"].map(async (name) => {
      const seen = [];
      const server = createServer((req, res) => {
        req.resume();
        seen.push(`${req.method} ${req.url.split("?")[0]}`);
        const { body, status } = answer(name, req);

        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

      return {
        close: () =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
        seen,
        url: `http://127.0.0.1:${server.address().port}`,
      };
    })
  );

  return { a: replicas[0], b: replicas[1], close: () => Promise.all(replicas.map((r) => r.close())) };
};

test("GET /chat runs the agent, so the edge never sends it to a second replica", async () => {
  const replicas = await startFakeAgentReplicas((name, req) =>
    req.url.startsWith("/chat") || name === "a"
      ? { body: { error: "The model circuit is open." }, status: 503 }
      : { body: { tasks: [] }, status: 200 }
  );
  const edge = await startServer(
    await createEdge(`${replicas.a.url},${replicas.b.url}`, { ragService: createStubRagService() })
  );

  try {
    // A read still fails over: the first replica's 503 goes to the second.
    const tasks = await fetch(`${edge.baseUrl}/tasks`);

    assert.equal(tasks.status, 200);
    assert.deepEqual([...replicas.a.seen, ...replicas.b.seen], ["GET /tasks", "GET /tasks"]);

    // GET /chat writes a run and memory: one replica answers it, once.
    const chat = await fetch(`${edge.baseUrl}/chat?docId=doc-1&question=Anything`);

    assert.equal(chat.status, 503);
    assert.deepEqual(await chat.json(), { error: "The model circuit is open." });
    assert.equal(
      [...replicas.a.seen, ...replicas.b.seen].filter((line) => line === "GET /chat").length,
      1
    );
  } finally {
    await edge.close();
    await replicas.close();
  }
});

test("a question with a raw backslash in the query reaches the agent as the monolith reads it", async () => {
  const monolith = await startServer(await createMonolith({ ragService: createStubRagService() }));
  const split = await startSplitDeployment({
    agentOptions: { ragService: createStubRagService() },
    edgeOptions: { ragService: createStubRagService() },
  });
  // http.request sends the target exactly as written, raw backslash included.
  const rawGet = (baseUrl, target) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(`${baseUrl}${target}`, (response) => {
        let text = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ body: JSON.parse(text), status: response.statusCode }));
      });

      request.on("error", reject);
      request.end();
    });

  try {
    const target = "/chat?docId=doc-1&question=What+is+the+allocation+amount+in+C:\\notes?";
    const [expected, actual] = await Promise.all([
      rawGet(monolith.baseUrl, target),
      rawGet(split.edge.baseUrl, target),
    ]);

    assert.equal(expected.status, 200);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(normalizeAnswer(actual.body), normalizeAnswer(expected.body));
  } finally {
    await split.close();
    await monolith.close();
  }
});

test("a slow client that leaves /chat/stream mid-relay releases the upstream stream", async () => {
  // The upstream always has another event ready, as a busy agent does; the
  // public client stops reading so the edge's writes back up, then leaves.
  const event = `event: trace_step\ndata: ${JSON.stringify({ pad: "x".repeat(64 * 1024) })}\n\n`;
  const cancelled = createDeferred();
  let pulls = 0;
  const client = {
    stream: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled.resolve("cancelled");
          },
          pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode(event));
          },
        }),
        { headers: { "content-type": "text/event-stream; charset=utf-8" }, status: 200 }
      ),
  };
  const edgeApp = express();

  edgeApp.use(express.json());
  edgeApp.use((req, res, next) => {
    req.accessScope = { authenticated: false, userId: "", workspaceId: "" };
    next();
  });
  edgeApp.use(createAgentEdgeRouter({ client, logger: { error() {}, log() {}, warn() {} } }).router);

  const edge = await startServer(edgeApp);

  try {
    const request = httpRequest(`${edge.baseUrl}/chat/stream`, {
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const response = await new Promise((resolve, reject) => {
      request.on("response", resolve);
      request.on("error", reject);
      request.end(JSON.stringify({ docId: "doc-1", question: "What is the allocation amount?" }));
    });

    response.pause();
    request.on("error", () => {});

    // Back-pressure: the relay stops pulling once the socket is full.
    let previous = -1;

    await waitFor(
      async () => {
        const settled = pulls > 1 && pulls === previous;
        previous = pulls;
        await new Promise((resolve) => setTimeout(resolve, 100));

        return settled;
      },
      { label: "the relay to wait for a drain" }
    );

    request.destroy();

    const outcome = await Promise.race([
      cancelled.promise,
      new Promise((resolve) => setTimeout(() => resolve("still relaying"), 3000)),
    ]);

    assert.equal(outcome, "cancelled");
  } finally {
    await edge.close();
  }
});

test("an unreachable agent tier answers 503 with a stable code while documents keep working", async () => {
  const closedPort = await findClosedPort();
  const edge = await startServer(
    await createEdge(`http://127.0.0.1:${closedPort}`, { ragService: createStubRagService() })
  );

  try {
    const chat = await postJson(`${edge.baseUrl}/chat`, {
      docId: "doc-1",
      question: "What is the allocation amount?",
    });

    assert.equal(chat.status, 503);
    assert.deepEqual(await chat.json(), {
      code: SERVICE_CLIENT_ERROR_CODES.unreachable,
      error: "The agent service is unreachable.",
      service: "agent",
    });

    const stream = await postJson(`${edge.baseUrl}/chat/stream`, {
      docId: "doc-1",
      question: "What is the allocation amount?",
    });

    assert.equal(stream.status, 503);
    assert.equal((await stream.json()).code, SERVICE_CLIENT_ERROR_CODES.unreachable);

    const tasks = await fetch(`${edge.baseUrl}/tasks`);

    assert.equal(tasks.status, 503);

    const documents = await fetch(`${edge.baseUrl}/documents`);

    assert.equal(documents.status, 200);
    assert.deepEqual(await documents.json(), [{ docId: "doc-1", fileName: "notes.pdf" }]);
  } finally {
    await edge.close();
  }
});

test("forged internal headers from a public client never reach the agent tier", async () => {
  const scopes = [];
  const chatCalls = [];

  await withEnvironment(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: "",
      API_AUTH_TOKENS: JSON.stringify({
        "token-a": { userId: "alice", workspaceId: "ws-a" },
      }),
    },
    async () => {
      const split = await startSplitDeployment({
        agentOptions: { ragService: createStubRagService({ chatCalls, scopes }) },
        edgeOptions: { ragService: createStubRagService() },
      });

      try {
        const forged = signAgentToken({
          accessScope: { authenticated: true, userId: "mallory", workspaceId: "ws-b" },
        });

        // Without a public credential the forged internal token is worthless.
        const anonymous = await postJson(
          `${split.edge.baseUrl}/chat`,
          { docId: "doc-1", question: "What is the allocation amount?" },
          { [SERVICE_TOKEN_HEADER]: forged }
        );

        assert.equal(anonymous.status, 401);
        assert.equal(split.agent.requests.length, 0);

        const response = await postJson(
          `${split.edge.baseUrl}/chat`,
          { docId: "doc-1", question: "What is the allocation amount?", userId: "bob" },
          {
            [SERVICE_DEADLINE_HEADER]: "1",
            [SERVICE_REQUEST_ID_HEADER]: "forged-request-id",
            [SERVICE_TOKEN_HEADER]: forged,
            "x-api-key": "token-a",
          }
        );

        assert.equal(response.status, 200);

        const [forwarded] = split.agent.requests;

        assert.notEqual(forwarded.headers[SERVICE_TOKEN_HEADER], forged);
        assert.notEqual(forwarded.headers[SERVICE_REQUEST_ID_HEADER], "forged-request-id");
        assert.notEqual(forwarded.headers[SERVICE_DEADLINE_HEADER], "1");
        // The public credential stays at the edge.
        assert.equal(forwarded.headers["x-api-key"], undefined);
        assert.equal(forwarded.headers.authorization, undefined);

        assert.ok(scopes.length > 0);
        for (const scope of scopes) {
          assert.equal(scope.userId, "alice");
          assert.equal(scope.workspaceId, "ws-a");
          assert.equal(scope.authenticated, true);
        }

        assert.ok(chatCalls.length > 0);
        for (const { options } of chatCalls) {
          assert.equal(options.userId, "alice");
          assert.equal(options.accessScope.workspaceId, "ws-a");
        }

        // Asking for another workspace is refused at the edge, as in the monolith.
        const before = split.agent.requests.length;
        const escape = await postJson(
          `${split.edge.baseUrl}/chat`,
          { docId: "doc-1", question: "What is the allocation amount?" },
          { "x-api-key": "token-a", "x-workspace-id": "ws-b" }
        );

        assert.equal(escape.status, 403);
        assert.equal(split.agent.requests.length, before);
      } finally {
        await split.close();
      }
    }
  );
});

test("the agent tier accepts only signed internal identities from the edge", async () => {
  const scopes = [];

  await withEnvironment(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: "",
      API_AUTH_TOKENS: JSON.stringify({ "token-a": { userId: "alice", workspaceId: "ws-a" } }),
    },
    async () => {
      const agent = await startAgentTier({ ragService: createStubRagService({ scopes }) });
      const ask = (headers) =>
        postJson(
          `${agent.baseUrl}/chat`,
          { docId: "doc-1", question: "What is the allocation amount?" },
          headers
        );
      const expectRefusal = async (headers, status, code) => {
        const response = await ask(headers);

        assert.equal(response.status, status);
        assert.equal((await response.json()).code, code);
      };

      try {
        await expectRefusal({}, 401, SERVICE_IDENTITY_ERROR_CODES.missing);
        await expectRefusal({ "x-api-key": "token-a" }, 401, SERVICE_IDENTITY_ERROR_CODES.missing);
        await expectRefusal(
          { authorization: "Bearer token-a" },
          401,
          SERVICE_IDENTITY_ERROR_CODES.missing
        );
        await expectRefusal(
          { [SERVICE_TOKEN_HEADER]: signAgentToken({ audience: "retrieval" }) },
          403,
          SERVICE_IDENTITY_ERROR_CODES.audience
        );
        await expectRefusal(
          { [SERVICE_TOKEN_HEADER]: signAgentToken({ issuer: "retrieval" }) },
          403,
          SERVICE_IDENTITY_ERROR_CODES.issuer
        );
        await expectRefusal(
          {
            [SERVICE_TOKEN_HEADER]: signServiceToken({ audience: "agent", issuer: "api", system: true }),
          },
          403,
          SERVICE_IDENTITY_ERROR_CODES.systemNotAllowed
        );
        await expectRefusal(
          {
            [SERVICE_TOKEN_HEADER]: signAgentToken({
              env: { INTERNAL_SERVICE_KEYS: `other:${"o".repeat(48)}` },
            }),
          },
          401,
          SERVICE_IDENTITY_ERROR_CODES.unknownKey
        );
        assert.equal(scopes.length, 0);

        // Liveness and health need no identity; the ping needs any valid one.
        const livez = await fetch(`${agent.baseUrl}/livez`);

        assert.deepEqual(await livez.json(), { role: "agent", status: "ok" });
        assert.equal((await fetch(`${agent.baseUrl}/health`)).status, 200);
        assert.equal((await fetch(`${agent.baseUrl}${AGENT_SERVICE_PING_PATH}`)).status, 401);

        const ping = await fetch(`${agent.baseUrl}${AGENT_SERVICE_PING_PATH}`, {
          headers: {
            [SERVICE_TOKEN_HEADER]: signServiceToken({ audience: "agent", issuer: "api", system: true }),
          },
        });

        assert.deepEqual(await ping.json(), { role: "agent", status: "ok" });

        // A valid identity runs as the tenant it names, with no public auth.
        const accepted = await ask({
          [SERVICE_TOKEN_HEADER]: signAgentToken({
            accessScope: { authenticated: true, userId: "alice", workspaceId: "ws-a" },
          }),
        });

        assert.equal(accepted.status, 200);
        assert.ok(scopes.every((scope) => scope.userId === "alice" && scope.workspaceId === "ws-a"));

        const unknownRoute = await fetch(`${agent.baseUrl}/documents`, {
          headers: { [SERVICE_TOKEN_HEADER]: signAgentToken() },
        });

        assert.equal(unknownRoute.status, 404);
      } finally {
        await agent.close();
      }
    }
  );
});

test("admin actions are authorized and audited at the edge and run by the agent tier", async () => {
  const calls = [];

  await withEnvironment(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: "",
      API_AUTH_TOKENS: JSON.stringify({
        "operator-token": {
          roles: [ADMIN_ROLE_IDS.operator],
          userId: "admin-user",
          workspaceId: "admin-workspace",
        },
        "plain-token": { userId: "alice", workspaceId: "ws-a" },
      }),
    },
    async () => {
      const split = await startSplitDeployment({
        agentOptions: {
          agentRunRecoveryActionService: {
            listRecoveryRuns: async ({ accessScope }) => {
              calls.push(accessScope);

              return { runs: [] };
            },
          },
          ragService: createStubRagService(),
        },
        edgeOptions: {
          agentRunRecoveryActionService: {
            listRecoveryRuns: async () => {
              throw new Error("the edge must not run admin actions");
            },
          },
          ragService: createStubRagService(),
        },
      });

      try {
        const allowed = await postJson(
          `${split.edge.baseUrl}/admin/actions/recovery-scan`,
          {},
          { "x-api-key": "operator-token" }
        );

        assert.equal(allowed.status, 200);
        assert.equal((await allowed.json()).status, "completed");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].userId, "admin-user");

        // The decision is audited once, by the edge that made it.
        const edgeAudit = await split.edge.app.locals.services.adminAuditService.listEvents({});
        const agentAudit = await split.agent.app.locals.services.adminAuditService.listEvents({});

        assert.ok(
          edgeAudit.events.some((event) => event.authorization?.actionId === "recovery-scan")
        );
        assert.equal(agentAudit.events.length, 0);

        const refused = await postJson(
          `${split.edge.baseUrl}/admin/actions/recovery-scan`,
          {},
          { "x-api-key": "plain-token" }
        );

        assert.equal(refused.status, 403);
        assert.equal(calls.length, 1);

        // Straight to the agent tier, a token without the edge's grant is refused.
        const direct = await postJson(
          `${split.agent.baseUrl}/admin/actions/recovery-scan`,
          {},
          {
            [SERVICE_TOKEN_HEADER]: signAgentToken({
              accessScope: { authenticated: true, userId: "alice", workspaceId: "ws-a" },
            }),
          }
        );

        assert.equal(direct.status, 403);

        const wrongGrant = await postJson(
          `${split.agent.baseUrl}/admin/actions/recovery-scan`,
          {},
          {
            [SERVICE_TOKEN_HEADER]: signAgentToken({
              claims: { [ADMIN_PERMISSION_CLAIM]: "admin.status.read" },
            }),
          }
        );

        assert.equal(wrongGrant.status, 403);
        assert.equal(calls.length, 1);
      } finally {
        await split.close();
      }
    }
  );
});

test("role api starts no agent recovery or background tasks; the agent tier and the monolith do", async () => {
  const createSpies = () => {
    const calls = [];

    return {
      calls,
      options: {
        agentRunRecoveryService: {
          recoverOnStartup: async () => {
            calls.push("recoverOnStartup");

            return { mode: "manual", recoveredCount: 0, runs: [] };
          },
        },
        jobOrchestrator: {
          recoverRunnableTasks: async () => {
            calls.push("recoverRunnableTasks");

            return { scheduledCount: 0 };
          },
        },
        ragService: createStubRagService(),
      },
    };
  };
  const closedPort = await findClosedPort();

  const edge = createSpies();
  await createEdge(`http://127.0.0.1:${closedPort}`, edge.options);
  assert.deepEqual(edge.calls, []);

  const agent = createSpies();
  await createProductionAgentApp(baseOptions(agent.options));
  assert.deepEqual(agent.calls, ["recoverOnStartup", "recoverRunnableTasks"]);

  const monolith = createSpies();
  await createMonolith(monolith.options);
  assert.deepEqual(monolith.calls, ["recoverOnStartup", "recoverRunnableTasks"]);
});

test("the monolith keeps serving the agent routes in process", async () => {
  const monolith = await startServer(await createMonolith({ ragService: createStubRagService() }));

  try {
    const tasks = await fetch(`${monolith.baseUrl}/tasks`);

    assert.equal(tasks.status, 200);
    assert.equal((await fetch(`${monolith.baseUrl}/capabilities`)).status, 200);
    assert.equal((await fetch(`${monolith.baseUrl}/livez`)).status, 200);
  } finally {
    await monolith.close();
  }
});

test("the edge forwards every route the agent routers serve", () => {
  const listRoutes = (router) =>
    router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).map((method) => `${method} ${layer.route.path}`)
      );
  const served = [...listRoutes(createTasksRouter({})), ...listRoutes(createChatRouter({}))].sort();
  const forwarded = AGENT_EDGE_ROUTES.map(({ method, path }) => `${method} ${path}`).sort();

  assert.deepEqual(forwarded, served);
});
