import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runIngestWorkerProcess } from "../ingest-worker.mjs";
import { runModelGatewayProcess } from "../model-gateway.mjs";
import { runRetrievalServiceProcess } from "../retrieval-service.mjs";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import {
  configureTenantUsageLedger,
  createTenantUsageLedger,
  recordTenantUsage,
  TENANT_USAGE_METRICS,
} from "../rag/tenant-usage.js";

// The tenant usage ledger (rag/tenant-usage.js) holds its totals in memory
// and writes them on a timer that does not keep a process alive, so every
// entry point that records usage must write them before it exits: server.js
// and startServiceRole do, and so must the dedicated ingest worker, the
// retrieval service, the model gateway (the only process that books model
// tokens in a split deployment) and the archive-ingest command. The database
// URLs below point at a closed port and are never connected to: the ledger's
// writes go to a list.

const SERVER_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = `${"u".repeat(24)}-usage-flush-0123456789`;
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const KEYS = [
  "ARCHIVE_RAG_ROLE",
  "DOCCOMPARE_STANDALONE",
  "INTERNAL_SERVICE_KEYS",
  "LONG_MEMORY_DATABASE_URL",
  "METRICS_ENABLED",
  "MODEL_GATEWAY_PORT",
  "MODEL_GATEWAY_URL",
  "OTEL_TRACING_ENABLED",
  "POSTGRES_DATABASE_URL",
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
  configureTenantUsageLedger(null);

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const createLogger = () => {
  const lines = { error: [], log: [], warn: [] };

  return {
    error: (line) => lines.error.push(String(line)),
    lines,
    log: (line) => lines.log.push(String(line)),
    warn: (line) => lines.warn.push(String(line)),
  };
};

// The process ledger as if a database were configured; `order` records when
// its rows were written relative to the process's exit.
const useRecordingLedger = (order) => {
  const rows = [];

  configureTenantUsageLedger(
    createTenantUsageLedger({
      isDatabaseConfigured: () => true,
      isEnabled: () => true,
      query: async (text, values) => {
        values[0].forEach((workspaceId, index) =>
          rows.push({ metric: values[2][index], userId: values[1][index], value: Number(values[4][index]), workspaceId })
        );
        order.push("ledger flushed");
        return { rows: [] };
      },
      runAsSystem: (callback) => callback(),
      setTimer: () => null,
    })
  );

  return rows;
};

const recordIngest = () =>
  recordTenantUsage(ALICE, {
    [TENANT_USAGE_METRICS.documents]: 1,
    [TENANT_USAGE_METRICS.ingestedBytes]: 1234,
  });

const EXPECTED_ROWS = [
  { metric: "documents", userId: "alice", value: 1, workspaceId: "ws-a" },
  { metric: "ingested_bytes", userId: "alice", value: 1234, workspaceId: "ws-a" },
];

test("the dedicated ingest worker writes the usage it holds before it exits", async () => {
  setEnvironment({
    POSTGRES_DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
    VECTOR_STORE_PROVIDER: "pgvector",
  });

  const order = [];
  const rows = useRecordingLedger(order);
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "usage-flush-worker-"));

  try {
    const started = await runIngestWorkerProcess({
      createStore: () => createInMemoryIngestJobStore(),
      environment: {},
      exit: (code) => order.push(`exit ${code}`),
      logger: createLogger(),
      ragService: { ingestDocument: async () => ({}) },
      signals: new EventEmitter(),
      tempDirectory,
    });

    assert.ok(started);
    // What a committed job records (rag/index.js commitDocument).
    recordIngest();
    await started.shutdown("SIGTERM");

    assert.deepEqual(order, ["ledger flushed", "exit 0"]);
    assert.deepEqual(rows, EXPECTED_ROWS);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("the retrieval service writes the usage it holds before it exits", async () => {
  setEnvironment({
    ARCHIVE_RAG_ROLE: "retrieval",
    INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
    POSTGRES_DATABASE_URL: "postgres://archive:unused@127.0.0.1:1/never-connected",
    VECTOR_STORE_PROVIDER: "qdrant",
  });

  const order = [];
  const rows = useRecordingLedger(order);
  const logger = createLogger();
  const started = await runRetrievalServiceProcess({
    exit: (code) => order.push(`exit ${code}`),
    logger,
    port: 0,
    signals: new EventEmitter(),
  });

  assert.ok(started, logger.lines.error.join("\n"));
  recordIngest();
  await started.shutdown("SIGTERM");

  assert.deepEqual(order, ["ledger flushed", "exit 0"]);
  assert.deepEqual(rows, EXPECTED_ROWS);
});

test("the model gateway writes the model usage it metered before it exits", async () => {
  setEnvironment({ MODEL_GATEWAY_PORT: "0" });

  const order = [];
  const rows = useRecordingLedger(order);
  const logger = createLogger();
  const started = await runModelGatewayProcess({
    environment: { INTERNAL_SERVICE_KEYS: `k1:${SECRET}` },
    exit: (code) => order.push(`exit ${code}`),
    logger,
    signals: new EventEmitter(),
  });

  assert.ok(started?.server, logger.lines.error.join("\n"));
  recordTenantUsage(ALICE, { [TENANT_USAGE_METRICS.modelTokens]: 42 });
  await started.shutdown("SIGTERM");

  assert.deepEqual(order, ["ledger flushed", "exit 0"]);
  assert.deepEqual(rows, [{ metric: "model_tokens", userId: "alice", value: 42, workspaceId: "ws-a" }]);
});

test("archive-ingest writes the usage ledger before the command ends", async () => {
  // A child process (the command runs on import) whose process ledger is a
  // recorder (--import, before the command's own modules load), started in an
  // empty directory so dotenv finds no .env. --help ingests nothing; the
  // recorder marks the ledger's stop, which must run on every way out.
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "usage-flush-cli-"));
  const preload = new URL("./usage-ledger-shutdown-flush/ledger-stop-marker.mjs", import.meta.url).href;
  const environment = { HOME: process.env.HOME ?? workDirectory, PATH: process.env.PATH ?? "" };

  try {
    for (const argv of [["--help"], []]) {
      const child = spawn(process.execPath, ["--import", preload, path.join(SERVER_DIRECTORY, "archive-ingest.mjs"), ...argv], {
        cwd: workDirectory,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";

      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });

      const code = await new Promise((resolve) => child.on("close", resolve));

      assert.equal(code, argv.length === 0 ? 1 : 0, output);
      assert.match(output, /Usage: node archive-ingest\.mjs/);
      assert.equal(output.match(/LEDGER_STOPPED/g)?.length, 1, `${argv.join(" ") || "(no files)"}: ${output}`);
    }
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
});
