import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresMigrator } from "../rag/db-migrations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const withEnv = async (overrides, callback) => {
  const originalValues = new Map(
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
    return await callback();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const tableNames = () => ({
  adminAuditEventsTable: "rag_admin_audit_events",
  agentRunEventsTable: "rag_agent_run_events",
  agentRunsTable: "rag_agent_runs",
  documentsTable: "rag_documents",
  longMemoryTable: "long_memory_items",
  sessionMemoryTable: "rag_session_memory",
  taskEventsTable: "rag_task_events",
  tasksTable: "rag_tasks",
});

test("PostgreSQL migrator applies new SQL files transactionally and skips applied files", async () => {
  const queryCalls = [];
  const clientCalls = [];
  const readFileCalls = [];
  const migrator = createPostgresMigrator({
    getTableNames: tableNames,
    isPostgresConfigured: () => true,
    migrationsDirectory: "/fake/migrations",
    queryPostgres: async (sql, values) => {
      queryCalls.push({
        sql: sql.trim(),
        values,
      });

      if (/SELECT id FROM schema_migrations/.test(sql)) {
        return {
          rows: [
            {
              id: "001_existing.sql",
            },
          ],
        };
      }

      return {
        rows: [],
      };
    },
    readFile: async (filePath, encoding) => {
      readFileCalls.push({
        encoding,
        filePath,
      });
      return [
        "CREATE TABLE __DOCUMENTS_TABLE__ (id text);",
        "CREATE TABLE __LONG_MEMORY_TABLE__ (id text);",
        "CREATE TABLE __SESSION_MEMORY_TABLE__ (id text);",
        "CREATE TABLE __TASKS_TABLE__ (id text);",
        "CREATE TABLE __TASK_EVENTS_TABLE__ (id text);",
        "CREATE TABLE __AGENT_RUNS_TABLE__ (id text);",
        "CREATE TABLE __AGENT_RUN_EVENTS_TABLE__ (id text);",
        "CREATE TABLE __ADMIN_AUDIT_EVENTS_TABLE__ (id text);",
      ].join("\n");
    },
    readdir: async () => [
      "notes.txt",
      "002_apply.sql",
      "001_existing.sql",
    ],
    withPostgresClient: async (callback) =>
      callback({
        query: async (sql, values) => {
          clientCalls.push({
            sql: sql.trim(),
            values,
          });
          return {
            rows: [],
          };
        },
      }),
  });

  const result = await migrator.run();

  assert.deepEqual(result, {
    status: "ok",
    appliedMigrations: ["002_apply.sql"],
  });
  assert.match(queryCalls[0].sql, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.equal(queryCalls[1].sql, "SELECT id FROM schema_migrations");
  assert.deepEqual(readFileCalls, [
    {
      encoding: "utf8",
      filePath: "/fake/migrations/002_apply.sql",
    },
  ]);
  assert.equal(clientCalls[0].sql, "BEGIN");
  assert.match(clientCalls[1].sql, /CREATE TABLE rag_documents/);
  assert.match(clientCalls[1].sql, /CREATE TABLE long_memory_items/);
  assert.match(clientCalls[1].sql, /CREATE TABLE rag_agent_run_events/);
  assert.match(clientCalls[1].sql, /CREATE TABLE rag_admin_audit_events/);
  assert.deepEqual(clientCalls[2], {
    sql: "INSERT INTO schema_migrations (id) VALUES ($1)",
    values: ["002_apply.sql"],
  });
  assert.equal(clientCalls[3].sql, "COMMIT");

  const queryCount = queryCalls.length;
  const secondResult = await migrator.run();

  assert.deepEqual(secondResult, {
    status: "ok",
    appliedMigrations: [],
  });
  assert.equal(queryCalls.length, queryCount);
});

test("admin audit migration avoids reserved authorization column name", async () => {
  const migrationSql = await readFile(
    path.join(__dirname, "../db/migrations/008_create_admin_audit_events.sql"),
    "utf8"
  );

  assert.match(migrationSql, /authorization_decision JSONB NOT NULL/);
  assert.doesNotMatch(migrationSql, /\bauthorization JSONB\b/);
});

test("PostgreSQL migrator rolls back failed migration files and can be retried", async () => {
  const clientCalls = [];
  let shouldFail = true;
  const migrator = createPostgresMigrator({
    getTableNames: tableNames,
    isPostgresConfigured: () => true,
    migrationsDirectory: "/fake/migrations",
    queryPostgres: async (sql) =>
      /SELECT id FROM schema_migrations/.test(sql)
        ? {
            rows: [],
          }
        : {
            rows: [],
          },
    readFile: async () => "SELECT * FROM __DOCUMENTS_TABLE__;",
    readdir: async () => ["001_fail_then_pass.sql"],
    withPostgresClient: async (callback) =>
      callback({
        query: async (sql, values) => {
          clientCalls.push({
            sql: sql.trim(),
            values,
          });

          if (shouldFail && /SELECT \* FROM rag_documents/.test(sql)) {
            throw new Error("migration failed");
          }

          return {
            rows: [],
          };
        },
      }),
  });

  await assert.rejects(() => migrator.run(), /migration failed/);
  assert.deepEqual(
    clientCalls.map((call) => call.sql),
    ["BEGIN", "SELECT * FROM rag_documents;", "ROLLBACK"]
  );

  shouldFail = false;
  const result = await migrator.run();

  assert.deepEqual(result.appliedMigrations, ["001_fail_then_pass.sql"]);
  assert.deepEqual(
    clientCalls.slice(3).map((call) => call.sql),
    [
      "BEGIN",
      "SELECT * FROM rag_documents;",
      "INSERT INTO schema_migrations (id) VALUES ($1)",
      "COMMIT",
    ]
  );
});

test("PostgreSQL migrator rejects missing configuration and invalid table names", async () => {
  const unconfiguredMigrator = createPostgresMigrator({
    isPostgresConfigured: () => false,
  });

  await assert.rejects(
    () => unconfiguredMigrator.run(),
    /PostgreSQL-backed storage/
  );

  const invalidTableMigrator = createPostgresMigrator({
    getTableNames: () => ({
      ...tableNames(),
      documentsTable: "bad-documents-table",
    }),
    isPostgresConfigured: () => true,
    queryPostgres: async (sql) =>
      /SELECT id FROM schema_migrations/.test(sql)
        ? {
            rows: [],
          }
        : {
            rows: [],
          },
    readFile: async () => "CREATE TABLE __DOCUMENTS_TABLE__ (id text);",
    readdir: async () => ["001_invalid.sql"],
    withPostgresClient: async () => {
      throw new Error("migration should not reach the database client");
    },
  });

  await assert.rejects(
    () => invalidTableMigrator.run(),
    /DOCUMENTS_POSTGRES_TABLE.*simple PostgreSQL identifier/
  );
});

test("PostgreSQL migrator resolves table names from runtime environment", async () => {
  await withEnv(
    {
      ADMIN_AUDIT_EVENTS_POSTGRES_TABLE: "env_admin_audit_events",
      AGENT_RUN_EVENTS_POSTGRES_TABLE: "env_agent_run_events",
      AGENT_RUNS_POSTGRES_TABLE: "env_agent_runs",
      DOCUMENTS_POSTGRES_TABLE: "env_documents",
      LONG_MEMORY_POSTGRES_TABLE: "env_long_memory",
      SESSION_MEMORY_POSTGRES_TABLE: "env_session_memory",
      TASK_EVENTS_POSTGRES_TABLE: "env_task_events",
      TASKS_POSTGRES_TABLE: "env_tasks",
    },
    async () => {
      const renderedSql = [];
      const migrator = createPostgresMigrator({
        isPostgresConfigured: () => true,
        migrationsDirectory: "/fake/migrations",
        queryPostgres: async (sql) =>
          /SELECT id FROM schema_migrations/.test(sql)
            ? {
                rows: [],
              }
            : {
                rows: [],
              },
        readFile: async () =>
          [
            "__LONG_MEMORY_TABLE__",
            "__DOCUMENTS_TABLE__",
            "__SESSION_MEMORY_TABLE__",
            "__TASKS_TABLE__",
            "__TASK_EVENTS_TABLE__",
            "__AGENT_RUNS_TABLE__",
            "__AGENT_RUN_EVENTS_TABLE__",
            "__ADMIN_AUDIT_EVENTS_TABLE__",
          ].join(" "),
        readdir: async () => ["001_runtime_tables.sql"],
        withPostgresClient: async (callback) =>
          callback({
            query: async (sql) => {
              renderedSql.push(sql.trim());
              return {
                rows: [],
              };
            },
          }),
      });

      await migrator.run();

      assert.equal(
        renderedSql[1],
        [
          "env_long_memory",
          "env_documents",
          "env_session_memory",
          "env_tasks",
          "env_task_events",
          "env_agent_runs",
          "env_agent_run_events",
          "env_admin_audit_events",
        ].join(" ")
      );
    }
  );
});
