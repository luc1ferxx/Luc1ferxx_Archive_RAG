import {
  buildEmbeddingIndexIdentity,
  getDocumentChunksPostgresTable,
  getEmbeddingDimensions,
  getEmbeddingDocumentPrefix,
  getEmbeddingIndexIdentity,
  getEmbeddingModel,
  getEmbeddingQueryPrefix,
  getIndexVersionDualWriteGraceMs,
  getIndexVersionPointerTtlMs,
  getPgvectorHnswEfConstruction,
  getPgvectorHnswM,
  getPgvectorIndexType,
  getPgvectorIvfflatLists,
  getPgvectorTextSearchConfig,
} from "./config.js";
import { getIndexVersionRegistryTableNames } from "./db-migrations.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";
import {
  getPgvectorQuery,
  getPgvectorRuntime,
  onPgvectorRuntimeReset,
} from "./vector-store-pgvector-runtime.js";

// The registry side of versioned pgvector indexes (migration 016).
//
// A version is one physical chunk table plus its sparse-rank function, built
// under one embedding space (model, task prefixes, width) and one set of index
// parameters. API processes search only the version the pointer names; every
// ingest, delete and clear writes the active version and every other version
// that must stay complete (the one being built, a built one not yet
// activated, and a deactivated one inside its dual-write grace period).
//
// Two protocols keep that exact:
//
// * Write targets. A writer takes a transaction-scoped SHARED advisory lock
//   as the first statement of its transaction and only then reads the target
//   set. Registering a new version, retiring one and switching the pointer take
//   the same lock EXCLUSIVELY. Registration therefore waits for every writer
//   that could have missed the new version, and every later writer sees it --
//   while the builder's document listing starts after the registration
//   committed, so each document is either in that listing or written by a
//   writer that saw the new version. The lock and the read are separate
//   statements on purpose: in READ COMMITTED a statement's snapshot is taken
//   when the statement starts, so a read in the locking statement could predate
//   a registration it waited for.
//
// * Lock order. Lifecycle operations lock the pointer row, then version rows,
//   then the advisory lock, then touch the documents table (DDL). Writers take
//   the advisory lock before their first documents-row lock. The builder locks
//   its version row and then one documents row. No cycle is possible.
//
// Searches read the pointer through a short TTL cache instead of LISTEN/NOTIFY:
// a stale read is harmless because the version it names keeps receiving every
// write for at least the dual-write grace period, which is never shorter than
// twice the TTL, and a retired table is never one a fresh pointer can name. A
// TTL needs no session-mode connection per instance (a transaction-pooling
// proxy breaks LISTEN) and cannot be lost the way a notification can while a
// listener reconnects.
//
// Which TTL: the pointer row records one (pointer_ttl_ms, migration 019, set
// from the configuration of the process that migrated). An instance caches for
// at most the smaller of its own RAG_INDEX_VERSION_POINTER_TTL_MS and that
// value, and the lifecycle (the grace floor, the retire window) assumes the
// larger of its own and that value, so a CLI and API instances configured
// differently still agree. A cache entry expires one TTL after its read
// started, not after it returned, so a slow read never stretches it.

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNDEFINED_TABLE = "42P01";

export const INDEX_VERSION_STATUSES = Object.freeze({
  active: "active",
  building: "building",
  failed: "failed",
  ready: "ready",
  retired: "retired",
});

export const EMBEDDING_SPACE_SOURCES = Object.freeze({
  configuration: "configuration",
  pinned: "pinned",
});

export const INDEX_VERSION_ERROR_CODES = Object.freeze({
  buildInProgress: "INDEX_VERSION_BUILD_IN_PROGRESS",
  invalidState: "INDEX_VERSION_INVALID_STATE",
  leaseLost: "INDEX_VERSION_LEASE_LOST",
  notFound: "INDEX_VERSION_NOT_FOUND",
  unsupportedProvider: "INDEX_VERSION_UNSUPPORTED_PROVIDER",
  validationFailed: "INDEX_VERSION_VALIDATION_FAILED",
});

export class IndexVersionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "IndexVersionError";
    this.code = code;
    this.status = code === INDEX_VERSION_ERROR_CODES.notFound ? 404 : 409;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const getIndexVersionTableNames = () => getIndexVersionRegistryTableNames();

/** The migration-012 table, which is version 1 after the upgrade. */
export const getPgvectorBaseTableName = () => {
  const tableName = getDocumentChunksPostgresTable();

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `DOCUMENT_CHUNKS_POSTGRES_TABLE must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const getLifecycleLockKey = () =>
  `archive_rag:index_versions:${getIndexVersionTableNames().versionsTable}`;

// ---------------------------------------------------------------------------
// Embedding spaces and index parameters
// ---------------------------------------------------------------------------

/**
 * What a stored vector means: the model, the task prefixes and the width.
 * `identity` is the value stored in each chunk's embedding_model column
 * (getEmbeddingIndexIdentity for the configured model); `key` tells two spaces
 * whose document vectors are interchangeable apart from two that are not.
 */
export const buildEmbeddingSpace = ({
  dimensions,
  documentPrefix = "",
  identity = "",
  model,
  queryPrefix = "",
} = {}) => {
  const safeModel = String(model ?? "").trim();
  const safeDocumentPrefix = String(documentPrefix ?? "");
  const safeIdentity =
    String(identity ?? "").trim() ||
    buildEmbeddingIndexIdentity({ documentPrefix: safeDocumentPrefix, model: safeModel });
  const safeDimensions = Number(dimensions);

  return Object.freeze({
    dimensions: safeDimensions,
    documentPrefix: safeDocumentPrefix,
    identity: safeIdentity,
    key: `${safeIdentity}|${safeDimensions}`,
    model: safeModel,
    queryPrefix: String(queryPrefix ?? ""),
  });
};

export const getConfiguredEmbeddingSpace = () =>
  buildEmbeddingSpace({
    dimensions: getEmbeddingDimensions(),
    documentPrefix: getEmbeddingDocumentPrefix(),
    identity: getEmbeddingIndexIdentity(),
    model: getEmbeddingModel(),
    queryPrefix: getEmbeddingQueryPrefix(),
  });

/** Document vectors of one space can be written into a table of the other. */
export const isSameDocumentSpace = (left, right) =>
  Boolean(left && right) &&
  left.key === right.key &&
  left.model === right.model &&
  left.documentPrefix === right.documentPrefix;

/** A query embedded in one space can be searched against the other. */
export const isSameQuerySpace = (left, right) =>
  isSameDocumentSpace(left, right) && left.queryPrefix === right.queryPrefix;

const toPositiveInteger = (value, fallback) => {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const getConfiguredIndexParams = () => ({
  hnswEfConstruction: getPgvectorHnswEfConstruction(),
  hnswM: getPgvectorHnswM(),
  indexType: getPgvectorIndexType(),
  ivfflatLists: getPgvectorIvfflatLists(),
  textSearchConfig: getPgvectorTextSearchConfig(),
});

export const normalizeIndexParams = (params = {}) => {
  const defaults = getConfiguredIndexParams();
  const safe = params && typeof params === "object" ? params : {};
  const textSearchConfig = String(safe.textSearchConfig ?? "").trim();

  return {
    hnswEfConstruction: toPositiveInteger(safe.hnswEfConstruction, defaults.hnswEfConstruction),
    hnswM: toPositiveInteger(safe.hnswM, defaults.hnswM),
    indexType: ["hnsw", "ivfflat"].includes(safe.indexType) ? safe.indexType : defaults.indexType,
    ivfflatLists: toPositiveInteger(safe.ivfflatLists, defaults.ivfflatLists),
    textSearchConfig: /^[a-z_][a-z0-9_]*$/.test(textSearchConfig)
      ? textSearchConfig
      : defaults.textSearchConfig,
  };
};

// ---------------------------------------------------------------------------
// Version descriptors
// ---------------------------------------------------------------------------

const toIso = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toCount = (value) => (value === null || value === undefined ? null : Number(value));

export const toIndexVersion = (row = {}) => {
  const spaceSource =
    row.embedding_space_source === EMBEDDING_SPACE_SOURCES.configuration
      ? EMBEDDING_SPACE_SOURCES.configuration
      : EMBEDDING_SPACE_SOURCES.pinned;
  const pinned = spaceSource === EMBEDDING_SPACE_SOURCES.pinned;

  return {
    activatedAt: toIso(row.activated_at),
    buildCompletedAt: toIso(row.build_completed_at),
    buildDocumentsDone: toCount(row.build_documents_done) ?? 0,
    buildDocumentsFailed: toCount(row.build_documents_failed) ?? 0,
    buildDocumentsTotal: toCount(row.build_documents_total),
    buildStartedAt: toIso(row.build_started_at),
    builderId: row.builder_id ?? null,
    chunkCount: toCount(row.chunk_count),
    chunkTable: String(row.chunk_table ?? ""),
    createdAt: toIso(row.created_at),
    deactivatedAt: toIso(row.deactivated_at),
    documentCount: toCount(row.document_count),
    dualWriteUntil: toIso(row.dual_write_until),
    implicit: false,
    inDualWriteWindow:
      row.in_dual_write_window === undefined ? null : row.in_dual_write_window === true,
    lastError: row.last_error ?? null,
    leaseExpired: row.lease_expired === undefined ? null : row.lease_expired === true,
    leaseExpiresAt: toIso(row.lease_expires_at),
    pinnedIndexParams: pinned ? normalizeIndexParams(row.index_params) : null,
    pinnedSpace: pinned
      ? buildEmbeddingSpace({
          dimensions: row.embedding_dimensions,
          documentPrefix: row.embedding_document_prefix,
          identity: row.embedding_identity,
          model: row.embedding_model,
          queryPrefix: row.embedding_query_prefix,
        })
      : null,
    retiredAt: toIso(row.retired_at),
    spaceSource,
    sparseRankFunction: String(row.sparse_rank_function ?? ""),
    status: String(row.status ?? ""),
    versionId: Number(row.version_id),
  };
};

/**
 * Version 1 as the registry would describe it, for a database the registry
 * does not exist in yet (a dry run before migrations) or a scripted runtime.
 */
export const buildLegacyIndexVersion = () => {
  const chunkTable = getPgvectorBaseTableName();

  return {
    ...toIndexVersion({
      chunk_table: chunkTable,
      embedding_space_source: EMBEDDING_SPACE_SOURCES.configuration,
      sparse_rank_function: `${chunkTable}_sparse_rank`,
      status: INDEX_VERSION_STATUSES.active,
      version_id: 1,
    }),
    implicit: true,
    inDualWriteWindow: true,
  };
};

/** The space a version's vectors live in; version 1 follows configuration until pinned. */
export const resolveVersionSpace = (version) =>
  version.spaceSource === EMBEDDING_SPACE_SOURCES.configuration || !version.pinnedSpace
    ? getConfiguredEmbeddingSpace()
    : version.pinnedSpace;

export const resolveVersionIndexParams = (version) =>
  version.spaceSource === EMBEDDING_SPACE_SOURCES.configuration || !version.pinnedIndexParams
    ? getConfiguredIndexParams()
    : version.pinnedIndexParams;

/**
 * Changes whenever the pointer names another version or a version's recorded
 * space changes. A version that follows the configuration keeps the single
 * table's old contract: verified once per process (until a forced check or a
 * clear), not again on every configuration read.
 */
export const getVersionVerificationKey = (version) => {
  const space =
    version.spaceSource === EMBEDDING_SPACE_SOURCES.pinned && version.pinnedSpace
      ? version.pinnedSpace
      : null;

  return [
    version.versionId,
    version.chunkTable,
    version.spaceSource,
    space ? [space.key, space.model, space.documentPrefix, space.queryPrefix].join("|") : "",
  ].join("\u0000");
};

const toRegistryPointerTtlMs = (value) => {
  const parsed = Number(value);

  return value !== null && value !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/** How long this process caches the pointer: never longer than the registry allows. */
export const getInstancePointerTtlMs = (registryPointerTtlMs = null) => {
  const own = getIndexVersionPointerTtlMs();
  const bound = toRegistryPointerTtlMs(registryPointerTtlMs);

  return bound === null ? own : Math.min(own, bound);
};

/** The longest any instance may cache the pointer, as the lifecycle must assume it. */
export const getLifecyclePointerTtlMs = (registryPointerTtlMs = null) =>
  Math.max(getIndexVersionPointerTtlMs(), toRegistryPointerTtlMs(registryPointerTtlMs) ?? 0);

// Never below twice the pointer TTL: an instance may search the old version
// for up to one TTL after the switch, and a rollback must lose nothing.
export const getEffectiveDualWriteGraceMs = (
  graceMs = getIndexVersionDualWriteGraceMs(),
  { registryPointerTtlMs = null } = {}
) =>
  Math.max(Math.floor(Number(graceMs) || 0), 2 * getLifecyclePointerTtlMs(registryPointerTtlMs));

// ---------------------------------------------------------------------------
// Pointer snapshot (TTL cache)
// ---------------------------------------------------------------------------

const VERSION_COLUMNS = `
  v.version_id, v.status, v.chunk_table, v.sparse_rank_function, v.embedding_space_source,
  v.embedding_model, v.embedding_identity, v.embedding_document_prefix, v.embedding_query_prefix,
  v.embedding_dimensions, v.index_params, v.dual_write_until,
  (v.dual_write_until IS NULL OR v.dual_write_until > NOW()) AS in_dual_write_window
`;

const buildLegacySnapshot = (registry) => ({
  active: buildLegacyIndexVersion(),
  generation: 0,
  previousVersionId: null,
  registry,
  versions: [buildLegacyIndexVersion()],
});

let snapshotCache = null;
let snapshotInFlight = null;

export const invalidateIndexVersionSnapshot = () => {
  snapshotCache = null;
  snapshotInFlight = null;
};

onPgvectorRuntimeReset(invalidateIndexVersionSnapshot);

const readSnapshotFromDatabase = async () => {
  const { pointerTable, versionsTable } = getIndexVersionTableNames();
  let result;

  try {
    result = await runAsDatabaseSystem(() =>
      getPgvectorRuntime().query(
        `/* index_versions:snapshot */
          SELECT ${VERSION_COLUMNS},
                 (v.version_id = p.active_version_id) AS is_active,
                 p.generation, p.previous_version_id,
                 (to_jsonb(p) ->> 'pointer_ttl_ms') AS pointer_ttl_ms
          FROM ${pointerTable} p
          JOIN ${versionsTable} v
            ON v.version_id = p.active_version_id OR v.status IN ('building', 'ready')
          WHERE p.singleton
          ORDER BY v.version_id`
      )
    );
  } catch (error) {
    // No registry yet: the database predates migration 016 (a read-only dry
    // run never migrates). The single table is then version 1.
    if (error?.code === UNDEFINED_TABLE) {
      return buildLegacySnapshot("absent");
    }

    throw error;
  }

  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const activeRow = rows.find((row) => row.is_active === true);

  if (!activeRow) {
    return buildLegacySnapshot(rows.length > 0 ? "inconsistent" : "empty");
  }

  return {
    active: toIndexVersion(activeRow),
    generation: Number(activeRow.generation) || 0,
    pointerTtlMs: toRegistryPointerTtlMs(activeRow.pointer_ttl_ms),
    previousVersionId:
      activeRow.previous_version_id === null || activeRow.previous_version_id === undefined
        ? null
        : Number(activeRow.previous_version_id),
    registry: "present",
    versions: rows.map(toIndexVersion),
  };
};

/**
 * The active version and the other live versions, from a cache that lives for
 * the pointer TTL (RAG_INDEX_VERSION_POINTER_TTL_MS). Concurrent readers share
 * one database read. Read as the owner: the pointer is system-wide.
 */
export const readIndexVersionSnapshot = async ({ force = false } = {}) => {
  const runtime = getPgvectorRuntime();

  if (!force && snapshotCache && snapshotCache.expiresAt > runtime.now()) {
    return snapshotCache.snapshot;
  }

  if (!force && snapshotInFlight) {
    return snapshotInFlight;
  }

  // The entry lives one TTL from when the read started: a read that waited
  // for a pool connection is already that old when it returns.
  const startedAt = runtime.now();
  const read = readSnapshotFromDatabase().then((snapshot) => {
    if (snapshotInFlight === read) {
      snapshotCache = {
        expiresAt: startedAt + getInstancePointerTtlMs(snapshot.pointerTtlMs),
        snapshot,
      };
    }

    return snapshot;
  });

  snapshotInFlight = read;

  try {
    return await read;
  } finally {
    if (snapshotInFlight === read) {
      snapshotInFlight = null;
    }
  }
};

/** The cached snapshot without reading the database (possibly expired, or null). */
export const peekIndexVersionSnapshot = () => snapshotCache?.snapshot ?? null;

export const isIndexVersionSnapshotFresh = () =>
  Boolean(snapshotCache && snapshotCache.expiresAt > getPgvectorRuntime().now());

export const isIndexVersionWriteTarget = (version) =>
  version.status === INDEX_VERSION_STATUSES.active ||
  version.status === INDEX_VERSION_STATUSES.building ||
  (version.status === INDEX_VERSION_STATUSES.ready && version.inDualWriteWindow !== false);

const isWriteTarget = isIndexVersionWriteTarget;

/**
 * The embedding spaces the next write will most likely need, active version
 * first, from the cached snapshot only. Ingest embeds in all of them before
 * it opens its transaction; a space the locked read then adds is embedded
 * inside the transaction.
 */
export const getHintedWriteSpaces = () => {
  const snapshot = peekIndexVersionSnapshot();
  const versions = snapshot
    ? [snapshot.active, ...snapshot.versions.filter((version) => version.versionId !== snapshot.active.versionId)]
    : [buildLegacyIndexVersion()];
  const spaces = [];

  for (const version of versions.filter(isWriteTarget)) {
    const space = resolveVersionSpace(version);

    if (!spaces.some((candidate) => isSameDocumentSpace(candidate, space))) {
      spaces.push(space);
    }
  }

  return spaces.length > 0 ? spaces : [getConfiguredEmbeddingSpace()];
};

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/**
 * The first statements of every ingest, delete and clear transaction: the
 * shared lock, then the versions to write, active first. `client` must be in a
 * transaction (the lock is transaction-scoped). Under a tenant this runs as the
 * tenant role, which may read the registry (migration 016's grant).
 */
export const lockIndexVersionWriteTargets = async (client) => {
  const query = getPgvectorQuery(client);
  const { pointerTable, versionsTable } = getIndexVersionTableNames();

  await query(
    `/* index_versions:write_lock */ SELECT pg_advisory_xact_lock_shared(hashtext($1)::bigint)`,
    [getLifecycleLockKey()]
  );

  const result = await query(
    `/* index_versions:write_targets */
      SELECT ${VERSION_COLUMNS}, (v.version_id = p.active_version_id) AS is_active
      FROM ${versionsTable} v
      JOIN ${pointerTable} p ON p.singleton
      WHERE v.version_id = p.active_version_id
         OR v.status = 'building'
         OR (v.status = 'ready' AND (v.dual_write_until IS NULL OR v.dual_write_until > NOW()))
      ORDER BY (v.version_id = p.active_version_id) DESC, v.version_id`
  );
  const versions = (Array.isArray(result?.rows) ? result.rows : []).map(toIndexVersion);

  return versions.length > 0 ? versions : [buildLegacyIndexVersion()];
};

/** Exclusive counterpart, for registration, the pointer switch and retire. */
export const lockIndexVersionLifecycle = (query) =>
  query(
    `/* index_versions:lifecycle_lock */ SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
    [getLifecycleLockKey()]
  );

// ---------------------------------------------------------------------------
// Fencing a version no search reads
// ---------------------------------------------------------------------------

// Short: the caller is an upload waiting on it, and a lifecycle operation that
// holds the version row must not stall it.
const FENCE_LOCK_TIMEOUT = "2s";

/**
 * Marks every live version in `space` that the pointer does not name failed
 * (a build being run, a built version not yet activated, a rollback target in
 * its grace period), so writes stop going to it. Called when an upload could
 * not embed its chunks in that space: the version then misses the upload, and
 * failed is what keeps it from ever being activated or rolled back to. The
 * active version is never touched. Runs as the owner in its own transaction;
 * the caller must hold no index-version lock (it runs before the upload's
 * write transaction opens). Resolves to the fenced version ids.
 */
export const fenceNonServingIndexVersions = async ({ reason = "", space }) => {
  const { pointerTable, versionsTable } = getIndexVersionTableNames();
  const message = String(reason || "Embedding in this version's space failed during an upload.").slice(0, 2000);
  const fenced = await runAsDatabaseSystem(() =>
    getPgvectorRuntime().withTransaction(async (client) => {
      const query = getPgvectorQuery(client);

      await query("SELECT set_config('lock_timeout', $1, true)", [FENCE_LOCK_TIMEOUT]);

      const result = await query(
        `/* index_versions:fence */
          UPDATE ${versionsTable} v
             SET status = 'failed', last_error = $5, builder_id = NULL, lease_expires_at = NULL,
                 dual_write_until = NULL, updated_at = NOW()
            FROM ${pointerTable} p
           WHERE p.singleton
             AND v.version_id <> p.active_version_id
             AND v.status IN ('building', 'ready')
             AND v.embedding_space_source = 'pinned'
             AND v.embedding_model = $1
             AND v.embedding_identity = $2
             AND v.embedding_document_prefix = $3
             AND v.embedding_dimensions = $4
          RETURNING v.version_id`,
        [space.model, space.identity, space.documentPrefix ?? "", space.dimensions, message]
      );

      return (result?.rows ?? []).map((row) => Number(row.version_id));
    })
  );

  invalidateIndexVersionSnapshot();
  return fenced;
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const describeSpace = (version) => {
  const space = resolveVersionSpace(version);

  return {
    dimensions: space.dimensions,
    identity: space.identity,
    model: space.model,
    source: version.spaceSource,
  };
};

const describeVersion = (version) => ({
  activatedAt: version.activatedAt,
  buildCompletedAt: version.buildCompletedAt,
  buildStartedAt: version.buildStartedAt,
  chunkCount: version.chunkCount,
  chunkTable: version.chunkTable,
  createdAt: version.createdAt,
  deactivatedAt: version.deactivatedAt,
  documentCount: version.documentCount,
  dualWriteUntil: version.dualWriteUntil,
  embedding: describeSpace(version),
  indexParams: resolveVersionIndexParams(version),
  lastError: version.lastError,
  retiredAt: version.retiredAt,
  sparseRankFunction: version.sparseRankFunction,
  status: version.status,
  versionId: version.versionId,
});

const readTableChunkTotals = async (query, chunkTable) => {
  const result = await query(
    `/* index_versions:table_totals */
      SELECT COUNT(*)::bigint AS chunk_count, COUNT(DISTINCT doc_id)::bigint AS document_count
      FROM ${chunkTable}`
  );

  return {
    chunkCount: Number(result?.rows?.[0]?.chunk_count) || 0,
    documentCount: Number(result?.rows?.[0]?.document_count) || 0,
  };
};

/**
 * Registry status for health, the CLI and the admin route: the active
 * version, every live one (building, ready) and the pointer's previous one
 * whatever their number, then the newest `limit` of the rest (retired,
 * failed) as history, newest first; build progress and warnings. Read-only
 * and as the owner. `warnings` never block serving; `problems` mean the active
 * version cannot be served as the pointer says.
 *
 * `includeDrift` compares the chunk and document totals of the active version
 * with every ready one (full scans of each table): the CLI and the admin route
 * ask for it, the health check does not.
 */
export const describeIndexVersions = async ({ includeDrift = true, includeRetired = true, limit = 25 } = {}) =>
  runAsDatabaseSystem(async () => {
    const runtime = getPgvectorRuntime();
    const { pointerTable, versionsTable } = getIndexVersionTableNames();
    const historyLimit = Math.max(1, Math.floor(Number(limit) || 25));
    let result;

    try {
      result = await runtime.query(
        `/* index_versions:describe */
          WITH p AS (SELECT * FROM ${pointerTable} WHERE singleton),
          described AS (
            SELECT v.*,
                   (v.dual_write_until IS NULL OR v.dual_write_until > NOW()) AS in_dual_write_window,
                   (v.version_id = p.active_version_id) AS is_active,
                   p.previous_version_id, p.generation, p.switched_at,
                   (to_jsonb(p) ->> 'pointer_ttl_ms') AS pointer_ttl_ms,
                   (v.lease_expires_at IS NOT NULL AND v.lease_expires_at <= NOW()) AS lease_expired,
                   (v.status IN ('active', 'building', 'ready')
                     OR v.version_id IS NOT DISTINCT FROM p.active_version_id
                     OR v.version_id IS NOT DISTINCT FROM p.previous_version_id) AS is_current
            FROM ${versionsTable} v
            LEFT JOIN p ON TRUE
          )
          (SELECT * FROM described WHERE is_current)
          UNION ALL
          (SELECT * FROM described
            WHERE NOT is_current AND ($1::boolean OR status <> 'retired')
            ORDER BY version_id DESC
            LIMIT $2)`,
        [includeRetired, historyLimit]
      );
    } catch (error) {
      if (error?.code === UNDEFINED_TABLE) {
        return { problems: [], registry: "absent", versions: [], warnings: [] };
      }

      throw error;
    }

    const rows = (Array.isArray(result?.rows) ? result.rows : []).sort(
      (left, right) => Number(right.version_id) - Number(left.version_id)
    );

    if (rows.length === 0) {
      return { problems: [], registry: "empty", versions: [], warnings: [] };
    }

    const versions = rows.map((row) => ({ ...toIndexVersion(row), isActive: row.is_active === true }));
    const active = versions.find((version) => version.isActive) ?? null;
    const pointerRow = rows.find((row) => row.generation !== null && row.generation !== undefined) ?? {};
    const warnings = [];
    const problems = [];
    const configured = getConfiguredEmbeddingSpace();

    if (!active) {
      problems.push("The version pointer names no registered version.");
    } else if (!isSameQuerySpace(resolveVersionSpace(active), configured)) {
      warnings.push({
        code: "configuration_differs_from_active",
        message: `The active version ${active.versionId} is pinned to ${resolveVersionSpace(active).identity}/${resolveVersionSpace(active).dimensions} but this process is configured for ${configured.identity}/${configured.dimensions}; every query is embedded twice until OPENAI_EMBEDDING_MODEL / RAG_EMBEDDING_DIMENSIONS name the active model.`,
        versionId: active.versionId,
      });
    }

    const liveVersions = versions.filter(
      (version) => !version.isActive && [INDEX_VERSION_STATUSES.building, INDEX_VERSION_STATUSES.ready].includes(version.status)
    );
    const activeTotals = includeDrift && active && liveVersions.length > 0
      ? await readTableChunkTotals(runtime.query, active.chunkTable)
      : null;
    const drift = includeDrift ? [] : null;
    const registryPointerTtlMs = toRegistryPointerTtlMs(pointerRow.pointer_ttl_ms);

    for (const version of liveVersions) {
      if (version.status === INDEX_VERSION_STATUSES.building) {
        if (version.leaseExpired) {
          warnings.push({
            code: "build_stalled",
            message: `Version ${version.versionId} is building but its builder's lease expired at ${version.leaseExpiresAt}; every upload still embeds in its space until it is resumed (npm run vector:index -- resume) or retired.`,
            versionId: version.versionId,
          });
        }

        continue;
      }

      if (version.dualWriteUntil === null) {
        // Built, never activated: it stays a write target with no expiry.
        warnings.push({
          code: "ready_not_activated",
          message: `Version ${version.versionId} is built but was never activated; every upload also embeds in its space (${resolveVersionSpace(version).identity}) until it is activated or retired.`,
          versionId: version.versionId,
        });
      }

      if (version.inDualWriteWindow === false) {
        warnings.push({
          code: "ready_out_of_grace",
          message: `Version ${version.versionId} stopped receiving writes at ${version.dualWriteUntil}; it can no longer be activated or rolled back to. Retire it.`,
          versionId: version.versionId,
        });
        continue;
      }

      if (!activeTotals) {
        continue;
      }

      const totals = await readTableChunkTotals(runtime.query, version.chunkTable);

      if (
        totals.chunkCount !== activeTotals.chunkCount ||
        totals.documentCount !== activeTotals.documentCount
      ) {
        drift.push({ active: activeTotals, version: totals, versionId: version.versionId });
        warnings.push({
          code: "drift",
          message: `Version ${version.versionId} holds ${totals.chunkCount} chunk(s) of ${totals.documentCount} document(s); the active version holds ${activeTotals.chunkCount} of ${activeTotals.documentCount}.`,
          versionId: version.versionId,
        });
      }
    }

    for (const version of versions.filter((entry) => entry.status === INDEX_VERSION_STATUSES.failed)) {
      warnings.push({
        code: "build_failed",
        message: `Version ${version.versionId} failed: ${version.lastError ?? "unknown error"}. Retire it.`,
        versionId: version.versionId,
      });
    }

    const building = versions.find((version) => version.status === INDEX_VERSION_STATUSES.building);

    return {
      active: active ? describeVersion(active) : null,
      building: building
        ? {
            builderId: building.builderId,
            documentsDone: building.buildDocumentsDone,
            documentsFailed: building.buildDocumentsFailed,
            documentsTotal: building.buildDocumentsTotal,
            leaseExpired: building.leaseExpired,
            leaseExpiresAt: building.leaseExpiresAt,
            versionId: building.versionId,
          }
        : null,
      drift,
      generation: Number(pointerRow.generation) || 0,
      historyLimit,
      // What this process caches the pointer for, and the bound the registry
      // sets for every instance (migration 019).
      pointerTtlMs: getInstancePointerTtlMs(registryPointerTtlMs),
      registryPointerTtlMs,
      previousVersionId:
        pointerRow.previous_version_id === null || pointerRow.previous_version_id === undefined
          ? null
          : Number(pointerRow.previous_version_id),
      problems,
      registry: "present",
      switchedAt: toIso(pointerRow.switched_at),
      versions: versions.map((version) => ({ ...describeVersion(version), isActive: version.isActive })),
      warnings,
    };
  });
