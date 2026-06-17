import { readFile } from "fs/promises";
import { getDocumentsPostgresTable } from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { createDocumentLegacyImporter } from "./document-legacy-importer.js";
import { buildPublicFilePath } from "./document-utils.js";
import { queryPostgres } from "./postgres.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

let configuredDocumentRegistryStore = null;
let documentRegistry = new Map();
let documentRegistryInitialized = false;
let legacyImportAttempted = false;

const toPositiveInteger = (value, fallbackValue = 0) => {
  const parsedValue = Number.parseInt(value ?? fallbackValue, 10);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallbackValue;
};

const ensureTableName = () => {
  const tableName = getDocumentsPostgresTable();

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

const hasAccessScope = (accessScope = {}) => {
  const scope = normalizeAccessScope(accessScope);

  return Boolean(scope.userId || scope.workspaceId);
};

const documentMatchesAccessScope = (document = {}, accessScope = {}) => {
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
    uploadedAt: document.uploadedAt ?? new Date().toISOString(),
    storageBackend: "postgresql",
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
      }
    : null;

const resolveFileBuffer = async ({ fileBuffer = null, sourceFilePath = "" } = {}) => {
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

const createDefaultStore = () => ({
  async initialize() {
    await runPostgresMigrations();

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

        const tableName = ensureTableName();
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

  async list(accessScope = {}) {
    const tableName = ensureTableName();
    const result = await queryPostgres(
      `
        SELECT doc_id, file_name, mime_type, file_size, chunk_count, page_count, owner_user_id, workspace_id, profile, uploaded_at
        FROM ${tableName}
        ORDER BY uploaded_at ASC, doc_id ASC
      `
    );

    return result.rows
      .map(mapRowToStoredDocument)
      .filter((document) => documentMatchesAccessScope(document, accessScope));
  },

  async upsert(document) {
    const normalizedDocument = toStoredDocument(document);

    if (!normalizedDocument.docId || !normalizedDocument.fileName) {
      throw new Error("Document registration requires both docId and fileName.");
    }

    const tableName = ensureTableName();
    const fileBuffer = await resolveFileBuffer({
      fileBuffer: document.fileBuffer,
      sourceFilePath: document.sourceFilePath,
    });
    const fileSize = normalizedDocument.fileSize || fileBuffer.byteLength;
    const result = await queryPostgres(
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
          uploaded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          uploaded_at = EXCLUDED.uploaded_at
        RETURNING doc_id, file_name, mime_type, file_size, chunk_count, page_count, owner_user_id, workspace_id, profile, uploaded_at
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
      ]
    );

    return mapRowToStoredDocument(result.rows[0]);
  },

  async getFile(docId, accessScope = {}) {
    const normalizedDocId = normalizeDocId(docId);

    if (!normalizedDocId) {
      return null;
    }

    const tableName = ensureTableName();
    const result = await queryPostgres(
      `
        SELECT doc_id, file_name, mime_type, file_size, file_bytes, chunk_count, page_count, owner_user_id, workspace_id, profile, uploaded_at
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

  async delete(docId, accessScope = {}) {
    const normalizedDocId = normalizeDocId(docId);

    if (!normalizedDocId) {
      return null;
    }

    const tableName = ensureTableName();
    const existingFile = await this.getFile(normalizedDocId, accessScope);

    if (!existingFile) {
      return null;
    }

    const result = await queryPostgres(
      `
        DELETE FROM ${tableName}
        WHERE doc_id = $1
        RETURNING doc_id, file_name, mime_type, file_size, chunk_count, page_count, owner_user_id, workspace_id, profile, uploaded_at
      `,
      [normalizedDocId]
    );

    return result.rows[0] ? mapRowToStoredDocument(result.rows[0]) : null;
  },

  async clear(accessScope = {}) {
    const tableName = ensureTableName();

    if (hasAccessScope(accessScope)) {
      const scopedDocuments = await this.list(accessScope);
      const scopedDocIds = scopedDocuments.map((document) => document.docId);

      if (scopedDocIds.length === 0) {
        return true;
      }

      await queryPostgres(
        `
          DELETE FROM ${tableName}
          WHERE doc_id = ANY($1::text[])
        `,
        [scopedDocIds]
      );
      return true;
    }

    await queryPostgres(`DELETE FROM ${tableName}`);
    return true;
  },
});

const getDocumentRegistryStore = () =>
  configuredDocumentRegistryStore ?? createDefaultStore();

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

export const initializeDocumentRegistry = async () => {
  if (documentRegistryInitialized) {
    return listDocuments();
  }

  const store = getDocumentRegistryStore();

  if (store.initialize) {
    await store.initialize();
  }

  const documents = store.list ? await store.list() : [];
  setDocumentRegistry(documents);
  return listDocuments();
};

export const configureDocumentRegistryStore = (store) => {
  configuredDocumentRegistryStore = store ?? null;
  documentRegistry = new Map();
  documentRegistryInitialized = false;
  legacyImportAttempted = false;
};

export const registerDocument = async (document) => {
  if (!documentRegistryInitialized) {
    await initializeDocumentRegistry();
  }

  const store = getDocumentRegistryStore();
  const storedDocument = store.upsert
    ? await store.upsert(document)
    : toStoredDocument(document);

  documentRegistry.set(storedDocument.docId, toStoredDocument(storedDocument));
  return getDocument(storedDocument.docId);
};

export const hasDocument = (docId) => documentRegistry.has(normalizeDocId(docId));

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

export const deleteDocument = async (docId, accessScope = {}) => {
  const storedDocument = getStoredDocument(docId, accessScope);

  if (!storedDocument) {
    return null;
  }

  const store = getDocumentRegistryStore();

  if (store.delete) {
    await store.delete(docId, accessScope);
  }

  documentRegistry.delete(normalizeDocId(docId));
  return toPublicDocument(storedDocument);
};

export const clearDocuments = async ({ accessScope = {} } = {}) => {
  const documents = listDocuments(accessScope);
  const store = getDocumentRegistryStore();

  if (store.clear) {
    await store.clear(accessScope);
  }

  if (hasAccessScope(accessScope)) {
    for (const document of documents) {
      documentRegistry.delete(normalizeDocId(document.docId));
    }
  } else {
    documentRegistry = new Map();
  }

  documentRegistryInitialized = true;
  return documents;
};

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
