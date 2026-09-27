import {
  getDocumentsPostgresTable,
  getEmbeddingModel,
  getKeywordWeight,
  getPgvectorIterativeScan,
  getVectorWeight,
} from "./config.js";
import {
  assertPgvectorAnnDimensionsSupported,
  buildPgvectorIndexStatement,
  getPgvectorEmbeddingIndexName,
  isPgvectorAnnDimensionSupported,
} from "./db-migrations.js";
import { embedQueryCached, getQueryVectorEmbeddingSpace, resetEmbeddingCache } from "./embedding-cache.js";
import { embedTexts } from "./openai.js";
import { getEnforcedDatabaseTenant } from "./postgres.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";
import { buildTermSet, extractMeaningfulTokens } from "./text-utils.js";
import {
  PGVECTOR_SPARSE_SEARCH_SIGNATURE,
  buildPgvectorSparseSearchSql,
  buildPgvectorSparseSearchValues,
  getPgvectorSparseBackend,
  getPgvectorSparseSearchFunctionName,
  getPgvectorSparseStatisticsTables,
  resolvePgvectorSparseScoring,
  toMissingSparseSearchFunctionError,
  usesPgvectorSparseSearchFunction,
} from "./vector-store-pgvector-sparse.js";
import {
  configurePgvectorRuntime,
  getPgvectorQuery,
  getPgvectorRuntime,
  onPgvectorRuntimeReset,
  resetPgvectorRuntime,
} from "./vector-store-pgvector-runtime.js";
import {
  EMBEDDING_SPACE_SOURCES,
  buildLegacyIndexVersion,
  describeIndexVersions,
  fenceNonServingIndexVersions,
  getConfiguredEmbeddingSpace,
  getHintedWriteSpaces,
  getPgvectorBaseTableName,
  getVersionVerificationKey,
  invalidateIndexVersionSnapshot,
  isIndexVersionWriteTarget,
  isSameDocumentSpace,
  isSameQuerySpace,
  lockIndexVersionWriteTargets,
  readIndexVersionSnapshot,
  resolveVersionIndexParams,
  resolveVersionSpace,
} from "./vector-store-pgvector-versions.js";

// PostgreSQL + pgvector retrieval provider: the default backend.
//
// Two routes over one table. The dense route orders chunks by cosine distance
// over an HNSW/IVFFlat index; the sparse route is PostgreSQL full-text search
// over a generated tsvector, ranked either with ts_rank_cd -- a cover-density
// rank, not BM25, and reported as such -- or, with RAG_SPARSE_SCORING=bm25,
// with Okapi BM25 over per-version, per-scope statistics; either may prune
// common query terms from candidate generation (vector-store-pgvector-sparse.js,
// migrations 029/030). Both routes filter by the caller's docIds so a query
// never reads outside the documents it was authorized for.
//
// "The table" is the active index version's (vector-store-pgvector-versions.js):
// version 1 is the migration-012 table, and a version built by
// `npm run vector:index -- build` has its own table, width and embedding model.
// Searches read the active version through a short-TTL pointer cache; every
// write goes to all of the versions that must stay complete (dual write).
//
// Every write goes through the caller-supplied transaction client when there
// is one. The ingest path opens that transaction around the document row and
// the chunk rows together, which is the only way the registry and the index
// can be guaranteed to agree after a crash.

export { configurePgvectorRuntime, resetPgvectorRuntime };

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INSERT_BATCH_SIZE = 100;
const MISSING_RELATION_CODES = new Set(["42P01", "42883"]);
// The active version this process verified (getVersionVerificationKey), so a
// search only re-reads the cheap pointer, never the whole table, while the
// active version stays the same.
let verified = null;
// The pgvector version schema verification read; it decides whether the dense
// route can ask for an iterative HNSW scan (a 0.8 setting).
let verifiedExtensionVersion = null;
// The verification in flight, per verification key: after a switch every
// concurrent request of this process waits for one verification (a full
// GROUP BY over the new version's table) instead of running its own.
const verificationsInFlight = new Map();
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

const CONFIGURATION_REMEDY =
  "Run `npm run vector:reindex -- --apply` after setting OPENAI_EMBEDDING_MODEL / RAG_EMBEDDING_DIMENSIONS to rebuild the index, or build a new index version with `npm run vector:index -- build`.";
const PINNED_REMEDY =
  "The active index version is pinned to its own embedding model; build and activate a new version with `npm run vector:index -- build` instead of rewriting it in place.";

export class PgvectorUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PgvectorUnavailableError";
    this.code = PGVECTOR_ERROR_CODES.unavailable;
    this.status = 503;
  }
}

export class PgvectorEmbeddingDimensionError extends Error {
  constructor({ actual, expected, context, model = null, remedy = CONFIGURATION_REMEDY }) {
    super(
      `${context}: the embedding model (${model ?? getEmbeddingModel()}) produces ${expected}-dimensional vectors but ${actual} was observed. ` +
        `Chunks embedded under another model or dimension cannot be searched. ${remedy}`
    );
    this.name = "PgvectorEmbeddingDimensionError";
    this.code = PGVECTOR_ERROR_CODES.dimensionMismatch;
    this.status = 500;
    this.actualDimensions = actual;
    this.expectedDimensions = expected;
  }
}

export class PgvectorEmbeddingModelError extends Error {
  constructor({ storedModels, expected = getConfiguredEmbeddingSpace(), remedy = CONFIGURATION_REMEDY }) {
    super(
      `The pgvector index holds chunks embedded with ${storedModels
        .map((entry) => `${entry.model}/${entry.dimensions}`)
        .join(", ")} but the configured embedding model is ${expected.identity}/${expected.dimensions}. ` +
        `Refusing to mix embedding spaces. ${remedy}`
    );
    this.name = "PgvectorEmbeddingModelError";
    this.code = PGVECTOR_ERROR_CODES.modelMismatch;
    this.status = 500;
    this.storedModels = storedModels;
  }
}

/** The migration-012 table (index version 1). Searches use the active version's. */
export const getPgvectorTableName = () => getPgvectorBaseTableName();

const getDocumentsTableName = () => {
  const tableName = getDocumentsPostgresTable();

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `DOCUMENTS_POSTGRES_TABLE must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

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

const assertDimensions = ({ actual, context, space = getConfiguredEmbeddingSpace() }) => {
  if (actual !== space.dimensions) {
    throw new PgvectorEmbeddingDimensionError({
      actual,
      context,
      expected: space.dimensions,
      model: space.model,
    });
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
// Embedding spaces
// ---------------------------------------------------------------------------

const toEmbeddingSpaceRequest = (space) => ({
  dimensions: space.dimensions,
  documentPrefix: space.documentPrefix,
  identity: space.identity,
  model: space.model,
  queryPrefix: space.queryPrefix,
});

/**
 * Embeds document texts in `space`: the configured model through the usual
 * path, a version pinned to another model through the same route with that
 * model and its prefixes. Every vector must have the space's width.
 */
export const embedDocumentsInSpace = async (
  texts,
  space = getConfiguredEmbeddingSpace(),
  { describeItem = (index) => `Embedding chunk ${index}` } = {}
) => {
  const safeTexts = Array.isArray(texts) ? texts : [];

  if (safeTexts.length === 0) {
    return [];
  }

  const vectors = isSameDocumentSpace(space, getConfiguredEmbeddingSpace())
    ? await embedTexts(safeTexts)
    : await embedTexts(safeTexts, { embeddingSpace: toEmbeddingSpaceRequest(space) });

  if (!Array.isArray(vectors) || vectors.length !== safeTexts.length) {
    throw new Error(
      `Embedding provider returned ${Array.isArray(vectors) ? vectors.length : 0} vector(s) for ${safeTexts.length} chunk(s).`
    );
  }

  return vectors.map((vector, index) => {
    const safeVector = Array.isArray(vector) ? vector : [];

    assertDimensions({ actual: safeVector.length, context: describeItem(index), space });
    return safeVector;
  });
};

/**
 * The query's vector in `space`, through the process's query embedding cache
 * (rag/embedding-cache.js: one LRU keyed by space and text, sized by
 * RAG_EMBEDDING_CACHE_MAX), width-checked.
 */
export const embedQueryInSpace = async (queryText, space = getConfiguredEmbeddingSpace()) => {
  const vector = await embedQueryCached(String(queryText ?? ""), { space });

  assertDimensions({ actual: Array.isArray(vector) ? vector.length : 0, context: "Embedding the query", space });
  return vector;
};

/**
 * The query vector for the active version. embedQueryCached embeds a query in
 * the space the index serves and tags the vector with it, so the caller's
 * vector is used as is when it was embedded in the active version's space.
 * An untagged vector counts as the configured space's (what every caller sent
 * before index versions). Only when the two differ -- the pointer moved between
 * the embedding and the search, or a caller embedded in the configured model
 * while a version pinned to another one serves -- is the text embedded again,
 * in the active space.
 */
const resolveQueryVector = async ({ queryText, queryVector, space }) => {
  const vectorSpace = getQueryVectorEmbeddingSpace(queryVector) ?? getConfiguredEmbeddingSpace();

  if (isSameQuerySpace(space, vectorSpace)) {
    assertDimensions({ actual: queryVector.length, context: "Embedding the query", space });
    return queryVector;
  }

  if (!String(queryText ?? "").trim()) {
    throw new PgvectorEmbeddingDimensionError({
      actual: queryVector.length,
      context: "The active index version is pinned to another embedding model and the query came without its text",
      expected: space.dimensions,
      model: space.model,
      remedy: PINNED_REMEDY,
    });
  }

  return embedQueryInSpace(queryText, space);
};

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

export const resetPgvectorVectorStore = () => {
  verified = null;
  verificationsInFlight.clear();
  // Query vectors of the previous store's spaces (the cache is shared with
  // the configured space: a cold start of the store is a cold cache).
  resetEmbeddingCache();
  invalidateIndexVersionSnapshot();
};

onPgvectorRuntimeReset(() => {
  verified = null;
  verificationsInFlight.clear();
});

export const readPgvectorColumnDimensions = async ({ query, tableName }) => {
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

export const readPgvectorStoredEmbeddingModels = async ({ query, tableName }) => {
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

// hnsw.iterative_scan exists from pgvector 0.8.0. Older servers reserve the
// hnsw.* prefix, so setting it there is an error rather than a no-op.
export const supportsPgvectorIterativeScan = (version) => {
  const match = /^(\d+)\.(\d+)/.exec(String(version ?? ""));

  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);

  return major > 0 || minor >= 8;
};

// The mode the dense route will set, or null when it keeps the plain
// statement (switched off, or a server older than 0.8).
const getActiveIterativeScan = () => {
  const mode = getPgvectorIterativeScan();

  return mode !== "off" && supportsPgvectorIterativeScan(verifiedExtensionVersion) ? mode : null;
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
const resizeEmbeddingColumn = async ({ query, tableName, dimensions, indexParams }) => {
  // Fail closed before touching the column: if the target width cannot carry an
  // ANN index, refuse the whole resize rather than dropping the index and
  // altering the column only to abort on CREATE INDEX and leave it index-less.
  assertPgvectorAnnDimensionsSupported({ dimensions });

  const indexName = getPgvectorEmbeddingIndexName(tableName);

  await query(`DROP INDEX IF EXISTS ${indexName}`);
  await query(`ALTER TABLE ${tableName} ALTER COLUMN embedding TYPE vector(${dimensions})`);
  await query(
    buildPgvectorIndexStatement({
      documentChunksTable: tableName,
      dimensions,
      hnswEfConstruction: indexParams.hnswEfConstruction,
      hnswM: indexParams.hnswM,
      indexType: indexParams.indexType,
      ivfflatLists: indexParams.ivfflatLists,
    })
  );
};

/**
 * Applies migrations and verifies the active version's table matches its
 * embedding space. Throws with a stable code when it does not: this is the
 * fail-closed boundary the goal asks for, and every read/write below goes
 * through it.
 *
 * Version 1 follows the configuration, exactly like the single table did: an
 * empty table at another width is resized, chunks of another model or width
 * fail closed. A version built by `vector:index` is pinned to its own model
 * and width and is never resized.
 */
// allowForeignEmbeddings is for `vector:reindex --apply` only: it rewrites every
// document it touches under the current embedding identity, so chunks stored
// under another model or task prefix are what it exists to replace. Every
// other caller fails closed on them.
export const ensurePgvectorSchema = async ({
  client = null,
  force = false,
  allowForeignEmbeddings = false,
} = {}) => {
  await ensureActivePgvectorVersion({ allowForeignEmbeddings, client, force });
  return true;
};

const ensureActivePgvectorVersion = async ({
  client = null,
  force = false,
  allowForeignEmbeddings = false,
} = {}) => {
  // Fast path: the pointer (cached for its TTL, then one cheap read) still
  // names the version verified last, under the same embedding space.
  let pendingKey = null;

  if (!force && verified) {
    const snapshot = await readIndexVersionSnapshot();
    const key = getVersionVerificationKey(snapshot.active);

    if (key === verified.key) {
      return snapshot.active;
    }

    pendingKey = key;
  }

  // The check is about the whole table: under a tenant the row policies would
  // hide other tenants' chunks from the emptiness and stored-model checks, and
  // the tenant role may not resize the column. It therefore never borrows a
  // tenant transaction's client and always runs as the owner.
  const verificationClient = getEnforcedDatabaseTenant() ? null : client;
  const verify = () =>
    runAsDatabaseSystem(() => verifyPgvectorSchema({ allowForeignEmbeddings, client: verificationClient }));

  // Shared only on the pool (no caller transaction) and with the same
  // strictness: a caller's transaction client, a forced check and the
  // reindex's foreign-embedding allowance each verify on their own.
  if (force || verificationClient || allowForeignEmbeddings) {
    return verify();
  }

  const flightKey = pendingKey ?? "\u0000initial";
  const inFlight = verificationsInFlight.get(flightKey);

  if (inFlight) {
    return inFlight;
  }

  const verification = verify().finally(() => {
    if (verificationsInFlight.get(flightKey) === verification) {
      verificationsInFlight.delete(flightKey);
    }
  });

  verificationsInFlight.set(flightKey, verification);
  return verification;
};

const verifyPgvectorSchema = async ({ allowForeignEmbeddings = false, client = null } = {}) => {
  const runtime = getPgvectorRuntime();

  if (!runtime.isConfigured()) {
    throw new PgvectorUnavailableError(
      "VECTOR_STORE_PROVIDER=pgvector requires POSTGRES_DATABASE_URL (or LONG_MEMORY_DATABASE_URL). Refusing to fall back to the local index."
    );
  }

  await runtime.runMigrations();

  const query = getPgvectorQuery(client);
  const version = (await readIndexVersionSnapshot({ force: true })).active;
  const space = resolveVersionSpace(version);
  const pinned = version.spaceSource === EMBEDDING_SPACE_SOURCES.pinned;
  const tableName = version.chunkTable;
  const extension = await readExtension({ query });

  verifiedExtensionVersion = extension.version;

  if (!extension.installed) {
    throw new PgvectorUnavailableError(
      "The PostgreSQL `vector` extension is not installed. Use a pgvector-enabled PostgreSQL image (pgvector/pgvector:pg16) or run CREATE EXTENSION vector as a superuser."
    );
  }

  const expectedDimensions = space.dimensions;
  const columnDimensions = await readPgvectorColumnDimensions({ query, tableName });

  if (pinned && columnDimensions === null) {
    throw new PgvectorUnavailableError(
      `The active index version ${version.versionId} names table ${tableName}, which does not exist. Roll back with \`npm run vector:index -- rollback\` or activate another version.`
    );
  }

  if (columnDimensions !== expectedDimensions) {
    const storedModels = await readPgvectorStoredEmbeddingModels({ query, tableName });
    const storedChunkCount = storedModels.reduce((sum, entry) => sum + entry.chunkCount, 0);

    if (pinned || storedChunkCount > 0) {
      throw new PgvectorEmbeddingDimensionError({
        actual: columnDimensions,
        context: `The ${tableName}.embedding column is vector(${columnDimensions}) and already holds ${storedChunkCount} chunk(s)`,
        expected: expectedDimensions,
        model: space.model,
        remedy: pinned ? PINNED_REMEDY : CONFIGURATION_REMEDY,
      });
    }

    await resizeEmbeddingColumn({
      dimensions: expectedDimensions,
      indexParams: resolveVersionIndexParams(version),
      query,
      tableName,
    });
  }

  const storedModels = await readPgvectorStoredEmbeddingModels({ query, tableName });
  const foreignModels = storedModels.filter(
    (entry) =>
      entry.chunkCount > 0 &&
      (entry.model !== space.identity || entry.dimensions !== expectedDimensions)
  );

  if (foreignModels.length > 0 && !allowForeignEmbeddings) {
    throw new PgvectorEmbeddingModelError({
      expected: space,
      remedy: pinned ? PINNED_REMEDY : CONFIGURATION_REMEDY,
      storedModels: foreignModels,
    });
  }

  verified = { key: getVersionVerificationKey(version), version };
  return version;
};

/**
 * The active index version, verified. Tests, the CLI and health use it to
 * name the table and function a search goes to.
 */
export const getActivePgvectorVersion = async ({ force = false } = {}) =>
  ensureActivePgvectorVersion({ force });

// A pointer read just before another instance retired a version can name a
// table that no longer exists; the next pointer read cannot. One retry with a
// fresh pointer, and only outside a caller's transaction (an error there has
// already aborted it).
const withActiveVersionRetry = async (client, operation) => {
  try {
    return await operation();
  } catch (error) {
    if (client || !MISSING_RELATION_CODES.has(error?.code)) {
      throw error;
    }

    invalidateIndexVersionSnapshot();
    verified = null;
    return operation();
  }
};

// Which sparse scoring and pruning the route uses, whether the active
// version's table carries the statistics and search function (migration
// 030), and how many rows its statistics log holds unfolded and how many
// chunks still lack sparse_length (sparse-length-backfill.mjs).
const describeSparseScoring = async ({ query, tableName }) => {
  let options;

  try {
    options = resolvePgvectorSparseScoring();
  } catch (error) {
    return { backend: null, configured: null, message: error.message, searchFunctionInstalled: null };
  }

  const described = {
    backend: getPgvectorSparseBackend(options.scoring),
    commonTermCap: options.commonTermCap,
    configured: options.scoring,
    pruneDfFraction: options.pruneDfFraction,
    searchFunctionInstalled: null,
  };

  try {
    const { termLog } = getPgvectorSparseStatisticsTables(tableName);
    const result = await query(
      `SELECT to_regprocedure($1) IS NOT NULL AS installed,
              CASE WHEN to_regclass($2) IS NULL THEN NULL
                   ELSE (SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass($2)) END AS term_log_rows`,
      [`${getPgvectorSparseSearchFunctionName(tableName)}${PGVECTOR_SPARSE_SEARCH_SIGNATURE}`, termLog]
    );
    const row = result?.rows?.[0] ?? {};

    described.searchFunctionInstalled = row.installed === true;
    described.unfoldedTermLogRowsEstimate = row.term_log_rows === null || row.term_log_rows === undefined
      ? null
      : Math.max(0, Number(row.term_log_rows));
  } catch {
    // Status stays non-throwing; null means "not checked".
  }

  return described;
};

const readSnapshotForStatus = async () => {
  try {
    return await readIndexVersionSnapshot({ force: true });
  } catch {
    return { active: buildLegacyIndexVersion(), registry: "error", versions: [] };
  }
};

/**
 * Non-throwing description of the provider for health and admin status. It
 * describes the active version's whole table, never one tenant's share, so it
 * runs as the owner. Strictly read-only (the reindex dry run relies on it).
 */
export const describePgvectorStatus = async () =>
  runAsDatabaseSystem(() => describePgvectorTableStatus());

const describePgvectorTableStatus = async () => {
  const runtime = getPgvectorRuntime();
  const queryPostgres = runtime.query;
  let version = buildLegacyIndexVersion();
  let space = resolveVersionSpace(version);
  let tableName = version.chunkTable;
  const base = {
    configured: runtime.isConfigured(),
    embedding: {
      columnDimensions: null,
      configuredDimensions: space.dimensions,
      matches: false,
      // The embedding_model value chunks are stored under: the model name,
      // plus the document prefix when one applies (getEmbeddingIndexIdentity).
      model: space.identity,
      storedModels: [],
    },
    extension: { installed: false, version: null },
    indexType: resolveVersionIndexParams(version).indexType,
    // ANN index intent vs. reality. `configured` is the method migrations would
    // build; `actual` is the access method actually on the embedding index (read
    // from pg_am, null when absent); `matches` is true only when both agree.
    // `supported` reflects whether the configured embedding can carry an ANN
    // index at all (<= the pgvector vector-type ceiling) — when false, an absent
    // ANN index is expected fail-closed behaviour, not a partial migration.
    annIndex: {
      configured: resolveVersionIndexParams(version).indexType,
      actual: null,
      present: false,
      matches: false,
      supported: isPgvectorAnnDimensionSupported(space.dimensions),
    },
    annDimensionsSupported: isPgvectorAnnDimensionSupported(space.dimensions),
    indexes: {},
    provider: "pgvector",
    reachable: false,
    table: { exists: false, name: tableName },
    textSearchConfig: resolveVersionIndexParams(version).textSearchConfig,
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

  // The active version decides which table the rest describes.
  const snapshot = await readSnapshotForStatus();

  version = snapshot.active;
  space = resolveVersionSpace(version);
  tableName = version.chunkTable;
  const indexParams = resolveVersionIndexParams(version);

  base.table = { exists: false, name: tableName };
  base.embedding.configuredDimensions = space.dimensions;
  base.embedding.model = space.identity;
  base.indexType = indexParams.indexType;
  base.textSearchConfig = indexParams.textSearchConfig;
  base.annDimensionsSupported = isPgvectorAnnDimensionSupported(space.dimensions);
  base.annIndex = { ...base.annIndex, configured: indexParams.indexType, supported: base.annDimensionsSupported };
  base.activeVersion = {
    chunkTable: tableName,
    sparseRankFunction: version.sparseRankFunction,
    spaceSource: version.spaceSource,
    versionId: version.versionId,
  };

  try {
    // No drift totals here: they scan every live version's table, and health
    // runs every few seconds. The CLI status and the admin route include them.
    base.indexVersions = await describeIndexVersions({ includeDrift: false });
  } catch (error) {
    base.indexVersions = {
      message: error instanceof Error ? error.message : String(error),
      problems: [],
      registry: "error",
      versions: [],
      warnings: [],
    };
  }

  base.extension = await readExtension({ query: queryPostgres });
  base.iterativeScan = {
    configured: getPgvectorIterativeScan(),
    supported: supportsPgvectorIterativeScan(base.extension.version),
  };
  base.table.exists = await tableExists({ query: queryPostgres, tableName });

  if (!base.table.exists) {
    return { ...base, message: `Table ${tableName} does not exist. Run migrations (they run at startup and on health checks).` };
  }

  base.sparseScoring = await describeSparseScoring({ query: queryPostgres, tableName });

  const indexNames = await readIndexNames({ query: queryPostgres, tableName });
  base.indexes = {
    docId: indexNames.has(`${tableName}_doc_id_idx`),
    embedding: indexNames.has(getPgvectorEmbeddingIndexName(tableName)),
    embeddingModel: indexNames.has(`${tableName}_embedding_model_idx`),
    scope: indexNames.has(`${tableName}_scope_idx`),
    searchVector: indexNames.has(`${tableName}_search_vector_idx`),
  };

  const annMethod = await readAnnIndexMethod({ query: queryPostgres, tableName });
  const configuredAnnMethod = indexParams.indexType;
  base.annIndex = {
    configured: configuredAnnMethod,
    actual: annMethod,
    present: annMethod !== null,
    matches: annMethod !== null && annMethod === configuredAnnMethod,
    supported: base.annDimensionsSupported,
  };
  base.embedding.columnDimensions = await readPgvectorColumnDimensions({ query: queryPostgres, tableName });
  base.embedding.storedModels = await readPgvectorStoredEmbeddingModels({ query: queryPostgres, tableName });
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
 * Embeds outside any transaction. The vectors are computed here, once for
 * every embedding space the write will most likely go to (the active version's
 * first, then a version being built or kept for rollback under another model),
 * and then written by writeDocumentsToPgvectorIndex inside whatever
 * transaction the caller opened, so a slow embedding call never holds a
 * database lock.
 */
// `vectorsBySpace` ({ [space.key]: vectors }) carries embeddings the staged
// ingest pipeline computed earlier (rag/ingest-pipeline.js); a space it covers
// is not embedded again.
/**
 * An upload could not embed its chunks in `space`. When no search reads that
 * space (it belongs only to a version being built, a built one not yet
 * activated, or a rollback target in its grace period), those versions are
 * fenced -- marked failed, so they stop taking writes and can never be
 * activated or rolled back to -- and the upload goes on without them: a
 * version nobody serves must not make every upload fail. Resolves to true when
 * the write may skip the space, false when the error must fail the write (the
 * active version is in that space, or the fence did not take).
 */
export const fenceFailedWriteSpace = async ({ error, space }) => {
  try {
    const before = await readIndexVersionSnapshot({ force: true });

    if (isSameDocumentSpace(resolveVersionSpace(before.active), space)) {
      return false;
    }

    const fenced = await fenceNonServingIndexVersions({
      reason: `An upload could not embed its chunks in ${space.identity}/${space.dimensions}: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 2000),
      space,
    });
    const after = await readIndexVersionSnapshot({ force: true });
    const stillWritten = after.versions.some(
      (version) =>
        isIndexVersionWriteTarget(version) && isSameDocumentSpace(resolveVersionSpace(version), space)
    );

    if (stillWritten) {
      return false;
    }

    if (fenced.length > 0) {
      console.warn(
        `[pgvector] index version(s) ${fenced.join(", ")} marked failed: an upload could not embed in their space ${space.identity}/${space.dimensions}. The active version keeps serving; build a new version once the model answers again.`
      );
    }

    return true;
  } catch (fenceError) {
    console.error(`[pgvector] could not fence the index versions in ${space.identity}.`, fenceError);
    return false;
  }
};

export const prepareDocumentsForPgvectorIndex = async ({
  documents,
  spaces = null,
  vectorsBySpace = null,
} = {}) => {
  const safeDocuments = Array.isArray(documents) ? documents : [];

  if (safeDocuments.length === 0) {
    return [];
  }

  const targetSpaces = [];
  // Explicit spaces (the version builder) must all succeed; hinted write
  // targets beyond the active version are best effort (fenceFailedWriteSpace).
  const hinted = !(Array.isArray(spaces) && spaces.length > 0);

  for (const space of hinted ? getHintedWriteSpaces() : spaces) {
    if (!targetSpaces.some((candidate) => isSameDocumentSpace(candidate, space))) {
      targetSpaces.push(space);
    }
  }

  const texts = safeDocuments.map((document) => document.pageContent);
  const vectorsForSpace = new Map();
  const embeddedSpaces = [];

  for (const [spaceIndex, space] of targetSpaces.entries()) {
    const given = vectorsBySpace?.[space.key];

    if (Array.isArray(given) && given.length === safeDocuments.length) {
      given.forEach((vector, index) =>
        assertDimensions({
          actual: Array.isArray(vector) ? vector.length : 0,
          context: `Embedding chunk ${safeDocuments[index].id}`,
          space,
        })
      );
      vectorsForSpace.set(space.key, given);
      embeddedSpaces.push(space);
      continue;
    }

    try {
      vectorsForSpace.set(
        space.key,
        await embedDocumentsInSpace(texts, space, {
          describeItem: (index) => `Embedding chunk ${safeDocuments[index].id}`,
        })
      );
      embeddedSpaces.push(space);
    } catch (error) {
      // The first hinted space is the active version's: its failure fails the write.
      if (!hinted || spaceIndex === 0 || !(await fenceFailedWriteSpace({ error, space }))) {
        throw error;
      }
    }
  }

  if (embeddedSpaces.length === 0) {
    throw new Error("No embedding space of the index could embed the document.");
  }

  const primary = embeddedSpaces[0];

  return safeDocuments.map((document, index) => ({
    id: String(document.id),
    metadata: normalizeMetadata(document.metadata),
    pageContent: String(document.pageContent ?? ""),
    searchText: buildSearchText(document),
    vector: vectorsForSpace.get(primary.key)[index],
    vectorSpaceKey: primary.key,
    vectors: Object.fromEntries(
      embeddedSpaces.map((space) => [space.key, vectorsForSpace.get(space.key)[index]])
    ),
  }));
};

const chunkArray = (values, size) => {
  const batches = [];

  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }

  return batches;
};

// A prepared document carries vectors per space; one prepared by hand (the
// reindex copy path) carries `vector` in the configured space.
const resolveVectorsForSpace = async (preparedDocuments, space) => {
  const configuredKey = getConfiguredEmbeddingSpace().key;
  const vectors = preparedDocuments.map(
    (document) =>
      document.vectors?.[space.key] ??
      ((document.vectorSpaceKey ?? configuredKey) === space.key ? document.vector : null)
  );

  if (vectors.every((vector) => Array.isArray(vector))) {
    vectors.forEach((vector, index) =>
      assertDimensions({ actual: vector.length, context: `Writing chunk ${preparedDocuments[index].id}`, space })
    );
    return vectors;
  }

  // A version registered after this write prepared its embeddings: embed in
  // its space now, inside the transaction. Rare, and correct either way.
  return embedDocumentsInSpace(
    preparedDocuments.map((document) => document.pageContent),
    space,
    { describeItem: (index) => `Embedding chunk ${preparedDocuments[index].id}` }
  );
};

/**
 * Replaces `docIds`' chunks in one version table. Re-ingesting a docId
 * replaces its chunks wholesale: chunk ids embed the docId, but chunk counts
 * can shrink between uploads, so a delete is the only way to drop rows the new
 * chunking no longer produces. The index-version builder writes through here
 * too.
 */
export const replacePgvectorChunks = async ({
  docIds,
  owner = {},
  preparedDocuments,
  query,
  space,
  tableName,
  vectors,
}) => {
  await query(`DELETE FROM ${tableName} WHERE doc_id = ANY($1::text[])`, [docIds]);

  let insertedChunkCount = 0;

  for (const [batchIndex, batch] of chunkArray(preparedDocuments, INSERT_BATCH_SIZE).entries()) {
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
        owner.userId ?? "",
        owner.workspaceId ?? "",
        space.identity,
        space.dimensions,
        toVectorLiteral(vectors[batchIndex * INSERT_BATCH_SIZE + rowIndex])
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

  return insertedChunkCount;
};

// The version tables this transaction writes, keyed by the handle
// beginPgvectorIndexWrite returned (a fresh object per transaction: pooled
// clients are reused, so the client itself cannot be the key).
const writeTargetsByHandle = new WeakMap();

/**
 * First statements of an ingest, delete or clear transaction: the shared
 * version-lifecycle lock and the version tables to write
 * (vector-store-pgvector-versions.js explains why they must come before the
 * transaction's first documents-row lock). Returns the handle the rest of the
 * transaction passes as its client.
 */
export const beginPgvectorIndexWrite = async ({ client }) => {
  if (!client || typeof client.query !== "function") {
    throw new Error("beginPgvectorIndexWrite needs the transaction's client.");
  }

  const targets = await lockIndexVersionWriteTargets(client);
  const handle = { query: (sql, values) => client.query(sql, values) };

  writeTargetsByHandle.set(handle, targets);
  return handle;
};

const withWriteTargets = async (client, callback) => {
  if (client) {
    const targets = writeTargetsByHandle.get(client) ?? (await lockIndexVersionWriteTargets(client));

    return callback(getPgvectorQuery(client), targets);
  }

  return getPgvectorRuntime().withTransaction(async (transactionClient) =>
    callback(getPgvectorQuery(transactionClient), await lockIndexVersionWriteTargets(transactionClient))
  );
};

const toOwnerScope = (accessScope = {}) => ({
  userId: String(accessScope?.userId ?? accessScope?.ownerUserId ?? "").trim(),
  workspaceId: String(accessScope?.workspaceId ?? "").trim(),
});

/**
 * Writes the chunks into every version that must stay complete: the active
 * one and, while they exist, the version being built and the versions kept
 * for activation or rollback. `insertedChunkCount` is the active version's.
 */
export const writeDocumentsToPgvectorIndex = async ({
  accessScope = {},
  client = null,
  preparedDocuments = [],
} = {}) => {
  if (preparedDocuments.length === 0) {
    return { insertedChunkCount: 0, replacedDocIds: [] };
  }

  await ensurePgvectorSchema({ client });

  const docIds = toDocIdArray(preparedDocuments.map((document) => document.metadata.docId));
  const owner = toOwnerScope(accessScope);

  return withWriteTargets(client, async (query, targets) => {
    let insertedChunkCount = null;

    for (const target of targets) {
      const space = resolveVersionSpace(target);
      const count = await replacePgvectorChunks({
        docIds,
        owner,
        preparedDocuments,
        query,
        space,
        tableName: target.chunkTable,
        vectors: await resolveVectorsForSpace(preparedDocuments, space),
      });

      insertedChunkCount ??= count;
    }

    return { insertedChunkCount: insertedChunkCount ?? 0, replacedDocIds: docIds };
  });
};

export const addDocumentsToPgvectorIndex = async ({
  accessScope = {},
  client = null,
  documents,
} = {}) => {
  const preparedDocuments = await prepareDocumentsForPgvectorIndex({ documents });

  return writeDocumentsToPgvectorIndex({ accessScope, client, preparedDocuments });
};

/** Deletes from every write-target version; returns the active version's count. */
export const removeDocumentsFromPgvectorIndex = async ({ client = null, docIds } = {}) => {
  const normalizedDocIds = toDocIdArray(docIds);

  if (normalizedDocIds.length === 0) {
    return 0;
  }

  await ensurePgvectorSchema({ client });

  return withWriteTargets(client, async (query, targets) => {
    let removed = null;

    for (const target of targets) {
      const result = await query(
        `DELETE FROM ${target.chunkTable} WHERE doc_id = ANY($1::text[])`,
        [normalizedDocIds]
      );

      removed ??= result.rowCount ?? 0;
    }

    return removed ?? 0;
  });
};

export const clearPgvectorIndex = async ({ client = null } = {}) => {
  await ensurePgvectorSchema({ client });

  const removed = await withWriteTargets(client, async (query, targets) => {
    let count = null;

    for (const target of targets) {
      const result = await query(`DELETE FROM ${target.chunkTable}`);

      count ??= result.rowCount ?? 0;
    }

    return count ?? 0;
  });

  // A cleared table is the one moment a dimension change is safe; let the next
  // ensure re-check the column instead of trusting the cached verdict.
  verified = null;

  return removed;
};

/** Chunks in the active version (or in `versionId`'s table). */
export const countPgvectorChunks = async ({ client = null, docIds = null, versionId = null } = {}) => {
  const query = getPgvectorQuery(client);
  const snapshot = await readIndexVersionSnapshot();
  const version =
    versionId === null
      ? snapshot.active
      : snapshot.versions.find((candidate) => candidate.versionId === Number(versionId));

  if (!version) {
    throw new Error(`Index version ${versionId} is not live.`);
  }

  const tableName = version.chunkTable;
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

// `scored` (a query-adapter search, rag/query-adapter.js): rows are still
// ordered by $1, and score_vector_score is the cosine with $6, the model's own
// query vector. Unscored statements are unchanged.
const buildDenseSearchSql = (tableName, scored = false) => `
  SELECT chunk_id, doc_id, chunk_index, page_number, section_heading, content, metadata,
         1 - (embedding <=> $1::vector) AS vector_score${
           scored ? ",\n         1 - (embedding <=> $6::vector) AS score_vector_score" : ""
         }
  FROM ${tableName}
  WHERE doc_id = ANY($2::text[])
    AND embedding_model = $3
    AND embedding_dimensions = $4
  ORDER BY embedding <=> $1::vector ASC, chunk_id ASC
  LIMIT $5
`;

// The document filter applies after HNSW returns its ef_search candidates (IVFFlat:
// its probed lists), so
// when the planner sends a filtered query through the index (a document set
// that is a large share of the table) a plain scan can return fewer than
// topK rows. An iterative scan keeps reading the index until LIMIT is met or
// hnsw.max_scan_tuples is reached. relaxed_order may emit rows slightly out of
// distance order; the materialized CTE fixes the order afterwards (pgvector's
// documented pattern; `+ 0` stops PostgreSQL 17+ from reusing the CTE's sort
// order and skipping the outer sort). Exact plans (doc_id btree) are unaffected.
const buildIterativeDenseSearchSql = (tableName, scored = false) => `
  WITH nearest AS MATERIALIZED (
    SELECT chunk_id, doc_id, chunk_index, page_number, section_heading, content, metadata,
           embedding <=> $1::vector AS distance${scored ? ",\n           embedding <=> $6::vector AS score_distance" : ""}
    FROM ${tableName}
    WHERE doc_id = ANY($2::text[])
      AND embedding_model = $3
      AND embedding_dimensions = $4
    ORDER BY embedding <=> $1::vector ASC, chunk_id ASC
    LIMIT $5
  )
  SELECT chunk_id, doc_id, chunk_index, page_number, section_heading, content, metadata,
         1 - distance AS vector_score${scored ? ",\n         1 - score_distance AS score_vector_score" : ""}
  FROM nearest
  ORDER BY distance + 0 ASC, chunk_id ASC
`;

// IVFFlat has its own setting and only a relaxed mode.
const getIterativeScanSetting = (iterativeScan, indexType) =>
  indexType === "ivfflat"
    ? { name: "ivfflat.iterative_scan", value: "relaxed_order" }
    : { name: "hnsw.iterative_scan", value: iterativeScan };

// set_config(..., true) is SET LOCAL: it needs the statement's own transaction.
// A caller's client is already in one; otherwise the setting and the search
// share a short transaction (under a tenant, the same one that sets the role).
const runIterativeDenseSearch = async ({ client, indexType, iterativeScan, scored = false, tableName, values }) => {
  const setting = getIterativeScanSetting(iterativeScan, indexType);
  const search = async (transactionClient) => {
    const query = getPgvectorQuery(transactionClient);

    await query("SELECT set_config($1, $2, true)", [setting.name, setting.value]);
    return query(buildIterativeDenseSearchSql(tableName, scored), values);
  };

  return client ? search(client) : getPgvectorRuntime().withTransaction(search);
};

// `scoreVector` (the query adapter, rag/query-adapter.js): the model's own
// query vector. Rows are ranked by queryVector (the adapted one) while
// vectorScore is the cosine with scoreVector and rankVectorScore the ranking
// cosine. The active version's space is resolved against scoreVector; when it
// has to be embedded again (the version moved to another space meanwhile),
// that vector ranks and scores and the result is unadapted.
export const searchPgvectorDocuments = async ({
  queryVector,
  scoreVector = null,
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

  let scored = false;
  const result = await withActiveVersionRetry(client, async () => {
    const version = await ensureActivePgvectorVersion({ client });
    const space = resolveVersionSpace(version);
    const modelVector = Array.isArray(scoreVector) ? scoreVector : queryVector;
    const vector = await resolveQueryVector({ queryText, queryVector: modelVector, space });
    scored = modelVector === scoreVector && vector === scoreVector;
    const values = [
      toVectorLiteral(scored ? queryVector : vector),
      normalizedDocIds,
      space.identity,
      space.dimensions,
      limit,
      ...(scored ? [toVectorLiteral(scoreVector)] : []),
    ];
    const iterativeScan = getActiveIterativeScan();

    return iterativeScan
      ? runIterativeDenseSearch({
          client,
          indexType: resolveVersionIndexParams(version).indexType,
          iterativeScan,
          scored,
          tableName: version.chunkTable,
          values,
        })
      : getPgvectorQuery(client)(buildDenseSearchSql(version.chunkTable, scored), values);
  });
  const queryTerms = buildTermSet(queryText);

  return result.rows
    .map((row) => {
      const document = rowToDocument(row);
      const rankScore = Number(row.vector_score) || 0;
      const vectorScore = scored ? Number(row.score_vector_score) || 0 : rankScore;
      const keywordScore = buildKeywordScore(queryTerms, document);

      return {
        document,
        score:
          scoringMode === "dense"
            ? rankScore
            : buildCombinedScore(rankScore, keywordScore),
        vectorScore,
        keywordScore,
        ...(scored ? { rankVectorScore: rankScore } : {}),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    );
};

/**
 * Nearest chunk ids in one version table over every document (no document
 * filter), for the activation recall probe. Owner only.
 */
export const searchPgvectorNearestChunkIds = async ({ query, space, tableName, topK, vector }) => {
  const result = await query(
    `/* index_versions:probe_nearest */
      SELECT chunk_id
      FROM ${tableName}
      WHERE embedding_model = $2 AND embedding_dimensions = $3
      ORDER BY embedding <=> $1::vector ASC, chunk_id ASC
      LIMIT $4`,
    [toVectorLiteral(vector), space.identity, space.dimensions, Math.max(1, Math.floor(Number(topK) || 1))]
  );

  return (result?.rows ?? []).map((row) => String(row.chunk_id));
};

const buildSparseSearchSql = (tableName) => `
  SELECT chunk_id, doc_id, chunk_index, page_number, section_heading, content, metadata,
         ts_rank_cd(search_vector, to_tsquery($1::regconfig, $2), 32) AS sparse_score
  FROM ${tableName}
  WHERE doc_id = ANY($3::text[])
    AND search_vector @@ to_tsquery($1::regconfig, $2)
  ORDER BY sparse_score DESC, chunk_id ASC
  LIMIT $4
`;

// The owner-run ranking function from migration 014, named after the table.
// This is version 1's; getActivePgvectorSparseRankFunctionName names the one a
// tenant's search calls now.
export const getPgvectorSparseRankFunctionName = () => `${getPgvectorTableName()}_sparse_rank`;

export const getActivePgvectorSparseRankFunctionName = async () =>
  (await readIndexVersionSnapshot()).active.sparseRankFunction;

/**
 * What checks.rowLevelSecurity probes for the sparse route (migration 030):
 * the four statistics tables of every live version, which carry the tenant
 * policy (and no tenant grant), and the active version's search function,
 * which a tenant calls for every BM25 search and every pruned
 * multi-document search (`searchFunctionUsed`).
 */
export const describePgvectorSparseRowLevelSecurityTargets = async () => {
  const snapshot = await readIndexVersionSnapshot();
  let searchFunctionUsed = true;

  try {
    const options = resolvePgvectorSparseScoring();

    searchFunctionUsed = usesPgvectorSparseSearchFunction({ docCount: 2, options });
  } catch {
    // An invalid RAG_SPARSE_SCORING fails every search anyway; probe the grant.
  }

  return {
    searchFunction: `${getPgvectorSparseSearchFunctionName(snapshot.active.chunkTable)}${PGVECTOR_SPARSE_SEARCH_SIGNATURE}`,
    searchFunctionUsed,
    statisticsTables: [...new Set(snapshot.versions.map((version) => version.chunkTable))].flatMap((chunkTable) =>
      Object.values(getPgvectorSparseStatisticsTables(chunkTable))
    ),
  };
};

/** Chunk tables of every live version (active, building, ready), for health. */
export const listLivePgvectorVersionTables = async () => {
  const snapshot = await readIndexVersionSnapshot();

  return [...new Set(snapshot.versions.map((version) => version.chunkTable))];
};

// Under row-level security the full-text match cannot use the GIN index: @@ is
// not leakproof, so it may only run after the policy conditions, never as an
// index condition, and a large document set was read and decompressed chunk by
// chunk. The function ranks the candidates as the table owner with the indexes.
// It only gets the doc ids the tenant can see in the documents table (a
// primary-key match, leakproof, so still an index lookup under that policy),
// so another tenant's chunks can never take a place under the limit; joining
// its ids back to the chunks table as the tenant keeps the row policy in charge
// of which rows are returned. A single document keeps the plain statement: the
// doc_id index reaches its few rows directly, and the function's call and
// planning cost more (0.76 ms against 1.37 ms p50 as a tenant). From ten
// documents up the function is faster, and far faster for large sets. Every
// index version has its own function over its own table (migration 014's
// template, rendered when the version is created).
const buildTenantSparseSearchSql = (version) => `
  SELECT c.chunk_id, c.doc_id, c.chunk_index, c.page_number, c.section_heading, c.content, c.metadata,
         r.sparse_score
  FROM ${version.sparseRankFunction}(
         to_tsquery($1::regconfig, $2),
         ARRAY(SELECT d.doc_id FROM ${getDocumentsTableName()} d WHERE d.doc_id = ANY($3::text[])),
         $4::integer
       ) AS r
  JOIN ${version.chunkTable} c ON c.chunk_id = r.chunk_id
  ORDER BY r.sparse_score DESC, c.chunk_id ASC
`;

// Migration 030's owner-run search function (rag/vector-store-pgvector-sparse.js):
// BM25, or ts_rank_cd with common-term pruning, over the statistics it keeps.
// One statement for tenant and owner, one document or many: the function
// filters the document ids by the tenant policy itself.
const runSparseSearchFunction = async ({ client, docIds, limit, options, tsQuery }) => {
  const version = await ensureActivePgvectorVersion({ client });

  return getPgvectorQuery(client)(
    buildPgvectorSparseSearchSql({ chunkTable: version.chunkTable }),
    buildPgvectorSparseSearchValues({
      docIds,
      limit,
      options,
      textSearchConfig: resolveVersionIndexParams(version).textSearchConfig,
      tokens: tsQuery.tokens,
      tsQuery: tsQuery.tsQuery,
    })
  );
};

/**
 * The lexical route. `scoring` / `pruneDfFraction` / `commonTermCap` override
 * RAG_SPARSE_SCORING / RAG_SPARSE_PRUNE_DF_FRACTION /
 * RAG_SPARSE_COMMON_TERM_CAP for one call (evaluation arms and the scale
 * benchmark compare them on the same data); `pruneMinChunks` overrides
 * PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS. A result from the search function names
 * its candidate path (`sparseCandidates`).
 */
export const searchPgvectorSparseDocuments = async ({
  queryText = "",
  docIds,
  topK,
  client = null,
  scoring = null,
  pruneDfFraction = undefined,
  pruneMinChunks = undefined,
  commonTermCap = undefined,
} = {}) => {
  const normalizedDocIds = toDocIdArray(docIds);
  const limit = Math.max(1, Math.floor(Number(topK) || 1));
  const tsQuery = buildTsQuery(queryText);

  if (normalizedDocIds.length === 0 || !tsQuery) {
    return [];
  }

  const scoringOptions = resolvePgvectorSparseScoring({ commonTermCap, pruneDfFraction, pruneMinChunks, scoring });

  // ts_rank_cd with normalization 32 maps the cover-density rank into [0, 1)
  // (rank / (rank + 1)) so scores are comparable across queries. It is not
  // BM25 and is never labelled as such. BM25 scores are unbounded; both are
  // ranking-only (admission never reads sparseScore).
  // A missing search function is retried once like a missing table (the
  // pointer may have named a version retired meanwhile); after that the error
  // names its remedy.
  const result = await withActiveVersionRetry(client, async () => {
    if (usesPgvectorSparseSearchFunction({ docCount: normalizedDocIds.length, options: scoringOptions })) {
      return runSparseSearchFunction({
        client,
        docIds: normalizedDocIds,
        limit,
        options: scoringOptions,
        tsQuery,
      });
    }

    const version = await ensureActivePgvectorVersion({ client });

    return getPgvectorQuery(client)(
      getEnforcedDatabaseTenant() && normalizedDocIds.length > 1
        ? buildTenantSparseSearchSql(version)
        : buildSparseSearchSql(version.chunkTable),
      [resolveVersionIndexParams(version).textSearchConfig, tsQuery.tsQuery, normalizedDocIds, limit]
    );
  }).catch((error) => {
    throw toMissingSparseSearchFunctionError(error, "the active index version's table");
  });
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
        ...(row.candidate_mode ? { sparseCandidates: row.candidate_mode } : {}),
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
