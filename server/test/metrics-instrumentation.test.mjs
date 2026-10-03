import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { createIngestWorker } from "../rag/ingest-worker.js";
import { LLMOPS_OPERATIONS, recordLlmOpsMetric } from "../rag/llmops-metrics.js";
import { getMetricsRegistry, setMetricsEnabled } from "../rag/metrics.js";
import {
  AGENT_RUN_OUTCOMES,
  classifyAgentRunError,
  classifyAgentRunResponse,
  observeAgentRun,
  recordAgentStep,
} from "../rag/metrics-agent.js";
import {
  createIngestQueueCollector,
  instrumentIngestStages,
  recordIngestAttemptOutcome,
  recordIngestStageFailure,
} from "../rag/metrics-ingest.js";
import {
  collectModelCallGuards,
  recordGatewayQuotaRejection,
  resolveModelMetering,
  toGuardModelLabel,
} from "../rag/metrics-model.js";
import {
  applyReplicaRoutingSnapshot,
  classifyPostgresError,
  collectPostgresPool,
  collectReplicaRouting,
  notePostgresStatementError,
} from "../rag/metrics-postgres.js";
import { collectProcessMetrics, startProcessMetrics, stopProcessMetrics } from "../rag/metrics-process.js";
import {
  collectSemanticCache,
  instrumentVectorStoreSearch,
  observeRerank,
  timeRetrievalRoute,
} from "../rag/metrics-retrieval.js";
import {
  classifyServiceCallError,
  collectServiceClients,
  instrumentServiceClient,
  recordServiceFailover,
} from "../rag/metrics-service-client.js";
import { guardModelCall, resetModelCallGuards } from "../rag/model-call-guard.js";
import { runWithModelGatewayCall } from "../rag/model-gateway/call-context.js";
import { MODEL_GATEWAY_MIRROR_ANNOTATION } from "../rag/model-gateway/protocol.js";
import { queryPostgres, resetPostgresPool, withPostgresTransaction } from "../rag/postgres.js";
import { configureReadReplicaRouting, pollReadReplicasNow } from "../rag/postgres-replicas.js";
import { configureCustomRerankProvider, rerankResultsOrKeepOrder, resetCustomRerankProvider } from "../rag/reranker.js";
import { createServiceClient, getServiceClient, resetServiceClients } from "../rag/service-client.js";
import { checkHistogram, parseExposition, sampleValue } from "./metrics-exposition.mjs";

// The instrumentation modules (rag/metrics-*.js) and their one-line hooks in
// llmops-metrics.js, model-call-guard.js, the model gateway, agent.js,
// vector-store.js, reranker.js, ingest-worker.js, postgres.js and
// service-client.js. Each test reads the default registry before and after,
// so the order of tests does not matter. No model, database or network
// beyond 127.0.0.1.

const registry = getMetricsRegistry();
const quietLogger = { error() {}, log() {}, warn() {} };

const read = async () => parseExposition(await registry.expose());

const withEnv = async (overrides, work) => {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));

  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });

  try {
    return await work();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
};

const closedPort = async () => {
  const server = http.createServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address();

  await new Promise((resolve) => server.close(resolve));
  return port;
};

before(() => setMetricsEnabled(true));
after(() => setMetricsEnabled(null));

test("hooks record nothing while metrics are off", async () => {
  setMetricsEnabled(false);

  try {
    const before = await read();

    await recordLlmOpsMetric(
      { latencyMs: 5, modelRoute: { modelId: "off.model" }, operation: LLMOPS_OPERATIONS.completion, status: "ok" },
      { recorder: async () => {} }
    );
    recordAgentStep({ status: "completed", type: "plan" });
    recordGatewayQuotaRejection("daily_tokens");
    await observeAgentRun(async () => ({ body: {}, status: 200 }));

    const implementation = { searchDenseDocuments: async () => [] };

    assert.equal(instrumentVectorStoreSearch(implementation), implementation);
    assert.equal(instrumentIngestStages(implementation), implementation);
    assert.equal(instrumentServiceClient(implementation), implementation);

    const after = await read();

    assert.equal(sampleValue(after, "archive_rag_model_calls_total", { model: "off.model" }), 0);
    assert.equal(
      sampleValue(after, "archive_rag_agent_runs_total"),
      sampleValue(before, "archive_rag_agent_runs_total")
    );
    assert.equal(
      sampleValue(after, "archive_rag_model_gateway_quota_rejections_total"),
      sampleValue(before, "archive_rag_model_gateway_quota_rejections_total")
    );
  } finally {
    setMetricsEnabled(true);
  }
});

test("every LLMOps event becomes model call, latency, token and cost series with its metering side", async () => {
  const recorded = [];
  const recorder = async (event) => recorded.push(event);
  const base = {
    estimatedCostUsd: 0.002,
    inputTokens: 400,
    latencyMs: 1500,
    modelRoute: { modelId: "openai.chat", providerId: "openai" },
    operation: LLMOPS_OPERATIONS.completion,
    outputTokens: 20,
    status: "ok",
  };
  const before = await read();

  await recordLlmOpsMetric(base, { recorder });
  await recordLlmOpsMetric({ ...base, annotations: [MODEL_GATEWAY_MIRROR_ANNOTATION] }, { recorder });
  await runWithModelGatewayCall({ meter: (event) => event }, () =>
    recordLlmOpsMetric({ ...base, error: new Error("upstream said: secret prompt text"), status: "error" }, { recorder })
  );
  await recordLlmOpsMetric(
    { latencyMs: 30, modelRoute: { modelId: "openai.embedding" }, operation: LLMOPS_OPERATIONS.embedding, status: "ok" },
    { recorder }
  );

  const after = await read();
  const delta = (name, labels) => sampleValue(after, name, labels) - sampleValue(before, name, labels);

  assert.equal(recorded.length, 4, "the LLMOps events are still written");
  assert.equal(delta("archive_rag_model_calls_total", { metering: "direct", model: "openai.chat", operation: "llm_completion", status: "ok" }), 1);
  assert.equal(delta("archive_rag_model_calls_total", { metering: "mirror", model: "openai.chat", status: "ok" }), 1);
  assert.equal(delta("archive_rag_model_calls_total", { metering: "gateway", model: "openai.chat", status: "error" }), 1);
  assert.equal(delta("archive_rag_model_calls_total", { metering: "direct", model: "openai.embedding", operation: "embedding" }), 1);
  assert.equal(delta("archive_rag_model_tokens_total", { direction: "input", metering: "direct", model: "openai.chat" }), 400);
  assert.equal(delta("archive_rag_model_tokens_total", { direction: "output", metering: "direct", model: "openai.chat" }), 20);
  assert.equal(delta("archive_rag_model_estimated_cost_usd_total", { metering: "direct", model: "openai.chat" }), 0.002);
  assert.equal(delta("archive_rag_model_call_duration_seconds_sum", { metering: "direct", model: "openai.chat" }), 1.5);
  checkHistogram(after.get("archive_rag_model_call_duration_seconds"));
  assert.equal(resolveModelMetering({ annotations: [MODEL_GATEWAY_MIRROR_ANNOTATION] }), "mirror");
  assert.equal(resolveModelMetering({}), "direct");
  assert.equal((await registry.expose()).includes("secret prompt text"), false);
});

test("guard state is read on scrape by model name, never by endpoint URL", async () => {
  await withEnv({ RAG_LLM_CIRCUIT_COOLDOWN_MS: "600000", RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "2" }, async () => {
    resetModelCallGuards();

    const failing = "http://upstream-a.internal:8000/v1|gpt-test";
    const busy = "http://upstream-b.internal:8000/v1|gpt-test";
    const unavailable = () => Promise.reject(Object.assign(new Error("HTTP 503"), { status: 503 }));

    await assert.rejects(guardModelCall(failing, unavailable));
    await assert.rejects(guardModelCall(failing, unavailable));
    await assert.rejects(guardModelCall(failing, unavailable), /Circuit open/u);

    let release;
    const held = guardModelCall(busy, () => new Promise((resolve) => (release = resolve)));

    while (!release) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    collectModelCallGuards();

    const families = parseExposition(registry.render());

    assert.equal(sampleValue(families, "archive_rag_model_circuits", { model: "gpt-test", state: "open" }), 1);
    assert.equal(sampleValue(families, "archive_rag_model_circuits", { model: "gpt-test", state: "closed" }), 1);
    assert.equal(sampleValue(families, "archive_rag_model_guard_in_flight", { model: "gpt-test" }), 1);
    assert.equal(registry.render().includes("upstream-a.internal"), false);

    release("done");
    await held;
    resetModelCallGuards();
    collectModelCallGuards();
    assert.equal(sampleValue(parseExposition(registry.render()), "archive_rag_model_circuits"), 0, "a reset guard map leaves no stale model");
  });

  assert.equal(toGuardModelLabel("http://x:1/v1|qwen2.5:7b"), "qwen2.5:7b");
  assert.equal(toGuardModelLabel("no-separator"), "unknown");
});

test("gateway quota rejections are counted by quota kind", async () => {
  const before = await read();

  recordGatewayQuotaRejection("tokens_per_minute");
  recordGatewayQuotaRejection("tenant-alice");

  const after = await read();
  const delta = (quota) =>
    sampleValue(after, "archive_rag_model_gateway_quota_rejections_total", { quota }) -
    sampleValue(before, "archive_rag_model_gateway_quota_rejections_total", { quota });

  assert.equal(delta("tokens_per_minute"), 1);
  assert.equal(delta("other"), 1, "an unknown quota name never becomes a label");
});

test("agent runs are classified into fixed outcomes and reasons, with their duration", async () => {
  const before = await read();
  const question = "What is the salary of employee 4471?";

  await observeAgentRun(async () => ({ body: { agentMode: "document", question }, status: 200 }));
  await observeAgentRun(async () => ({ body: { ragAbstained: true }, status: 200 }));
  await observeAgentRun(async () => ({
    body: { agentMode: "clarification", clarification: { needed: true, question, reason: "missing_required_documents" } },
    status: 200,
  }));
  await observeAgentRun(async () => ({ body: { error: question }, status: 500 }));
  await assert.rejects(
    observeAgentRun(async () => {
      throw Object.assign(new Error(question), { code: "AGENT_DEADLINE_EXCEEDED", name: "RequestCancelledError" });
    }),
    /salary/u
  );
  await assert.rejects(observeAgentRun(async () => {
    throw new Error(question);
  }));

  recordAgentStep({ label: question, status: "completed", type: "document_rag" });
  recordAgentStep({ status: "failed", type: question });

  const after = await read();
  const delta = (labels) =>
    sampleValue(after, "archive_rag_agent_runs_total", labels) - sampleValue(before, "archive_rag_agent_runs_total", labels);

  assert.equal(delta({ outcome: "completed", reason: "answered" }), 1);
  assert.equal(delta({ outcome: "completed", reason: "abstained" }), 1);
  assert.equal(delta({ outcome: "clarification", reason: "missing_required_documents" }), 1);
  assert.equal(delta({ outcome: "failed", reason: "http_5xx" }), 1);
  assert.equal(delta({ outcome: "failed", reason: "deadline_exceeded" }), 1);
  assert.equal(delta({ outcome: "failed", reason: "error" }), 1);
  assert.equal(
    sampleValue(after, "archive_rag_agent_run_duration_seconds_count") -
      sampleValue(before, "archive_rag_agent_run_duration_seconds_count"),
    6
  );
  assert.equal(
    sampleValue(after, "archive_rag_agent_steps_total", { status: "completed", type: "document_rag" }) -
      sampleValue(before, "archive_rag_agent_steps_total", { status: "completed", type: "document_rag" }),
    1
  );
  assert.ok(sampleValue(after, "archive_rag_agent_steps_total", { status: "failed", type: "other" }) >= 1);
  assert.equal((await registry.expose()).includes("4471"), false, "no question text in any label");

  assert.deepEqual(classifyAgentRunError({ code: "AGENT_CLIENT_CANCELLED", name: "RequestCancelledError" }), {
    outcome: AGENT_RUN_OUTCOMES.cancelled,
    reason: "client_cancelled",
  });
  assert.equal(classifyAgentRunError({ name: "AbortError" }).outcome, AGENT_RUN_OUTCOMES.cancelled);
  assert.equal(classifyAgentRunError({ name: "AbortError" }).reason, "aborted");
  assert.deepEqual(
    classifyAgentRunError({ code: "AGENT_DEPENDENCY_UNAVAILABLE", dependency: "database", name: "DependencyOutageError" }),
    { outcome: AGENT_RUN_OUTCOMES.failed, reason: "dependency_database" }
  );
  assert.equal(classifyAgentRunError({ code: "AGENT_DEPENDENCY_TIMEOUT", dependency: "host-a" }).reason, "dependency_other");
  assert.equal(classifyAgentRunError({ name: "LlmOpsBudgetExceededError" }).reason, "budget_exceeded");
  assert.equal(classifyAgentRunError({ code: "CIRCUIT_OPEN" }).reason, "circuit_open");
  assert.equal(classifyAgentRunError({ code: "MODEL_GATEWAY_UNAVAILABLE" }).reason, "model_unavailable");
  assert.equal(classifyAgentRunError({ code: "SERVICE_UNREACHABLE" }).reason, "service_unavailable");
  assert.equal(classifyAgentRunResponse({ body: {}, status: 499 }).reason, "client_cancelled");
  assert.equal(classifyAgentRunResponse({ body: { code: "AGENT_DEADLINE_EXCEEDED" }, status: 504 }).reason, "deadline_exceeded");
  assert.equal(classifyAgentRunResponse({ body: {}, status: 404 }).reason, "http_4xx");
  assert.equal(
    classifyAgentRunResponse({ body: { clarification: { needed: true, reason: "Free text?" } }, status: 200 }).reason,
    "other"
  );
});

test("retrieval routes record latency and candidates; rerank is timed only while it is on and its failures count", async () => {
  const before = await read();
  const implementation = {
    id: "fake",
    searchDenseDocuments: async ({ topK }) => Array.from({ length: topK }, (unused, index) => ({ id: index })),
    searchSparseDocuments: async () => {
      throw new Error("sparse down");
    },
    writeDocuments: () => "untouched",
  };
  const instrumented = instrumentVectorStoreSearch(implementation);

  assert.equal((await instrumented.searchDenseDocuments({ topK: 7 })).length, 7);
  await assert.rejects(instrumented.searchSparseDocuments({}), /sparse down/u);
  assert.equal(instrumented.writeDocuments(), "untouched");
  assert.equal(instrumented.id, "fake");
  await timeRetrievalRoute("hybrid", async () => ({ results: [1, 2, 3] }));

  await withEnv({ RAG_RERANK_ENABLED: "false" }, async () => {
    assert.deepEqual(await observeRerank(async () => ["kept"]), ["kept"]);
  });

  await withEnv({ RAG_RERANK_ENABLED: "true", RAG_RERANK_PROVIDER: "custom" }, async () => {
    configureCustomRerankProvider({
      rerank: async () => {
        throw new Error("reranker unreachable");
      },
    });

    try {
      const results = [{ id: "a" }, { id: "b" }, { id: "c" }];
      const originalWarn = console.warn;

      console.warn = () => {};

      try {
        assert.deepEqual(await rerankResultsOrKeepOrder({ queryText: "q", results, topK: 2 }), results.slice(0, 2));
      } finally {
        console.warn = originalWarn;
      }

      configureCustomRerankProvider({ rerank: async ({ results: input }) => [...input].reverse() });
      assert.deepEqual(
        (await rerankResultsOrKeepOrder({ queryText: "q", results, topK: 2 })).map((entry) => entry.id),
        ["c", "b"]
      );
    } finally {
      resetCustomRerankProvider();
    }
  });

  const after = await read();
  const delta = (name, labels) => sampleValue(after, name, labels) - sampleValue(before, name, labels);

  assert.equal(delta("archive_rag_retrieval_route_duration_seconds_count", { outcome: "ok", route: "dense" }), 1);
  assert.equal(delta("archive_rag_retrieval_route_duration_seconds_count", { outcome: "error", route: "sparse" }), 1);
  assert.equal(delta("archive_rag_retrieval_route_duration_seconds_count", { route: "hybrid" }), 1);
  assert.equal(delta("archive_rag_retrieval_route_candidates_sum", { route: "dense" }), 7);
  assert.equal(delta("archive_rag_retrieval_route_candidates_sum", { route: "hybrid" }), 3);
  assert.equal(delta("archive_rag_retrieval_route_duration_seconds_count", { outcome: "error", route: "rerank" }), 1);
  assert.equal(delta("archive_rag_retrieval_route_duration_seconds_count", { outcome: "ok", route: "rerank" }), 1, "rerank off was not timed");
  assert.equal(delta("archive_rag_retrieval_rerank_degradations_total"), 1);
  checkHistogram(after.get("archive_rag_retrieval_route_duration_seconds"));
  checkHistogram(after.get("archive_rag_retrieval_route_candidates"));

  await withEnv({ RAG_SEMANTIC_CACHE: "on" }, () => collectSemanticCache());

  const cache = parseExposition(registry.render());

  assert.equal(cache.get("archive_rag_semantic_cache_lookups_total").samples.length, 3);
});

test("the ingest worker records stage durations, retries by stage and attempt outcomes", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "metrics-ingest-"));
  let now = Date.parse("2026-10-02T10:00:00.000Z");
  const store = createInMemoryIngestJobStore({ now: () => now });
  let embedFailures = 1;
  const pipeline = {
    chunk: async ({ inputs }) => ({ output: Buffer.from(`chunks <- ${inputs.pages}`) }),
    embed: async ({ inputs }) => {
      if (embedFailures > 0) {
        embedFailures -= 1;
        throw Object.assign(new Error("embedding model unavailable"), { retryable: true });
      }

      return { output: Buffer.from(`embeddings <- ${inputs.chunks}`) };
    },
    index: async ({ job, onCommit }) => {
      await onCommit?.({ client: null, docId: job.docId, documentVersion: 1, duplicate: false });
      return { docId: job.docId, documentVersion: 1, duplicate: false, superseded: false };
    },
    parse: async ({ filePath }) => ({ output: Buffer.from(`pages: ${(await readFile(filePath)).length}`) }),
  };
  const worker = createIngestWorker({
    leaseMs: 60000,
    logger: quietLogger,
    pipeline,
    renewIntervalMs: 60000,
    retryDelayMs: () => 0,
    settleRetryDelayMs: 1,
    store,
    tempDirectory,
    workerId: "metrics-worker",
  });

  try {
    const before = await read();

    await store.enqueue({
      docId: "doc-metrics",
      fileBytes: Buffer.from("%PDF-1.4 metrics fixture"),
      fileName: "notes.pdf",
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });

    assert.equal((await worker.runOnce()).outcome, "queued");
    now += 1;
    assert.equal((await worker.runOnce()).outcome, "succeeded");

    const after = await read();
    const delta = (name, labels) => sampleValue(after, name, labels) - sampleValue(before, name, labels);

    assert.equal(delta("archive_rag_ingest_stage_failures_total", { result: "retry", stage: "embed" }), 1);
    assert.equal(delta("archive_rag_ingest_job_attempts_total", { outcome: "queued" }), 1);
    assert.equal(delta("archive_rag_ingest_job_attempts_total", { outcome: "succeeded" }), 1);
    assert.equal(delta("archive_rag_ingest_stage_duration_seconds_count", { outcome: "ok", stage: "parse" }), 1);
    assert.equal(delta("archive_rag_ingest_stage_duration_seconds_count", { outcome: "error", stage: "embed" }), 1);
    assert.equal(delta("archive_rag_ingest_stage_duration_seconds_count", { outcome: "ok", stage: "embed" }), 1);
    assert.equal(delta("archive_rag_ingest_stage_duration_seconds_count", { outcome: "ok", stage: "index" }), 1);
    checkHistogram(after.get("archive_rag_ingest_stage_duration_seconds"));
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }

  assert.equal(instrumentIngestStages(null), null);
  assert.equal(instrumentIngestStages(pipeline), instrumentIngestStages(pipeline), "wrapped once per pipeline");
  assert.equal(recordIngestAttemptOutcome("lease_lost"), "lease_lost");

  const before = await read();

  recordIngestStageFailure("parse", "dead_letter");
  recordIngestStageFailure("parse", null);
  recordIngestStageFailure("../etc", "failed");

  const after = await read();
  const delta = (labels) =>
    sampleValue(after, "archive_rag_ingest_stage_failures_total", labels) -
    sampleValue(before, "archive_rag_ingest_stage_failures_total", labels);

  assert.equal(delta({ result: "dead_letter", stage: "parse" }), 1);
  assert.equal(delta({ result: "lease_lost", stage: "parse" }), 1);
  assert.equal(delta({ result: "failed", stage: "other" }), 1);
});

test("the queue depth is read at most once per window and shared by concurrent scrapes", async () => {
  let now = 0;
  let reads = 0;
  let fail = false;
  const store = {
    countByStatus: async () => {
      reads += 1;

      if (fail) {
        throw new Error("database unavailable");
      }

      return { dead_letter: 2, failed: 0, queued: 5, running: 1, succeeded: 9 };
    },
  };
  const collect = createIngestQueueCollector({ cacheMs: 15000, now: () => now, store });

  await Promise.all([collect(), collect(), collect()]);
  assert.equal(reads, 1, "concurrent scrapes share one read");
  now = 14999;
  await collect();
  assert.equal(reads, 1, "inside the window nothing is read");

  let families = parseExposition(registry.render());

  assert.equal(sampleValue(families, "archive_rag_ingest_jobs", { status: "queued" }), 5);
  assert.equal(sampleValue(families, "archive_rag_ingest_dead_letter_jobs"), 2);

  now = 15000;
  fail = true;
  await assert.rejects(collect(), /database unavailable/u);
  assert.equal(reads, 2);
  now = 20000;
  await collect();
  assert.equal(reads, 2, "a failed read waits out the window too");
  families = parseExposition(registry.render());
  assert.equal(sampleValue(families, "archive_rag_ingest_jobs", { status: "queued" }), 5, "values survive a failed read");
});

test("PostgreSQL failures are counted by SQLSTATE class through the pool hooks, and replicas are read when present", async () => {
  assert.equal(classifyPostgresError({ code: "23505" }), "23");
  assert.equal(classifyPostgresError({ code: "40001" }), "40");
  assert.equal(classifyPostgresError({ code: "ECONNREFUSED" }), "network");
  assert.equal(classifyPostgresError({ code: "ARCHIVE_RAG_TENANT_PIPELINE_STATUS" }), "tenant_pipeline");
  assert.equal(classifyPostgresError({ message: "timeout exceeded when trying to connect" }), "pool_timeout");
  assert.equal(classifyPostgresError({ message: "Query read timeout" }), "client_timeout");
  assert.equal(classifyPostgresError({ code: "P0001" }), "P0");
  assert.equal(classifyPostgresError({ code: "EPIPE" }), "network");
  assert.equal(classifyPostgresError({ code: "ABORT" }), null, "five capitals are not a SQLSTATE");
  assert.equal(classifyPostgresError(new Error("CAS conflict in the run store")), null);

  // A closed local port: the pool's first connection is refused.
  const port = await closedPort();
  const before = await read();

  await withEnv({ POSTGRES_DATABASE_URL: `postgres://metrics:none@127.0.0.1:${port}/none`, POSTGRES_ROW_LEVEL_SECURITY: "off" }, async () => {
    await resetPostgresPool();

    try {
      await assert.rejects(queryPostgres("SELECT 1"));
      await assert.rejects(withPostgresTransaction(async () => null));
      await collectPostgresPool();
    } finally {
      await resetPostgresPool();
    }
  });

  notePostgresStatementError(new Error("not a database error"));

  const after = await read();

  assert.equal(
    sampleValue(after, "archive_rag_postgres_statement_errors_total", { sqlstate_class: "network" }) -
      sampleValue(before, "archive_rag_postgres_statement_errors_total", { sqlstate_class: "network" }),
    2
  );
  assert.equal(sampleValue(after, "archive_rag_postgres_pool_clients", { state: "waiting" }), 0);

  await collectPostgresPool();
  assert.equal(parseExposition(registry.render()).get("archive_rag_postgres_pool_clients").samples.length, 0, "no pool, no series");

  // With replica routing off (or without rag/postgres-replicas.js) reading
  // the router is a no-op, not an error.
  await collectReplicaRouting();

  applyReplicaRoutingSnapshot({
    fallbacksByReason: { lag_exceeded: 3 },
    maxLagMs: 5000,
    readsByTarget: { primary: 10, replica: 40 },
    replicas: [
      { lagSeconds: 0.5, url: "postgres://secret@replica-1" },
      { lagMs: 7000 },
      { endpoint: "db-replica.internal:5432", id: "replica-2", lagMs: 250 },
      { id: "db-replica.internal", lagMs: 100 },
    ],
  });

  let families = parseExposition(registry.render());

  assert.equal(sampleValue(families, "archive_rag_postgres_reads_total", { target: "replica" }), 40);
  assert.equal(sampleValue(families, "archive_rag_postgres_replica_fallbacks_total", { reason: "lag_exceeded" }), 3);
  assert.equal(sampleValue(families, "archive_rag_postgres_replica_lag_seconds", { replica: "1" }), 7);
  assert.equal(sampleValue(families, "archive_rag_postgres_replica_lag_seconds", { replica: "replica-2" }), 0.25);
  assert.equal(sampleValue(families, "archive_rag_postgres_replica_lag_seconds", { replica: "3" }), 0.1, "a host name is not an id");
  assert.equal(sampleValue(families, "archive_rag_postgres_replica_max_lag_seconds"), 5);
  assert.equal(registry.render().includes("secret@replica"), false);
  assert.equal(registry.render().includes("replica.internal"), false);

  applyReplicaRoutingSnapshot({ lagSeconds: 1, maxLagSeconds: 2, reads: { primary: 11 } });
  families = parseExposition(registry.render());
  assert.equal(sampleValue(families, "archive_rag_postgres_replica_lag_seconds", { replica: "0" }), 1);
  assert.equal(families.get("archive_rag_postgres_replica_lag_seconds").samples.length, 1);
});

test("the replica router is read on scrape only where retrieval runs, so a scrape never starts its lag monitor elsewhere", async () => {
  // The real router (rag/postgres-replicas.js) with a pool factory that only
  // counts: reading its snapshot starts the lag monitor, which polls the
  // primary and every replica from then on. The health report runs that
  // check only in a process that retrieves (health.js), and a scrape must
  // not start it anywhere else.
  const created = [];
  const refusedPool = () => ({
    connect: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
    end: async () => {},
    on() {},
    query: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
  });
  const replicaEnvironment = {
    AGENT_SERVICE_URL: undefined,
    POSTGRES_DATABASE_URL: "postgres://metrics:none@127.0.0.1:1/never-connected",
    POSTGRES_READ_REPLICA_MAX_LAG_MS: "4000",
    POSTGRES_READ_REPLICA_URLS: "postgres://metrics:none@127.0.0.1:1/never-connected-replica",
    RETRIEVAL_SERVICE_URL: undefined,
  };

  await configureReadReplicaRouting({
    createPool: (options) => {
      created.push(options.application_name ?? "read");
      return refusedPool();
    },
  });

  try {
    for (const overrides of [
      { ARCHIVE_RAG_ROLE: "api" },
      { ARCHIVE_RAG_ROLE: "model-gateway" },
      { ARCHIVE_RAG_ROLE: "agent", RETRIEVAL_SERVICE_URL: "http://127.0.0.1:1" },
    ]) {
      await withEnv({ ...replicaEnvironment, ...overrides }, () => collectReplicaRouting());
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(created, [], `a scrape of role ${overrides.ARCHIVE_RAG_ROLE} opened no replica or poll pool`);
    }

    // The monolith retrieves in process: its scrape reports the router.
    await withEnv({ ...replicaEnvironment, ARCHIVE_RAG_ROLE: undefined }, async () => {
      await collectReplicaRouting();
      await pollReadReplicasNow();
    });

    const families = parseExposition(registry.render());

    assert.ok(created.length > 0, "the monolith's scrape read the router");
    assert.equal(sampleValue(families, "archive_rag_postgres_replica_max_lag_seconds"), 4);
    assert.ok(families.get("archive_rag_postgres_reads_total").samples.some((sample) => sample.labels.target === "replica"));
    assert.ok(
      families.get("archive_rag_postgres_replica_fallbacks_total").samples.some((sample) => sample.labels.reason === "lag_exceeded")
    );
  } finally {
    await configureReadReplicaRouting({});
  }
});

test("service client calls are counted by tier and code, failovers by tier, and replica state is read on scrape", async () => {
  const env = { ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_KEYS: `k1:${"m".repeat(48)}` };
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const fetchStub = async (url) => {
    if (url.startsWith("http://127.0.0.1:1")) {
      throw refused;
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" }, status: 200 });
  };
  const before = await read();
  const client = createServiceClient({
    audience: "retrieval",
    env,
    fetch: fetchStub,
    urls: ["http://127.0.0.1:1", "http://127.0.0.1:2"],
  });

  // The first pick is the first replica: refused, then the second answers.
  assert.equal((await client.request({ path: "/x", system: true })).status, 200);

  const down = createServiceClient({ audience: "retrieval", env, fetch: fetchStub, urls: ["http://127.0.0.1:1"] });

  await assert.rejects(down.request({ path: "/x", system: true }), (error) => error.code === "SERVICE_UNREACHABLE");

  const after = await read();
  const delta = (name, labels) => sampleValue(after, name, labels) - sampleValue(before, name, labels);

  assert.equal(delta("archive_rag_service_client_calls_total", { code: "2xx", tier: "retrieval" }), 1);
  assert.equal(delta("archive_rag_service_client_calls_total", { code: "SERVICE_UNREACHABLE", tier: "retrieval" }), 1);
  assert.equal(delta("archive_rag_service_client_failovers_total", { tier: "retrieval" }), 1);
  assert.equal(registry.render().includes("127.0.0.1:2"), false, "no replica URL in any label");

  recordServiceFailover("https://agent.internal");
  assert.equal(classifyServiceCallError({ code: "SERVICE_TIMEOUT" }), "SERVICE_TIMEOUT");
  assert.equal(classifyServiceCallError({ name: "AbortError" }), "ABORTED");
  assert.equal(classifyServiceCallError(new Error("x")), "ERROR");

  resetServiceClients();
  getServiceClient("retrieval", { env: { ...env, RETRIEVAL_SERVICE_URL: "http://127.0.0.1:7001,http://127.0.0.1:7002" } });
  await collectServiceClients();

  const families = parseExposition(registry.render());

  assert.equal(sampleValue(families, "archive_rag_service_client_replicas", { tier: "retrieval" }), 2);
  assert.equal(sampleValue(families, "archive_rag_service_client_unhealthy_replicas", { tier: "retrieval" }), 0);
  assert.equal(sampleValue(families, "archive_rag_service_client_in_flight", { tier: "retrieval" }), 0);
  resetServiceClients();
});

test("process metrics report CPU, memory, heap and the event loop's p99 delay", async () => {
  startProcessMetrics();
  await new Promise((resolve) => setTimeout(resolve, 30));
  collectProcessMetrics();

  const families = parseExposition(registry.render());

  stopProcessMetrics();
  assert.ok(sampleValue(families, "process_cpu_seconds_total") > 0);
  assert.ok(sampleValue(families, "process_resident_memory_bytes") > 0);
  assert.ok(sampleValue(families, "nodejs_heap_size_total_bytes") >= sampleValue(families, "nodejs_heap_size_used_bytes"));
  assert.ok(sampleValue(families, "process_start_time_seconds") <= Date.now() / 1000);
  assert.ok(sampleValue(families, "nodejs_eventloop_delay_p99_seconds") >= 0);
});
