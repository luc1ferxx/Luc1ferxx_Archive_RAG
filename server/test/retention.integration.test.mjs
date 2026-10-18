import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";

// Retention (rag/retention.js) on a real PostgreSQL, under the database role
// split (POSTGRES_MIGRATION_DATABASE_URL) and POSTGRES_TENANT_CONTEXT=strict:
// the runtime login owns and may touch nothing itself, so every row the sweep
// deletes was deleted as the system role, in a system context. Proven here:
//
// * with every type at 30 days, two tenants' expired rows go -- finished runs
//   with their events and approval snapshots, finished tasks with their
//   events, archived artifacts, feedback (migration 039's DELETE) -- and
//   everything else stays: running and waiting runs, unfinished tasks, active
//   artifacts, rows newer than the cutoff;
// * the tenant registry's retention_policy (migration 036's rag_workspaces)
//   keeps one workspace's runs forever and keeps another's feedback longer;
// * a session holding a table's retention advisory lock makes the sweep skip
//   that table, and a row another transaction holds is skipped (SKIP LOCKED);
// * a tenant may still not delete feedback.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases; otherwise it is
// reported as skipped, never as passed. It provisions its own database and
// roles and drops them.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!adminDatabaseUrl) {
  test("retention integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `ret_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const runtimeRole = `ret_it_app_${suffix}`;
  const runtimePassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `ret_it_tenant_${suffix}`;
  const systemRole = `ret_it_system_${suffix}`;
  const databaseName = `ret_it_${suffix}`;
  const ALICE = { userId: "alice", workspaceId: "ws-a" };
  const BOB = { userId: "bob", workspaceId: "ws-b" };
  const MANAGED_VARIABLES = [
    "AGENT_RUN_RETENTION_DAYS",
    "FEEDBACK_RETENTION_DAYS",
    "LONG_MEMORY_DATABASE_URL",
    "OPENAI_EMBEDDING_MODEL",
    "POSTGRES_DATABASE_URL",
    "POSTGRES_MIGRATION_DATABASE_URL",
    "POSTGRES_ROW_LEVEL_SECURITY",
    "POSTGRES_SYSTEM_ROLE",
    "POSTGRES_TENANT_CONTEXT",
    "POSTGRES_TENANT_ROLE",
    "RAG_EMBEDDING_DIMENSIONS",
    "RAG_OBSERVABILITY_RETENTION_DAYS",
    "TASK_RETENTION_DAYS",
    "VECTOR_STORE_PROVIDER",
    "WORKSPACE_ARTIFACT_RETENTION_DAYS",
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
  const ownerUrl = () =>
    withDatabase(adminDatabaseUrl, databaseName, { password: ownerPassword, user: ownerRole });
  // As the owner (it owns every table and bypasses row-level security).
  const ownerQuery = (sql, values) => adminQuery(ownerUrl(), sql, values);

  let modules;
  let tables;

  // Seeds one tenant's rows of every type under `prefix`; "old" rows are 100
  // days old, "new" ones a day old.
  const seed = async (scope, prefix) => {
    const old = "NOW() - INTERVAL '100 days'";
    const recent = "NOW() - INTERVAL '1 day'";
    const runs = [
      ["completed-old", "completed", old],
      ["failed-old", "failed", old],
      ["canceled-old", "canceled", old],
      ["running-old", "running", old],
      ["waiting-old", "waiting_for_user", old],
      ["completed-new", "completed", recent],
    ];

    for (const [name, status, at] of runs) {
      const runId = `${prefix}-run-${name}`;

      await ownerQuery(
        `INSERT INTO ${tables.runs} (user_id, workspace_id, run_id, status, goal, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'goal', ${at}, ${at})`,
        [scope.userId, scope.workspaceId, runId, status]
      );
      await ownerQuery(
        `INSERT INTO ${tables.runEvents} (user_id, workspace_id, run_id, event_type, created_at)
         VALUES ($1, $2, $3, 'run_created', ${at}), ($1, $2, $3, 'run_updated', ${at})`,
        [scope.userId, scope.workspaceId, runId]
      );
      await ownerQuery(
        `INSERT INTO ${tables.snapshots}
           (user_id, workspace_id, run_id, gate_id, capability_id, capability_version,
            approval_object_hash, snapshot_version, execution_input)
         VALUES ($1, $2, $3, 'gate-1', 'cap', '1', 'hash', 1, '{}'::jsonb)`,
        [scope.userId, scope.workspaceId, runId]
      );
    }

    const tasks = [
      ["completed-old", "completed", old],
      ["failed-old", "failed", old],
      ["canceled-old", "canceled", old],
      ["queued-old", "queued", old],
      ["running-old", "running", old],
      ["waiting-old", "waiting_for_user", old],
      ["pending-old", "pending", old],
      ["completed-new", "completed", recent],
    ];

    for (const [name, status, at] of tasks) {
      const taskId = `${prefix}-task-${name}`;

      await ownerQuery(
        `INSERT INTO ${tables.tasks} (user_id, workspace_id, task_id, type, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'agent', $4, ${at}, ${at})`,
        [scope.userId, scope.workspaceId, taskId, status]
      );
      await ownerQuery(
        `INSERT INTO ${tables.taskEvents} (user_id, workspace_id, task_id, event_type, created_at)
         VALUES ($1, $2, $3, 'task_upsert', ${at})`,
        [scope.userId, scope.workspaceId, taskId]
      );
    }

    const artifacts = [
      ["archived-old", "archived", old],
      ["active-old", "active", null],
      ["archived-new", "archived", recent],
    ];

    for (const [name, status, archivedAt] of artifacts) {
      const artifactId = `${prefix}-artifact-${name}`;

      await ownerQuery(
        `INSERT INTO ${tables.artifacts}
           (owner_user_id, workspace_id, artifact_id, artifact_type, version, title, status,
            idempotency_key, created_at, updated_at, archived_at)
         VALUES ($1, $2, $3, 'report', '1', $3, $4, $3, ${old}, ${archivedAt ?? old}, ${archivedAt ?? "NULL"})`,
        [scope.userId, scope.workspaceId, artifactId, status]
      );
    }

    for (const [name, at] of [["old", old], ["new", recent]]) {
      await ownerQuery(
        `INSERT INTO ${tables.feedback} (feedback_id, owner_user_id, workspace_id, created_at, feedback_type)
         VALUES ($1, $2, $3, ${at}, 'helpful')`,
        [`${prefix}-feedback-${name}`, scope.userId, scope.workspaceId]
      );
    }
  };

  const idsLike = async (table, column, prefix) =>
    (
      await ownerQuery(`SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE $1 ORDER BY 1`, [`${prefix}-%`])
    ).rows.map((row) => row.id);
  const countWhere = async (table, column, prefix) =>
    Number(
      (await ownerQuery(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} LIKE $1`, [`${prefix}-%`])).rows[0].n
    );

  // Every test starts from empty tables, so one test's kept rows (a policy
  // that kept a workspace's runs) never expire in the next one's sweep.
  const clearTables = async () => {
    for (const table of [
      tables.snapshots,
      tables.runEvents,
      tables.runs,
      tables.taskEvents,
      tables.tasks,
      tables.artifacts,
      tables.feedback,
    ]) {
      await ownerQuery(`DELETE FROM ${table}`);
    }
  };

  const buildSweeper = () => {
    const services = {
      agentRunService: modules.agentRuns.createAgentRunService({
        agentRunStore: modules.runStore.createPostgresAgentRunStore(),
      }),
      feedbackService: modules.feedback.createFeedbackService({
        store: modules.feedbackStore.createPostgresFeedbackStore(),
      }),
      taskService: modules.tasks.createTaskService({ taskStore: modules.taskStore.createPostgresTaskStore() }),
      workspaceArtifactService: modules.artifacts.createWorkspaceArtifactService({
        store: modules.artifacts.createPostgresWorkspaceArtifactStore(),
      }),
    };
    const lines = [];

    return modules.retention.createRetentionSweeper({
      batchSize: 2,
      logger: { error: (line) => lines.push(line), log: (line) => lines.push(line), warn: (line) => lines.push(line) },
      targets: {
        database: modules.retention.resolveRetentionTargets({
          hostsAgentTier: true,
          hostsApiTier: true,
          observabilityDays: 0,
          services,
        }).database,
        observability: null,
      },
    });
  };

  before(async () => {
    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    // pgvector is not a trusted extension; a superuser installs it, as a DBA would.
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    Object.assign(process.env, {
      AGENT_RUN_RETENTION_DAYS: "30",
      FEEDBACK_RETENTION_DAYS: "30",
      LONG_MEMORY_DATABASE_URL: "",
      OPENAI_EMBEDDING_MODEL: "retention-it-embedding",
      POSTGRES_DATABASE_URL: withDatabase(adminDatabaseUrl, databaseName, {
        password: runtimePassword,
        user: runtimeRole,
      }),
      POSTGRES_MIGRATION_DATABASE_URL: ownerUrl(),
      POSTGRES_ROW_LEVEL_SECURITY: "enforce",
      POSTGRES_SYSTEM_ROLE: systemRole,
      POSTGRES_TENANT_CONTEXT: "strict",
      POSTGRES_TENANT_ROLE: tenantRole,
      RAG_EMBEDDING_DIMENSIONS: "8",
      RAG_OBSERVABILITY_RETENTION_DAYS: "0",
      TASK_RETENTION_DAYS: "30",
      VECTOR_STORE_PROVIDER: "pgvector",
      WORKSPACE_ARTIFACT_RETENTION_DAYS: "30",
    });

    const [
      config,
      postgres,
      tenant,
      migrations,
      retention,
      agentRuns,
      runStore,
      tasks,
      taskStore,
      artifacts,
      feedback,
      feedbackStore,
      tenantRegistry,
    ] =
      await Promise.all([
        import("../rag/config.js"),
        import("../rag/postgres.js"),
        import("../rag/postgres-tenant.js"),
        import("../rag/db-migrations.js"),
        import("../rag/retention.js"),
        import("../rag/agent-runs.js"),
        import("../rag/postgres-agent-run-store.js"),
        import("../rag/tasks.js"),
        import("../rag/postgres-task-store.js"),
        import("../rag/workspace-artifacts/index.js"),
        import("../feedback.js"),
        import("../rag/postgres-feedback-store.js"),
        import("../rag/tenant-registry.js"),
      ]);

    modules = {
      agentRuns,
      artifacts,
      config,
      feedback,
      feedbackStore,
      migrations,
      postgres,
      retention,
      runStore,
      taskStore,
      tasks,
      tenant,
      tenantRegistry,
    };
    config.configureEmbeddingDimensions(8);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();

    const applied = await migrations.runPostgresMigrations();

    assert.ok(applied.appliedMigrations.includes("039_grant_feedback_retention_delete.sql"));
    tables = {
      artifacts: config.getWorkspaceArtifactsPostgresTable(),
      feedback: config.getFeedbackPostgresTable(),
      runEvents: config.getAgentRunEventsPostgresTable(),
      runs: config.getAgentRunsPostgresTable(),
      snapshots: `${config.getAgentRunsPostgresTable()}_approval_snapshots`,
      taskEvents: config.getTaskEventsPostgresTable(),
      tasks: config.getTasksPostgresTable(),
      workspaces: config.getWorkspacesPostgresTable(),
    };
  });

  after(async () => {
    try {
      modules?.config.configureEmbeddingDimensions(null);
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

      await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);

      for (const role of [runtimeRole, tenantRole, systemRole, ownerRole]) {
        await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${role}`);
      }
    }
  });

  test("the sweep deletes both tenants' expired, finished rows as the system role and keeps every other row", async () => {
    await clearTables();
    await seed(ALICE, "a1");
    await seed(BOB, "b1");

    const report = await buildSweeper().sweep();

    for (const type of ["agent_runs", "tasks", "workspace_artifacts", "feedback"]) {
      assert.equal(report[type]?.error, undefined, `${type}: ${report[type]?.error}`);
      assert.equal(report[type]?.locked, false, type);
    }

    assert.equal(report.agent_runs.deleted, 6);
    assert.equal(report.agent_runs.deletedEvents, 12);
    assert.equal(report.tasks.deleted, 6);
    assert.equal(report.tasks.deletedEvents, 6);
    assert.equal(report.workspace_artifacts.deleted, 2);
    assert.equal(report.feedback.deleted, 2);

    for (const prefix of ["a1", "b1"]) {
      assert.deepEqual(await idsLike(tables.runs, "run_id", prefix), [
        `${prefix}-run-completed-new`,
        `${prefix}-run-running-old`,
        `${prefix}-run-waiting-old`,
      ]);
      assert.equal(await countWhere(tables.runEvents, "run_id", prefix), 6, "the kept runs keep their events");
      assert.deepEqual(await idsLike(tables.snapshots, "run_id", prefix), [
        `${prefix}-run-completed-new`,
        `${prefix}-run-running-old`,
        `${prefix}-run-waiting-old`,
      ], "the deleted runs' approval snapshots went by the cascade");
      assert.deepEqual(await idsLike(tables.tasks, "task_id", prefix), [
        `${prefix}-task-completed-new`,
        `${prefix}-task-pending-old`,
        `${prefix}-task-queued-old`,
        `${prefix}-task-running-old`,
        `${prefix}-task-waiting-old`,
      ]);
      assert.equal(await countWhere(tables.taskEvents, "task_id", prefix), 5);
      assert.deepEqual(await idsLike(tables.artifacts, "artifact_id", prefix), [
        `${prefix}-artifact-active-old`,
        `${prefix}-artifact-archived-new`,
      ]);
      assert.deepEqual(await idsLike(tables.feedback, "feedback_id", prefix), [`${prefix}-feedback-new`]);
    }

    // Nothing left to do on the next sweep.
    const again = await buildSweeper().sweep();

    assert.equal(again.agent_runs.deleted, 0);
    assert.equal(again.feedback.deleted, 0);
  });

  test("the tenant registry's retention_policy keeps one workspace's runs and another's feedback longer", async () => {
    await clearTables();
    // The registry's own table (migration 036, which grants the system role
    // its reads), written through the registry so the policies pass its
    // validation (rag/workspace-retention-policy.js).
    const registry = modules.tenantRegistry.createTenantRegistryService({
      cacheTtlMs: 0,
      store: modules.tenantRegistry.createPostgresTenantRegistryStore(),
    });

    await modules.tenant.runAsDatabaseSystem(async () => {
      await registry.createWorkspace({ retentionPolicy: { agentRuns: 0, feedback: 365 }, workspaceId: "ws-b" });
      await registry.createWorkspace({ retentionPolicy: { tasks: 200 }, workspaceId: "ws-a" });
    });

    try {
      await seed(ALICE, "a2");
      await seed(BOB, "b2");
      await buildSweeper().sweep();

      assert.deepEqual(await idsLike(tables.runs, "run_id", "a2"), [
        "a2-run-completed-new",
        "a2-run-running-old",
        "a2-run-waiting-old",
      ]);
      assert.equal((await idsLike(tables.runs, "run_id", "b2")).length, 6, "ws-b keeps its runs forever");
      assert.equal((await idsLike(tables.tasks, "task_id", "a2")).length, 8, "ws-a keeps its tasks 200 days");
      assert.equal((await idsLike(tables.tasks, "task_id", "b2")).length, 5);
      assert.deepEqual(await idsLike(tables.feedback, "feedback_id", "b2"), ["b2-feedback-new", "b2-feedback-old"]);
      assert.deepEqual(await idsLike(tables.feedback, "feedback_id", "a2"), ["a2-feedback-new"]);
    } finally {
      await ownerQuery(`DELETE FROM ${tables.workspaces} WHERE workspace_id IN ('ws-a', 'ws-b')`);
    }
  });

  test("policies the system role cannot read stop the sweep: nothing is deleted, and the next readable sweep applies them", async () => {
    await clearTables();

    const registry = modules.tenantRegistry.createTenantRegistryService({
      cacheTtlMs: 0,
      store: modules.tenantRegistry.createPostgresTenantRegistryStore(),
    });

    await modules.tenant.runAsDatabaseSystem(() =>
      registry.createWorkspace({ retentionPolicy: { agentRuns: 0 }, workspaceId: "ws-b" })
    );

    try {
      await seed(ALICE, "a5");
      await seed(BOB, "b5");
      // The registry table is there, but the system role may no longer read
      // it: a failure to read the policies, not "no policies".
      await ownerQuery(`REVOKE SELECT ON ${tables.workspaces} FROM ${systemRole}`);

      const skipped = await buildSweeper().sweep();

      for (const type of ["agent_runs", "tasks", "workspace_artifacts", "feedback"]) {
        assert.equal(skipped[type]?.skipped, "workspace_policies_unavailable", type);
      }

      assert.equal((await idsLike(tables.runs, "run_id", "a5")).length, 6, "nothing is deleted at the global cutoff");
      assert.equal((await idsLike(tables.runs, "run_id", "b5")).length, 6);

      await ownerQuery(`GRANT SELECT ON ${tables.workspaces} TO ${systemRole}`);

      const swept = await buildSweeper().sweep();

      assert.equal(swept.agent_runs.error, undefined, swept.agent_runs.error);
      assert.equal((await idsLike(tables.runs, "run_id", "a5")).length, 3, "ws-a takes the global 30 days");
      assert.equal((await idsLike(tables.runs, "run_id", "b5")).length, 6, "ws-b keeps its runs forever");
    } finally {
      await ownerQuery(`GRANT SELECT ON ${tables.workspaces} TO ${systemRole}`);
      await ownerQuery(`DELETE FROM ${tables.workspaces} WHERE workspace_id = 'ws-b'`);
    }
  });

  test("a held retention lock skips that table, and a row another transaction holds is skipped", async () => {
    await clearTables();
    await seed(ALICE, "a3");

    const holder = new pg.Client({ connectionString: ownerUrl() });

    await holder.connect();

    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        `archive_rag:retention:${tables.runs}`,
      ]);
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${tables.tasks} WHERE task_id = 'a3-task-completed-old' FOR UPDATE`);

      const report = await buildSweeper().sweep();

      assert.equal(report.agent_runs.locked, true);
      assert.equal(report.agent_runs.deleted, 0);
      assert.equal((await idsLike(tables.runs, "run_id", "a3")).length, 6);
      assert.equal(report.tasks.deleted, 2, "the failed and canceled tasks; the locked one waits");
      assert.ok((await idsLike(tables.tasks, "task_id", "a3")).includes("a3-task-completed-old"));

      await holder.query("COMMIT");
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        `archive_rag:retention:${tables.runs}`,
      ]);

      const next = await buildSweeper().sweep();

      assert.equal(next.agent_runs.deleted, 3);
      assert.equal(next.tasks.deleted, 1);
    } finally {
      await holder.end();
    }
  });

  test("a tenant still may not delete feedback", async () => {
    const store = modules.feedbackStore.createPostgresFeedbackStore();

    await assert.rejects(
      modules.tenant.runWithDatabaseTenant(ALICE, () =>
        store.deleteExpired({ cutoff: new Date().toISOString() })
      ),
      (error) => {
        assert.equal(error?.code, "42501", `expected a permission error, got ${error?.code}: ${error?.message}`);
        return true;
      }
    );
  });
}
