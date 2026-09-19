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
  getLongMemoryPostgresTable,
  getPgvectorHnswEfConstruction,
  getPgvectorHnswM,
  getPgvectorIndexType,
  getPgvectorIvfflatLists,
  getPgvectorTextSearchConfig,
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
  // Optional for injected table maps so older callers keep working; the
  // runtime map always carries it.
  documentChunksTable: ensureSimpleTableName(
    tableNames.documentChunksTable ?? getDocumentChunksPostgresTable(),
    "DOCUMENT_CHUNKS_POSTGRES_TABLE"
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

export const renderMigrationSql = (
  sqlText,
  tableNames = getTableNames(),
  {
    embeddingDimensions = getEmbeddingDimensions(),
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
  const indexStatement =
    vectorIndexStatement ??
    buildPgvectorIndexStatement({
      documentChunksTable: safeTableNames.documentChunksTable,
      dimensions: safeDimensions,
    });

  return sqlText
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
    .replaceAll("__EMBEDDING_DIMENSIONS__", String(safeDimensions))
    .replaceAll("__TEXT_SEARCH_CONFIG__", safeTextSearchConfig)
    .replaceAll("__VECTOR_INDEX_STATEMENT__", indexStatement);
};

export const createPostgresMigrator = ({
  getEmbeddingDimensions: resolveEmbeddingDimensions = getEmbeddingDimensions,
  getTableNames: resolveTableNames = getTableNames,
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
    run,
  };
};

const defaultMigrator = createPostgresMigrator();

export const runPostgresMigrations = () => defaultMigrator.run();

export const resetPostgresMigrations = () => {
  defaultMigrator.reset();
};
