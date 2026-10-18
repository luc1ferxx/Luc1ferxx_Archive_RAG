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

  // Ids with quotes, backslashes, semicolons, newlines and a would-be second
  // statement: the tenant settings bind them as parameters, so PostgreSQL must
  // hand back exactly these strings and run nothing else.
  const HOSTILE = {
    userId: `o'brien\\'); DROP TABLE ${"rag_tasks"}; --\nline two $1 "q" é`,
    workspaceId: `ws\\\\'; SELECT set_config('role', 'postgres', false); --\r\n'`,
  };
  const IDENTITY_SQL = `SELECT current_user AS role,
    current_setting('archive_rag.user_id') AS user_id,
    current_setting('archive_rag.workspace_id') AS workspace_id`;

  // Counts pg client.query calls, one per round trip: a pipelined tenant
  // statement is one call carrying one Sync.
  const countClientQueries = async (callback) => {
    const original = pg.Client.prototype.query;
    let calls = 0;

    pg.Client.prototype.query = function countedQuery(...args) {
      calls += 1;
      return original.apply(this, args);
    };

    try {
      const result = await callback();

      return { calls, result };
    } finally {
      pg.Client.prototype.query = original;
    }
  };

  const ownerSeesNoTenantState = async () => {
    // A destroyed connection's backend exits asynchronously; wait for it.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const open = await modules.postgres.queryPostgres(
        `SELECT count(*)::int AS open FROM pg_stat_activity
         WHERE datname = current_database() AND state LIKE 'idle in transaction%'`
      );

      if (open.rows[0].open === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const observations = await Promise.all(
      Array.from({ length: 12 }, () =>
        modules.postgres.queryPostgres(
          `SELECT current_user AS role, current_setting('archive_rag.user_id', true) AS tenant,
                  (SELECT count(*)::int FROM pg_stat_activity
                   WHERE datname = current_database() AND state LIKE 'idle in transaction%') AS open`
        )
      )
    );

    observations.forEach(({ rows: [row] }) => {
      assert.equal(row.role, ownerRole);
      assert.ok(!row.tenant, "no tenant setting survives on a pooled connection");
      assert.equal(row.open, 0, "no session is left inside a transaction");
    });
  };

  test("hostile ids round-trip exactly through the tenant settings and inject nothing", async () => {
    const asHostile = (callback) => modules.tenant.runWithDatabaseTenant(HOSTILE, callback);
    const single = await asHostile(() => modules.postgres.queryPostgres(IDENTITY_SQL));
    const inTransaction = await asHostile(() =>
      modules.postgres.withPostgresTransaction((client) => client.query(IDENTITY_SQL))
    );

    for (const { rows: [row] } of [single, inTransaction]) {
      assert.equal(row.role, tenantRole);
      assert.equal(row.user_id, HOSTILE.userId);
      assert.equal(row.workspace_id, HOSTILE.workspaceId);
    }

    // The hostile tenant owns nothing, and nothing was dropped or changed.
    assert.deepEqual(await asHostile(() => scopedRows(tables.tasks)), []);
    assert.deepEqual(await scopedRows(tables.tasks), ["alice", "bob"]);
    await ownerSeesNoTenantState();
  });

  test("an id PostgreSQL cannot store fails the statement closed instead of truncating it", async () => {
    await assert.rejects(
      modules.tenant.runWithDatabaseTenant({ userId: "alice\u0000bob", workspaceId: "ws-a" }, () =>
        modules.postgres.queryPostgres(`SELECT task_id FROM ${tables.tasks}`)
      ),
      (error) => error.code === "22021"
    );
    await ownerSeesNoTenantState();
  });

  test("a tenant statement is one round trip and a tenant transaction adds only BEGIN+settings and COMMIT", async () => {
    const single = await countClientQueries(() =>
      asAlice(() => modules.postgres.queryPostgres(IDENTITY_SQL))
    );

    assert.equal(single.calls, 1);
    assert.equal(single.result.rows[0].role, tenantRole);
    assert.equal(single.result.rows[0].user_id, "alice");

    const transaction = await countClientQueries(() =>
      asAlice(() => modules.postgres.withPostgresTransaction((client) => client.query(IDENTITY_SQL)))
    );

    assert.equal(transaction.calls, 3, "BEGIN+settings, the statement, COMMIT");
    assert.equal(transaction.result.rows[0].role, tenantRole);
  });

  test("a failing tenant statement or transaction rolls back and returns the connection as the owner", async () => {
    const insertTask = (taskId) =>
      `INSERT INTO ${tables.tasks} (user_id, workspace_id, task_id, type, status)
       VALUES ('alice', 'ws-a', '${taskId}', 'research', 'queued')`;

    // The insert runs, then the same statement fails: the implicit
    // transaction the Sync ends must roll the insert back.
    await assert.rejects(
      asAlice(() =>
        modules.postgres.queryPostgres(
          `WITH inserted AS (${insertTask("alice-rolled-back")} RETURNING 1)
           SELECT 1 / (count(*) - 1) FROM inserted`
        )
      ),
      (error) => error.code === "22012"
    );
    await assert.rejects(
      asAlice(() =>
        modules.postgres.withPostgresTransaction(async (client) => {
          await client.query(insertTask("alice-rolled-back-2"));
          await client.query("SELECT 1 / 0");
        })
      ),
      (error) => error.code === "22012"
    );

    const leftovers = await modules.postgres.queryPostgres(
      `SELECT task_id FROM ${tables.tasks} WHERE task_id LIKE 'alice-rolled-back%'`
    );

    assert.deepEqual(leftovers.rows, []);
    await ownerSeesNoTenantState();
  });

  test("a tenant statement that would leave a transaction open fails and its connection is discarded", async () => {
    await assert.rejects(
      asAlice(() => modules.postgres.queryPostgres("BEGIN")),
      (error) => error.code === modules.postgres.TENANT_PIPELINE_STATUS_ERROR_CODE
    );
    await ownerSeesNoTenantState();
    assert.deepEqual(await asAlice(() => scopedRows(tables.tasks)), ["alice"]);
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

  // What pg_proc says about a sparse-rank function: migration 014's shape,
  // which migration 033 keeps.
  const describeSparseRankFunction = async (functionName) =>
    (
      await modules.postgres.queryPostgres(
        `SELECT p.prosecdef, p.proconfig, p.prorows, pg_get_userbyid(p.proowner) AS owner,
                pg_get_function_identity_arguments(p.oid) AS arguments,
                pg_get_function_result(p.oid) AS result,
                has_function_privilege($2, p.oid, 'EXECUTE') AS tenant_may_execute,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_may_execute
         FROM pg_proc p
         WHERE p.proname = $1`,
        [functionName, tenantRole]
      )
    ).rows;
  const assertSparseRankShape = (rows, label) => {
    assert.equal(rows.length, 1, `${label}: one function`);
    assert.equal(rows[0].prosecdef, true, `${label}: SECURITY DEFINER`);
    assert.deepEqual(rows[0].proconfig, ["search_path=pg_catalog, pg_temp", "enable_indexscan=off"], label);
    assert.equal(Number(rows[0].prorows), 20, label);
    assert.equal(rows[0].owner, ownerRole, `${label}: owned by the table owner`);
    assert.equal(rows[0].arguments, "query tsquery, doc_ids text[], max_rows integer", label);
    assert.equal(rows[0].result, "TABLE(chunk_id text, sparse_score real)", `${label}: chunk ids and ranks only`);
    assert.equal(rows[0].tenant_may_execute, true, label);
    assert.equal(rows[0].public_may_execute, false, label);
  };
  // A direct call of a sparse-rank function, the way a statement running as
  // the tenant role could make it, bypassing buildTenantSparseSearchSql.
  const callSparseRank = (functionName, docIds, maxRows = 5) =>
    modules.postgres.queryPostgres(
      `SELECT chunk_id, sparse_score FROM ${functionName}(to_tsquery('simple', 'alpha'), $1::text[], $2)
       ORDER BY chunk_id`,
      [docIds, maxRows]
    );
  const chunkIds = (result) => result.rows.map((row) => row.chunk_id);
  const ALL_DOCS = ["doc-alice", "doc-bob", "doc-unowned"];
  // A checked-in migration rendered for this database's tables, with
  // `overrides` replacing some of them (014 rendered for a version table).
  const renderMigrationSqlFor = (sqlText, overrides = {}) =>
    modules.migrations.renderMigrationSql(sqlText, {
      adminAuditEventsTable: modules.config.getAdminAuditEventsPostgresTable(),
      agentRunEventsTable: modules.config.getAgentRunEventsPostgresTable(),
      agentRunsTable: modules.config.getAgentRunsPostgresTable(),
      documentChunksTable: modules.config.getDocumentChunksPostgresTable(),
      documentsTable: modules.config.getDocumentsPostgresTable(),
      indexVersionsTable: modules.config.getIndexVersionsPostgresTable(),
      ingestJobsTable: modules.config.getIngestJobsPostgresTable(),
      longMemoryTable: modules.config.getLongMemoryPostgresTable(),
      sessionMemoryTable: modules.config.getSessionMemoryPostgresTable(),
      taskEventsTable: modules.config.getTaskEventsPostgresTable(),
      tasksTable: modules.config.getTasksPostgresTable(),
      workspaceArtifactsTable: modules.config.getWorkspaceArtifactsPostgresTable(),
      ...overrides,
    });

  test("the sparse rank function runs as its owner with a pinned search_path, only the tenant role may call it, and it ranks only the caller's own documents", async () => {
    const functionName = modules.pgvector.getPgvectorSparseRankFunctionName();

    assertSparseRankShape(await describeSparseRankFunction(functionName), functionName);

    // Migration 033's installer is the owner's alone.
    const installer = (
      await modules.postgres.queryPostgres(
        `SELECT has_function_privilege($2, p.oid, 'EXECUTE') AS tenant_may_execute,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_may_execute
         FROM pg_proc p WHERE p.proname = $1`,
        [modules.migrations.getSparseRankInstallFunctionName(), tenantRole]
      )
    ).rows;

    assert.deepEqual(installer, [{ public_may_execute: false, tenant_may_execute: false }]);

    // Called directly as a tenant, the function itself drops every doc id the
    // documents policy hides: another tenant's, and the unowned document.
    assert.deepEqual(chunkIds(await asAlice(() => callSparseRank(functionName, ALL_DOCS))), ["doc-alice:0"]);
    assert.deepEqual(chunkIds(await asAlice(() => callSparseRank(functionName, ["doc-bob"]))), []);
    assert.deepEqual(chunkIds(await asAlice(() => callSparseRank(functionName, ["doc-unowned"]))), []);
    assert.deepEqual(
      chunkIds(await modules.tenant.runWithDatabaseTenant(BOB, () => callSparseRank(functionName, ALL_DOCS))),
      ["doc-bob:0"]
    );
    assert.deepEqual(
      chunkIds(
        await modules.tenant.runWithDatabaseTenant({ userId: "mallory", workspaceId: "ws-m" }, () =>
          callSparseRank(functionName, ALL_DOCS)
        )
      ),
      []
    );
    // A foreign chunk takes no place under max_rows either: the chunks tie,
    // and doc-alice:0 sorts first, so Bob's one row is his own.
    assert.deepEqual(
      chunkIds(
        await modules.tenant.runWithDatabaseTenant(BOB, () =>
          callSparseRank(functionName, ["doc-alice", "doc-bob"], 1)
        )
      ),
      ["doc-bob:0"]
    );

    // The owner path is unchanged: every doc id it passes is ranked, and a
    // tenant's own documents rank exactly as the owner ranks them.
    const owner = await callSparseRank(functionName, ALL_DOCS);

    assert.deepEqual(chunkIds(owner), ["doc-alice:0", "doc-bob:0", "doc-unowned:0"]);
    assert.deepEqual(
      (await asAlice(() => callSparseRank(functionName, ["doc-alice"]))).rows,
      owner.rows.filter((row) => row.chunk_id === "doc-alice:0")
    );
  });

  test("every index version's sparse rank function filters a tenant's doc ids: a new version's from the template, an existing one's from migration 033", async () => {
    const { readFile } = await import("node:fs/promises");
    const migrationText = (fileName) =>
      readFile(new URL(`../db/migrations/${fileName}`, import.meta.url), "utf8");
    const versionsTable = modules.config.getIndexVersionsPostgresTable();
    const created = `${tables.chunks}_v91`;
    const existing = `${tables.chunks}_v92`;
    const q = modules.postgres.queryPostgres;
    const seedChunks = async (chunkTable) => {
      const vector = `[${[1, 0, 0, 0, 0, 0, 0, 0.05].join(",")}]`;

      for (const [scope, docId] of [
        [ALICE, "doc-alice"],
        [BOB, "doc-bob"],
        [{ userId: "", workspaceId: "" }, "doc-unowned"],
      ]) {
        await q(
          `INSERT INTO ${chunkTable}
             (chunk_id, doc_id, chunk_index, content, search_text, owner_user_id, workspace_id,
              embedding_model, embedding_dimensions, embedding)
           VALUES ($1, $2, 0, $3, $3, $4, $5, 'rls-it-embedding', 8, $6::vector)`,
          [`${docId}:0`, docId, `alpha policy text for ${docId}`, scope.userId, scope.workspaceId, vector]
        );
      }
    };

    try {
      for (const chunkTable of [created, existing]) {
        await modules.postgres.withPostgresTransaction(async (client) =>
          client.query(await modules.migrations.renderIndexVersionChunkTableDdl({ chunkTable, dimensions: 8 }))
        );
        await seedChunks(chunkTable);
      }

      // A version table created from the template gets the filtering function.
      assertSparseRankShape(await describeSparseRankFunction(`${created}_sparse_rank`), created);
      assert.deepEqual(chunkIds(await asAlice(() => callSparseRank(`${created}_sparse_rank`, ALL_DOCS))), ["doc-alice:0"]);
      assert.deepEqual(
        chunkIds(await callSparseRank(`${created}_sparse_rank`, ALL_DOCS)),
        ["doc-alice:0", "doc-bob:0", "doc-unowned:0"]
      );

      // A version from before migration 033: migration 014's body, registered
      // under a status the search never serves (failed) but whose function
      // the tenant role may still call.
      await q(
        renderMigrationSqlFor(await migrationText("014_create_sparse_rank_function.sql"), {
          documentChunksTable: existing,
        })
      );
      await q(
        `INSERT INTO ${versionsTable} (version_id, status, chunk_table, sparse_rank_function, embedding_dimensions)
         VALUES (92, 'failed', $1, $2, 8)`,
        [existing, `${existing}_sparse_rank`]
      );
      assert.deepEqual(
        chunkIds(await asAlice(() => callSparseRank(`${existing}_sparse_rank`, ALL_DOCS))),
        ["doc-alice:0", "doc-bob:0", "doc-unowned:0"],
        "migration 014's body ranks every doc id it is handed"
      );

      // Migration 033 (idempotent) fixes it in place, keeping its shape.
      await modules.postgres.withPostgresTransaction(async (client) =>
        client.query(renderMigrationSqlFor(await migrationText("033_harden_sparse_rank_function.sql")))
      );
      assertSparseRankShape(await describeSparseRankFunction(`${existing}_sparse_rank`), existing);
      assert.deepEqual(chunkIds(await asAlice(() => callSparseRank(`${existing}_sparse_rank`, ALL_DOCS))), ["doc-alice:0"]);
      assert.deepEqual(chunkIds(await asAlice(() => callSparseRank(`${existing}_sparse_rank`, ["doc-bob"]))), []);
      assert.deepEqual(
        chunkIds(await callSparseRank(`${existing}_sparse_rank`, ALL_DOCS)),
        ["doc-alice:0", "doc-bob:0", "doc-unowned:0"]
      );
      // And the base table's function is still the filtering one.
      assert.deepEqual(
        chunkIds(await asAlice(() => callSparseRank(modules.pgvector.getPgvectorSparseRankFunctionName(), ALL_DOCS))),
        ["doc-alice:0"]
      );
    } finally {
      await q(`DELETE FROM ${versionsTable} WHERE version_id = 92`);

      for (const chunkTable of [created, existing]) {
        await q(
          modules.migrations.renderIndexVersionDropDdl({ chunkTable, sparseRankFunction: `${chunkTable}_sparse_rank` })
        );
      }
    }
  });

  test("session memory is keyed and stored per tenant, and the policy refuses another tenant's session rows", async () => {
    const memory = await import("../rag/memory.js");
    const sessionTable = modules.config.getSessionMemoryPostgresTable();
    const q = modules.postgres.queryPostgres;
    const sessionId = "shared-client-session";
    const aliceScope = { ...ALICE, authenticated: true };
    const bobScope = { ...BOB, authenticated: true };
    const record = (scope, text) =>
      modules.tenant.runWithDatabaseTenant(scope, () =>
        memory.recordSessionTurn({
          accessScope: scope,
          answer: `${text} answer`,
          documents: [],
          query: text,
          routeMode: "qa",
          sessionId,
        })
      );

    memory.configureSessionMemoryStore(null);
    memory.resetSessionMemory();

    // A pre-migration row (no owner) that has outlived the TTL, and a fresh
    // one under the raw id a tenant without a derived key would use.
    await q(
      `INSERT INTO ${sessionTable} (session_id, updated_at, messages)
       VALUES ('legacy-expired', NOW() - INTERVAL '7 hours', '[]'::jsonb),
              ('legacy-fresh', NOW(), '[{"role":"user","text":"legacy question"}]'::jsonb)`
    );

    try {
      await record(aliceScope, "alice question");
      await record(bobScope, "bob question");

      const aliceKey = memory.resolveSessionMemoryKey(sessionId, aliceScope);
      const bobKey = memory.resolveSessionMemoryKey(sessionId, bobScope);
      const owned = await q(
        `SELECT session_id, owner_user_id, workspace_id, messages
         FROM ${sessionTable} WHERE session_id = ANY($1::text[]) ORDER BY owner_user_id`,
        [[aliceKey, bobKey]]
      );

      assert.notEqual(aliceKey, bobKey);
      assert.deepEqual(
        owned.rows.map((row) => [row.session_id, row.owner_user_id, row.workspace_id]),
        [
          [aliceKey, "alice", "ws-a"],
          [bobKey, "bob", "ws-b"],
        ]
      );
      assert.equal(owned.rows[0].messages[0].text, "alice question");
      assert.equal(owned.rows[1].messages[0].text, "bob question");

      // The TTL purge ran as the owner from inside alice's request, so the
      // expired owner-less row is gone; the fresh legacy row stays.
      const legacy = await q(
        `SELECT session_id FROM ${sessionTable} WHERE session_id LIKE 'legacy-%' ORDER BY 1`
      );
      assert.deepEqual(legacy.rows.map((row) => row.session_id), ["legacy-fresh"]);

      await modules.tenant.runWithDatabaseTenant(BOB, async () => {
        // Direct SQL as the tenant role, naming alice's row by its key.
        const visible = await q(`SELECT session_id FROM ${sessionTable} ORDER BY 1`);
        assert.deepEqual(visible.rows.map((row) => row.session_id), [bobKey]);

        const read = await q(`SELECT messages FROM ${sessionTable} WHERE session_id = $1`, [aliceKey]);
        const updated = await q(
          `UPDATE ${sessionTable} SET messages = '[]'::jsonb WHERE session_id = ANY($1::text[])`,
          [[aliceKey, "legacy-fresh"]]
        );
        const deleted = await q(
          `DELETE FROM ${sessionTable} WHERE session_id = ANY($1::text[])`,
          [[aliceKey, "legacy-fresh"]]
        );

        assert.equal(read.rowCount, 0, "alice's session is invisible to bob");
        assert.equal(updated.rowCount, 0, "bob cannot overwrite alice's or a legacy session");
        assert.equal(deleted.rowCount, 0, "bob cannot delete alice's or a legacy session");

        await assert.rejects(
          q(
            `INSERT INTO ${sessionTable} (session_id, messages, owner_user_id, workspace_id)
             VALUES ('forged', '[]'::jsonb, 'alice', 'ws-a')`
          ),
          (error) => error.code === "42501"
        );
        await assert.rejects(
          q(
            `INSERT INTO ${sessionTable} (session_id, messages, owner_user_id, workspace_id)
             VALUES ($1, '[]'::jsonb, 'bob', 'ws-b')
             ON CONFLICT (session_id) DO UPDATE SET messages = EXCLUDED.messages`,
            [aliceKey]
          ),
          (error) => error.code === "42501"
        );

        // A raw-id upsert over the owner-less legacy row (auth off with a
        // client user id) is dropped instead of failing the answer.
        assert.equal(
          await memory.recordSessionTurn({
            accessScope: { ...BOB, authenticated: false },
            answer: "x",
            documents: [],
            query: "y",
            sessionId: "legacy-fresh",
          }),
          null
        );

        // Bob's clear derives bob's key and leaves alice's session alone.
        assert.equal(await memory.clearSessionMemory(sessionId, bobScope), true);
        assert.equal(await memory.clearSessionMemory(sessionId, bobScope), false);
      });

      const remaining = await q(
        `SELECT session_id, messages FROM ${sessionTable} ORDER BY session_id`
      );
      assert.deepEqual(remaining.rows.map((row) => row.session_id), ["legacy-fresh", aliceKey].sort());
      assert.equal(
        remaining.rows.find((row) => row.session_id === "legacy-fresh").messages[0].text,
        "legacy question"
      );

      // The owner path (auth off, no tenant) still reaches a session by its
      // raw id, as before the migration.
      assert.equal(await memory.clearSessionMemory("legacy-fresh"), true);
    } finally {
      await q(`DELETE FROM ${sessionTable}`);
      memory.resetSessionMemory();
    }
  });

  test("long-term memory: migration 045's policy keeps a workspace's rows in that workspace, and LONG_MEMORY_SCOPE=workspace reads, writes and erases by it", async () => {
    const longMemory = await import("../rag/long-memory.js");
    const { normalizeTenantSelector } = await import("../rag/tenant-records.js");
    const table = tables.longMemory;
    const q = modules.postgres.queryPostgres;
    const carolX = { authenticated: true, userId: "carol", workspaceId: "ws-x" };
    const carolY = { authenticated: true, userId: "carol", workspaceId: "ws-y" };
    const savedScope = process.env.LONG_MEMORY_SCOPE;
    const memoryIds = async (where = "TRUE", values = []) =>
      (await q(`SELECT memory_id FROM ${table} WHERE ${where} ORDER BY memory_id`, values)).rows.map(
        (row) => row.memory_id
      );

    // The policy: the user's own rows that are user-level ('') or of the
    // active workspace, for USING and WITH CHECK alike.
    const policy = (
      await q(
        `SELECT roles::text[] AS roles, cmd, qual, with_check
         FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = $1`,
        [table]
      )
    ).rows[0];

    assert.deepEqual(policy.roles, [tenantRole]);
    assert.equal(policy.cmd, "ALL");
    assert.match(policy.qual, /user_id = current_setting\('archive_rag\.user_id'::text, true\)/);
    assert.match(policy.qual, /workspace_id = ''::text/);
    assert.match(policy.qual, /workspace_id = current_setting\('archive_rag\.workspace_id'::text, true\)/);
    assert.equal(policy.with_check, policy.qual);

    // Seeded as the owner: alice's row of her workspace, and one of another
    // workspace. Her user-level row is the suite's seed (alice-1).
    await q(
      `INSERT INTO ${table} (memory_id, user_id, category, text, workspace_id)
       VALUES ('lm-alice-ws-a', 'alice', 'note', 'ws-a note', 'ws-a'),
              ('lm-alice-ws-other', 'alice', 'note', 'other workspace note', 'ws-other')`
    );

    try {
      await asAlice(async () => {
        assert.deepEqual(await memoryIds(), ["alice-1", "lm-alice-ws-a"], "no WHERE: user-level and ws-a rows only");
        assert.equal(
          (await q(`UPDATE ${table} SET text = 'x' WHERE memory_id = 'lm-alice-ws-other'`)).rowCount,
          0,
          "another workspace's row cannot be updated"
        );
        assert.equal(
          (await q(`DELETE FROM ${table} WHERE memory_id = 'lm-alice-ws-other'`)).rowCount,
          0,
          "nor deleted"
        );
        await assert.rejects(
          q(
            `INSERT INTO ${table} (memory_id, user_id, category, text, workspace_id)
             VALUES ('lm-forged', 'alice', 'note', 'forged', 'ws-other')`
          ),
          (error) => error.code === "42501"
        );
        await assert.rejects(
          q(`UPDATE ${table} SET workspace_id = 'ws-other' WHERE memory_id = 'lm-alice-ws-a'`),
          (error) => error.code === "42501",
          "a row cannot be moved into another workspace"
        );
        await q(
          `INSERT INTO ${table} (memory_id, user_id, category, text, workspace_id)
           VALUES ('lm-alice-own', 'alice', 'note', 'own', 'ws-a'), ('lm-alice-user', 'alice', 'note', 'user-level', '')`
        );
      });
      assert.equal(
        (await q(`SELECT text FROM ${table} WHERE memory_id = 'lm-alice-ws-other'`)).rows[0].text,
        "other workspace note"
      );

      // The store under LONG_MEMORY_SCOPE=workspace, each call bound to the
      // caller as bindDatabaseTenant binds a request.
      process.env.LONG_MEMORY_SCOPE = "workspace";
      longMemory.configureLongMemoryStore(null);

      const asCarol = (scope, work) => modules.tenant.runWithDatabaseTenant(scope, work);

      await asCarol(carolX, () =>
        longMemory.recordLongMemoryFromUserMessage({
          accessScope: carolX,
          query: "remember that the Xylo merger closes in May",
          userId: "carol",
        })
      );
      await asCarol(carolX, () =>
        longMemory.recordLongMemoryFromUserMessage({ accessScope: carolX, query: "以后用中文回答", userId: "carol" })
      );

      const inY = await asCarol(carolY, () =>
        longMemory.getLongMemoryContext({ accessScope: carolY, query: "When does the Xylo merger close?", userId: "carol" })
      );
      const inX = await asCarol(carolX, () =>
        longMemory.getLongMemoryContext({ accessScope: carolX, query: "When does the Xylo merger close?", userId: "carol" })
      );

      assert.deepEqual(inY.memories.map((memory) => [memory.category, memory.workspaceId]), [["preference", ""]]);
      assert.doesNotMatch(inY.answerBlock, /Xylo/);
      assert.deepEqual(
        inX.memories.map((memory) => [memory.category, memory.workspaceId]).sort(),
        [["note", "ws-x"], ["preference", ""]]
      );
      assert.equal(
        await asCarol(carolY, () => longMemory.clearLongMemories({ accessScope: carolY, userId: "carol" })),
        1,
        "a clear in ws-y removes the user-level preference only"
      );
      await asCarol(carolX, () =>
        longMemory.recordLongMemoryFromUserMessage({ accessScope: carolX, query: "以后用中文回答", userId: "carol" })
      );

      // The tenant erase and export selectors (rag/tenant-records.js) by the
      // (user, workspace_id) pair: a workspace takes every user's rows of it,
      // a user in a workspace that pair's, a user outside any workspace the
      // user-level rows.
      const recordStore = longMemory.getLongMemoryTenantRecordStore().store;
      const count = (selector) =>
        modules.tenant.runAsDatabaseSystem(() => recordStore.countTenantRecords(normalizeTenantSelector(selector)));
      const exported = async (selector) => {
        const rows = [];

        for await (const { record } of recordStore.iterateTenantRecords(normalizeTenantSelector(selector))) {
          rows.push([record.user_id, record.workspace_id, record.category]);
        }

        return rows.sort();
      };

      assert.deepEqual(await count({ workspaceId: "ws-a" }), { long_memory: { records: 2 } });
      assert.deepEqual(await count({ userId: "carol", workspaceId: "ws-x" }), { long_memory: { records: 1 } });
      assert.deepEqual(await count({ userId: "carol", workspaceId: "" }), { long_memory: { records: 1 } });
      assert.deepEqual(await count({ userId: "carol", workspaceId: "ws-y" }), { long_memory: { records: 0 } });
      assert.deepEqual(await exported({ workspaceId: "ws-x" }), [["carol", "ws-x", "note"]]);
      assert.deepEqual(await exported({ userId: "carol", workspaceId: "" }), [["carol", "", "preference"]]);
      assert.deepEqual(
        await modules.tenant.runAsDatabaseSystem(() =>
          recordStore.deleteTenantRecords(normalizeTenantSelector({ workspaceId: "ws-x" }))
        ),
        { long_memory: { deleted: 1 } }
      );
      assert.equal((await memoryIds("user_id = 'carol'")).length, 1, "the preference stays");

      // Under the default scope a selector that names a user takes every row
      // of the user, as before migration 045, and a workspace one none.
      delete process.env.LONG_MEMORY_SCOPE;
      assert.deepEqual(await count({ userId: "alice", workspaceId: "ws-b" }), { long_memory: { records: 5 } });
      assert.deepEqual(await count({ workspaceId: "ws-a" }), { long_memory: { notApplicable: true, records: 0 } });
    } finally {
      if (savedScope === undefined) {
        delete process.env.LONG_MEMORY_SCOPE;
      } else {
        process.env.LONG_MEMORY_SCOPE = savedScope;
      }

      await q(`DELETE FROM ${table} WHERE memory_id NOT IN ('alice-1', 'bob-1')`);
    }
  });

  test("the health report proves the tenant role switch and every covered policy", async () => {
    const { buildHealthReport } = await import("../health.js");
    const report = await buildHealthReport();

    assert.equal(report.checks.rowLevelSecurity.status, "ok", report.checks.rowLevelSecurity.message);
    assert.equal(report.checks.rowLevelSecurity.role, tenantRole);
    // Ten tenant tables plus the staged ingest's outputs (migration 017), the
    // four sparse statistics tables of the chunk table (migration 030),
    // session memory (migration 031), admin audit events (migration 032),
    // answer feedback (migration 034), the tenant registry's workspaces and
    // members (migration 036) and the tenant usage ledger (migration 037).
    assert.equal(report.checks.rowLevelSecurity.protectedTableCount, 21);
    assert.deepEqual(report.checks.rowLevelSecurity.roleAttributes, {
      bypassRls: false,
      superuser: false,
    });
    assert.equal(report.checks.rowLevelSecurity.sparseRankExecutable, true);
    assert.equal(report.checks.rowLevelSecurity.sparseSearchExecutable, true);

    // Migration 031's policy is the exact-pair expression of the other
    // owner_user_id/workspace_id tables (workspace artifacts), so an
    // owner-less row is visible to no tenant.
    const q = modules.postgres.queryPostgres;
    const sessionTable = modules.config.getSessionMemoryPostgresTable();
    const artifactsTable = modules.config.getWorkspaceArtifactsPostgresTable();
    const policies = await q(
      `SELECT tablename, roles::text[] AS roles, cmd, qual, with_check
       FROM pg_policies
       WHERE policyname = 'tenant_isolation' AND tablename = ANY($1::text[])`,
      [[sessionTable, artifactsTable]]
    );
    const sessionPolicy = policies.rows.find((row) => row.tablename === sessionTable);
    const artifactsPolicy = policies.rows.find((row) => row.tablename === artifactsTable);

    assert.ok(sessionPolicy, "session memory carries the tenant_isolation policy");
    assert.deepEqual(sessionPolicy.roles, [tenantRole]);
    assert.equal(sessionPolicy.cmd, "ALL");
    assert.equal(sessionPolicy.qual, artifactsPolicy.qual);
    assert.equal(sessionPolicy.with_check, artifactsPolicy.with_check);

    // Without that policy the check fails and names the table.
    await q(`DROP POLICY tenant_isolation ON ${sessionTable}`);

    try {
      const missing = (await buildHealthReport()).checks.rowLevelSecurity;

      assert.equal(missing.status, "error");
      assert.deepEqual(missing.unprotectedTables, [sessionTable]);
    } finally {
      await q(
        `CREATE POLICY tenant_isolation ON ${sessionTable}
           TO ${tenantRole}
           USING (${sessionPolicy.qual})
           WITH CHECK (${sessionPolicy.with_check})`
      );
    }

    assert.equal((await buildHealthReport()).checks.rowLevelSecurity.status, "ok");
  });

  test("the health report fails on a BYPASSRLS tenant role, a table the tenant role owns, and a granted table without the policy", async () => {
    const { buildHealthReport } = await import("../health.js");
    const q = modules.postgres.queryPostgres;
    const testDatabaseUrl = withDatabase(adminDatabaseUrl, databaseName);

    // ALTER ROLE ... BYPASSRLS needs a superuser: the admin login, as a DBA.
    await adminQuery(adminDatabaseUrl, `ALTER ROLE ${tenantRole} BYPASSRLS`);

    try {
      const bypassing = (await buildHealthReport()).checks.rowLevelSecurity;

      assert.equal(bypassing.status, "error");
      assert.deepEqual(bypassing.roleAttributes, { bypassRls: true, superuser: false });
      assert.match(bypassing.message, /BYPASSRLS/);
    } finally {
      await adminQuery(adminDatabaseUrl, `ALTER ROLE ${tenantRole} NOBYPASSRLS`);
    }

    // A table the tenant role owns ignores its policy for that role (ENABLE,
    // not FORCE, ROW LEVEL SECURITY), wherever the table came from.
    await adminQuery(
      testDatabaseUrl,
      `CREATE TABLE rls_it_tenant_owned (id int); ALTER TABLE rls_it_tenant_owned OWNER TO ${tenantRole}`
    );

    try {
      const owning = (await buildHealthReport()).checks.rowLevelSecurity;

      assert.equal(owning.status, "error");
      assert.deepEqual(owning.ownedTables, ["rls_it_tenant_owned"]);
    } finally {
      await adminQuery(testDatabaseUrl, "DROP TABLE rls_it_tenant_owned");
    }

    // A table the tenant role may read without the policy fails the check
    // even though no covered table is missing one.
    await q("CREATE TABLE rls_it_ungated (id int)");
    await q(`GRANT SELECT ON rls_it_ungated TO ${tenantRole}`);

    try {
      const ungated = (await buildHealthReport()).checks.rowLevelSecurity;

      assert.equal(ungated.status, "error");
      assert.deepEqual(ungated.ungatedTables, ["rls_it_ungated"]);
      assert.deepEqual(ungated.unprotectedTables, []);
    } finally {
      await q("DROP TABLE rls_it_ungated");
    }

    // Relations an extension owns are not tenant tables, even when the
    // extension grants them to PUBLIC as pg_stat_statements does. Creating it
    // needs a superuser; querying its views would need it preloaded, which the
    // probe never does.
    await adminQuery(testDatabaseUrl, "CREATE EXTENSION IF NOT EXISTS pg_stat_statements");

    try {
      const withExtension = (await buildHealthReport()).checks.rowLevelSecurity;

      assert.equal(withExtension.status, "ok", withExtension.message);
    } finally {
      await adminQuery(testDatabaseUrl, "DROP EXTENSION IF EXISTS pg_stat_statements");
    }

    assert.equal((await buildHealthReport()).checks.rowLevelSecurity.status, "ok");
  });

  test("admin audit events are readable per workspace, append-only for the tenant role, and purged as the owner", async () => {
    const q = modules.postgres.queryPostgres;
    const auditTable = modules.config.getAdminAuditEventsPostgresTable();
    const insertEvent = (eventId, scope, createdAt = new Date().toISOString()) =>
      q(
        `INSERT INTO ${auditTable} (event_id, event_type, result, user_id, workspace_id, created_at)
         VALUES ($1, 'authorization_decision', 'allowed', $2, $3, $4::timestamptz)`,
        [eventId, scope.userId, scope.workspaceId, createdAt]
      );
    const visibleEventIds = async () =>
      (await q(`SELECT event_id FROM ${auditTable} ORDER BY event_id`)).rows.map(
        (row) => row.event_id
      );

    // Seeded as the owner: two users of ws-a, one of ws-b, one user without a
    // workspace, and an expired event of ws-b.
    await insertEvent("audit-alice", ALICE);
    await insertEvent("audit-carol", { userId: "carol", workspaceId: "ws-a" });
    await insertEvent("audit-bob", BOB);
    await insertEvent("audit-dave", { userId: "dave", workspaceId: "" });
    await insertEvent("audit-bob-expired", BOB, "2000-01-01T00:00:00.000Z");

    // A workspace tenant reads every user of its own workspace and nothing else.
    assert.deepEqual(await asAlice(visibleEventIds), ["audit-alice", "audit-carol"]);
    // A tenant without a workspace reads only its own user's events.
    assert.deepEqual(
      await modules.tenant.runWithDatabaseTenant({ userId: "dave", workspaceId: "" }, visibleEventIds),
      ["audit-dave"]
    );

    // The tenant role may not change or remove audit events, its own included.
    for (const statement of [
      `UPDATE ${auditTable} SET result = 'denied' WHERE event_id = 'audit-alice'`,
      `DELETE FROM ${auditTable} WHERE event_id = 'audit-alice'`,
    ]) {
      await assert.rejects(asAlice(() => q(statement)), (error) => error.code === "42501");
    }

    // It may append only events that name itself.
    await assert.rejects(
      asAlice(() => insertEvent("audit-forged-bob", BOB)),
      (error) => error.code === "42501"
    );
    await asAlice(() => insertEvent("audit-alice-2", ALICE));

    // Recording an event in a tenant request still purges every tenant's
    // expired events: the purge runs as the owner.
    const { createPostgresAdminAuditStore } = await import(
      "../rag/postgres-admin-audit-store.js"
    );
    const store = createPostgresAdminAuditStore({
      retentionDays: 30,
      runMigrations: async () => {},
      tableName: auditTable,
    });

    await asAlice(() =>
      store.recordEvent({
        eventId: "audit-alice-3",
        principal: { userId: ALICE.userId, workspaceId: ALICE.workspaceId },
        result: "allowed",
        type: "authorization_decision",
      })
    );
    assert.deepEqual(await visibleEventIds(), [
      "audit-alice",
      "audit-alice-2",
      "audit-alice-3",
      "audit-bob",
      "audit-carol",
      "audit-dave",
    ]);

    // A tenant id with a whitespace run: the event compaction collapses it,
    // the tenant settings do not, and the row must still be written under the
    // bound tenant's own ids rather than fail the policy and vanish.
    const spaced = { userId: "erin", workspaceId: "ws\tspaced" };

    await modules.tenant.runWithDatabaseTenant(spaced, () =>
      store.recordEvent({
        eventId: "audit-erin",
        principal: spaced,
        result: "allowed",
        type: "authorization_decision",
      })
    );
    assert.deepEqual(
      await modules.tenant.runWithDatabaseTenant(spaced, visibleEventIds),
      ["audit-erin"]
    );

    await q(`DELETE FROM ${auditTable}`);
  });

  // Sets `overrides` (undefined deletes) with a fresh pool on both sides, so
  // the pool reads the settings it is created with.
  const withPostgresEnv = async (overrides, callback) => {
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    const apply = (entries) =>
      Object.entries(entries).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });

    apply(overrides);
    await modules.postgres.resetPostgresPool();

    try {
      return await callback();
    } finally {
      apply(previous);
      await modules.postgres.resetPostgresPool();
    }
  };
  const settingNow = async (name) =>
    (await modules.postgres.queryPostgres("SELECT current_setting($1) AS value", [name])).rows[0].value;

  test("POSTGRES_STATEMENT_TIMEOUT_MS cancels tenant statements and tenant transactions, ends with them, and never limits owner work", async () => {
    // The server's own value, read on the owner path before the limit is on.
    const serverDefault = await settingNow("statement_timeout");

    // One connection, so the owner statement afterwards provably reuses the
    // connection the tenant statements set the limit on.
    await withPostgresEnv({ POSTGRES_POOL_MAX: "1", POSTGRES_STATEMENT_TIMEOUT_MS: "200" }, async () => {
      await assert.rejects(asAlice(() => modules.postgres.queryPostgres("SELECT pg_sleep(2)")), { code: "57014" });
      await assert.rejects(
        asAlice(() => modules.postgres.withPostgresTransaction((client) => client.query("SELECT pg_sleep(2)"))),
        { code: "57014" }
      );
      assert.equal(await asAlice(() => settingNow("statement_timeout")), "200ms");
      // The cancelled statements left the tenant's view intact.
      assert.deepEqual(await asAlice(() => scopedRows(tables.tasks)), ["alice"]);

      const owner = await modules.postgres.queryPostgres(
        "SELECT current_setting('statement_timeout') AS value, (SELECT true FROM pg_sleep(0.4)) AS slept"
      );

      assert.equal(owner.rows[0].value, serverDefault, "the limit did not outlive its transaction");
      assert.equal(owner.rows[0].slept, true, "owner work ran past the tenant limit");
    });
  });

  test("POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS ends a tenant transaction held idle; the process survives and the next statement gets a new connection", async () => {
    const serverDefault = await settingNow("idle_in_transaction_session_timeout");

    await withPostgresEnv({ POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS: "200", POSTGRES_POOL_MAX: "1" }, async () => {
      assert.equal(
        await asAlice(() =>
          modules.postgres.withPostgresTransaction(async (client) =>
            (await client.query("SELECT current_setting('idle_in_transaction_session_timeout') AS value")).rows[0].value
          )
        ),
        "200ms"
      );

      const heldBackend = { pid: null };

      // The server terminates the session while the callback waits; a
      // checked-out client's 'error' must not end the process.
      await assert.rejects(
        asAlice(() =>
          modules.postgres.withPostgresTransaction(async (client) => {
            heldBackend.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await new Promise((resolve) => setTimeout(resolve, 800));

            return client.query("SELECT 1");
          })
        )
      );

      const next = await asAlice(() => modules.postgres.queryPostgres("SELECT pg_backend_pid() AS pid"));

      assert.notEqual(next.rows[0].pid, heldBackend.pid, "the ended session was not pooled again");
      assert.equal(await settingNow("idle_in_transaction_session_timeout"), serverDefault);
    });
  });

  test("POSTGRES_TENANT_CONTEXT=strict refuses an unbound statement and lets system, unscoped and tenant work through", async () => {
    const originalConsoleError = console.error;

    console.error = () => {};

    try {
      await withPostgresEnv({ POSTGRES_TENANT_CONTEXT: "strict" }, async () => {
        await assert.rejects(modules.postgres.queryPostgres(`SELECT 1 FROM ${tables.tasks}`), {
          code: "ARCHIVE_RAG_TENANT_CONTEXT_MISSING",
        });
        await assert.rejects(
          modules.postgres.withPostgresTransaction((client) => client.query("SELECT 1")),
          { code: "ARCHIVE_RAG_TENANT_CONTEXT_MISSING" }
        );
        assert.deepEqual(await modules.tenant.runAsDatabaseSystem(() => scopedRows(tables.tasks)), ["alice", "bob"]);
        // Unscoped (an auth-off request) is the owner, as before strict mode.
        assert.deepEqual(await modules.tenant.runWithDatabaseTenant({}, () => scopedRows(tables.tasks)), [
          "alice",
          "bob",
        ]);
        assert.deepEqual(await asAlice(() => scopedRows(tables.tasks)), ["alice"]);
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("answer feedback is stored per tenant, read back exactly, and append-only for the tenant role", async () => {
    const [{ buildFeedbackRecord }, { createPostgresFeedbackStore }] = await Promise.all([
      import("../feedback.js"),
      import("../rag/postgres-feedback-store.js"),
    ]);
    const q = modules.postgres.queryPostgres;
    const feedbackTable = modules.config.getFeedbackPostgresTable();
    const store = createPostgresFeedbackStore();
    const asBob = (callback) => modules.tenant.runWithDatabaseTenant(BOB, callback);
    const build = (accessScope, question) =>
      buildFeedbackRecord({
        accessScope,
        payload: {
          answerText: `${question} answer`,
          feedbackType: "incomplete",
          question,
          // Key order and the \u0000 escape must survive the json column.
          skills: [{ id: "document_rag", label: "nul\u0000label", status: "completed", version: "1" }],
          userId: "mallory",
          workspaceId: "ws-mallory",
        },
      });
    const aliceRecord = build(ALICE, "alice question");
    const bobRecord = build(BOB, "bob question");
    const ids = (records) => records.map((record) => record.feedbackId);

    try {
      assert.deepStrictEqual(await asAlice(() => store.recordFeedback(aliceRecord)), aliceRecord);
      await asBob(() => store.recordFeedback(bobRecord));
      // Auth disabled without a user: the owner path, a record no tenant sees.
      const unowned = await store.recordFeedback(build({}, "unowned question"));

      const owners = await q(
        `SELECT owner_user_id, workspace_id FROM ${feedbackTable} ORDER BY id`
      );

      assert.deepEqual(
        owners.rows.map((row) => [row.owner_user_id, row.workspace_id]),
        [
          ["alice", "ws-a"],
          ["bob", "ws-b"],
          ["", ""],
        ],
        "the payload's user and workspace are never the record's"
      );

      const aliceSees = await asAlice(() => store.listFeedback({ accessScope: ALICE }));

      assert.deepStrictEqual(aliceSees, [aliceRecord]);
      assert.deepEqual(Object.keys(aliceSees[0]), Object.keys(aliceRecord));
      assert.deepEqual(Object.keys(aliceSees[0].skills[0]), ["skillId", "skillVersion", "label", "status"]);
      assert.equal(aliceSees[0].skills[0].label, "nul\u0000label");

      // A store call that forgot its filter, or names another tenant, still
      // returns only the bound tenant's rows.
      assert.deepEqual(ids(await asAlice(() => store.listFeedback({ accessScope: {} }))), [aliceRecord.feedbackId]);
      assert.deepEqual(await asAlice(() => store.listFeedback({ accessScope: BOB })), []);
      assert.deepEqual(ids(await asAlice(() => store.listAllFeedback())), [aliceRecord.feedbackId]);
      // A scope naming no tenant (the single shared token; requireApiAuth
      // refuses every other such scope) reads like the owner path (auth
      // disabled, operator tools): every record.
      assert.equal(
        (await store.listFeedback({ accessScope: { authenticated: true }, limit: 100 })).length,
        (await store.listAllFeedback()).length
      );
      assert.deepEqual(ids(await store.listAllFeedback()), [
        aliceRecord.feedbackId,
        bobRecord.feedbackId,
        unowned.feedbackId,
      ]);

      await asBob(async () => {
        const visible = await q(`SELECT feedback_id FROM ${feedbackTable} ORDER BY id`);

        assert.deepEqual(visible.rows.map((row) => row.feedback_id), [bobRecord.feedbackId]);
        await assert.rejects(
          store.recordFeedback({ ...aliceRecord, feedbackId: "forged-for-alice" }),
          (error) => error.code === "42501" && /row-level security/.test(error.message)
        );
        await assert.rejects(
          store.recordFeedback({ ...unowned, feedbackId: "forged-unowned" }),
          (error) => error.code === "42501"
        );

        // No request changes or removes feedback, its own included.
        for (const statement of [
          `UPDATE ${feedbackTable} SET note = 'changed'`,
          `DELETE FROM ${feedbackTable}`,
        ]) {
          await assert.rejects(q(statement), (error) => error.code === "42501");
        }
      });

      // npm run feedback:import runs as the owner and keeps what is stored.
      const imported = await modules.tenant.runAsDatabaseSystem(() =>
        store.importFeedback([
          { ...aliceRecord, note: "imported copy" },
          { ...bobRecord, expectedAnswerIncludes: ["approval"], feedbackId: "imported-bob" },
        ])
      );

      assert.deepEqual(imported, { alreadyPresent: 1, inserted: 1 });
      assert.equal((await asAlice(() => store.listFeedback({ accessScope: ALICE })))[0].note, "");

      const bobSees = await asBob(() => store.listFeedback({ accessScope: BOB, limit: 10 }));

      assert.deepEqual(ids(bobSees).sort(), [bobRecord.feedbackId, "imported-bob"].sort());
      assert.deepEqual(
        bobSees.find((record) => record.feedbackId === "imported-bob").expectedAnswerIncludes,
        ["approval"]
      );
    } finally {
      await q(`DELETE FROM ${feedbackTable}`);
    }
  });

  test("the tenant registry is read-only for the tenant role: its own workspace row and its own memberships", async () => {
    const {
      createPostgresTenantRegistryStore,
      createTenantRegistryService,
      decideTenantMembership,
    } = await import("../rag/tenant-registry.js");
    const q = modules.postgres.queryPostgres;
    const workspacesTable = modules.config.getWorkspacesPostgresTable();
    const membersTable = modules.config.getWorkspaceMembersPostgresTable();
    const registry = createTenantRegistryService({
      cacheTtlMs: 0,
      store: createPostgresTenantRegistryStore(),
    });
    const asSystem = (callback) => modules.tenant.runAsDatabaseSystem(callback);
    const asTenant = (scope, callback) => modules.tenant.runWithDatabaseTenant(scope, callback);
    const visible = async () => ({
      members: (
        await q(`SELECT workspace_id, user_id FROM ${membersTable} ORDER BY 1, 2`)
      ).rows.map((row) => `${row.workspace_id}/${row.user_id}`),
      workspaces: (
        await q(`SELECT workspace_id FROM ${workspacesTable} ORDER BY 1`)
      ).rows.map((row) => row.workspace_id),
    });

    try {
      await asSystem(async () => {
        await registry.createWorkspace({ plan: "team", retentionPolicy: { agentRuns: 30 }, workspaceId: "ws-a" });
        await registry.createWorkspace({ workspaceId: "ws-b" });
        await registry.putMember({ roles: ["workspace.admin"], userId: "alice", workspaceId: "ws-a" });
        await registry.putMember({ roles: ["workspace.viewer"], userId: "alice", workspaceId: "ws-b" });
        await registry.putMember({ userId: "bob", workspaceId: "ws-b" });
      });

      // Read back exactly through the system path (jsonb, text[]).
      const stored = await asSystem(() => registry.getWorkspace("ws-a"));

      assert.deepEqual(stored.retentionPolicy, { agentRuns: 30 });
      assert.equal(stored.plan, "team");
      assert.equal(
        (await asSystem(() => registry.putMember({ roles: ["workspace.admin"], userId: "alice", workspaceId: "ws-a" })))
          .created,
        false
      );

      // Alice in ws-a: her workspace's row and her membership there only.
      assert.deepEqual(await asAlice(visible), { members: ["ws-a/alice"], workspaces: ["ws-a"] });
      // A user-only tenant: its own memberships in every workspace, no row.
      assert.deepEqual(await asTenant({ userId: "alice", workspaceId: "" }, visible), {
        members: ["ws-a/alice", "ws-b/alice"],
        workspaces: [],
      });
      // A workspace-only tenant: its row, no membership.
      assert.deepEqual(await asTenant({ userId: "", workspaceId: "ws-b" }, visible), {
        members: [],
        workspaces: ["ws-b"],
      });
      // Bob inside ws-a, where he is no member.
      assert.deepEqual(await asTenant({ userId: "bob", workspaceId: "ws-a" }, visible), {
        members: [],
        workspaces: ["ws-a"],
      });

      // The tenant role writes nothing, its own rows included.
      await asAlice(async () => {
        for (const statement of [
          `INSERT INTO ${workspacesTable} (workspace_id) VALUES ('ws-forged')`,
          `UPDATE ${workspacesTable} SET status = 'suspended'`,
          `DELETE FROM ${workspacesTable}`,
          `INSERT INTO ${membersTable} (workspace_id, user_id) VALUES ('ws-a', 'mallory')`,
          `UPDATE ${membersTable} SET roles = ARRAY['workspace.admin']`,
          `DELETE FROM ${membersTable}`,
        ]) {
          await assert.rejects(q(statement), (error) => error.code === "42501", statement);
        }

        await assert.rejects(registry.createWorkspace({ workspaceId: "ws-forged" }), (error) => error.code === "42501");
      });

      // The enforcement lookups bind the tenant they check and decide
      // through those policies.
      assert.deepEqual(await decideTenantMembership({ registry, userId: "alice", workspaceId: "ws-a" }), {
        allowed: true,
        roles: ["workspace.admin"],
      });
      assert.equal(
        (await decideTenantMembership({ registry, userId: "bob", workspaceId: "ws-a" })).code,
        "WORKSPACE_MEMBERSHIP_REQUIRED"
      );
      assert.deepEqual(
        await decideTenantMembership({ registry, workspaceBoundByPrincipal: true, workspaceId: "ws-b" }),
        { allowed: true, roles: [] }
      );

      await asSystem(() => registry.suspendWorkspace("ws-b"));
      assert.equal(
        (await decideTenantMembership({ registry, userId: "bob", workspaceId: "ws-b" })).code,
        "WORKSPACE_SUSPENDED"
      );
      await asSystem(() => registry.setWorkspaceStatus("ws-b", "deleting"));
      await assert.rejects(
        asSystem(() => registry.activateWorkspace("ws-b")),
        (error) => error.code === "WORKSPACE_DELETING"
      );

      // Removing a workspace row removes its memberships.
      await q(`DELETE FROM ${workspacesTable} WHERE workspace_id = 'ws-b'`);
      assert.deepEqual((await visible()).members, ["ws-a/alice"]);
    } finally {
      await q(`DELETE FROM ${workspacesTable}`);
    }
  });

  test("the tenant usage ledger is written as system work and read by a tenant only for its own pair", async () => {
    const [usage, quota] = await Promise.all([
      import("../rag/tenant-usage.js"),
      import("../rag/tenant-storage-quota.js"),
    ]);
    const q = modules.postgres.queryPostgres;
    const usageTable = modules.config.getTenantUsagePostgresTable();
    const asBob = (callback) => modules.tenant.runWithDatabaseTenant(BOB, callback);
    const hour = Date.UTC(2026, 9, 17, 10);
    const ledger = usage.createTenantUsageLedger({
      isDatabaseConfigured: () => true,
      isEnabled: () => true,
      now: () => hour + 5 * 60 * 1000,
      setTimer: () => null,
    });
    const top = (options = {}) =>
      usage.listTenantUsageTop({
        from: new Date(hour - 60 * 60 * 1000),
        metric: usage.TENANT_USAGE_METRICS.modelTokens,
        to: new Date(hour + 2 * 60 * 60 * 1000),
        ...options,
      });

    try {
      ledger.record(ALICE, { model_tokens: 120, model_cost_micro_usd: 7 });
      ledger.record(ALICE, { model_tokens: 30 });
      ledger.record(BOB, { model_tokens: 500 });
      ledger.record(null, { model_tokens: 9 });
      // Recorded inside a tenant request, flushed as system work all the same.
      assert.deepEqual(await asAlice(() => ledger.flush()), { rows: 4 });
      // A second flush adds to the stored totals.
      ledger.record(ALICE, { model_tokens: 50 });
      await ledger.flush();

      const stored = await q(
        `SELECT workspace_id, owner_user_id, metric, value::text AS value, period_start
         FROM ${usageTable} ORDER BY workspace_id, owner_user_id, metric`
      );

      assert.deepEqual(
        stored.rows.map((row) => [row.workspace_id, row.owner_user_id, row.metric, row.value]),
        [
          ["", "", "model_tokens", "9"],
          ["ws-a", "alice", "model_cost_micro_usd", "7"],
          ["ws-a", "alice", "model_tokens", "200"],
          ["ws-b", "bob", "model_tokens", "500"],
        ]
      );
      assert.equal(new Date(stored.rows[0].period_start).getTime(), hour);

      // The platform view, as GET /admin/usage reads it.
      const platform = await modules.tenant.runAsDatabaseSystem(() => top());

      assert.deepEqual(platform.rows, [
        { userId: "bob", value: 500, workspaceId: "ws-b" },
        { userId: "alice", value: 200, workspaceId: "ws-a" },
        { userId: "", value: 9, workspaceId: "" },
      ]);
      assert.deepEqual(
        (await modules.tenant.runAsDatabaseSystem(() => top({ workspaceId: "ws-a" }))).rows,
        [{ userId: "alice", value: 200, workspaceId: "ws-a" }]
      );

      // A tenant sees its own pair only, whatever it asks for, and writes nothing.
      assert.deepEqual((await asAlice(() => top())).rows, [{ userId: "alice", value: 200, workspaceId: "ws-a" }]);
      assert.deepEqual((await asAlice(() => top({ workspaceId: "ws-b" }))).rows, []);
      await asBob(async () => {
        await assert.rejects(
          q(
            `INSERT INTO ${usageTable} (workspace_id, owner_user_id, metric, period_start, value)
             VALUES ('ws-b', 'bob', 'model_tokens', '2026-10-17T10:00:00Z', 1)`
          ),
          (error) => error.code === "42501"
        );
        await assert.rejects(q(`UPDATE ${usageTable} SET value = 0`), (error) => error.code === "42501");
        await assert.rejects(q(`DELETE FROM ${usageTable}`), (error) => error.code === "42501");
      });
      // Periods are whole hours.
      await assert.rejects(
        q(
          `INSERT INTO ${usageTable} (workspace_id, owner_user_id, metric, period_start, value)
           VALUES ('ws-a', 'alice', 'model_tokens', '2026-10-17T10:30:00Z', 1)`
        ),
        (error) => error.code === "23514"
      );

      // Storage totals count a workspace's documents across users, as the
      // owner, but answer a tenant only for its own quota scope.
      await q(
        `INSERT INTO ${tables.documents} (doc_id, file_name, file_bytes, file_size, owner_user_id, workspace_id)
         VALUES ('doc-carol', 'doc-carol.pdf', $1, 300, 'carol', 'ws-a')`,
        [Buffer.from("%PDF-1.4")]
      );

      const workspaceA = { kind: "workspace", userId: "", workspaceId: "ws-a" };

      assert.deepEqual(await asAlice(() => quota.readTenantStorageTotals(workspaceA, { registryShared: () => true })), {
        documentBytes: 300,
        documentCount: 2,
      });
      assert.deepEqual(
        await asAlice(() =>
          modules.postgres.withPostgresTransaction((client) =>
            quota.readTenantStorageTotals(workspaceA, { client })
          )
        ),
        { documentBytes: 300, documentCount: 2 }
      );
      await assert.rejects(
        asAlice(() =>
          quota.readTenantStorageTotals(
            { kind: "workspace", userId: "", workspaceId: "ws-b" },
            { registryShared: () => true }
          )
        ),
        (error) => error.code === "42501"
      );
      await assert.rejects(
        asAlice(() =>
          quota.readTenantStorageTotals({ kind: "user", userId: "alice", workspaceId: "" }, { registryShared: () => true })
        ),
        (error) => error.code === "42501"
      );
      assert.deepEqual(
        await quota.readTenantStorageTotals(
          { kind: "workspace", userId: "", workspaceId: "ws-b" },
          { registryShared: () => true }
        ),
        { documentBytes: 0, documentCount: 1 }
      );

      // The commit-path check: the quota lock and the count in one tenant
      // transaction.
      await asAlice(() =>
        modules.postgres.withPostgresTransaction(async (client) => {
          await assert.rejects(
            quota.assertTenantStorageQuota({
              addedBytes: 10,
              addedDocuments: 1,
              client,
              limits: { maxDocumentBytes: 0, maxDocuments: 2 },
              lock: true,
              ownerUserId: "alice",
              workspaceId: "ws-a",
            }),
            (error) => error.code === quota.TENANT_STORAGE_QUOTA_EXCEEDED && error.status === 429
          );
        })
      );
    } finally {
      await q(`DELETE FROM ${usageTable}`);
      await q(`DELETE FROM ${tables.documents} WHERE doc_id = 'doc-carol'`);
    }
  });

  // rag/document-deletion-cascade.js with DOCUMENT_DELETE_REDACTION=on, over
  // the real stores and their statements: runs and artifacts under the
  // tenant's policy, feedback on the system path with its owner filter.
  test("deleting a document redacts its text in the tenant's own settled runs, artifacts and feedback, never another tenant's", async () => {
    const [
      { buildFeedbackRecord },
      { createPostgresFeedbackStore },
      { createPostgresAgentRunStore },
      { createPostgresWorkspaceArtifactStore, createWorkspaceArtifactService },
      { createDocumentDeletionCascade },
      { DELETED_SOURCE_TEXT_MARKER },
    ] = await Promise.all([
      import("../feedback.js"),
      import("../rag/postgres-feedback-store.js"),
      import("../rag/postgres-agent-run-store.js"),
      import("../rag/workspace-artifacts/index.js"),
      import("../rag/document-deletion-cascade.js"),
      import("../rag/document-deletion-redaction.js"),
    ]);
    const q = modules.postgres.queryPostgres;
    const asBob = (callback) => modules.tenant.runWithDatabaseTenant(BOB, callback);
    const excerpt = "Deleted clause: employees receive twelve paid leave days.";
    const docId = "doc-redacted-it";
    const citation = { chunkIndex: 0, docId, excerpt, fileName: "leave.pdf", pageNumber: 1 };
    const agentRunStore = createPostgresAgentRunStore();
    const artifactStore = createPostgresWorkspaceArtifactStore();
    const feedbackStore = createPostgresFeedbackStore();
    const createRun = (runId, status) =>
      agentRunStore.create({
        accessScope: modules.tenant.getActiveDatabaseTenant(),
        run: {
          goal: "leave",
          result: { answer: "Twelve days [Source 1]." },
          runId,
          status,
          steps: [{ id: "step:1", output: { citations: [citation] }, status: "completed", type: "document_rag" }],
        },
      });
    const createArtifact = (artifactId) =>
      createWorkspaceArtifactService({ createArtifactId: () => artifactId, store: artifactStore }).createArtifact({
        accessScope: modules.tenant.getActiveDatabaseTenant(),
        artifact: {
          artifactType: "report",
          citationManifest: [citation],
          content: `Report quoting: ${excerpt}`,
          docIds: [docId],
          idempotencyKey: `key-${artifactId}`,
          title: "Leave report",
        },
      });
    const recordFeedback = (scope) =>
      feedbackStore.recordFeedback(
        buildFeedbackRecord({
          accessScope: scope,
          payload: { answerText: "Twelve days.", citations: [citation], feedbackType: "helpful", question: "leave?" },
        })
      );
    const previous = process.env.DOCUMENT_DELETE_REDACTION;

    try {
      await asAlice(() => createRun("run-alice-done", "completed"));
      await asAlice(() => createRun("run-alice-active", "running"));
      await asBob(() => createRun("run-bob-done", "completed"));
      await asAlice(() => createArtifact("artifact-alice"));
      await asBob(() => createArtifact("artifact-bob"));
      await asAlice(() => recordFeedback(ALICE));
      await asBob(() => recordFeedback(BOB));

      process.env.DOCUMENT_DELETE_REDACTION = "on";

      const cascade = createDocumentDeletionCascade({ agentRunStore, feedbackStore, workspaceArtifactStore: artifactStore });
      const summary = await asAlice(() => cascade.afterDocumentsDeleted({ accessScope: ALICE, docIds: [docId] }));

      assert.deepEqual(summary.redaction.agentRuns, { conflicts: 0, redacted: 1, skippedActive: 1, unchanged: 0 });
      assert.deepEqual(summary.redaction.artifacts, { conflicts: 0, redacted: 1, unchanged: 0 });
      assert.deepEqual(summary.redaction.feedback, { redacted: 1 });

      const aliceRun = await asAlice(() => agentRunStore.get({ accessScope: ALICE, runId: "run-alice-done" }));

      assert.equal(aliceRun.steps[0].output.citations[0].excerpt, DELETED_SOURCE_TEXT_MARKER);
      assert.equal(aliceRun.steps[0].output.citations[0].docId, docId);
      assert.equal(aliceRun.revision, 1);
      assert.equal(
        (await asAlice(() => agentRunStore.get({ accessScope: ALICE, runId: "run-alice-active" }))).steps[0].output.citations[0].excerpt,
        excerpt,
        "a run still running is left for its resume"
      );
      assert.equal(
        (await asBob(() => agentRunStore.get({ accessScope: BOB, runId: "run-bob-done" }))).steps[0].output.citations[0].excerpt,
        excerpt
      );

      const aliceArtifact = await asAlice(() => artifactStore.getArtifact({ accessScope: ALICE, artifactId: "artifact-alice" }));

      assert.equal(aliceArtifact.sourceDeleted, true);
      assert.deepEqual(aliceArtifact.sourceDeletedDocIds, [docId]);
      assert.equal(aliceArtifact.content.includes(excerpt), false);
      assert.equal(aliceArtifact.citationManifest[0].excerpt, DELETED_SOURCE_TEXT_MARKER);
      assert.equal(
        (await asBob(() => artifactStore.getArtifact({ accessScope: BOB, artifactId: "artifact-bob" }))).sourceDeleted,
        undefined
      );

      assert.equal(
        (await asAlice(() => feedbackStore.listFeedback({ accessScope: ALICE })))[0].citations[0].excerpt,
        DELETED_SOURCE_TEXT_MARKER
      );
      assert.equal((await asBob(() => feedbackStore.listFeedback({ accessScope: BOB })))[0].citations[0].excerpt, excerpt);
    } finally {
      if (previous === undefined) {
        delete process.env.DOCUMENT_DELETE_REDACTION;
      } else {
        process.env.DOCUMENT_DELETE_REDACTION = previous;
      }

      await q(`DELETE FROM ${modules.config.getFeedbackPostgresTable()}`);
      await q(`DELETE FROM ${modules.config.getWorkspaceArtifactsPostgresTable()} WHERE artifact_id IN ('artifact-alice', 'artifact-bob')`);
      await q(
        `DELETE FROM ${modules.config.getAgentRunsPostgresTable()} WHERE run_id IN ('run-alice-done', 'run-alice-active', 'run-bob-done')`
      );
    }
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
