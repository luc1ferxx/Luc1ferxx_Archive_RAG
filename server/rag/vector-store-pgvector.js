import {
  getDocumentChunksPostgresTable,
  getDocumentsPostgresTable,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getKeywordWeight,
  getPgvectorIndexType,
  getPgvectorTextSearchConfig,
  getVectorWeight,
} from "./config.js";
import {
  assertPgvectorAnnDimensionsSupported,
  buildPgvectorIndexStatement,
  getPgvectorEmbeddingIndexName,
  isPgvectorAnnDimensionSupported,
  runPostgresMigrations,
} from "./db-migrations.js";
import { embedTexts } from "./openai.js";
import {
  checkPostgresHealth,
  getEnforcedDatabaseTenant,
  isPostgresConfigured,
  queryPostgres,
} from "./postgres.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";
import { buildTermSet, extractMeaningfulTokens } from "./text-utils.js";

// PostgreSQL + pgvector retrieval provider: the default backend.
//
// Two routes, one table. The dense route orders chunks by cosine distance over
// an HNSW/IVFFlat index; the sparse route is PostgreSQL full-text search over a
// generated tsvector, ranked with ts_rank_cd -- which is a cover-density rank,
// not BM25, and is reported as such. Both routes filter by the caller's docIds
// so a query never reads outside the documents it was authorized for.
//
// Every write goes through the caller-supplied transaction client when there
// is one. The ingest path opens that transaction around the document row and
// the chunk rows together, which is the only way the registry and the index
// can be guaranteed to agree after a crash.

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INSERT_BATCH_SIZE = 100;
let schemaVerified = false;
const INSERT_COLUMNS = [
  "chunk_id",
  "doc_id",
  "chunk_index",
  "page_number",
  "section_heading",
  "content",
  "search_text",
  "metadata",
  "owner_user_id",
  "workspace_id",
  "embedding_model",
  "embedding_dimensions",
  "embedding",
];

export const PGVECTOR_ERROR_CODES = Object.freeze({
  dimensionMismatch: "EMBEDDING_DIMENSION_MISMATCH",
  modelMismatch: "EMBEDDING_MODEL_MISMATCH",
  unavailable: "PGVECTOR_UNAVAILABLE",
});

export class PgvectorUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PgvectorUnavailableError";
    this.code = PGVECTOR_ERROR_CODES.unavailable;
    this.status = 503;
  }
}

export class PgvectorEmbeddingDimensionError extends Error {
  constructor({ actual, expected, context }) {
    super(
      `${context}: the current embedding model (${getEmbeddingModel()}) produces ${expected}-dimensional vectors but ${actual} was observed. ` +
        "Chunks embedded under another model or dimension cannot be searched. Run `npm run vector:reindex -- --apply` after setting OPENAI_EMBEDDING_MODEL / RAG_EMBEDDING_DIMENSIONS to rebuild the index."
    );
    this.name = "PgvectorEmbeddingDimensionError";
    this.code = PGVECTOR_ERROR_CODES.dimensionMismatch;
    this.status = 500;
    this.actualDimensions = actual;
    this.expectedDimensions = expected;
  }
}

export class PgvectorEmbeddingModelError extends Error {
  constructor({ storedModels }) {
    super(
      `The pgvector index holds chunks embedded with ${storedModels
        .map((entry) => `${entry.model}/${entry.dimensions}`)
        .join(", ")} but the configured embedding model is ${getEmbeddingModel()}/${getEmbeddingDimensions()}. ` +
        "Refusing to mix embedding spaces. Run `npm run vector:reindex -- --apply` to re-embed the archive under the current model."
    );
    this.name = "PgvectorEmbeddingModelError";
    this.code = PGVECTOR_ERROR_CODES.modelMismatch;
    this.status = 500;
    this.storedModels = storedModels;
  }
}

const ensureTableName = (tableName, envName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `${envName} must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

export const getPgvectorTableName = () =>
  ensureTableName(getDocumentChunksPostgresTable(), "DOCUMENT_CHUNKS_POSTGRES_TABLE");

const getDocumentsTableName = () =>
  ensureTableName(getDocumentsPostgresTable(), "DOCUMENTS_POSTGRES_TABLE");

// Test injection point, in the same spirit as configureOpenAIProvider and
// configureQdrantClientFactory: unit tests hand in a scripted query function
// and a no-op migration runner so the SQL this module emits can be checked
// without a database. Production never calls it.
let runtimeOverrides = null;

export const configurePgvectorRuntime = (overrides = null) => {
  runtimeOverrides = overrides && typeof overrides === "object" ? overrides : null;
  schemaVerified = false;
};

export const resetPgvectorRuntime = () => {
  configurePgvectorRuntime(null);
};

const getRuntime = () => ({
  checkHealth: runtimeOverrides?.checkPostgresHealth ?? checkPostgresHealth,
  isConfigured: runtimeOverrides?.isPostgresConfigured ?? isPostgresConfigured,
  query: runtimeOverrides?.query ?? queryPostgres,
  runMigrations: runtimeOverrides?.runMigrations ?? runPostgresMigrations,
});

const getQuery = (client) =>
  client && typeof client.query === "function"
    ? (sql, values = []) => client.query(sql, values)
    : getRuntime().query;

const toVectorLiteral = (vector) => `[${vector.map((value) => Number(value) || 0).join(",")}]`;

const toDocIdArray = (docIds) =>
  [...new Set((Array.isArray(docIds) ? docIds : []).map((docId) => String(docId ?? "").trim()).filter(Boolean))];

const normalizeMetadata = (metadata = {}) => ({
  ...metadata,
  docId: metadata.docId ?? "",
  fileName: metadata.fileName ?? "Unknown document",
  filePath: metadata.filePath ?? "",
  publicFilePath: metadata.publicFilePath ?? "",
  pageNumber: metadata.pageNumber ?? null,
  chunkIndex: metadata.chunkIndex ?? null,
  sectionHeading: metadata.sectionHeading ?? null,
});

// Same text the local sparse store indexes, tokenized by the same tokenizer,
// so the lexical route sees identical terms whichever backend is active.
export const buildSearchText = ({ pageContent = "", metadata = {} } = {}) =>
  extractMeaningfulTokens(
    [metadata.fileName, metadata.sectionHeading, pageContent].filter(Boolean).join("\n")
  ).join(" ");

const buildKeywordScore = (queryTerms, { pageContent = "", metadata = {} }) => {
  if (queryTerms.size === 0) {
    return null;
  }

  const entryTerms = buildTermSet(
    [metadata.fileName, metadata.sectionHeading, pageContent].filter(Boolean).join("\n")
  );

  if (entryTerms.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const term of queryTerms) {
    if (entryTerms.has(term)) {
      overlap += 1;
    }
  }

  return overlap / queryTerms.size;
};

const buildCombinedScore = (vectorScore, keywordScore) => {
  if (keywordScore === null) {
    return vectorScore;
  }

  const weightedScore = vectorScore * getVectorWeight() + keywordScore * getKeywordWeight();

  return Math.max(vectorScore, keywordScore, weightedScore);
};

const rowToDocument = (row) => ({
  id: String(row.chunk_id),
  pageContent: String(row.content ?? ""),
  metadata: normalizeMetadata({
    ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
    docId: row.doc_id,
    pageNumber: row.page_number ?? null,
    chunkIndex: row.chunk_index ?? null,
    sectionHeading: row.section_heading ?? null,
  }),
});

const assertDimensions = ({ actual, context }) => {
  const expected = getEmbeddingDimensions();

  if (actual !== expected) {
    throw new PgvectorEmbeddingDimensionError({ actual, context, expected });
  }
};

const buildTsQuery = (queryText) => {
  const tokens = [...new Set(extractMeaningfulTokens(queryText))];

  if (tokens.length === 0) {
    return null;
  }

  // OR semantics: a chunk matching any query term is a candidate and
  // ts_rank_cd orders by how many it covers. Tokens are already reduced to
  // [a-z0-9] runs and single CJK characters, but quote them anyway.
  return {
    tokens,
    tsQuery: tokens.map((token) => `'${token.replace(/'/g, "''")}'`).join(" | "),
  };
};

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

export const resetPgvectorVectorStore = () => {
  schemaVerified = false;
};

const readColumnDimensions = async ({ query, tableName }) => {
  const result = await query(
    `
      SELECT a.atttypmod AS typmod
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1
        AND n.nspname = current_schema()
        AND a.attname = 'embedding'
        AND NOT a.attisdropped
      LIMIT 1
    `,
    [tableName]
  );
  const typmod = Number(result.rows[0]?.typmod);

  return Number.isInteger(typmod) && typmod > 0 ? typmod : null;
};

const readStoredEmbeddingModels = async ({ query, tableName }) => {
  const result = await query(
    `
      SELECT embedding_model, embedding_dimensions, COUNT(*)::int AS chunk_count
      FROM ${tableName}
      GROUP BY embedding_model, embedding_dimensions
      ORDER BY embedding_model, embedding_dimensions
    `
  );

  return result.rows.map((row) => ({
    chunkCount: Number(row.chunk_count) || 0,
    dimensions: Number(row.embedding_dimensions) || 0,
    model: String(row.embedding_model ?? ""),
  }));
};

const readIndexNames = async ({ query, tableName }) => {
  const result = await query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1`,
    [tableName]
  );

  return new Set(result.rows.map((row) => String(row.indexname)));
};

// The actual access method backing the embedding index, read from the catalog
// rather than inferred from config. pg_indexes tells us a name exists; only the
// pg_am join tells us whether that index is really an hnsw/ivfflat ANN index or
// something else entirely (e.g. a stray btree). Returns the lowercased amname,
// or null when no index by that name exists.
const readAnnIndexMethod = async ({ query, tableName }) => {
  const indexName = getPgvectorEmbeddingIndexName(tableName);
  const result = await query(
    `
      SELECT am.amname AS access_method
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = $1
        AND n.nspname = current_schema()
        AND c.relkind = 'i'
      LIMIT 1
    `,
    [indexName]
  );
  const method = result.rows[0]?.access_method;

  return method ? String(method).toLowerCase() : null;
};

const readExtension = async ({ query }) => {
  const result = await query(
    `SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1`
  );

  return result.rows[0] ? { installed: true, version: String(result.rows[0].extversion) } : { installed: false, version: null };
};

const tableExists = async ({ query, tableName }) => {
  const result = await query(`SELECT to_regclass($1) AS relation`, [tableName]);

  return Boolean(result.rows[0]?.relation);
};

/**
 * Resizes the embedding column to the configured width. Only legal on an empty
 * table: a populated table holds vectors of the old width, and pgvector would
 * refuse the cast anyway. Callers that hit the populated case get the
 * dimension error with reindex instructions instead.
 */
const resizeEmbeddingColumn = async ({ query, tableName, dimensions }) => {
  // Fail closed before touching the column: if the target width cannot carry an
  // ANN index, refuse the whole resize rather than dropping the index and
  // altering the column only to abort on CREATE INDEX and leave it index-less.
  assertPgvectorAnnDimensionsSupported({ dimensions });

  const indexName = getPgvectorEmbeddingIndexName(tableName);

  await query(`DROP INDEX IF EXISTS ${indexName}`);
  await query(`ALTER TABLE ${tableName} ALTER COLUMN embedding TYPE vector(${dimensions})`);
  await query(
    buildPgvectorIndexStatement({ documentChunksTable: tableName, dimensions })
  );
};

/**
 * Applies migrations and verifies the table matches the configured embedding
 * space. Throws with a stable code when it does not: this is the fail-closed
 * boundary the goal asks for, and every read/write below goes through it.
 */
export const ensurePgvectorSchema = async ({ client = null, force = false } = {}) => {
  if (schemaVerified && !force) {
    return true;
  }

  // The check is about the whole table: under a tenant the row policies would
  // hide other tenants' chunks from the emptiness and stored-model checks, and
  // the tenant role may not resize the column. It therefore never borrows a
  // tenant transaction's client and always runs as the owner.
  const verificationClient = getEnforcedDatabaseTenant() ? null : client;

  return runAsDatabaseSystem(() => verifyPgvectorSchema({ client: verificationClient }));
};

const verifyPgvectorSchema = async ({ client = null } = {}) => {
  const runtime = getRuntime();

  if (!runtime.isConfigured()) {
    throw new PgvectorUnavailableError(
      "VECTOR_STORE_PROVIDER=pgvector requires POSTGRES_DATABASE_URL (or LONG_MEMORY_DATABASE_URL). Refusing to fall back to the local index."
    );
  }

  await runtime.runMigrations();

  const query = getQuery(client);
  const tableName = getPgvectorTableName();
  const extension = await readExtension({ query });

  if (!extension.installed) {
    throw new PgvectorUnavailableError(
      "The PostgreSQL `vector` extension is not installed. Use a pgvector-enabled PostgreSQL image (pgvector/pgvector:pg16) or run CREATE EXTENSION vector as a superuser."
    );
  }

  const expectedDimensions = getEmbeddingDimensions();
  const columnDimensions = await readColumnDimensions({ query, tableName });

  if (columnDimensions !== expectedDimensions) {
    const storedModels = await readStoredEmbeddingModels({ query, tableName });
    const storedChunkCount = storedModels.reduce((sum, entry) => sum + entry.chunkCount, 0);

    if (storedChunkCount > 0) {
      throw new PgvectorEmbeddingDimensionError({
        actual: columnDimensions,
        context: `The ${tableName}.embedding column is vector(${columnDimensions}) and already holds ${storedChunkCount} chunk(s)`,
        expected: expectedDimensions,
      });
    }

    await resizeEmbeddingColumn({ query, tableName, dimensions: expectedDimensions });
  }

  const storedModels = await readStoredEmbeddingModels({ query, tableName });
  const foreignModels = storedModels.filter(
    (entry) =>
      entry.chunkCount > 0 &&
      (entry.model !== getEmbeddingModel() || entry.dimensions !== expectedDimensions)
  );

  if (foreignModels.length > 0) {
    throw new PgvectorEmbeddingModelError({ storedModels: foreignModels });
  }

  schemaVerified = true;
  return true;
};

/**
 * Non-throwing description of the provider for health and admin status. It
 * describes the whole table, never one tenant's share, so it runs as the owner.
 */
export const describePgvectorStatus = async () =>
  runAsDatabaseSystem(() => describePgvectorTableStatus());

const describePgvectorTableStatus = async () => {
  const runtime = getRuntime();
  const queryPostgres = runtime.query;
  const tableName = getPgvectorTableName();
  const base = {
    configured: runtime.isConfigured(),
    embedding: {
      columnDimensions: null,
      configuredDimensions: getEmbeddingDimensions(),
      matches: false,
      model: getEmbeddingModel(),
      storedModels: [],
    },
    extension: { installed: false, version: null },
    indexType: getPgvectorIndexType(),
    // ANN index intent vs. reality. `configured` is the method migrations would
    // build; `actual` is the access method actually on the embedding index (read
    // from pg_am, null when absent); `matches` is true only when both agree.
    // `supported` reflects whether the configured embedding can carry an ANN
    // index at all (<= the pgvector vector-type ceiling) — when false, an absent
    // ANN index is expected fail-closed behaviour, not a partial migration.
    annIndex: {
      configured: getPgvectorIndexType(),
      actual: null,
      present: false,
      matches: false,
      supported: isPgvectorAnnDimensionSupported(getEmbeddingDimensions()),
    },
    annDimensionsSupported: isPgvectorAnnDimensionSupported(
      getEmbeddingDimensions()
    ),
    indexes: {},
    provider: "pgvector",
    reachable: false,
    table: { exists: false, name: tableName },
    textSearchConfig: getPgvectorTextSearchConfig(),
    chunkCount: 0,
    documentCount: 0,
    indexEmptyWithDocuments: false,
  };

  if (!base.configured) {
    return { ...base, message: "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is missing." };
  }

  const health = await runtime.checkHealth();

  if (health.status !== "ok") {
    return { ...base, message: health.message };
  }

  base.reachable = true;
  base.extension = await readExtension({ query: queryPostgres });
  base.table.exists = await tableExists({ query: queryPostgres, tableName });

  if (!base.table.exists) {
    return { ...base, message: `Table ${tableName} does not exist. Run migrations (they run at startup and on health checks).` };
  }

  const indexNames = await readIndexNames({ query: queryPostgres, tableName });
  base.indexes = {
    docId: indexNames.has(`${tableName}_doc_id_idx`),
    embedding: indexNames.has(getPgvectorEmbeddingIndexName(tableName)),
    embeddingModel: indexNames.has(`${tableName}_embedding_model_idx`),
    scope: indexNames.has(`${tableName}_scope_idx`),
    searchVector: indexNames.has(`${tableName}_search_vector_idx`),
  };

  const annMethod = await readAnnIndexMethod({ query: queryPostgres, tableName });
  const configuredAnnMethod = getPgvectorIndexType();
  base.annIndex = {
    configured: configuredAnnMethod,
    actual: annMethod,
    present: annMethod !== null,
    matches: annMethod !== null && annMethod === configuredAnnMethod,
    supported: base.annDimensionsSupported,
  };
  base.embedding.columnDimensions = await readColumnDimensions({ query: queryPostgres, tableName });
  base.embedding.storedModels = await readStoredEmbeddingModels({ query: queryPostgres, tableName });
  base.chunkCount = base.embedding.storedModels.reduce((sum, entry) => sum + entry.chunkCount, 0);
  base.embedding.matches =
    base.embedding.columnDimensions === base.embedding.configuredDimensions &&
    base.embedding.storedModels.every(
      (entry) =>
        entry.chunkCount === 0 ||
        (entry.model === base.embedding.model &&
          entry.dimensions === base.embedding.configuredDimensions)
    );

  const documents = await queryPostgres(
    `SELECT COUNT(*)::int AS document_count FROM ${getDocumentsTableName()}`
  );
  base.documentCount = Number(documents.rows[0]?.document_count) || 0;
  base.indexEmptyWithDocuments = base.documentCount > 0 && base.chunkCount === 0;

  return base;
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Embeds outside any transaction. The vectors are computed once here and then
 * written by writeDocumentsToPgvectorIndex inside whatever transaction the
 * caller opened, so a slow embedding call never holds a database lock.
 */
export const prepareDocumentsForPgvectorIndex = async ({ documents }) => {
  const safeDocuments = Array.isArray(documents) ? documents : [];

  if (safeDocuments.length === 0) {
    return [];
  }

  const vectors = await embedTexts(safeDocuments.map((document) => document.pageContent));

  if (vectors.length !== safeDocuments.length) {
    throw new Error(
      `Embedding provider returned ${vectors.length} vector(s) for ${safeDocuments.length} chunk(s).`
    );
  }

  return safeDocuments.map((document, index) => {
    const vector = Array.isArray(vectors[index]) ? vectors[index] : [];

    assertDimensions({
      actual: vector.length,
      context: `Embedding chunk ${document.id}`,
    });

    return {
      id: String(document.id),
      metadata: normalizeMetadata(document.metadata),
      pageContent: String(document.pageContent ?? ""),
      searchText: buildSearchText(document),
      vector,
    };
  });
};

const chunkArray = (values, size) => {
  const batches = [];

  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }

  return batches;
};

export const writeDocumentsToPgvectorIndex = async ({
  accessScope = {},
  client = null,
  preparedDocuments = [],
} = {}) => {
  if (preparedDocuments.length === 0) {
    return { insertedChunkCount: 0, replacedDocIds: [] };
  }

  await ensurePgvectorSchema({ client });

  const query = getQuery(client);
  const tableName = getPgvectorTableName();
  const docIds = toDocIdArray(preparedDocuments.map((document) => document.metadata.docId));
  const ownerUserId = String(accessScope?.userId ?? accessScope?.ownerUserId ?? "").trim();
  const workspaceId = String(accessScope?.workspaceId ?? "").trim();
  const embeddingModel = getEmbeddingModel();
  const embeddingDimensions = getEmbeddingDimensions();

  // Re-ingesting a docId replaces its chunks wholesale. Chunk ids embed the
  // docId, but chunk counts can shrink between uploads, so a delete is the
  // only way to drop rows the new chunking no longer produces.
  await query(`DELETE FROM ${tableName} WHERE doc_id = ANY($1::text[])`, [docIds]);

  let insertedChunkCount = 0;

  for (const batch of chunkArray(preparedDocuments, INSERT_BATCH_SIZE)) {
    const values = [];
    const rows = batch.map((document, rowIndex) => {
      const base = rowIndex * INSERT_COLUMNS.length;

      values.push(
        document.id,
        document.metadata.docId,
        Number.isInteger(document.metadata.chunkIndex) ? document.metadata.chunkIndex : 0,
        Number.isInteger(document.metadata.pageNumber) ? document.metadata.pageNumber : null,
        document.metadata.sectionHeading ?? null,
        document.pageContent,
        document.searchText,
        JSON.stringify(document.metadata),
        ownerUserId,
        workspaceId,
        embeddingModel,
        embeddingDimensions,
        toVectorLiteral(document.vector)
      );

      return `(${INSERT_COLUMNS.map((column, columnIndex) =>
        column === "embedding"
          ? `$${base + columnIndex + 1}::vector`
          : column === "metadata"
            ? `$${base + columnIndex + 1}::jsonb`
            : `$${base + columnIndex + 1}`
      ).join(", ")})`;
    });

    const result = await query(
      `
        INSERT INTO ${tableName} (${INSERT_COLUMNS.join(", ")})
        VALUES ${rows.join(",\n")}
        ON CONFLICT (chunk_id) DO UPDATE SET
          doc_id = EXCLUDED.doc_id,
          chunk_index = EXCLUDED.chunk_index,
          page_number = EXCLUDED.page_number,
          section_heading = EXCLUDED.section_heading,
          content = EXCLUDED.content,
          search_text = EXCLUDED.search_text,
          metadata = EXCLUDED.metadata,
          owner_user_id = EXCLUDED.owner_user_id,
          workspace_id = EXCLUDED.workspace_id,
          embedding_model = EXCLUDED.embedding_model,
          embedding_dimensions = EXCLUDED.embedding_dimensions,
          embedding = EXCLUDED.embedding
      `,
      values
    );

    insertedChunkCount += result.rowCount ?? batch.length;
  }

  return { insertedChunkCount, replacedDocIds: docIds };
};

export const addDocumentsToPgvectorIndex = async ({
  accessScope = {},
  client = null,
  documents,
} = {}) => {
  const preparedDocuments = await prepareDocumentsForPgvectorIndex({ documents });

  return writeDocumentsToPgvectorIndex({ accessScope, client, preparedDocuments });
};

export const removeDocumentsFromPgvectorIndex = async ({ client = null, docIds } = {}) => {
  const normalizedDocIds = toDocIdArray(docIds);

  if (normalizedDocIds.length === 0) {
    return 0;
  }

  await ensurePgvectorSchema({ client });

  const result = await getQuery(client)(
    `DELETE FROM ${getPgvectorTableName()} WHERE doc_id = ANY($1::text[])`,
    [normalizedDocIds]
  );

  return result.rowCount ?? 0;
};

export const clearPgvectorIndex = async ({ client = null } = {}) => {
  await ensurePgvectorSchema({ client });

  const result = await getQuery(client)(`DELETE FROM ${getPgvectorTableName()}`);

  // A cleared table is the one moment a dimension change is safe; let the next
  // ensure re-check the column instead of trusting the cached verdict.
  schemaVerified = false;

  return result.rowCount ?? 0;
};

export const countPgvectorChunks = async ({ client = null, docIds = null } = {}) => {
  const query = getQuery(client);
  const tableName = getPgvectorTableName();
  const normalizedDocIds = docIds === null ? null : toDocIdArray(docIds);
  const result =
    normalizedDocIds === null
      ? await query(`SELECT COUNT(*)::int AS chunk_count FROM ${tableName}`)
      : await query(
          `SELECT COUNT(*)::int AS chunk_count FROM ${tableName} WHERE doc_id = ANY($1::text[])`,
          [normalizedDocIds]
        );

  return Number(result.rows[0]?.chunk_count) || 0;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const searchPgvectorDocuments = async ({
  queryVector,
  queryText = "",
  docIds,
  topK,
  scoringMode = "combined",
  client = null,
} = {}) => {
  const normalizedDocIds = toDocIdArray(docIds);
  const limit = Math.max(1, Math.floor(Number(topK) || 1));

  if (normalizedDocIds.length === 0 || !Array.isArray(queryVector) || queryVector.length === 0) {
    return [];
  }

  await ensurePgvectorSchema({ client });
  assertDimensions({ actual: queryVector.length, context: "Embedding the query" });

  const result = await getQuery(client)(
    `
      SELECT chunk_id, doc_id, chunk_index, page_number, section_heading, content, metadata,
             1 - (embedding <=> $1::vector) AS vector_score
      FROM ${getPgvectorTableName()}
      WHERE doc_id = ANY($2::text[])
        AND embedding_model = $3
        AND embedding_dimensions = $4
      ORDER BY embedding <=> $1::vector ASC, chunk_id ASC
      LIMIT $5
    `,
    [
      toVectorLiteral(queryVector),
      normalizedDocIds,
      getEmbeddingModel(),
      getEmbeddingDimensions(),
      limit,
    ]
  );
  const queryTerms = buildTermSet(queryText);

  return result.rows
    .map((row) => {
      const document = rowToDocument(row);
      const vectorScore = Number(row.vector_score) || 0;
      const keywordScore = buildKeywordScore(queryTerms, document);

      return {
        document,
        score:
          scoringMode === "dense"
            ? vectorScore
            : buildCombinedScore(vectorScore, keywordScore),
        vectorScore,
        keywordScore,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    );
};

export const searchPgvectorSparseDocuments = async ({
  queryText = "",
  docIds,
  topK,
  client = null,
} = {}) => {
  const normalizedDocIds = toDocIdArray(docIds);
  const limit = Math.max(1, Math.floor(Number(topK) || 1));
  const tsQuery = buildTsQuery(queryText);

  if (normalizedDocIds.length === 0 || !tsQuery) {
    return [];
  }

  await ensurePgvectorSchema({ client });

  // ts_rank_cd with normalization 32 maps the cover-density rank into [0, 1)
  // (rank / (rank + 1)) so scores are comparable across queries. It is not
  // BM25 and is never labelled as such.
  const result = await getQuery(client)(
    `
      SELECT chunk_id, doc_id, chunk_index, page_number, section_heading, content, metadata,
             ts_rank_cd(search_vector, to_tsquery($1::regconfig, $2), 32) AS sparse_score
      FROM ${getPgvectorTableName()}
      WHERE doc_id = ANY($3::text[])
        AND search_vector @@ to_tsquery($1::regconfig, $2)
      ORDER BY sparse_score DESC, chunk_id ASC
      LIMIT $4
    `,
    [getPgvectorTextSearchConfig(), tsQuery.tsQuery, normalizedDocIds, limit]
  );
  const queryTerms = new Set(tsQuery.tokens);

  return result.rows
    .map((row) => {
      const document = rowToDocument(row);
      const sparseScore = Number(row.sparse_score) || 0;

      return {
        document,
        score: sparseScore,
        sparseScore,
        keywordScore: buildKeywordScore(queryTerms, document),
      };
    })
    .sort(
      (left, right) =>
        right.sparseScore - left.sparseScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    );
};

export const searchPgvectorDocumentsPerDocument = async ({
  queryVector,
  queryText = "",
  docIds,
  topKPerDoc,
  scoringMode = "combined",
} = {}) =>
  new Map(
    await Promise.all(
      toDocIdArray(docIds).map(async (docId) => [
        docId,
        await searchPgvectorDocuments({
          queryVector,
          queryText,
          docIds: [docId],
          topK: topKPerDoc,
          scoringMode,
        }),
      ])
    )
  );
