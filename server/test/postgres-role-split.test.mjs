import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { after, afterEach, before, describe } from "node:test";
import { fileURLToPath } from "node:url";

import { TENANT_SETTINGS_TEXT, executedTexts, roundTrips, startFakePostgres } from "./postgres-replica-fake-server.mjs";

// The database role split (POSTGRES_MIGRATION_DATABASE_URL) at the protocol
// level: two fake PostgreSQL servers on OS-assigned 127.0.0.1 ports, one
// behind POSTGRES_DATABASE_URL (the runtime login) and one behind
// POSTGRES_MIGRATION_DATABASE_URL (the owner), record every frontend message,
// so each test shows which login a statement went to, which role switch went
// with it and in how many round trips. Plus the SQL migration 035 and the
// migrator's grant step render, and the health entry's role-split verdicts over
// scripted catalog answers. That PostgreSQL itself enforces all of this is
// proven by postgres-role-split.integration.test.mjs on a real database.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const SYSTEM_ROLE = "archive_rag_system";
const SYSTEM_SETTINGS = "SELECT set_config('role', $1, true)";
const ENV_NAMES = [
  "LONG_MEMORY_DATABASE_URL",
  "POSTGRES_CONNECTION_TIMEOUT_MS",
  "POSTGRES_DATABASE_URL",
  "POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  "POSTGRES_MIGRATION_DATABASE_URL",
  "POSTGRES_POOL_MAX",
  "POSTGRES_READ_REPLICA_URLS",
  "POSTGRES_ROW_LEVEL_SECURITY",
  "POSTGRES_SSL_ENABLED",
  "POSTGRES_STATEMENT_TIMEOUT_MS",
  "POSTGRES_SYSTEM_ROLE",
  "POSTGRES_TENANT_CONTEXT",
  "POSTGRES_TENANT_ROLE",
];

const compact = (text) => String(text).replace(/\s+/g, " ").trim();
// Every message as one line; the tenant settings statement shortened.
const shape = (messages) =>
  messages.map((entry) => {
    if (entry.type === "Parse" || entry.type === "Query" || entry.type === "Execute") {
      return `${entry.type} ${compact(entry.text).replace(TENANT_SETTINGS_TEXT, "<tenant settings>")}`;
    }

    return entry.type === "Bind" ? `Bind ${JSON.stringify(entry.values)}` : entry.type;
  });
const withoutTerminate = (messages) => messages.filter((entry) => entry.type !== "Terminate");

let runtime;
let owner;
let modules;
let respond = () => undefined;
const savedEnv = new Map();

const setEnv = (overrides) => {
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
};

// The split on (the default here) or off, with fresh pools on both sides so the
// pools read the URLs they are created with.
const withSplit = async (enabled, callback, extra = {}) => {
  const previous = Object.fromEntries(
    ["POSTGRES_MIGRATION_DATABASE_URL", ...Object.keys(extra)].map((name) => [name, process.env[name]])
  );

  setEnv({ POSTGRES_MIGRATION_DATABASE_URL: enabled ? owner.url() : undefined, ...extra });
  await modules.postgres.resetPostgresPool();

  try {
    return await callback();
  } finally {
    setEnv(previous);
    await modules.postgres.resetPostgresPool();
  }
};

before(async () => {
  for (const name of ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }

  runtime = await startFakePostgres((text, values) => respond("runtime", text, values));
  owner = await startFakePostgres((text, values) => respond("owner", text, values));
  process.env.POSTGRES_DATABASE_URL = runtime.url();
  process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";

  const [config, migrations, postgres, tenant] = await Promise.all([
    import("../rag/config.js"),
    import("../rag/db-migrations.js"),
    import("../rag/postgres.js"),
    import("../rag/postgres-tenant.js"),
  ]);

  modules = { config, migrations, postgres, tenant };
});

afterEach(async () => {
  respond = () => undefined;
  await modules.postgres.resetPostgresPool();

  for (const server of [runtime, owner]) {
    await new Promise((resolve) => {
      const poll = () => (server.state.closed.size === server.state.connections ? resolve() : setImmediate(poll));

      poll();
    });
    server.state.messages.length = 0;
  }
});

after(async () => {
  await modules?.postgres.resetPostgresPool();
  await runtime?.close();
  await owner?.close();

  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const asSystem = (callback) => modules.tenant.runAsDatabaseSystem(callback);
const asUnscoped = (callback) => modules.tenant.runWithDatabaseTenant({}, callback);
const asAlice = (callback) => modules.tenant.runWithDatabaseTenant(ALICE, callback);
const taskRows = (_login, text) =>
  /FROM rag_tasks/.test(text) ? { command: "SELECT 1", fields: ["task_id"], rows: [["task-1"]] } : undefined;
const STATEMENT = "SELECT task_id FROM rag_tasks WHERE task_id = $1";
const SYSTEM_PIPELINE = [
  `Parse ${SYSTEM_SETTINGS}`,
  `Bind ["${SYSTEM_ROLE}"]`,
  `Execute ${SYSTEM_SETTINGS}`,
  `Parse ${STATEMENT}`,
  'Bind ["task-1"]',
  "Describe",
  `Execute ${STATEMENT}`,
  "Sync",
];

// ---- configuration ---------------------------------------------------------

describe("role split configuration", () => {
  test("the split is on only with a non-blank POSTGRES_MIGRATION_DATABASE_URL", () => {
    const { config } = modules;

    assert.equal(config.isPostgresRoleSplitEnabled(), false);

    for (const blank of ["", "   ", "\t"]) {
      process.env.POSTGRES_MIGRATION_DATABASE_URL = blank;
      assert.equal(config.isPostgresRoleSplitEnabled(), false, JSON.stringify(blank));
      assert.equal(config.getPostgresMigrationDatabaseUrl(), "");
    }

    process.env.POSTGRES_MIGRATION_DATABASE_URL = "  postgresql://owner@127.0.0.1/db ";
    assert.equal(config.isPostgresRoleSplitEnabled(), true);
    assert.equal(config.getPostgresMigrationDatabaseUrl(), "postgresql://owner@127.0.0.1/db");
    delete process.env.POSTGRES_MIGRATION_DATABASE_URL;
  });

  test("POSTGRES_SYSTEM_ROLE defaults to archive_rag_system, is validated like the tenant role and must differ from it", () => {
    const { config } = modules;

    assert.equal(config.getPostgresSystemRole(), "archive_rag_system");
    process.env.POSTGRES_SYSTEM_ROLE = "  ";
    assert.equal(config.getPostgresSystemRole(), "archive_rag_system");

    try {
      for (const bad of ["Archive", "rag-system", "x".repeat(64), "a b", "sys'; DROP ROLE x; --"]) {
        process.env.POSTGRES_SYSTEM_ROLE = bad;
        assert.throws(() => config.getPostgresSystemRole(), /POSTGRES_SYSTEM_ROLE must be a lowercase PostgreSQL identifier/);
      }

      process.env.POSTGRES_SYSTEM_ROLE = "archive_rag_tenant";
      assert.throws(() => config.getPostgresSystemRole(), /must differ from POSTGRES_TENANT_ROLE/);
      process.env.POSTGRES_SYSTEM_ROLE = "custom_system";
      assert.equal(config.getPostgresSystemRole(), "custom_system");
    } finally {
      delete process.env.POSTGRES_SYSTEM_ROLE;
    }
  });
});

// ---- statement routing -----------------------------------------------------

describe("statement routing without the split", () => {
  test("system, unscoped and unbound statements go straight to the one pool with no role switch; the owner helpers are the same calls", async () => {
    respond = taskRows;

    await withSplit(false, async () => {
      for (const run of [asSystem, asUnscoped, (callback) => callback()]) {
        await run(() => modules.postgres.queryPostgres(STATEMENT, ["task-1"]));
      }

      await asSystem(() => modules.postgres.queryPostgresAsOwner(STATEMENT, ["task-1"]));
      await asSystem(() =>
        modules.postgres.withPostgresOwnerTransaction((client) => client.query(STATEMENT, ["task-1"]))
      );
      await asSystem(() => modules.postgres.withPostgresOwnerClient((client) => client.query("SELECT 1")));
    });

    const statement = [`Parse ${STATEMENT}`, 'Bind ["task-1"]', "Describe", `Execute ${STATEMENT}`, "Sync"];

    assert.equal(withoutTerminate(owner.state.messages).length, 0, "nothing reaches the migration URL");
    assert.deepEqual(shape(withoutTerminate(runtime.state.messages)), [
      // system, unscoped, unbound, and queryPostgresAsOwner: pool.query
      ...statement,
      ...statement,
      ...statement,
      ...statement,
      // withPostgresOwnerTransaction is withPostgresTransaction
      "Query BEGIN",
      ...statement,
      "Query COMMIT",
      // withPostgresOwnerClient is withPostgresClient
      "Query SELECT 1",
    ]);
  });

  test("a tenant statement keeps its one-round-trip settings step", async () => {
    respond = taskRows;

    await withSplit(false, () => asAlice(() => modules.postgres.queryPostgres(STATEMENT, ["task-1"])));

    assert.equal(roundTrips(runtime.state.messages), 1);
    assert.equal(shape(withoutTerminate(runtime.state.messages))[0], "Parse SELECT <tenant settings>");
  });
});

describe("statement routing with the split", () => {
  test("a system statement switches into the system role in the same round trip, on the runtime login, with no BEGIN", async () => {
    respond = taskRows;

    const result = await withSplit(true, () =>
      asSystem(() => modules.postgres.queryPostgres(STATEMENT, ["task-1"]))
    );

    assert.deepEqual(result.rows, [{ task_id: "task-1" }], "the statement's rows, not set_config's");
    assert.deepEqual(shape(withoutTerminate(runtime.state.messages)), SYSTEM_PIPELINE);
    assert.equal(roundTrips(runtime.state.messages), 1);
    assert.equal(withoutTerminate(owner.state.messages).length, 0, "system work never logs in as the owner");
  });

  test("an unscoped statement (auth off, the shared token) runs as the system role too", async () => {
    respond = taskRows;

    await withSplit(true, () => asUnscoped(() => modules.postgres.queryPostgres(STATEMENT, ["task-1"])));

    assert.deepEqual(shape(withoutTerminate(runtime.state.messages)), SYSTEM_PIPELINE);
  });

  test("a tenant statement is unchanged: the tenant settings, never the system role", async () => {
    respond = taskRows;

    await withSplit(true, () => asAlice(() => modules.postgres.queryPostgres(STATEMENT, ["task-1"])));

    const lines = shape(withoutTerminate(runtime.state.messages));

    assert.equal(lines[0], "Parse SELECT <tenant settings>");
    assert.equal(lines[1], `Bind ${JSON.stringify(["archive_rag_tenant", "alice", "ws-a", null, null])}`);
    assert.ok(!lines.some((line) => line.includes(SYSTEM_ROLE)));
    assert.equal(roundTrips(runtime.state.messages), 1);
  });

  test("with row-level security off a tenant chain runs as the system role, never as the bare login", async () => {
    respond = taskRows;

    await withSplit(
      true,
      () => asAlice(() => modules.postgres.queryPostgres(STATEMENT, ["task-1"])),
      { POSTGRES_ROW_LEVEL_SECURITY: "off" }
    );

    assert.deepEqual(shape(withoutTerminate(runtime.state.messages)), SYSTEM_PIPELINE);
  });

  test("an unbound statement runs as the runtime login itself and fails closed on its privilege error", async () => {
    respond = (_login, text) =>
      /FROM rag_tasks/.test(text)
        ? { error: { code: "42501", message: "permission denied for table rag_tasks" } }
        : undefined;

    await withSplit(true, async () => {
      await assert.rejects(modules.postgres.queryPostgres(STATEMENT, ["task-1"]), { code: "42501" });
    });

    const lines = shape(withoutTerminate(runtime.state.messages));

    assert.deepEqual(lines, [`Parse ${STATEMENT}`, 'Bind ["task-1"]', "Describe", `Execute ${STATEMENT}`, "Sync"]);
    assert.equal(withoutTerminate(owner.state.messages).length, 0);
  });

  test("POSTGRES_TENANT_CONTEXT=strict refuses an unbound statement with its own error before anything is sent", async () => {
    await withSplit(
      true,
      async () => {
        await assert.rejects(modules.postgres.queryPostgres(STATEMENT, ["task-1"]), {
          code: modules.postgres.TENANT_CONTEXT_MISSING_ERROR_CODE,
        });
      },
      { POSTGRES_TENANT_CONTEXT: "strict" }
    );

    assert.equal(withoutTerminate(runtime.state.messages).length, 0);
    assert.equal(withoutTerminate(owner.state.messages).length, 0);
  });

  test("a prelude rides behind the system role step in the same round trip", async () => {
    respond = taskRows;

    await withSplit(true, () =>
      asSystem(() =>
        modules.postgres.queryPostgres(STATEMENT, ["task-1"], {
          prelude: [{ text: "SELECT 1 FROM rag_tasks WHERE task_id = $1 FOR NO KEY UPDATE", values: ["task-1"] }],
        })
      )
    );

    assert.deepEqual(executedTexts(runtime.state.messages), [
      SYSTEM_SETTINGS,
      "SELECT 1 FROM rag_tasks WHERE task_id = $1 FOR NO KEY UPDATE",
      STATEMENT,
    ]);
    assert.equal(roundTrips(runtime.state.messages), 1);
  });

  test("a system transaction sends BEGIN and the system role in one round trip; an unbound one a bare BEGIN", async () => {
    respond = taskRows;

    await withSplit(true, async () => {
      await asSystem(() =>
        modules.postgres.withPostgresTransaction((client) => client.query(STATEMENT, ["task-1"]))
      );
    });

    assert.deepEqual(shape(withoutTerminate(runtime.state.messages)), [
      "Parse BEGIN",
      "Bind []",
      "Execute BEGIN",
      `Parse ${SYSTEM_SETTINGS}`,
      `Bind ["${SYSTEM_ROLE}"]`,
      "Describe",
      `Execute ${SYSTEM_SETTINGS}`,
      "Sync",
      `Parse ${STATEMENT}`,
      'Bind ["task-1"]',
      "Describe",
      `Execute ${STATEMENT}`,
      "Sync",
      "Query COMMIT",
    ]);
    runtime.state.messages.length = 0;

    await withSplit(true, () => modules.postgres.withPostgresTransaction((client) => client.query("SELECT 1")));

    assert.deepEqual(shape(withoutTerminate(runtime.state.messages)), ["Query BEGIN", "Query SELECT 1", "Query COMMIT"]);
  });

  test("POSTGRES_SYSTEM_ROLE names the role, always as a bind value", async () => {
    respond = taskRows;

    await withSplit(
      true,
      () => asSystem(() => modules.postgres.queryPostgres(STATEMENT, ["task-1"])),
      { POSTGRES_SYSTEM_ROLE: "custom_system" }
    );

    const lines = shape(withoutTerminate(runtime.state.messages));

    assert.equal(lines[1], 'Bind ["custom_system"]');
    assert.ok(runtime.state.messages.every((entry) => !String(entry.text ?? "").includes("custom_system")));
  });

  test("withPostgresClient hands out no raw session under the split, in any context", async () => {
    await withSplit(true, async () => {
      for (const run of [asSystem, asUnscoped, (callback) => callback()]) {
        await assert.rejects(
          run(() => modules.postgres.withPostgresClient((client) => client.query("SELECT 1"))),
          { code: modules.postgres.ROLE_SPLIT_RAW_SESSION_ERROR_CODE }
        );
      }
    });

    assert.equal(withoutTerminate(runtime.state.messages).length, 0);
    assert.equal(withoutTerminate(owner.state.messages).length, 0);
  });

  test("owner work goes to the migration URL without any role switch, and only from the system context", async () => {
    respond = taskRows;

    await withSplit(true, async () => {
      await asSystem(() => modules.postgres.queryPostgresAsOwner("SELECT task_id FROM rag_tasks"));
      await asSystem(() =>
        modules.postgres.withPostgresOwnerTransaction((client) => client.query("ALTER TABLE rag_tasks ADD COLUMN x int"))
      );
      await asSystem(() => modules.postgres.withPostgresOwnerClient((client) => client.query("SELECT 1")));

      for (const run of [asUnscoped, asAlice, (callback) => callback()]) {
        await assert.rejects(run(() => modules.postgres.queryPostgresAsOwner("SELECT 1")), {
          code: modules.postgres.OWNER_WORK_CONTEXT_ERROR_CODE,
        });
        await assert.rejects(
          run(() => modules.postgres.withPostgresOwnerTransaction((client) => client.query("SELECT 1"))),
          { code: modules.postgres.OWNER_WORK_CONTEXT_ERROR_CODE }
        );
        await assert.rejects(
          run(() => modules.postgres.withPostgresOwnerClient((client) => client.query("SELECT 1"))),
          { code: modules.postgres.OWNER_WORK_CONTEXT_ERROR_CODE }
        );
      }
    });

    assert.equal(withoutTerminate(runtime.state.messages).length, 0, "owner work never touches the runtime login");
    assert.deepEqual(shape(withoutTerminate(owner.state.messages)), [
      "Query SELECT task_id FROM rag_tasks",
      "Query BEGIN",
      "Query ALTER TABLE rag_tasks ADD COLUMN x int",
      "Query COMMIT",
      "Query SELECT 1",
    ]);
  });

  test("the runtime login is read from the database (session_user), with no role switch", async () => {
    respond = (_login, text) =>
      /session_user/.test(text) ? { command: "SELECT 1", fields: ["login"], rows: [["archive_rag_app"]] } : undefined;

    const login = await withSplit(true, () => asSystem(() => modules.postgres.readPostgresRuntimeLogin()));

    assert.equal(login, "archive_rag_app");
    assert.deepEqual(shape(withoutTerminate(runtime.state.messages)), ["Query SELECT session_user::text AS login"]);
  });
});

// ---- migrations ------------------------------------------------------------

describe("migrations under the split", () => {
  test("every migration and its bookkeeping run on the migration URL; the runtime URL only reports its login, which is granted the roles", async () => {
    respond = (login, text) => {
      if (login === "runtime" && /session_user/.test(text)) {
        return { command: "SELECT 1", fields: ["login"], rows: [["app login'; --"]] };
      }

      return undefined;
    };

    const result = await withSplit(true, async () => {
      modules.migrations.resetPostgresMigrations();

      try {
        return await modules.migrations.runPostgresMigrations();
      } finally {
        modules.migrations.resetPostgresMigrations();
      }
    });

    assert.equal(result.status, "ok");
    assert.ok(result.appliedMigrations.includes("035_create_system_role.sql"));
    assert.equal(result.runtimeLogin, "app login'; --");

    assert.deepEqual(executedTexts(runtime.state.messages), ["SELECT session_user::text AS login"]);

    const ownerTexts = executedTexts(owner.state.messages);

    assert.match(ownerTexts[0], /^CREATE TABLE IF NOT EXISTS schema_migrations/);
    assert.equal(ownerTexts[1], "SELECT id FROM schema_migrations");
    assert.ok(ownerTexts.some((text) => text.includes("CREATE POLICY system_access")));
    assert.ok(!ownerTexts.some((text) => text.includes("set_config('role'")), "the owner never switches role");

    // The grant: the login's name as a bind value, then the DO block, in one
    // transaction after the last migration.
    const tail = shape(withoutTerminate(owner.state.messages)).slice(-8);

    assert.deepEqual(tail.slice(0, 5), [
      "Query BEGIN",
      "Parse SELECT set_config('archive_rag.runtime_login', $1, true)",
      `Bind ${JSON.stringify(["app login'; --"])}`,
      "Describe",
      "Execute SELECT set_config('archive_rag.runtime_login', $1, true)",
    ]);
    assert.equal(tail[5], "Sync");
    assert.match(tail[6], /^Query DO \$grant\$/);
    assert.equal(tail[7], "Query COMMIT");
    assert.ok(
      owner.state.messages.every((entry) => !String(entry.text ?? "").includes("app login")),
      "the login's name is never SQL text"
    );
  });

  test("without the split the migrator grants nothing and never reads a runtime login", async () => {
    let granted = 0;
    const migrator = modules.migrations.createPostgresMigrator({
      grantRuntimeRoles: async () => {
        granted += 1;
      },
      isPostgresConfigured: () => true,
      queryPostgres: async (sql) => ({ rows: /SELECT id/.test(sql) ? [] : [] }),
      readdir: async () => [],
    });
    const result = await migrator.run();

    assert.deepEqual(result, { appliedMigrations: [], status: "ok" });
    assert.equal(granted, 0);
  });

  test("with the split the migrator grants after the migrations, with the configured roles and its own owner client", async () => {
    const calls = [];
    const withClient = async (callback) => callback({ query: async (sql) => calls.push(sql) });
    const migrator = modules.migrations.createPostgresMigrator({
      getSystemRole: () => "sys_role",
      getTenantRole: () => "tenant_role",
      grantRuntimeRoles: async (options) => {
        calls.push(options);
        return "runtime_login";
      },
      isPostgresConfigured: () => true,
      isRoleSplitEnabled: () => true,
      queryPostgres: async () => ({ rows: [] }),
      readFile: async () => "SELECT 1;",
      readdir: async () => ["001_one.sql"],
      withPostgresClient: withClient,
    });
    const result = await migrator.run();

    assert.deepEqual(result, { appliedMigrations: ["001_one.sql"], runtimeLogin: "runtime_login", status: "ok" });
    assert.equal(calls.at(-2), "COMMIT", "the migration committed first");
    assert.deepEqual(
      { ...calls.at(-1), withClient: calls.at(-1).withClient === withClient },
      { systemRole: "sys_role", tenantRole: "tenant_role", withClient: true }
    );
  });

  test("the grant gives both roles SET and never INHERIT, keeps an existing SET grant, and explains a missing ADMIN option", () => {
    const sql = modules.migrations.renderRuntimeRoleGrantSql({ systemRole: "sys_role", tenantRole: "tenant_role" });

    assert.match(sql, /current_setting\('archive_rag\.runtime_login', true\)/);
    assert.match(sql, /FOREACH granted_role IN ARRAY ARRAY\['tenant_role', 'sys_role'\] LOOP/);
    assert.match(sql, /IF NOT pg_has_role\(runtime_login, granted_role, 'SET'\) THEN/);
    assert.match(sql, /GRANT %I TO %I WITH INHERIT FALSE, SET TRUE/);
    assert.match(sql, /server_version_num'\)::int >= 160000/);
    assert.match(sql, /WHEN insufficient_privilege THEN/);
    assert.doesNotMatch(sql, /INHERIT TRUE/);
    assert.throws(
      () => modules.migrations.renderRuntimeRoleGrantSql({ systemRole: "same_role", tenantRole: "same_role" }),
      /must differ/
    );
    assert.throws(
      () => modules.migrations.renderRuntimeRoleGrantSql({ systemRole: "bad'; --", tenantRole: "tenant_role" }),
      /POSTGRES_SYSTEM_ROLE must be a simple PostgreSQL identifier/
    );
  });
});

describe("migration 035 and the version-table templates", () => {
  const tableNames = {
    adminAuditEventsTable: "t_audit",
    agentRunEventsTable: "t_run_events",
    agentRunsTable: "t_runs",
    documentChunksTable: "t_chunks",
    documentsTable: "t_documents",
    feedbackTable: "t_feedback",
    indexVersionsTable: "t_versions",
    ingestJobsTable: "t_jobs",
    longMemoryTable: "t_memory",
    sessionMemoryTable: "t_sessions",
    taskEventsTable: "t_task_events",
    tasksTable: "t_tasks",
    workspaceArtifactsTable: "t_artifacts",
  };
  // The rendered statements, without the header's prose.
  const render = async (options = {}) =>
    modules.migrations
      .renderMigrationSql(
        await readFile(path.join(__dirname, "..", "db", "migrations", "035_create_system_role.sql"), "utf8"),
        tableNames,
        { embeddingDimensions: 8, systemRole: "sys_role", tenantRole: "tenant_role", ...options }
      )
      .replace(/--[^\n]*/g, "");

  test("it creates the NOLOGIN system role (tolerating a concurrent create) and refuses one equal to the tenant role", async () => {
    const sql = await render();

    assert.doesNotMatch(sql, /__[A-Z_]+__/, "every placeholder is rendered");
    assert.match(sql, /system_role CONSTANT text := 'sys_role';/);
    assert.match(sql, /tenant_role CONSTANT text := 'tenant_role';/);
    assert.match(sql, /IF system_role = tenant_role THEN\s+RAISE EXCEPTION/);
    assert.match(sql, /EXECUTE format\('CREATE ROLE %I NOLOGIN', system_role\);/);
    assert.match(sql, /WHEN duplicate_object OR unique_violation THEN/);
    assert.match(sql, /GRANT USAGE ON SCHEMA %I TO %I/);
    assert.doesNotMatch(sql, /LOGIN [A-Z]/, "the system role never logs in");
    assert.doesNotMatch(sql, /GRANT [^;]* TO tenant_role/, "the tenant role gains nothing");
  });

  test("it grants the owner path's privileges: full DML on tenant tables and the registry, append-and-purge on audit, append on feedback", async () => {
    const sql = compact(await render());
    const fullDml = /GRANT SELECT, INSERT, UPDATE, DELETE ON ([^;]+) TO sys_role;/.exec(sql)?.[1].split(",").map((name) => name.trim());

    assert.deepEqual(fullDml, [
      "t_documents",
      "t_tasks",
      "t_task_events",
      "t_runs",
      "t_run_events",
      "t_runs_approval_snapshots",
      "t_artifacts",
      "t_memory",
      "t_sessions",
      "t_jobs",
      "t_jobs_outputs",
      "t_versions",
      "t_versions_pointer",
      "t_versions_build_progress",
    ]);
    assert.match(sql, /GRANT SELECT, INSERT, DELETE ON t_audit TO sys_role;/);
    assert.match(sql, /GRANT SELECT, INSERT ON t_feedback TO sys_role;/);
    assert.doesNotMatch(sql, /schema_migrations/);
    assert.doesNotMatch(sql, /TRUNCATE/i);
    assert.match(sql, /pg_get_serial_sequence\('t_feedback', 'id'\)/);
    assert.match(sql, /GRANT USAGE, SELECT ON SEQUENCE %s TO %I', sequence_name, 'sys_role'/);
  });

  test("it adds the permissive system_access policy, for the system role only, to every table under row-level security", async () => {
    const sql = compact(await render());
    const listed = /FOREACH covered_table IN ARRAY ARRAY\[([^\]]+)\] LOOP/.exec(sql)?.[1]
      .split(",")
      .map((entry) => /lower\('([^']+)'\)/.exec(entry)?.[1]);

    assert.deepEqual(listed, [
      "t_documents",
      "t_tasks",
      "t_task_events",
      "t_runs",
      "t_run_events",
      "t_runs_approval_snapshots",
      "t_artifacts",
      "t_memory",
      "t_sessions",
      "t_jobs",
      "t_jobs_outputs",
      "t_audit",
      "t_feedback",
    ]);
    assert.match(sql, /'CREATE POLICY system_access ON %I\.%I TO %I USING \(true\) WITH CHECK \(true\)', current_schema\(\), covered_table, system_role/);
  });

  test("its chunk-table installer covers the table, its statistics tables and both search functions, owner only, for the base table and every version", async () => {
    const sql = compact(await render());

    assert.match(sql, /CREATE OR REPLACE FUNCTION t_chunks_install_system_access\(target_table text\)/);
    assert.match(sql, /REVOKE ALL ON FUNCTION t_chunks_install_system_access\(text\) FROM PUBLIC;/);
    assert.match(sql, /SELECT t_chunks_install_system_access\('t_chunks'\);/);
    assert.match(sql, /FROM t_versions AS v WHERE lower\(v\.chunk_table\) <> base_table/);
    assert.match(sql, /PERFORM t_chunks_install_system_access\(version_row\.chunk_table\);/);

    for (const suffix of ["_sparse_scopes", "_sparse_terms", "_sparse_scope_log", "_sparse_term_log"]) {
      assert.ok(sql.includes(`chunk_table || '${suffix}'`), suffix);
    }

    assert.match(sql, /'GRANT SELECT, INSERT, UPDATE, DELETE ON %I\.%I TO %I', schema_name, chunk_table, system_role/);
    assert.match(sql, /chunk_table \|\| '_sparse_rank', rank_signature, system_role/);
    assert.match(sql, /chunk_table \|\| '_sparse_search', search_signature, system_role/);
    assert.match(
      sql,
      /search_signature CONSTANT text := '\(tsquery, tsvector, text\[\], integer, text, double precision, double precision, double precision, bigint, integer\)'/
    );
  });

  test("a version table's DDL grants the system role and adds its policy; creation then calls the installer after the BM25 install", async () => {
    const ddl = await modules.migrations.renderIndexVersionChunkTableDdl({
      chunkTable: "rag_document_chunks_v3",
      dimensions: 8,
      systemRole: "sys_role",
      tenantRole: "tenant_role",
    });

    assert.match(ddl, /GRANT SELECT, INSERT, UPDATE, DELETE ON rag_document_chunks_v3 TO sys_role;/);
    assert.match(ddl, /CREATE POLICY system_access ON rag_document_chunks_v3\s+TO sys_role\s+USING \(true\)\s+WITH CHECK \(true\);/);
    assert.ok(
      ddl.endsWith("SELECT rag_document_chunks_install_sparse_rank('rag_document_chunks_v3');"),
      "migration 033's installer still runs last"
    );
    assert.equal(
      modules.migrations.renderSystemAccessInstallStatement({ chunkTable: "Rag_Document_Chunks_V3" }),
      "SELECT rag_document_chunks_install_system_access('rag_document_chunks_v3');"
    );
    assert.throws(
      () => modules.migrations.renderSystemAccessInstallStatement({ chunkTable: "x'); DROP TABLE y; --" }),
      /simple PostgreSQL identifier/
    );

    const lifecycle = await readFile(path.join(__dirname, "..", "rag", "vector-store-pgvector-version-lifecycle.js"), "utf8");
    const creation = lifecycle.slice(lifecycle.indexOf("export const createIndexVersion"));

    assert.ok(
      creation.indexOf("renderSystemAccessInstallStatement({ chunkTable })") >
        creation.indexOf("renderPgvectorBm25InstallStatement({ chunkTable"),
      "the installer runs after the statistics tables and search function exist"
    );
  });
});

// ---- health ----------------------------------------------------------------

describe("checks.rowLevelSecurity.roleSplit", () => {
  // The catalog answers the health probes read, typed as PostgreSQL sends them
  // (text[] 1009, bool 16), so node-pg parses them as the real server's.
  const TEXT_ARRAY = 1009;
  const BOOL = 16;
  const toArray = (values) => `{${values.map((value) => `"${value}"`).join(",")}}`;
  const tenantProbe = (role) => ({
    command: "SELECT 1",
    fields: [
      { name: "role", typeOid: 25 },
      { name: "protected_tables", typeOid: TEXT_ARRAY },
      { name: "sparse_rank_executable", typeOid: BOOL },
      { name: "sparse_search_executable", typeOid: BOOL },
      { name: "role_superuser", typeOid: BOOL },
      { name: "role_bypass_rls", typeOid: BOOL },
      { name: "owned_tables", typeOid: TEXT_ARRAY },
      { name: "ungated_tables", typeOid: TEXT_ARRAY },
    ],
    rows: [[role, "{}", "t", "t", "f", "f", "{}", "{}"]],
  });
  const splitProbe = ({ login = "archive_rag_app", missing = [], role = SYSTEM_ROLE, superuser = "f", usable = [] } = {}) => ({
    command: "SELECT 1",
    fields: [
      { name: "role", typeOid: 25 },
      { name: "login", typeOid: 25 },
      { name: "login_superuser", typeOid: BOOL },
      { name: "login_bypass_rls", typeOid: BOOL },
      { name: "role_superuser", typeOid: BOOL },
      { name: "login_owned_tables", typeOid: TEXT_ARRAY },
      { name: "login_usable_tables", typeOid: TEXT_ARRAY },
      { name: "login_executable_functions", typeOid: TEXT_ARRAY },
      { name: "role_owned_tables", typeOid: TEXT_ARRAY },
      { name: "missing_system_policies", typeOid: TEXT_ARRAY },
    ],
    rows: [[role, login, superuser, "f", "f", "{}", toArray(usable), "{}", "{}", toArray(missing)]],
  });
  // Every covered table is protected: the tenant probe answers with the
  // tables it was asked about.
  const answerProbes = (split) => (_login, text, values) => {
    if (/AS protected_tables/.test(text)) {
      const answer = tenantProbe("archive_rag_tenant");

      answer.rows[0][1] = values[0];
      return answer;
    }

    if (/AS missing_system_policies/.test(text)) {
      return split;
    }

    return undefined;
  };

  const runHealth = async (enabled, probe) => {
    const { checkRowLevelSecurityHealth } = await import("../health.js");

    respond = answerProbes(probe);

    return withSplit(enabled, async () => {
      modules.migrations.resetPostgresMigrations();

      try {
        return await modules.tenant.runAsDatabaseSystem(() => checkRowLevelSecurityHealth());
      } finally {
        modules.migrations.resetPostgresMigrations();
      }
    });
  };

  test("without the split the entry stays ok and carries a warning that the login is the owner, naming the fix", async () => {
    const entry = await runHealth(false, splitProbe());

    assert.equal(entry.status, "ok", entry.message);
    assert.deepEqual(Object.keys(entry.roleSplit).sort(), ["enabled", "message", "status"]);
    assert.equal(entry.roleSplit.enabled, false);
    assert.equal(entry.roleSplit.status, "warning");
    assert.match(entry.roleSplit.message, /owns every table/);
    assert.match(entry.roleSplit.message, /POSTGRES_MIGRATION_DATABASE_URL/);
    assert.ok(
      !executedTexts(runtime.state.messages).some((text) => text.includes("missing_system_policies")),
      "no role-split probe without the split"
    );
  });

  test("with the split a clean runtime login is ok, and the probe runs as the system role", async () => {
    const entry = await runHealth(true, splitProbe());

    assert.equal(entry.status, "ok", entry.message);
    assert.equal(entry.roleSplit.enabled, true);
    assert.equal(entry.roleSplit.status, "ok");
    assert.equal(entry.roleSplit.login, "archive_rag_app");
    assert.equal(entry.roleSplit.systemRole, SYSTEM_ROLE);

    const texts = executedTexts(runtime.state.messages);
    const probeIndex = texts.findIndex((text) => text.includes("missing_system_policies"));

    assert.ok(probeIndex > 0);
    assert.equal(texts[probeIndex - 1], SYSTEM_SETTINGS, "switched into the system role first");
  });

  test("with the split a superuser login, a login that reaches a table directly, a wrong role or a missing policy is an error", async () => {
    const superuser = await runHealth(true, splitProbe({ superuser: "t" }));

    assert.equal(superuser.status, "error");
    assert.equal(superuser.roleSplit.status, "error");
    assert.deepEqual(superuser.roleSplit.loginAttributes, { bypassRls: false, superuser: true });
    assert.match(superuser.message, /runtime login "archive_rag_app" \(POSTGRES_DATABASE_URL\) is a superuser/);

    const usable = await runHealth(true, splitProbe({ usable: ["rag_documents"] }));

    assert.equal(usable.status, "error");
    assert.deepEqual(usable.roleSplit.loginUsableTables, ["rag_documents"]);
    assert.match(usable.message, /without switching into the tenant or system role/);

    const wrongRole = await runHealth(true, splitProbe({ role: "archive_rag_app" }));

    assert.equal(wrongRole.status, "error");
    assert.match(wrongRole.message, /instead of the system role/);

    const missing = await runHealth(true, splitProbe({ missing: ["rag_feedback"] }));

    assert.equal(missing.status, "error");
    assert.deepEqual(missing.roleSplit.missingSystemPolicies, ["rag_feedback"]);
    assert.match(missing.message, /system_access policy: rag_feedback/);
  });
});
