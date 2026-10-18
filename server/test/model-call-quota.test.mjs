import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createModelGatewayApp } from "../rag/model-gateway/app.js";
import { resetModelGatewayClient } from "../rag/model-gateway/client.js";
import { MODEL_GATEWAY_ERROR_CODES, MODEL_GATEWAY_QUOTAS } from "../rag/model-gateway/protocol.js";
import { createModelGatewayQuotas } from "../rag/model-gateway/quotas.js";
import {
  admitModelCallQuota,
  configureInProcessModelQuotas,
  describeInProcessModelQuotas,
  resetInProcessModelQuotas,
} from "../rag/model-call-quota.js";
import { createWorkspaceModelQuotas } from "../rag/model-quotas.js";
import { resetModelCallGuards } from "../rag/model-call-guard.js";
import {
  completeTextWithMetadata,
  configureOpenAIProvider,
  embedQuery,
  embedTexts,
  resetOpenAIProvider,
} from "../rag/openai.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { rerankResultsOrKeepOrder } from "../rag/reranker.js";

// In-process per-workspace model quotas (MODEL_QUOTA_ENABLED): the model
// gateway's limits and engine, applied to the model calls a process sends
// itself, admitted once per call before it is sent and charged from the
// answered call's LLMOps event. A call routed to the gateway is admitted
// there only.

const SECRET = `${"q".repeat(24)}-quota-secret-0123456789`;
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };

const BASE_ENV = {
  API_AUTH_ENABLED: undefined,
  ARCHIVE_RAG_ROLE: undefined,
  INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
  MODEL_GATEWAY_CHAT_UPSTREAMS: undefined,
  MODEL_GATEWAY_EMBEDDING_UPSTREAMS: undefined,
  MODEL_GATEWAY_QUOTA_DAILY_TOKENS: undefined,
  MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE: undefined,
  MODEL_GATEWAY_QUOTA_TOKENS_PER_MINUTE: undefined,
  MODEL_GATEWAY_RERANK_UPSTREAMS: undefined,
  MODEL_GATEWAY_URL: undefined,
  MODEL_QUOTA_ENABLED: "true",
  OPENAI_API_BASE: undefined,
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: undefined,
  OPENAI_CHAT_FALLBACK_MODEL: "",
  OPENAI_CHAT_MODEL: "quota-chat",
  OPENAI_EMBEDDING_MODEL: "quota-embed",
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

  resetOpenAIProvider();
  resetModelCallGuards();
  resetInProcessModelQuotas();
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetOpenAIProvider();
    resetModelCallGuards();
    resetInProcessModelQuotas();
  });
};

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return `http://127.0.0.1:${server.address().port}`;
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// A fake OpenAI-compatible backend (chat answers "pong" with 10 tokens of
// usage, embeddings small vectors) plus a cross-encoder at /rerank.
const startUpstream = async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;

      requests.push({ body, path: req.url });

      if (req.url.endsWith("/chat/completions")) {
        sendJson(res, 200, {
          choices: [{ finish_reason: "stop", index: 0, message: { content: "pong", role: "assistant" } }],
          usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
        });
      } else if (req.url.endsWith("/embeddings")) {
        const texts = Array.isArray(body.input) ? body.input : [body.input];

        sendJson(res, 200, { data: texts.map((text, index) => ({ embedding: [text.length, index, 1], index })) });
      } else if (req.url.endsWith("/rerank")) {
        sendJson(res, 200, { scores: body.texts.map((_, index) => index) });
      } else {
        sendJson(res, 404, { error: { message: "no such route" } });
      }
    });
  });
  const origin = await listen(server);

  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });

  return { baseUrl: `${origin}/v1`, origin, requests };
};

const isQuotaRefusal = (quota) => (error) => {
  assert.equal(error.status, 429);
  assert.equal(error.code, MODEL_GATEWAY_ERROR_CODES.quotaExceeded);
  assert.equal(error.quota, quota);
  assert.equal(error.upstreamStatus, null);
  assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 24 * 60 * 60 * 1000, `retryAfterMs ${error.retryAfterMs}`);
  return true;
};

test("quotas are enforced in process only with MODEL_QUOTA_ENABLED=true", async (t) => {
  withEnv(t, { ...BASE_ENV, MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE: "1", MODEL_QUOTA_ENABLED: undefined });
  const upstream = await startUpstream(t);

  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });

  for (let index = 0; index < 3; index += 1) {
    assert.equal((await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata(`call ${index}`))).text, "pong");
  }

  assert.equal(upstream.requests.length, 3);
  assert.equal(admitModelCallQuota(ALICE), null, "nothing to await while quotas are off");
  assert.equal(describeInProcessModelQuotas().enabled, false);
});

test("a workspace over its in-process quota gets the gateway's 429 shape; the call is never sent, retried or failed over", async (t) => {
  withEnv(t, {
    ...BASE_ENV,
    MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE: "2",
    OPENAI_CHAT_FALLBACK_MODEL: "quota-fallback",
  });
  const upstream = await startUpstream(t);

  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });

  await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("one"));
  await runWithDatabaseTenant(ALICE, () => embedQuery("two"));
  await assert.rejects(
    runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("three")),
    isQuotaRefusal(MODEL_GATEWAY_QUOTAS.requestsPerMinute)
  );
  await assert.rejects(
    runWithDatabaseTenant(ALICE, () => embedTexts(["four"])),
    isQuotaRefusal(MODEL_GATEWAY_QUOTAS.requestsPerMinute)
  );
  // Two calls reached the backend: the refused ones were not sent, retried,
  // or sent to the fallback model.
  assert.equal(upstream.requests.length, 2);
  assert.ok(upstream.requests.every((request) => request.body.model !== "quota-fallback"));

  // Another workspace, and a call without a tenant, are not limited by it.
  assert.equal((await runWithDatabaseTenant(BOB, () => completeTextWithMetadata("five"))).text, "pong");
  assert.equal((await completeTextWithMetadata("six")).text, "pong");
  assert.equal(upstream.requests.length, 4);

  const described = describeInProcessModelQuotas();

  assert.equal(described.enabled, true);
  assert.deepEqual(described.limits, { dailyTokens: 0, requestsPerMinute: 2, tokensPerMinute: 0 });
  assert.equal(described.rejections.requests_per_minute, 2);
  assert.doesNotMatch(JSON.stringify(described), /alice|ws-a|bob|ws-b/);
});

test("token quotas charge each tenant the tokens its answered calls used", async (t) => {
  withEnv(t, { ...BASE_ENV, MODEL_GATEWAY_QUOTA_TOKENS_PER_MINUTE: "15" });
  const upstream = await startUpstream(t);

  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });

  // 10 tokens per answered call: 0 and 10 used are under 15, 20 is not.
  await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("one"));
  await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("two"));
  await assert.rejects(
    runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("three")),
    isQuotaRefusal(MODEL_GATEWAY_QUOTAS.tokensPerMinute)
  );
  assert.equal((await runWithDatabaseTenant(BOB, () => completeTextWithMetadata("four"))).text, "pong");
  assert.equal(upstream.requests.length, 3);
});

test("a stand-in provider is admitted too, and a rerank over quota keeps the fused order", async (t) => {
  withEnv(t, { ...BASE_ENV, MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE: "1" });
  const calls = [];

  configureOpenAIProvider({
    completeText: async (prompt) => {
      calls.push(prompt);
      return "stand-in";
    },
  });
  assert.equal((await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("one"))).text, "stand-in");
  await assert.rejects(
    runWithDatabaseTenant(ALICE, () => completeTextWithMetadata("two")),
    isQuotaRefusal(MODEL_GATEWAY_QUOTAS.requestsPerMinute)
  );
  assert.equal(calls.length, 1);

  const upstream = await startUpstream(t);

  withEnv(t, {
    RAG_CROSS_ENCODER_ENDPOINT: `${upstream.origin}/rerank`,
    RAG_RERANK_ENABLED: "true",
    RAG_RERANK_PROVIDER: "cross-encoder",
  });
  const results = [
    { document: { id: "a", pageContent: "first" }, score: 0.9 },
    { document: { id: "b", pageContent: "second" }, score: 0.5 },
  ];

  // Bob's first rerank is scored by the cross-encoder; his second is over
  // quota, is never sent, and keeps the fused order instead of failing.
  const scored = await runWithDatabaseTenant(BOB, () => rerankResultsOrKeepOrder({ queryText: "q", results, topK: 2 }));

  assert.equal(scored.length, 2);
  assert.equal(upstream.requests.filter((request) => request.path === "/rerank").length, 1);

  const kept = await runWithDatabaseTenant(BOB, () => rerankResultsOrKeepOrder({ queryText: "q", results, topK: 2 }));

  assert.deepEqual(kept, results);
  assert.equal(upstream.requests.filter((request) => request.path === "/rerank").length, 1);
  assert.equal(describeInProcessModelQuotas().rejections.requests_per_minute, 1);
});

test("a call routed to the model gateway is admitted there only, never twice", async (t) => {
  // The in-process limit would refuse Alice's second call; the gateway has
  // none. All three answer: neither the calling side (routed to the gateway)
  // nor the gateway's own model call (inside a gateway request) admits here.
  withEnv(t, { ...BASE_ENV, ARCHIVE_RAG_ROLE: "agent", MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE: "1" });
  const upstream = await startUpstream(t);

  withEnv(t, { OPENAI_BASE_URL: upstream.baseUrl });
  resetModelGatewayClient();

  const app = createModelGatewayApp({ quotas: createModelGatewayQuotas({ limits: {}, redis: null }) });
  const server = http.createServer(app);
  const url = await listen(server);

  withEnv(t, { MODEL_GATEWAY_URL: url });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    app.locals.modelGateway.close();
    resetModelGatewayClient();
  });

  for (let index = 0; index < 3; index += 1) {
    assert.equal((await runWithDatabaseTenant(ALICE, () => completeTextWithMetadata(`call ${index}`))).text, "pong");
  }

  assert.equal((await runWithDatabaseTenant(ALICE, () => embedTexts(["a", "b"]))).length, 2);
  assert.equal(upstream.requests.length, 4);
  assert.equal(describeInProcessModelQuotas().rejections.requests_per_minute, 0);
});

test("the extracted engine keeps the gateway's quota behaviour", async (t) => {
  let nowMs = Date.UTC(2026, 9, 17, 12, 0, 30);
  const quotas = createWorkspaceModelQuotas({
    limits: { dailyTokens: 25, requestsPerMinute: 2, tokensPerMinute: 0 },
    now: () => nowMs,
    redis: null,
  });

  assert.deepEqual(await quotas.admit(ALICE), { ok: true });
  assert.deepEqual(await quotas.admit(ALICE), { ok: true });
  assert.deepEqual(await quotas.admit(ALICE), { ok: false, quota: "requests_per_minute", retryAfterMs: 30_000 });
  assert.deepEqual(await quotas.admit(null), { ok: true }, "a system call is never limited");

  nowMs += 60_000;
  await quotas.chargeTokens(ALICE, 30);
  assert.equal((await quotas.admit(ALICE)).quota, "daily_tokens");
  assert.deepEqual(await quotas.admit(BOB), { ok: true });

  // Injected into the in-process enforcer, it decides every admission.
  withEnv(t, { MODEL_QUOTA_ENABLED: "true" });
  configureInProcessModelQuotas({ quotas });
  await assert.rejects(admitModelCallQuota(ALICE), isQuotaRefusal("daily_tokens"));
  assert.equal(await admitModelCallQuota(BOB), undefined);
  assert.equal(admitModelCallQuota(null), null, "a call without a tenant is never admitted or limited");
});
