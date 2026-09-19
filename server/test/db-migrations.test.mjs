import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPgvectorAnnDimensionsSupported,
  buildPgvectorIndexStatement,
  createPostgresMigrator,
  getPgvectorEmbeddingIndexName,
  isPgvectorAnnDimensionSupported,
  PGVECTOR_MIGRATION_ERROR_CODES,
  PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS,
  PgvectorAnnDimensionError,
  renderMigrationSql,
} from "../rag/db-migrations.js";

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
  workspaceArtifactsTable: "rag_workspace_artifacts",
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
        "CREATE TABLE __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__ (id text);",
        "CREATE TABLE __ADMIN_AUDIT_EVENTS_TABLE__ (id text);",
        "CREATE TABLE __WORKSPACE_ARTIFACTS_TABLE__ (id text);",
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
      filePath: path.join("/fake/migrations", "002_apply.sql"),
    },
  ]);
  assert.equal(clientCalls[0].sql, "BEGIN");
  assert.match(clientCalls[1].sql, /CREATE TABLE rag_documents/);
  assert.match(clientCalls[1].sql, /CREATE TABLE long_memory_items/);
  assert.match(clientCalls[1].sql, /CREATE TABLE rag_agent_run_events/);
  assert.match(
    clientCalls[1].sql,
    /CREATE TABLE rag_agent_runs_approval_snapshots/
  );
  assert.match(clientCalls[1].sql, /CREATE TABLE rag_admin_audit_events/);
  assert.match(clientCalls[1].sql, /CREATE TABLE rag_workspace_artifacts/);
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

test("workspace artifact migration enforces scoped idempotency", async () => {
  const migrationSql = await readFile(
    path.join(
      __dirname,
      "../db/migrations/009_create_workspace_artifacts.sql"
    ),
    "utf8"
  );

  assert.match(
    migrationSql,
    /UNIQUE\s*\(owner_user_id, workspace_id, idempotency_key\)/i
  );
  assert.match(
    migrationSql,
    /PRIMARY KEY\s*\(owner_user_id, workspace_id, artifact_id\)/i
  );
  assert.match(migrationSql, /status IN \('active', 'archived'\)/i);
});

test("agent run revision migration adds an internal monotonic CAS column", async () => {
  const migrationSql = await readFile(
    path.join(
      __dirname,
      "../db/migrations/010_add_agent_run_revision.sql"
    ),
    "utf8"
  );

  assert.match(
    migrationSql,
    /ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0/i
  );
});

test("agent run approval snapshot migration keeps private execution input scoped to its run", async () => {
  const migrationSql = await readFile(
    path.join(
      __dirname,
      "../db/migrations/011_create_agent_run_approval_snapshots.sql"
    ),
    "utf8"
  );

  assert.match(
    migrationSql,
    /CREATE TABLE IF NOT EXISTS __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__/i
  );
  assert.match(
    migrationSql,
    /PRIMARY KEY\s*\(user_id, workspace_id, run_id, gate_id\)/i
  );
  assert.match(
    migrationSql,
    /FOREIGN KEY\s*\(user_id, workspace_id, run_id\)[\s\S]*REFERENCES __AGENT_RUNS_TABLE__/i
  );
  assert.match(migrationSql, /approval_object_hash TEXT NOT NULL/i);
  assert.match(migrationSql, /execution_input JSONB NOT NULL/i);
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

test("PostgreSQL migrator rejects a derived approval snapshot identifier that would be truncated", async () => {
  const migrator = createPostgresMigrator({
    getTableNames: () => ({
      ...tableNames(),
      agentRunsTable: "a".repeat(50),
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
    readFile: async () =>
      "CREATE TABLE __AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__ (id text);",
    readdir: async () => ["011_approval_snapshots.sql"],
    withPostgresClient: async () => {
      throw new Error("migration should not reach the database client");
    },
  });

  await assert.rejects(
    () => migrator.run(),
    /derived agent run approval snapshots table.*63 bytes/i
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
      WORKSPACE_ARTIFACTS_POSTGRES_TABLE: "env_workspace_artifacts",
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
            "__WORKSPACE_ARTIFACTS_TABLE__",
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
          "env_workspace_artifacts",
        ].join(" ")
      );
    }
  );
});

// --- pgvector chunk table --------------------------------------------------

test("chunk migration renders the pgvector table, embedding width, text search config and cosine index", async () => {
  await withEnv(
    {
      DOCUMENT_CHUNKS_POSTGRES_TABLE: "env_chunks",
      RAG_PGVECTOR_INDEX_TYPE: undefined,
    },
    async () => {
      const renderedSql = [];
      const migrator = createPostgresMigrator({
        getEmbeddingDimensions: () => 64,
        getTextSearchConfig: () => "simple",
        isPostgresConfigured: () => true,
        migrationsDirectory: "/fake/migrations",
        queryPostgres: async () => ({ rows: [] }),
        readFile: async () =>
          "__DOCUMENT_CHUNKS_TABLE__ vector(__EMBEDDING_DIMENSIONS__) to_tsvector('__TEXT_SEARCH_CONFIG__'::regconfig, search_text) __VECTOR_INDEX_STATEMENT__",
        readdir: async () => ["012_create_rag_document_chunks.sql"],
        withPostgresClient: async (callback) =>
          callback({
            query: async (sql) => {
              renderedSql.push(sql.trim());
              return { rows: [] };
            },
          }),
      });

      await migrator.run();

      const rendered = renderedSql[1];

      assert.match(rendered, /^env_chunks vector\(64\) to_tsvector\('simple'::regconfig, search_text\)/);
      assert.match(rendered, /CREATE INDEX IF NOT EXISTS env_chunks_embedding_idx/);
      assert.match(rendered, /USING hnsw \(embedding vector_cosine_ops\)/);
      assert.match(rendered, /m = 16, ef_construction = 64/);
      assert.doesNotMatch(rendered, /__[A-Z_]+__/);
    }
  );
});

test("ivfflat is available as an explicit index choice", () => {
  assert.match(
    buildPgvectorIndexStatement({
      documentChunksTable: "rag_document_chunks",
      indexType: "ivfflat",
      ivfflatLists: 50,
    }),
    /USING ivfflat \(embedding vector_cosine_ops\)\n  WITH \(lists = 50\)/
  );
  assert.equal(
    getPgvectorEmbeddingIndexName("rag_document_chunks"),
    "rag_document_chunks_embedding_idx"
  );
});

test("pgvector ANN indexes fail closed above the 2000-dimension vector ceiling", () => {
  // pgvector's `vector` type refuses hnsw/ivfflat indexes past 2000 dims. The
  // guard must fire on the index-statement chokepoint for both access methods,
  // before any DDL is emitted, so a mis-sized embedding never aborts a migration
  // halfway or silently degrades retrieval to a sequential scan.
  assert.equal(PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS, 2000);
  assert.equal(isPgvectorAnnDimensionSupported(2000), true);
  assert.equal(isPgvectorAnnDimensionSupported(2001), false);
  assert.equal(isPgvectorAnnDimensionSupported(3072), false);

  for (const indexType of ["hnsw", "ivfflat"]) {
    assert.throws(
      () =>
        buildPgvectorIndexStatement({
          documentChunksTable: "rag_document_chunks",
          dimensions: 3072,
          indexType,
        }),
      (error) => {
        assert.ok(error instanceof PgvectorAnnDimensionError);
        assert.equal(
          error.code,
          PGVECTOR_MIGRATION_ERROR_CODES.annDimensionUnsupported
        );
        assert.equal(error.dimensions, 3072);
        assert.equal(error.indexType, indexType);
        assert.equal(error.limit, 2000);
        assert.match(error.message, /2000 dimensions/);
        assert.match(error.message, /text-embedding-3-small is 1536/);
        return true;
      }
    );
  }

  // The boundary value is admitted so a 2000-dim embedding still indexes.
  assert.doesNotThrow(() =>
    buildPgvectorIndexStatement({
      documentChunksTable: "rag_document_chunks",
      dimensions: 2000,
      indexType: "hnsw",
    })
  );
  assert.equal(
    assertPgvectorAnnDimensionsSupported({ dimensions: 1536, indexType: "hnsw" }),
    true
  );
});

test("rendering a >2000-dim migration fails closed before any DDL text is produced", () => {
  // renderMigrationSql sizes vector(__EMBEDDING_DIMENSIONS__) from the same
  // width it feeds the index guard, so an over-wide embedding is rejected while
  // the SQL is still a template — no CREATE INDEX ever reaches the database.
  assert.throws(
    () =>
      renderMigrationSql("__VECTOR_INDEX_STATEMENT__", tableNames(), {
        embeddingDimensions: 3072,
        textSearchConfig: "simple",
      }),
    (error) => {
      assert.ok(error instanceof PgvectorAnnDimensionError);
      assert.equal(error.dimensions, 3072);
      return true;
    }
  );

  // A supported width still renders the cosine index unchanged.
  assert.match(
    renderMigrationSql("__VECTOR_INDEX_STATEMENT__", tableNames(), {
      embeddingDimensions: 1536,
      textSearchConfig: "simple",
    }),
    /rag_document_chunks_embedding_idx/
  );
});

test("migration rendering rejects an unsafe text search config and a non-positive width", () => {
  assert.throws(
    () =>
      renderMigrationSql("__TEXT_SEARCH_CONFIG__", tableNames(), {
        embeddingDimensions: 64,
        textSearchConfig: "simple'; DROP TABLE rag_documents; --",
      }),
    /text search configuration/
  );
  assert.throws(
    () =>
      renderMigrationSql("__EMBEDDING_DIMENSIONS__", tableNames(), {
        embeddingDimensions: 0,
        textSearchConfig: "simple",
      }),
    /positive integer/
  );
});

test("the checked-in chunk migration is transactional-delete safe and fully rendered", async () => {
  const migrationSql = await readFile(
    path.join(__dirname, "..", "db", "migrations", "012_create_rag_document_chunks.sql"),
    "utf8"
  );

  assert.match(migrationSql, /CREATE EXTENSION IF NOT EXISTS vector;/);
  assert.match(
    migrationSql,
    /doc_id TEXT NOT NULL REFERENCES __DOCUMENTS_TABLE__ \(doc_id\) ON DELETE CASCADE/
  );
  assert.match(migrationSql, /UNIQUE \(doc_id, chunk_index\)/);
  assert.match(migrationSql, /embedding vector\(__EMBEDDING_DIMENSIONS__\) NOT NULL/);
  assert.match(migrationSql, /search_vector tsvector GENERATED ALWAYS AS/);
  assert.match(migrationSql, /USING gin \(search_vector\)/);
  assert.match(migrationSql, /\(owner_user_id, workspace_id\)/);
  assert.match(migrationSql, /__VECTOR_INDEX_STATEMENT__/);

  const rendered = renderMigrationSql(migrationSql, tableNames(), {
    embeddingDimensions: 1536,
    textSearchConfig: "simple",
  });

  assert.doesNotMatch(rendered, /__[A-Z_]+__/);
  assert.match(rendered, /rag_document_chunks \(\n\s+chunk_id TEXT PRIMARY KEY/);
  assert.match(rendered, /REFERENCES rag_documents \(doc_id\) ON DELETE CASCADE/);
  assert.match(rendered, /vector\(1536\)/);
  assert.match(rendered, /rag_document_chunks_embedding_idx/);
});
