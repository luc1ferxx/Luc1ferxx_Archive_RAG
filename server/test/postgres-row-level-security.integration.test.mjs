import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";

// Real-database check that PostgreSQL row-level security isolates tenants even
// when a query carries no user/workspace filter. It runs only when
// PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled PostgreSQL where that
// login may create roles and databases (CI's pgvector/pgvector:pg16 service and
// scripts/run-pgvector-integration.sh both qualify); otherwise it is reported
// as skipped, never as passed.
//
// It provisions its own database owned by a non-superuser login with only
// CREATEROLE -- the shape of a managed database's application user -- so the
// migration's role-membership branch runs, and so the other integration suites
// that clear shared tables cannot interfere. Everything it creates is dropped
// afterwards.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!adminDatabaseUrl) {
  test("postgres row-level security integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `rls_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `rls_it_tenant_${suffix}`;
  const databaseName = `rls_it_${suffix}`;
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

  const ALICE = { userId: "alice", workspaceId: "ws-a" };
  const BOB = { userId: "bob", workspaceId: "ws-b" };

  let modules;
  let tables;

  before(async () => {
    const adminDatabaseName = new URL(adminDatabaseUrl).pathname.slice(1);

    await adminQuery(
      adminDatabaseUrl,
      `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`
    );
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    // pgvector is not a trusted extension; a superuser installs it, as a DBA
    // would, and migration 012's CREATE EXTENSION IF NOT EXISTS is then a no-op.
    await adminQuery(
      withDatabase(adminDatabaseUrl, databaseName),
      "CREATE EXTENSION IF NOT EXISTS vector"
    );
    assert.ok(adminDatabaseName, "the admin URL names a database");

    process.env.POSTGRES_DATABASE_URL = withDatabase(adminDatabaseUrl, databaseName, {
      password: ownerPassword,
      user: ownerRole,
    });
    process.env.POSTGRES_TENANT_ROLE = tenantRole;
    process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
    process.env.VECTOR_STORE_PROVIDER = "pgvector";
    process.env.OPENAI_EMBEDDING_MODEL = "rls-it-embedding";
    process.env.RAG_EMBEDDING_DIMENSIONS = "8";

    const [config, postgres, tenant, migrations, registry, pgvector, taskStore] =
      await Promise.all([
        import("../rag/config.js"),
        import("../rag/postgres.js"),
        import("../rag/postgres-tenant.js"),
        import("../rag/db-migrations.js"),
        import("../rag/doc-registry.js"),
        import("../rag/vector-store-pgvector.js"),
        import("../rag/postgres-task-store.js"),
      ]);

    modules = { config, migrations, pgvector, postgres, registry, taskStore, tenant };
    config.configureEmbeddingDimensions(8);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await migrations.runPostgresMigrations();

    tables = {
      chunks: config.getDocumentChunksPostgresTable(),
      documents: config.getDocumentsPostgresTable(),
      longMemory: config.getLongMemoryPostgresTable(),
      runEvents: config.getAgentRunEventsPostgresTable(),
      runs: config.getAgentRunsPostgresTable(),
      snapshots: `${config.getAgentRunsPostgresTable()}_approval_snapshots`,
      taskEvents: config.getTaskEventsPostgresTable(),
      tasks: config.getTasksPostgresTable(),
      artifacts: config.getWorkspaceArtifactsPostgresTable(),
    };

    // Seed as the owner: two tenants plus one unowned document that no
    // tenant may see.
    const q = postgres.queryPostgres;
    const vector = `[${[1, 0, 0, 0, 0, 0, 0, 0.05].join(",")}]`;

    for (const [scope, docId] of [
      [ALICE, "doc-alice"],
      [BOB, "doc-bob"],
      [{ userId: "", workspaceId: "" }, "doc-unowned"],
    ]) {
      await q(
        `INSERT INTO ${tables.documents} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [docId, `${docId}.pdf`, Buffer.from("%PDF-1.4"), scope.userId, scope.workspaceId]
      );
      await q(
        `INSERT INTO ${tables.chunks}
           (chunk_id, doc_id, chunk_index, content, search_text, owner_user_id, workspace_id,
            embedding_model, embedding_dimensions, embedding)
         VALUES ($1, $2, 0, $3, $3, $4, $5, 'rls-it-embedding', 8, $6::vector)`,
        [`${docId}:0`, docId, `alpha policy text for ${docId}`, scope.userId, scope.workspaceId, vector]
      );
    }

    for (const scope of [ALICE, BOB]) {
      const id = `${scope.userId}-1`;

      await q(
        `INSERT INTO ${tables.tasks} (user_id, workspace_id, task_id, type, status)
         VALUES ($1, $2, $3, 'research', 'queued')`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.taskEvents} (user_id, workspace_id, task_id, event_type)
         VALUES ($1, $2, $3, 'created')`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.runs} (user_id, workspace_id, run_id, status)
         VALUES ($1, $2, $3, 'running')`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.runEvents} (user_id, workspace_id, run_id, event_type)
         VALUES ($1, $2, $3, 'run_created')`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.snapshots}
           (user_id, workspace_id, run_id, gate_id, capability_id, capability_version,
            approval_object_hash, snapshot_version, execution_input)
         VALUES ($1, $2, $3, 'gate-1', 'cap', '1', 'hash', 1, '{}'::jsonb)`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.artifacts}
           (owner_user_id, workspace_id, artifact_id, artifact_type, version, title, idempotency_key)
         VALUES ($1, $2, $3, 'report', '1', 'Report', $3)`,
        [scope.userId, scope.workspaceId, id]
      );
      await q(
        `INSERT INTO ${tables.longMemory} (memory_id, user_id, category, text)
         VALUES ($1, $2, 'preference', 'likes concise answers')`,
        [id, scope.userId]
      );
    }
  });

  after(async () => {
    await modules?.postgres.resetPostgresPool();
    await modules?.registry.resetDocumentRegistryStore();
    await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    // The owner role also holds grants made by CREATE ROLE on the tenant role.
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
    await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
  });

  const asAlice = (callback) => modules.tenant.runWithDatabaseTenant(ALICE, callback);
  const scopedRows = async (tableName, userColumn = "user_id") =>
    (
      await modules.postgres.queryPostgres(
        `SELECT ${userColumn} AS owner FROM ${tableName} ORDER BY 1`
      )
    ).rows.map((row) => row.owner);

  test("a query with no WHERE clause returns only the tenant's rows in every covered table", async () => {
    const leaks = await asAlice(async () => ({
      artifacts: await scopedRows(tables.artifacts, "owner_user_id"),
      chunks: await scopedRows(tables.chunks, "owner_user_id"),
      documents: await scopedRows(tables.documents, "owner_user_id"),
      longMemory: await scopedRows(tables.longMemory),
      runEvents: await scopedRows(tables.runEvents),
      runs: await scopedRows(tables.runs),
      snapshots: await scopedRows(tables.snapshots),
      taskEvents: await scopedRows(tables.taskEvents),
      tasks: await scopedRows(tables.tasks),
    }));

    for (const [table, owners] of Object.entries(leaks)) {
      assert.deepEqual(owners, ["alice"], `${table} is isolated to alice`);
    }

    // The owner still sees every tenant (and the unowned document).
    assert.deepEqual(await scopedRows(tables.documents, "owner_user_id"), ["", "alice", "bob"]);
  });

  test("a tenant cannot insert, update, delete or upsert over another tenant's rows", async () => {
    await asAlice(async () => {
      await assert.rejects(
        modules.postgres.queryPostgres(
          `INSERT INTO ${tables.documents} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
           VALUES ('doc-forged', 'forged.pdf', '\\x00', 'bob', 'ws-b')`
        ),
        (error) => error.code === "42501" && /row-level security/.test(error.message)
      );
      await assert.rejects(
        modules.postgres.queryPostgres(
          `INSERT INTO ${tables.documents} (doc_id, file_name, file_bytes, owner_user_id, workspace_id)
           VALUES ('doc-bob', 'takeover.pdf', '\\x00', 'alice', 'ws-a')
           ON CONFLICT (doc_id) DO UPDATE SET file_name = EXCLUDED.file_name,
             owner_user_id = EXCLUDED.owner_user_id, workspace_id = EXCLUDED.workspace_id`
        ),
        (error) => error.code === "42501"
      );

      const updated = await modules.postgres.queryPostgres(
        `UPDATE ${tables.tasks} SET status = 'canceled'`
      );
      const deleted = await modules.postgres.queryPostgres(
        `DELETE FROM ${tables.runEvents} WHERE user_id = 'bob'`
      );

      assert.equal(updated.rowCount, 1, "only alice's task is updated");
      assert.equal(deleted.rowCount, 0, "bob's events are invisible to the delete");
    });

    const bobTask = await modules.postgres.queryPostgres(
      `SELECT status FROM ${tables.tasks} WHERE user_id = 'bob'`
    );

    assert.equal(bobTask.rows[0].status, "queued");
  });

  test("a store asked for the wrong scope still cannot read across tenants", async () => {
    const store = modules.taskStore.createPostgresTaskStore({
      runMigrations: async () => ({ status: "ok" }),
    });
    const crossTenant = await asAlice(() => store.get({ accessScope: BOB, taskId: "bob-1" }));
    const ownTask = await asAlice(() => store.get({ accessScope: ALICE, taskId: "alice-1" }));

    assert.equal(crossTenant, null);
    assert.equal(ownTask?.id, "alice-1");
  });

  test("transactions carry the tenant, raw sessions refuse it, and nothing leaks onto the pool", async () => {
    const inTransaction = await asAlice(() =>
      modules.postgres.withPostgresTransaction(async (client) => {
        const identity = await client.query("SELECT current_user AS role");
        const documents = await client.query(`SELECT doc_id FROM ${tables.documents}`);

        return { documents: documents.rows.map((row) => row.doc_id), role: identity.rows[0].role };
      })
    );

    assert.equal(inTransaction.role, tenantRole);
    assert.deepEqual(inTransaction.documents, ["doc-alice"]);
    await assert.rejects(
      asAlice(() => modules.postgres.withPostgresClient(async () => "unreachable")),
      /cannot run under a database tenant/
    );

    // Interleave tenant and owner queries across the pool: every owner query
    // must come back as the owner with no tenant setting left behind.
    const observations = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        index % 2 === 0
          ? asAlice(() => modules.postgres.queryPostgres("SELECT current_user AS role"))
          : modules.postgres.queryPostgres(
              "SELECT current_user AS role, current_setting('archive_rag.user_id', true) AS tenant"
            )
      )
    );

    observations.forEach((result, index) => {
      const row = result.rows[0];

      if (index % 2 === 0) {
        assert.equal(row.role, tenantRole);
      } else {
        assert.equal(row.role, ownerRole);
        assert.ok(!row.tenant, "no tenant setting survives on a pooled connection");
      }
    });
  });

  test("system work inside a tenant request sees every tenant", async () => {
    const owners = await asAlice(() =>
      modules.tenant.runAsDatabaseSystem(() => scopedRows(tables.tasks))
    );

    assert.deepEqual(owners, ["alice", "bob"]);
  });

  test("the process-wide document registry loads every tenant even when first touched by a tenant", async () => {
    await modules.registry.resetDocumentRegistryStore();

    const loaded = await asAlice(() => modules.registry.initializeDocumentRegistry());

    assert.deepEqual(
      loaded.map((document) => document.docId).sort(),
      ["doc-alice", "doc-bob", "doc-unowned"]
    );
    assert.deepEqual(
      modules.registry.listDocuments(ALICE).map((document) => document.docId),
      ["doc-alice"]
    );
  });

  test("vector and full-text search drop another tenant's chunks even when its docId is passed", async () => {
    modules.pgvector.resetPgvectorVectorStore();

    const queryVector = [1, 0, 0, 0, 0, 0, 0, 0.05];
    const [dense, sparse] = await asAlice(async () => [
      await modules.pgvector.searchPgvectorDocuments({
        docIds: ["doc-alice", "doc-bob"],
        queryText: "alpha policy",
        queryVector,
        topK: 5,
      }),
      await modules.pgvector.searchPgvectorSparseDocuments({
        docIds: ["doc-alice", "doc-bob"],
        queryText: "alpha policy",
        topK: 5,
      }),
    ]);

    assert.deepEqual(dense.map((result) => result.document.metadata.docId), ["doc-alice"]);
    assert.deepEqual(sparse.map((result) => result.document.metadata.docId), ["doc-alice"]);
  });

  test("the sparse rank function runs as its owner with a pinned search_path, only the tenant role may call it, and the join drops foreign ids", async () => {
    const functionName = modules.pgvector.getPgvectorSparseRankFunctionName();
    const definition = (
      await modules.postgres.queryPostgres(
        `SELECT p.prosecdef, p.proconfig, p.prorows,
                has_function_privilege($2, p.oid, 'EXECUTE') AS tenant_may_execute,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_may_execute
         FROM pg_proc p
         WHERE p.proname = $1`,
        [functionName, tenantRole]
      )
    ).rows;

    assert.equal(definition.length, 1);
    assert.equal(definition[0].prosecdef, true);
    assert.deepEqual(definition[0].proconfig, ["search_path=pg_catalog, pg_temp", "enable_indexscan=off"]);
    assert.equal(Number(definition[0].prorows), 20);
    assert.equal(definition[0].tenant_may_execute, true);
    assert.equal(definition[0].public_may_execute, false);

    // Called directly the function ranks by doc id alone and sees Bob's chunk;
    // the search itself first narrows the doc ids to those Alice can see in the
    // documents table, and joins back to the chunks as Alice (test above).
    const raw = await asAlice(() =>
      modules.postgres.queryPostgres(
        `SELECT chunk_id FROM ${functionName}(to_tsquery('simple', 'alpha'), $1::text[], 5) ORDER BY chunk_id`,
        [["doc-alice", "doc-bob"]]
      )
    );

    assert.deepEqual(raw.rows.map((row) => row.chunk_id), ["doc-alice:0", "doc-bob:0"]);
  });

  test("the health report proves the tenant role switch and every covered policy", async () => {
    const { buildHealthReport } = await import("../health.js");
    const report = await buildHealthReport();

    assert.equal(report.checks.rowLevelSecurity.status, "ok", report.checks.rowLevelSecurity.message);
    assert.equal(report.checks.rowLevelSecurity.role, tenantRole);
    assert.equal(report.checks.rowLevelSecurity.protectedTableCount, 9);
    assert.equal(report.checks.rowLevelSecurity.sparseRankExecutable, true);
  });

  test("POSTGRES_ROW_LEVEL_SECURITY=off keeps the owner connection", async () => {
    process.env.POSTGRES_ROW_LEVEL_SECURITY = "off";

    try {
      assert.deepEqual(await asAlice(() => scopedRows(tables.tasks)), ["alice", "bob"]);
    } finally {
      process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
    }
  });
}
