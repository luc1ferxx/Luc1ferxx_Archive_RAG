import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  buildModelGatewayErrorBody,
  createModelGatewayCallError,
  describeModelGatewayError,
  MODEL_GATEWAY_ERROR_CODES,
} from "../rag/model-gateway/protocol.js";
import { createModelGatewayQuotas, getQuotaTenantKey } from "../rag/model-gateway/quotas.js";
import { createUpstreamPool, parseUpstreamUrls } from "../rag/model-gateway/upstream-pool.js";
import { createModelUsageLedger } from "../rag/model-gateway/usage-ledger.js";
import { resetModelCallGuards } from "../rag/model-call-guard.js";
import { createSharedRedisClient } from "../rag/shared-state.js";

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };
const MINUTE = 60_000;

test("quota keys follow the workspace, fall back to the user, and exempt system calls", () => {
  assert.equal(getQuotaTenantKey(ALICE), "workspace:ws-a");
  assert.equal(getQuotaTenantKey({ userId: "carol", workspaceId: " " }), "user:carol");
  assert.equal(getQuotaTenantKey(null), null);
  assert.equal(getQuotaTenantKey({ userId: "", workspaceId: "" }), null);
});

test("requests per minute are counted per workspace and reset with the window", async () => {
  let now = 10 * MINUTE + 15_000;
  const quotas = createModelGatewayQuotas({
    limits: { requestsPerMinute: 2 },
    now: () => now,
    redis: null,
  });

  assert.deepEqual(await quotas.admit(ALICE), { ok: true });
  assert.deepEqual(await quotas.admit(ALICE), { ok: true });
  assert.deepEqual(await quotas.admit(ALICE), {
    ok: false,
    quota: "requests_per_minute",
    retryAfterMs: 45_000,
  });
  assert.deepEqual(await quotas.admit(BOB), { ok: true });
  assert.deepEqual(await quotas.admit(null), { ok: true });

  now += 45_000;

  assert.deepEqual(await quotas.admit(ALICE), { ok: true });
});

test("token quotas charge answered tokens by the minute and by the UTC day", async () => {
  let now = Date.UTC(2026, 8, 30, 23, 59, 30);
  const quotas = createModelGatewayQuotas({
    limits: { dailyTokens: 100, tokensPerMinute: 50 },
    now: () => now,
    redis: null,
  });

  await quotas.chargeTokens(ALICE, 60);
  assert.equal((await quotas.admit(ALICE)).quota, "tokens_per_minute");
  assert.equal((await quotas.admit(BOB)).ok, true);

  now += 30_000; // next minute, next UTC day
  await quotas.chargeTokens(ALICE, 40);
  assert.equal((await quotas.admit(ALICE)).ok, true);

  now += 60_000;
  await quotas.chargeTokens(ALICE, 45);
  now += 60_000;
  await quotas.chargeTokens(ALICE, 20);
  now += 60_000;

  const refused = await quotas.admit(ALICE);

  assert.equal(refused.quota, "daily_tokens");
  assert.ok(refused.retryAfterMs > 20 * 60 * MINUTE);
  assert.deepEqual(quotas.describe().limits, { dailyTokens: 100, requestsPerMinute: 0, tokensPerMinute: 50 });
});

test("counters of ended windows are dropped, whatever the workspace id holds", async () => {
  let now = 10 * MINUTE;
  const quotas = createModelGatewayQuotas({
    limits: { requestsPerMinute: 5, tokensPerMinute: 100 },
    now: () => now,
    redis: null,
  });

  await quotas.admit({ userId: "u", workspaceId: "team|a" });
  await quotas.chargeTokens({ userId: "u", workspaceId: "team|a" }, 10);
  assert.equal(quotas.describe().localCounters, 3);

  now += 2 * MINUTE;
  await quotas.admit(BOB);

  // Left: the "team|a" day's tokens (the day has not ended) and Bob's request
  // counter for this minute; "team|a"'s minute counters are gone.
  assert.equal(quotas.describe().localCounters, 2);
});

test("quotas off admit everything, and a failing Redis falls back to this process", async () => {
  const off = createModelGatewayQuotas({ limits: {}, redis: null });

  assert.equal(off.enabled, false);
  assert.deepEqual(await off.admit(ALICE), { ok: true });

  const failing = {
    eval: async () => {
      throw new Error("Connection is closed.");
    },
  };
  const quotas = createModelGatewayQuotas({ limits: { requestsPerMinute: 1 }, redis: failing });

  assert.equal((await quotas.admit(ALICE)).ok, true);
  assert.equal((await quotas.admit(ALICE)).quota, "requests_per_minute");
  await quotas.chargeTokens(ALICE, 5);
  assert.equal(quotas.describe().shared.provider, "redis");
  assert.equal(quotas.describe().shared.fallbacks, 3);
});

const redisUrl = String(process.env.REDIS_TEST_URL ?? "").trim();

test(
  "two gateway replicas share one quota through Redis",
  { skip: redisUrl ? false : "REDIS_TEST_URL is not set; point it at a disposable Redis to run it" },
  async (t) => {
    const originalPrefix = process.env.RAG_SHARED_STATE_PREFIX;

    process.env.RAG_SHARED_STATE_PREFIX = `archive-rag-test:${randomBytes(4).toString("hex")}:`;
    const clients = [createSharedRedisClient(redisUrl), createSharedRedisClient(redisUrl)];

    t.after(async () => {
      await Promise.all(clients.map((client) => client.quit().catch(() => client.disconnect())));

      if (originalPrefix === undefined) delete process.env.RAG_SHARED_STATE_PREFIX;
      else process.env.RAG_SHARED_STATE_PREFIX = originalPrefix;
    });
    await Promise.all(
      clients.map(
        (client) => new Promise((resolve) => (client.status === "ready" ? resolve() : client.once("ready", resolve)))
      )
    );

    const [first, second] = clients.map((redis) =>
      createModelGatewayQuotas({ limits: { requestsPerMinute: 3, tokensPerMinute: 25 }, redis })
    );

    assert.equal((await first.admit(ALICE)).ok, true);
    assert.equal((await second.admit(ALICE)).ok, true);
    assert.equal((await first.admit(ALICE)).ok, true);
    assert.equal((await second.admit(ALICE)).quota, "requests_per_minute");
    assert.equal((await second.admit(BOB)).ok, true);

    await first.chargeTokens(BOB, 30);
    assert.equal((await second.admit(BOB)).quota, "tokens_per_minute");
    assert.equal(first.describe().shared.fallbacks, 0);
    assert.equal(second.describe().shared.fallbacks, 0);
  }
);

test("the usage ledger totals answered tokens per tenant and counts failed attempts", () => {
  const ledger = createModelUsageLedger({ now: () => Date.UTC(2026, 8, 30) });

  ledger.recordRequest(ALICE);
  ledger.recordEvent(ALICE, { operation: "llm_completion", status: "error", totalTokens: 9 });
  ledger.recordEvent(ALICE, {
    estimatedCostUsd: 0.25,
    inputTokens: 7,
    operation: "llm_completion",
    outputTokens: 3,
    status: "ok",
    totalTokens: 10,
  });
  ledger.recordRequest(ALICE, { rejectedBy: "requests_per_minute" });
  ledger.recordRequest(null);
  ledger.recordEvent(null, { operation: "embedding", status: "ok", totalTokens: 4 });

  const snapshot = ledger.snapshot();
  const alice = snapshot.tenants.find((entry) => entry.tenant?.userId === "alice");
  const system = snapshot.tenants.find((entry) => entry.system);

  assert.equal(snapshot.since, "2026-09-30T00:00:00.000Z");
  assert.equal(alice.requests, 2);
  assert.deepEqual(alice.rejectedRequests, { requests_per_minute: 1 });
  assert.equal(alice.modelCalls, 2);
  assert.equal(alice.failedModelCalls, 1);
  assert.equal(alice.totalTokens, 10);
  assert.equal(alice.estimatedCostUsd, 0.25);
  assert.equal(system.unpricedModelCalls, 1);
  assert.equal(snapshot.totals.totalTokens, 14);
  assert.equal(snapshot.totals.requests, 3);
});

test("gateway errors keep the backend's meaning, never its text, and survive the round trip", () => {
  const upstream = (status, extra = {}) =>
    Object.assign(new Error("model said: secret prompt"), { status, upstreamStatus: status, ...extra });
  const cases = [
    [upstream(400), 400, MODEL_GATEWAY_ERROR_CODES.upstreamRejected],
    [upstream(401), 502, MODEL_GATEWAY_ERROR_CODES.upstreamAuth],
    [upstream(429, { retryAfterMs: 1200 }), 429, MODEL_GATEWAY_ERROR_CODES.upstreamRateLimited],
    [upstream(503), 503, MODEL_GATEWAY_ERROR_CODES.upstreamUnavailable],
    [Object.assign(new Error("Circuit open for http://x|m"), { code: "CIRCUIT_OPEN", status: 503 }), 503, "CIRCUIT_OPEN"],
    [Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), 504, MODEL_GATEWAY_ERROR_CODES.upstreamTimeout],
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), 503, MODEL_GATEWAY_ERROR_CODES.upstreamUnavailable],
    [Object.assign(new Error("LLMOps budget exceeded."), { name: "LlmOpsBudgetExceededError", status: 429 }), 429, MODEL_GATEWAY_ERROR_CODES.budgetExceeded],
    [Object.assign(new Error("OPENAI_API_KEY is not configured."), { status: 500 }), 500, MODEL_GATEWAY_ERROR_CODES.internal],
  ];

  for (const [error, status, code] of cases) {
    const described = describeModelGatewayError(error);
    const body = buildModelGatewayErrorBody(described);
    const received = createModelGatewayCallError({ json: body, status: described.status });

    assert.equal(described.status, status, code);
    assert.equal(described.code, code);
    assert.ok(!JSON.stringify(body).includes("secret prompt"));
    assert.ok(!JSON.stringify(body).includes("http://x"));
    assert.equal(received.status, status);
    assert.equal(received.code, code);
  }

  assert.equal(describeModelGatewayError(upstream(429, { retryAfterMs: 1200 })).retryAfterMs, 1200);

  // A proxy's answer in front of a gateway that is gone.
  const proxied = createModelGatewayCallError({ headers: {}, json: null, status: 502 });

  assert.equal(proxied.status, 503);
  assert.equal(proxied.code, MODEL_GATEWAY_ERROR_CODES.unavailable);

  // Any other answer that is not the gateway's never keeps its own status.
  for (const [status, json] of [
    [200, null],
    [401, { code: "SERVICE_TOKEN_SIGNATURE", error: "Unauthorized." }],
    [404, { error: { code: "NOT_FOUND" } }],
  ]) {
    const unknown = createModelGatewayCallError({ json, status });

    assert.equal(unknown.status, 502, String(status));
    assert.equal(unknown.code, MODEL_GATEWAY_ERROR_CODES.protocol);
  }

  assert.equal(
    createModelGatewayCallError({ json: { code: "SERVICE_TOKEN_SIGNATURE" }, status: 401 }).serviceCode,
    "SERVICE_TOKEN_SIGNATURE"
  );
});

test("upstream lists are validated like service URLs", () => {
  assert.deepEqual(parseUpstreamUrls(" http://a:1/v1/ , http://b:2/v1,http://a:1/v1 "), [
    "http://a:1/v1",
    "http://b:2/v1",
  ]);
  assert.deepEqual(parseUpstreamUrls(""), []);
  assert.throws(
    () => parseUpstreamUrls("http://user:pass@a/v1", { variable: "MODEL_GATEWAY_CHAT_UPSTREAMS" }),
    (error) => /MODEL_GATEWAY_CHAT_UPSTREAMS/.test(error.message) && !error.message.includes("pass")
  );
});

test("a pool with no replica refuses with a stable code, and an open circuit moves to the next replica", async (t) => {
  t.after(() => resetModelCallGuards());
  resetModelCallGuards();

  await assert.rejects(createUpstreamPool({ kind: "rerank" }).run({ send: async () => [] }), (error) => {
    const described = describeModelGatewayError(error);

    assert.equal(described.status, 503);
    assert.equal(described.code, MODEL_GATEWAY_ERROR_CODES.backendNotConfigured);
    return true;
  });

  const originalThreshold = process.env.RAG_LLM_CIRCUIT_FAILURE_THRESHOLD;

  process.env.RAG_LLM_CIRCUIT_FAILURE_THRESHOLD = "1";
  t.after(() => {
    if (originalThreshold === undefined) delete process.env.RAG_LLM_CIRCUIT_FAILURE_THRESHOLD;
    else process.env.RAG_LLM_CIRCUIT_FAILURE_THRESHOLD = originalThreshold;
  });

  let now = 0;
  const pool = createUpstreamPool({ cooldownMs: 10, kind: "chat", now: () => now, urls: ["http://a", "http://b"] });
  const sent = [];
  const send = async (url) => {
    sent.push(url);

    if (url === "http://a") {
      throw Object.assign(new Error("down"), { status: 503, upstreamStatus: 503 });
    }

    return url;
  };

  await assert.rejects(pool.run({ model: "m", send }), /down/);
  now += 20; // past the pool's short cooldown; a's circuit is still open
  assert.equal(await pool.run({ model: "m", send }), "http://b");
  assert.equal(await pool.run({ model: "m", send }), "http://b");
  // After its one failure a's breaker rejects without sending anything.
  assert.deepEqual(sent, ["http://a", "http://b", "http://b"]);
  assert.equal(pool.describe().replicas[0].guards.m.breaker.state, "open");
});
