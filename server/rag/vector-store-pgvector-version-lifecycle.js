import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chunkDocument } from "./chunker.js";
import {
  getDocumentsPostgresTable,
  getEmbeddingTaskPrefixesForModel,
  getIndexVersionBuildBatchSize,
  getIndexVersionBuildConcurrency,
  getIndexVersionBuildLeaseMs,
  getIndexVersionDualWriteGraceMs,
  getIndexVersionPointerTtlMs,
  getIndexVersionRetireDropAttempts,
  getIndexVersionRetireLockTimeoutMs,
  getIndexVersionRetireRetryDelayMs,
  getKnownEmbeddingDimensionsForModel,
  getVectorStoreProviderConfigStatus,
  isRagIngestEmbedBatchingEnabled,
} from "./config.js";
import {
  assertIndexVersionChunkTableName,
  assertPgvectorAnnDimensionsSupported,
  renderIndexVersionChunkTableDdl,
  renderIndexVersionDropDdl,
} from "./db-migrations.js";
import { buildPublicFilePath } from "./document-utils.js";
import { getDefaultEmbeddingBatcher } from "./ingest-embedding-batcher.js";
import { loadPdfPages } from "./pdf-loader.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";
import {
  PGVECTOR_ERROR_CODES,
  PgvectorUnavailableError,
  embedDocumentsInSpace,
  embedQueryInSpace,
  prepareDocumentsForPgvectorIndex,
  readPgvectorColumnDimensions,
  readPgvectorStoredEmbeddingModels,
  replacePgvectorChunks,
  searchPgvectorNearestChunkIds,
} from "./vector-store-pgvector.js";
import { getPgvectorQuery, getPgvectorRuntime } from "./vector-store-pgvector-runtime.js";
import { stampChunkDocumentVersion } from "./vector-store.js";
import {
  EMBEDDING_SPACE_SOURCES,
  INDEX_VERSION_ERROR_CODES,
  INDEX_VERSION_STATUSES,
  IndexVersionError,
  buildEmbeddingSpace,
  getConfiguredEmbeddingSpace,
  getConfiguredIndexParams,
  getEffectiveDualWriteGraceMs,
  getIndexVersionTableNames,
  getLifecyclePointerTtlMs,
  getPgvectorBaseTableName,
  invalidateIndexVersionSnapshot,
  lockIndexVersionLifecycle,
  normalizeIndexParams,
  readIndexVersionSnapshot,
  resolveVersionSpace,
  toIndexVersion,
} from "./vector-store-pgvector-versions.js";

// Building, validating, activating, rolling back and retiring pgvector index
// versions (`npm run vector:index`). The registry, the pointer cache and the
// write/lifecycle lock protocol live in vector-store-pgvector-versions.js.
//
// A build re-embeds every registered document from the PDF bytes the registry
// stores into the version's own table, several documents in flight at once
// (RAG_INDEX_VERSION_BUILD_CONCURRENCY) and their chunks embedded through the
// cross-document batcher of the staged ingest. RAG_LLM_MAX_CONCURRENCY caps the
// build's embedding requests; only when the cap is below the documents in
// flight do the documents it holds back leave merged into one request (at the
// defaults, 4 in flight under a cap of 8, every document leaves alone).
// RAG_INGEST_EMBED_BATCHING=false, the staged ingest's kill switch, turns the
// merging off for builds too: one request per document.
//
// Each document is written in its own transaction together with its progress
// row, and only if the document row it read is still the current one (checked
// under FOR SHARE: a concurrent re-ingest, replacement or delete -- each takes
// the document row before any chunk row, rag/index.js -- either waits for the
// builder or wins outright). The lease is renewed after the chunk writes, as
// the statement before the progress row: an UPDATE of the version row WHERE
// builder_id and status = 'building', so a transaction whose lease was lost or
// whose version was fenced meanwhile still rolls back, while the version row
// is held only from there to COMMIT. Chunk writes of different documents
// therefore never queue on it, and neither does a fence or a claim waiting
// for it. Order in a document transaction: document row, chunk rows, version
// row, progress row -- the version row before the progress rows, as retire
// takes them. Retire stops a build before it locks the version row (see
// retireIndexVersion), so no builder is ever left waiting for a row retire
// holds while it waits for the writers.
//
// A crashed builder leaves the version `building`; once its lease has expired
// `resume` continues with the documents that have no progress row. While the
// build runs, every ingest, delete and clear writes the building version too,
// so the snapshot the builder works from never misses a change.

const DDL_LOCK_TIMEOUT = "10s";
const PROBE_TEXT_LIMIT = 1000;
const MAX_REPORTED_MISMATCHES = 20;
// Retiring drops a table whose foreign key points at the documents table, and
// dropping it needs an AccessExclusiveLock on documents. A queued request for
// that lock blocks every later reader of documents, so each try waits only a
// short lock_timeout before it gives the lock queue back, and the drop is
// retried (RAG_INDEX_VERSION_RETIRE_*).
const LOCK_NOT_AVAILABLE = "55P03";
// What a new version's model is asked to embed before any DDL.
const CREATION_PROBE_TEXT = "Index version creation probe.";

const noop = () => {};

class DocumentSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentSourceError";
  }
}

const getDocumentsTableName = () => {
  const tableName = getDocumentsPostgresTable();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(
      `DOCUMENTS_POSTGRES_TABLE must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const firstRow = (result) => (Array.isArray(result?.rows) ? result.rows[0] ?? null : null);

export const assertIndexVersionsSupported = () => {
  const status = getVectorStoreProviderConfigStatus();

  if (!status.valid || status.provider !== "pgvector") {
    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.unsupportedProvider,
      `Index versions are a pgvector feature, but VECTOR_STORE_PROVIDER resolves to "${
        status.rawValue || status.provider
      }". The local and Qdrant providers keep one index that vector:reindex rewrites in place.`
    );
  }
};

// Lifecycle commands need the registry (migrations), not a verified active
// version: a builder may run with another embedding configuration than the
// API instances, and building must stay possible while the active version is
// being investigated.
const ensureRegistryReady = async () => {
  const runtime = getPgvectorRuntime();

  if (!runtime.isConfigured()) {
    throw new PgvectorUnavailableError(
      "Index versions need POSTGRES_DATABASE_URL (or LONG_MEMORY_DATABASE_URL)."
    );
  }

  await runtime.runMigrations();
};

export const createDefaultBuilderId = () =>
  `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const toPositiveInteger = (value, fallback) => {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * The embedding space of a new version: the configured one unless a model,
 * width or prefix is given. Another model gets its documented task prefixes
 * and its known width; an unknown model needs --dimensions.
 */
export const resolveBuildEmbeddingSpace = ({
  dimensions = null,
  documentPrefix = null,
  model = null,
  queryPrefix = null,
} = {}) => {
  const configured = getConfiguredEmbeddingSpace();
  const requestedModel = String(model ?? "").trim();
  const sameModel = !requestedModel || requestedModel === configured.model;
  const prefixes = sameModel
    ? { document: configured.documentPrefix, query: configured.queryPrefix }
    : getEmbeddingTaskPrefixesForModel(requestedModel);
  const width =
    dimensions === null || dimensions === undefined || dimensions === ""
      ? sameModel
        ? configured.dimensions
        : getKnownEmbeddingDimensionsForModel(requestedModel)
      : Number(dimensions);

  if (!Number.isInteger(width) || width <= 0) {
    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.invalidState,
      `The width of ${requestedModel || configured.model} is not known; pass --dimensions.`
    );
  }

  return buildEmbeddingSpace({
    dimensions: width,
    documentPrefix: documentPrefix ?? prefixes.document,
    model: sameModel ? configured.model : requestedModel,
    queryPrefix: queryPrefix ?? prefixes.query,
  });
};

const readVersionRow = async (query, versionId, { lock = false } = {}) => {
  const { versionsTable } = getIndexVersionTableNames();
  const result = await query(
    `/* index_versions:read_version */
      SELECT v.*,
             (v.dual_write_until IS NULL OR v.dual_write_until > NOW()) AS in_dual_write_window,
             (v.lease_expires_at IS NOT NULL AND v.lease_expires_at <= NOW()) AS lease_expired
      FROM ${versionsTable} v
      WHERE v.version_id = $1${lock ? "\n      FOR UPDATE" : ""}`,
    [versionId]
  );
  const row = firstRow(result);

  return row ? toIndexVersion(row) : null;
};

const requireVersionId = (versionId) => {
  const parsed = Number(versionId);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.notFound,
      `"${versionId}" is not an index version id.`
    );
  }

  return parsed;
};

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Embeds one text in `space` and checks the vector's width. A model the
 * endpoint does not serve, a key it refuses or a --dimensions the model never
 * produces then fails here, with nothing registered, instead of failing every
 * upload that dual-writes the new version.
 */
export const probeEmbeddingSpace = async (space) => {
  try {
    await embedDocumentsInSpace([CREATION_PROBE_TEXT], space, {
      describeItem: () => `Probing ${space.model}`,
    });
  } catch (error) {
    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.invalidState,
      `The embedding model ${space.model} could not embed a probe text at ${space.dimensions} dimensions, so no version was created: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { model: space.model, dimensions: space.dimensions }
    );
  }
};

/**
 * Registers a new `building` version and creates its table, indexes, policy,
 * grant and sparse-rank function in one owner transaction under the exclusive
 * lifecycle lock, so the version becomes a write target in the same commit
 * that makes its table exist. At most one version builds at a time.
 */
export const createIndexVersion = async ({
  builderId = null,
  indexParams = {},
  leaseMs = getIndexVersionBuildLeaseMs(),
  space = getConfiguredEmbeddingSpace(),
} = {}) => {
  assertIndexVersionsSupported();

  const params = normalizeIndexParams(indexParams);

  // Fail closed before any DDL: a >2000-dim vector column cannot carry an ANN index.
  assertPgvectorAnnDimensionsSupported({ dimensions: space.dimensions, indexType: params.indexType });
  await ensureRegistryReady();
  // And before the version becomes a write target every upload embeds in: the
  // model must answer in this process and at the declared width.
  await probeEmbeddingSpace(space);

  const { pointerTable, versionsTable } = getIndexVersionTableNames();
  const version = await runAsDatabaseSystem(() =>
    getPgvectorRuntime().withTransaction(async (client) => {
      const query = getPgvectorQuery(client);

      await query(
        `/* index_versions:lock_pointer */ SELECT active_version_id FROM ${pointerTable} WHERE singleton FOR UPDATE`
      );
      await lockIndexVersionLifecycle(query);

      const building = firstRow(
        await query(
          `/* index_versions:find_building */ SELECT version_id FROM ${versionsTable} WHERE status = 'building'`
        )
      );

      if (building) {
        throw new IndexVersionError(
          INDEX_VERSION_ERROR_CODES.buildInProgress,
          `Index version ${building.version_id} is already building. Resume it with \`npm run vector:index -- resume\` or retire it first; two builds never run at once.`,
          { versionId: Number(building.version_id) }
        );
      }

      const versionId = Number(
        firstRow(
          await query(
            `/* index_versions:next_id */ SELECT COALESCE(MAX(version_id), 0) + 1 AS next_version_id FROM ${versionsTable}`
          )
        )?.next_version_id
      );

      if (!Number.isInteger(versionId) || versionId < 2) {
        throw new IndexVersionError(
          INDEX_VERSION_ERROR_CODES.invalidState,
          "The index version registry holds no version 1; run the migrations first."
        );
      }

      const chunkTable = assertIndexVersionChunkTableName(
        `${getPgvectorBaseTableName()}_v${versionId}`.toLowerCase()
      );
      const sparseRankFunction = `${chunkTable}_sparse_rank`;

      if (
        firstRow(
          await query(`/* index_versions:relation_exists */ SELECT to_regclass($1) AS relation`, [chunkTable])
        )?.relation
      ) {
        throw new IndexVersionError(
          INDEX_VERSION_ERROR_CODES.invalidState,
          `Table ${chunkTable} already exists outside the registry; drop it or restore its registry row before building version ${versionId}.`
        );
      }

      await query("SELECT set_config('lock_timeout', $1, true)", [DDL_LOCK_TIMEOUT]);
      await query(
        await renderIndexVersionChunkTableDdl({
          chunkTable,
          dimensions: space.dimensions,
          indexParams: params,
        })
      );

      const inserted = firstRow(
        await query(
          `/* index_versions:register */
            INSERT INTO ${versionsTable} (
              version_id, status, chunk_table, sparse_rank_function, embedding_space_source,
              embedding_model, embedding_identity, embedding_document_prefix, embedding_query_prefix,
              embedding_dimensions, index_params, builder_id, lease_expires_at, build_started_at
            )
            VALUES (
              $1, 'building', $2, $3, 'pinned', $4, $5, $6, $7, $8, $9::jsonb, $10,
              CASE WHEN $10::text IS NULL THEN NULL
                   ELSE NOW() + ($11::bigint * INTERVAL '1 millisecond') END,
              NOW()
            )
            RETURNING *`,
          [
            versionId,
            chunkTable,
            sparseRankFunction,
            space.model,
            space.identity,
            space.documentPrefix,
            space.queryPrefix,
            space.dimensions,
            JSON.stringify(params),
            builderId,
            toPositiveInteger(leaseMs, getIndexVersionBuildLeaseMs()),
          ]
        )
      );

      return toIndexVersion(inserted ?? {});
    })
  );

  invalidateIndexVersionSnapshot();
  return version;
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Takes the build lease of a `building` version: free, already this
 * builder's, or expired. Anything else means another builder is alive.
 */
export const claimIndexVersionBuild = async ({
  builderId,
  leaseMs = getIndexVersionBuildLeaseMs(),
  versionId,
}) =>
  runAsDatabaseSystem(async () => {
    const query = getPgvectorRuntime().query;
    const { versionsTable } = getIndexVersionTableNames();
    const claimed = firstRow(
      await query(
        `/* index_versions:claim */
          UPDATE ${versionsTable}
             SET builder_id = $2,
                 lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
                 last_error = NULL,
                 updated_at = NOW()
           WHERE version_id = $1
             AND status = 'building'
             AND (builder_id IS NULL OR builder_id = $2 OR lease_expires_at IS NULL OR lease_expires_at <= NOW())
          RETURNING *`,
        [versionId, builderId, toPositiveInteger(leaseMs, getIndexVersionBuildLeaseMs())]
      )
    );

    if (claimed) {
      return toIndexVersion(claimed);
    }

    const version = await readVersionRow(query, versionId);

    if (!version) {
      throw new IndexVersionError(
        INDEX_VERSION_ERROR_CODES.notFound,
        `Index version ${versionId} does not exist.`
      );
    }

    if (version.status !== INDEX_VERSION_STATUSES.building) {
      throw new IndexVersionError(
        INDEX_VERSION_ERROR_CODES.invalidState,
        `Index version ${versionId} is ${version.status}, not building.`
      );
    }

    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.buildInProgress,
      `Index version ${versionId} is being built by ${version.builderId} until ${version.leaseExpiresAt}; two builders never run at once.`,
      { builderId: version.builderId, leaseExpiresAt: version.leaseExpiresAt, versionId }
    );
  });

// Every write of a builder renews its lease and fails when another builder
// has taken the version or it is no longer building (retired, failed). The
// UPDATE holds the version row until the transaction ends, so it runs as late
// as it can: after a document's chunk writes, before its progress row.
const renewLease = async (query, { builderId, leaseMs, versionId }) => {
  const { versionsTable } = getIndexVersionTableNames();
  const renewed = firstRow(
    await query(
      `/* index_versions:renew_lease */
        UPDATE ${versionsTable}
           SET lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'), updated_at = NOW()
         WHERE version_id = $1 AND builder_id = $2 AND status = 'building'
        RETURNING version_id`,
      [versionId, builderId, leaseMs]
    )
  );

  if (!renewed) {
    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.leaseLost,
      `Builder ${builderId} no longer holds index version ${versionId}; another builder or an operator took it over.`,
      { builderId, versionId }
    );
  }
};

const recordProgress = (query, { chunkCount = 0, docId, error = null, outcome, uploadedAt = null, versionId }) => {
  const { buildProgressTable } = getIndexVersionTableNames();

  return query(
    `/* index_versions:progress */
      INSERT INTO ${buildProgressTable} (version_id, doc_id, outcome, chunk_count, source_uploaded_at, error)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (version_id, doc_id) DO UPDATE SET
        outcome = EXCLUDED.outcome,
        chunk_count = EXCLUDED.chunk_count,
        source_uploaded_at = EXCLUDED.source_uploaded_at,
        error = EXCLUDED.error,
        completed_at = NOW()`,
    [versionId, docId, outcome, chunkCount, uploadedAt, error]
  );
};

const inOwnerTransaction = (callback) =>
  runAsDatabaseSystem(() =>
    getPgvectorRuntime().withTransaction(async (client) => callback(getPgvectorQuery(client)))
  );

// A progress row alone (skipped, failed): nothing runs before it, so the
// lease is renewed first.
const recordProgressUnderLease = (lease, progress) =>
  inOwnerTransaction(async (query) => {
    await renewLease(query, lease);
    await recordProgress(query, progress);
  });

const listPendingDocuments = async ({ cursor, limit, versionId }) => {
  const { buildProgressTable } = getIndexVersionTableNames();
  const result = await runAsDatabaseSystem(() =>
    getPgvectorRuntime().query(
      `/* index_versions:pending_documents */
        SELECT d.doc_id
        FROM ${getDocumentsTableName()} d
        WHERE d.doc_id > $2
          AND NOT EXISTS (
            SELECT 1 FROM ${buildProgressTable} p
            WHERE p.version_id = $1 AND p.doc_id = d.doc_id AND p.outcome <> 'failed'
          )
        ORDER BY d.doc_id
        LIMIT $3`,
      [versionId, cursor, limit]
    )
  );

  return (result?.rows ?? []).map((row) => String(row.doc_id));
};

const readDocumentSource = async (docId) =>
  firstRow(
    await runAsDatabaseSystem(() =>
      getPgvectorRuntime().query(
        `/* index_versions:document_source */
          SELECT doc_id, file_name, file_bytes, profile, uploaded_at::text AS uploaded_at, content_version
          FROM ${getDocumentsTableName()}
          WHERE doc_id = $1`,
        [docId]
      )
    )
  );

// What the builder read must still be the document when it writes: a
// re-ingest changes uploaded_at, a replacement (PUT /documents/:docId) keeps it
// and bumps content_version (migration 018).
const toContentToken = (row) => `${String(row?.uploaded_at)}#${Number(row?.content_version ?? 1) || 1}`;

/** The default page loader: the stored PDF bytes through the ingest parser. */
export const loadStoredDocumentPages = async ({ fileBuffer }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "index-version-build-"));
  const filePath = path.join(directory, "document.pdf");

  try {
    await writeFile(filePath, fileBuffer);
    return await loadPdfPages(filePath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const buildDocumentChunks = async ({ loadPages, source }) => {
  const docId = String(source.doc_id);
  const fileBuffer = Buffer.from(source.file_bytes ?? []);

  if (fileBuffer.byteLength === 0) {
    throw new DocumentSourceError(`No PDF bytes are stored for ${docId}.`);
  }

  let pages;

  try {
    pages = await loadPages({ docId, fileBuffer, fileName: String(source.file_name ?? "") });
  } catch (error) {
    throw new DocumentSourceError(
      `Parsing the stored PDF of ${docId} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const chunks = chunkDocument({
    docId,
    fileName: String(source.file_name ?? ""),
    pages,
    publicFilePath: buildPublicFilePath(docId),
    source: source.profile?.source ?? null,
  });

  if (chunks.length === 0) {
    throw new DocumentSourceError(`No extractable text was found in the stored PDF of ${docId}.`);
  }

  // Stamped like an ingest stamps them (rag/index.js commitDocument).
  const documentVersion = Number(source.content_version ?? 1) || 1;

  return chunks.map((chunk) => ({
    id: chunk.id,
    metadata: stampChunkDocumentVersion(chunk.metadata, documentVersion),
    pageContent: chunk.pageContent,
  }));
};

const writeVersionDocument = ({ contentToken, docId, lease, prepared, space, uploadedAt, version }) =>
  inOwnerTransaction(async (query) => {
    // FOR SHARE: a concurrent re-ingest, replacement or delete of this
    // document waits for this transaction (each of them locks the document row
    // before any chunk row), and its own dual write then lands after these
    // rows.
    const current = firstRow(
      await query(
        `/* index_versions:lock_document */
          SELECT uploaded_at::text AS uploaded_at, content_version, owner_user_id, workspace_id
          FROM ${getDocumentsTableName()}
          WHERE doc_id = $1
          FOR SHARE`,
        [docId]
      )
    );

    if (!current) {
      await renewLease(query, lease);
      await recordProgress(query, { docId, outcome: "skipped_deleted", versionId: version.versionId });
      return "skipped_deleted";
    }

    if (toContentToken(current) !== contentToken) {
      // Re-ingested or replaced since it was read: that write reached this
      // version itself. Read it again rather than write stale chunks.
      return "changed";
    }

    const chunkCount = await replacePgvectorChunks({
      docIds: [docId],
      owner: {
        userId: String(current.owner_user_id ?? ""),
        workspaceId: String(current.workspace_id ?? ""),
      },
      preparedDocuments: prepared,
      query,
      space,
      tableName: version.chunkTable,
      vectors: prepared.map((document) => document.vectors[space.key]),
    });

    // The fence, after the chunk writes: a lost lease or a version fenced
    // meanwhile rolls all of this back, and the version row is held only
    // from here to COMMIT (see the header).
    await renewLease(query, lease);
    await recordProgress(query, {
      chunkCount,
      docId,
      outcome: "indexed",
      uploadedAt,
      versionId: version.versionId,
    });
    return "indexed";
  });

/**
 * The build's default embedding path: this process's cross-document batcher
 * (rag/ingest-embedding-batcher.js), or, with RAG_INGEST_EMBED_BATCHING=false
 * (the staged ingest's kill switch), a pass-through that sends each
 * document's texts as its own request, as the ingest pipeline's
 * embedUnbatched does. Both reach the store's width-checked embedding.
 */
export const resolveBuildEmbeddingBatcher = () =>
  isRagIngestEmbedBatchingEnabled()
    ? getDefaultEmbeddingBatcher()
    : { embed: (texts, space) => embedDocumentsInSpace(texts, space) };

// The chunks' vectors in the version's space through `batcher`. Through the
// cross-document batcher, with a free slot under RAG_LLM_MAX_CONCURRENCY a
// document's texts leave at once, alone; only the documents that find every
// slot busy go out together when one frees. Every vector is width-checked.
const prepareVersionChunks = async ({ batcher, documents, space }) => {
  const vectors = await batcher.embed(
    documents.map((document) => document.pageContent),
    space
  );

  return prepareDocumentsForPgvectorIndex({
    documents,
    spaces: [space],
    vectorsBySpace: { [space.key]: vectors },
  });
};

const buildOneDocument = async ({ batcher, docId, hooks, lease, loadPages, maxAttempts, space, version }) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const source = await readDocumentSource(docId);

    if (!source) {
      await recordProgressUnderLease(lease, { docId, outcome: "skipped_deleted", versionId: version.versionId });
      return "skipped_deleted";
    }

    let documents;

    try {
      documents = await buildDocumentChunks({ loadPages, source });
    } catch (error) {
      if (!(error instanceof DocumentSourceError)) {
        throw error;
      }

      await recordProgressUnderLease(lease, {
        docId,
        error: error.message,
        outcome: "failed",
        uploadedAt: source.uploaded_at,
        versionId: version.versionId,
      });
      return "failed";
    }

    const prepared = await prepareVersionChunks({ batcher, documents, space });

    await hooks.beforeDocumentWrite({ attempt, docId, versionId: version.versionId });

    const outcome = await writeVersionDocument({
      contentToken: toContentToken(source),
      docId,
      lease,
      prepared,
      space,
      uploadedAt: source.uploaded_at,
      version,
    });

    if (outcome !== "changed") {
      return outcome;
    }
  }

  await recordProgressUnderLease(lease, {
    docId,
    error: `The document changed during each of ${maxAttempts} attempts.`,
    outcome: "failed",
    versionId: version.versionId,
  });
  return "failed";
};

const refreshBuildCounters = (lease) => {
  const { buildProgressTable, versionsTable } = getIndexVersionTableNames();

  return runAsDatabaseSystem(async () => {
    const query = getPgvectorRuntime().query;
    const updated = firstRow(
      await query(
        `/* index_versions:progress_counters */
          UPDATE ${versionsTable}
             SET build_documents_done = (
                   SELECT COUNT(*) FROM ${buildProgressTable} WHERE version_id = $1 AND outcome <> 'failed'),
                 build_documents_failed = (
                   SELECT COUNT(*) FROM ${buildProgressTable} WHERE version_id = $1 AND outcome = 'failed'),
                 build_documents_total = (SELECT COUNT(*) FROM ${getDocumentsTableName()}),
                 lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
                 updated_at = NOW()
           WHERE version_id = $1 AND builder_id = $2 AND status = 'building'
          RETURNING version_id`,
        [lease.versionId, lease.builderId, lease.leaseMs]
      )
    );

    if (!updated) {
      throw new IndexVersionError(
        INDEX_VERSION_ERROR_CODES.leaseLost,
        `Builder ${lease.builderId} no longer holds index version ${lease.versionId}.`,
        { builderId: lease.builderId, versionId: lease.versionId }
      );
    }
  });
};

const completeIndexVersionBuild = async ({ builderId, version }) => {
  const { buildProgressTable, versionsTable } = getIndexVersionTableNames();
  const completed = firstRow(
    await runAsDatabaseSystem(() =>
      getPgvectorRuntime().query(
        `/* index_versions:complete_build */
          UPDATE ${versionsTable} v
             SET status = 'ready',
                 build_completed_at = NOW(),
                 builder_id = NULL,
                 lease_expires_at = NULL,
                 dual_write_until = NULL,
                 last_error = NULL,
                 chunk_count = t.chunk_count,
                 document_count = t.document_count,
                 build_documents_done = (
                   SELECT COUNT(*) FROM ${buildProgressTable} WHERE version_id = $1 AND outcome <> 'failed'),
                 build_documents_failed = (
                   SELECT COUNT(*) FROM ${buildProgressTable} WHERE version_id = $1 AND outcome = 'failed'),
                 updated_at = NOW()
            FROM (
              SELECT COUNT(*)::bigint AS chunk_count, COUNT(DISTINCT doc_id)::int AS document_count
              FROM ${version.chunkTable}
            ) t
           WHERE v.version_id = $1 AND v.builder_id = $2 AND v.status = 'building'
          RETURNING v.*`,
        [version.versionId, builderId]
      )
    )
  );

  if (!completed) {
    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.leaseLost,
      `Builder ${builderId} no longer holds index version ${version.versionId}; it was not marked ready.`,
      { builderId, versionId: version.versionId }
    );
  }

  invalidateIndexVersionSnapshot();
  return toIndexVersion(completed);
};

const endBuildAfterError = async ({ builderId, error, failed, versionId }) => {
  const { versionsTable } = getIndexVersionTableNames();

  try {
    await runAsDatabaseSystem(() =>
      getPgvectorRuntime().query(
        `/* index_versions:${failed ? "fail_build" : "release_build"} */
          UPDATE ${versionsTable}
             SET ${failed ? "status = 'failed', " : ""}builder_id = NULL, lease_expires_at = NULL,
                 last_error = $3, updated_at = NOW()
           WHERE version_id = $1 AND builder_id = $2 AND status = 'building'`,
        [versionId, builderId, String(error instanceof Error ? error.message : error).slice(0, 2000)]
      )
    );
  } catch (releaseError) {
    console.error(`Failed to record the end of the build of index version ${versionId}.`, releaseError);
  }

  invalidateIndexVersionSnapshot();
};

// A version whose embeddings never have its declared width can never finish.
const isFatalBuildError = (error) => error?.code === PGVECTOR_ERROR_CODES.dimensionMismatch;

/**
 * Runs `processDocument` over the pending documents, `concurrency` at a time.
 * Pages of pending doc ids are listed as the workers run out (`listPage`; its
 * cursor only moves forward, so each document is taken once), and a page is
 * finished (`finishPage`: counters, lease, the afterBatch seam) once every one
 * of its documents has settled, pages in listing order. With concurrency 1
 * this is exactly the serial loop: list a page, build its documents one by
 * one, finish it, list the next.
 *
 * The first error stops every worker from taking another document; the
 * documents already in flight settle -- each commits or rolls back its own
 * transaction -- before the error is thrown, so the caller never releases the
 * lease under a write that is still running.
 */
export const runBuildDocuments = async ({ concurrency, finishPage, listPage, processDocument }) => {
  const queue = [];
  const pages = [];
  let exhausted = false;
  let listing = null;
  let failure = null;
  let finishing = Promise.resolve();

  const listNextPage = () => {
    listing ??= (async () => {
      const docIds = await listPage();

      if (docIds.length === 0) {
        exhausted = true;
        return;
      }

      const page = { remaining: docIds.length };

      pages.push(page);
      docIds.forEach((docId) => queue.push({ docId, page }));
    })().finally(() => {
      listing = null;
    });

    return listing;
  };

  const takeNext = async () => {
    while (!failure) {
      if (queue.length > 0) {
        return queue.shift();
      }

      if (exhausted) {
        return null;
      }

      await listNextPage();
    }

    return null;
  };

  // One chain, so pages finish one at a time and in order.
  const finishSettledPages = () => {
    finishing = finishing.then(async () => {
      while (!failure && pages.length > 0 && pages[0].remaining === 0) {
        pages.shift();
        await finishPage();
      }
    });

    return finishing;
  };

  const worker = async () => {
    for (;;) {
      const next = await takeNext();

      if (!next) {
        return;
      }

      await processDocument(next.docId);
      next.page.remaining -= 1;
      await finishSettledPages();
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.floor(Number(concurrency) || 1)) }, () =>
      worker().catch((error) => {
        failure ??= error;
      })
    )
  );

  if (failure) {
    throw failure;
  }
};

/**
 * Builds (or resumes) `versionId`: claims the lease, re-embeds every document
 * without a progress row, `concurrency` documents at a time
 * (RAG_INDEX_VERSION_BUILD_CONCURRENCY) and their embeddings through the
 * cross-document batcher, and marks the version ready. Each document is still
 * written in its own transaction with its progress row, fenced on the lease
 * (renewed after the chunk writes, just before the progress row, so the
 * version row is held only from there to COMMIT and chunk writes of
 * different documents overlap). A lost lease stops the build without touching
 * the version; an embedding width that never matches marks it failed; any
 * other error (the embedding API down, the database gone) releases the lease
 * -- after the documents in flight have settled -- and leaves it `building`
 * for `resume`.
 *
 * `hooks.beforeDocumentWrite` / `afterDocument` / `afterBatch` are test seams;
 * `batcher` ({ embed(texts, space) }) defaults to resolveBuildEmbeddingBatcher:
 * this process's embedding batcher, shared with its ingest workers, unless
 * RAG_INGEST_EMBED_BATCHING=false.
 */
export const runIndexVersionBuild = async ({
  batchSize = getIndexVersionBuildBatchSize(),
  batcher = resolveBuildEmbeddingBatcher(),
  builderId = createDefaultBuilderId(),
  concurrency = getIndexVersionBuildConcurrency(),
  hooks = {},
  leaseMs = getIndexVersionBuildLeaseMs(),
  loadPages = loadStoredDocumentPages,
  logger = null,
  maxAttemptsPerDocument = 3,
  versionId,
} = {}) => {
  assertIndexVersionsSupported();
  await ensureRegistryReady();

  const safeVersionId = requireVersionId(versionId);
  const safeLeaseMs = toPositiveInteger(leaseMs, getIndexVersionBuildLeaseMs());
  const safeBatchSize = toPositiveInteger(batchSize, getIndexVersionBuildBatchSize());
  const safeConcurrency = toPositiveInteger(concurrency, getIndexVersionBuildConcurrency());
  const safeHooks = {
    afterBatch: hooks.afterBatch ?? noop,
    afterDocument: hooks.afterDocument ?? noop,
    beforeDocumentWrite: hooks.beforeDocumentWrite ?? noop,
  };
  const version = await claimIndexVersionBuild({ builderId, leaseMs: safeLeaseMs, versionId: safeVersionId });
  const space = resolveVersionSpace(version);
  const lease = { builderId, leaseMs: safeLeaseMs, versionId: safeVersionId };
  const summary = { builderId, failed: 0, indexed: 0, skippedDeleted: 0, versionId: safeVersionId };
  let cursor = "";

  try {
    await runBuildDocuments({
      concurrency: safeConcurrency,
      finishPage: async () => {
        await refreshBuildCounters(lease);
        logger?.(`version ${safeVersionId}: ${summary.indexed} indexed, ${summary.skippedDeleted} deleted meanwhile, ${summary.failed} failed`);
        await safeHooks.afterBatch({ ...summary });
      },
      listPage: async () => {
        const docIds = await listPendingDocuments({ cursor, limit: safeBatchSize, versionId: safeVersionId });

        cursor = docIds.at(-1) ?? cursor;
        return docIds;
      },
      processDocument: async (docId) => {
        const outcome = await buildOneDocument({
          batcher,
          docId,
          hooks: safeHooks,
          lease,
          loadPages,
          maxAttempts: toPositiveInteger(maxAttemptsPerDocument, 3),
          space,
          version,
        });

        if (outcome === "indexed") {
          summary.indexed += 1;
        } else if (outcome === "skipped_deleted") {
          summary.skippedDeleted += 1;
        } else {
          summary.failed += 1;
        }

        await safeHooks.afterDocument({ docId, outcome, versionId: safeVersionId });
      },
    });

    return { ...summary, version: await completeIndexVersionBuild({ builderId, version }) };
  } catch (error) {
    if (error?.code !== INDEX_VERSION_ERROR_CODES.leaseLost) {
      await endBuildAfterError({
        builderId,
        error,
        failed: isFatalBuildError(error),
        versionId: safeVersionId,
      });
    }

    throw error;
  }
};

/** Creates a version and builds it (`npm run vector:index -- build`). */
export const startIndexVersionBuild = async ({
  builderId = createDefaultBuilderId(),
  indexParams = {},
  leaseMs = getIndexVersionBuildLeaseMs(),
  space = getConfiguredEmbeddingSpace(),
  ...buildOptions
} = {}) => {
  const version = await createIndexVersion({ builderId, indexParams, leaseMs, space });

  return runIndexVersionBuild({ ...buildOptions, builderId, leaseMs, versionId: version.versionId });
};

/** Continues the building version after a crash (`npm run vector:index -- resume`). */
export const resumeIndexVersionBuild = async (options = {}) => {
  assertIndexVersionsSupported();
  await ensureRegistryReady();

  const snapshot = await readIndexVersionSnapshot({ force: true });
  const building = snapshot.versions.find(
    (version) => version.status === INDEX_VERSION_STATUSES.building
  );

  if (!building) {
    throw new IndexVersionError(INDEX_VERSION_ERROR_CODES.notFound, "No index version is building.");
  }

  return runIndexVersionBuild({ ...options, versionId: building.versionId });
};

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

const nearestChunkIds = async ({ query, text, topK, version }) => {
  const space = resolveVersionSpace(version);

  return searchPgvectorNearestChunkIds({
    query,
    space,
    tableName: version.chunkTable,
    topK,
    vector: await embedQueryInSpace(text, space),
  });
};

/**
 * Optional recall probe for the activation gate.
 *
 * `sampleSize` stored chunks of the candidate version are embedded as queries
 * in its own space; recall@K is the share whose own chunk comes back in the
 * top K over the whole table (a broken embedding or index returns noise).
 * `queries` (stored queries, e.g. exported from real traffic or an eval
 * corpus) run against both versions; agreement@K is the share of the active
 * version's top K the candidate also returns. Either must reach `minRecall`.
 */
export const runIndexVersionRecallProbe = async ({
  active,
  minRecall = 0.8,
  queries = [],
  sampleSize = 0,
  target,
  topK = 5,
} = {}) =>
  runAsDatabaseSystem(async () => {
    const query = getPgvectorRuntime().query;
    const safeTopK = toPositiveInteger(topK, 5);
    const report = { minRecall, passed: true, queryAgreement: null, selfRetrieval: null, topK: safeTopK };
    const size = Math.max(0, Math.floor(Number(sampleSize) || 0));

    if (size > 0) {
      const sample = await query(
        `/* index_versions:probe_sample */ SELECT chunk_id, content FROM ${target.chunkTable} ORDER BY random() LIMIT $1`,
        [size]
      );
      const rows = sample?.rows ?? [];
      let hits = 0;

      for (const row of rows) {
        const ids = await nearestChunkIds({
          query,
          text: String(row.content ?? "").slice(0, PROBE_TEXT_LIMIT),
          topK: safeTopK,
          version: target,
        });

        hits += ids.includes(String(row.chunk_id)) ? 1 : 0;
      }

      report.selfRetrieval = {
        hits,
        recall: rows.length > 0 ? hits / rows.length : null,
        sampled: rows.length,
      };

      if (rows.length > 0 && report.selfRetrieval.recall < minRecall) {
        report.passed = false;
      }
    }

    const texts = (Array.isArray(queries) ? queries : [])
      .map((entry) => String(typeof entry === "string" ? entry : entry?.query ?? entry?.question ?? "").trim())
      .filter(Boolean);

    if (texts.length > 0) {
      const agreements = [];

      for (const text of texts) {
        const [activeIds, targetIds] = await Promise.all([
          nearestChunkIds({ query, text, topK: safeTopK, version: active }),
          nearestChunkIds({ query, text, topK: safeTopK, version: target }),
        ]);

        agreements.push(
          activeIds.length === 0
            ? 1
            : targetIds.filter((id) => activeIds.includes(id)).length / activeIds.length
        );
      }

      const meanAgreement = agreements.reduce((sum, value) => sum + value, 0) / agreements.length;

      report.queryAgreement = {
        meanAgreement,
        minAgreement: Math.min(...agreements),
        queries: agreements.length,
      };

      if (meanAgreement < minRecall) {
        report.passed = false;
      }
    }

    return report;
  });

const relationExists = async (query, relation) =>
  Boolean(
    firstRow(
      await query(`/* index_versions:relation_exists */ SELECT to_regclass($1) AS relation`, [relation])
    )?.relation
  );

// Every chunk carries the content version of the document it was cut from
// (metadata.documentVersion; chunks from before migration 018 carry none and
// are version 1). A version whose chunks of a document name another version
// than the registry holds stale (or foreign) content even when the chunk count
// matches: a replacement it missed, e.g. one an instance running older code
// wrote to the active version only.
const DOCUMENT_VERSION_OF_CHUNK_SQL = `CASE
    WHEN metadata->>'documentVersion' ~ '^[0-9]{1,9}$' THEN (metadata->>'documentVersion')::bigint
    WHEN metadata ? 'documentVersion' THEN -1
    ELSE 1
  END`;

const buildContentDriftSql = ({ targetTable }) => `/* index_versions:content_drift */
  SELECT t.doc_id, t.min_version, t.max_version, d.content_version
  FROM (
    SELECT doc_id,
           MIN(${DOCUMENT_VERSION_OF_CHUNK_SQL}) AS min_version,
           MAX(${DOCUMENT_VERSION_OF_CHUNK_SQL}) AS max_version
    FROM ${targetTable}
    GROUP BY doc_id
  ) t
  JOIN ${getDocumentsTableName()} d ON d.doc_id = t.doc_id
  WHERE t.min_version <> d.content_version OR t.max_version <> d.content_version
  ORDER BY t.doc_id`;

const buildCountDriftSql = ({ activeTable, targetTable }) => `/* index_versions:count_drift */
  WITH a AS (SELECT doc_id, COUNT(*)::int AS n FROM ${activeTable} GROUP BY doc_id),
       t AS (SELECT doc_id, COUNT(*)::int AS n FROM ${targetTable} GROUP BY doc_id)
  SELECT d.doc_id, COALESCE(a.n, 0) AS active_count, COALESCE(t.n, 0) AS target_count
  FROM ${getDocumentsTableName()} d
  LEFT JOIN a ON a.doc_id = d.doc_id
  LEFT JOIN t ON t.doc_id = d.doc_id
  WHERE COALESCE(a.n, 0) <> COALESCE(t.n, 0)
  ORDER BY d.doc_id`;

const formatSpace = (space) => `${space.identity}/${space.dimensions}`;

/**
 * The activation gate, read-only. A candidate passes when it is ready and
 * still receiving writes, its table has its declared width and only its own
 * embedding identity, every registered document has as many chunks in it as
 * in the active version (`allowChunkCountDrift`: at least one wherever the
 * active version has some, for a rebuild under another chunking), every one of
 * its chunks names the content version the registry holds for its document,
 * and the optional recall probe reaches its minimum. The per-document
 * comparison is one statement, so it sees one snapshot of both tables; dual
 * writes keep them equal from then until the switch.
 *
 * `allowUnreadableActive` is for the case the active version's table is gone
 * (a manual DROP, a partial restore): the comparisons with the active version
 * are skipped and the candidate is judged on its own checks, so a rollback is
 * still possible. Without it such a gate refuses and says so.
 */
export const validateIndexVersion = async ({
  allowChunkCountDrift = false,
  allowUnreadableActive = false,
  probe = null,
  versionId,
} = {}) =>
  runAsDatabaseSystem(async () => {
    assertIndexVersionsSupported();
    await ensureRegistryReady();

    const safeVersionId = requireVersionId(versionId);
    const query = getPgvectorRuntime().query;
    const active = (await readIndexVersionSnapshot({ force: true })).active;
    const target = await readVersionRow(query, safeVersionId);

    if (!target) {
      throw new IndexVersionError(
        INDEX_VERSION_ERROR_CODES.notFound,
        `Index version ${safeVersionId} does not exist.`
      );
    }

    const report = {
      activeReadable: null,
      activeVersionId: active.versionId,
      allowChunkCountDrift: Boolean(allowChunkCountDrift),
      mismatchedDocuments: 0,
      mismatches: [],
      ok: false,
      probe: null,
      reasons: [],
      staleDocuments: 0,
      stale: [],
      totals: null,
      versionId: safeVersionId,
    };

    if (target.versionId === active.versionId) {
      report.reasons.push(`Version ${safeVersionId} is already active.`);
    } else if (target.status !== INDEX_VERSION_STATUSES.ready) {
      report.reasons.push(
        `Version ${safeVersionId} is ${target.status}; only a ready version can be activated.`
      );
    } else if (target.inDualWriteWindow === false) {
      report.reasons.push(
        `Version ${safeVersionId} stopped receiving writes at ${target.dualWriteUntil} and may miss later changes; build a new version instead.`
      );
    }

    if (report.reasons.length > 0) {
      return report;
    }

    const activeReadable = await relationExists(query, active.chunkTable);

    report.activeReadable = activeReadable;

    if (!activeReadable && !allowUnreadableActive) {
      report.reasons.push(
        `The active version ${active.versionId}'s table ${active.chunkTable} does not exist, so version ${safeVersionId} cannot be compared with it document by document. To switch to version ${safeVersionId} on its own checks (status, write window, width, embedding identity, content versions), pass --active-unreadable.`
      );
    }

    const targetSpace = resolveVersionSpace(target);
    const columnDimensions = await readPgvectorColumnDimensions({ query, tableName: target.chunkTable });

    if (columnDimensions !== targetSpace.dimensions) {
      report.reasons.push(
        `Table ${target.chunkTable} is vector(${columnDimensions}), not the vector(${targetSpace.dimensions}) version ${safeVersionId} was registered with.`
      );
    }

    const foreign = (await readPgvectorStoredEmbeddingModels({ query, tableName: target.chunkTable })).filter(
      (entry) =>
        entry.chunkCount > 0 &&
        (entry.model !== targetSpace.identity || entry.dimensions !== targetSpace.dimensions)
    );

    if (foreign.length > 0) {
      report.reasons.push(
        `Version ${safeVersionId} holds chunks embedded as ${foreign
          .map((entry) => `${entry.model}/${entry.dimensions}`)
          .join(", ")}, not ${formatSpace(targetSpace)}.`
      );
    }

    // The switch pins a configuration-following active version to the space
    // it was verified under; that must be the space its rows really hold.
    if (activeReadable && active.spaceSource === EMBEDDING_SPACE_SOURCES.configuration) {
      const configured = getConfiguredEmbeddingSpace();
      const activeForeign = (
        await readPgvectorStoredEmbeddingModels({ query, tableName: active.chunkTable })
      ).filter(
        (entry) =>
          entry.chunkCount > 0 &&
          (entry.model !== configured.identity || entry.dimensions !== configured.dimensions)
      );

      if (activeForeign.length > 0) {
        report.reasons.push(
          `The active version ${active.versionId} follows the configuration, which in this process names ${formatSpace(configured)}, but its chunks were embedded as ${activeForeign
            .map((entry) => `${entry.model}/${entry.dimensions}`)
            .join(", ")}. Activate with the embedding configuration the API instances serve with, so the switch pins version ${active.versionId} correctly.`
        );
      }
    }

    const mismatches = activeReadable
      ? (
          (await query(buildCountDriftSql({ activeTable: active.chunkTable, targetTable: target.chunkTable })))
            ?.rows ?? []
        ).map((row) => ({
          activeCount: Number(row.active_count) || 0,
          docId: String(row.doc_id),
          targetCount: Number(row.target_count) || 0,
        }))
      : [];
    const blocking = allowChunkCountDrift
      ? mismatches.filter((entry) => entry.activeCount > 0 && entry.targetCount === 0)
      : mismatches;

    report.mismatchedDocuments = activeReadable ? mismatches.length : null;
    report.mismatches = mismatches.slice(0, MAX_REPORTED_MISMATCHES);

    const stale = ((await query(buildContentDriftSql({ targetTable: target.chunkTable })))?.rows ?? []).map(
      (row) => ({
        docId: String(row.doc_id),
        maxVersion: Number(row.max_version),
        minVersion: Number(row.min_version),
        registryVersion: Number(row.content_version),
      })
    );

    report.staleDocuments = stale.length;
    report.stale = stale.slice(0, MAX_REPORTED_MISMATCHES);

    if (stale.length > 0) {
      report.reasons.push(
        `${stale.length} document(s) have chunks in version ${safeVersionId} cut from another content version than the registry holds (first: ${stale
          .slice(0, 3)
          .map((entry) =>
            `${entry.docId} ${entry.minVersion === entry.maxVersion ? `v${entry.minVersion}` : `v${entry.minVersion}-v${entry.maxVersion}`}, registry v${entry.registryVersion}`
          )
          .join("; ")}); a replacement never reached it. Rebuild the version, and finish any rolling upgrade before building.`
      );
    }

    if (blocking.length > 0) {
      report.reasons.push(
        `${blocking.length} document(s) ${
          allowChunkCountDrift
            ? `have no chunks in version ${safeVersionId} although the active version ${active.versionId} has some`
            : `have a different chunk count in version ${safeVersionId} than in the active version ${active.versionId}`
        } (first: ${blocking
          .slice(0, 3)
          .map((entry) => `${entry.docId} ${entry.activeCount}->${entry.targetCount}`)
          .join(", ")}).`
      );
    }

    const totals = firstRow(
      await query(
        `/* index_versions:count_totals */
          SELECT (SELECT COUNT(*) FROM ${getDocumentsTableName()})::bigint AS document_count,
                 ${activeReadable ? `(SELECT COUNT(*) FROM ${active.chunkTable})::bigint` : "NULL::bigint"} AS active_chunks,
                 (SELECT COUNT(*) FROM ${target.chunkTable})::bigint AS target_chunks`
      )
    );

    report.totals = {
      activeChunks: activeReadable ? Number(totals?.active_chunks) || 0 : null,
      documents: Number(totals?.document_count) || 0,
      targetChunks: Number(totals?.target_chunks) || 0,
    };

    if (probe && (Number(probe.sampleSize) > 0 || (Array.isArray(probe.queries) && probe.queries.length > 0))) {
      // Agreement needs the active version's table; self-retrieval does not.
      report.probe = await runIndexVersionRecallProbe({
        ...probe,
        active,
        queries: activeReadable ? probe.queries : [],
        target,
      });

      if (!report.probe.passed) {
        report.reasons.push(
          `The recall probe stayed below ${report.probe.minRecall} (self-retrieval ${
            report.probe.selfRetrieval?.recall ?? "n/a"
          }, agreement with the active version ${report.probe.queryAgreement?.meanAgreement ?? "n/a"}).`
        );
      }
    }

    report.ok = report.reasons.length === 0;
    return report;
  });

// ---------------------------------------------------------------------------
// Switch, rollback, retire
// ---------------------------------------------------------------------------

// The pointer row, locked, with the TTL bound migration 019 records (null on
// a registry that predates it).
const lockPointer = async (query) => {
  const { pointerTable } = getIndexVersionTableNames();

  return firstRow(
    await query(
      `/* index_versions:lock_pointer */
        SELECT active_version_id, (to_jsonb(p) ->> 'pointer_ttl_ms') AS pointer_ttl_ms
        FROM ${pointerTable} p WHERE singleton FOR UPDATE`
    )
  );
};

/**
 * Validates `versionId` and then switches the pointer to it in one owner
 * transaction under the exclusive lifecycle lock. The previous version stays a
 * write target for the grace period (never less than twice the longest
 * pointer TTL an instance may use); a previous version that followed the
 * configuration is pinned to it first. Every API process picks the switch up
 * within the pointer TTL. With `allowUnreadableActive` and the active table
 * gone, the previous version is marked failed instead: it can take no write.
 */
export const activateIndexVersion = async ({
  allowChunkCountDrift = false,
  allowUnreadableActive = false,
  graceMs = getIndexVersionDualWriteGraceMs(),
  mode = "activate",
  probe = null,
  versionId,
} = {}) => {
  const safeVersionId = requireVersionId(versionId);
  const validation = await validateIndexVersion({
    allowChunkCountDrift,
    allowUnreadableActive,
    probe,
    versionId: safeVersionId,
  });

  if (!validation.ok) {
    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.validationFailed,
      `Index version ${safeVersionId} did not pass the activation gate: ${validation.reasons.join(" ")}`,
      { validation }
    );
  }

  const configured = getConfiguredEmbeddingSpace();
  const configuredParams = getConfiguredIndexParams();
  const { pointerTable, versionsTable } = getIndexVersionTableNames();
  const previousUnreadable = validation.activeReadable === false;
  const switched = await runAsDatabaseSystem(() =>
    getPgvectorRuntime().withTransaction(async (client) => {
      const query = getPgvectorQuery(client);
      const pointer = await lockPointer(query);
      const previousId = Number(pointer?.active_version_id);
      const effectiveGraceMs = getEffectiveDualWriteGraceMs(graceMs, {
        registryPointerTtlMs: pointer?.pointer_ttl_ms,
      });

      if (previousId !== validation.activeVersionId) {
        throw new IndexVersionError(
          INDEX_VERSION_ERROR_CODES.invalidState,
          `The active version changed to ${pointer?.active_version_id ?? "none"} while version ${safeVersionId} was validated; run the activation again.`
        );
      }

      await query(
        `/* index_versions:lock_versions */
          SELECT version_id FROM ${versionsTable} WHERE version_id = ANY($1::int[]) ORDER BY version_id FOR UPDATE`,
        [[previousId, safeVersionId]]
      );
      await lockIndexVersionLifecycle(query);

      // clock_timestamp(), not NOW(): the window must still be open now that the
      // lock is held, whenever this transaction started.
      const target = firstRow(
        await query(
          `/* index_versions:switch_state */
            SELECT status, (dual_write_until IS NULL OR dual_write_until > clock_timestamp()) AS writable
            FROM ${versionsTable} WHERE version_id = $1`,
          [safeVersionId]
        )
      );

      if (target?.status !== INDEX_VERSION_STATUSES.ready || target?.writable !== true) {
        throw new IndexVersionError(
          INDEX_VERSION_ERROR_CODES.invalidState,
          `Index version ${safeVersionId} is no longer a ready version inside its write window.`
        );
      }

      const previous = await readVersionRow(query, previousId);

      if (!previousUnreadable && previous?.spaceSource === EMBEDDING_SPACE_SOURCES.configuration) {
        await query(
          `/* index_versions:pin */
            UPDATE ${versionsTable}
               SET embedding_space_source = 'pinned', embedding_model = $2, embedding_identity = $3,
                   embedding_document_prefix = $4, embedding_query_prefix = $5,
                   embedding_dimensions = $6, index_params = $7::jsonb, updated_at = NOW()
             WHERE version_id = $1`,
          [
            previousId,
            configured.model,
            configured.identity,
            configured.documentPrefix,
            configured.queryPrefix,
            configured.dimensions,
            JSON.stringify(configuredParams),
          ]
        );
      }

      // A previous version whose table is gone must not become a write
      // target (every upload would fail on it): it is failed, not in grace.
      const deactivated = previousUnreadable
        ? firstRow(
            await query(
              `/* index_versions:deactivate_unreadable */
                UPDATE ${versionsTable}
                   SET status = 'failed', deactivated_at = NOW(), dual_write_until = NULL,
                       last_error = $2, updated_at = NOW()
                 WHERE version_id = $1
                RETURNING dual_write_until`,
              [
                previousId,
                `Its table ${validation.activeReadable === false ? "was missing" : "was unreadable"} when version ${safeVersionId} was activated with --active-unreadable.`,
              ]
            )
          )
        : firstRow(
            await query(
              `/* index_versions:deactivate */
                UPDATE ${versionsTable}
                   SET status = 'ready', deactivated_at = NOW(), chunk_count = $3,
                       dual_write_until = clock_timestamp() + ($2::bigint * INTERVAL '1 millisecond'),
                       updated_at = NOW()
                 WHERE version_id = $1
                RETURNING dual_write_until`,
              [previousId, effectiveGraceMs, validation.totals.activeChunks]
            )
          );

      await query(
        `/* index_versions:activate */
          UPDATE ${versionsTable}
             SET status = 'active', activated_at = NOW(), dual_write_until = NULL,
                 chunk_count = $2, updated_at = NOW()
           WHERE version_id = $1`,
        [safeVersionId, validation.totals.targetChunks]
      );

      const updatedPointer = firstRow(
        await query(
          `/* index_versions:switch_pointer */
            UPDATE ${pointerTable}
               SET active_version_id = $1, previous_version_id = $2,
                   generation = generation + 1, switched_at = NOW()
             WHERE singleton
            RETURNING generation, switched_at`,
          [safeVersionId, previousId]
        )
      );

      return {
        activeVersionId: safeVersionId,
        dualWriteGraceMs: previousUnreadable ? 0 : effectiveGraceMs,
        generation: Number(updatedPointer?.generation) || null,
        previousDualWriteUntil:
          deactivated?.dual_write_until instanceof Date
            ? deactivated.dual_write_until.toISOString()
            : deactivated?.dual_write_until ?? null,
        previousFailed: previousUnreadable,
        previousVersionId: previousId,
      };
    })
  );

  invalidateIndexVersionSnapshot();
  return { ...switched, mode, validation };
};

/**
 * Switches back to the version active before the last switch, through the
 * same gate. Refused once that version's dual-write window has closed: it may
 * then miss writes, and only a new build is safe.
 */
export const rollbackIndexVersion = async (options = {}) => {
  assertIndexVersionsSupported();

  const snapshot = await readIndexVersionSnapshot({ force: true });

  if (!snapshot.previousVersionId) {
    throw new IndexVersionError(
      INDEX_VERSION_ERROR_CODES.invalidState,
      "There is no previous index version to roll back to."
    );
  }

  return activateIndexVersion({ ...options, mode: "rollback", versionId: snapshot.previousVersionId });
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Removes a retired version's storage: drops its table and sparse-rank
 * function (version 1's migration-owned table is emptied instead). Each try is
 * its own transaction with a short lock_timeout: the drop needs an
 * AccessExclusiveLock on the documents table (the version table's foreign key
 * triggers live there), and while that request waits in the lock queue every
 * new reader of documents waits behind it. A try that cannot get the lock
 * within `lockTimeoutMs` gives the queue back at once and the next one starts
 * after a pause; readers are held up for at most one timeout per try.
 * Resolves to { dropped, attempts }.
 */
export const dropRetiredIndexVersionStorage = async ({
  attempts = getIndexVersionRetireDropAttempts(),
  chunkTable,
  lockTimeoutMs = getIndexVersionRetireLockTimeoutMs(),
  retryDelayMs = getIndexVersionRetireRetryDelayMs(),
  sparseRankFunction,
}) => {
  const baseTable = getPgvectorBaseTableName().toLowerCase();
  const isBaseTable = String(chunkTable).toLowerCase() === baseTable;
  const maxAttempts = toPositiveInteger(attempts, getIndexVersionRetireDropAttempts());
  const timeout = `${toPositiveInteger(lockTimeoutMs, getIndexVersionRetireLockTimeoutMs())}ms`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runAsDatabaseSystem(() =>
        getPgvectorRuntime().withTransaction(async (client) => {
          const query = getPgvectorQuery(client);

          await query("SELECT set_config('lock_timeout', $1, true)", [timeout]);

          if (isBaseTable) {
            await query(`/* index_versions:empty_base_table */ TRUNCATE ${chunkTable}`);
          } else {
            await query(renderIndexVersionDropDdl({ chunkTable, sparseRankFunction }));
          }
        })
      );

      return { attempts: attempt, dropped: true };
    } catch (error) {
      if (error?.code !== LOCK_NOT_AVAILABLE || attempt >= maxAttempts) {
        if (error?.code === LOCK_NOT_AVAILABLE) {
          return { attempts: attempt, dropped: false };
        }

        throw error;
      }

      // Jittered, so two retries never line up with the same long reader.
      await delay(Math.round(Math.max(0, Number(retryDelayMs) || 0) * (0.5 + Math.random() / 2)));
    }
  }

  return { attempts: maxAttempts, dropped: false };
};

const retiredStorageRemains = async (query, row) => {
  const chunkTable = String(row.chunk_table);

  if (chunkTable.toLowerCase() === getPgvectorBaseTableName().toLowerCase()) {
    return Boolean(
      firstRow(await query(`/* index_versions:base_rows */ SELECT EXISTS (SELECT 1 FROM ${chunkTable}) AS has_rows`))
        ?.has_rows
    );
  }

  return relationExists(query, chunkTable);
};

/**
 * Retires a non-active version in two steps. First, in one short transaction
 * without DDL (under the exclusive lifecycle lock, so no write is still
 * aimed at it): it becomes `retired`, which ends its writes, and its build
 * progress and rollback pointer are forgotten. Then its table and sparse-rank
 * function are dropped by dropRetiredIndexVersionStorage, a short lock
 * attempt at a time. Version 1's table belongs to the migrations (health and
 * migration 014 name it), so retiring version 1 empties it instead.
 *
 * Refused for the active version, for a version deactivated less than two
 * pointer TTLs ago (an instance may still be searching it; the longest TTL any
 * instance may use), and -- unless `force` -- for a version inside its
 * rollback window or one a live builder holds. A build it may abort (--force,
 * or a lease that expired or was released) is first stopped on its own --
 * failed, so every builder transaction in flight fails its lease check --
 * and reported as `previousStatus: "building"`. When the drop could not get
 * its lock within its attempts (`dropped: false`), the version is retired all
 * the same and running retire on it again finishes the drop.
 */
export const retireIndexVersion = async ({
  dropAttempts = getIndexVersionRetireDropAttempts(),
  dropLockTimeoutMs = getIndexVersionRetireLockTimeoutMs(),
  dropRetryDelayMs = getIndexVersionRetireRetryDelayMs(),
  force = false,
  versionId,
} = {}) => {
  assertIndexVersionsSupported();

  const safeVersionId = requireVersionId(versionId);
  const { buildProgressTable, pointerTable, versionsTable } = getIndexVersionTableNames();
  const baseTable = getPgvectorBaseTableName().toLowerCase();
  // A build retire may abort (--force, or one whose lease has expired or was
  // released) is stopped first, in a statement of its own that locks nothing
  // but the version row: it becomes failed, so each builder transaction still
  // in flight fails its lease check without waiting for that row. A builder
  // takes the version row last, after a document row a concurrent write may
  // be waiting for (see the header); left waiting on the row the transaction
  // below holds while that one waits for the writers, the three would
  // deadlock.
  const stoppedBuild = Boolean(
    firstRow(
      await runAsDatabaseSystem(() =>
        getPgvectorRuntime().query(
          `/* index_versions:stop_build */
            UPDATE ${versionsTable}
               SET status = 'failed', builder_id = NULL, lease_expires_at = NULL,
                   last_error = $3, updated_at = NOW()
             WHERE version_id = $1 AND status = 'building'
               AND ($2::boolean OR lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
            RETURNING version_id`,
          [safeVersionId, Boolean(force), "The build was stopped by retire."]
        )
      )
    )
  );

  if (stoppedBuild) {
    invalidateIndexVersionSnapshot();
  }

  const retired = await runAsDatabaseSystem(() =>
    getPgvectorRuntime().withTransaction(async (client) => {
      const query = getPgvectorQuery(client);
      const pointer = await lockPointer(query);
      const row = firstRow(
        await query(
          `/* index_versions:lock_retire */
            SELECT version_id, status, chunk_table, sparse_rank_function, builder_id, lease_expires_at,
                   dual_write_until, deactivated_at,
                   (dual_write_until IS NOT NULL AND dual_write_until > clock_timestamp()) AS in_grace,
                   (deactivated_at IS NOT NULL
                     AND deactivated_at + ($2::bigint * INTERVAL '1 millisecond') > clock_timestamp())
                     AS recently_deactivated,
                   (lease_expires_at IS NOT NULL AND lease_expires_at > clock_timestamp()) AS lease_live
            FROM ${versionsTable}
            WHERE version_id = $1
            FOR UPDATE`,
          [safeVersionId, 2 * getLifecyclePointerTtlMs(pointer?.pointer_ttl_ms)]
        )
      );

      if (!row) {
        throw new IndexVersionError(
          INDEX_VERSION_ERROR_CODES.notFound,
          `Index version ${safeVersionId} does not exist.`
        );
      }

      const refuse = (message) => {
        throw new IndexVersionError(INDEX_VERSION_ERROR_CODES.invalidState, message, {
          versionId: safeVersionId,
        });
      };
      const summary = {
        chunkTable: String(row.chunk_table),
        previousStatus: stoppedBuild ? INDEX_VERSION_STATUSES.building : String(row.status),
        sparseRankFunction: String(row.sparse_rank_function),
        versionId: safeVersionId,
      };

      if (row.status === INDEX_VERSION_STATUSES.retired) {
        // A retire whose drop did not get its lock: finish it.
        if (await retiredStorageRemains(query, row)) {
          return { ...summary, alreadyRetired: true };
        }

        refuse(`Index version ${safeVersionId} is already retired.`);
      }

      if (Number(pointer?.active_version_id) === safeVersionId || row.status === INDEX_VERSION_STATUSES.active) {
        refuse(`Index version ${safeVersionId} is active; activate another version before retiring it.`);
      }

      if (row.recently_deactivated === true) {
        refuse(
          `Index version ${safeVersionId} was deactivated less than two pointer TTLs ago; API instances may still be searching it.`
        );
      }

      if (!force && row.status === INDEX_VERSION_STATUSES.ready && row.in_grace === true) {
        refuse(
          `Index version ${safeVersionId} can still be rolled back to until ${toIsoString(row.dual_write_until)}; pass --force to retire it now.`
        );
      }

      // Every build retire may abort was stopped above; one still building
      // has a live lease and no --force (or its lease ran out only since).
      if (row.status === INDEX_VERSION_STATUSES.building) {
        refuse(
          row.lease_live === true
            ? `Index version ${safeVersionId} is being built by ${row.builder_id}; pass --force to abort the build.`
            : `Index version ${safeVersionId} was still building when retire began; run retire again.`
        );
      }

      // Waits for every write that still has this version among its targets.
      await lockIndexVersionLifecycle(query);
      await query(
        `/* index_versions:retire */
          UPDATE ${versionsTable}
             SET status = 'retired', retired_at = NOW(), builder_id = NULL, lease_expires_at = NULL,
                 dual_write_until = NULL, updated_at = NOW()
           WHERE version_id = $1`,
        [safeVersionId]
      );
      await query(
        `/* index_versions:clear_progress */ DELETE FROM ${buildProgressTable} WHERE version_id = $1`,
        [safeVersionId]
      );
      await query(
        `/* index_versions:clear_previous */
          UPDATE ${pointerTable} SET previous_version_id = NULL
           WHERE singleton AND previous_version_id = $1`,
        [safeVersionId]
      );

      return { ...summary, alreadyRetired: false };
    })
  );

  invalidateIndexVersionSnapshot();

  const drop = await dropRetiredIndexVersionStorage({
    attempts: dropAttempts,
    chunkTable: retired.chunkTable,
    lockTimeoutMs: dropLockTimeoutMs,
    retryDelayMs: dropRetryDelayMs,
    sparseRankFunction: retired.sparseRankFunction,
  });
  const isBase = retired.chunkTable.toLowerCase() === baseTable;

  return {
    chunkTable: retired.chunkTable,
    dropAttempts: drop.attempts,
    dropPending: !drop.dropped,
    droppedTable: drop.dropped && !isBase,
    emptiedTable: drop.dropped && isBase,
    previousStatus: retired.alreadyRetired ? INDEX_VERSION_STATUSES.retired : retired.previousStatus,
    versionId: safeVersionId,
  };
};

const toIsoString = (value) => (value instanceof Date ? value.toISOString() : String(value ?? ""));
