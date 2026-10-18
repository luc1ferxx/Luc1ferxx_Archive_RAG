import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";

// Upgrade drill: an archive written by an OLDER checkout of this server (its
// own `node server.js`, migrations, API and feedback file) is opened by this
// checkout, on a least-privilege database the way a DBA would set it up.
//
//   1. A DBA creates the owner login (LOGIN, no CREATEROLE, no superuser), the
//      database it owns, pgvector, and the tenant role the owner may SET.
//   2. The older server ingests a document per tenant, answers a /chat, keeps
//      session memory, writes admin audit events and answer feedback (a JSONL
//      file before migration 034), then stops.
//   3. This checkout starts on the same database as the same login. Migration
//      035 needs a role the login may not create, so the start must fail with
//      the hint naming it, and leave the archive untouched.
//   4. The DBA creates the system role; this checkout starts, applies every
//      pending migration, and the old data keeps its isolation: each tenant
//      lists and answers over its own document only, health passes, the audit
//      chain verifies (old rows are legacy rows, not breaks), the feedback
//      file imports.
//   5. The DBA adds a runtime login (create-split-roles.sql shape) and the
//      database role split is switched on for the existing archive, with
//      strict tenant context: health's roleSplit has no error, old and new
//      documents stay isolated, new audit rows are chained.
//
// Opt-in: it needs PGVECTOR_TEST_DATABASE_URL (a superuser, as the DBA) and
// ARCHIVE_RAG_UPGRADE_FROM, a checkout of the older version with its server
// dependencies installed, e.g.
//
//   git worktree add --detach /tmp/archive-rag-main main
//   ln -s "$PWD/server/node_modules" /tmp/archive-rag-main/server/node_modules
//   ARCHIVE_RAG_UPGRADE_FROM=/tmp/archive-rag-main \
//     TEST_FILES=test/postgres-upgrade.integration.test.mjs \
//     bash scripts/run-pgvector-integration.sh
//
// Without either it is reported as skipped, never as passed.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();
const upgradeFrom = String(process.env.ARCHIVE_RAG_UPGRADE_FROM ?? "").trim();
const resolveServerDirectory = (root) =>
  [path.join(root, "server"), root].find((candidate) => existsSync(path.join(candidate, "server.js"))) ?? null;
const oldServerDirectory = upgradeFrom ? resolveServerDirectory(upgradeFrom) : null;

if (!adminDatabaseUrl || !oldServerDirectory) {
  test("upgrade from an older checkout on a least-privilege database", {
    skip: !adminDatabaseUrl
      ? "PGVECTOR_TEST_DATABASE_URL is not set; run it through `bash scripts/run-pgvector-integration.sh`"
      : "ARCHIVE_RAG_UPGRADE_FROM does not name an older checkout (a directory with server/server.js)",
  }, () => {});
} else {
  const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `upg_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const runtimeRole = `upg_runtime_${suffix}`;
  const runtimePassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `upg_tenant_${suffix}`;
  const systemRole = `upg_system_${suffix}`;
  const databaseName = `upg_${suffix}`;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "archive-rag-upgrade-"));
  const ADMIN_TOKEN = `upg-admin-${randomBytes(8).toString("hex")}`;
  const TENANTS = {
    alice: {
      lines: ["Program Aster employee handbook.", "Employees receive twelve paid annual leave days each year."],
      question: "How many paid annual leave days do employees receive?",
      answer: /twelve paid annual leave days/u,
      scope: { userId: "alice", workspaceId: "ws-a" },
      token: `alice-${randomBytes(8).toString("hex")}`,
    },
    bob: {
      lines: ["Program Boreal travel policy.", "Travellers book economy class for flights under six hours."],
      question: "Which class do travellers book for flights under six hours?",
      answer: /economy class/u,
      scope: { userId: "bob", workspaceId: "ws-b" },
      token: `bob-${randomBytes(8).toString("hex")}`,
    },
  };
  const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
  const EMBEDDING_DIMENSIONS = 64;
  const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

  writeFileSync(emptyEnvironmentFile, "", "utf8");

  const withDatabase = (url, name, { user, password } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const ownerUrl = () => withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole });
  const runtimeUrl = () => withDatabase(adminDatabaseUrl, databaseName, { password: runtimePassword, user: runtimeRole });
  const dbaUrl = () => withDatabase(adminDatabaseUrl, databaseName);
  const sql = async (url, text, values) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(text, values);
    } finally {
      await client.end();
    }
  };

  const readBody = async (req) => {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
  };

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

  let modelServer = null;
  const children = new Set();

  const baseEnvironment = () => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
    AGENT_EXECUTION_PLANNER: "deterministic",
    AGENT_INTENT_PLANNER: "deterministic",
    AGENT_PLANNER_ROLLOUT: "deterministic",
    API_AUTH_ENABLED: "true",
    API_AUTH_TOKENS: JSON.stringify({
      ...Object.fromEntries(Object.values(TENANTS).map((tenant) => [tenant.token, tenant.scope])),
      [ADMIN_TOKEN]: { roles: ["admin.owner"] },
    }),
    DOTENV_CONFIG_PATH: emptyEnvironmentFile,
    DOTENV_CONFIG_QUIET: "true",
    FEEDBACK_DIRECTORY: path.join(tempRoot, "feedback"),
    OPENAI_API_KEY: "upgrade-drill-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${modelServer.address().port}/v1`,
    OPENAI_CHAT_MODEL: "upgrade-drill-chat",
    OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
    PDF_PARSER: "pdfjs",
    PORT: "0",
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    POSTGRES_SYSTEM_ROLE: systemRole,
    POSTGRES_TENANT_ROLE: tenantRole,
    RAG_CLAIM_JUDGE: "off",
    RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
    RAG_EMBEDDING_DIMENSIONS: String(EMBEDDING_DIMENSIONS),
    RAG_OBSERVABILITY_ENABLED: "false",
    RAG_RERANK_ENABLED: "false",
    RAG_SEMANTIC_CACHE: "off",
    RAG_SHARED_STATE: "memory",
    RATE_LIMIT_ENABLED: "false",
    UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
    VECTOR_STORE_PROVIDER: "pgvector",
  });

  // Starts `node server.js` of either checkout; resolves with its URL once it
  // listens, or with its exit (and output) when it stops first.
  const startServer = (directory, environment) => {
    const child = spawn(process.execPath, [path.join(directory, "server.js")], {
      cwd: tempRoot,
      env: { ...baseEnvironment(), ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

    children.add(child);
    exited.then(() => children.delete(child));
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    const started = new Promise((resolve) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;

        const appPort = /server is running on port (\d+)/u.exec(output)?.[1];

        if (appPort) {
          resolve({ appUrl: `http://127.0.0.1:${appPort}` });
        }
      });
      exited.then((exit) => resolve({ exit }));
    });

    return started.then((result) => ({ ...result, child, exited, output: () => output }));
  };

  const stopServer = async (server) => {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGTERM");
    }

    return server.exited;
  };

  const runCli = (script, args, environment) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(serverDirectory, script), ...args], {
        cwd: tempRoot,
        env: { ...baseEnvironment(), ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("exit", (code) => resolve({ code, stderr, stdout }));
    });

  const call = (server, pathname, { body, headers = {}, method = "GET", token } = {}) =>
    fetch(`${server.appUrl}${pathname}`, {
      body,
      headers: { ...(token ? { "x-api-key": token } : {}), ...headers },
      method,
      signal: AbortSignal.timeout(30_000),
    });
  const postJson = (server, pathname, payload, token) =>
    call(server, pathname, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
      token,
    });

  const uploadDocument = async (server, name, tenant, title) => {
    const form = new FormData();

    form.append(
      "file",
      new Blob([buildTextPdf({ pages: [tenant.lines], title })], { type: "application/pdf" }),
      `${name}-${title.replaceAll(" ", "-")}.pdf`
    );

    const response = await call(server, "/upload", { body: form, method: "POST", token: tenant.token });
    const body = await response.json();

    assert.equal(response.status, 201, JSON.stringify(body));

    return body.docId ?? body.document?.docId;
  };

  const listDocIds = async (server, tenant) => {
    const response = await call(server, "/documents", { token: tenant.token });
    const documents = await response.json();

    assert.equal(response.status, 200, JSON.stringify(documents));

    return documents.map((document) => document.docId).sort();
  };

  const ask = async (server, tenant, docIds, sessionId) => {
    const response = await postJson(server, "/chat", { docIds, question: tenant.question, sessionId }, tenant.token);

    return { body: await response.json(), status: response.status };
  };

  const docIds = { alice: [], bob: [] };

  before(async () => {
    // The DBA's part: a login that owns the database but may not create roles
    // and is no superuser, pgvector (not a trusted extension), and the tenant
    // role, which the owner may SET (migration 013 then grants nothing).
    await sql(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN NOCREATEROLE NOSUPERUSER PASSWORD '${ownerPassword}'`);
    await sql(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await sql(dbaUrl(), "CREATE EXTENSION IF NOT EXISTS vector");
    await sql(adminDatabaseUrl, `CREATE ROLE ${tenantRole} NOLOGIN`);
    await sql(adminDatabaseUrl, `GRANT ${tenantRole} TO ${ownerRole} WITH SET TRUE`);

    modelServer = await startFakeModel();
  });

  after(async () => {
    for (const child of children) {
      child.kill("SIGKILL");
    }

    await new Promise((resolve) => (modelServer ? modelServer.close(resolve) : resolve()));
    await sql(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);

    for (const role of [runtimeRole, systemRole, tenantRole, ownerRole]) {
      await sql(adminDatabaseUrl, `DROP ROLE IF EXISTS ${role}`);
    }

    rmSync(tempRoot, { force: true, recursive: true });
  });

  test("an archive written by the older checkout upgrades on a least-privilege database and keeps its isolation", async (t) => {
    await t.test("the older checkout writes documents, runs, memory, audit events and feedback", async () => {
      const old = await startServer(oldServerDirectory, { POSTGRES_DATABASE_URL: ownerUrl() });

      assert.ok(old.appUrl, `the older server did not start:\n${old.output()}`);

      for (const [name, tenant] of Object.entries(TENANTS)) {
        docIds[name].push(await uploadDocument(old, name, tenant, "handbook"));

        const { body, status } = await ask(old, tenant, docIds[name], `${name}-session`);

        assert.equal(status, 200, JSON.stringify(body));
        assert.match(body.agentAnswer, tenant.answer);

        const feedback = await postJson(
          old,
          "/feedback",
          { answerText: body.agentAnswer, feedbackType: "helpful", question: tenant.question },
          tenant.token
        );

        assert.equal(feedback.status, 201, await feedback.text());
      }

      // Admin reads leave audit events behind (authorization decisions).
      assert.equal((await call(old, "/admin/status", { token: ADMIN_TOKEN })).status, 200);
      assert.equal((await call(old, "/admin/audit", { token: ADMIN_TOKEN })).status, 200);

      const { code } = await stopServer(old);

      assert.equal(code, 0, old.output());
    });

    const beforeUpgrade = await sql(ownerUrl(), "SELECT id FROM schema_migrations ORDER BY id");
    const oldMigrations = beforeUpgrade.rows.map((row) => row.id);
    const auditRowsBefore = Number((await sql(ownerUrl(), "SELECT count(*)::int AS n FROM rag_admin_audit_events")).rows[0].n);

    assert.ok(auditRowsBefore > 0, "the older server wrote audit events");

    await t.test("without the system role the start fails with the DBA hint and changes nothing", async () => {
      const blocked = await startServer(serverDirectory, {
        POSTGRES_DATABASE_URL: ownerUrl(),
        STARTUP_HEALTH_STRICT: "true",
      });

      if (blocked.appUrl) {
        await stopServer(blocked);
      } else {
        await blocked.exited;
      }

      assert.match(blocked.output(), new RegExp(`CREATE ROLE ${systemRole} NOLOGIN`, "u"), blocked.output());

      // Migrations before 035 may have been applied; 035 itself rolled back.
      const applied = (await sql(ownerUrl(), "SELECT id FROM schema_migrations ORDER BY id")).rows.map((row) => row.id);

      assert.equal(applied.some((id) => id.startsWith("035_")), false, applied.join(", "));
      assert.deepEqual(applied.slice(0, oldMigrations.length), oldMigrations);
    });

    await t.test("with the system role every pending migration applies and the old data stays isolated", async () => {
      await sql(adminDatabaseUrl, `CREATE ROLE ${systemRole} NOLOGIN`);

      const upgraded = await startServer(serverDirectory, { POSTGRES_DATABASE_URL: ownerUrl() });

      assert.ok(upgraded.appUrl, `the upgraded server did not start:\n${upgraded.output()}`);

      const applied = (await sql(ownerUrl(), "SELECT id FROM schema_migrations ORDER BY id")).rows.map((row) => row.id);

      assert.ok(applied.some((id) => id.startsWith("041_")), applied.join(", "));

      for (const [name, tenant] of Object.entries(TENANTS)) {
        assert.deepEqual(await listDocIds(upgraded, tenant), [...docIds[name]].sort(), `${name} lists its own documents`);

        const own = await ask(upgraded, tenant, docIds[name], `${name}-session`);

        assert.equal(own.status, 200, JSON.stringify(own.body));
        assert.match(own.body.agentAnswer, tenant.answer);
      }

      // The other tenant's document answers like a missing one: whatever the
      // status, nothing of it comes back.
      const crossed = await postJson(
        upgraded,
        "/chat",
        { docIds: docIds.bob, question: TENANTS.bob.question, sessionId: "alice-cross" },
        TENANTS.alice.token
      );
      const crossedText = await crossed.text();

      assert.doesNotMatch(crossedText, TENANTS.bob.answer, crossedText);
      assert.equal(crossedText.includes("Boreal"), false, crossedText);
      assert.equal(
        (await call(upgraded, `/documents/${docIds.bob[0]}/file`, { token: TENANTS.alice.token })).status,
        404
      );

      const ready = await call(upgraded, "/ready", { token: ADMIN_TOKEN });
      const readiness = await ready.json();

      assert.equal(ready.status, 200, JSON.stringify(readiness));
      assert.equal(readiness.checks.rowLevelSecurity.status, "ok", JSON.stringify(readiness.checks.rowLevelSecurity));

      const { code } = await stopServer(upgraded);

      assert.equal(code, 0, upgraded.output());

      // Pre-041 rows are legacy rows, not breaks.
      const verify = await runCli("audit-verify.mjs", ["--json"], { POSTGRES_DATABASE_URL: ownerUrl() });

      assert.equal(verify.code, 0, `${verify.stdout}\n${verify.stderr}`);

      // The pre-034 feedback file moves into PostgreSQL, once.
      const dryRun = await runCli("feedback-import.mjs", ["--json"], { POSTGRES_DATABASE_URL: ownerUrl() });

      assert.equal(dryRun.code, 0, `${dryRun.stdout}\n${dryRun.stderr}`);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const applyRun = await runCli("feedback-import.mjs", ["--apply", "--json"], { POSTGRES_DATABASE_URL: ownerUrl() });

        assert.equal(applyRun.code, 0, `${applyRun.stdout}\n${applyRun.stderr}`);
      }

      const feedbackRows = await sql(ownerUrl(), "SELECT owner_user_id, workspace_id FROM rag_feedback ORDER BY owner_user_id");

      assert.deepEqual(
        feedbackRows.rows.map((row) => [row.owner_user_id, row.workspace_id]),
        [["alice", "ws-a"], ["bob", "ws-b"]]
      );
    });

    await t.test("the role split and strict context switch on for the existing archive", async () => {
      // create-split-roles.sql's shape for an existing database: a runtime
      // login that owns nothing, with SET (not INHERIT) on both roles; the
      // DBA grants them because the owner may not.
      await sql(adminDatabaseUrl, `CREATE ROLE ${runtimeRole} LOGIN NOCREATEROLE NOSUPERUSER PASSWORD '${runtimePassword}'`);
      await sql(adminDatabaseUrl, `GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`);
      await sql(adminDatabaseUrl, `GRANT ${tenantRole} TO ${runtimeRole} WITH INHERIT FALSE, SET TRUE`);
      await sql(adminDatabaseUrl, `GRANT ${systemRole} TO ${runtimeRole} WITH INHERIT FALSE, SET TRUE`);

      const split = await startServer(serverDirectory, {
        POSTGRES_DATABASE_URL: runtimeUrl(),
        POSTGRES_MIGRATION_DATABASE_URL: ownerUrl(),
        POSTGRES_TENANT_CONTEXT: "strict",
      });

      assert.ok(split.appUrl, `the split server did not start:\n${split.output()}`);

      const ready = await call(split, "/ready", { token: ADMIN_TOKEN });
      const readiness = await ready.json();

      assert.equal(ready.status, 200, JSON.stringify(readiness));
      assert.equal(readiness.checks.rowLevelSecurity.status, "ok", JSON.stringify(readiness.checks.rowLevelSecurity));
      assert.equal(readiness.checks.rowLevelSecurity.roleSplit?.status, "ok", JSON.stringify(readiness.checks.rowLevelSecurity));

      const annex = {
        ...TENANTS.alice,
        answer: /forty dollars/u,
        lines: ["Program Aster remote work annex.", "Remote staff receive a monthly home office allowance of forty dollars."],
        question: "Which home office allowance do remote staff receive?",
      };

      docIds.alice.push(await uploadDocument(split, "alice", annex, "remote annex"));

      for (const [name, tenant] of Object.entries(TENANTS)) {
        assert.deepEqual(await listDocIds(split, tenant), [...docIds[name]].sort(), `${name} after the split`);

        const own = await ask(split, tenant, docIds[name].slice(0, 1), `${name}-session`);

        assert.equal(own.status, 200, JSON.stringify(own.body));
        assert.match(own.body.agentAnswer, tenant.answer);
      }

      const fresh = await ask(split, annex, [docIds.alice[1]], "alice-annex");
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
      assert.match(fresh.body.agentAnswer, annex.answer);

      assert.equal(
        (await call(split, `/documents/${docIds.alice[1]}/file`, { token: TENANTS.bob.token })).status,
        404
      );
      // Admin reads are audited (authorization decisions), now chained.
      assert.equal((await call(split, "/admin/status", { token: ADMIN_TOKEN })).status, 200);
      assert.equal((await call(split, "/admin/audit", { token: ADMIN_TOKEN })).status, 200);
      assert.equal(split.output().includes("ARCHIVE_RAG_TENANT_CONTEXT_MISSING"), false, split.output());

      const { code } = await stopServer(split);

      assert.equal(code, 0, split.output());

      const chained = await sql(
        ownerUrl(),
        "SELECT count(*)::int AS n FROM rag_admin_audit_events WHERE row_hash IS NOT NULL"
      );

      assert.ok(chained.rows[0].n > 0, "audit events written after the upgrade are chained");

      const verify = await runCli("audit-verify.mjs", ["--json"], { POSTGRES_DATABASE_URL: ownerUrl() });

      assert.equal(verify.code, 0, `${verify.stdout}\n${verify.stderr}`);
    });
  });
}
