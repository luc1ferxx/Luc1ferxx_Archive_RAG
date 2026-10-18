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
  getSparseRankInstallFunctionName,
  isPgvectorAnnDimensionSupported,
  PGVECTOR_MIGRATION_ERROR_CODES,
  PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS,
  PgvectorAnnDimensionError,
  renderMigrationSql,
  renderSparseRankInstallStatement,
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

// --- migration 033: the sparse-rank function filters by the tenant policy ----

const migrationText = (fileName) =>
  readFile(path.join(__dirname, "..", "db", "migrations", fileName), "utf8");

const customTableNames = () => ({
  adminAuditEventsTable: "a_audit",
  agentRunEventsTable: "a_run_events",
  agentRunsTable: "a_runs",
  documentChunksTable: "custom_chunks",
  documentsTable: "custom_documents",
  indexVersionsTable: "custom_versions",
  ingestJobsTable: "custom_jobs",
  longMemoryTable: "a_memory",
  sessionMemoryTable: "a_sessions",
  taskEventsTable: "a_task_events",
  tasksTable: "a_tasks",
  workspaceArtifactsTable: "a_artifacts",
});

const squash = (text) => text.replace(/\s+/g, " ").trim();

// PostgreSQL's format() for the conversions the migration uses (%n$s, %n$I,
// %n$L, %%), enough to see the function body the installer creates. Simple
// lower-case identifiers need no quoting, which is all the test passes.
const pgFormat = (template, ...args) =>
  template.replace(/%(?:(\d+)\$)?([sIL%])/g, (match, position, conversion) => {
    if (conversion === "%") return "%";

    assert.ok(position, `only positional conversions are used (${match})`);

    const value = String(args[Number(position) - 1]);

    if (conversion === "L") return `'${value.replaceAll("'", "''")}'`;
    if (conversion === "I") {
      assert.match(value, /^[a-z_][a-z0-9_]*$/, "the test only passes simple identifiers");
    }

    return value;
  });

// The single-quoted ranking statement handed to format() inside a function body.
const extractRankingStatement = (sql) => {
  const match = /'(SELECT c\.chunk_id, ts_rank_cd\(c\.search_vector, \$1, 32\)[\s\S]*?LIMIT \$3)'/.exec(sql);

  assert.ok(match, "the ranking statement is present");
  return squash(match[1]);
};

// The USING predicate of the documents policy of migration 013.
const extractDocumentsPolicyPredicate = (sql) => {
  const match =
    /CREATE POLICY tenant_isolation ON __DOCUMENTS_TABLE__\s+TO __TENANT_ROLE__\s+USING \(([\s\S]*?)\)\s+WITH CHECK/.exec(sql);

  assert.ok(match, "migration 013 has the documents policy");
  return squash(match[1]);
};

test("migration 033 recreates the sparse-rank function with migration 014's shape and the documents policy for the tenant role", async () => {
  const [template, sparseRank, rowLevelSecurity] = await Promise.all([
    migrationText("033_harden_sparse_rank_function.sql"),
    migrationText("014_create_sparse_rank_function.sql"),
    migrationText("013_enable_tenant_row_level_security.sql"),
  ]);
  const rendered = renderMigrationSql(template, customTableNames(), {
    embeddingDimensions: 8,
    tenantRole: "custom_tenant",
    textSearchConfig: "english",
  });

  assert.doesNotMatch(rendered, /__[A-Z_]+__/, "every placeholder is rendered");
  assert.match(rendered, /CREATE OR REPLACE FUNCTION custom_chunks_install_sparse_rank\(target_table text\)/);
  assert.match(rendered, /tenant_role CONSTANT text := 'custom_tenant';/);
  assert.match(rendered, /documents_table CONSTANT text := lower\('custom_documents'\);/);
  assert.match(rendered, /REVOKE ALL ON FUNCTION custom_chunks_install_sparse_rank\(text\) FROM PUBLIC;/);
  assert.match(rendered, /SELECT custom_chunks_install_sparse_rank\('custom_chunks'\);/);
  // Every registered version whose table still exists, whatever its status:
  // a failed version and a retired one whose drop failed keep both.
  assert.match(rendered, /FROM custom_versions AS v\s+WHERE lower\(v\.chunk_table\) <> base_table\s+AND to_regclass/);
  assert.doesNotMatch(rendered, /v\.status/);
  assert.match(rendered, /PERFORM custom_chunks_install_sparse_rank\(version_row\.chunk_table\);/);

  // Same signature, return type, security, settings and row estimate as 014.
  const shape = (sql) =>
    squash(
      /\(query tsquery, doc_ids text\[\], max_rows integer\)\s+(RETURNS TABLE[\s\S]*?SET enable_indexscan = off)/.exec(sql)[1]
    );

  assert.equal(shape(rendered), shape(sparseRank));
  assert.equal(
    shape(rendered),
    "RETURNS TABLE (chunk_id text, sparse_score real) LANGUAGE plpgsql STABLE SECURITY DEFINER ROWS 20 SET search_path = pg_catalog, pg_temp SET enable_indexscan = off"
  );
  assert.match(rendered, /'REVOKE ALL ON FUNCTION %I\.%I%s FROM PUBLIC', schema_name, rank_function, rank_signature\)/);
  assert.match(rendered, /'GRANT EXECUTE ON FUNCTION %I\.%I%s TO %I', schema_name, rank_function, rank_signature, tenant_role\)/);
  assert.match(rendered, /rank_signature CONSTANT text := '\(tsquery, text\[\], integer\)';/);

  // The body the installer creates, as format() renders it for one table.
  const body = /rank_body CONSTANT text := \$rank\$([\s\S]*?)\$rank\$;/.exec(rendered)?.[1];

  assert.ok(body, "the installer holds one function body");
  assert.match(
    rendered,
    /format\(rank_body, schema_name, documents_table, chunk_table, tenant_role, schema_name\)/,
    "the body's conversions are filled in this order"
  );

  const created = pgFormat(body, "public", "custom_documents", "custom_chunks", "custom_tenant", "public");

  assert.match(created, /tenant_scoped CONSTANT boolean := current_setting\('role'\) = 'custom_tenant';/);
  assert.match(created, /ranked_doc_ids text\[\] := doc_ids;/, "an owner call ranks the ids it was given");
  assert.match(created, /IF tenant_scoped THEN\s+ranked_doc_ids := ARRAY\(/);
  assert.match(created, /FROM public\.custom_documents AS d\s+WHERE d\.doc_id = ANY \(doc_ids\)/);
  assert.match(created, /FROM %I\.%I c/, "the ranked table is bound at call time");
  assert.match(created, /'public',\s+'custom_chunks'\s+\)\s+USING query, ranked_doc_ids, max_rows;/);
  assert.doesNotMatch(created.replace(/%I/g, ""), /%/, "no conversion is left for the call-time format()");

  // The filter is migration 013's documents policy, column for column.
  const filter = /AND \(d\.owner_user_id <> ''[\s\S]*?archive_rag\.workspace_id', true\)\)/.exec(created)?.[0];

  assert.ok(filter, "the tenant branch filters the doc ids");
  assert.equal(
    squash(filter.replace(/^AND /, "").replace(/\bd\./g, "")),
    extractDocumentsPolicyPredicate(rowLevelSecurity)
  );

  // The ranking itself is migration 014's statement (014 escapes its call-time
  // conversions once more, for the migration's own format()).
  assert.equal(extractRankingStatement(created), extractRankingStatement(sparseRank).replaceAll("%%", "%"));
});

test("the sparse-rank installer name and call are validated identifiers", () => {
  assert.equal(getSparseRankInstallFunctionName("rag_document_chunks"), "rag_document_chunks_install_sparse_rank");
  assert.equal(getSparseRankInstallFunctionName("Custom_Chunks"), "custom_chunks_install_sparse_rank");
  assert.throws(() => getSparseRankInstallFunctionName("bad-name"), /simple PostgreSQL identifier/);
  assert.throws(() => getSparseRankInstallFunctionName("c".repeat(44)), /63 bytes/);
  assert.equal(
    renderSparseRankInstallStatement({ chunkTable: "rag_document_chunks_v7", documentChunksTable: "rag_document_chunks" }),
    "SELECT rag_document_chunks_install_sparse_rank('rag_document_chunks_v7');"
  );
  assert.equal(
    renderSparseRankInstallStatement({ chunkTable: "Rag_Document_Chunks_V8", documentChunksTable: "rag_document_chunks" }),
    "SELECT rag_document_chunks_install_sparse_rank('rag_document_chunks_v8');"
  );
  assert.throws(
    () =>
      renderSparseRankInstallStatement({
        chunkTable: "t'); DROP TABLE x; --",
        documentChunksTable: "rag_document_chunks",
      }),
    /simple PostgreSQL identifier/
  );
});

test("the feedback migration renders the tenant table, its read/append grant and the exact-pair policy", async () => {
  const migrationSql = await readFile(
    path.join(__dirname, "..", "db", "migrations", "034_create_rag_feedback.sql"),
    "utf8"
  );
  const render = (names) =>
    renderMigrationSql(migrationSql, names, {
      embeddingDimensions: 8,
      tenantRole: "archive_tenant",
      vectorIndexStatement: "",
    });
  const rendered = render(tableNames());

  assert.doesNotMatch(rendered, /__[A-Z_]+__/, "every placeholder is rendered");
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS rag_feedback \(/);
  assert.match(rendered, /owner_user_id TEXT NOT NULL DEFAULT ''/);
  assert.match(rendered, /workspace_id TEXT NOT NULL DEFAULT ''/);
  assert.match(rendered, /feedback_id TEXT NOT NULL UNIQUE/);
  assert.match(rendered, /rag_feedback_scope_created_idx\s+ON rag_feedback \(owner_user_id, workspace_id, created_at DESC, id ASC\)/);
  assert.match(rendered, /GRANT SELECT, INSERT ON rag_feedback TO archive_tenant;/);
  assert.doesNotMatch(rendered, /GRANT[^;]*(UPDATE|DELETE)[^;]*rag_feedback/, "the tenant role never changes feedback");
  assert.match(rendered, /pg_get_serial_sequence\('rag_feedback', 'id'\)/);
  assert.match(rendered, /ALTER TABLE rag_feedback ENABLE ROW LEVEL SECURITY;/);
  assert.match(
    rendered,
    /CREATE POLICY tenant_isolation ON rag_feedback\s+TO archive_tenant\s+USING \(\s+owner_user_id = current_setting\('archive_rag\.user_id', true\)\s+AND workspace_id = current_setting\('archive_rag\.workspace_id', true\)\s+\)\s+WITH CHECK \(\s+owner_user_id = current_setting\('archive_rag\.user_id', true\)\s+AND workspace_id = current_setting\('archive_rag\.workspace_id', true\)\s+\);/
  );
  // The structured fields keep their text exactly (json, not jsonb).
  assert.doesNotMatch(rendered, /^\s+\w+ JSONB\b/im);
  assert.match(rendered, /^\s+agent_observability JSON NULL,$/m);

  // FEEDBACK_POSTGRES_TABLE renames the table and everything named after it.
  const renamed = render({ ...tableNames(), feedbackTable: "tenant_feedback" });

  assert.match(renamed, /CREATE TABLE IF NOT EXISTS tenant_feedback \(/);
  assert.match(renamed, /tenant_feedback_created_idx/);
  assert.doesNotMatch(renamed, /rag_feedback/);
  assert.throws(
    () => render({ ...tableNames(), feedbackTable: "feedback; DROP TABLE x" }),
    /FEEDBACK_POSTGRES_TABLE must be a simple PostgreSQL identifier/
  );
  // Its longest derived name must fit PostgreSQL's 63 bytes.
  assert.throws(
    () => render({ ...tableNames(), feedbackTable: `f${"x".repeat(45)}` }),
    /derived feedback table identifier must be at most 63 bytes/
  );
  assert.doesNotThrow(() => render({ ...tableNames(), feedbackTable: `f${"x".repeat(44)}` }));

  await withEnv({ FEEDBACK_POSTGRES_TABLE: "env_feedback" }, () => {
    assert.match(
      renderMigrationSql(migrationSql, undefined, {
        embeddingDimensions: 8,
        tenantRole: "archive_tenant",
        vectorIndexStatement: "",
      }),
      /CREATE TABLE IF NOT EXISTS env_feedback \(/
    );
  });
});
