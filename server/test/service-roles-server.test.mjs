import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";

import { buildHealthReport } from "../health.js";
import { createAgentApp } from "../rag/agent-service/app.js";
import {
  createGracefulShutdown,
  createRoleApp,
  resolveRolePort,
  startServiceRole,
} from "../rag/agent-service/role-server.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { getAgentServiceTimeoutMs, getServiceShutdownGraceMs } from "../rag/config.js";
import { resetServiceClients, SERVICE_CLIENT_ERROR_CODES } from "../rag/service-client.js";
import { SERVICE_TOKEN_HEADER, signServiceToken } from "../rag/service-identity.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";

// Start-up, graceful shutdown, and health for the split-deployment roles
// (rag/agent-service/role-server.js, health.js). Everything listens on port 0
// with in-memory stores and the local vector store; no database is touched.

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const SERVICE_KEYS = `roles-server:${"q".repeat(48)}`;
process.env.INTERNAL_SERVICE_KEYS = SERVICE_KEYS;

const quietLogger = { error() {}, log() {}, warn() {} };

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const createStubRagService = ({ chat } = {}) => {
  const documents = new Map([["doc-1", { docId: "doc-1", fileName: "notes.pdf" }]]);

  return {
    chat: async (...args) =>
      chat ? chat(...args) : { citations: [], text: "The amount is 5 [Source 1]." },
    getDocument: (docId) => documents.get(docId) ?? null,
    initializeDocumentRegistry: async () => [],
    initializeSessionMemory: async () => true,
    listDocuments: () => [...documents.values()],
  };
};

const appOptions = (overrides = {}) => ({
  chatMcp: async () => ({ text: "web" }),
  executionPlannerAdapter: deterministicPlannerAdapter,
  healthService: okHealthService,
  intentPlannerAdapter: deterministicIntentPlannerAdapter,
  ragService: createStubRagService(),
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

const findClosedPort = async () => {
  const server = createServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  return port;
};

const createExitSpy = () => {
  const codes = [];

  return { codes, exit: (code) => codes.push(code) };
};

const tenantToken = () =>
  signServiceToken({
    accessScope: { authenticated: false, userId: "", workspaceId: "" },
    audience: "agent",
    issuer: "api",
  });

const askAgent = (baseUrl) =>
  fetch(`${baseUrl}/chat`, {
    body: JSON.stringify({ docId: "doc-1", question: "What is the amount?" }),
    headers: { "content-type": "application/json", [SERVICE_TOKEN_HEADER]: tenantToken() },
    method: "POST",
  });

test("role agent starts, reports its role, and drains in-flight requests on SIGTERM", async () => {
  const release = createDeferred();
  const chatStarted = createDeferred();
  const exitSpy = createExitSpy();
  const signals = new (await import("node:events")).EventEmitter();

  await withEnvironment({ ARCHIVE_RAG_ROLE: "agent" }, async () => {
    const started = await startServiceRole({
      appOptions: appOptions({
        ragService: createStubRagService({
          chat: async () => {
            chatStarted.resolve();
            await release.promise;

            return { citations: [], text: "The amount is 5 [Source 1]." };
          },
        }),
      }),
      exit: exitSpy.exit,
      graceMs: 5000,
      host: "127.0.0.1",
      logger: quietLogger,
      port: 0,
      role: "agent",
      signals,
    });
    const baseUrl = `http://127.0.0.1:${started.port}`;

    assert.deepEqual(await (await fetch(`${baseUrl}/livez`)).json(), {
      role: "agent",
      status: "ok",
    });

    const inFlight = askAgent(baseUrl);

    await chatStarted.promise;
    signals.emit("SIGTERM");

    // No new connections once draining started.
    await assert.rejects(
      fetch(`${baseUrl}/livez`, { headers: { connection: "close" } })
    );
    assert.deepEqual(exitSpy.codes, []);

    release.resolve();

    const answer = await inFlight;

    assert.equal(answer.status, 200);
    await started.shutdown("SIGTERM");
    assert.deepEqual(exitSpy.codes, [0]);
  });
});

test("requests still running when the grace period ends are cut, then the process exits", async () => {
  const release = createDeferred();
  const chatStarted = createDeferred();
  const exitSpy = createExitSpy();

  await withEnvironment({ ARCHIVE_RAG_ROLE: "agent" }, async () => {
    const started = await startServiceRole({
      appOptions: appOptions({
        ragService: createStubRagService({
          chat: async () => {
            chatStarted.resolve();
            await release.promise;

            return { citations: [], text: "late" };
          },
        }),
      }),
      exit: exitSpy.exit,
      graceMs: 50,
      handleSignals: false,
      host: "127.0.0.1",
      logger: quietLogger,
      port: 0,
      role: "agent",
    });
    const inFlight = askAgent(`http://127.0.0.1:${started.port}`);

    await chatStarted.promise;
    await started.shutdown("SIGTERM");

    assert.deepEqual(exitSpy.codes, [0]);
    await assert.rejects(inFlight);
    release.resolve();
  });
});

test("a role refuses to start when the topology has errors", async () => {
  await assert.rejects(
    startServiceRole({
      env: { ARCHIVE_RAG_ROLE: "api", INTERNAL_SERVICE_KEYS: SERVICE_KEYS },
      logger: quietLogger,
      port: 0,
      role: "api",
    }),
    /Role api cannot start: .*AGENT_SERVICE_URL/u
  );
  await assert.rejects(
    startServiceRole({
      env: { ARCHIVE_RAG_ROLE: "agent" },
      logger: quietLogger,
      port: 0,
      role: "agent",
    }),
    /INTERNAL_SERVICE_KEYS/u
  );
  await assert.rejects(createRoleApp({ role: "all" }), /server\.js starts it/u);
  await assert.rejects(createRoleApp({ role: "edge" }), /Unknown service role/u);
});

test("role api starts the public edge: documents answer while agent routes wait for the agent tier", async () => {
  const exitSpy = createExitSpy();
  const agentUrl = `http://127.0.0.1:${await findClosedPort()}`;

  await withEnvironment({ AGENT_SERVICE_URL: agentUrl, ARCHIVE_RAG_ROLE: "api" }, async () => {
    resetServiceClients();

    const started = await startServiceRole({
      appOptions: appOptions(),
      exit: exitSpy.exit,
      handleSignals: false,
      host: "127.0.0.1",
      logger: quietLogger,
      port: 0,
      role: "api",
    });
    const baseUrl = `http://127.0.0.1:${started.port}`;

    try {
      assert.equal((await fetch(`${baseUrl}/documents`)).status, 200);
      assert.deepEqual(await (await fetch(`${baseUrl}/livez`)).json(), {
        role: "api",
        status: "ok",
      });

      const chat = await fetch(`${baseUrl}/chat?docId=doc-1&question=Anything`);

      assert.equal(chat.status, 503);
      assert.equal((await chat.json()).code, SERVICE_CLIENT_ERROR_CODES.unreachable);
    } finally {
      await started.shutdown("SIGTERM");
    }

    assert.deepEqual(exitSpy.codes, [0]);
  });
});

// What the retrieval tier's own entry point requires: PostgreSQL and a shared
// vector store. The URL is never connected to; the health report is a stub.
const RETRIEVAL_PREFLIGHT_ENVIRONMENT = {
  ARCHIVE_RAG_ROLE: "retrieval",
  DOCCOMPARE_STANDALONE: undefined,
  POSTGRES_DATABASE_URL: "postgres://preflight-only@127.0.0.1:9/never-connected",
  STARTUP_HEALTH_STRICT: undefined,
  VECTOR_STORE_PROVIDER: "pgvector",
};

test("retrieval and model-gateway roles load their own app lazily", async () => {
  const exitSpy = createExitSpy();
  const stops = [];
  const createTierApp = () => {
    const app = express();

    app.get("/livez", (req, res) => res.json({ role: "retrieval", status: "ok" }));
    app.locals.stop = async () => {
      stops.push("stopped");
    };

    return app;
  };

  await withEnvironment(RETRIEVAL_PREFLIGHT_ENVIRONMENT, async () => {
    const started = await startServiceRole({
      exit: exitSpy.exit,
      handleSignals: false,
      host: "127.0.0.1",
      loaders: {
        retrieval: async () => ({
          buildRetrievalHealthReport: async () => ({ checks: {}, status: "ok" }),
          createRetrievalApp: createTierApp,
        }),
      },
      logger: quietLogger,
      port: 0,
      role: "retrieval",
    });

    assert.equal(
      (await (await fetch(`http://127.0.0.1:${started.port}/livez`)).json()).role,
      "retrieval"
    );
    await started.shutdown("SIGTERM");
  });

  assert.deepEqual(stops, ["stopped"]);
  assert.deepEqual(exitSpy.codes, [0]);

  // The gateway's pools close as model-gateway.mjs closes them.
  const closed = [];
  const gateway = await createRoleApp({
    loaders: {
      "model-gateway": async () => ({
        createModelGatewayApp: () => {
          const app = express();

          app.locals.modelGateway = { close: () => closed.push("pools") };

          return app;
        },
      }),
    },
    role: "model-gateway",
  });

  for (const finalize of gateway.finalizers) {
    await finalize();
  }

  assert.deepEqual(closed, ["pools"]);

  const missing = Object.assign(
    new Error("Cannot find module '/srv/server/rag/model-gateway/app.js' imported from role-server.js"),
    { code: "ERR_MODULE_NOT_FOUND" }
  );

  await assert.rejects(
    createRoleApp({
      loaders: { "model-gateway": async () => Promise.reject(missing) },
      role: "model-gateway",
    }),
    /Role model-gateway is not available in this build/u
  );
  await assert.rejects(
    createRoleApp({ loaders: { "model-gateway": async () => ({}) }, role: "model-gateway" }),
    /does not export createModelGatewayApp/u
  );
});

test("role retrieval through server.js refuses what retrieval-service.mjs refuses", async () => {
  const created = [];
  let health = { checks: { vectorStore: { status: "error" } }, status: "error" };
  const loaders = {
    retrieval: async () => ({
      buildRetrievalHealthReport: async () => health,
      createRetrievalApp: () => {
        created.push("app");

        return express();
      },
    }),
  };
  const startRetrieval = (overrides) =>
    withEnvironment({ ...RETRIEVAL_PREFLIGHT_ENVIRONMENT, ...overrides }, () =>
      createRoleApp({ loaders, logger: quietLogger, role: "retrieval" })
    );

  // A per-process index would be searched as a stale copy.
  await assert.rejects(
    startRetrieval({ VECTOR_STORE_PROVIDER: "local" }),
    /Role retrieval cannot start: VECTOR_STORE_PROVIDER=local/u
  );
  // Without PostgreSQL the document registry would be this process's own.
  await assert.rejects(
    startRetrieval({ LONG_MEMORY_DATABASE_URL: undefined, POSTGRES_DATABASE_URL: undefined }),
    /Role retrieval cannot start: it needs PostgreSQL/u
  );
  await assert.rejects(
    startRetrieval({ DOCCOMPARE_STANDALONE: "1" }),
    /Role retrieval cannot start: it needs PostgreSQL/u
  );
  // A failing start-up health report stops the start only when strict.
  await assert.rejects(
    startRetrieval({ STARTUP_HEALTH_STRICT: "true" }),
    /startup health check failed \(vectorStore=error\)/u
  );
  assert.deepEqual(created, []);

  await startRetrieval({});
  health = { checks: { vectorStore: { status: "ok" } }, status: "ok" };
  await startRetrieval({ STARTUP_HEALTH_STRICT: "true" });
  assert.deepEqual(created, ["app", "app"]);
});

test("graceful shutdown runs workers alongside the drain and finalizers after it, once", async () => {
  const order = [];
  const server = createServer((req, res) => res.end("ok"));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const exitSpy = createExitSpy();
  const shutdown = createGracefulShutdown({
    exit: exitSpy.exit,
    finalizers: [
      async () => order.push("finalizer"),
      async () => {
        throw new Error("a failing finalizer is logged, not fatal");
      },
    ],
    graceMs: 1000,
    logger: quietLogger,
    role: "agent",
    server,
    stoppers: [async () => order.push("worker")],
  });

  await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

  assert.deepEqual(order, ["worker", "finalizer"]);
  assert.deepEqual(exitSpy.codes, [0]);
  assert.equal(server.listening, false);
});

test("each role listens where its own entry point would", async () => {
  assert.equal(resolveRolePort("api", {}), 5001);
  assert.equal(resolveRolePort("agent", { PORT: "7001" }), 7001);
  assert.equal(resolveRolePort("retrieval", {}), 5002);
  assert.equal(resolveRolePort("retrieval", { PORT: "7002" }), 7002);

  await withEnvironment({ MODEL_GATEWAY_PORT: undefined, PORT: undefined }, () => {
    assert.equal(resolveRolePort("model-gateway"), 5003);
  });
});

test("role settings fall back to their defaults and clamp to their bounds", async () => {
  await withEnvironment(
    { AGENT_SERVICE_TIMEOUT_MS: undefined, SERVICE_SHUTDOWN_GRACE_MS: undefined },
    () => {
      assert.equal(getAgentServiceTimeoutMs(), 300_000);
      assert.equal(getServiceShutdownGraceMs(), 25_000);
    }
  );
  await withEnvironment(
    { AGENT_SERVICE_TIMEOUT_MS: "5", SERVICE_SHUTDOWN_GRACE_MS: "-3" },
    () => {
      assert.equal(getAgentServiceTimeoutMs(), 1000);
      assert.equal(getServiceShutdownGraceMs(), 0);
    }
  );
  await withEnvironment(
    { AGENT_SERVICE_TIMEOUT_MS: "not a number", SERVICE_SHUTDOWN_GRACE_MS: "" },
    () => {
      assert.equal(getAgentServiceTimeoutMs(), 300_000);
      assert.equal(getServiceShutdownGraceMs(), 25_000);
    }
  );
});

// --- health -----------------------------------------------------------------

const quietStores = {
  ADMIN_AUDIT_STORE_PROVIDER: "memory",
  AGENT_RUN_STORE_PROVIDER: "memory",
  API_AUTH_ENABLED: "false",
  LONG_MEMORY_DATABASE_URL: undefined,
  OPENAI_API_KEY: "test-key",
  POSTGRES_DATABASE_URL: undefined,
  TASK_STORE_PROVIDER: "memory",
  WORKSPACE_ARTIFACT_STORE_PROVIDER: "memory",
};

const withHealthEnvironment = async (overrides, work) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "service-roles-health-"));
  const originalDirectory = getRagDataDirectory();

  configureRagDataDirectory(path.join(tempRoot, "data"));

  try {
    return await withEnvironment({ ...quietStores, ...overrides }, work);
  } finally {
    configureRagDataDirectory(originalDirectory);
    await rm(tempRoot, { force: true, recursive: true });
  }
};

const MONOLITH_CHECKS = [
  "apiAuth",
  "openai",
  "vectorStore",
  "documentStore",
  "sessionMemory",
  "longMemory",
  "agentExperienceMemory",
  "taskStore",
  "agentRunStore",
  "adminAuditStore",
  "workspaceArtifactStore",
  "rowLevelSecurity",
  "sharedState",
  "pdfParser",
  "ingestJobs",
  "queryAdapter",
];

test("the monolith's health runs every check it ran before and names its role", async () => {
  await withHealthEnvironment({ AGENT_SERVICE_URL: undefined, ARCHIVE_RAG_ROLE: undefined }, async () => {
    const report = await buildHealthReport();

    assert.deepEqual(Object.keys(report.checks), MONOLITH_CHECKS);
    assert.equal(report.service.role, "all");
    assert.equal(report.service.status, "ok");
    assert.equal(JSON.stringify(report.service).includes(SERVICE_KEYS.split(":")[1]), false);
  });
});

test("the edge's health probes every agent replica and never fails on the agent tier", async () => {
  const agentApp = await withEnvironment({ ARCHIVE_RAG_ROLE: "agent" }, () =>
    createAgentApp(appOptions())
  );
  const agentServer = createServer(agentApp);

  await new Promise((resolve) => agentServer.listen(0, "127.0.0.1", resolve));

  const liveUrl = `http://127.0.0.1:${agentServer.address().port}`;
  const deadUrl = `http://127.0.0.1:${await findClosedPort()}`;

  try {
    await withHealthEnvironment(
      { AGENT_SERVICE_URL: `${liveUrl},${deadUrl}`, ARCHIVE_RAG_ROLE: "api" },
      async () => {
        const report = await buildHealthReport();
        const { agentService } = report.checks;

        assert.equal(report.service.role, "api");
        assert.equal("queryAdapter" in report.checks, false);
        assert.equal(report.checks.serviceTopology.role, "api");
        assert.equal(agentService.status, "warning");
        assert.equal(agentService.reachableReplicas, 1);
        assert.deepEqual(
          agentService.replicas.map(({ ok }) => ok),
          [true, false]
        );
        assert.equal(agentService.replicas[1].code, SERVICE_CLIENT_ERROR_CODES.unreachable);
        assert.equal(agentService.replicas[1].causeCode, "ECONNREFUSED");
        // /ready stays 200 for a missing agent tier: only errors fail it.
        assert.notEqual(agentService.status, "error");
      }
    );

    await withHealthEnvironment({ AGENT_SERVICE_URL: liveUrl, ARCHIVE_RAG_ROLE: "api" }, async () => {
      const report = await buildHealthReport();

      assert.equal(report.checks.agentService.status, "ok");
    });

    // A key the agent tier does not know is reported per replica. The agent
    // (in this process) verifies with process.env, so only the report's own
    // environment carries the stranger key.
    await withHealthEnvironment({ AGENT_SERVICE_URL: liveUrl, ARCHIVE_RAG_ROLE: "api" }, async () => {
      const report = await buildHealthReport({
        env: { ...process.env, INTERNAL_SERVICE_KEYS: `stranger:${"z".repeat(48)}` },
      });

      assert.equal(report.checks.agentService.status, "warning");
      assert.equal(report.checks.agentService.replicas[0].code, "SERVICE_TOKEN_UNKNOWN_KEY");
    });
  } finally {
    agentServer.closeAllConnections();
    await new Promise((resolve) => agentServer.close(resolve));
  }
});

test("the agent tier's health leaves out the edge's checks and follows remote retrieval", async () => {
  await withHealthEnvironment({ ARCHIVE_RAG_ROLE: "agent", RETRIEVAL_SERVICE_URL: undefined }, async () => {
    const report = await buildHealthReport();

    assert.equal(report.service.role, "agent");
    assert.equal("apiAuth" in report.checks, false);
    assert.equal("ingestJobs" in report.checks, false);
    assert.equal("agentService" in report.checks, false);
    assert.equal("queryAdapter" in report.checks, true);
    assert.equal(report.checks.serviceTopology.status, "warning");
  });

  await withHealthEnvironment(
    {
      ARCHIVE_RAG_ROLE: "agent",
      MODEL_GATEWAY_URL: "http://127.0.0.1:1",
      OPENAI_API_KEY: undefined,
      RETRIEVAL_SERVICE_URL: "http://127.0.0.1:2",
    },
    async () => {
      const report = await buildHealthReport();

      assert.equal("queryAdapter" in report.checks, false);
      // Behind the model gateway the provider key is not this tier's to hold.
      assert.equal(report.checks.openai.status, "ok");
      assert.equal(report.checks.openai.gateway, true);
    }
  );

  await withHealthEnvironment({ ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_KEYS: undefined }, async () => {
    const report = await buildHealthReport();

    assert.equal(report.checks.serviceTopology.status, "error");
    assert.equal(report.status, "error");
  });
});
