import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmbeddingBatcher,
  splitEmbeddingTokensByTenant,
} from "../rag/ingest-embedding-batcher.js";
import {
  buildModelCallGuardKey,
  describeModelCallTenantRef,
  getModelCallGuardSnapshot,
  guardModelCall,
  MODEL_CALL_LANES,
  resetModelCallGuards,
  resolveModelCallLane,
} from "../rag/model-call-guard.js";
import { configureInProcessModelQuotas, resetInProcessModelQuotas } from "../rag/model-call-quota.js";
import { MODEL_GATEWAY_ERROR_CODES } from "../rag/model-gateway/protocol.js";
import {
  DATABASE_TENANT_CONTEXTS,
  getActiveDatabaseTenant,
  getDatabaseTenantContext,
  runWithDatabaseTenant,
} from "../rag/postgres-tenant.js";
import { recordLlmOpsMetric } from "../rag/llmops-metrics.js";
import { chargeActiveRunUsage } from "../rag/run-usage.js";
import { configureTenantUsageLedger, createTenantUsageLedger } from "../rag/tenant-usage.js";

// The ingest embedding batcher across tenants: per-tenant sub-queues taken in
// turn, merged requests sent as no tenant's call with each job's tenant
// admitted before its texts join and charged its share after, and per-tenant
// requests (the model gateway's path) sent as that tenant.

const SPACE = { dimensions: 3, key: "tenants|3", model: "tenants" };
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };
const silentLogger = { warn: () => {} };

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
    resetInProcessModelQuotas();
    resetModelCallGuards();
  });
};

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

// An in-process quota stand-in: records admissions and charges; `refuse`
// names the tenants (by userId) it refuses.
const createRecordingQuotas = ({ refuse = [] } = {}) => {
  const admitted = [];
  const charged = [];

  return {
    admitted,
    charged,
    quotas: {
      admit: async (tenant) => {
        admitted.push(tenant?.userId ?? null);
        return refuse.includes(tenant?.userId)
          ? { ok: false, quota: "requests_per_minute", retryAfterMs: 1234 }
          : { ok: true };
      },
      chargeTokens: async (tenant, tokens) => {
        charged.push([tenant?.userId ?? null, tokens]);
      },
      describe: () => ({ enabled: true, limits: {} }),
      enabled: true,
    },
  };
};

// Records each request's texts and the database context it ran in.
const createRecordingEmbed = ({ fail = null, meteredTokens = null } = {}) => {
  const calls = [];

  return {
    calls,
    embed: async (texts) => {
      calls.push({
        context: getDatabaseTenantContext(),
        tenant: getActiveDatabaseTenant()?.userId ?? null,
        texts: [...texts],
      });
      await new Promise((resolve) => setImmediate(resolve));

      const failure = fail?.(texts);

      if (failure) {
        throw failure;
      }

      if (meteredTokens !== null) {
        // What openai.js records for the call: one answered LLMOps event.
        chargeActiveRunUsage({ status: "ok", totalTokens: meteredTokens });
      }

      return texts.map((text) => [text.length, text.charCodeAt(0) || 0, 1]);
    },
  };
};

const vectorsOf = (texts) => texts.map((text) => [text.length, text.charCodeAt(0), 1]);

test("merged: several tenants' jobs share one request, sent as no tenant's, each tenant admitted and charged its share", async (t) => {
  withEnv(t, { MODEL_QUOTA_ENABLED: "true" });
  const quotas = createRecordingQuotas();
  const recorder = createRecordingEmbed({ meteredTokens: 30 });

  configureInProcessModelQuotas({ quotas: quotas.quotas });

  const batcher = createEmbeddingBatcher({
    embed: recorder.embed,
    estimateTokens: (text) => text.length,
    lingerMs: 20,
    maxConcurrency: 0,
    mergeAcrossTenants: true,
  });
  const jobs = await Promise.all([
    runWithDatabaseTenant(ALICE, () => batcher.embed(["aaaa", "aa"], SPACE)),
    runWithDatabaseTenant(BOB, () => batcher.embed(["bbbbbb"], SPACE)),
    batcher.embed(["cccccc"], SPACE),
  ]);

  assert.deepEqual(jobs, [vectorsOf(["aaaa", "aa"]), vectorsOf(["bbbbbb"]), vectorsOf(["cccccc"])]);
  // One request, the tenants' texts taken in turn. The job without a tenant
  // queued first: it has no quota to wait for.
  assert.deepEqual(recorder.calls, [
    { context: DATABASE_TENANT_CONTEXTS.system, tenant: null, texts: ["cccccc", "aaaa", "bbbbbb", "aa"] },
  ]);
  // Each job's tenant was admitted once, before its texts joined; the call
  // without a tenant is never admitted or charged.
  assert.deepEqual(quotas.admitted, ["alice", "bob"]);
  // 30 metered tokens over 6 + 6 + 6 estimated: 10 each.
  assert.deepEqual(quotas.charged, [
    ["alice", 10],
    ["bob", 10],
  ]);
  assert.equal(batcher.stats().batchedRequests, 1);
});

test("merged: a tenant over its quota fails only its own job, before it joins a batch", async (t) => {
  withEnv(t, { MODEL_QUOTA_ENABLED: "true" });
  const quotas = createRecordingQuotas({ refuse: ["alice"] });
  const recorder = createRecordingEmbed();

  configureInProcessModelQuotas({ quotas: quotas.quotas });

  const batcher = createEmbeddingBatcher({ embed: recorder.embed, lingerMs: 10, maxConcurrency: 0, mergeAcrossTenants: true });
  const [alice, bob] = await Promise.allSettled([
    runWithDatabaseTenant(ALICE, () => batcher.embed(["alice text"], SPACE)),
    runWithDatabaseTenant(BOB, () => batcher.embed(["bob text"], SPACE)),
  ]);

  assert.equal(alice.status, "rejected");
  assert.equal(alice.reason.status, 429);
  assert.equal(alice.reason.code, MODEL_GATEWAY_ERROR_CODES.quotaExceeded);
  assert.equal(alice.reason.retryAfterMs, 1234, "the ingest worker requeues it no earlier than the window ends");
  assert.deepEqual(bob, { status: "fulfilled", value: vectorsOf(["bob text"]) });
  assert.deepEqual(recorder.calls.map((call) => call.texts), [["bob text"]]);
  // Charged from the batch's estimate when the embed function meters nothing.
  assert.equal(quotas.charged.length, 1);
  assert.equal(quotas.charged[0][0], "bob");
});

test("merged: a failure of the shared request is recorded against every tenant it carried", async (t) => {
  withEnv(t, {
    RAG_LLM_CIRCUIT_COOLDOWN_MS: "60000",
    RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1",
    RAG_LLM_INGEST_MAX_CONCURRENCY: undefined,
    RAG_LLM_MAX_CONCURRENCY: "4",
    RAG_SHARED_STATE: "memory",
  });
  resetModelCallGuards();
  const key = "http://batch.test|ingest-model";
  const unavailable = Object.assign(new Error("HTTP 503"), { status: 503 });
  const batcher = createEmbeddingBatcher({
    embed: (texts) => guardModelCall(key, () => Promise.reject(unavailable), { lane: MODEL_CALL_LANES.ingest }),
    lingerMs: 10,
    logger: silentLogger,
    maxConcurrency: 0,
    mergeAcrossTenants: true,
  });
  const settled = await Promise.allSettled([
    runWithDatabaseTenant(ALICE, () => batcher.embed(["a"], SPACE)),
    runWithDatabaseTenant(BOB, () => batcher.embed(["b"], SPACE)),
  ]);

  assert.deepEqual(settled.map((result) => result.status), ["rejected", "rejected"]);

  // RAG_LLM_INGEST_MAX_CONCURRENCY unset: the ingest lane shares the
  // endpoint's one guard (resolveModelCallLane).
  const breaker = getModelCallGuardSnapshot(
    buildModelCallGuardKey(key, resolveModelCallLane(MODEL_CALL_LANES.ingest))
  ).breaker;

  // The merged request opened the circuit; it is attributed to both tenants,
  // not to whichever job happened to send it. The per-job re-sends then met
  // the open circuit and were never sent.
  assert.equal(breaker.state, "open");
  assert.deepEqual(
    breaker.openedBy,
    [describeModelCallTenantRef(ALICE), describeModelCallTenantRef(BOB)]
      .sort()
      .map((tenant) => ({ failures: 1, tenant }))
  );
});

test("per tenant (the model gateway's path): each request carries one tenant's texts and runs as that tenant", async (t) => {
  withEnv(t, { MODEL_QUOTA_ENABLED: "true" });
  const quotas = createRecordingQuotas();
  const rateLimited = Object.assign(new Error("over quota"), {
    code: MODEL_GATEWAY_ERROR_CODES.quotaExceeded,
    status: 429,
  });
  const recorder = createRecordingEmbed({ fail: (texts) => (texts.includes("b1") ? rateLimited : null) });

  configureInProcessModelQuotas({ quotas: quotas.quotas });

  const batcher = createEmbeddingBatcher({
    embed: recorder.embed,
    lingerMs: 20,
    logger: silentLogger,
    maxConcurrency: 0,
    mergeAcrossTenants: false,
  });
  const settled = await Promise.allSettled([
    runWithDatabaseTenant(ALICE, () => batcher.embed(["a1", "a2"], SPACE)),
    runWithDatabaseTenant(BOB, () => batcher.embed(["b1"], SPACE)),
    runWithDatabaseTenant(ALICE, () => batcher.embed(["a3"], SPACE)),
    batcher.embed(["s1"], SPACE),
  ]);

  assert.deepEqual(
    recorder.calls.map(({ context, tenant, texts }) => ({ context, tenant, texts })),
    [
      { context: DATABASE_TENANT_CONTEXTS.tenant, tenant: "alice", texts: ["a1", "a2", "a3"] },
      { context: DATABASE_TENANT_CONTEXTS.tenant, tenant: "bob", texts: ["b1"] },
      { context: DATABASE_TENANT_CONTEXTS.system, tenant: null, texts: ["s1"] },
    ]
  );
  // A 429 the gateway answers for Bob's own request fails Bob's job only.
  assert.deepEqual(settled.map((result) => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(settled[1].reason, rateLimited);
  // Admission and charging happen where each request is sent, not here.
  assert.deepEqual(quotas.admitted, []);
  assert.deepEqual(quotas.charged, []);
});

test("under a cap, a tenant behind another tenant's backlog leaves in the next request", async () => {
  for (const mergeAcrossTenants of [true, false]) {
    const gate = deferred();
    const calls = [];
    const batcher = createEmbeddingBatcher({
      embed: async (texts) => {
        calls.push([...texts]);

        if (calls.length === 1) {
          await gate.promise;
        }

        return texts.map(() => [0, 0, 1]);
      },
      lingerMs: 60_000,
      maxConcurrency: 1,
      maxItems: 2,
      mergeAcrossTenants,
    });
    const jobs = [runWithDatabaseTenant(ALICE, () => batcher.embed(["a0"], SPACE))];

    // The first job holds the only slot; Alice's backlog and then Bob's job wait.
    for (const text of ["a1", "a2", "a3", "a4"]) {
      jobs.push(runWithDatabaseTenant(ALICE, () => batcher.embed([text], SPACE)));
    }

    jobs.push(runWithDatabaseTenant(BOB, () => batcher.embed(["b0"], SPACE)));
    await new Promise((resolve) => setImmediate(resolve));
    gate.resolve();
    await Promise.all(jobs);

    assert.ok(
      calls.slice(0, 2).some((texts) => texts.includes("b0")),
      `${mergeAcrossTenants ? "merged" : "per tenant"}: ${JSON.stringify(calls)}`
    );
    assert.deepEqual(
      calls.flat().filter((text) => text.startsWith("a")),
      ["a0", "a1", "a2", "a3", "a4"],
      "one tenant's texts keep their order"
    );
  }
});

test("a merged request's tokens split over its tenants by estimated tokens, adding up to the total", () => {
  const entries = [
    { tenant: ALICE, tenantKey: "a", tokens: 1 },
    { tenant: BOB, tenantKey: "b", tokens: 1 },
    { tenant: null, tenantKey: "system", tokens: 1 },
    { tenant: ALICE, tenantKey: "a", tokens: 2 },
  ];
  const parts = splitEmbeddingTokensByTenant(entries, 10);

  assert.equal(parts.reduce((sum, part) => sum + part.tokens, 0), 10);
  assert.deepEqual(
    parts.map((part) => [part.tenant?.userId ?? null, part.estimated, part.tokens]),
    [
      ["alice", 3, 6],
      ["bob", 1, 2],
      [null, 1, 2],
    ]
  );
  assert.deepEqual(
    splitEmbeddingTokensByTenant(entries, 0).map((part) => part.tokens),
    [0, 0, 0]
  );
});

// The tenant usage ledger (rag/tenant-usage.js) as if a database were
// configured: never flushed by a timer, its flush written to `rows`.
const createRecordingLedger = () => {
  const rows = [];
  const ledger = createTenantUsageLedger({
    isDatabaseConfigured: () => true,
    isEnabled: () => true,
    query: async (text, values) => {
      values[0].forEach((workspaceId, index) =>
        rows.push({
          metric: values[2][index],
          userId: values[1][index],
          value: Number(values[4][index]),
          workspaceId,
        })
      );
      return { rows: [] };
    },
    runAsSystem: (callback) => callback(),
    setTimer: () => null,
  });
  const totals = async () => {
    await ledger.flush();
    return Object.fromEntries(
      [...new Set(rows.map((row) => `${row.workspaceId}/${row.userId}`))].sort().map((tenant) => [
        tenant,
        Object.fromEntries(
          rows
            .filter((row) => `${row.workspaceId}/${row.userId}` === tenant)
            .map((row) => [row.metric, row.value])
            .sort(([left], [right]) => left.localeCompare(right))
        ),
      ])
    );
  };

  return { ledger, totals };
};

// What openai.js records for an answered embeddings call: one LLMOps event,
// through the same recordLlmOpsMetric that charges the run meter and the
// ledger (the trace write goes nowhere).
const recordEmbeddingEvent = (totalTokens, estimatedCostUsd) =>
  recordLlmOpsMetric(
    { estimatedCostUsd, model: "tenants", operation: "embedding", status: "ok", totalTokens },
    { recorder: async () => {} }
  );

test("merged: the usage ledger books each tenant its share of a merged request, never the whole request under ('', '')", async (t) => {
  const { ledger, totals } = createRecordingLedger();

  configureTenantUsageLedger(ledger);
  t.after(() => configureTenantUsageLedger(null));

  const batcher = createEmbeddingBatcher({
    embed: async (texts) => {
      // 30 tokens and 30 micro-USD for 6 + 6 + 6 estimated tokens.
      await recordEmbeddingEvent(30, 0.00003);
      return texts.map((text) => [text.length, text.charCodeAt(0), 1]);
    },
    estimateTokens: (text) => text.length,
    lingerMs: 20,
    maxConcurrency: 0,
    mergeAcrossTenants: true,
  });

  await Promise.all([
    runWithDatabaseTenant(ALICE, () => batcher.embed(["aaaa", "aa"], SPACE)),
    runWithDatabaseTenant(BOB, () => batcher.embed(["bbbbbb"], SPACE)),
    batcher.embed(["cccccc"], SPACE),
  ]);

  assert.equal(batcher.stats().batchedRequests, 1);
  assert.deepEqual(await totals(), {
    // The job without a tenant keeps its own share under ('', '').
    "/": { model_cost_micro_usd: 10, model_tokens: 10 },
    "ws-a/alice": { model_cost_micro_usd: 10, model_tokens: 10 },
    "ws-b/bob": { model_cost_micro_usd: 10, model_tokens: 10 },
  });
});

test("merged: a request that fails after a metered call still books the paid usage per tenant", async (t) => {
  const { ledger, totals } = createRecordingLedger();
  const rateLimited = Object.assign(new Error("rate limited"), { status: 429 });

  configureTenantUsageLedger(ledger);
  t.after(() => configureTenantUsageLedger(null));

  const batcher = createEmbeddingBatcher({
    embed: async () => {
      // One sub-request answered (and paid for), the next refused.
      await recordEmbeddingEvent(8, 0);
      throw rateLimited;
    },
    estimateTokens: (text) => text.length,
    lingerMs: 20,
    logger: silentLogger,
    maxConcurrency: 0,
    mergeAcrossTenants: true,
  });
  const settled = await Promise.allSettled([
    runWithDatabaseTenant(ALICE, () => batcher.embed(["aaaa"], SPACE)),
    runWithDatabaseTenant(BOB, () => batcher.embed(["bbbb"], SPACE)),
  ]);

  assert.deepEqual(settled.map((result) => result.status), ["rejected", "rejected"]);
  assert.deepEqual(await totals(), {
    "ws-a/alice": { model_tokens: 4 },
    "ws-b/bob": { model_tokens: 4 },
  });
});

test("per tenant: each request's usage reaches the ledger under its own tenant, as any call's does", async (t) => {
  const { ledger, totals } = createRecordingLedger();

  configureTenantUsageLedger(ledger);
  t.after(() => configureTenantUsageLedger(null));

  const batcher = createEmbeddingBatcher({
    embed: async (texts) => {
      await recordEmbeddingEvent(texts.length * 5, 0);
      return texts.map(() => [0, 0, 1]);
    },
    lingerMs: 20,
    maxConcurrency: 0,
    mergeAcrossTenants: false,
  });

  await Promise.all([
    runWithDatabaseTenant(ALICE, () => batcher.embed(["a1", "a2"], SPACE)),
    runWithDatabaseTenant(BOB, () => batcher.embed(["b1"], SPACE)),
  ]);

  assert.deepEqual(await totals(), {
    "ws-a/alice": { model_tokens: 10 },
    "ws-b/bob": { model_tokens: 5 },
  });
});
