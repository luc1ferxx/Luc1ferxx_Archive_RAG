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

// The database role split (POSTGRES_MIGRATION_DATABASE_URL) on a real
// PostgreSQL with pgvector. An owner login (CREATEROLE, owns the database)
// runs every migration and DDL through the migration URL; a separate runtime
// login -- NOSUPERUSER, NOBYPASSRLS, created with the default INHERIT so the
// grant's own INHERIT FALSE is what keeps it from using the roles' privileges
// -- serves the application through POSTGRES_DATABASE_URL. Proven here:
//
// * the migrations run as the owner and grant the runtime login the tenant and
//   system roles with SET only; the runtime login owns and reaches nothing;
// * an empty table's resize goes through the owner pool;
// * a tenant sees only its own rows, system work (a registry load, a
//   recovery-style cross-tenant listing, an owner-path sparse search, the
//   audit purge) sees every tenant's;
// * a statement bound to no context fails closed with a permission error;
// * an index version is built and retired: its DDL as the owner, its writes as
//   the system role, its rows isolated like version 1's;
// * the health check is ok with the split and reports a BYPASSRLS runtime
//   login, an inherited grant, a direct grant and a missing system_access
//   policy as errors;
// * `node server.js` with the split and POSTGRES_TENANT_CONTEXT=strict serves
//   two tenants' async ingestion, listings, /chat and /ready without a single
//   permission error.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one); otherwise it is
// reported as skipped, never as passed. It provisions its own databases and
// roles (the system and tenant roles are unique to the run) and drops them.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!adminDatabaseUrl) {
  test("postgres role split integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `split_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const runtimeRole = `split_it_app_${suffix}`;
  const runtimePassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `split_it_tenant_${suffix}`;
  const systemRole = `split_it_system_${suffix}`;
  const databaseName = `split_it_${suffix}`;
  const monolithDatabaseName = `split_it_app_${suffix}`;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "role-split-it-"));
  const EMBEDDING_MODEL = "split-it-embedding";
  const DIMENSIONS = 8;
  const POINTER_TTL_MS = 200;
  const WORDS = ["alpha", "beta", "gamma", "delta", "policy", "budget", "travel"];
  const ALICE = { userId: "alice", workspaceId: "ws-a" };
  const BOB = { userId: "bob", workspaceId: "ws-b" };
  const MANAGED_VARIABLES = [
    "LONG_MEMORY_DATABASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_EMBEDDING_MODEL",
    "PDF_PARSER",
    "POSTGRES_DATABASE_URL",
    "POSTGRES_MIGRATION_DATABASE_URL",
    "POSTGRES_ROW_LEVEL_SECURITY",
    "POSTGRES_SYSTEM_ROLE",
    "POSTGRES_TENANT_CONTEXT",
    "POSTGRES_TENANT_ROLE",
    "RAG_AGENT_EXPERIENCE_MEMORY_ENABLED",
    "RAG_DATA_DIRECTORY",
    "RAG_EMBEDDING_DIMENSIONS",
    "RAG_INDEX_VERSION_POINTER_TTL_MS",
    "RAG_LONG_MEMORY_ENABLED",
    "SESSION_MEMORY_STORE_PROVIDER",
    "VECTOR_STORE_PROVIDER",
  ];
  const savedEnvironment = new Map(MANAGED_VARIABLES.map((name) => [name, process.env[name]]));

  const withDatabase = (url, name, { user, password } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
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
  // As the superuser, in the suite's database.
  const dbaQuery = (sql, values) => adminQuery(withDatabase(adminDatabaseUrl, databaseName), sql, values);
  // As the owner, in the suite's database.
  const ownerQuery = (sql, values) =>
    adminQuery(withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole }), sql, values);

  // A word-count embedding: the documents' topic words rank them first.
  const embed = (text) => {
    const lower = String(text).toLowerCase();

    return [...WORDS.map((word) => (lower.includes(word) ? 1 : 0)), 0.05];
  };
  const provider = {
    completeText: async (prompt) => {
      const sourceMatch = String(prompt).match(/\[Source 1\][^\n]*\n([^\n]+)/);

      return `${sourceMatch?.[1]?.trim() ?? "The documents describe the policy."} [Source 1]`;
    },
    embedQuery: async (query) => embed(query),
    embedTexts: async (texts) => texts.map((text) => embed(text)),
  };

  let modules;

  const q = (sql, values = []) => modules.postgres.queryPostgres(sql, values);
  const asSystem = (callback) => modules.tenant.runAsDatabaseSystem(callback);
  const asUnscoped = (callback) => modules.tenant.runWithDatabaseTenant({}, callback);
  const asTenant = (scope, callback) => modules.tenant.runWithDatabaseTenant(scope, callback);
  const docIdsIn = async (table) => (await q(`SELECT DISTINCT doc_id FROM ${table} ORDER BY 1`)).rows.map((row) => row.doc_id);
  const ingest = async (scope, docId, sentences) => {
    const filePath = path.join(tempRoot, `${docId}-${randomBytes(3).toString("hex")}.pdf`);

    writeFileSync(filePath, buildTextPdf({ pages: [sentences] }));

    return asTenant(scope, () =>
      modules.rag.ingestDocument({
        docId,
        fileName: `${docId}.pdf`,
        filePath,
        ownerUserId: scope.userId,
        workspaceId: scope.workspaceId,
      })
    );
  };
  const healthEntry = async () =>
    (await asSystem(() => modules.health.buildHealthReport())).checks.rowLevelSecurity;
  const isPermissionDenied = (error) => {
    assert.equal(error?.code, "42501", `expected a permission error, got ${error?.code}: ${error?.message}`);
    return true;
  };

  before(async () => {
    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    // Default INHERIT on purpose: the migrator's grant (INHERIT FALSE) alone
    // must keep it from using the tenant and system roles' privileges.
    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`);

    for (const name of [databaseName, monolithDatabaseName]) {
      await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${name} OWNER ${ownerRole}`);
      // pgvector is not a trusted extension; a superuser installs it, as a DBA would.
      await adminQuery(withDatabase(adminDatabaseUrl, name), "CREATE EXTENSION IF NOT EXISTS vector");
    }

    Object.assign(process.env, {
      LONG_MEMORY_DATABASE_URL: "",
      OPENAI_API_KEY: "role-split-it-key",
      OPENAI_EMBEDDING_MODEL: EMBEDDING_MODEL,
      PDF_PARSER: "pdfjs",
      POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName, { password: runtimePassword, user: runtimeRole }),
      POSTGRES_MIGRATION_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName, {
        password: ownerPassword,
        user: ownerRole,
      }),
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_SYSTEM_ROLE: systemRole,
      POSTGRES_TENANT_CONTEXT: "lenient",
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
      RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
      RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      // Short, so a version deactivated by the rollback may be retired soon after.
      RAG_INDEX_VERSION_POINTER_TTL_MS: String(POINTER_TTL_MS),
      RAG_LONG_MEMORY_ENABLED: "false",
      SESSION_MEMORY_STORE_PROVIDER: "memory",
      VECTOR_STORE_PROVIDER: "pgvector",
    });

    const [config, postgres, tenant, migrations, registry, rag, openai, vectorStore, pgvector, lifecycle, health, taskStore, auditStore] =
      await Promise.all([
        import("../rag/config.js"),
        import("../rag/postgres.js"),
        import("../rag/postgres-tenant.js"),
        import("../rag/db-migrations.js"),
        import("../rag/doc-registry.js"),
        import("../rag/index.js"),
        import("../rag/openai.js"),
        import("../rag/vector-store.js"),
        import("../rag/vector-store-pgvector.js"),
        import("../rag/vector-store-pgvector-version-lifecycle.js"),
        import("../health.js"),
        import("../rag/postgres-task-store.js"),
        import("../rag/postgres-admin-audit-store.js"),
      ]);

    modules = { auditStore, config, health, lifecycle, migrations, openai, pgvector, postgres, rag, registry, taskStore, tenant, vectorStore };
    config.configureEmbeddingDimensions(DIMENSIONS);
    openai.configureOpenAIProvider(provider);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    vectorStore.resetVectorStore();
  });

  after(async () => {
    try {
      modules?.openai.resetOpenAIProvider();
      modules?.config.configureEmbeddingDimensions(null);
      modules?.vectorStore.resetVectorStore();
      await modules?.registry.resetDocumentRegistryStore();
      modules?.migrations.resetPostgresMigrations();
      await modules?.postgres.resetPostgresPool();
    } finally {
      for (const [name, value] of savedEnvironment) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }

      for (const name of [databaseName, monolithDatabaseName]) {
        await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }

      for (const role of [runtimeRole, tenantRole, systemRole, ownerRole]) {
        await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${role}`);
      }

      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  test("migrations run as the owner through the migration URL and grant the runtime login both roles with SET only", async () => {
    const result = await modules.migrations.runPostgresMigrations();

    assert.equal(result.status, "ok");
    assert.ok(result.appliedMigrations.includes("013_enable_tenant_row_level_security.sql"));
    assert.ok(result.appliedMigrations.includes("035_create_system_role.sql"));
    assert.equal(result.runtimeLogin, runtimeRole, "read from the runtime connection's session_user");

    const facts = (
      await dbaQuery(
        `
          SELECT
            pg_has_role($1, $2, 'SET') AS tenant_set,
            pg_has_role($1, $2, 'USAGE') AS tenant_usage,
            pg_has_role($1, $3, 'SET') AS system_set,
            pg_has_role($1, $3, 'USAGE') AS system_usage,
            (SELECT r.rolcanlogin FROM pg_roles r WHERE r.rolname = $3) AS system_can_login,
            (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = $3) AS system_bypasses,
            ARRAY(
              SELECT DISTINCT pg_get_userbyid(c.relowner)::text
              FROM pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'S', 'v')
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
            ) AS owners,
            ARRAY(
              SELECT c.relname::text
              FROM pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v')
                AND has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
            ) AS runtime_reachable,
            (SELECT count(*)::int FROM schema_migrations) AS applied
        `,
        [runtimeRole, tenantRole, systemRole]
      )
    ).rows[0];

    assert.deepEqual(facts, {
      applied: result.appliedMigrations.length,
      owners: [ownerRole],
      runtime_reachable: [],
      system_bypasses: false,
      system_can_login: false,
      system_set: true,
      system_usage: false,
      tenant_set: true,
      tenant_usage: false,
    });

    // The next run (another process start) re-checks the grant and changes nothing.
    modules.migrations.resetPostgresMigrations();
    assert.deepEqual(await modules.migrations.runPostgresMigrations(), {
      appliedMigrations: [],
      runtimeLogin: runtimeRole,
      status: "ok",
    });
  });

  test("the runtime login and the system role can create nothing; an empty table's resize goes through the owner pool", async () => {
    await assert.rejects(asSystem(() => q("CREATE TABLE split_it_forbidden (id int)")), isPermissionDenied);
    await assert.rejects(q("CREATE TABLE split_it_forbidden (id int)"), isPermissionDenied);

    const width = async () =>
      (
        await dbaQuery(
          `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
            WHERE attrelid = 'rag_document_chunks'::regclass AND attname = 'embedding'`
        )
      ).rows[0].type;

    assert.equal(await width(), `vector(${DIMENSIONS})`);
    modules.config.configureEmbeddingDimensions(16);

    try {
      await modules.pgvector.ensurePgvectorSchema({ force: true });
      assert.equal(await width(), "vector(16)", "resized by the owner");
    } finally {
      modules.config.configureEmbeddingDimensions(DIMENSIONS);
      await modules.pgvector.ensurePgvectorSchema({ force: true });
    }

    assert.equal(await width(), `vector(${DIMENSIONS})`);
  });

  test("a tenant sees only its own rows while system work -- registry load, recovery listing, owner-path search -- sees every tenant's", async () => {
    await ingest(ALICE, "a-doc", ["Alpha policy requires manager approval for remote work."]);
    await ingest(BOB, "b-doc", ["Beta budget caps meals at forty dollars per day."]);
    // Unowned: visible to no tenant, only to system work.
    await asSystem(() =>
      q(
        `INSERT INTO rag_documents (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
         VALUES ('unowned-doc', 'unowned.pdf', $1, '', '')`,
        [Buffer.from("%PDF-1.4")]
      )
    );

    for (const scope of [ALICE, BOB]) {
      await asTenant(scope, () =>
        q(
          `INSERT INTO rag_tasks (user_id, workspace_id, task_id, type, status) VALUES ($1, $2, $3, 'research', 'queued')`,
          [scope.userId, scope.workspaceId, `${scope.userId}-task`]
        )
      );
    }

    assert.deepEqual(await asTenant(ALICE, () => docIdsIn("rag_documents")), ["a-doc"]);
    assert.deepEqual(await asTenant(ALICE, () => docIdsIn("rag_document_chunks")), ["a-doc"]);
    assert.deepEqual(await asTenant(BOB, () => docIdsIn("rag_document_chunks")), ["b-doc"]);
    assert.deepEqual(await asSystem(() => docIdsIn("rag_documents")), ["a-doc", "b-doc", "unowned-doc"]);
    assert.deepEqual(await asUnscoped(() => docIdsIn("rag_document_chunks")), ["a-doc", "b-doc"]);
    // A tenant cannot write another tenant's row; the system role can.
    await assert.rejects(
      asTenant(ALICE, () =>
        q(`INSERT INTO rag_tasks (user_id, workspace_id, task_id, type, status) VALUES ('bob', 'ws-b', 'forged', 'research', 'queued')`)
      ),
      isPermissionDenied
    );

    // The process-wide registry is filled by system work with every tenant's documents.
    await modules.registry.resetDocumentRegistryStore();
    await modules.registry.initializeDocumentRegistry();
    assert.deepEqual(
      modules.registry.listDocuments().map((document) => document.docId).sort(),
      ["a-doc", "b-doc", "unowned-doc"]
    );

    // Startup recovery lists every tenant's runnable tasks, then binds each one's scope.
    const store = modules.taskStore.createPostgresTaskStore();
    const recoverable = await asSystem(() => store.listRecoverable());

    assert.deepEqual(recoverable.map((task) => task.id).sort(), ["alice-task", "bob-task"]);
    assert.deepEqual(
      (await asTenant(ALICE, () => store.listRecoverable())).map((task) => task.id),
      ["alice-task"]
    );

    // The owner path's multi-document sparse search calls migration 030's
    // search function as the system role (EXECUTE from migration 035); a
    // tenant's call is narrowed by the function's tenant filter.
    const search = (run) =>
      run(() =>
        modules.pgvector.searchPgvectorSparseDocuments({
          docIds: ["a-doc", "b-doc"],
          queryText: "alpha policy beta budget",
          topK: 10,
        })
      );
    const docsOf = (results) => [...new Set(results.map((result) => result.document.metadata.docId))].sort();

    assert.deepEqual(docsOf(await search(asUnscoped)), ["a-doc", "b-doc"]);
    assert.deepEqual(docsOf(await search((callback) => asTenant(ALICE, callback))), ["a-doc"]);
  });

  test("the audit purge removes every tenant's expired events as the system role; a tenant still cannot delete one", async () => {
    const insertEvent = (eventId, scope, createdAt = new Date().toISOString()) =>
      q(
        `INSERT INTO rag_admin_audit_events (event_id, event_type, result, user_id, workspace_id, created_at)
         VALUES ($1, 'authorization_decision', 'allowed', $2, $3, $4::timestamptz)`,
        [eventId, scope.userId, scope.workspaceId, createdAt]
      );
    const allEventIds = async () =>
      (await asSystem(() => q("SELECT event_id FROM rag_admin_audit_events ORDER BY event_id"))).rows.map(
        (row) => row.event_id
      );

    await asSystem(() => insertEvent("bob-expired", BOB, "2000-01-01T00:00:00.000Z"));
    await asSystem(() => insertEvent("bob-current", BOB));
    await asTenant(ALICE, () => insertEvent("alice-current", ALICE));

    await assert.rejects(
      asTenant(ALICE, () => q("DELETE FROM rag_admin_audit_events WHERE event_id = 'alice-current'")),
      isPermissionDenied
    );

    const store = modules.auditStore.createPostgresAdminAuditStore({ retentionDays: 30 });

    await asTenant(ALICE, () =>
      store.recordEvent({
        eventId: "alice-recorded",
        principal: { userId: ALICE.userId, workspaceId: ALICE.workspaceId },
        result: "allowed",
        type: "authorization_decision",
      })
    );

    assert.deepEqual(await allEventIds(), ["alice-current", "alice-recorded", "bob-current"]);
    // Append-only for the system role too, apart from the purge: no UPDATE.
    await assert.rejects(
      asSystem(() => q("UPDATE rag_admin_audit_events SET result = 'denied' WHERE event_id = 'bob-current'")),
      isPermissionDenied
    );
  });

  // Migration 040: the system role may rewrite feedback citations (the
  // deletion cascade's redaction) and nothing else of a record; the tenant
  // role still may not update feedback at all.
  test("the system role may update only the citations of feedback, and a delete's redaction runs through it", async () => {
    const [{ createPostgresFeedbackStore }, { buildDocumentReferenceNeedles, redactDocumentText }] = await Promise.all([
      import("../rag/postgres-feedback-store.js"),
      import("../rag/document-deletion-redaction.js"),
    ]);
    const store = createPostgresFeedbackStore();
    const citations = [{ docId: "split-deleted", excerpt: "Split clause text.", fileName: "s.pdf", pageNumber: 1 }];

    try {
      await asTenant(ALICE, () =>
        store.recordFeedback({
          answerText: "answer",
          citations,
          feedbackId: "split-feedback",
          feedbackType: "helpful",
          question: "q",
          userId: ALICE.userId,
          workspaceId: ALICE.workspaceId,
        })
      );
      await assert.rejects(
        asTenant(ALICE, () => q("UPDATE rag_feedback SET citations = '[]'::json WHERE feedback_id = 'split-feedback'")),
        isPermissionDenied
      );
      await assert.rejects(
        asSystem(() => q("UPDATE rag_feedback SET note = 'changed' WHERE feedback_id = 'split-feedback'")),
        isPermissionDenied
      );

      const outcome = await asTenant(ALICE, () =>
        store.redactDocumentReferences({
          accessScope: ALICE,
          needles: buildDocumentReferenceNeedles(["split-deleted"]),
          redactCitations: (value) => redactDocumentText(value, ["split-deleted"]),
        })
      );

      assert.deepEqual(outcome, { redacted: 1 });
      assert.notEqual(
        (await asTenant(ALICE, () => store.listFeedback({ accessScope: ALICE })))[0].citations[0].excerpt,
        "Split clause text."
      );
    } finally {
      await ownerQuery("DELETE FROM rag_feedback WHERE feedback_id = 'split-feedback'");
    }
  });

  // The tenant erase (rag/tenant-lifecycle.js) runs as the system role: it
  // must be able to mark a registry workspace deleting and delete its
  // memberships, its row and its usage ledger rows (migrations 036 and 037
  // grant it full DML and system_access), and read them back per tenant for
  // the export, while the tenant role may not delete any of them.
  test("the system role erases a workspace's registry rows and usage rows; the tenant role cannot", async () => {
    const [registryModule, usageModule] = await Promise.all([
      import("../rag/tenant-registry.js"),
      import("../rag/tenant-usage.js"),
    ]);
    const registry = registryModule.createTenantRegistryService({
      cacheTtlMs: 0,
      store: registryModule.createPostgresTenantRegistryStore(),
    });
    const usage = usageModule.createTenantUsageRecordStore({
      ledger: usageModule.createTenantUsageLedger({ clearTimer: () => {}, setTimer: () => ({ unref() {} }) }),
    });
    const CAROL = { userId: "carol", workspaceId: "ws-split-c" };
    const workspace = { userId: null, workspaceId: CAROL.workspaceId };

    try {
      await asSystem(async () => {
        await registry.createWorkspace({ workspaceId: CAROL.workspaceId });
        await registry.putMember({ roles: ["workspace.member"], userId: CAROL.userId, workspaceId: CAROL.workspaceId });
        await q(
          `INSERT INTO tenant_usage (workspace_id, owner_user_id, metric, period_start, value)
           VALUES ($1, $2, 'chat_requests', to_timestamp(floor(extract(epoch FROM NOW()) / 3600) * 3600), 3)`,
          [CAROL.workspaceId, CAROL.userId]
        );
      });

      for (const statement of [
        "DELETE FROM rag_workspace_members",
        "DELETE FROM rag_workspaces",
        "DELETE FROM tenant_usage",
        "UPDATE rag_workspaces SET status = 'deleting'",
      ]) {
        await assert.rejects(asTenant(CAROL, () => q(statement)), isPermissionDenied, statement);
      }

      // The export's reads, each bound to its tenant.
      const exported = [];

      for await (const entry of registry.iterateTenantRecords(workspace)) exported.push(entry.table);
      for await (const entry of usage.iterateTenantRecords(workspace)) exported.push(entry.table);

      assert.deepEqual(exported, ["workspace_members", "workspaces", "tenant_usage"]);

      await asSystem(async () => {
        assert.equal(await registry.markWorkspaceDeleting(CAROL.workspaceId), true);
        assert.deepEqual(await usage.deleteTenantRecords(workspace), {
          tenant_usage: { deleted: 1 },
          "tenant_usage:pending": { deleted: 0 },
        });
        assert.deepEqual(await registry.deleteTenantRecords(workspace), {
          workspace_members: { deleted: 1 },
          workspaces: { deleted: 1 },
        });
      });
      assert.equal(await asSystem(() => registry.getWorkspace(CAROL.workspaceId)), null);
    } finally {
      await ownerQuery(`DELETE FROM tenant_usage WHERE workspace_id = '${CAROL.workspaceId}'`);
      await ownerQuery(`DELETE FROM rag_workspaces WHERE workspace_id = '${CAROL.workspaceId}'`);
    }
  });

  test("a statement bound to no context runs as the runtime login and fails closed", async () => {
    await assert.rejects(q("SELECT doc_id FROM rag_documents"), isPermissionDenied);
    await assert.rejects(q("SELECT task_id FROM rag_tasks WHERE task_id = $1", ["alice-task"]), isPermissionDenied);
    await assert.rejects(
      modules.postgres.withPostgresTransaction((client) => client.query("SELECT count(*) FROM rag_admin_audit_events")),
      isPermissionDenied
    );
    // The owner-run search functions refuse the bare login too: called that
    // way they would rank every tenant's chunks.
    await assert.rejects(
      q(
        "SELECT chunk_id FROM rag_document_chunks_sparse_rank(to_tsquery('simple', 'alpha'), ARRAY['a-doc', 'b-doc'], 10)"
      ),
      isPermissionDenied
    );
    // The login cannot become the owner.
    await assert.rejects(q(`SELECT set_config('role', $1, false)`, [ownerRole]), isPermissionDenied);
    // Catalog reads need no privilege and still work.
    assert.equal((await q("SELECT session_user::text AS login")).rows[0].login, runtimeRole);
    // No raw runtime session is handed out at all under the split.
    await assert.rejects(
      asSystem(() => modules.postgres.withPostgresClient((client) => client.query("SELECT 1"))),
      { code: modules.postgres.ROLE_SPLIT_RAW_SESSION_ERROR_CODE }
    );
  });

  test("an index version is created and dropped as the owner, built, activated and rolled back as the system role, and isolates tenants like version 1", async () => {
    const result = await modules.lifecycle.startIndexVersionBuild({
      builderId: "split-it-builder",
      space: modules.lifecycle.resolveBuildEmbeddingSpace({}),
    });

    assert.equal(result.versionId, 2);
    assert.equal(result.version.status, "ready");

    const table = "rag_document_chunks_v2";
    const shape = (
      await dbaQuery(
        `
          SELECT
            pg_get_userbyid(c.relowner)::text AS owner,
            ARRAY(
              SELECT t.relname::text FROM pg_class t
              JOIN pg_policy p ON p.polrelid = t.oid AND p.polname = 'system_access'
              WHERE t.relname = ANY ($2::text[]) AND (SELECT r.oid FROM pg_roles r WHERE r.rolname = $3) = ANY (p.polroles)
              ORDER BY 1
            ) AS system_policies,
            has_table_privilege($3, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS system_dml,
            has_function_privilege($3, $4::regprocedure, 'EXECUTE') AS system_rank,
            has_function_privilege($3, to_regprocedure($5), 'EXECUTE') AS system_search,
            has_table_privilege($6, c.oid, 'SELECT') AS runtime_reads
          FROM pg_class c WHERE c.oid = $1::regclass
        `,
        [
          table,
          [table, `${table}_sparse_scopes`, `${table}_sparse_terms`, `${table}_sparse_scope_log`, `${table}_sparse_term_log`],
          systemRole,
          `${table}_sparse_rank(tsquery, text[], integer)`,
          `${table}_sparse_search(tsquery, tsvector, text[], integer, text, double precision, double precision, double precision, bigint, integer)`,
          runtimeRole,
        ]
      )
    ).rows[0];

    assert.deepEqual(shape, {
      owner: ownerRole,
      runtime_reads: false,
      system_dml: true,
      system_policies: [table, `${table}_sparse_scope_log`, `${table}_sparse_scopes`, `${table}_sparse_term_log`, `${table}_sparse_terms`].sort(),
      system_rank: true,
      system_search: true,
    });
    assert.deepEqual(await asSystem(() => docIdsIn(table)), ["a-doc", "b-doc"], "the build wrote every document");
    assert.deepEqual(await asTenant(ALICE, () => docIdsIn(table)), ["a-doc"]);
    await assert.rejects(q(`SELECT doc_id FROM ${table}`), isPermissionDenied);

    // Activation and rollback are registry and pointer writes of the system
    // role; searches follow the pointer to the new table and back.
    const sparseDocs = async (run) =>
      [
        ...new Set(
          (
            await run(() =>
              modules.pgvector.searchPgvectorSparseDocuments({
                docIds: ["a-doc", "b-doc"],
                queryText: "alpha policy beta budget",
                topK: 10,
              })
            )
          ).map((result) => result.document.metadata.docId)
        ),
      ].sort();
    const activated = await modules.lifecycle.activateIndexVersion({ versionId: 2 });

    assert.equal(activated.activeVersionId, 2);
    assert.equal((await modules.pgvector.getActivePgvectorVersion({ force: true })).chunkTable, table);
    assert.deepEqual(await sparseDocs((callback) => asTenant(ALICE, callback)), ["a-doc"]);
    assert.deepEqual(await sparseDocs(asUnscoped), ["a-doc", "b-doc"]);

    const rolledBack = await modules.lifecycle.rollbackIndexVersion();

    assert.equal(rolledBack.activeVersionId, 1);
    assert.equal((await modules.pgvector.getActivePgvectorVersion({ force: true })).chunkTable, "rag_document_chunks");
    // Retire refuses a version deactivated less than two pointer TTLs ago.
    await new Promise((resolve) => setTimeout(resolve, 2 * POINTER_TTL_MS + 200));

    const retired = await modules.lifecycle.retireIndexVersion({ force: true, versionId: 2 });

    assert.equal(retired.droppedTable, true);
    assert.deepEqual(
      (
        await dbaQuery(`SELECT to_regclass($1) AS chunks, to_regclass($2) AS terms`, [table, `${table}_sparse_terms`])
      ).rows[0],
      { chunks: null, terms: null }
    );
  });

  test("the health check is ok with the split and reports a BYPASSRLS login, inherited and direct grants and a missing policy", async () => {
    const healthy = await healthEntry();

    assert.equal(healthy.status, "ok", healthy.message);
    assert.equal(healthy.role, tenantRole);
    assert.deepEqual(
      { ...healthy.roleSplit, message: undefined },
      {
        enabled: true,
        login: runtimeRole,
        loginAttributes: { bypassRls: false, superuser: false },
        message: undefined,
        status: "ok",
        systemRole,
      }
    );

    const expectError = async (pattern, check) => {
      const entry = await healthEntry();

      assert.equal(entry.status, "error", JSON.stringify(entry));
      assert.equal(entry.roleSplit.status, "error");
      assert.match(entry.message, pattern);
      check?.(entry.roleSplit);
    };

    // ALTER ROLE ... BYPASSRLS needs a superuser: the admin login, as a DBA.
    await adminQuery(adminDatabaseUrl, `ALTER ROLE ${runtimeRole} BYPASSRLS`);

    try {
      await expectError(/BYPASSRLS/, (roleSplit) =>
        assert.deepEqual(roleSplit.loginAttributes, { bypassRls: true, superuser: false })
      );
    } finally {
      await adminQuery(adminDatabaseUrl, `ALTER ROLE ${runtimeRole} NOBYPASSRLS`);
    }

    // The tenant role granted WITH INHERIT TRUE: the login now reaches every
    // tenant table without switching role, though its policies still apply.
    await ownerQuery(`GRANT ${tenantRole} TO ${runtimeRole} WITH INHERIT TRUE`);

    try {
      await expectError(/without switching into the tenant or system role/, (roleSplit) =>
        assert.ok(roleSplit.loginUsableTables.includes("rag_documents"), JSON.stringify(roleSplit))
      );
    } finally {
      await ownerQuery(`GRANT ${tenantRole} TO ${runtimeRole} WITH INHERIT FALSE`);
    }

    await ownerQuery(`GRANT SELECT ON rag_feedback TO ${runtimeRole}`);

    try {
      await expectError(/rag_feedback/, (roleSplit) => assert.deepEqual(roleSplit.loginUsableTables, ["rag_feedback"]));
    } finally {
      await ownerQuery(`REVOKE SELECT ON rag_feedback FROM ${runtimeRole}`);
    }

    await ownerQuery("DROP POLICY system_access ON rag_session_memory");

    try {
      await expectError(/system_access policy: rag_session_memory/, (roleSplit) =>
        assert.deepEqual(roleSplit.missingSystemPolicies, ["rag_session_memory"])
      );
    } finally {
      await ownerQuery(`CREATE POLICY system_access ON rag_session_memory TO ${systemRole} USING (true) WITH CHECK (true)`);
    }

    assert.equal((await healthEntry()).status, "ok");
  });

  test("node server.js with the split and strict tenant context serves two tenants end to end without a permission error", async () => {
    const METRICS_DIMENSIONS = 64;
    const OPERATOR_TOKEN = `ops-${randomBytes(8).toString("hex")}`;
    const METRICS_TOKEN = randomBytes(16).toString("hex");
    const TENANTS = {
      carol: {
        lines: ["Program Aster employee handbook.", "Employees receive twelve paid annual leave days each year."],
        question: "How many paid annual leave days do employees receive?",
        scope: { userId: "carol", workspaceId: "ws-c" },
        token: `carol-${randomBytes(8).toString("hex")}`,
      },
      dave: {
        lines: ["Program Boreal travel policy.", "Travellers book economy class for flights under six hours."],
        question: "Which class do travellers book for flights under six hours?",
        scope: { userId: "dave", workspaceId: "ws-d" },
        token: `dave-${randomBytes(8).toString("hex")}`,
      },
    };
    const readBody = async (req) => {
      const chunks = [];

      for await (const chunk of req) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks).toString("utf8");
    };
    const modelServer = http.createServer(async (req, res) => {
      const payload = JSON.parse((await readBody(req)) || "{}");

      res.writeHead(200, { "content-type": "application/json" });

      if (req.url.endsWith("/embeddings")) {
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

        res.end(
          JSON.stringify({
            data: inputs.map((input, index) => ({
              embedding: hashEmbedding(input, METRICS_DIMENSIONS),
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
          choices: [{ finish_reason: "stop", index: 0, message: { content: buildFakeChatAnswer(payload), role: "assistant" } }],
          model: payload.model,
          object: "chat.completion",
          usage: { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 },
        })
      );
    });

    await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

    const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

    writeFileSync(emptyEnvironmentFile, "", "utf8");

    const child = spawn(process.execPath, [path.join(serverDirectory, "server.js")], {
      cwd: tempRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u.test(name)
          )
        ),
        AGENT_EXECUTION_PLANNER: "deterministic",
        AGENT_INTENT_PLANNER: "deterministic",
        AGENT_PLANNER_ROLLOUT: "deterministic",
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKENS: JSON.stringify({
          ...Object.fromEntries(Object.values(TENANTS).map((tenant) => [tenant.token, tenant.scope])),
          // An operator who may read the health details.
          [OPERATOR_TOKEN]: { roles: ["admin.owner"], userId: "ops", workspaceId: "ws-ops" },
        }),
        DOTENV_CONFIG_PATH: emptyEnvironmentFile,
        DOTENV_CONFIG_QUIET: "true",
        METRICS_ENABLED: "true",
        METRICS_PORT: "0",
        METRICS_TOKEN,
        OPENAI_API_KEY: "role-split-e2e-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${modelServer.address().port}/v1`,
        OPENAI_CHAT_MODEL: "role-split-e2e-chat",
        OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
        PDF_PARSER: "pdfjs",
        PORT: "0",
        POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, monolithDatabaseName, {
          password: runtimePassword,
          user: runtimeRole,
        }),
        POSTGRES_MIGRATION_DATABASE_URL: withDatabase(adminDatabaseUrl, monolithDatabaseName, {
          password: ownerPassword,
          user: ownerRole,
        }),
        POSTGRES_ROW_LEVEL_SECURITY: "enforce",
        POSTGRES_SYSTEM_ROLE: systemRole,
        POSTGRES_TENANT_CONTEXT: "strict",
        POSTGRES_TENANT_ROLE: tenantRole,
        RAG_CLAIM_JUDGE: "off",
        RAG_DATA_DIRECTORY: path.join(tempRoot, "monolith-rag-data"),
        RAG_EMBEDDING_DIMENSIONS: String(METRICS_DIMENSIONS),
        RAG_INGEST_MODE: "async",
        RAG_INGEST_WORKER_POLL_MS: "100",
        RAG_OBSERVABILITY_ENABLED: "false",
        RAG_RERANK_ENABLED: "false",
        RAG_SEMANTIC_CACHE: "off",
        RAG_SHARED_STATE: "memory",
        RATE_LIMIT_ENABLED: "false",
        STARTUP_HEALTH_STRICT: "true",
        UPLOADS_DIRECTORY: path.join(tempRoot, "monolith-uploads"),
        VECTOR_STORE_PROVIDER: "pgvector",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      const { appUrl, metricsUrl } = await new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          output += chunk;

          const port = /server is running on port (\d+)/u.exec(output)?.[1];
          const metricsPort = /\[metrics\] serving \/metrics on http:\/\/127\.0\.0\.1:(\d+)/u.exec(output)?.[1];

          if (port && metricsPort) {
            resolve({ appUrl: `http://127.0.0.1:${port}`, metricsUrl: `http://127.0.0.1:${metricsPort}/metrics` });
          }
        });
        exited.then(({ code, signal }) => reject(new Error(`server.js exited (${code ?? signal}):\n${output}`)));
      });
      const call = (pathname, { body, headers = {}, method = "GET", token } = {}) =>
        fetch(`${appUrl}${pathname}`, {
          body,
          headers: { ...(token ? { "x-api-key": token } : {}), ...headers },
          method,
          signal: AbortSignal.timeout(30_000),
        });
      const waitForJob = async (jobId, token) => {
        const deadline = Date.now() + 30_000;

        while (Date.now() < deadline) {
          const job = await (await call(`/ingest-jobs/${jobId}`, { token })).json();

          if (job.status !== "queued" && job.status !== "running") {
            return job;
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        throw new Error(`ingest job ${jobId} did not finish:\n${output}`);
      };
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
        assert.deepEqual(documents.map((document) => document.docId), [docIds[name]]);

        const chat = await call("/chat", {
          body: JSON.stringify({ docIds: [docIds[name]], question: tenant.question }),
          headers: { "content-type": "application/json" },
          method: "POST",
          token: tenant.token,
        });
        const answer = await chat.json();

        assert.equal(chat.status, 200, JSON.stringify(answer));
        assert.match(answer.agentAnswer, name === "carol" ? /twelve paid annual leave days/u : /economy class/u);
      }

      const ready = await call("/ready", { token: OPERATOR_TOKEN });
      const readiness = await ready.json();

      assert.equal(ready.status, 200, JSON.stringify(readiness));
      assert.equal(readiness.checks.rowLevelSecurity.status, "ok", JSON.stringify(readiness.checks.rowLevelSecurity));
      assert.equal(readiness.checks.rowLevelSecurity.roleSplit?.status, "ok");
      assert.equal(readiness.checks.rowLevelSecurity.roleSplit?.login, runtimeRole);

      // The ingest queue collector reads every tenant's jobs as system work
      // from the metrics listener.
      const scrape = await fetch(metricsUrl, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
      const exposition = await scrape.text();

      assert.equal(scrape.status, 200);
      assert.match(exposition, /archive_rag_ingest_jobs\{status="succeeded"\} 2/u);
      assert.doesNotMatch(exposition, /archive_rag_metrics_collector_errors_total\{[^}]*\} [1-9]/u);

      assert.doesNotMatch(output, /permission denied|42501/u, output);
      assert.doesNotMatch(output, /ARCHIVE_RAG_TENANT_CONTEXT_MISSING|ARCHIVE_RAG_OWNER_WORK_CONTEXT/u, output);

      child.kill("SIGTERM");

      const { code } = await exited;

      assert.equal(code, 0, output);
      assert.doesNotMatch(output, /permission denied/u, output);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }

      await new Promise((resolve) => modelServer.close(resolve));
    }
  });
}
