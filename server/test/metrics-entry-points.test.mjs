import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runIngestWorkerProcess } from "../ingest-worker.mjs";
import { runModelGatewayProcess } from "../model-gateway.mjs";
import { runRetrievalServiceProcess } from "../retrieval-service.mjs";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { setMetricsEnabled } from "../rag/metrics.js";
import { parseExposition, sampleValue } from "./metrics-exposition.mjs";

// The dedicated entry points of the split roles -- `node model-gateway.mjs`,
// `node retrieval-service.mjs` and the ingest worker (`npm run worker:ingest`)
// -- start the /metrics listener with METRICS_ENABLED=true, as server.js and
// role-server.js do, and close it on shutdown. Nothing here connects to a
// database: the PostgreSQL URLs point at a closed port and are never used.

const SECRET = `${"m".repeat(24)}-entry-points-0123456789`;
const METRICS_TOKEN = randomBytes(16).toString("hex");
const METRICS_ENVIRONMENT = { METRICS_ENABLED: "true", METRICS_PORT: "0", METRICS_TOKEN };
const KEYS = [
  "ARCHIVE_RAG_ROLE",
  "DOCCOMPARE_STANDALONE",
  "INTERNAL_SERVICE_KEYS",
  "LONG_MEMORY_DATABASE_URL",
  "METRICS_ENABLED",
  "METRICS_HOST",
  "METRICS_PORT",
  "METRICS_TOKEN",
  "MODEL_GATEWAY_PORT",
  "MODEL_GATEWAY_URL",
  "OTEL_TRACING_ENABLED",
  "POSTGRES_DATABASE_URL",
  "POSTGRES_READ_REPLICA_URLS",
  "RAG_EMBEDDING_QUERY_ADAPTER",
  "RETRIEVAL_SERVICE_URL",
  "STARTUP_HEALTH_STRICT",
  "VECTOR_STORE_PROVIDER",
];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

const setEnvironment = (values) => {
  KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, values);
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

after(() => setMetricsEnabled(null));

const createLogger = () => {
  const lines = { error: [], log: [], warn: [] };

  return {
    error: (line) => lines.error.push(String(line)),
    lines,
    log: (line) => lines.log.push(String(line)),
    warn: (line) => lines.warn.push(String(line)),
  };
};

const scrape = async (metrics) => {
  const url = `http://127.0.0.1:${metrics.port}/metrics`;

  assert.equal((await fetch(url)).status, 401, "the token is required");

  const response = await fetch(url, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });

  assert.equal(response.status, 200);
  return parseExposition(await response.text());
};

const assertClosed = async (metrics) => {
  assert.equal(metrics.server.listening, false);
  await assert.rejects(fetch(`http://127.0.0.1:${metrics.port}/metrics`));
};

test("node model-gateway.mjs serves /metrics on its own listener and closes it on shutdown", async (t) => {
  setEnvironment({ ...METRICS_ENVIRONMENT, MODEL_GATEWAY_PORT: "0" });

  const logger = createLogger();
  const signals = new EventEmitter();
  const exits = [];
  const started = await runModelGatewayProcess({
    environment: { ...METRICS_ENVIRONMENT, INTERNAL_SERVICE_KEYS: `k1:${SECRET}` },
    exit: (code) => exits.push(code),
    logger,
    signals,
  });

  t.after(() => started?.shutdown?.("SIGTERM"));
  assert.ok(started?.metrics, logger.lines.error.join("\n"));
  assert.notEqual(started.metrics.port, started.server.address().port, "never on the app port");
  assert.ok(logger.lines.log.some((line) => line.includes(`/metrics on http://127.0.0.1:${started.metrics.port}`)));

  await fetch(`http://127.0.0.1:${started.server.address().port}/health`);

  const families = await scrape(started.metrics);

  assert.ok(sampleValue(families, "archive_rag_http_requests_total", { method: "GET", route: "/health" }) >= 1);
  assert.ok(families.has("archive_rag_model_gateway_quota_rejections_total"));

  await started.shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
  await assertClosed(started.metrics);
});

test("node retrieval-service.mjs serves /metrics on its own listener and closes it on shutdown", async (t) => {
  setEnvironment({
    ...METRICS_ENVIRONMENT,
    ARCHIVE_RAG_ROLE: "retrieval",
    INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
    POSTGRES_DATABASE_URL: "postgres://archive:unused@127.0.0.1:1/never-connected",
    VECTOR_STORE_PROVIDER: "qdrant",
  });

  const logger = createLogger();
  const exits = [];
  const started = await runRetrievalServiceProcess({
    exit: (code) => exits.push(code),
    logger,
    port: 0,
    signals: new EventEmitter(),
  });

  t.after(() => started?.shutdown?.("SIGTERM"));
  assert.ok(started?.metrics, logger.lines.error.join("\n"));
  assert.notEqual(started.metrics.port, started.server.address().port, "never on the app port");

  await fetch(`http://127.0.0.1:${started.server.address().port}/livez`);

  const families = await scrape(started.metrics);

  assert.ok(sampleValue(families, "archive_rag_http_requests_total", { method: "GET", route: "/livez" }) >= 1);

  await started.shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
  await assertClosed(started.metrics);
});

test("the dedicated ingest worker serves /metrics with its queue's depth and closes it on shutdown", async (t) => {
  // Never connected to: the store is injected and no pool is ever opened.
  setEnvironment({
    ...METRICS_ENVIRONMENT,
    POSTGRES_DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
    VECTOR_STORE_PROVIDER: "pgvector",
  });

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "metrics-ingest-worker-"));
  const store = createInMemoryIngestJobStore();
  const logger = createLogger();
  const exits = [];

  try {
    const started = await runIngestWorkerProcess({
      createStore: () => store,
      environment: { ...METRICS_ENVIRONMENT },
      exit: (code) => exits.push(code),
      logger,
      ragService: { ingestDocument: async () => ({}) },
      signals: new EventEmitter(),
      tempDirectory,
    });

    t.after(() => started?.shutdown?.("SIGTERM"));
    assert.ok(started?.metrics, logger.lines.error.join("\n"));

    const families = await scrape(started.metrics);

    assert.equal(
      families.get("archive_rag_ingest_jobs").samples.length,
      5,
      "the worker's store reports every status"
    );
    assert.equal(sampleValue(families, "archive_rag_ingest_dead_letter_jobs"), 0);

    await started.shutdown("SIGTERM");
    assert.deepEqual(exits, [0]);
    assert.equal(started.worker.running, false);
    await assertClosed(started.metrics);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});
