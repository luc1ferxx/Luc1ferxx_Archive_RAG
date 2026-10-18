import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";
import { startFakePostgres, TENANT_SETTINGS_TEXT } from "./postgres-replica-fake-server.mjs";

// POSTGRES_TENANT_CONTEXT=strict refuses every PostgreSQL call made with no
// tenant context bound (rag/postgres.js), so it only works if every
// legitimate non-request entry point binds one. This suite builds the real
// app in process (createApp, the PostgreSQL-backed default stores, pgvector)
// against a fake PostgreSQL server that answers every statement with no rows
// (the migrations count as applied), runs start-up, the health and readiness
// routes, and requests of two tenants, and requires that no statement was
// refused for a missing context. The fake answers say nothing about whether
// the work succeeds (an upload fails on the empty pgvector registry); what it
// shows is which context each statement went out in. The same check against a
// real database, through `node server.js`, is
// postgres-strict-tenant-context.e2e.test.mjs (needs PGVECTOR_TEST_DATABASE_URL).

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_IDS = readdirSync(path.join(serverDirectory, "db", "migrations")).filter((name) =>
  /^\d+.*\.sql$/i.test(name)
);
const TOKENS = {
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
  "bob-token": { userId: "bob", workspaceId: "ws-b" },
};
const CONTEXT_MISSING = "ARCHIVE_RAG_TENANT_CONTEXT_MISSING";

let fakeDatabase;
let modelServer;
let appServer;
let baseUrl;
let tempRoot;
let modules;
const refusals = [];
const originalConsoleError = console.error;

const readBody = async (req) => {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

// OpenAI-compatible chat and embeddings (the load bench's deterministic ones).
const startFakeModel = async () => {
  const server = http.createServer(async (req, res) => {
    const payload = JSON.parse((await readBody(req)) || "{}");

    res.writeHead(200, { "content-type": "application/json" });

    if (req.url.endsWith("/embeddings")) {
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

      res.end(
        JSON.stringify({
          data: inputs.map((input, index) => ({ embedding: hashEmbedding(input, 64), index, object: "embedding" })),
          model: payload.model,
          object: "list",
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
      );
      return;
    }

    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: buildFakeChatAnswer(payload), role: "assistant" } }],
        model: payload.model,
        object: "chat.completion",
        usage: { completion_tokens: 10, prompt_tokens: 100, total_tokens: 110 },
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
};

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "strict-tenant-context-"));
  fakeDatabase = await startFakePostgres((text) =>
    /^\s*SELECT id FROM schema_migrations\s*$/u.test(text)
      ? { command: `SELECT ${MIGRATION_IDS.length}`, fields: ["id"], rows: MIGRATION_IDS.map((id) => [id]) }
      : undefined
  );
  modelServer = await startFakeModel();

  Object.assign(process.env, {
    AGENT_EXECUTION_PLANNER: "deterministic",
    AGENT_INTENT_PLANNER: "deterministic",
    AGENT_PLANNER_ROLLOUT: "deterministic",
    API_AUTH_ENABLED: "true",
    API_AUTH_TOKENS: JSON.stringify(TOKENS),
    OPENAI_API_KEY: "strict-sweep-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${modelServer.address().port}/v1`,
    OPENAI_CHAT_MODEL: "strict-sweep-chat",
    POSTGRES_DATABASE_URL: fakeDatabase.url(),
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    POSTGRES_TENANT_CONTEXT: "strict",
    POSTGRES_TENANT_ROLE: "archive_rag_tenant",
    RAG_CLAIM_JUDGE: "off",
    RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
    RAG_INGEST_MODE: "sync",
    RAG_OBSERVABILITY_ENABLED: "false",
    RAG_RERANK_ENABLED: "false",
    RAG_SEMANTIC_CACHE: "off",
    RAG_SHARED_STATE: "memory",
    RATE_LIMIT_ENABLED: "false",
    STARTUP_HEALTH_STRICT: "false",
    UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
    VECTOR_STORE_PROVIDER: "pgvector",
  });

  for (const name of ["DOCCOMPARE_STANDALONE", "LONG_MEMORY_DATABASE_URL", "POSTGRES_READ_REPLICA_URLS", "AGENT_SERVICE_URL"]) {
    delete process.env[name];
  }

  // Every refusal is logged by rag/postgres.js; collected for the whole suite,
  // start-up included.
  console.error = (...args) => {
    const line = args.map((value) => (value instanceof Error ? value.stack : String(value))).join(" ");

    if (line.includes(CONTEXT_MISSING)) {
      // The message and the call site's first frames are enough to find it.
      refusals.push(line.split("\n").slice(0, 8).join("\n"));
    }
  };

  const [{ createApp }, postgres] = await Promise.all([import("../app.js"), import("../rag/postgres.js")]);

  modules = { postgres };

  const app = await createApp({ uploadsDirectory: path.join(tempRoot, "uploads") });

  appServer = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  console.error = originalConsoleError;
  await new Promise((resolve) => (appServer ? appServer.close(resolve) : resolve()));
  await modules?.postgres.resetPostgresPool();
  await new Promise((resolve) => (modelServer ? modelServer.close(resolve) : resolve()));
  await fakeDatabase?.close();
  await rm(tempRoot, { force: true, recursive: true });
});

const call = (pathname, { body, headers = {}, method = "GET", token } = {}) =>
  fetch(`${baseUrl}${pathname}`, {
    body,
    headers: { ...(token ? { "x-api-key": token } : {}), ...headers },
    method,
    signal: AbortSignal.timeout(20_000),
  });

// The ids each tenant settings step carried, per statement group.
const tenantsSeen = () =>
  new Set(
    fakeDatabase.state.messages
      .filter((entry, index, all) => entry.type === "Bind" && TENANT_SETTINGS_TEXT.test(all[index - 1]?.text ?? ""))
      .map((entry) => `${entry.values[1]}|${entry.values[2]}`)
  );

test("strict mode: start-up, health, readiness and two tenants' requests go out bound, none refused", async () => {
  // Start-up (migrations, registry, memory, task, run, audit and artifact
  // stores, recovery scans, start-up health) already ran in before().
  assert.ok(fakeDatabase.state.messages.length > 0, "start-up reached the database");
  assert.deepEqual(refusals, [], "start-up issued no unbound statement");

  // Before authentication: nothing binds a tenant, so the health report binds
  // the system itself.
  assert.equal((await call("/livez")).status, 200);
  assert.equal((await call("/health")).status, 200);
  await call("/ready");

  const pdf = () => {
    const form = new FormData();

    form.append(
      "file",
      new Blob([buildTextPdf({ pages: [["Strict mode handbook.", "Employees receive twelve leave days."]], title: "Strict" })], {
        type: "application/pdf",
      }),
      "strict-handbook.pdf"
    );
    return form;
  };

  for (const token of Object.keys(TOKENS)) {
    await call("/documents", { token });
    await call("/upload", { body: pdf(), method: "POST", token });
    await call("/chat", {
      body: JSON.stringify({ docIds: ["doc-missing"], question: "How many leave days do employees receive?" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      token,
    });
    await call("/auth/me", { token });
    await call("/sessions/session-1", { method: "DELETE", token });
  }

  assert.deepEqual(refusals, [], "no statement went out with the context lost");
  assert.ok(tenantsSeen().has("alice|ws-a"), "alice's requests ran as her tenant");
  assert.ok(tenantsSeen().has("bob|ws-b"), "bob's requests ran as his tenant");
});

test("strict mode: TENANT_MEMBERSHIP=enforce's registry lookups go out bound to the tenant they check", async () => {
  const previous = process.env.TENANT_MEMBERSHIP;

  // requireApiAuth reads the mode per request; the app's PostgreSQL registry
  // (app.locals.tenantRegistry) was created at start-up either way.
  process.env.TENANT_MEMBERSHIP = "enforce";

  try {
    for (const token of Object.keys(TOKENS)) {
      const response = await call("/documents", { token });

      // The fake database answers no rows: no membership.
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "WORKSPACE_MEMBERSHIP_REQUIRED");
    }
  } finally {
    if (previous === undefined) delete process.env.TENANT_MEMBERSHIP;
    else process.env.TENANT_MEMBERSHIP = previous;
  }

  assert.deepEqual(refusals, [], "no lookup went out with the context lost");
  // The workspace read as the workspace alone, the membership read as that
  // user in it.
  for (const tenant of ["|ws-a", "alice|ws-a", "|ws-b", "bob|ws-b"]) {
    assert.ok(tenantsSeen().has(tenant), `a lookup ran as ${tenant}`);
  }
});

test("strict mode: an ingest worker's loops, housekeeping and LISTEN session go out bound, none refused", async () => {
  const [{ createIngestWorker }, { createPostgresIngestJobStore }] = await Promise.all([
    import("../rag/ingest-worker.js"),
    import("../rag/ingest-job-store.js"),
  ]);
  const quiet = { error() {}, log() {}, warn() {} };
  const store = createPostgresIngestJobStore({ logger: quiet });
  const sentBefore = fakeDatabase.state.messages.length;
  const worker = createIngestWorker({
    logger: quiet,
    pollIntervalMs: 20,
    ragService: { ingestDocument: async () => ({ docId: "never" }) },
    store,
    tempDirectory: tempRoot,
  });

  // Started from the test's own (unbound) context, as server.js starts it.
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await worker.stop();

  assert.ok(fakeDatabase.state.messages.length > sentBefore, "the loops claimed from the database");
  assert.deepEqual(refusals, []);
});
