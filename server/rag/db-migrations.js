import { readdir as readDirectory, readFile as readTextFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  getAdminAuditEventsPostgresTable,
  getDocumentChunksPostgresTable,
  getDocumentsPostgresTable,
  getAgentRunEventsPostgresTable,
  getAgentRunsPostgresTable,
  getEmbeddingDimensions,
  getIndexVersionPointerTtlMs,
  getIndexVersionsPostgresTable,
  getIngestJobsPostgresTable,
  getLongMemoryPostgresTable,
  getPgvectorHnswEfConstruction,
  getPgvectorHnswM,
  getPgvectorIndexType,
  getPgvectorIvfflatLists,
  getPgvectorTextSearchConfig,
  getPostgresTenantRole,
  getSessionMemoryPostgresTable,
  getTaskEventsPostgresTable,
  getTasksPostgresTable,
  getWorkspaceArtifactsPostgresTable,
} from "./config.js";
import {
  isPostgresConfigured,
  queryPostgres,
  withPostgresClient,
} from "./postgres.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultMigrationsDirectory = path.join(__dirname, "..", "db", "migrations");
const MIGRATIONS_TABLE = "schema_migrations";
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ensureSimpleTableName = (tableName, envName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `${envName} must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  if (Buffer.byteLength(tableName, "utf8") > 63) {
    throw new Error(
      `${envName} must be at most 63 bytes so PostgreSQL does not truncate it.`
    );
  }

  return tableName;
};

const getTableNames = () => ({
  longMemoryTable: ensureSimpleTableName(
    getLongMemoryPostgresTable(),
    "LONG_MEMORY_POSTGRES_TABLE"
  ),
  documentsTable: ensureSimpleTableName(
    getDocumentsPostgresTable(),
    "DOCUMENTS_POSTGRES_TABLE"
  ),
  sessionMemoryTable: ensureSimpleTableName(
    getSessionMemoryPostgresTable(),
    "SESSION_MEMORY_POSTGRES_TABLE"
  ),
  tasksTable: ensureSimpleTableName(
    getTasksPostgresTable(),
    "TASKS_POSTGRES_TABLE"
  ),
  taskEventsTable: ensureSimpleTableName(
    getTaskEventsPostgresTable(),
    "TASK_EVENTS_POSTGRES_TABLE"
  ),
  agentRunsTable: ensureSimpleTableName(
    getAgentRunsPostgresTable(),
    "AGENT_RUNS_POSTGRES_TABLE"
  ),
  agentRunEventsTable: ensureSimpleTableName(
    getAgentRunEventsPostgresTable(),
    "AGENT_RUN_EVENTS_POSTGRES_TABLE"
  ),
  adminAuditEventsTable: ensureSimpleTableName(
    getAdminAuditEventsPostgresTable(),
    "ADMIN_AUDIT_EVENTS_POSTGRES_TABLE"
  ),
  workspaceArtifactsTable: ensureSimpleTableName(
    getWorkspaceArtifactsPostgresTable(),
    "WORKSPACE_ARTIFACTS_POSTGRES_TABLE"
  ),
  documentChunksTable: ensureSimpleTableName(
    getDocumentChunksPostgresTable(),
    "DOCUMENT_CHUNKS_POSTGRES_TABLE"
  ),
  ingestJobsTable: ensureSimpleTableName(
    getIngestJobsPostgresTable(),
    "INGEST_JOBS_POSTGRES_TABLE"
  ),
  indexVersionsTable: ensureSimpleTableName(
    getIndexVersionsPostgresTable(),
    "INDEX_VERSIONS_POSTGRES_TABLE"
  ),
});

const validateTableNames = (tableNames = {}) => ({
  longMemoryTable: ensureSimpleTableName(
    tableNames.longMemoryTable,
    "LONG_MEMORY_POSTGRES_TABLE"
  ),
  documentsTable: ensureSimpleTableName(
    tableNames.documentsTable,
    "DOCUMENTS_POSTGRES_TABLE"
  ),
  sessionMemoryTable: ensureSimpleTableName(
    tableNames.sessionMemoryTable,
    "SESSION_MEMORY_POSTGRES_TABLE"
  ),
  tasksTable: ensureSimpleTableName(
    tableNames.tasksTable,
    "TASKS_POSTGRES_TABLE"
  ),
  taskEventsTable: ensureSimpleTableName(
    tableNames.taskEventsTable,
    "TASK_EVENTS_POSTGRES_TABLE"
  ),
  agentRunsTable: ensureSimpleTableName(
    tableNames.agentRunsTable,
    "AGENT_RUNS_POSTGRES_TABLE"
  ),
  agentRunEventsTable: ensureSimpleTableName(
    tableNames.agentRunEventsTable,
    "AGENT_RUN_EVENTS_POSTGRES_TABLE"
  ),
  adminAuditEventsTable: ensureSimpleTableName(
    tableNames.adminAuditEventsTable,
    "ADMIN_AUDIT_EVENTS_POSTGRES_TABLE"
  ),
  workspaceArtifactsTable: ensureSimpleTableName(
    tableNames.workspaceArtifactsTable,
    "WORKSPACE_ARTIFACTS_POSTGRES_TABLE"
  ),
  // These two are optional for injected table maps so older callers keep
  // working; the runtime map always carries them.
  documentChunksTable: ensureSimpleTableName(
    tableNames.documentChunksTable ?? getDocumentChunksPostgresTable(),
    "DOCUMENT_CHUNKS_POSTGRES_TABLE"
  ),
  ingestJobsTable: ensureSimpleTableName(
    tableNames.ingestJobsTable ?? getIngestJobsPostgresTable(),
    "INGEST_JOBS_POSTGRES_TABLE"
  ),
  indexVersionsTable: ensureSimpleTableName(
    tableNames.indexVersionsTable ?? getIndexVersionsPostgresTable(),
    "INDEX_VERSIONS_POSTGRES_TABLE"
  ),
});

const TEXT_SEARCH_CONFIG_PATTERN = /^[a-z_][a-z0-9_]*$/;

const ensureTextSearchConfig = (value) => {
  const config = String(value ?? "").trim();

  if (!TEXT_SEARCH_CONFIG_PATTERN.test(config)) {
    throw new Error(
      `RAG_PGVECTOR_TEXT_SEARCH_CONFIG must be a simple PostgreSQL text search configuration name. Received "${config}".`
    );
  }

  return config;
};

const ensureEmbeddingDimensions = (value) => {
  const dimensions = Number(value);

  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `Embedding dimensions must be a positive integer to size the pgvector column. Received "${value}".`
    );
  }

  return dimensions;
};

// pgvector caps ANN indexes on the built-in `vector` type at 2000 dimensions:
// hnswbuild.c and ivfbuild.c both raise "column cannot have more than 2000
// dimensions for <hnsw|ivfflat> index" (ERRCODE_PROGRAM_LIMIT_EXCEEDED) when the
// column is wider. The `halfvec` type lifts that to 4000, but this store indexes
// a `vector` column, so 2000 is the ceiling. Above it we fail closed with a
// diagnostic *before* any DDL runs, rather than letting CREATE INDEX abort a
// migration halfway with pgvector's raw error.
export const PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS = 2000;

export const PGVECTOR_MIGRATION_ERROR_CODES = Object.freeze({
  annDimensionUnsupported: "PGVECTOR_ANN_DIMENSION_UNSUPPORTED",
});

export class PgvectorAnnDimensionError extends Error {
  constructor({ dimensions, indexType, limit = PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS }) {
    super(
      `pgvector ${indexType} indexes support at most ${limit} dimensions on a vector column, ` +
        `but the configured embedding is ${dimensions}-dimensional. Retrieval would run without an ` +
        "ANN index (sequential scan) or the migration would abort. Set OPENAI_EMBEDDING_MODEL / " +
        `RAG_EMBEDDING_DIMENSIONS to an embedding at or below ${limit} dimensions ` +
        "(text-embedding-3-small is 1536), or lower the model's output dimensions. The pgvector " +
        "index is not created rather than silently skipped."
    );
    this.name = "PgvectorAnnDimensionError";
    this.code = PGVECTOR_MIGRATION_ERROR_CODES.annDimensionUnsupported;
    this.status = 500;
    this.dimensions = dimensions;
    this.indexType = indexType;
    this.limit = limit;
  }
}

// Non-throwing predicate for health/status surfaces that must describe the
// unsupported case without aborting.
export const isPgvectorAnnDimensionSupported = (dimensions) => {
  const parsed = Number(dimensions);

  return (
    Number.isInteger(parsed) &&
    parsed > 0 &&
    parsed <= PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS
  );
};

export const assertPgvectorAnnDimensionsSupported = ({
  dimensions = getEmbeddingDimensions(),
  indexType = getPgvectorIndexType(),
} = {}) => {
  const parsed = Number(dimensions);

  if (Number.isInteger(parsed) && parsed > PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS) {
    throw new PgvectorAnnDimensionError({ dimensions: parsed, indexType });
  }

  return true;
};

export const getPgvectorEmbeddingIndexName = (documentChunksTable) =>
  ensureSimpleTableName(
    `${ensureSimpleTableName(documentChunksTable, "DOCUMENT_CHUNKS_POSTGRES_TABLE")}_embedding_idx`,
    "derived pgvector embedding index"
  );

/**
 * Cosine index over the embedding column. HNSW by default; IVFFlat is an
 * explicit choice for archives large enough that build time matters more than
 * recall at small sizes. Both use vector_cosine_ops because search orders by
 * the `<=>` cosine distance operator and nothing else.
 */
export const buildPgvectorIndexStatement = ({
  documentChunksTable,
  dimensions = getEmbeddingDimensions(),
  hnswEfConstruction = getPgvectorHnswEfConstruction(),
  hnswM = getPgvectorHnswM(),
  indexType = getPgvectorIndexType(),
  ivfflatLists = getPgvectorIvfflatLists(),
} = {}) => {
  const tableName = ensureSimpleTableName(
    documentChunksTable,
    "DOCUMENT_CHUNKS_POSTGRES_TABLE"
  );
  const indexName = getPgvectorEmbeddingIndexName(tableName);

  // Fail closed before emitting CREATE INDEX: a >2000-dim vector column cannot
  // carry an hnsw/ivfflat index. This is the one chokepoint every index build
  // (startup migration and the empty-table resize) passes through.
  assertPgvectorAnnDimensionsSupported({ dimensions, indexType });

  if (indexType === "ivfflat") {
    return `CREATE INDEX IF NOT EXISTS ${indexName}\n  ON ${tableName} USING ivfflat (embedding vector_cosine_ops)\n  WITH (lists = ${Math.max(1, Math.floor(ivfflatLists))});`;
  }

  return `CREATE INDEX IF NOT EXISTS ${indexName}\n  ON ${tableName} USING hnsw (embedding vector_cosine_ops)\n  WITH (m = ${Math.max(2, Math.floor(hnswM))}, ef_construction = ${Math.max(4, Math.floor(hnswEfConstruction))});`;
};

// ---------------------------------------------------------------------------
// Index versions (migration 016, rag/vector-store-pgvector-versions.js)
// ---------------------------------------------------------------------------

/**
 * The registry, pointer and build-progress table names of migration 016. Every
 * identifier the migration derives from them must fit PostgreSQL's 63 bytes,
 * so the longest ones are checked here rather than left to truncate.
 */
export const getIndexVersionRegistryTableNames = (
  versionsTable = getIndexVersionsPostgresTable()
) => {
  const base = ensureSimpleTableName(versionsTable, "INDEX_VERSIONS_POSTGRES_TABLE");
  const pointerTable = `${base}_pointer`;
  const buildProgressTable = `${base}_build_progress`;

  for (const derived of [
    `${pointerTable}_singleton`,
    `${pointerTable}_ttl_positive`,
    `${buildProgressTable}_outcome_check`,
    `${base}_space_source_check`,
    `${base}_chunk_table_unique`,
    `${base}_dimensions_positive`,
  ]) {
    ensureSimpleTableName(derived, "derived index version registry identifier");
  }

  return { buildProgressTable, pointerTable, versionsTable: base };
};

// ---------------------------------------------------------------------------
// Staged ingestion (migrations 017 and 018, rag/ingest-job-store.js)
// ---------------------------------------------------------------------------

/**
 * The stage-output table of migration 017, `<jobs table>_outputs`. It and the
 * constraint the migration names after it must fit PostgreSQL's 63 bytes, and
 * so must the constraints migration 017 adds to the jobs table.
 */
export const getIngestJobOutputsTableName = (ingestJobsTable = getIngestJobsPostgresTable()) => {
  const base = ensureSimpleTableName(ingestJobsTable, "INGEST_JOBS_POSTGRES_TABLE");
  const outputsTable = `${base}_outputs`;

  for (const derived of [
    `${outputsTable}_output_check`,
    `${base}_stage_attempts_check`,
    `${base}_dead_letter_idx`,
  ]) {
    ensureSimpleTableName(derived, "derived ingest job identifier");
  }

  return outputsTable;
};

// The suffixes migrations 012 and 014 append to a chunk table's name (indexes,
// constraints, the sparse-rank function). A version table's name has to leave
// room for all of them.
const CHUNK_TABLE_DERIVED_SUFFIXES = Object.freeze([
  "_dimensions_positive",
  "_embedding_model_idx",
  "_search_vector_idx",
  "_doc_chunk_unique",
  "_embedding_idx",
  "_sparse_rank",
  "_doc_id_idx",
  "_scope_idx",
]);

export const assertIndexVersionChunkTableName = (chunkTable) => {
  const tableName = ensureSimpleTableName(chunkTable, "index version chunk table");

  for (const suffix of CHUNK_TABLE_DERIVED_SUFFIXES) {
    ensureSimpleTableName(`${tableName}${suffix}`, "derived index version identifier");
  }

  return tableName;
};

// Mirrors the chunk-table policy of migration 013: a row with neither owner
// nor workspace is never visible to a tenant, and each non-empty owner column
// must equal the tenant's setting.
const buildChunkTableTenantPolicySql = ({ chunkTable, tenantRole }) => `
GRANT SELECT, INSERT, UPDATE, DELETE ON ${chunkTable} TO ${tenantRole};

ALTER TABLE ${chunkTable} ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${chunkTable};
CREATE POLICY tenant_isolation ON ${chunkTable}
  TO ${tenantRole}
  USING (
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  )
  WITH CHECK (
    (owner_user_id <> '' OR workspace_id <> '')
    AND (owner_user_id = '' OR owner_user_id = current_setting('archive_rag.user_id', true))
    AND (workspace_id = '' OR workspace_id = current_setting('archive_rag.workspace_id', true))
  );
`;

/**
 * The owner-only DDL that creates one index version's physical table: the
 * chunk table of migration 012 rendered at the version's width with its own
 * ANN and GIN indexes and foreign key to the documents table, the tenant grant
 * and row policy of migration 013, and the sparse-rank function of migration
 * 014 rendered for this table -- the same templates, so a version table cannot
 * drift from the schema the migrations maintain. CREATE TABLE is not IF NOT
 * EXISTS: a version id is never reused, so an existing table is an error.
 */
export const renderIndexVersionChunkTableDdl = async ({
  chunkTable,
  dimensions,
  indexParams = {},
  migrationsDirectory = defaultMigrationsDirectory,
  readFile = readTextFile,
  tableNames = getTableNames(),
  tenantRole = getPostgresTenantRole(),
} = {}) => {
  const safeChunkTable = assertIndexVersionChunkTableName(chunkTable);
  const safeTenantRole = ensureSimpleTableName(tenantRole, "POSTGRES_TENANT_ROLE");
  const safeDimensions = ensureEmbeddingDimensions(dimensions);
  const names = { ...tableNames, documentChunksTable: safeChunkTable };
  const options = {
    embeddingDimensions: safeDimensions,
    tenantRole: safeTenantRole,
    textSearchConfig: indexParams.textSearchConfig ?? getPgvectorTextSearchConfig(),
    vectorIndexStatement: buildPgvectorIndexStatement({
      dimensions: safeDimensions,
      documentChunksTable: safeChunkTable,
      hnswEfConstruction: indexParams.hnswEfConstruction ?? getPgvectorHnswEfConstruction(),
      hnswM: indexParams.hnswM ?? getPgvectorHnswM(),
      indexType: indexParams.indexType ?? getPgvectorIndexType(),
      ivfflatLists: indexParams.ivfflatLists ?? getPgvectorIvfflatLists(),
    }),
  };
  const [chunkTemplate, sparseRankTemplate] = await Promise.all([
    readFile(path.join(migrationsDirectory, "012_create_rag_document_chunks.sql"), "utf8"),
    readFile(path.join(migrationsDirectory, "014_create_sparse_rank_function.sql"), "utf8"),
  ]);
  const tableSql = renderMigrationSql(chunkTemplate, names, options)
    // The extension belongs to migration 012; a version never installs it.
    .replace(/^CREATE EXTENSION IF NOT EXISTS vector;\s*$/m, "")
    .replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE");

  return [
    tableSql,
    buildChunkTableTenantPolicySql({ chunkTable: safeChunkTable, tenantRole: safeTenantRole }),
    renderMigrationSql(sparseRankTemplate, names, options),
  ].join("\n");
};

/** Retiring a version drops its function and table (owner only). */
export const renderIndexVersionDropDdl = ({ chunkTable, sparseRankFunction }) => {
  const safeChunkTable = assertIndexVersionChunkTableName(chunkTable);
  const safeFunction = ensureSimpleTableName(sparseRankFunction, "index version sparse-rank function");

  return [
    `DROP FUNCTION IF EXISTS ${safeFunction}(tsquery, text[], integer);`,
    `DROP TABLE IF EXISTS ${safeChunkTable};`,
  ].join("\n");
};

export const renderMigrationSql = (
  sqlText,
  tableNames = getTableNames(),
  {
    embeddingDimensions = getEmbeddingDimensions(),
    indexVersionPointerTtlMs = getIndexVersionPointerTtlMs(),
    tenantRole = getPostgresTenantRole(),
    textSearchConfig = getPgvectorTextSearchConfig(),
    vectorIndexStatement = null,
  } = {}
) => {
  const safeTableNames = validateTableNames(tableNames);
  const agentRunApprovalSnapshotsTable = ensureSimpleTableName(
    `${safeTableNames.agentRunsTable}_approval_snapshots`,
    "derived agent run approval snapshots table"
  );
  const safeDimensions = ensureEmbeddingDimensions(embeddingDimensions);
  const safeTextSearchConfig = ensureTextSearchConfig(textSearchConfig);
  const safeTenantRole = ensureSimpleTableName(tenantRole, "POSTGRES_TENANT_ROLE");
  const safePointerTtlMs = Math.floor(Number(indexVersionPointerTtlMs));

  if (!Number.isInteger(safePointerTtlMs) || safePointerTtlMs <= 0) {
    throw new Error(`The index version pointer TTL must be a positive integer. Received "${indexVersionPointerTtlMs}".`);
  }

  const indexVersionTables = getIndexVersionRegistryTableNames(
    safeTableNames.indexVersionsTable
  );
  const indexStatement =
    vectorIndexStatement ??
    buildPgvectorIndexStatement({
      documentChunksTable: safeTableNames.documentChunksTable,
      dimensions: safeDimensions,
    });

  return sqlText
    .replaceAll("__INDEX_VERSIONS_TABLE__", indexVersionTables.versionsTable)
    .replaceAll("__INDEX_VERSIONS_POINTER_TABLE__", indexVersionTables.pointerTable)
    .replaceAll(
      "__INDEX_VERSION_BUILD_PROGRESS_TABLE__",
      indexVersionTables.buildProgressTable
    )
    .replaceAll("__LONG_MEMORY_TABLE__", safeTableNames.longMemoryTable)
    .replaceAll("__DOCUMENTS_TABLE__", safeTableNames.documentsTable)
    .replaceAll("__SESSION_MEMORY_TABLE__", safeTableNames.sessionMemoryTable)
    .replaceAll("__TASKS_TABLE__", safeTableNames.tasksTable)
    .replaceAll("__TASK_EVENTS_TABLE__", safeTableNames.taskEventsTable)
    .replaceAll("__AGENT_RUNS_TABLE__", safeTableNames.agentRunsTable)
    .replaceAll("__AGENT_RUN_EVENTS_TABLE__", safeTableNames.agentRunEventsTable)
    .replaceAll(
      "__AGENT_RUN_APPROVAL_SNAPSHOTS_TABLE__",
      agentRunApprovalSnapshotsTable
    )
    .replaceAll("__ADMIN_AUDIT_EVENTS_TABLE__", safeTableNames.adminAuditEventsTable)
    .replaceAll(
      "__WORKSPACE_ARTIFACTS_TABLE__",
      safeTableNames.workspaceArtifactsTable
    )
    .replaceAll("__DOCUMENT_CHUNKS_TABLE__", safeTableNames.documentChunksTable)
    .replaceAll("__INGEST_JOB_OUTPUTS_TABLE__", getIngestJobOutputsTableName(safeTableNames.ingestJobsTable))
    .replaceAll("__INGEST_JOBS_TABLE__", safeTableNames.ingestJobsTable)
    .replaceAll("__INDEX_VERSION_POINTER_TTL_MS__", String(safePointerTtlMs))
    .replaceAll("__EMBEDDING_DIMENSIONS__", String(safeDimensions))
    .replaceAll("__TEXT_SEARCH_CONFIG__", safeTextSearchConfig)
    .replaceAll("__TENANT_ROLE__", safeTenantRole)
    .replaceAll("__VECTOR_INDEX_STATEMENT__", indexStatement);
};

export const createPostgresMigrator = ({
  getEmbeddingDimensions: resolveEmbeddingDimensions = getEmbeddingDimensions,
  getTableNames: resolveTableNames = getTableNames,
  getTenantRole: resolveTenantRole = getPostgresTenantRole,
  getTextSearchConfig: resolveTextSearchConfig = getPgvectorTextSearchConfig,
  isPostgresConfigured: isConfigured = isPostgresConfigured,
  migrationsDirectory = defaultMigrationsDirectory,
  queryPostgres: query = queryPostgres,
  readFile = readTextFile,
  readdir = readDirectory,
  withPostgresClient: withClient = withPostgresClient,
} = {}) => {
  let migrationsInitialized = false;

  const ensureMigrationsTable = async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  };

  const listMigrationFiles = async () => {
    const fileNames = await readdir(migrationsDirectory);

    return fileNames
      .filter((fileName) => /^\d+.*\.sql$/i.test(fileName))
      .sort((left, right) => left.localeCompare(right));
  };

  const run = async () => {
    if (!isConfigured()) {
      throw new Error(
        "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is required for PostgreSQL-backed storage."
      );
    }

    if (migrationsInitialized) {
      return {
        status: "ok",
        appliedMigrations: [],
      };
    }

    await ensureMigrationsTable();

    const existingMigrations = await query(
      `SELECT id FROM ${MIGRATIONS_TABLE}`
    );
    const appliedMigrationIds = new Set(
      existingMigrations.rows.map((row) => String(row.id))
    );
    const migrationFiles = await listMigrationFiles();
    const newlyAppliedMigrations = [];

    for (const fileName of migrationFiles) {
      if (appliedMigrationIds.has(fileName)) {
        continue;
      }

      const filePath = path.join(migrationsDirectory, fileName);
      const migrationSql = renderMigrationSql(
        await readFile(filePath, "utf8"),
        resolveTableNames(),
        {
          embeddingDimensions: resolveEmbeddingDimensions(),
          tenantRole: resolveTenantRole(),
          textSearchConfig: resolveTextSearchConfig(),
        }
      );

      await withClient(async (client) => {
        await client.query("BEGIN");

        try {
          await client.query(migrationSql);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($1)`,
            [fileName]
          );
          await client.query("COMMIT");
          newlyAppliedMigrations.push(fileName);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    }

    migrationsInitialized = true;

    return {
      status: "ok",
      appliedMigrations: newlyAppliedMigrations,
    };
  };

  return {
    reset: () => {
      migrationsInitialized = false;
    },
    // Stores run migrations lazily, sometimes from inside a tenant request;
    // DDL belongs to the owner role, never the tenant.
    run: () => runAsDatabaseSystem(run),
  };
};

const defaultMigrator = createPostgresMigrator();

export const runPostgresMigrations = () => defaultMigrator.run();

export const resetPostgresMigrations = () => {
  defaultMigrator.reset();
};
