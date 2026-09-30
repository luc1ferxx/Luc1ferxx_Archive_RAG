import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RESILIENCE_SCENARIOS,
  startFaultInjectingServer,
} from "../evaluation/run-llm-resilience-eval.mjs";
import { runModelGatewayProcess } from "../model-gateway.mjs";
import { runWithAgentEventSink } from "../rag/agent-event-stream.js";
import { createAnswerDraftReleaser, runWithAnswerDraftChannel } from "../rag/answer-drafts.js";
import { createModelGatewayApp } from "../rag/model-gateway/app.js";
import {
  describeModelGatewayClient,
  MODEL_GATEWAY_EMBEDDING_BATCH_SIZE,
  resetModelGatewayClient,
} from "../rag/model-gateway/client.js";
import { MODEL_GATEWAY_ERROR_CODES } from "../rag/model-gateway/protocol.js";
import { createModelGatewayQuotas } from "../rag/model-gateway/quotas.js";
import {
  completeTextWithMetadata,
  embedQuery,
  embedTexts,
  resetOpenAIProvider,
} from "../rag/openai.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { getModelQueryVectorSpace } from "../rag/query-adapter.js";
import { rerankResultsOrKeepOrder, rerankResultsWithProvider } from "../rag/reranker.js";
import { createRunUsage, runWithRunUsage } from "../rag/run-usage.js";
import { SERVICE_TOKEN_HEADER, signServiceToken } from "../rag/service-identity.js";

// The model gateway end to end in one process: a fake OpenAI-compatible
// backend on an OS-assigned port, the gateway app on another, and this process
// as the calling tier (ARCHIVE_RAG_ROLE=agent with MODEL_GATEWAY_URL). The
// gateway's own model calls see the same environment but never go back out to
// a gateway: they run inside a gateway call context.

const SECRET = `${"g".repeat(24)}-gateway-secret-0123456789`;
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };
const PROMPT = Object.freeze({ fingerprint: "0123456789ab", id: "gateway_test", version: "v1" });

const BASE_ENV = {
  API_AUTH_ENABLED: undefined,
  ARCHIVE_RAG_ROLE: "agent",
  INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
  MODEL_GATEWAY_CHAT_UPSTREAMS: undefined,
  MODEL_GATEWAY_EMBEDDING_UPSTREAMS: undefined,
  MODEL_GATEWAY_QUOTA_DAILY_TOKENS: undefined,
  MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE: undefined,
  MODEL_GATEWAY_QUOTA_TOKENS_PER_MINUTE: undefined,
  MODEL_GATEWAY_RERANK_UPSTREAMS: undefined,
  MODEL_GATEWAY_TIMEOUT_MS: undefined,
  MODEL_GATEWAY_URL: undefined,
  OPENAI_API_BASE: undefined,
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: undefined,
  OPENAI_CHAT_FALLBACK_MODEL: "",
  OPENAI_CHAT_MODEL: "gw-chat",
  OPENAI_EMBEDDING_MODEL: "gw-embed",
  RAG_CROSS_ENCODER_ENDPOINT: undefined,
  RAG_CROSS_ENCODER_MODEL: undefined,
  RAG_EMBEDDING_DOCUMENT_PREFIX: undefined,
  RAG_EMBEDDING_QUERY_ADAPTER: undefined,
  RAG_EMBEDDING_QUERY_PREFIX: undefined,
  RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: undefined,
  RAG_LLM_MAX_CONCURRENCY: undefined,
  RAG_LLM_REQUEST_TIMEOUT_MS: "5000",
  RAG_OBSERVABILITY_ENABLED: "false",
  RAG_OBSERVABILITY_EVENTS_PATH: undefined,
  RAG_RERANK_ENABLED: undefined,
  RAG_RERANK_PROVIDER: undefined,
  RAG_SHARED_STATE: "memory",
  RAG_STRUCTURED_OUTPUT_ENABLED: undefined,
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

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return `http://127.0.0.1:${server.address().port}`;
};

const closeServer = async (server, openResponses = new Set()) => {
  for (const response of openResponses) response.destroy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
};

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const chatAnswer = (content, usage = { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 }) => ({
  choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
  usage,
});

const embeddingAnswer = (input) => ({
  data: (Array.isArray(input) ? input : [input]).map((text, index) => ({
    embedding: [text.length, index, 1],
    index,
  })),
  usage: { prompt_tokens: 4, total_tokens: 4 },
});

const writeSse = (res, chunks) => {
  for (const chunk of chunks) {
    res.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
  }
};

const deltaChunk = (content) => ({ choices: [{ delta: { content }, index: 0 }] });

// A fake OpenAI-compatible backend that records every request. `handler`
// answers; by default chat says "pong" and embeddings return small vectors.
const startUpstream = async (t, handler = null) => {
  const requests = [];
  const openResponses = new Set();
  const server = http.createServer((req, res) => {
    let raw = "";
    openResponses.add(res);
    res.on("close", () => openResponses.delete(res));
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const entry = { body: raw ? JSON.parse(raw) : null, headers: req.headers, path: req.url };

      requests.push(entry);

      if (handler) {
        handler(entry, res, requests.length - 1);
      } else if (entry.path.endsWith("/chat/completions")) {
        sendJson(res, 200, chatAnswer("pong"));
      } else if (entry.path.endsWith("/embeddings")) {
        sendJson(res, 200, embeddingAnswer(entry.body.input));
      } else {
        sendJson(res, 404, { error: { message: "no such route" } });
      }
    });
  });
  const origin = await listen(server);

  t.after(() => closeServer(server, openResponses));

  return { baseUrl: `${origin}/v1`, origin, requests };
};

// The gateway app on its own port; MODEL_GATEWAY_URL points this process at it.
const startGateway = async (t, { quotas } = {}) => {
  resetOpenAIProvider();
  resetModelGatewayClient();

  const app = createModelGatewayApp({ quotas: quotas ?? createModelGatewayQuotas() });
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    hits.count += 1;
    app(req, res);
  });
  const url = await listen(server);

  withEnv(t, { MODEL_GATEWAY_URL: url });
  t.after(async () => {
    await closeServer(server);
    app.locals.modelGateway.close();
    resetOpenAIProvider();
    resetModelGatewayClient();
  });

  return { app, hits, url };
};

// A stand-in for a gateway that misbehaves: `handler(entry, res, index)`
// answers each request (its body parsed as JSON when it is JSON).
const startFakeGateway = async (t, handler) => {
  resetOpenAIProvider();
  resetModelGatewayClient();

  const requests = [];
  const openResponses = new Set();
  const server = http.createServer((req, res) => {
    let raw = "";

    openResponses.add(res);
    res.on("close", () => openResponses.delete(res));
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const entry = { body: raw ? JSON.parse(raw) : null, headers: req.headers, path: req.url };

      requests.push(entry);
      handler(entry, res, requests.length - 1);
    });
  });
  const url = await listen(server);

  withEnv(t, { MODEL_GATEWAY_URL: url });
  t.after(async () => {
    await closeServer(server, openResponses);
    resetOpenAIProvider();
    resetModelGatewayClient();
  });

  return { requests, url };
};

const signToken = ({ accessScope, audience = "model-gateway", claims, system = false } = {}) =>
  signServiceToken({
    accessScope: system ? undefined : accessScope ?? { authenticated: true, ...ALICE },
    audience,
    claims,
    issuer: "agent",
    system,
  });

const callGateway = (url, route, { body, method = "POST", token } = {}) =>
  fetch(`${url}${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { [SERVICE_TOKEN_HEADER]: token ?? signToken() }),
    },
    method,
  });

const captureEvents = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-gateway-events-"));
  const eventsPath = path.join(directory, "events.jsonl");

  withEnv(t, { RAG_OBSERVABILITY_ENABLED: "true", RAG_OBSERVABILITY_EVENTS_PATH: eventsPath });
  t.after(() => rm(directory, { force: true, recursive: true }));

  return async () =>
    (await readFile(eventsPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.eventType === "llmops_metric");
};

const hasAnnotation = (event, id) => (event.annotations ?? []).some((entry) => entry.id === id);

test("a chat call goes through the gateway: same text and route, run usage and one authoritative event", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t);
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  const readEvents = await captureEvents(t);
  const gateway = await startGateway(t);
  const runUsage = createRunUsage({ limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 } });

  const completion = await runWithDatabaseTenant(ALICE, () =>
    runWithRunUsage(runUsage, () => completeTextWithMetadata("ping", { promptTemplate: PROMPT }))
  );

  assert.equal(completion.text, "pong");
  assert.equal(completion.modelRoute.modelId, "openai.chat");
  assert.equal(completion.modelRoute.providerId, "openai");
  assert.equal(gateway.hits.count, 1);
  // The backend sees exactly the request the direct client would have sent.
  assert.equal(upstream.requests.length, 1);
  assert.deepEqual(upstream.requests[0].body.messages, [{ content: "ping", role: "user" }]);
  assert.equal(upstream.requests[0].body.model, "gw-chat");
  // Run-level ceilings see the tokens the gateway metered.
  assert.equal(runUsage.used.tokens, 10);
  assert.equal(runUsage.used.modelCalls, 1);

  const events = await readEvents();
  const metered = events.filter((event) => hasAnnotation(event, "model_gateway_metered"));
  const mirrors = events.filter((event) => hasAnnotation(event, "model_gateway_mirror"));

  assert.equal(events.length, 2);
  assert.equal(metered.length, 1);
  assert.equal(mirrors.length, 1);
  assert.deepEqual(metered[0].tenant, ALICE);
  assert.deepEqual(metered[0].promptTemplate, PROMPT);
  assert.equal(metered[0].totalTokens, 10);
  assert.equal(metered[0].tokenSource, "actual");
  assert.deepEqual(mirrors[0].promptTemplate, PROMPT);
  assert.equal(mirrors[0].totalTokens, 10);
  assert.equal(mirrors[0].modelRoute.modelId, "openai.chat");
  assert.equal(mirrors[0].tenant, undefined);
  // No prompt or answer text in any event.
  assert.ok(!JSON.stringify(events).includes("ping"));
  assert.ok(!JSON.stringify(events).includes("pong"));

  const usage = await (await callGateway(gateway.url, "/usage", { method: "GET", token: signToken({ system: true }) })).json();
  const alice = usage.usage.tenants.find((entry) => entry.tenant?.userId === "alice");

  assert.equal(alice.tenant.workspaceId, "ws-a");
  assert.equal(alice.requests, 1);
  assert.equal(alice.modelCalls, 1);
  assert.equal(alice.totalTokens, 10);
  assert.equal(alice.byOperation.llm_completion.totalTokens, 10);
});

test("retry and failover run once, in the gateway, and the route names the model that answered", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startFaultInjectingServer();
  t.after(() => upstream.close());
  withEnv(t, {
    OPENAI_BASE_URL: upstream.baseUrl,
    OPENAI_CHAT_FALLBACK_MODEL: "resilience-fallback",
    OPENAI_CHAT_MODEL: "resilience-primary",
  });
  const readEvents = await captureEvents(t);
  const gateway = await startGateway(t);
  upstream.setScenario(RESILIENCE_SCENARIOS.find((scenario) => scenario.id === "primary_model_down"), 1);

  const completion = await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("ping"));

  assert.equal(completion.text, "pong");
  assert.equal(completion.modelRoute.modelId, "openai.chat.fallback");
  assert.equal(completion.modelRoute.status, "failover");
  // One call to the gateway; the gateway's usual schedule upstream (four tries
  // on the primary, then the fallback), not multiplied by a client retry.
  assert.equal(gateway.hits.count, 1);
  assert.deepEqual(upstream.stats().byModel, { "resilience-fallback": 1, "resilience-primary": 4 });

  const events = await readEvents();
  const metered = events.filter((event) => hasAnnotation(event, "model_gateway_metered"));

  // One metered event per model tried; one mirror for the call.
  assert.deepEqual(metered.map((event) => event.status), ["error", "ok"]);
  const mirrors = events.filter((event) => hasAnnotation(event, "model_gateway_mirror"));

  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].status, "ok");
  // The backend's error text stays in the gateway's own event log.
  assert.ok(!JSON.stringify(mirrors).includes("overloaded"));
});

test("an upstream rejection keeps its status with a stable code and without the backend's text", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t, (entry, res) =>
    sendJson(res, 400, { error: { message: "Invalid schema near: secret prompt words" } })
  );
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl, OPENAI_CHAT_FALLBACK_MODEL: "gw-fallback" });
  await startGateway(t);

  await assert.rejects(completeTextWithMetadata("ping"), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.upstreamRejected);
    assert.equal(error.upstreamStatus, 400);
    assert.ok(!error.message.includes("secret prompt"));
    return true;
  });
  // A client error never fails over: it would fail the same way on any model.
  assert.equal(upstream.requests.length, 1);
});

test("streaming passes tokens through, and a gateway-side retry starts a new attempt for the caller", async (t) => {
  withEnv(t, { ...BASE_ENV, RAG_LLM_REQUEST_TIMEOUT_MS: "300" });
  const upstream = await startUpstream(t, (entry, res, index) => {
    res.writeHead(200, { "content-type": "text/event-stream" });

    if (index === 0) {
      // Streams part of an answer, then stalls until the request times out.
      writeSse(res, [deltaChunk("Par"), deltaChunk("tial")]);
      return;
    }

    writeSse(res, [
      deltaChunk("Hello"),
      deltaChunk(" world"),
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      { choices: [], usage: { completion_tokens: 2, prompt_tokens: 5, total_tokens: 7 } },
      "[DONE]",
    ]);
    res.end();
  });
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  await startGateway(t);
  const log = [];
  const runUsage = createRunUsage({ limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 } });

  const completion = await runWithRunUsage(runUsage, () =>
    completeTextWithMetadata("hi", {
      onAttemptStart: () => log.push("attempt"),
      onTextDelta: (delta) => log.push(delta),
    })
  );

  assert.equal(completion.text, "Hello world");
  assert.deepEqual(log, ["attempt", "Par", "tial", "attempt", "Hello", " world"]);
  assert.equal(upstream.requests.length, 2);
  assert.equal(upstream.requests[1].body.stream, true);
  assert.equal(runUsage.used.tokens, 7);
});

test("answer drafts streamed through the gateway are reset when the gateway retries", async (t) => {
  withEnv(t, { ...BASE_ENV, RAG_LLM_REQUEST_TIMEOUT_MS: "300" });
  const citation = {
    docId: "contract-1",
    excerpt: "The agreement renews every 12 months unless either party gives 30 days notice.",
    fileName: "services-agreement.pdf",
    pageNumber: 3,
  };
  const sentence = "The agreement renews every 12 months. [Source 1]\n";
  const upstream = await startUpstream(t, (entry, res, index) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(res, [deltaChunk(sentence)]);

    if (index > 0) {
      writeSse(res, ["[DONE]"]);
      res.end();
    }
    // The first attempt stalls after one sentence and times out.
  });
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  await startGateway(t);
  const events = [];

  await runWithAgentEventSink(
    (event) => events.push(event),
    () =>
      runWithAnswerDraftChannel(async () => {
        const drafts = createAnswerDraftReleaser({ citations: [citation] });
        const completion = await completeTextWithMetadata("q", drafts.completionOptions);

        drafts.finish(completion.text);
      })
  );

  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type.startsWith("answer_draft")),
    ["answer_draft", "answer_draft_reset", "answer_draft"]
  );
});

test("a generic OpenAI client can stream from the gateway", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t, (entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(res, [deltaChunk("Hel"), deltaChunk("lo"), "[DONE]"]);
    res.end();
  });
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  const gateway = await startGateway(t);

  const response = await callGateway(gateway.url, "/v1/chat/completions", {
    body: {
      messages: [
        { content: "Be brief.", role: "system" },
        { content: "Earlier answer.", role: "assistant" },
        { content: "Say hello.", role: "user" },
      ],
      stream: true,
    },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const lines = (await response.text()).split("\n").filter((line) => line.startsWith("data: "));
  const payloads = lines.map((line) => line.slice(6));
  const chunks = payloads.filter((payload) => payload !== "[DONE]").map((payload) => JSON.parse(payload));

  assert.equal(payloads.at(-1), "[DONE]");
  assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join(""), "Hello");
  assert.ok(chunks.every((chunk) => chunk.object === "chat.completion.chunk"));
  // Messages reach the backend with their roles.
  assert.deepEqual(
    upstream.requests[0].body.messages.map((message) => message.role),
    ["system", "assistant", "user"]
  );
});

test("embeddings keep the caller's task prefixes, pinned space and query marker", async (t) => {
  withEnv(t, {
    ...BASE_ENV,
    RAG_EMBEDDING_DOCUMENT_PREFIX: "doc: ",
    RAG_EMBEDDING_QUERY_PREFIX: "query: ",
  });
  const upstream = await startUpstream(t);
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  const gateway = await startGateway(t);

  const vectors = await embedTexts(["alpha", "beta"]);
  const queryVector = await embedQuery("what");
  const pinned = await embedTexts(["gamma"], {
    embeddingSpace: { dimensions: 3, documentPrefix: "p: ", model: "pinned-embed", queryPrefix: "" },
  });
  const empty = await embedTexts([]);

  assert.deepEqual(vectors, [
    [10, 0, 1],
    [9, 1, 1],
  ]);
  assert.deepEqual(queryVector, [11, 0, 1]);
  assert.deepEqual(pinned, [[8, 0, 1]]);
  assert.deepEqual(empty, []);
  // Each prefix once: the gateway embeds what it is given.
  assert.deepEqual(
    upstream.requests.map((request) => [request.body.model, request.body.input]),
    [
      ["gw-embed", ["doc: alpha", "doc: beta"]],
      ["gw-embed", "query: what"],
      ["pinned-embed", ["p: gamma"]],
    ]
  );
  assert.equal(gateway.hits.count, 3);
  // The query vector is marked as the caller's model's, in the caller's space.
  assert.deepEqual(getModelQueryVectorSpace(queryVector), {
    dimensions: 3,
    documentPrefix: "doc: ",
    model: "gw-embed",
    queryPrefix: "query: ",
  });
});

test("replicas share the load and each has its own breaker; a refused connection moves on at once", async (t) => {
  withEnv(t, { ...BASE_ENV, RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1" });
  const slow = (entry, res) => setTimeout(() => sendJson(res, 200, embeddingAnswer(entry.body.input)), 40);
  const first = await startUpstream(t, slow);
  const second = await startUpstream(t, slow);
  const refused = http.createServer();
  const refusedUrl = await listen(refused);
  await closeServer(refused);
  withEnv(t, {
    MODEL_GATEWAY_EMBEDDING_UPSTREAMS: `${first.baseUrl},${second.baseUrl},${refusedUrl}/v1`,
  });
  const gateway = await startGateway(t);

  await Promise.all(Array.from({ length: 6 }, (_, index) => embedTexts([`text ${index}`])));

  assert.ok(first.requests.length >= 2, `first replica took ${first.requests.length}`);
  assert.ok(second.requests.length >= 2, `second replica took ${second.requests.length}`);
  assert.equal(first.requests.length + second.requests.length, 6);

  const health = await (await fetch(`${gateway.url}/health`)).json();
  const refusedReplica = health.upstreams.embedding.replicas.find((replica) =>
    replica.url.startsWith(refusedUrl)
  );
  const healthyReplica = health.upstreams.embedding.replicas.find((replica) =>
    replica.url.startsWith(first.origin)
  );

  // The refused replica was tried, failed without costing a retry, and its
  // circuit (keyed by replica and model) is open; the others' stay closed.
  assert.ok(refusedReplica.requests >= 1);
  assert.equal(refusedReplica.healthy, false);
  assert.equal(refusedReplica.guards["gw-embed"].breaker.state, "open");
  assert.equal(healthyReplica.guards["gw-embed"].breaker.state, "closed");
  assert.equal(healthyReplica.guards["gw-embed"].breaker.consecutiveFailures, 0);
});

test("a retry after an unavailable replica lands on another one", async (t) => {
  withEnv(t, BASE_ENV);
  const down = await startUpstream(t, (entry, res) => sendJson(res, 503, { error: { message: "busy" } }));
  const up = await startUpstream(t);
  withEnv(t, { MODEL_GATEWAY_CHAT_UPSTREAMS: `${down.baseUrl},${up.baseUrl}` });
  await startGateway(t);

  const completion = await completeTextWithMetadata("ping");

  assert.equal(completion.text, "pong");
  assert.equal(down.requests.length, 1);
  assert.equal(up.requests.length, 1);
});

test("a workspace over its quota gets 429 with Retry-After and a stable code; others are unaffected", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t);
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  const gateway = await startGateway(t, {
    quotas: createModelGatewayQuotas({ limits: { requestsPerMinute: 2 }, redis: null }),
  });

  await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("one"));
  await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("two"));
  await assert.rejects(
    runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("three")),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.quotaExceeded);
      assert.equal(error.quota, "requests_per_minute");
      assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 60_000);
      return true;
    }
  );

  const raw = await callGateway(gateway.url, "/v1/chat/completions", {
    body: { messages: [{ content: "four", role: "user" }] },
    token: signToken({ accessScope: { authenticated: true, ...ALICE } }),
  });

  assert.equal(raw.status, 429);
  assert.ok(Number(raw.headers.get("retry-after")) >= 1);
  assert.equal((await raw.json()).error.code, MODEL_GATEWAY_ERROR_CODES.quotaExceeded);

  // Another workspace, and a system call, are not limited by Alice's quota.
  assert.equal((await runWithDatabaseTenant(BOB, () => completeTextWithMetadata("five"))).text, "pong");
  assert.equal((await completeTextWithMetadata("six")).text, "pong");
  // Rejected requests never reached the backend.
  assert.equal(upstream.requests.length, 4);

  const usage = await (await callGateway(gateway.url, "/usage", { method: "GET", token: signToken({ system: true }) })).json();
  const alice = usage.usage.tenants.find((entry) => entry.tenant?.userId === "alice");

  assert.equal(alice.requests, 4);
  assert.deepEqual(alice.rejectedRequests, { requests_per_minute: 2 });
  assert.equal(usage.usage.tenants.find((entry) => entry.system).requests, 1);
});

test("a token quota counts answered tokens per workspace", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t);
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  await startGateway(t, {
    quotas: createModelGatewayQuotas({ limits: { tokensPerMinute: 15 }, redis: null }),
  });

  // 10 tokens per call: the first two are admitted (0 and 10 used), the third
  // is not (20 used).
  await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("one"));
  await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("two"));
  await assert.rejects(runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("three")), (error) => {
    assert.equal(error.quota, "tokens_per_minute");
    return true;
  });
  assert.equal((await runWithDatabaseTenant(BOB, () => completeTextWithMetadata("four"))).text, "pong");
});

test("forged or missing identities are refused, and the tenant comes from the token only", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t);
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  const gateway = await startGateway(t);
  const body = { messages: [{ content: "hi", role: "user" }] };
  const forgedToken = (() => {
    const signingKeys = process.env.INTERNAL_SERVICE_KEYS;

    process.env.INTERNAL_SERVICE_KEYS = `k1:${"x".repeat(40)}`;

    try {
      return signToken();
    } finally {
      process.env.INTERNAL_SERVICE_KEYS = signingKeys;
    }
  })();

  const missing = await callGateway(gateway.url, "/v1/chat/completions", { body, token: null });
  const forged = await callGateway(gateway.url, "/v1/chat/completions", { body, token: forgedToken });
  const wrongAudience = await callGateway(gateway.url, "/v1/embeddings", {
    body: { input: "x" },
    token: signToken({ audience: "retrieval" }),
  });

  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).code, "SERVICE_TOKEN_MISSING");
  assert.equal(forged.status, 401);
  assert.equal((await forged.json()).code, "SERVICE_TOKEN_SIGNATURE");
  assert.equal(wrongAudience.status, 403);
  assert.equal((await wrongAudience.json()).code, "SERVICE_TOKEN_AUDIENCE");
  assert.equal(upstream.requests.length, 0);

  // A body that names another tenant changes nothing.
  const spoofed = await callGateway(gateway.url, "/v1/chat/completions", {
    body: { ...body, archive_rag: { tenant: BOB, userId: "bob", workspaceId: "ws-b" }, user: "bob" },
    token: signToken({ accessScope: { authenticated: true, ...ALICE } }),
  });

  assert.equal(spoofed.status, 200);
  const usage = await (await callGateway(gateway.url, "/usage", { method: "GET", token: signToken({ system: true }) })).json();

  assert.deepEqual(
    usage.usage.tenants.map((entry) => entry.tenant),
    [ALICE]
  );
});

test("usage is readable with a system identity or an admin claim only", async (t) => {
  withEnv(t, BASE_ENV);
  const gateway = await startGateway(t);

  const tenant = await callGateway(gateway.url, "/usage", { method: "GET" });
  const admin = await callGateway(gateway.url, "/usage", {
    method: "GET",
    token: signToken({ claims: { admin: true } }),
  });
  const permitted = await callGateway(gateway.url, "/usage", {
    method: "GET",
    token: signToken({
      accessScope: { authenticated: true, permissionIds: ["admin.status.read"], ...ALICE },
    }),
  });

  assert.equal(tenant.status, 403);
  assert.equal((await tenant.json()).error.code, MODEL_GATEWAY_ERROR_CODES.forbidden);
  assert.equal(admin.status, 200);
  assert.equal(permitted.status, 200);
  assert.deepEqual((await admin.json()).usage.totals.requests, 0);
});

test("rerank goes to the rerank replicas through the gateway", async (t) => {
  withEnv(t, { ...BASE_ENV, RAG_RERANK_ENABLED: "true", RAG_RERANK_PROVIDER: "cross-encoder" });
  const reranker = await startUpstream(t, (entry, res) =>
    sendJson(res, 200, { scores: entry.body.texts.map((text) => (text.includes("best") ? 3 : -1)) })
  );
  withEnv(t, { MODEL_GATEWAY_RERANK_UPSTREAMS: `${reranker.origin}/rerank` });
  const gateway = await startGateway(t);
  const results = [
    { document: { id: "a", pageContent: "plain text" }, score: 0.9 },
    { document: { id: "b", pageContent: "the best text" }, score: 0.5 },
  ];

  const reranked = await rerankResultsWithProvider({ queryText: "which is best", results, topK: 2 });

  assert.deepEqual(reranked.map((result) => result.document.id), ["b", "a"]);
  assert.equal(reranked[0].crossEncoderScore, 3);
  assert.equal(reranker.requests.length, 1);
  assert.equal(reranker.requests[0].path, "/rerank");
  assert.equal(reranker.requests[0].body.query, "which is best");
  assert.equal(gateway.hits.count, 1);
});

test("a gateway that is down is a clean 503 with a stable code, and rerank keeps the retrieval order", async (t) => {
  withEnv(t, { ...BASE_ENV, RAG_RERANK_ENABLED: "true", RAG_RERANK_PROVIDER: "cross-encoder" });
  const closed = http.createServer();
  const closedUrl = await listen(closed);
  await closeServer(closed);
  withEnv(t, { MODEL_GATEWAY_URL: closedUrl });
  resetModelGatewayClient();
  t.after(() => resetModelGatewayClient());
  const results = [
    { document: { id: "a", pageContent: "first" }, score: 0.9 },
    { document: { id: "b", pageContent: "second" }, score: 0.5 },
  ];

  for (const call of [() => completeTextWithMetadata("ping"), () => embedQuery("ping")]) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.unavailable);
      assert.equal(error.serviceCode, "SERVICE_UNREACHABLE");
      assert.ok(!error.message.includes(closedUrl));
      return true;
    });
  }

  const kept = await rerankResultsOrKeepOrder({ queryText: "q", results, topK: 1 });

  assert.deepEqual(kept.map((result) => result.document.id), ["a"]);
  assert.equal(describeModelGatewayClient().replicas[0].lastFailureCode, "ECONNREFUSED");
});

test("a hanging gateway degrades rerank within the cross-encoder timeout, not the chat budget", { timeout: 15_000 }, async (t) => {
  withEnv(t, {
    ...BASE_ENV,
    RAG_CROSS_ENCODER_TIMEOUT_MS: "200",
    RAG_RERANK_ENABLED: "true",
    RAG_RERANK_PROVIDER: "cross-encoder",
  });
  // Takes the request and never answers.
  const gateway = await startFakeGateway(t, () => {});
  const results = [
    { document: { id: "a", pageContent: "first" }, score: 0.9 },
    { document: { id: "b", pageContent: "second" }, score: 0.5 },
  ];
  const startedAt = Date.now();

  await assert.rejects(rerankResultsWithProvider({ queryText: "q", results, topK: 2 }), (error) => {
    assert.equal(error.status, 504);
    assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.timeout);
    return true;
  });

  const kept = await rerankResultsOrKeepOrder({ queryText: "q", results, topK: 1 });

  assert.deepEqual(kept.map((result) => result.document.id), ["a"]);
  assert.ok(Date.now() - startedAt < 5_000, `took ${Date.now() - startedAt} ms`);
  // The deadline the gateway was given is the rerank budget, not 10 minutes.
  assert.ok(Number(gateway.requests[0].headers["x-archive-service-deadline-ms"]) <= 200);
});

test("the gateway abandons a rerank backend request when its caller's deadline passes", { timeout: 15_000 }, async (t) => {
  withEnv(t, { ...BASE_ENV, RAG_CROSS_ENCODER_TIMEOUT_MS: "10000" });
  let backendClosed = null;
  const backendGone = new Promise((resolve) => {
    backendClosed = resolve;
  });
  // A cross-encoder that never answers.
  const reranker = await startUpstream(t, (entry, res) => res.on("close", backendClosed));
  withEnv(t, { MODEL_GATEWAY_RERANK_UPSTREAMS: `${reranker.origin}/rerank` });
  const gateway = await startGateway(t);
  const startedAt = Date.now();

  const response = await fetch(`${gateway.url}/rerank`, {
    body: JSON.stringify({ query: "q", texts: ["a", "b"] }),
    headers: {
      "content-type": "application/json",
      "x-archive-service-deadline-ms": "200",
      [SERVICE_TOKEN_HEADER]: signToken(),
    },
    method: "POST",
  });

  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, MODEL_GATEWAY_ERROR_CODES.aborted);
  await backendGone;
  assert.ok(Date.now() - startedAt < 5_000, `took ${Date.now() - startedAt} ms`);
});

test("a document larger than one gateway request is embedded in batches, with its usage added up", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t);
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  const readEvents = await captureEvents(t);
  const gateway = await startGateway(t);
  const runUsage = createRunUsage({ limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 } });
  // Past the gateway's per-request input limit (8192); the monolith batches
  // any number of texts.
  const texts = Array.from({ length: 8193 }, (_, index) => `t${index}`);

  const vectors = await runWithRunUsage(runUsage, () => embedTexts(texts));
  const batches = Math.ceil(texts.length / MODEL_GATEWAY_EMBEDDING_BATCH_SIZE);

  assert.equal(vectors.length, texts.length);
  assert.deepEqual(vectors[8192], ["t8192".length, 0, 1]);
  assert.equal(gateway.hits.count, batches);
  assert.equal(upstream.requests.length, batches);

  const events = await readEvents();
  const metered = events.filter((event) => hasAnnotation(event, "model_gateway_metered"));
  const mirrors = events.filter((event) => hasAnnotation(event, "model_gateway_mirror"));
  const meteredTokens = metered.reduce((sum, event) => sum + event.totalTokens, 0);

  assert.equal(metered.length, batches);
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].totalTokens, meteredTokens);
  assert.equal(runUsage.used.tokens, meteredTokens);
});

test("an answer that is not the gateway's is a 502 with a stable code, never its own status", async (t) => {
  withEnv(t, BASE_ENV);

  // A gateway that does not accept this tier's keys: a deployment fault, not
  // the end user's 401.
  const upstream = await startUpstream(t);
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  resetModelGatewayClient();
  const app = createModelGatewayApp({
    env: { ...process.env, INTERNAL_SERVICE_KEYS: `k9:${"z".repeat(40)}` },
  });
  const server = http.createServer(app);
  const url = await listen(server);

  withEnv(t, { MODEL_GATEWAY_URL: url });
  t.after(async () => {
    await closeServer(server);
    app.locals.modelGateway.close();
    resetModelGatewayClient();
  });

  await assert.rejects(completeTextWithMetadata("ping"), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.protocol);
    assert.equal(error.serviceCode, "SERVICE_TOKEN_UNKNOWN_KEY");
    return true;
  });
  assert.equal(upstream.requests.length, 0);
});

test("a gateway answering garbage fails the call with a stable code", async (t) => {
  withEnv(t, BASE_ENV);
  await startFakeGateway(t, (entry, res) => {
    if (entry.path === "/v1/embeddings") {
      sendJson(res, 200, { data: [], object: "list" });
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>maintenance</html>");
  });

  await assert.rejects(completeTextWithMetadata("ping"), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.protocol);
    return true;
  });

  for (const call of [() => embedQuery("ping"), () => embedTexts(["a", "b"])]) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.protocol);
      return true;
    });
  }
});

test("a stream that breaks, stalls or cannot be parsed fails with the gateway's codes", async (t) => {
  withEnv(t, { ...BASE_ENV, MODEL_GATEWAY_TIMEOUT_MS: "400" });
  const chunk = (content) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }], object: "chat.completion.chunk" })}\n\n`;
  await startFakeGateway(t, (entry, res, index) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk("Hel"));

    if (index === 0) {
      // The gateway process dies mid-answer.
      setTimeout(() => res.socket.destroy(), 20);
    } else if (index === 2) {
      res.write("data: {not json\n\n");
    }
    // index 1: stalls past the call's budget.
  });
  const stream = () => completeTextWithMetadata("ping", { onTextDelta: () => {} });

  await assert.rejects(stream(), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.unavailable);
    return true;
  });
  await assert.rejects(stream(), (error) => {
    assert.equal(error.status, 504);
    assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.timeout);
    return true;
  });
  await assert.rejects(stream(), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.protocol);
    return true;
  });
});

test("health reports replicas, guard state and quotas without secrets", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t);
  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  const gateway = await startGateway(t);

  const response = await fetch(`${gateway.url}/health`);
  const text = await response.text();
  const health = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(health.status, "ok");
  assert.equal(health.role, "model-gateway");
  assert.deepEqual(health.identity.keyIds, ["k1"]);
  assert.equal(health.upstreams.chat.replicas[0].url, upstream.baseUrl);
  assert.equal(health.upstreams.rerank.replicas.length, 0);
  assert.equal(health.quotas.enabled, false);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes("test-key"));
});

test("a process that hosts the gateway never calls MODEL_GATEWAY_URL, and without it nothing changes", async (t) => {
  withEnv(t, BASE_ENV);
  const upstream = await startUpstream(t);
  const closed = http.createServer();
  const closedUrl = await listen(closed);
  await closeServer(closed);
  withEnv(t, { ARCHIVE_RAG_ROLE: "model-gateway", MODEL_GATEWAY_URL: closedUrl, OPENAI_BASE_URL: upstream.baseUrl });
  resetOpenAIProvider();

  assert.equal((await completeTextWithMetadata("ping")).text, "pong");

  withEnv(t, { ARCHIVE_RAG_ROLE: undefined, MODEL_GATEWAY_URL: undefined });

  assert.equal((await completeTextWithMetadata("ping")).text, "pong");
  assert.equal(upstream.requests.length, 2);
});

test("the entry point runs only as role model-gateway", async (t) => {
  withEnv(t, BASE_ENV);
  const logged = [];
  const logger = { error: (line) => logged.push(line), log: () => {}, warn: () => {} };

  assert.equal(
    await runModelGatewayProcess({ environment: { ARCHIVE_RAG_ROLE: "api" }, listen: false, logger }),
    null
  );
  assert.match(logged[0], /runs only as role model-gateway/);
  assert.equal(
    await runModelGatewayProcess({ environment: {}, listen: false, logger }),
    null,
    "without INTERNAL_SERVICE_KEYS the topology is invalid"
  );

  const environment = { INTERNAL_SERVICE_KEYS: `k1:${SECRET}` };
  const started = await runModelGatewayProcess({ environment, listen: false, logger });

  t.after(() => started?.app.locals.modelGateway.close());
  assert.equal(environment.ARCHIVE_RAG_ROLE, "model-gateway");
  assert.equal(typeof started.app, "function");
});
