import { createHash } from "node:crypto";
import { readFile as readBinaryFile } from "fs/promises";
import { getDocumentsPostgresTable, isPostgresDatabaseConfigured } from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { createDocumentLegacyImporter as createDefaultDocumentLegacyImporter } from "./document-legacy-importer.js";
import { buildPublicFilePath } from "./document-utils.js";
import { queryPostgres as queryDefaultPostgres } from "./postgres.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// What a registry store says it is (`store.backend`). Only a PostgreSQL store
// is written by more than one process; see isDocumentRegistryShared.
export const DOCUMENT_REGISTRY_BACKENDS = Object.freeze({
  filesystem: "filesystem",
  postgres: "postgres",
});

let configuredDocumentRegistryStore = null;
let documentRegistry = new Map();
let documentRegistryInitialized = false;
let legacyImportAttempted = false;
// Document writes of this process whose transaction has not settled, the
// store reads running now (each with the ids written while it ran), and per
// access scope the refresh listing the store and the one queued behind it;
// see trackDocumentWrite, loadDocumentsFromStore and refreshDocumentRegistry.
const documentWritesInFlight = new Map();
const activeRefreshes = new Set();
const refreshQueues = new Map();
// Called with the docIds a store read dropped from this process's map or found
// with other content (another process deleted or replaced them), so a cache
// built on their old content can drop it (rag/semantic-cache.js). This
// process's own deletes and replacements are handled by their callers.
const documentStoreChangeListeners = new Set();

export const onDocumentStoreChange = (listener) => {
  documentStoreChangeListeners.add(listener);
  return () => documentStoreChangeListeners.delete(listener);
};

const notifyDocumentStoreChange = (docIds) => {
  if (docIds.length === 0) {
    return;
  }

  for (const listener of documentStoreChangeListeners) {
    try {
      listener(docIds);
    } catch (error) {
      console.error("Document registry change listener failed.", error);
    }
  }
};

const describeContentVersion = (document) =>
  document ? `${document.version}:${document.contentSha256 ?? ""}:${document.updatedAt ?? ""}` : null;

// Whether a store read changed what `docId` holds: gone, or other content.
const isContentChange = (previous, next) =>
  Boolean(previous) && (!next || describeContentVersion(previous) !== describeContentVersion(next));

const toPositiveInteger = (value, fallbackValue = 0) => {
  const parsedValue = Number.parseInt(value ?? fallbackValue, 10);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallbackValue;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// A document's content identity (migration 018): the SHA-256 of its stored
// bytes, lowercase hex, or null when it is unknown (a row from before the
// migration that `ingest:jobs -- backfill-hashes` has not reached yet).
export const normalizeContentSha256 = (value) => {
  const hash = String(value ?? "").trim().toLowerCase();

  return SHA256_PATTERN.test(hash) ? hash : null;
};

const toContentVersion = (value) => {
  const parsedValue = Number.parseInt(value ?? 1, 10);

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : 1;
};

const toTimestampText = (value, fallbackValue) =>
  value instanceof Date ? value.toISOString() : value ?? fallbackValue;

const ensureTableName = (getTableName = getDocumentsPostgresTable) => {
  const tableName = getTableName();

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `DOCUMENTS_POSTGRES_TABLE must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const normalizeDocId = (docId) => String(docId ?? "").trim();

const normalizeAccessScope = (accessScope = {}) => ({
  userId: String(accessScope.userId ?? "").trim(),
  workspaceId: String(accessScope.workspaceId ?? "").trim(),
});

export const hasAccessScope = (accessScope = {}) => {
  const scope = normalizeAccessScope(accessScope);

  return Boolean(scope.userId || scope.workspaceId);
};

// Exported so alternative registry stores (doc-registry-file.js) enforce the
// same access rule rather than reimplementing it. An access-control predicate
// that exists twice is an access-control predicate that will eventually differ.
export const documentMatchesAccessScope = (document = {}, accessScope = {}) => {
  const safeDocument = document ?? {};
  const scope = normalizeAccessScope(accessScope);

  if (!scope.userId && !scope.workspaceId) {
    return true;
  }

  const ownerUserId = String(safeDocument.ownerUserId ?? "").trim();
  const workspaceId = String(safeDocument.workspaceId ?? "").trim();

  if (!ownerUserId && !workspaceId) {
    return false;
  }

  if (ownerUserId && (!scope.userId || ownerUserId !== scope.userId)) {
    return false;
  }

  if (workspaceId && (!scope.workspaceId || workspaceId !== scope.workspaceId)) {
    return false;
  }

  return true;
};

const normalizeStringArray = (values, { limit = 12 } = {}) => {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    ),
  ].slice(0, limit);
};

const normalizeProfileSource = (source = {}) => {
  if (!source || typeof source !== "object") {
    return null;
  }

  const sourceType = String(source.sourceType ?? "").trim();

  if (!sourceType) {
    return null;
  }

  const normalizedSource = {
    sourceType,
    arxivId: String(source.arxivId ?? "").trim(),
    relatedToDocId: String(source.relatedToDocId ?? "").trim(),
    importedByUserConfirmation: Boolean(source.importedByUserConfirmation),
  };

  const absUrl = String(source.absUrl ?? "").trim();
  const pdfUrl = String(source.pdfUrl ?? "").trim();
  const titleHash = String(source.titleHash ?? "").trim();

  if (absUrl) {
    normalizedSource.absUrl = absUrl;
  }

  if (pdfUrl) {
    normalizedSource.pdfUrl = pdfUrl;
  }

  if (titleHash) {
    normalizedSource.titleHash = titleHash;
  }

  return normalizedSource;
};

const normalizeProfile = (document = {}) => {
  const rawProfile =
    document.profile && typeof document.profile === "object" ? document.profile : {};
  const source = normalizeProfileSource(rawProfile.source ?? document.source);

  const profile = {
    summary: String(rawProfile.summary ?? document.summary ?? "").trim(),
    tags: normalizeStringArray(rawProfile.tags ?? document.tags),
    entities: normalizeStringArray(rawProfile.entities ?? document.entities),
    generatedAt: String(rawProfile.generatedAt ?? document.profileGeneratedAt ?? "").trim(),
  };

  if (source) {
    profile.source = source;
  }

  return profile;
};

const toStoredDocument = (document = {}) => {
  const docId = normalizeDocId(document.docId);
  const publicFilePath = buildPublicFilePath(docId);
  const profile = normalizeProfile(document);
  // pg returns timestamptz as a Date, while file/in-memory stores already
  // use strings. Keep the registry's public and sortable timestamp shape
  // identical across providers.
  const uploadedAt = toTimestampText(document.uploadedAt, new Date().toISOString());

  return {
    docId,
    fileName: String(document.fileName ?? "").trim(),
    filePath: publicFilePath,
    publicFilePath,
    mimeType: String(document.mimeType ?? "application/pdf").trim() || "application/pdf",
    fileSize: toPositiveInteger(document.fileSize),
    chunkCount: toPositiveInteger(document.chunkCount),
    pageCount: toPositiveInteger(document.pageCount),
    ownerUserId: String(
      document.ownerUserId ?? document.userId ?? document.owner_user_id ?? ""
    ).trim(),
    workspaceId: String(
      document.workspaceId ?? document.workspace_id ?? ""
    ).trim(),
    profile,
    uploadedAt,
    // Content identity and version (migration 018). A replacement keeps the
    // docId and uploadedAt, bumps `version` and moves `updatedAt`.
    contentSha256: normalizeContentSha256(document.contentSha256 ?? document.content_sha256),
    version: toContentVersion(document.version ?? document.contentVersion ?? document.content_version),
    updatedAt: toTimestampText(
      document.updatedAt ?? document.contentUpdatedAt ?? document.content_updated_at,
      uploadedAt
    ),
    // Defaults to postgresql because that is where documents live unless a store
    // says otherwise. Preserving what the store reports matters: every document
    // entering the registry is renormalized through here, so hardcoding this made
    // the file-backed store's documents claim a database that is not running.
    storageBackend: String(document.storageBackend ?? "").trim() || "postgresql",
  };
};

const mapRowToStoredDocument = (row = {}) =>
  toStoredDocument({
    docId: row.doc_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    chunkCount: row.chunk_count,
    pageCount: row.page_count,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    profile: row.profile,
    uploadedAt: row.uploaded_at,
    contentSha256: row.content_sha256,
    contentVersion: row.content_version,
    contentUpdatedAt: row.content_updated_at ?? undefined,
  });

const toPublicDocument = (document) =>
  document
    ? {
        docId: document.docId,
        fileName: document.fileName,
        filePath: document.filePath,
        publicFilePath: document.publicFilePath,
        mimeType: document.mimeType,
        fileSize: document.fileSize,
        chunkCount: document.chunkCount,
        pageCount: document.pageCount,
        summary: document.profile?.summary ?? "",
        tags: document.profile?.tags ?? [],
        entities: document.profile?.entities ?? [],
        profile: document.profile,
        source: document.profile?.source ?? null,
        uploadedAt: document.uploadedAt,
        storageBackend: document.storageBackend,
        version: document.version,
        updatedAt: document.updatedAt,
        contentSha256: document.contentSha256,
      }
    : null;

export const resolveFileBuffer = async ({
  fileBuffer = null,
  readFile = readBinaryFile,
  sourceFilePath = "",
} = {}) => {
  if (Buffer.isBuffer(fileBuffer)) {
    return fileBuffer;
  }

  if (fileBuffer instanceof Uint8Array) {
    return Buffer.from(fileBuffer);
  }

  if (sourceFilePath) {
    return readFile(sourceFilePath);
  }

  throw new Error("Document ingestion requires a PDF buffer or source file path.");
};

// Writes accept an optional transaction client so the pgvector ingest path can
// commit the document row and its chunk rows together. Without one they use
// the pool, exactly as before.
const resolveQuery = (queryPostgres, client) =>
  client && typeof client.query === "function"
    ? (sql, values = []) => client.query(sql, values)
    : queryPostgres;

// The metadata columns every read returns. A database migration 018 has not
// reached yet (a read-only `vector:reindex` dry run never migrates) has no
// content columns; reads there fall back to the older list once.
const DOCUMENT_METADATA_COLUMNS =
  "doc_id, file_name, mime_type, file_size, chunk_count, page_count, owner_user_id, workspace_id, profile, uploaded_at, content_sha256, content_version, content_updated_at";
const LEGACY_DOCUMENT_METADATA_COLUMNS =
  "doc_id, file_name, mime_type, file_size, chunk_count, page_count, owner_user_id, workspace_id, profile, uploaded_at";
const UNDEFINED_COLUMN = "42703";

const queryDocumentColumns = async (query, buildSql, values) => {
  try {
    return await query(buildSql(DOCUMENT_METADATA_COLUMNS), values);
  } catch (error) {
    if (error?.code !== UNDEFINED_COLUMN) {
      throw error;
    }

    return query(buildSql(LEGACY_DOCUMENT_METADATA_COLUMNS), values);
  }
};

// Exact tenant equality, not the looser visibility rule: a duplicate is a
// document this very owner and workspace stored.
const toOwnerKey = ({ ownerUserId = "", workspaceId = "" } = {}) => ({
  ownerUserId: String(ownerUserId ?? "").trim(),
  workspaceId: String(workspaceId ?? "").trim(),
});

export const createDocumentRegistryStore = ({
  createDocumentLegacyImporter = createDefaultDocumentLegacyImporter,
  getDocumentsTable = getDocumentsPostgresTable,
  queryPostgres = queryDefaultPostgres,
  readFile = readBinaryFile,
  runMigrations = runPostgresMigrations,
} = {}) => ({
  backend: DOCUMENT_REGISTRY_BACKENDS.postgres,

  async initialize() {
    await runMigrations();

    if (legacyImportAttempted) {
      return true;
    }

    legacyImportAttempted = true;
    const legacyImporter = createDocumentLegacyImporter();

    await legacyImporter.importMissingDocuments({
      getExistingDocIds: async (docIds = []) => {
        if (docIds.length === 0) {
          return new Set();
        }

        const tableName = ensureTableName(getDocumentsTable);
        const existing = await queryPostgres(
          `
            SELECT doc_id
            FROM ${tableName}
            WHERE doc_id = ANY($1::text[])
          `,
          [docIds]
        );

        return new Set(existing.rows.map((row) => String(row.doc_id)));
      },
      upsertDocument: (document) => this.upsert(document),
    });

    return true;
  },

  // A scope is applied in SQL too (the documentMatchesAccessScope rule, which
  // is also the row policy), so a scoped listing reads only that tenant's rows
  // even when it runs as the owner.
  async list(accessScope = {}) {
    const tableName = ensureTableName(getDocumentsTable);
    const scope = normalizeAccessScope(accessScope);
    const result = hasAccessScope(scope)
      ? await queryDocumentColumns(
          queryPostgres,
          (columns) => `
            SELECT ${columns}
            FROM ${tableName}
            WHERE (owner_user_id <> '' OR workspace_id <> '')
              AND (owner_user_id = '' OR owner_user_id = $1)
              AND (workspace_id = '' OR workspace_id = $2)
            ORDER BY uploaded_at ASC, doc_id ASC
          `,
          [scope.userId, scope.workspaceId]
        )
      : await queryDocumentColumns(
          queryPostgres,
          (columns) => `
            SELECT ${columns}
            FROM ${tableName}
            ORDER BY uploaded_at ASC, doc_id ASC
          `
        );

    return result.rows
      .map(mapRowToStoredDocument)
      .filter((document) => documentMatchesAccessScope(document, accessScope));
  },

  // Metadata of the named documents only (no file bytes), for a process that
  // needs to pick up documents another process registered.
  async listByIds(docIds = []) {
    const normalizedDocIds = normalizeDocIds(docIds);

    if (normalizedDocIds.length === 0) {
      return [];
    }

    const tableName = ensureTableName(getDocumentsTable);
    const result = await queryDocumentColumns(
      queryPostgres,
      (columns) => `
        SELECT ${columns}
        FROM ${tableName}
        WHERE doc_id = ANY($1::text[])
      `,
      [normalizedDocIds]
    );

    return result.rows.map(mapRowToStoredDocument);
  },

  /**
   * The oldest document of exactly this owner and workspace whose stored
   * bytes hash to `contentSha256`, or null. Inside the ingest transaction it
   * runs on `client`, after the caller took lockContentHash.
   */
  async findByContentHash(contentSha256, owner = {}, { client = null } = {}) {
    const hash = normalizeContentSha256(contentSha256);

    if (!hash) {
      return null;
    }

    const { ownerUserId, workspaceId } = toOwnerKey(owner);
    const result = await resolveQuery(queryPostgres, client)(
      `
        SELECT ${DOCUMENT_METADATA_COLUMNS}
        FROM ${ensureTableName(getDocumentsTable)}
        WHERE owner_user_id = $1
          AND workspace_id = $2
          AND content_sha256 = $3
        ORDER BY uploaded_at ASC, doc_id ASC
        LIMIT 1
      `,
      [ownerUserId, workspaceId, hash]
    );

    return result.rows[0] ? mapRowToStoredDocument(result.rows[0]) : null;
  },

  /**
   * Serializes identical uploads of one tenant for the rest of the caller's
   * transaction (a transaction-scoped advisory lock on the tenant and hash).
   * Taken after the index-version write lock and before any documents-row
   * lock, the order vector-store-pgvector-versions.js requires of writers.
   */
  async lockContentHash(contentSha256, owner = {}, { client }) {
    const { ownerUserId, workspaceId } = toOwnerKey(owner);

    await resolveQuery(queryPostgres, client)(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [
        // JSON keeps the parts apart whatever an id contains (a NUL separator
        // cannot travel in a text parameter).
        JSON.stringify([
          "archive_rag:document_content",
          ensureTableName(getDocumentsTable),
          ownerUserId,
          workspaceId,
          normalizeContentSha256(contentSha256) ?? "",
        ]),
      ]
    );
  },

  /**
   * Locks the row a replacement is about to change (FOR UPDATE: concurrent
   * replacements and deletes, and the index-version builder's FOR SHARE read,
   * wait for it) and returns it, or null when the document is gone.
   */
  async lockForContentReplace(docId, { client }) {
    const result = await resolveQuery(queryPostgres, client)(
      `
        SELECT ${DOCUMENT_METADATA_COLUMNS}
        FROM ${ensureTableName(getDocumentsTable)}
        WHERE doc_id = $1
        FOR UPDATE
      `,
      [normalizeDocId(docId)]
    );

    return result.rows[0] ? mapRowToStoredDocument(result.rows[0]) : null;
  },

  async upsert(document, { client = null } = {}) {
    const normalizedDocument = toStoredDocument(document);

    if (!normalizedDocument.docId || !normalizedDocument.fileName) {
      throw new Error("Document registration requires both docId and fileName.");
    }

    const tableName = ensureTableName(getDocumentsTable);
    const fileBuffer = await resolveFileBuffer({
      fileBuffer: document.fileBuffer,
      readFile,
      sourceFilePath: document.sourceFilePath,
    });
    const fileSize = normalizedDocument.fileSize || fileBuffer.byteLength;
    const result = await resolveQuery(queryPostgres, client)(
      `
        INSERT INTO ${tableName} (
          doc_id,
          file_name,
          mime_type,
          file_size,
          file_bytes,
          chunk_count,
          page_count,
          owner_user_id,
          workspace_id,
          profile,
          uploaded_at,
          content_sha256,
          content_version,
          content_updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::timestamptz, NOW()))
        ON CONFLICT (doc_id)
        DO UPDATE SET
          file_name = EXCLUDED.file_name,
          mime_type = EXCLUDED.mime_type,
          file_size = EXCLUDED.file_size,
          file_bytes = EXCLUDED.file_bytes,
          chunk_count = EXCLUDED.chunk_count,
          page_count = EXCLUDED.page_count,
          owner_user_id = EXCLUDED.owner_user_id,
          workspace_id = EXCLUDED.workspace_id,
          profile = EXCLUDED.profile,
          uploaded_at = EXCLUDED.uploaded_at,
          content_sha256 = EXCLUDED.content_sha256,
          content_version = EXCLUDED.content_version,
          content_updated_at = EXCLUDED.content_updated_at
        RETURNING ${DOCUMENT_METADATA_COLUMNS}
      `,
      [
        normalizedDocument.docId,
        normalizedDocument.fileName,
        normalizedDocument.mimeType,
        fileSize,
        fileBuffer,
        normalizedDocument.chunkCount,
        normalizedDocument.pageCount,
        normalizedDocument.ownerUserId,
        normalizedDocument.workspaceId,
        normalizedDocument.profile,
        normalizedDocument.uploadedAt,
        normalizedDocument.contentSha256 ?? createHash("sha256").update(fileBuffer).digest("hex"),
        normalizedDocument.version,
        // The database's clock when the writer asks for it: async jobs order
        // replacements by their enqueue time (created_at, this clock too), so a
        // write without a request time is stamped by it, never by a host's.
        document.contentUpdatedAtFromDatabase === true ? null : normalizedDocument.updatedAt,
      ]
    );

    return mapRowToStoredDocument(result.rows[0]);
  },

  async getFile(docId, accessScope = {}) {
    const normalizedDocId = normalizeDocId(docId);

    if (!normalizedDocId) {
      return null;
    }

    const tableName = ensureTableName(getDocumentsTable);
    const result = await queryDocumentColumns(
      queryPostgres,
      (columns) => `
        SELECT ${columns.replace("file_size,", "file_size, file_bytes,")}
        FROM ${tableName}
        WHERE doc_id = $1
        LIMIT 1
      `,
      [normalizedDocId]
    );
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    const document = mapRowToStoredDocument(row);

    if (!documentMatchesAccessScope(document, accessScope)) {
      return null;
    }

    return {
      document,
      fileBuffer: Buffer.from(row.file_bytes ?? []),
      mimeType: String(row.mime_type ?? "application/pdf"),
      fileName: String(row.file_name ?? "document.pdf"),
      fileSize: toPositiveInteger(row.file_size),
    };
  },

  async delete(docId, accessScope = {}, { client = null } = {}) {
    const normalizedDocId = normalizeDocId(docId);

    if (!normalizedDocId) {
      return null;
    }

    const tableName = ensureTableName(getDocumentsTable);
    const existingFile = await this.getFile(normalizedDocId, accessScope);

    if (!existingFile) {
      return null;
    }

    const result = await resolveQuery(queryPostgres, client)(
      `
        DELETE FROM ${tableName}
        WHERE doc_id = $1
        RETURNING ${DOCUMENT_METADATA_COLUMNS}
      `,
      [normalizedDocId]
    );

    return result.rows[0] ? mapRowToStoredDocument(result.rows[0]) : null;
  },

  // Deletes the scope's rows (every row when the scope is empty) in one
  // statement on `client` and returns the documents it deleted, including
  // rows another process registered that this process's map never loaded.
  async clear(accessScope = {}, { client = null } = {}) {
    const tableName = ensureTableName(getDocumentsTable);
    const query = resolveQuery(queryPostgres, client);
    const scope = normalizeAccessScope(accessScope);
    const result = hasAccessScope(scope)
      ? await query(
          `
            DELETE FROM ${tableName}
            WHERE (owner_user_id <> '' OR workspace_id <> '')
              AND (owner_user_id = '' OR owner_user_id = $1)
              AND (workspace_id = '' OR workspace_id = $2)
            RETURNING ${DOCUMENT_METADATA_COLUMNS}
          `,
          [scope.userId, scope.workspaceId]
        )
      : await query(
          `
            DELETE FROM ${tableName}
            RETURNING ${DOCUMENT_METADATA_COLUMNS}
          `
        );

    return (result?.rows ?? []).map(mapRowToStoredDocument);
  },
});

const getDocumentRegistryStore = () =>
  configuredDocumentRegistryStore ?? createDocumentRegistryStore();

/**
 * Whether other processes write the store behind this process's registry map,
 * so the map can miss documents they added and keep ones they deleted. True for
 * the PostgreSQL registry, in either ingest mode: every API instance and every
 * ingest worker process registers into the same table. False for the
 * file-backed registry (standalone: one process ingests) and for a store that
 * does not declare itself PostgreSQL, such as an in-memory test or evaluation
 * store. The default store counts only when a database is configured, since
 * without one it cannot answer at all.
 */
export const isDocumentRegistryShared = () =>
  configuredDocumentRegistryStore
    ? configuredDocumentRegistryStore.backend === DOCUMENT_REGISTRY_BACKENDS.postgres
    : isPostgresDatabaseConfigured();

const setDocumentRegistry = (documents = []) => {
  documentRegistry = new Map(
    documents.map((document) => [document.docId, toStoredDocument(document)])
  );
  documentRegistryInitialized = true;
};

export const normalizeDocIds = (docIds) => {
  if (Array.isArray(docIds)) {
    return [...new Set(docIds.map((docId) => normalizeDocId(docId)).filter(Boolean))];
  }

  if (typeof docIds === "string") {
    return [
      ...new Set(
        docIds
          .split(",")
          .map((docId) => normalizeDocId(docId))
          .filter(Boolean)
      ),
    ];
  }

  return [];
};

// The registry map is process-wide and every request filters it by scope, so
// it is always loaded as the owner role. Registering the first document can
// trigger this load from inside a tenant request; under that tenant the row
// policies would fill the shared map with one tenant's documents only.
export const initializeDocumentRegistry = async () => {
  if (documentRegistryInitialized) {
    return listDocuments();
  }

  const store = getDocumentRegistryStore();
  const documents = await runAsDatabaseSystem(async () => {
    if (store.initialize) {
      await store.initialize();
    }

    return store.list ? store.list() : [];
  });

  setDocumentRegistry(documents);
  return listDocuments();
};

/**
 * Read-only registry load: lists the stored documents and populates the
 * in-memory map WITHOUT calling store.initialize(), which would run migrations
 * (DDL). This is the load path for read-only callers such as the reindex
 * dry-run, which must inspect the registry without altering the schema. It
 * reads whatever the documents table currently holds; if that table does not
 * exist yet, store.list() surfaces the underlying error to the caller rather
 * than silently creating it.
 */
export const readDocumentRegistrySnapshot = async (accessScope = {}) => {
  const store = getDocumentRegistryStore();
  const documents = await runAsDatabaseSystem(() => (store.list ? store.list() : []));

  setDocumentRegistry(documents);
  return listDocuments(accessScope);
};

export const configureDocumentRegistryStore = (store) => {
  configuredDocumentRegistryStore = store ?? null;
  documentRegistry = new Map();
  documentRegistryInitialized = false;
  legacyImportAttempted = false;
};

export const registerDocument = async (document, { client = null } = {}) => {
  if (!documentRegistryInitialized) {
    await initializeDocumentRegistry();
  }

  const store = getDocumentRegistryStore();
  const storedDocument = store.upsert
    ? await store.upsert(document, { client })
    : toStoredDocument(document);

  documentRegistry.set(storedDocument.docId, toStoredDocument(storedDocument));
  return getDocument(storedDocument.docId);
};

export const hasDocument = (docId) => documentRegistry.has(normalizeDocId(docId));

const compareByUploadOrder = (left, right) =>
  left.uploadedAt.localeCompare(right.uploadedAt) || left.docId.localeCompare(right.docId);

/**
 * The document exactly this owner and workspace stored with bytes that hash to
 * `contentSha256`, or null (the stored form, not the public one). A PostgreSQL
 * store answers, so another process's upload counts, on `client` when the
 * caller is inside its ingest transaction. A store that cannot (the file-backed
 * registry, an evaluation store) has one writer, this process, whose map then
 * answers. The map is not changed here: a caller that returns the document
 * loads it (loadDocumentsFromStore) once its transaction settled.
 */
export const findDocumentByContentHash = async (contentSha256, owner = {}, { client = null } = {}) => {
  const hash = normalizeContentSha256(contentSha256);

  if (!hash) {
    return null;
  }

  const { ownerUserId, workspaceId } = toOwnerKey(owner);
  const store = getDocumentRegistryStore();

  // The database answers whenever it is the registry other processes write,
  // and always inside a caller's transaction.
  if (typeof store.findByContentHash === "function" && (client || isDocumentRegistryShared())) {
    const found = await store.findByContentHash(hash, { ownerUserId, workspaceId }, { client });

    return found ? toStoredDocument(found) : null;
  }

  // A configured single-writer store is loaded once; without one (no database
  // and no file registry) there is nothing to have stored.
  if (!documentRegistryInitialized && configuredDocumentRegistryStore) {
    await initializeDocumentRegistry();
  }

  return (
    [...documentRegistry.values()]
      .filter(
        (document) =>
          document.contentSha256 === hash &&
          document.ownerUserId === ownerUserId &&
          document.workspaceId === workspaceId
      )
      .sort(compareByUploadOrder)[0] ?? null
  );
};

/**
 * Inside an ingest transaction on a PostgreSQL store: holds the tenant's lock
 * on `contentSha256` until COMMIT, so an identical upload racing this one
 * waits and then finds this document. Other stores have one writer and take
 * no lock here (rag/index.js serializes identical uploads in process).
 */
export const lockDocumentContentHash = async (contentSha256, owner = {}, { client = null } = {}) => {
  const store = getDocumentRegistryStore();

  if (client && typeof store.lockContentHash === "function") {
    await store.lockContentHash(contentSha256, toOwnerKey(owner), { client });
    return true;
  }

  return false;
};

/**
 * The row a replacement is about to change, locked until the caller's
 * transaction ends (PostgreSQL store with `client`), or this process's entry.
 * Null when the document is gone. The stored form, as findDocumentByContentHash.
 */
export const lockDocumentForContentReplace = async (docId, { client = null } = {}) => {
  const store = getDocumentRegistryStore();

  if (client && typeof store.lockForContentReplace === "function") {
    const locked = await store.lockForContentReplace(docId, { client });

    return locked ? toStoredDocument(locked) : null;
  }

  if (!documentRegistryInitialized) {
    await initializeDocumentRegistry();
  }

  const current = documentRegistry.get(normalizeDocId(docId));

  return current ? toStoredDocument(current) : null;
};

/**
 * Re-reads one document from the store and replaces the in-process copy.
 *
 * registerDocument/deleteDocument update the in-memory map as soon as the
 * store call returns, which is right on the pool but wrong inside a
 * transaction that later rolls back. The ingest path calls this on rollback
 * so the map reflects what the database actually committed.
 */
export const resyncDocument = async (docId) => {
  const normalizedDocId = normalizeDocId(docId);

  if (!normalizedDocId) {
    return null;
  }

  // Same reason as the initial load: the map entry is shared by all tenants,
  // so whether the row exists is read as the owner. Only the metadata is read
  // when the store can, not the file bytes.
  const store = getDocumentRegistryStore();
  const storedDocument = await runAsDatabaseSystem(async () => {
    if (store.listByIds) {
      return (await store.listByIds([normalizedDocId]))[0] ?? null;
    }

    return store.getFile ? (await store.getFile(normalizedDocId))?.document ?? null : null;
  });

  const previous = documentRegistry.get(normalizedDocId);
  const next = storedDocument ? toStoredDocument(storedDocument) : null;

  if (next) {
    documentRegistry.set(normalizedDocId, next);
  } else {
    documentRegistry.delete(normalizedDocId);
  }

  if (isContentChange(previous, next)) {
    notifyDocumentStoreChange([normalizedDocId]);
  }

  return getDocument(normalizedDocId);
};

/**
 * Marks `docIds` (one id or a list) as written by this process until
 * `callback` settles. The pgvector ingest, delete and clear paths change the
 * map inside their transaction, before COMMIT, and a store read on another
 * connection cannot see that write yet; a refresh or a named load leaves such a
 * document as this process has it, including one whose write settled while the
 * read was in flight. `callback` receives `track(ids)`, which marks more ids
 * the same way until the callback settles: a clear learns which rows it
 * deleted only from its DELETE, inside the transaction.
 */
export const trackDocumentWrite = async (docIds, callback) => {
  const tracked = [];
  const touch = (ids) => {
    for (const touched of activeRefreshes) {
      for (const docId of ids) {
        touched.add(docId);
      }
    }
  };
  const track = (ids) => {
    const added = normalizeDocIds(Array.isArray(ids) ? ids : [ids]);

    for (const docId of added) {
      documentWritesInFlight.set(docId, (documentWritesInFlight.get(docId) ?? 0) + 1);
      tracked.push(docId);
    }

    touch(added);
  };

  track(docIds);

  try {
    return await callback(track);
  } finally {
    for (const docId of tracked) {
      const remaining = (documentWritesInFlight.get(docId) ?? 1) - 1;

      if (remaining > 0) {
        documentWritesInFlight.set(docId, remaining);
      } else {
        documentWritesInFlight.delete(docId);
      }
    }

    touch(tracked);
  }
};

// The map is filled at startup and updated by this process's own writes, so a
// document another process committed (an API instance's upload, an ingest
// worker's job) is invisible here until it is read back, and one another
// process deleted stays until then. Both readers below read as the owner for
// the same reason as the initial load, and apply a store row only to an entry
// this process neither is writing (trackDocumentWrite) nor changed while the
// read was in flight: the read may predate that write, and before its COMMIT
// another connection still sees the old row. Callers use them only when
// isDocumentRegistryShared().

/**
 * Runs `read` with a set that collects every id written while it runs (and
 * starts with the ids being written now); see trackDocumentWrite.
 */
const readWhileTrackingWrites = async (read) => {
  const touched = new Set(documentWritesInFlight.keys());

  activeRefreshes.add(touched);

  try {
    return { result: await read(), touched };
  } finally {
    activeRefreshes.delete(touched);
  }
};

/**
 * Brings the named documents in line with the store: adds the ones another
 * process registered, replaces a held entry with its stored row, and drops an
 * entry whose row is gone (another process deleted it). A docId the store does
 * not know stays missing. Returns the ids it added.
 */
export const loadDocumentsFromStore = async (docIds) => {
  const requestedDocIds = normalizeDocIds(docIds);

  if (requestedDocIds.length === 0) {
    return [];
  }

  if (!documentRegistryInitialized) {
    await initializeDocumentRegistry();
  }

  const before = new Map(requestedDocIds.map((docId) => [docId, documentRegistry.get(docId)]));
  const store = getDocumentRegistryStore();
  const { result: storedDocuments, touched } = await readWhileTrackingWrites(() =>
    runAsDatabaseSystem(async () => {
      if (store.listByIds) {
        return store.listByIds(requestedDocIds);
      }

      const wanted = new Set(requestedDocIds);
      const documents = store.list ? await store.list() : [];

      return documents.filter((document) => wanted.has(normalizeDocId(document.docId)));
    })
  );
  const stored = new Map(
    storedDocuments
      .map((document) => toStoredDocument(document))
      .filter((document) => document.docId)
      .map((document) => [document.docId, document])
  );
  const loaded = [];
  const changed = [];

  for (const docId of requestedDocIds) {
    if (touched.has(docId) || documentRegistry.get(docId) !== before.get(docId)) {
      continue;
    }

    if (stored.has(docId)) {
      documentRegistry.set(docId, stored.get(docId));

      if (!before.get(docId)) {
        loaded.push(docId);
      }
    } else if (before.get(docId)) {
      documentRegistry.delete(docId);
    }

    if (isContentChange(before.get(docId), stored.get(docId))) {
      changed.push(docId);
    }
  }

  notifyDocumentStoreChange(changed);
  return loaded;
};

const refreshFromStore = async (accessScope) => {
  const before = new Map(documentRegistry);
  const store = getDocumentRegistryStore();
  const { result: storedDocuments, touched } = await readWhileTrackingWrites(() =>
    runAsDatabaseSystem(async () =>
      (store.list ? await store.list(accessScope) : []).filter((document) =>
        documentMatchesAccessScope(toStoredDocument(document), accessScope)
      )
    )
  );
  const stored = new Map(
    storedDocuments
      .map((document) => toStoredDocument(document))
      .filter((document) => document.docId)
      .map((document) => [document.docId, document])
  );

  const changed = [];

  for (const docId of new Set([...before.keys(), ...stored.keys()])) {
    if (touched.has(docId) || documentRegistry.get(docId) !== before.get(docId)) {
      continue;
    }

    if (stored.has(docId)) {
      documentRegistry.set(docId, stored.get(docId));
    } else if (documentMatchesAccessScope(before.get(docId), accessScope)) {
      // Only an entry the listing covered can be missing from it.
      documentRegistry.delete(docId);
    } else {
      continue;
    }

    if (isContentChange(before.get(docId), stored.get(docId))) {
      changed.push(docId);
    }
  }

  notifyDocumentStoreChange(changed);
};

const noop = () => {};

const startRefresh = (key, scope, queue) => {
  const refresh = refreshFromStore(scope).finally(() => {
    if (queue.running === refresh) {
      queue.running = null;
    }

    if (!queue.running && !queue.next && refreshQueues.get(key) === queue) {
      refreshQueues.delete(key);
    }
  });

  queue.running = refresh;
  return refresh;
};

/**
 * Re-lists the store for `accessScope` (everything when it is empty) and
 * brings that part of the map in line with it: documents other processes added
 * appear and ones they deleted go, while other tenants' entries are left
 * alone, so a request reads its own tenant's rows and not every tenant's. An
 * entry this process set or removed after the listing started is kept as this
 * process left it, because the listing may predate that write, and so is one
 * this process is writing in a transaction (trackDocumentWrite).
 *
 * A caller waits for a listing that starts after it arrived: one already in
 * flight may predate a write the caller knows of (another instance's 201 or
 * delete). Callers with the same scope that arrive while a listing runs share
 * the one queued behind it, so a scope has at most one listing running and one
 * waiting.
 */
export const refreshDocumentRegistry = async (accessScope = {}) => {
  if (!documentRegistryInitialized) {
    await initializeDocumentRegistry();
    return listDocuments(accessScope);
  }

  const scope = normalizeAccessScope(accessScope);
  const key = `${scope.userId}\u0000${scope.workspaceId}`;
  let queue = refreshQueues.get(key);

  if (!queue) {
    queue = { next: null, running: null };
    refreshQueues.set(key, queue);
  }

  let refresh = queue.next;

  if (!refresh && queue.running) {
    refresh = queue.running.then(noop, noop).then(() => {
      queue.next = null;
      return startRefresh(key, scope, queue);
    });
    queue.next = refresh;
  } else if (!refresh) {
    refresh = startRefresh(key, scope, queue);
  }

  await refresh;
  return listDocuments(scope);
};

export const getStoredDocument = (docId, accessScope = {}) => {
  const document = documentRegistry.get(normalizeDocId(docId)) ?? null;

  return documentMatchesAccessScope(document, accessScope) ? document : null;
};

export const getDocument = (docId, accessScope = {}) =>
  toPublicDocument(getStoredDocument(docId, accessScope));

export const getDocuments = (docIds, accessScope = {}) =>
  normalizeDocIds(docIds)
    .map((docId) => getDocument(docId, accessScope))
    .filter(Boolean);

export const listDocuments = (accessScope = {}) =>
  [...documentRegistry.values()]
    .filter((document) => documentMatchesAccessScope(document, accessScope))
    .sort((left, right) => left.uploadedAt.localeCompare(right.uploadedAt))
    .map((document) => toPublicDocument(document));

export const getDocumentFile = async (docId, accessScope = {}) => {
  const store = getDocumentRegistryStore();

  return store.getFile ? store.getFile(docId, accessScope) : null;
};

/**
 * Deletes a document this caller can see. Null when the map does not hold it
 * for the scope, or when the store deleted nothing (another process deleted
 * the row): the stale entry is dropped either way and the caller answers 404.
 */
export const deleteDocument = async (
  docId,
  accessScope = {},
  { client = null } = {}
) => {
  const storedDocument = getStoredDocument(docId, accessScope);

  if (!storedDocument) {
    return null;
  }

  const store = getDocumentRegistryStore();
  const deleted = store.delete ? await store.delete(docId, accessScope, { client }) : undefined;

  documentRegistry.delete(normalizeDocId(docId));
  return deleted === null ? null : toPublicDocument(storedDocument);
};

/**
 * Clears the scope's documents (every document for an empty scope) from the
 * store and the map, and returns the documents cleared. A store that reports
 * what it deleted (the PostgreSQL store's DELETE ... RETURNING) decides: that
 * includes rows other processes registered that the map never loaded, and
 * leaves out ones another process had already deleted. Otherwise the map's own
 * listing stands in. `onCleared(docIds)` is called with those ids before the
 * map changes; rag/index.js passes trackDocumentWrite's `track`, so a refresh
 * whose listing predates the COMMIT does not bring them back. An entry another
 * write of this process has in flight (an ingest not committed yet, whose row
 * the DELETE could not see) is kept unless the store deleted it.
 */
export const clearDocuments = async ({
  accessScope = {},
  client = null,
  onCleared = null,
} = {}) => {
  const listed = listDocuments(accessScope);
  const otherWritesInFlight = new Set(documentWritesInFlight.keys());
  const store = getDocumentRegistryStore();
  const result = store.clear ? await store.clear(accessScope, { client }) : null;
  const cleared = Array.isArray(result)
    ? result
        .map((document) => toStoredDocument(document))
        .filter((document) => document.docId)
        .map((document) => toPublicDocument(document))
    : listed;
  const clearedDocIds = new Set(cleared.map((document) => document.docId));

  onCleared?.([...clearedDocIds]);

  for (const document of listed) {
    if (clearedDocIds.has(document.docId) || !otherWritesInFlight.has(document.docId)) {
      documentRegistry.delete(document.docId);
    }
  }

  for (const docId of clearedDocIds) {
    documentRegistry.delete(docId);
  }

  documentRegistryInitialized = true;
  return cleared;
};

/**
 * Fills content_sha256 (migration 018) for rows stored before it, in batches
 * the database hashes itself, so no PDF crosses the wire. Until a row has its
 * hash, an identical upload is not recognised as a duplicate of it. `dryRun`
 * only counts. Runs as the owner: every tenant's rows.
 */
export const backfillDocumentContentHashes = async ({
  batchSize = 100,
  dryRun = false,
  getDocumentsTable = getDocumentsPostgresTable,
  onBatch = null,
  queryPostgres = queryDefaultPostgres,
  runMigrations = runPostgresMigrations,
} = {}) =>
  runAsDatabaseSystem(async () => {
    await runMigrations();

    const tableName = ensureTableName(getDocumentsTable);
    const missing = async () =>
      Number(
        (
          await queryPostgres(
            `SELECT COUNT(*)::int AS missing FROM ${tableName} WHERE content_sha256 IS NULL`
          )
        ).rows[0]?.missing
      ) || 0;
    const before = await missing();

    if (dryRun || before === 0) {
      return { dryRun, hashed: 0, missing: before, remaining: before };
    }

    const limit = Math.max(1, Math.floor(Number(batchSize) || 100));
    let hashed = 0;

    for (;;) {
      const result = await queryPostgres(
        `
          WITH batch AS (
            SELECT doc_id
            FROM ${tableName}
            WHERE content_sha256 IS NULL
            ORDER BY doc_id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE ${tableName} AS d
          SET content_sha256 = encode(sha256(d.file_bytes), 'hex')
          FROM batch
          WHERE d.doc_id = batch.doc_id
          RETURNING d.doc_id
        `,
        [limit]
      );
      const count = result.rows.length;

      hashed += count;
      await onBatch?.({ count, hashed });

      if (count < limit) {
        break;
      }
    }

    return { dryRun, hashed, missing: before, remaining: await missing() };
  });

export const resetDocumentRegistry = async () => {
  documentRegistry = new Map();
  documentRegistryInitialized = false;
  legacyImportAttempted = false;
};

export const resetDocumentRegistryStore = async () => {
  const store = configuredDocumentRegistryStore;

  if (store?.reset) {
    await store.reset();
  }

  await resetDocumentRegistry();
  configuredDocumentRegistryStore = null;
};
