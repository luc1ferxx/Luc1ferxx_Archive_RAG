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
  getFeedbackPostgresTable,
  getIndexVersionPointerTtlMs,
  getIndexVersionsPostgresTable,
  getIngestJobsPostgresTable,
  getLongMemoryPostgresTable,
  getPgvectorHnswEfConstruction,
  getPgvectorHnswM,
  getPgvectorIndexType,
  getPgvectorIvfflatLists,
  getPgvectorTextSearchConfig,
  getPostgresSystemRole,
  getPostgresTenantRole,
  getSessionMemoryPostgresTable,
  getTaskEventsPostgresTable,
  getTasksPostgresTable,
  getTenantUsagePostgresTable,
  getWorkspaceArtifactsPostgresTable,
  getWorkspaceMembersPostgresTable,
  getWorkspacesPostgresTable,
  isPostgresRoleSplitEnabled,
} from "./config.js";
import {
  isPostgresConfigured,
  queryPostgresAsOwner,
  readPostgresRuntimeLogin,
  withPostgresOwnerClient,
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

// Migration 034's feedback table. The indexes it names after the table must
// fit PostgreSQL's 63 bytes too, or PostgreSQL would truncate them.
export const getFeedbackTableName = (feedbackTable = getFeedbackPostgresTable()) => {
  const base = ensureSimpleTableName(feedbackTable, "FEEDBACK_POSTGRES_TABLE");

  for (const derived of [`${base}_scope_created_idx`, `${base}_feedback_id_key`]) {
    ensureSimpleTableName(derived, "derived feedback table identifier");
  }

  return base;
};

// Migration 036's tenant registry tables. The index it names after the
// members table must fit PostgreSQL's 63 bytes too.
export const getTenantRegistryTableNames = ({
  workspaceMembersTable = getWorkspaceMembersPostgresTable(),
  workspacesTable = getWorkspacesPostgresTable(),
} = {}) => {
  const workspaces = ensureSimpleTableName(workspacesTable, "WORKSPACES_POSTGRES_TABLE");
  const members = ensureSimpleTableName(
    workspaceMembersTable,
    "WORKSPACE_MEMBERS_POSTGRES_TABLE"
  );

  if (workspaces.toLowerCase() === members.toLowerCase()) {
    throw new Error(
      `WORKSPACES_POSTGRES_TABLE and WORKSPACE_MEMBERS_POSTGRES_TABLE must differ (both are "${workspaces}").`
    );
  }

  for (const derived of [`${members}_user_idx`, `${workspaces}_status_idx`]) {
    ensureSimpleTableName(derived, "derived tenant registry identifier");
  }

  return { workspaceMembersTable: members, workspacesTable: workspaces };
};

// Migration 037's usage ledger table (TENANT_USAGE_POSTGRES_TABLE). The
// constraints and the index it names after the table must fit PostgreSQL's 63
// bytes too.
export const getTenantUsageTableName = (tenantUsageTable = getTenantUsagePostgresTable()) => {
  const base = ensureSimpleTableName(tenantUsageTable, "TENANT_USAGE_POSTGRES_TABLE");

  for (const derived of [
    `${base}_metric_period_idx`,
    `${base}_period_check`,
    `${base}_metric_check`,
    `${base}_value_check`,
  ]) {
    ensureSimpleTableName(derived, "derived tenant usage identifier");
  }

  return base;
};

// Migration 037's SECURITY DEFINER storage-quota function and the index it
// adds, both named after the documents table.
export const getDocumentStorageTotalsFunctionName = (documentsTable = getDocumentsPostgresTable()) =>
  ensureSimpleTableName(
    `${ensureSimpleTableName(documentsTable, "DOCUMENTS_POSTGRES_TABLE")}_storage_totals`.toLowerCase(),
    "derived document storage-totals function"
  );

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
  feedbackTable: getFeedbackTableName(),
  ...getTenantRegistryTableNames(),
  tenantUsageTable: getTenantUsageTableName(),
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
  // The tables below are optional for injected table maps so older callers
  // keep working; the runtime map always carries them.
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
  feedbackTable: getFeedbackTableName(
    tableNames.feedbackTable ?? getFeedbackPostgresTable()
  ),
  ...getTenantRegistryTableNames({
    workspaceMembersTable:
      tableNames.workspaceMembersTable ?? getWorkspaceMembersPostgresTable(),
    workspacesTable: tableNames.workspacesTable ?? getWorkspacesPostgresTable(),
  }),
  tenantUsageTable: getTenantUsageTableName(
    tableNames.tenantUsageTable ?? getTenantUsagePostgresTable()
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
// must equal the tenant's setting. The system role (migration 035) gets its
// grant and its permissive system_access policy in the same statement; the
// installer that runs after the BM25 install restates them and covers the
// statistics tables and search functions too.
const buildChunkTableTenantPolicySql = ({ chunkTable, systemRole, tenantRole }) => `
GRANT SELECT, INSERT, UPDATE, DELETE ON ${chunkTable} TO ${tenantRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON ${chunkTable} TO ${systemRole};

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

DROP POLICY IF EXISTS system_access ON ${chunkTable};
CREATE POLICY system_access ON ${chunkTable}
  TO ${systemRole}
  USING (true)
  WITH CHECK (true);
`;

/**
 * The owner-only installer migration 035 creates, named after the
 * migration-012 table: it gives the system role one chunk table (grant and
 * system_access policy), the system_access policy on that table's BM25
 * statistics tables, and EXECUTE on its sparse-rank and sparse-search
 * functions.
 */
export const getSystemAccessInstallFunctionName = (
  documentChunksTable = getDocumentChunksPostgresTable()
) =>
  ensureSimpleTableName(
    `${ensureSimpleTableName(documentChunksTable, "DOCUMENT_CHUNKS_POSTGRES_TABLE")}_install_system_access`.toLowerCase(),
    "derived system-access installer"
  );

/**
 * The statement that gives the system role a new index version's table. It
 * runs in the transaction that creates the table, after the table DDL and the
 * BM25 install, so the statistics tables and the search function exist
 * (vector-store-pgvector-version-lifecycle.js). Needs migration 035.
 */
export const renderSystemAccessInstallStatement = ({
  chunkTable,
  documentChunksTable = getDocumentChunksPostgresTable(),
}) => {
  const safeChunkTable = assertIndexVersionChunkTableName(chunkTable).toLowerCase();

  return `SELECT ${getSystemAccessInstallFunctionName(documentChunksTable)}('${safeChunkTable}');`;
};

/**
 * The grant the migrator runs on every run while the role split is on: the
 * tenant and system roles to the runtime login, with SET (it switches into
 * them per transaction) and without INHERIT (it must not use their privileges
 * without switching: an unbound statement would otherwise read through the
 * system role's policies). PostgreSQL 16 split SET and INHERIT out of plain
 * membership; before 16 a plain grant is made and the runtime login itself
 * must be NOINHERIT (the health check reports a login that can use a table
 * directly). A login that already holds SET is left as it is, so a role
 * administrator may make the grant beforehand
 * (deploy/postgres/create-split-roles.sql) and the migration login then
 * needs no ADMIN option. The login's name travels as a transaction-local
 * setting set with a bind parameter, never in the SQL text; the two role names
 * are validated identifiers.
 */
export const renderRuntimeRoleGrantSql = ({
  systemRole = getPostgresSystemRole(),
  tenantRole = getPostgresTenantRole(),
} = {}) => {
  const safeTenantRole = ensureSimpleTableName(tenantRole, "POSTGRES_TENANT_ROLE");
  const safeSystemRole = ensureSimpleTableName(systemRole, "POSTGRES_SYSTEM_ROLE");

  if (safeTenantRole === safeSystemRole) {
    throw new Error(`POSTGRES_SYSTEM_ROLE must differ from POSTGRES_TENANT_ROLE (both are "${safeTenantRole}").`);
  }

  return `DO $grant$
DECLARE
  runtime_login CONSTANT text := current_setting('archive_rag.runtime_login', true);
  granted_role text;
BEGIN
  IF runtime_login IS NULL OR runtime_login = '' THEN
    RAISE EXCEPTION 'The runtime login to grant the tenant and system roles to is not set.';
  END IF;

  FOREACH granted_role IN ARRAY ARRAY['${safeTenantRole}', '${safeSystemRole}'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = granted_role) THEN
      RAISE EXCEPTION 'Role "%" does not exist; migrations 013 and 035 create it.', granted_role;
    END IF;

    BEGIN
      IF current_setting('server_version_num')::int >= 160000 THEN
        IF NOT pg_has_role(runtime_login, granted_role, 'SET') THEN
          EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', granted_role, runtime_login);
        END IF;
      ELSIF NOT pg_has_role(runtime_login, granted_role, 'MEMBER') THEN
        EXECUTE format('GRANT %I TO %I', granted_role, runtime_login);
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'The migration login "%" may not grant role "%" to the runtime login "%".', current_user, granted_role, runtime_login
          USING HINT = format('Grant it as a role administrator: GRANT %I TO %I WITH INHERIT FALSE, SET TRUE;', granted_role, runtime_login);
      -- Another process made the same grant at the same moment.
      WHEN unique_violation THEN
        NULL;
    END;
  END LOOP;
END
$grant$;`;
};

/**
 * The owner-only installer migration 033 creates, named after the
 * migration-012 table: it (re)creates `<table>_sparse_rank` for one chunk
 * table with the tenant filter migration 014's body lacks.
 */
export const getSparseRankInstallFunctionName = (
  documentChunksTable = getDocumentChunksPostgresTable()
) =>
  ensureSimpleTableName(
    `${ensureSimpleTableName(documentChunksTable, "DOCUMENT_CHUNKS_POSTGRES_TABLE")}_install_sparse_rank`.toLowerCase(),
    "derived sparse-rank installer"
  );

/**
 * The statement that gives one chunk table migration 033's sparse-rank
 * function. The table name is a validated simple identifier, so it is safe
 * inside the string literal.
 */
export const renderSparseRankInstallStatement = ({
  chunkTable,
  documentChunksTable = getDocumentChunksPostgresTable(),
}) => {
  const safeChunkTable = assertIndexVersionChunkTableName(chunkTable).toLowerCase();

  return `SELECT ${getSparseRankInstallFunctionName(documentChunksTable)}('${safeChunkTable}');`;
};

/**
 * The owner-only DDL that creates one index version's physical table: the
 * chunk table of migration 012 rendered at the version's width with its own
 * ANN and GIN indexes and foreign key to the documents table, the tenant grant
 * and row policy of migration 013, and the sparse-rank function of migrations
 * 014 and 033 for this table -- the same templates, so a version table cannot
 * drift from the schema the migrations maintain. Migration 014's template
 * still sets the search_vector statistics target; migration 033's installer,
 * called right after it in the same statement, then replaces 014's function
 * with the one that filters a tenant's doc ids by the documents policy, so the
 * unfiltered body is never committed for a version. That call needs migration
 * 033 applied, as the BM25 install needs migration 030. CREATE TABLE is not IF
 * NOT EXISTS: a version id is never reused, so an existing table is an error.
 * The system role (migration 035) gets its grant and system_access policy on
 * the table here too; the lifecycle then runs migration 035's installer after
 * the BM25 install for the statistics tables and the search functions
 * (renderSystemAccessInstallStatement). Under the role split the whole
 * statement runs on the owner pool.
 */
export const renderIndexVersionChunkTableDdl = async ({
  chunkTable,
  dimensions,
  indexParams = {},
  migrationsDirectory = defaultMigrationsDirectory,
  readFile = readTextFile,
  systemRole = getPostgresSystemRole(),
  tableNames = getTableNames(),
  tenantRole = getPostgresTenantRole(),
} = {}) => {
  const safeChunkTable = assertIndexVersionChunkTableName(chunkTable);
  const safeTenantRole = ensureSimpleTableName(tenantRole, "POSTGRES_TENANT_ROLE");
  const safeSystemRole = ensureSimpleTableName(systemRole, "POSTGRES_SYSTEM_ROLE");
  const safeDimensions = ensureEmbeddingDimensions(dimensions);
  const names = { ...tableNames, documentChunksTable: safeChunkTable };
  const options = {
    embeddingDimensions: safeDimensions,
    systemRole: safeSystemRole,
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
    buildChunkTableTenantPolicySql({
      chunkTable: safeChunkTable,
      systemRole: safeSystemRole,
      tenantRole: safeTenantRole,
    }),
    renderMigrationSql(sparseRankTemplate, names, options),
    renderSparseRankInstallStatement({
      chunkTable: safeChunkTable,
      documentChunksTable: tableNames.documentChunksTable ?? getDocumentChunksPostgresTable(),
    }),
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
    systemRole = getPostgresSystemRole(),
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
  const safeSystemRole = ensureSimpleTableName(systemRole, "POSTGRES_SYSTEM_ROLE");
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
    .replaceAll("__FEEDBACK_TABLE__", safeTableNames.feedbackTable)
    .replaceAll("__WORKSPACE_MEMBERS_TABLE__", safeTableNames.workspaceMembersTable)
    .replaceAll("__WORKSPACES_TABLE__", safeTableNames.workspacesTable)
    .replaceAll("__TENANT_USAGE_TABLE__", safeTableNames.tenantUsageTable)
    .replaceAll("__INDEX_VERSION_POINTER_TTL_MS__", String(safePointerTtlMs))
    .replaceAll("__EMBEDDING_DIMENSIONS__", String(safeDimensions))
    .replaceAll("__TEXT_SEARCH_CONFIG__", safeTextSearchConfig)
    .replaceAll("__TENANT_ROLE__", safeTenantRole)
    .replaceAll("__SYSTEM_ROLE__", safeSystemRole)
    .replaceAll("__VECTOR_INDEX_STATEMENT__", indexStatement);
};

/**
 * The role split's grant step (renderRuntimeRoleGrantSql) on an owner client:
 * the runtime login's name as a transaction-local setting (bind parameter),
 * then the grant, in one transaction. Resolves to the login's name.
 */
export const grantRuntimeRoles = async ({
  readRuntimeLogin = readPostgresRuntimeLogin,
  systemRole = getPostgresSystemRole(),
  tenantRole = getPostgresTenantRole(),
  withClient = withPostgresOwnerClient,
} = {}) => {
  const runtimeLogin = await readRuntimeLogin();
  const grantSql = renderRuntimeRoleGrantSql({ systemRole, tenantRole });

  await withClient(async (client) => {
    await client.query("BEGIN");

    try {
      await client.query("SELECT set_config('archive_rag.runtime_login', $1, true)", [runtimeLogin]);
      await client.query(grantSql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  return runtimeLogin;
};

/**
 * Applies the pending migrations, in file order, each in its own transaction
 * on a raw owner session. With the role split on (POSTGRES_MIGRATION_DATABASE_
 * URL) that session and the bookkeeping statements use the owner pool, and
 * after the migrations the tenant and system roles are granted to the runtime
 * login (grantRuntimeRoles) on every run, so a database migrated before the
 * split was switched on needs no extra step; without the split they use the
 * one pool exactly as before and nothing is granted.
 */
export const createPostgresMigrator = ({
  getEmbeddingDimensions: resolveEmbeddingDimensions = getEmbeddingDimensions,
  getSystemRole: resolveSystemRole = getPostgresSystemRole,
  getTableNames: resolveTableNames = getTableNames,
  getTenantRole: resolveTenantRole = getPostgresTenantRole,
  getTextSearchConfig: resolveTextSearchConfig = getPgvectorTextSearchConfig,
  grantRuntimeRoles: grantRoles = grantRuntimeRoles,
  isPostgresConfigured: isConfigured = isPostgresConfigured,
  isRoleSplitEnabled = isPostgresRoleSplitEnabled,
  migrationsDirectory = defaultMigrationsDirectory,
  queryPostgres: query = queryPostgresAsOwner,
  readFile = readTextFile,
  readdir = readDirectory,
  withPostgresClient: withClient = withPostgresOwnerClient,
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
          systemRole: resolveSystemRole(),
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

    const runtimeLogin = isRoleSplitEnabled()
      ? await grantRoles({ systemRole: resolveSystemRole(), tenantRole: resolveTenantRole(), withClient })
      : null;

    migrationsInitialized = true;

    return {
      status: "ok",
      appliedMigrations: newlyAppliedMigrations,
      ...(runtimeLogin === null ? {} : { runtimeLogin }),
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
