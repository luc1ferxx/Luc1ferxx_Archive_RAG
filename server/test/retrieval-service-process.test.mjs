import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { startServiceRole } from "../rag/agent-service/role-server.js";
import { SERVICE_TOKEN_HEADER, signServiceToken } from "../rag/service-identity.js";

// The retrieval tier as `ARCHIVE_RAG_ROLE=retrieval node server.js` starts it:
// startServiceRole with the real rag/retrieval-service/app.js, usable internal
// keys, a PostgreSQL document registry and a shared vector store. The database
// URL below is never connected to: the qdrant provider is not probed and
// nothing here reads the registry. What the role refuses is covered in
// service-roles-server.test.mjs.

const SECRET = "p".repeat(24) + "-process-secret-0123456789";
const KEYS = [
  "ARCHIVE_RAG_ROLE",
  "DOCCOMPARE_STANDALONE",
  "INTERNAL_SERVICE_KEYS",
  "LONG_MEMORY_DATABASE_URL",
  "METRICS_ENABLED",
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

const QDRANT_WARNING = /VECTOR_STORE_PROVIDER=qdrant keeps its sparse vocabulary in each process/u;

test("role retrieval serves the retrieval app, health without identity, warns about Qdrant, and stops on SIGTERM", async (t) => {
  setEnvironment(READY);
  const logger = createLogger();
  const signals = new EventEmitter();
  const exits = [];
  const started = await startServiceRole({
    exit: (code) => exits.push(code),
    host: "127.0.0.1",
    logger,
    port: 0,
    role: "retrieval",
    signals,
  });

  // A failed assertion must not leave the listener holding the run open.
  t.after(() => started.shutdown("SIGTERM"));

  const baseUrl = `http://127.0.0.1:${started.port}`;
  const bare = await fetch(`${baseUrl}/health`);

  // A container healthcheck reads the status code; the details need a probe
  // identity, here bound to the request the way the service client binds.
  assert.equal(bare.status, 200);
  assert.deepEqual(await bare.json(), { status: "ok" });

  const health = await fetch(`${baseUrl}/health`, {
    headers: {
      [SERVICE_TOKEN_HEADER]: signServiceToken({
        audience: "retrieval",
        issuer: "agent",
        request: { method: "GET", target: "/health" },
        system: true,
      }),
    },
  });
  const report = await health.json();

  assert.equal(health.status, 200);
  assert.equal(report.checks.vectorStore.provider, "qdrant");
  assert.equal(report.checks.serviceTopology.role, "retrieval");
  // Split deployments use pgvector: Qdrant starts, with a warning at start-up
  // and in the report.
  assert.ok(report.checks.serviceTopology.warnings.some((line) => QDRANT_WARNING.test(line)));
  assert.ok(logger.lines.warn.some((line) => QDRANT_WARNING.test(line)), logger.lines.warn.join("\n"));
  assert.ok(logger.lines.log.some((line) => line.includes("role retrieval is running on port")));

  const refused = await fetch(`${baseUrl}/internal/retrieval/v1/global`, { body: "{}", method: "POST" });

  assert.equal(refused.status, 401);

  signals.emit("SIGTERM");
  await started.shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
  assert.equal(started.server.listening, false);
  assert.ok(!JSON.stringify(logger.lines).includes(SECRET));
});

test("a failing start-up health report stops role retrieval under STARTUP_HEALTH_STRICT=true", async () => {
  setEnvironment({ ...READY, RAG_EMBEDDING_QUERY_ADAPTER: "/nonexistent/adapter.json", STARTUP_HEALTH_STRICT: "true" });
  const logger = createLogger();

  await assert.rejects(
    startServiceRole({
      exit: () => assert.fail("no exit"),
      handleSignals: false,
      host: "127.0.0.1",
      logger,
      port: 0,
      role: "retrieval",
    }),
    /Role retrieval cannot start: its startup health check failed \(.*queryAdapter=error/u
  );
  assert.ok(logger.lines.warn.some((line) => line.includes("queryAdapter=error")), logger.lines.warn.join("\n"));
});
