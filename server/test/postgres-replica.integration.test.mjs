import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";

// Read replicas against real streaming replication: a primary and a hot
// standby fed by it (scripts/run-pgvector-replica-integration.sh provisions
// both). It runs only when PGVECTOR_TEST_DATABASE_URL (the primary) and
// PGVECTOR_TEST_REPLICA_URL (the same database on the replica) are set, with a
// superuser login (replay is paused and resumed); otherwise it is reported as
// skipped, never as passed.
//
// It provisions its own database owned by a non-superuser login with only
// CREATEROLE, as postgres-row-level-security.integration.test.mjs does, and
// that login is what the app uses on both servers. Then:
//
//   1. The tenant pipeline on the standby: a tenant read routed there runs as
//      the tenant role with the tenant settings, and row-level security shows
//      each tenant only its own rows, exactly as on the primary.
//   2. Bounded staleness: with replay paused and a write on the primary the
//      replica's measured lag passes POSTGRES_READ_REPLICA_MAX_LAG_MS and reads
//      go to the primary (counted as lag_exceeded); once replay resumes they
//      come back.
//   3. The acceptance test, over two app processes (A and B) on one database,
//      with replay paused: upload then /chat, replace then /chat, delete then
//      list and /chat, on the instance that wrote and on the other one. No
//      answer may miss, predate or include what the primary holds; the reads
//      the replica cannot serve fall back to the primary and are counted
//      (version_behind). A document the replica still holds unchanged is read
//      from it meanwhile. After replay resumes, reads go back to the replica.

const adminPrimaryUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();
const adminReplicaUrl = String(process.env.PGVECTOR_TEST_REPLICA_URL ?? "").trim();

if (!adminPrimaryUrl || !adminReplicaUrl) {
  test("postgres read replica integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL and PGVECTOR_TEST_REPLICA_URL are not both set; run `bash scripts/run-pgvector-replica-integration.sh`",
  }, () => {});
} else {
  const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const serverUrl = pathToFileURL(`${serverDirectory}/`).href;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "replica-it-"));
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `replica_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `replica_it_tenant_${suffix}`;
  const databaseName = `replica_it_${suffix}`;
  const EMBEDDING_DIMENSIONS = 64;
  const EMBEDDING_MODEL = "text-embedding-3-small";
  const TOKENS = {
    alice: `alice-${randomBytes(8).toString("hex")}`,
    bob: `bob-${randomBytes(8).toString("hex")}`,
  };
  const ALICE = { userId: "alice", workspaceId: "ws-a" };
  const BOB = { userId: "bob", workspaceId: "ws-b" };
  // The in-process checks' tenants, apart from the app's.
  const CAROL = { userId: "carol", workspaceId: "ws-c" };
  const DAVE = { userId: "dave", workspaceId: "ws-d" };

  const withDatabase = (url, name, { password, user } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const ownerUrls = {
    primary: withDatabase(adminPrimaryUrl, databaseName, { password: ownerPassword, user: ownerRole }),
    replica: withDatabase(adminReplicaUrl, databaseName, { password: ownerPassword, user: ownerRole }),
  };
  const adminUrls = {
    primary: withDatabase(adminPrimaryUrl, databaseName),
    replica: withDatabase(adminReplicaUrl, databaseName),
  };

  const adminQuery = async (url, sql, values = []) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(sql, values);
    } finally {
      await client.end();
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Polls `check` until it returns a truthy value, or fails with `label`.
  const waitFor = async (label, check, { timeoutMs = 20000, intervalMs = 50 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last;

    while (Date.now() < deadline) {
      try {
        last = await check();

        if (last) {
          return last;
        }
      } catch (error) {
        last = error;
      }

      await sleep(intervalMs);
    }

    throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
  };

  const lsnOf = (text) => {
    const [high, low] = String(text).split("/");

    return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  };
  const replicaCaughtUp = async () => {
    const primaryLsn = (await adminQuery(adminUrls.primary, "SELECT pg_current_wal_flush_lsn()::text AS lsn")).rows[0].lsn;

    return waitFor("the replica to replay the primary's WAL", async () => {
      const replayLsn = (await adminQuery(adminUrls.replica, "SELECT pg_last_wal_replay_lsn()::text AS lsn")).rows[0].lsn;

      return lsnOf(replayLsn) >= lsnOf(primaryLsn);
    });
  };
  const pauseReplay = async () => {
    await adminQuery(adminUrls.replica, "SELECT pg_wal_replay_pause()");
  };
  const resumeReplay = async () => {
    await adminQuery(adminUrls.replica, "SELECT pg_wal_replay_resume()");
  };
  const countOnReplica = async (sql, values) =>
    Number((await adminQuery(adminUrls.replica, sql, values)).rows[0].count);

  const children = new Set();
  const servers = new Set();
  let modules;

  before(async () => {
    await adminQuery(adminPrimaryUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminPrimaryUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(adminUrls.primary, "CREATE EXTENSION IF NOT EXISTS vector");
    await replicaCaughtUp();
    await waitFor("the database on the replica", () => adminQuery(adminUrls.replica, "SELECT 1 AS ok"));

    Object.assign(process.env, {
      OPENAI_EMBEDDING_MODEL: EMBEDDING_MODEL,
      POSTGRES_DATABASE_URL: ownerUrls.primary,
      POSTGRES_READ_REPLICA_LAG_POLL_MS: "50",
      POSTGRES_READ_REPLICA_MAX_LAG_MS: "600000",
      POSTGRES_READ_REPLICA_URLS: ownerUrls.replica,
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_EMBEDDING_DIMENSIONS: String(EMBEDDING_DIMENSIONS),
      VECTOR_STORE_PROVIDER: "pgvector",
    });
    delete process.env.LONG_MEMORY_DATABASE_URL;

    const [config, migrations, postgres, registry, replicas, tenant] = await Promise.all([
      import("../rag/config.js"),
      import("../rag/db-migrations.js"),
      import("../rag/postgres.js"),
      import("../rag/doc-registry.js"),
      import("../rag/postgres-replicas.js"),
      import("../rag/postgres-tenant.js"),
    ]);

    modules = { config, migrations, postgres, registry, replicas, tenant };
    config.configureEmbeddingDimensions(EMBEDDING_DIMENSIONS);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await migrations.runPostgresMigrations();
  });

  after(async () => {
    for (const child of children) {
      child.kill("SIGKILL");
    }

    await Promise.all([...servers].map((server) => server.stop()));
    await resumeReplay().catch(() => {});
    await modules?.postgres.resetPostgresPool();
    await adminQuery(adminPrimaryUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`).catch(() => {});
    await adminQuery(adminPrimaryUrl, `DROP ROLE IF EXISTS ${tenantRole}`).catch(() => {});
    await adminQuery(adminPrimaryUrl, `DROP ROLE IF EXISTS ${ownerRole}`).catch(() => {});
    rmSync(tempRoot, { force: true, recursive: true });
  });

  const asTenant = (scope, callback) => modules.tenant.runWithDatabaseTenant(scope, callback);
  const readOnly = (scope, sql, values = [], options = {}) =>
    asTenant(scope, () => modules.postgres.queryPostgres(sql, values, { readOnly: true, ...options }));
  const routing = () => modules.replicas.getReplicaRoutingSnapshot();
  const usableNow = async () => {
    await modules.replicas.pollReadReplicasNow();
    return routing().replicas[0].usable;
  };

  test("a tenant read on the hot standby runs as the tenant role, and row-level security shows each tenant only its rows", async () => {
    const store = modules.registry.createDocumentRegistryStore();

    await modules.tenant.runAsDatabaseSystem(async () => {
      for (const [docId, owner] of [
        ["rls-carol", CAROL],
        ["rls-dave", DAVE],
      ]) {
        await store.upsert({
          docId,
          fileBuffer: Buffer.from(`%PDF-1.4 ${docId}`),
          fileName: `${docId}.pdf`,
          ownerUserId: owner.userId,
          workspaceId: owner.workspaceId,
        });
      }
    });
    await replicaCaughtUp();
    await waitFor("the replica to be usable", usableNow);

    const before = routing().reads.replica;
    const identity = await readOnly(
      CAROL,
      `SELECT current_user AS role, pg_is_in_recovery() AS standby,
              current_setting('archive_rag.user_id') AS user_id,
              current_setting('archive_rag.workspace_id') AS workspace_id`
    );

    assert.deepEqual(identity.rows, [{ role: tenantRole, standby: true, user_id: "carol", workspace_id: "ws-c" }]);

    const documentsTable = modules.config.getDocumentsPostgresTable();
    const listAs = async (scope) =>
      (
        await readOnly(scope, `SELECT doc_id, pg_is_in_recovery() AS standby FROM ${documentsTable} ORDER BY doc_id`)
      ).rows;

    assert.deepEqual(await listAs(CAROL), [{ doc_id: "rls-carol", standby: true }]);
    assert.deepEqual(await listAs(DAVE), [{ doc_id: "rls-dave", standby: true }]);
    assert.equal(routing().reads.replica, before + 3, "all three were answered by the replica");

    // The guard runs as the tenant too: another tenant's document is
    // invisible to it, so it fails and the primary answers, where the row
    // policy hides that document as well.
    const guard = modules.replicas.buildDocumentFreshnessGuard({
      documents: [{ docId: "rls-dave", version: 1 }],
      documentsTable,
    });
    const behind = routing().fallbacks.version_behind;
    const viaPrimary = await readOnly(CAROL, `SELECT doc_id, pg_is_in_recovery() AS standby FROM ${documentsTable}`, [], {
      readOnly: { guard },
    });

    assert.deepEqual(viaPrimary.rows, [{ doc_id: "rls-carol", standby: false }]);
    assert.equal(routing().fallbacks.version_behind, behind + 1);

    // Owner statements never go to the replica, marked or not.
    const owner = await modules.postgres.queryPostgres("SELECT pg_is_in_recovery() AS standby", [], { readOnly: true });

    assert.deepEqual(owner.rows, [{ standby: false }]);
    assert.ok(routing().bypasses.owner >= 1);
  });

  test("bounded staleness: a replica paused behind a write passes the lag limit and reads go to the primary until it catches up", async () => {
    process.env.POSTGRES_READ_REPLICA_MAX_LAG_MS = "400";

    try {
      await waitFor("the replica to be usable", usableNow);
      await pauseReplay();

      // With nothing written the replica keeps up, paused or not; checked only
      // when the primary's position provably did not move meanwhile.
      const flushBefore = (await adminQuery(adminUrls.primary, "SELECT pg_current_wal_flush_lsn()::text AS lsn")).rows[0].lsn;

      await sleep(600);

      const flushAfter = (await adminQuery(adminUrls.primary, "SELECT pg_current_wal_flush_lsn()::text AS lsn")).rows[0].lsn;

      if (flushAfter === flushBefore) {
        assert.equal(await usableNow(), true, "an idle primary does not make a paused replica stale");
      }

      await adminQuery(adminUrls.primary, `CREATE TABLE replica_it_lag_${suffix} (id int)`);
      await waitFor("the lag to pass the limit", async () => {
        await modules.replicas.pollReadReplicasNow();
        return routing().replicas[0].exclusion === "lag_exceeded";
      });

      const lagged = routing();

      assert.equal(lagged.replicas[0].state, "paused");
      assert.ok(lagged.replicas[0].lagMs > 400);
      assert.ok(lagged.replicas[0].behindSince);

      const fallbacks = lagged.fallbacks.lag_exceeded;
      const answer = await readOnly(CAROL, "SELECT pg_is_in_recovery() AS standby");

      assert.deepEqual(answer.rows, [{ standby: false }], "the primary answered");
      assert.equal(routing().fallbacks.lag_exceeded, fallbacks + 1);

      await resumeReplay();
      await replicaCaughtUp();
      await waitFor("the replica to be usable again", usableNow);
      assert.deepEqual((await readOnly(CAROL, "SELECT pg_is_in_recovery() AS standby")).rows, [{ standby: true }]);
    } finally {
      await resumeReplay().catch(() => {});
      process.env.POSTGRES_READ_REPLICA_MAX_LAG_MS = "600000";
    }
  });

  // ---- two app processes ----------------------------------------------------

  const startHttpServer = async (handler) => {
    const server = http.createServer(handler);

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const entry = {
      stop: () =>
        new Promise((resolve) => {
          servers.delete(entry);
          server.closeAllConnections();
          server.close(() => resolve());
        }),
      url: `http://127.0.0.1:${server.address().port}`,
    };

    servers.add(entry);
    return entry;
  };

  const readBody = async (req) => {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
  };

  // OpenAI-compatible chat and embeddings: the load bench's deterministic
  // answer (the best evidence sentence with its source label) and hashed
  // term vectors.
  const startFakeModel = () =>
    startHttpServer(async (req, res) => {
      const payload = JSON.parse((await readBody(req)) || "{}");

      if (req.url.endsWith("/embeddings")) {
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

        res.writeHead(200, { "content-type": "application/json" });
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

      if (!req.url.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No such route." } }));
        return;
      }

      const content = buildFakeChatAnswer(payload);
      const usage = { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 };

      if (!payload.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
            model: payload.model,
            object: "chat.completion",
            usage,
          })
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }], model: payload.model })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], model: payload.model, usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });

  // Only what a process needs; nothing from the developer's shell or
  // server/.env can point it elsewhere.
  const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
  const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

  writeFileSync(emptyEnvironmentFile, "", "utf8");

  const appEnvironment = (model) => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
    AGENT_EXECUTION_PLANNER: "deterministic",
    AGENT_INTENT_PLANNER: "deterministic",
    AGENT_PLANNER_ROLLOUT: "deterministic",
    API_AUTH_ENABLED: "true",
    API_AUTH_TOKENS: JSON.stringify({
      [TOKENS.alice]: ALICE,
      [TOKENS.bob]: BOB,
    }),
    DOTENV_CONFIG_PATH: emptyEnvironmentFile,
    DOTENV_CONFIG_QUIET: "true",
    OPENAI_API_KEY: "replica-it-key",
    OPENAI_BASE_URL: `${model.url}/v1`,
    OPENAI_CHAT_MODEL: "replica-it-chat",
    OPENAI_EMBEDDING_MODEL: EMBEDDING_MODEL,
    PDF_PARSER: "pdfjs",
    POSTGRES_DATABASE_URL: ownerUrls.primary,
    // Generous: this part tests the freshness guard, not the lag limit.
    POSTGRES_READ_REPLICA_LAG_POLL_MS: "50",
    POSTGRES_READ_REPLICA_MAX_LAG_MS: "600000",
    POSTGRES_READ_REPLICA_URLS: ownerUrls.replica,
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    POSTGRES_TENANT_ROLE: tenantRole,
    RAG_CLAIM_JUDGE: "off",
    RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
    RAG_EMBEDDING_DIMENSIONS: String(EMBEDDING_DIMENSIONS),
    RAG_INGEST_MODE: "sync",
    RAG_LONG_MEMORY_ENABLED: "false",
    RAG_OBSERVABILITY_ENABLED: "false",
    RAG_RERANK_ENABLED: "false",
    RAG_SEMANTIC_CACHE: "off",
    RAG_SHARED_STATE: "memory",
    RATE_LIMIT_ENABLED: "false",
    STARTUP_HEALTH_STRICT: "false",
    UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
    VECTOR_STORE_PROVIDER: "pgvector",
  });

  // The app as server.js builds it, behind a listener that also answers
  // /__replica-routing with this process's routing snapshot.
  const HARNESS = [
    "--input-type=module",
    "-e",
    `const root = ${JSON.stringify(serverUrl)};
const http = await import("node:http");
const { createApp } = await import(new URL("app.js", root));
const { getReplicaRoutingSnapshot } = await import(new URL("rag/postgres-replicas.js", root));
const app = await createApp();
const server = http.createServer((req, res) => {
  if (req.url === "/__replica-routing") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(getReplicaRoutingSnapshot()));
    return;
  }
  app(req, res);
});
server.listen(0, "127.0.0.1", () => console.log("REPLICA_IT_LISTENING " + server.address().port));
process.once("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});`,
  ];

  const spawnApp = async (name, environment) => {
    const child = spawn(process.execPath, HARNESS, {
      cwd: tempRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail = [];
    const keep = (chunk) => {
      tail.push(...String(chunk).split("\n").filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 60));
    };

    children.add(child);
    child.stderr.on("data", keep);

    const port = await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        keep(chunk);
        const match = /REPLICA_IT_LISTENING (\d+)/u.exec(tail.join("\n"));

        if (match) {
          resolve(Number(match[1]));
        }
      });
      child.once("exit", (code, signal) =>
        reject(new Error(`${name} exited (${code ?? signal}) before listening:\n${tail.join("\n")}`))
      );
    });

    return { logs: () => tail.join("\n"), name, url: `http://127.0.0.1:${port}` };
  };

  const request = async (app, route, { body, form, method = "GET", token = TOKENS.alice } = {}) => {
    const response = await fetch(`${app.url}${route}`, {
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { "x-api-key": token } : {}),
      },
      method,
    });
    const text = await response.text();

    return { json: text ? JSON.parse(text) : null, status: response.status, text };
  };

  const pdfForm = (title, lines) => {
    const form = new FormData();

    form.append("file", new Blob([buildTextPdf({ pages: [lines], title })], { type: "application/pdf" }), `${title}.pdf`);
    return form;
  };

  const upload = async (app, title, lines) => {
    const answer = await request(app, "/upload", { form: pdfForm(title, lines), method: "POST" });

    assert.equal(answer.status, 201, answer.text);

    const docId = answer.json?.docId ?? answer.json?.document?.docId;

    assert.ok(docId, answer.text);
    return docId;
  };

  // A session of its own per question, so no earlier answer reaches a prompt.
  const chat = (app, question, docIds) =>
    request(app, "/chat", {
      body: { docIds, question, sessionId: `replica-it-${randomBytes(6).toString("hex")}` },
      method: "POST",
    });
  const answerOf = (answer) => `${answer.json?.agentAnswer ?? ""}\n${answer.json?.ragAnswer ?? ""}`;
  const routingOf = async (app) => (await request(app, "/__replica-routing", { token: null })).json;

  // Counter changes on one app across `run`.
  const measure = async (app, run) => {
    const before = await routingOf(app);
    const result = await run();
    const after = await routingOf(app);

    return {
      replicaReads: after.reads.replica - before.reads.replica,
      primaryReads: after.reads.primary - before.reads.primary,
      result,
      versionBehind: after.fallbacks.version_behind - before.fallbacks.version_behind,
    };
  };

  const LEAVE_QUESTION = "How many paid annual leave days do employees receive?";
  const CEILING_QUESTION = "What is the cobalt ceiling per quarter?";
  const PARKING_QUESTION = "Where do visitors park at the Delta site?";

  test("acceptance: with replay paused, nothing either instance answers misses, predates or includes a primary change; reads return to the replica once it catches up", async () => {
    const model = await startFakeModel();
    const [appA, appB] = await Promise.all([
      spawnApp("app-a", appEnvironment(model)),
      spawnApp("app-b", appEnvironment(model)),
    ]);
    const apps = [appA, appB];
    const documentsTable = modules.config.getDocumentsPostgresTable();

    try {
      // Baseline, replica streaming: both instances read it.
      const leaveDoc = await upload(appA, "aster-handbook", [
        "Program Aster employee handbook.",
        "Employees receive twelve paid annual leave days each year.",
        "Unused leave days carry over until the end of March.",
      ]);
      const parkingDoc = await upload(appA, "delta-site-guide", [
        "Delta site visitor guide.",
        "Visitors park in the north lot next to the Delta site reception.",
      ]);

      await replicaCaughtUp();

      for (const app of apps) {
        await waitFor(`${app.name}'s replica monitor`, async () => (await routingOf(app)).replicas[0].usable);

        const baseline = await measure(app, () => chat(app, LEAVE_QUESTION, [leaveDoc]));

        assert.equal(baseline.result.status, 200, baseline.result.text);
        assert.match(answerOf(baseline.result), /twelve paid annual leave days/u);
        assert.ok(baseline.replicaReads > 0, `${app.name} searched on the replica: ${JSON.stringify(baseline)}`);
        assert.equal(baseline.versionBehind, 0);
      }

      await pauseReplay();

      // Upload on A, then ask on A and on B.
      const ceilingDoc = await upload(appA, "cobalt-budget", [
        "Program Cobalt budget policy.",
        "The cobalt ceiling is 2400 dollars per quarter.",
      ]);

      assert.equal(
        await countOnReplica(`SELECT count(*) FROM ${documentsTable} WHERE doc_id = $1`, [ceilingDoc]),
        0,
        "the replica has not seen the upload"
      );

      for (const app of apps) {
        const asked = await measure(app, () => chat(app, CEILING_QUESTION, [ceilingDoc]));

        assert.equal(asked.result.status, 200, `${app.name}: ${asked.result.text}`);
        assert.match(answerOf(asked.result), /2400 dollars per quarter/u, `${app.name} found the new document`);
        assert.ok(asked.versionBehind > 0, `${app.name} counted the fallback: ${JSON.stringify(asked)}`);
        assert.equal(asked.replicaReads, 0, `${app.name} read nothing of it from the replica`);
      }

      // A document the replica holds unchanged is still read from it.
      const unchanged = await measure(appB, () => chat(appB, PARKING_QUESTION, [parkingDoc]));

      assert.equal(unchanged.result.status, 200, unchanged.result.text);
      assert.match(answerOf(unchanged.result), /north lot/u);
      assert.ok(unchanged.replicaReads > 0, `an unchanged document stays on the replica: ${JSON.stringify(unchanged)}`);
      assert.equal(unchanged.versionBehind, 0);

      // Replace on B, then ask on A and on B.
      const replaced = await request(appB, `/documents/${leaveDoc}`, {
        form: pdfForm("aster-handbook-2", [
          "Program Aster employee handbook, second edition.",
          "Employees receive twenty paid annual leave days each year.",
          "Unused leave days carry over until the end of June.",
        ]),
        method: "PUT",
      });

      assert.equal(replaced.status, 200, replaced.text);
      assert.equal(
        await countOnReplica(`SELECT count(*) FROM ${documentsTable} WHERE doc_id = $1 AND content_version = 1`, [leaveDoc]),
        1,
        "the replica still holds the first version"
      );

      for (const app of apps) {
        const asked = await measure(app, () => chat(app, LEAVE_QUESTION, [leaveDoc]));
        const text = answerOf(asked.result);

        assert.equal(asked.result.status, 200, `${app.name}: ${asked.result.text}`);
        assert.match(text, /twenty paid annual leave days/u, `${app.name} read the replacement`);
        assert.doesNotMatch(text, /twelve/u, `${app.name} read nothing of the replaced version`);
        assert.ok(asked.versionBehind > 0, `${app.name} counted the fallback: ${JSON.stringify(asked)}`);
        assert.equal(asked.replicaReads, 0);
      }

      // Delete on A, then list and ask on A and on B.
      const deleted = await request(appA, `/documents/${parkingDoc}`, { method: "DELETE" });

      assert.equal(deleted.status, 200, deleted.text);
      assert.equal(
        await countOnReplica(`SELECT count(*) FROM ${documentsTable} WHERE doc_id = $1`, [parkingDoc]),
        1,
        "the replica still holds the deleted document"
      );

      for (const app of apps) {
        const listed = await request(app, "/documents");

        assert.equal(listed.status, 200, listed.text);
        assert.deepEqual(listed.json.map((document) => document.docId).sort(), [ceilingDoc, leaveDoc].sort(), app.name);

        const gone = await chat(app, PARKING_QUESTION, [parkingDoc]);

        assert.equal(gone.status, 404, `${app.name}: ${gone.text}`);
      }

      // Replay resumes: the same reads go back to the replica.
      await resumeReplay();
      await replicaCaughtUp();

      for (const app of apps) {
        await waitFor(`${app.name}'s replica monitor`, async () => (await routingOf(app)).replicas[0].usable);

        const asked = await measure(app, () => chat(app, LEAVE_QUESTION, [leaveDoc]));

        assert.equal(asked.result.status, 200, asked.result.text);
        assert.match(answerOf(asked.result), /twenty paid annual leave days/u);
        assert.ok(asked.replicaReads > 0, `${app.name} is back on the replica: ${JSON.stringify(asked)}`);
        assert.equal(asked.versionBehind, 0);
      }

      const final = await Promise.all(apps.map(routingOf));

      for (const [index, snapshot] of final.entries()) {
        assert.ok(snapshot.fallbacks.version_behind >= 2, `${apps[index].name}: ${JSON.stringify(snapshot.fallbacks)}`);
        assert.equal(snapshot.fallbacks.replica_unavailable, 0);
        assert.equal(snapshot.fallbacks.replica_error, 0, JSON.stringify(snapshot.fallbacks));
        assert.ok(!JSON.stringify(snapshot).includes(ownerPassword), "no secret in the snapshot");
      }
    } catch (error) {
      for (const app of apps) {
        console.error(`--- ${app.name} log tail ---\n${app.logs()}`);
      }

      throw error;
    } finally {
      await resumeReplay().catch(() => {});
    }
  });
}
