import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { runRetrievalServiceProcess } from "../retrieval-service.mjs";

// The entry point starts only as a retrieval tier that can see what the API
// writes: ARCHIVE_RAG_ROLE=retrieval, usable internal keys, a PostgreSQL
// document registry and a shared vector store. The database URL below is
// never connected to: the qdrant provider is not probed and nothing here
// reads the registry.

const SECRET = "p".repeat(24) + "-process-secret-0123456789";
const KEYS = [
  "ARCHIVE_RAG_ROLE",
  "DOCCOMPARE_STANDALONE",
  "INTERNAL_SERVICE_KEYS",
  "LONG_MEMORY_DATABASE_URL",
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

const READY = {
  ARCHIVE_RAG_ROLE: "retrieval",
  INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
  POSTGRES_DATABASE_URL: "postgres://archive:unused@127.0.0.1:1/never-connected",
  VECTOR_STORE_PROVIDER: "qdrant",
};

test("the retrieval service refuses to start outside a valid retrieval-tier configuration", async () => {
  const cases = [
    [{ ...READY, ARCHIVE_RAG_ROLE: "" }, /runs only as ARCHIVE_RAG_ROLE=retrieval/],
    [{ ...READY, ARCHIVE_RAG_ROLE: "agent" }, /runs only as ARCHIVE_RAG_ROLE=retrieval/],
    [{ ...READY, ARCHIVE_RAG_ROLE: "worker" }, /ARCHIVE_RAG_ROLE/],
    [{ ...READY, INTERNAL_SERVICE_KEYS: "" }, /INTERNAL_SERVICE_KEYS/],
    [{ ...READY, POSTGRES_DATABASE_URL: "" }, /needs PostgreSQL/],
    [{ ...READY, DOCCOMPARE_STANDALONE: "1" }, /needs PostgreSQL/],
    [{ ...READY, VECTOR_STORE_PROVIDER: "local" }, /needs a shared vector store/],
  ];

  for (const [environment, pattern] of cases) {
    setEnvironment(environment);
    const logger = createLogger();
    const started = await runRetrievalServiceProcess({ exit: () => assert.fail("no exit"), logger, port: 0 });

    assert.equal(started, null, String(pattern));
    assert.ok(logger.lines.error.some((line) => pattern.test(line)), logger.lines.error.join("\n"));
    assert.ok(!logger.lines.error.join("\n").includes(SECRET));
  }
});

test("a configured retrieval tier listens, serves health without identity, and stops on SIGTERM", async () => {
  setEnvironment(READY);
  const logger = createLogger();
  const signals = new EventEmitter();
  const exits = [];
  const started = await runRetrievalServiceProcess({
    exit: (code) => exits.push(code),
    logger,
    port: 0,
    signals,
  });

  assert.ok(started, logger.lines.error.join("\n"));

  const baseUrl = `http://127.0.0.1:${started.server.address().port}`;
  const health = await fetch(`${baseUrl}/health`);
  const report = await health.json();

  assert.equal(health.status, 200);
  assert.equal(report.checks.vectorStore.provider, "qdrant");
  assert.equal(report.checks.serviceTopology.role, "retrieval");
  assert.ok(logger.lines.log.some((line) => line.includes("listening on port")));

  const refused = await fetch(`${baseUrl}/internal/retrieval/v1/global`, { body: "{}", method: "POST" });

  assert.equal(refused.status, 401);

  signals.emit("SIGTERM");
  await started.shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
  assert.equal(started.server.listening, false);
});

test("a failing startup health report stops the tier under STARTUP_HEALTH_STRICT=true", async () => {
  setEnvironment({ ...READY, RAG_EMBEDDING_QUERY_ADAPTER: "/nonexistent/adapter.json", STARTUP_HEALTH_STRICT: "true" });
  const logger = createLogger();
  const started = await runRetrievalServiceProcess({ exit: () => assert.fail("no exit"), logger, port: 0 });

  assert.equal(started, null);
  assert.ok(logger.lines.warn.some((line) => line.includes("queryAdapter=error")), logger.lines.warn.join("\n"));
});
