import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";

// POSTGRES_TENANT_CONTEXT=strict on a real monolith: `node server.js` against
// a real PostgreSQL with pgvector, API auth on with two tenant tokens, a fake
// OpenAI-compatible model on 127.0.0.1, asynchronous ingestion (so the
// in-process ingest worker, its LISTEN session and the job store run too) and
// /metrics with the ingest queue collector. Both tenants upload a document,
// list their documents and ask /chat; /ready and /health answer; a scrape
// reads the queue. Strict mode refuses every PostgreSQL call made with no
// tenant context bound, so any start-up, background, health or request path
// that lost its context would log ARCHIVE_RAG_TENANT_CONTEXT_MISSING and fail
// its work. The log must hold none, the process must stay up, and SIGTERM must
// still shut it down cleanly. The in-process version against a fake database
// is postgres-strict-tenant-context-sweep.test.mjs.
//
// It needs PGVECTOR_TEST_DATABASE_URL (a login that may create roles and
// databases, as for postgres-row-level-security.integration.test.mjs) and is
// reported as skipped without it, never as passed. It provisions its own
// database owned by a non-superuser CREATEROLE login, so the row-level
// security health check can pass, and drops everything afterwards.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!adminDatabaseUrl) {
  test("strict tenant context end to end (node server.js on pgvector)", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `strict_e2e_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `strict_e2e_tenant_${suffix}`;
  const databaseName = `strict_e2e_${suffix}`;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "strict-tenant-e2e-"));
  const METRICS_TOKEN = randomBytes(16).toString("hex");
  const HEALTH_ADMIN_TOKEN = "strict-e2e-health-admin";
  const TENANTS = {
    alice: {
      lines: ["Program Aster employee handbook.", "Employees receive twelve paid annual leave days each year."],
      question: "How many paid annual leave days do employees receive?",
      scope: { userId: "alice", workspaceId: "ws-a" },
      token: `alice-${randomBytes(8).toString("hex")}`,
    },
    bob: {
      lines: ["Program Boreal travel policy.", "Travellers book economy class for flights under six hours."],
      question: "Which class do travellers book for flights under six hours?",
      scope: { userId: "bob", workspaceId: "ws-b" },
      token: `bob-${randomBytes(8).toString("hex")}`,
    },
  };
  const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
  const EMBEDDING_DIMENSIONS = 64;

  const withDatabase = (url, name, { user, password } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const adminQuery = async (url, sql) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  };

  let modelServer = null;
  let monolith = null;

  const readBody = async (req) => {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
  };

  // OpenAI-compatible chat and embeddings: the load bench's deterministic
  // answer (the best evidence sentence with its source label) and hashed term
  // vectors.
  const startFakeModel = async () => {
    const server = http.createServer(async (req, res) => {
      const payload = JSON.parse((await readBody(req)) || "{}");

      res.writeHead(200, { "content-type": "application/json" });

      if (req.url.endsWith("/embeddings")) {
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

        res.end(
          JSON.stringify({
            data: inputs.map((input, index) => ({
              embedding: hashEmbedding(input, EMBEDDING_DIMENSIONS),
              index,
              object: "embedding",
            })),
            model: payload.model,
            object: "list",
            usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
          })
        );
        return;
      }

      res.end(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", index: 0, message: { content: buildFakeChatAnswer(payload), role: "assistant" } },
          ],
          model: payload.model,
          object: "chat.completion",
          usage: { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 },
        })
      );
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  };

  const startMonolith = async ({ databaseUrl, modelUrl }) => {
    const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

    writeFileSync(emptyEnvironmentFile, "", "utf8");

    const child = spawn(process.execPath, [path.join(serverDirectory, "server.js")], {
      cwd: tempRoot,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
        AGENT_EXECUTION_PLANNER: "deterministic",
        AGENT_INTENT_PLANNER: "deterministic",
        AGENT_PLANNER_ROLLOUT: "deterministic",
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKENS: JSON.stringify({
          ...Object.fromEntries(Object.values(TENANTS).map((tenant) => [tenant.token, tenant.scope])),
          // A platform admin: with auth on, only admin.status.read sees the
          // health checks (routes/system.js); everyone else gets {status}.
          [HEALTH_ADMIN_TOKEN]: { roles: ["admin.viewer"] },
        }),
        DOTENV_CONFIG_PATH: emptyEnvironmentFile,
        DOTENV_CONFIG_QUIET: "true",
        METRICS_ENABLED: "true",
        METRICS_PORT: "0",
        METRICS_TOKEN,
        OPENAI_API_KEY: "strict-e2e-key",
        OPENAI_BASE_URL: `${modelUrl}/v1`,
        OPENAI_CHAT_MODEL: "strict-e2e-chat",
        OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
        PDF_PARSER: "pdfjs",
        PORT: "0",
        POSTGRES_DATABASE_URL: databaseUrl,
        POSTGRES_ROW_LEVEL_SECURITY: "enforce",
        POSTGRES_TENANT_CONTEXT: "strict",
        POSTGRES_TENANT_ROLE: tenantRole,
        RAG_CLAIM_JUDGE: "off",
        RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
        RAG_EMBEDDING_DIMENSIONS: String(EMBEDDING_DIMENSIONS),
        RAG_INGEST_MODE: "async",
        RAG_INGEST_WORKER_POLL_MS: "100",
        RAG_OBSERVABILITY_ENABLED: "false",
        RAG_RERANK_ENABLED: "false",
        RAG_SEMANTIC_CACHE: "off",
        RAG_SHARED_STATE: "memory",
        RATE_LIMIT_ENABLED: "false",
        STARTUP_HEALTH_STRICT: "false",
        UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
        VECTOR_STORE_PROVIDER: "pgvector",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    const urls = await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;

        const appPort = /server is running on port (\d+)/u.exec(output)?.[1];
        const metricsPort = /\[metrics\] serving \/metrics on http:\/\/127\.0\.0\.1:(\d+)/u.exec(output)?.[1];

        if (appPort && metricsPort) {
          resolve({ appUrl: `http://127.0.0.1:${appPort}`, metricsUrl: `http://127.0.0.1:${metricsPort}/metrics` });
        }
      });
      exited.then(({ code, signal }) => reject(new Error(`server.js exited (${code ?? signal}):\n${output}`)));
    });

    return { ...urls, child, exited, output: () => output };
  };

  before(async () => {
    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    // pgvector is not a trusted extension: a superuser installs it, as a DBA
    // would, and migration 012's CREATE EXTENSION IF NOT EXISTS is a no-op.
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    modelServer = await startFakeModel();
    monolith = await startMonolith({
      databaseUrl: withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole }),
      modelUrl: `http://127.0.0.1:${modelServer.address().port}`,
    });
  });

  after(async () => {
    if (monolith && monolith.child.exitCode === null && monolith.child.signalCode === null) {
      monolith.child.kill("SIGKILL");
      await monolith.exited;
    }

    await new Promise((resolve) => (modelServer ? modelServer.close(resolve) : resolve()));
    await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
    rmSync(tempRoot, { force: true, recursive: true });
  });

  const call = (pathname, { body, headers = {}, method = "GET", token } = {}) =>
    fetch(`${monolith.appUrl}${pathname}`, {
      body,
      headers: { ...(token ? { "x-api-key": token } : {}), ...headers },
      method,
      signal: AbortSignal.timeout(30_000),
    });

  const assertNoRefusal = (where) => {
    assert.equal(
      monolith.output().includes("ARCHIVE_RAG_TENANT_CONTEXT_MISSING"),
      false,
      `${where}: a PostgreSQL call ran without a tenant context:\n${monolith.output()}`
    );
  };

  const waitForJob = async (jobId, token) => {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      const job = await (await call(`/ingest-jobs/${jobId}`, { token })).json();

      if (job.status !== "queued" && job.status !== "running") {
        return job;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`ingest job ${jobId} did not finish:\n${monolith.output()}`);
  };

  test("strict mode: start-up, async ingestion, listings, /chat, readiness and metrics of two tenants never lose the tenant context", async () => {
    assertNoRefusal("start-up");

    const docIds = {};

    for (const [name, tenant] of Object.entries(TENANTS)) {
      const form = new FormData();

      form.append(
        "file",
        new Blob([buildTextPdf({ pages: [tenant.lines], title: `${name} handbook` })], { type: "application/pdf" }),
        `${name}-handbook.pdf`
      );

      const upload = await call("/upload", { body: form, method: "POST", token: tenant.token });
      const accepted = await upload.json();

      assert.equal(upload.status, 202, JSON.stringify(accepted));

      const job = await waitForJob(accepted.jobId, tenant.token);

      assert.equal(job.status, "succeeded", JSON.stringify(job));
      docIds[name] = job.docId;
    }

    for (const [name, tenant] of Object.entries(TENANTS)) {
      const listing = await call("/documents", { token: tenant.token });
      const documents = await listing.json();

      assert.equal(listing.status, 200, JSON.stringify(documents));
      assert.deepEqual(
        documents.map((document) => document.docId),
        [docIds[name]],
        `${name} lists exactly its own document`
      );

      const chat = await call("/chat", {
        body: JSON.stringify({ docIds: [docIds[name]], question: tenant.question }),
        headers: { "content-type": "application/json" },
        method: "POST",
        token: tenant.token,
      });
      const answer = await chat.json();

      assert.equal(chat.status, 200, JSON.stringify(answer));
      assert.match(answer.agentAnswer, name === "alice" ? /twelve paid annual leave days/u : /economy class/u);
    }

    // Before authentication nothing binds a tenant: health binds the system.
    // An anonymous probe gets the status only; the admin sees the checks.
    const anonymousReady = await call("/ready");

    assert.equal(anonymousReady.status, 200);
    assert.deepEqual(await anonymousReady.json(), { status: "ok" });

    const ready = await call("/ready", { token: HEALTH_ADMIN_TOKEN });
    const readiness = await ready.json();

    assert.equal(ready.status, 200, JSON.stringify(readiness));
    assert.equal(readiness.checks.rowLevelSecurity.status, "ok", JSON.stringify(readiness.checks.rowLevelSecurity));

    const health = await call("/health");

    assert.equal(health.status, 200);

    // The ingest queue collector reads every tenant's jobs from the metrics
    // listener, where nothing is bound.
    const scrape = await fetch(monolith.metricsUrl, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    const exposition = await scrape.text();

    assert.equal(scrape.status, 200);
    assert.match(exposition, /archive_rag_ingest_jobs\{status="succeeded"\} 2/u);

    assertNoRefusal("requests, health and metrics");
    assert.equal(monolith.child.exitCode, null, "the process is still up");

    // Graceful shutdown (in-flight drain, the ingest worker's stop, the pool)
    // also runs without a refusal and exits 0.
    monolith.child.kill("SIGTERM");

    const { code } = await monolith.exited;

    assert.equal(code, 0, monolith.output());
    assertNoRefusal("shutdown");
  });
}
