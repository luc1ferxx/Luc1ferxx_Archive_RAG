import { createHash, randomUUID } from "node:crypto";
import { readFile as readBinaryFile } from "node:fs/promises";
import { chunkDocument } from "./chunker.js";
import { isAgentFollowUpOriginalQuestionEnabled } from "./config.js";
import { areConversationMemoryWritesSuppressed } from "./conversation-memory-writes.js";
import {
  clearDocuments as clearRegisteredDocuments,
  deleteDocument as deleteRegisteredDocument,
  documentMatchesAccessScope,
  eraseStoredDocuments,
  findDocumentByContentHash,
  getDocument,
  getDocumentFile,
  getDocuments,
  getStoredDocument,
  initializeDocumentRegistry,
  isDocumentRegistryShared,
  listDocuments,
  listStoredDocumentsForTenant,
  loadDocumentsFromStore,
  lockDocumentContentHash,
  lockDocumentForContentReplace,
  normalizeContentSha256,
  normalizeDocIds,
  refreshDocumentRegistry,
  registerDocument,
  resolveFileBuffer,
  resyncDocument,
  trackDocumentWrite,
} from "./doc-registry.js";
import { buildPublicFilePath } from "./document-utils.js";
import { buildDocumentProfile } from "./document-profiler.js";
import {
  executeDocumentRag,
  normalizeRetrievalPlan,
} from "./document-rag-execution.js";
import {
  clearLongMemories,
  deleteLongMemory,
  getLongMemoryContext,
  initializeLongMemory,
  listLongMemories,
  recordLongMemoryFromUserMessage,
  rememberLongMemory,
} from "./long-memory.js";
import {
  clearSessionMemory,
  initializeSessionMemory,
  recordSessionTurn,
  resolveQueryWithSessionMemory,
} from "./memory.js";
import { runDocumentDeletionCascade } from "./document-deletion-cascade.js";
import { recordRagTrace } from "./observability.js";
import { invalidateSemanticCacheDocuments } from "./semantic-cache.js";
import { loadPdfPages } from "./pdf-loader.js";
import { withPostgresTransaction } from "./postgres.js";
import { STAGED_INGEST } from "./ingest-stages.js";
import {
  assertTenantStorageQuota,
  describeStorageQuotaScopeKey,
  getTenantStorageQuotaLimits,
  hasTenantStorageQuota,
  lockTenantStorageQuota,
  resolveStorageQuotaScope,
} from "./tenant-storage-quota.js";
import { recordTenantUsage, TENANT_USAGE_METRICS } from "./tenant-usage.js";
import {
  beginVectorIndexWrite,
  clearVectorIndex,
  countDocumentChunksForErase,
  eraseDocumentsFromIndex,
  embedDocumentTextsForIndex,
  embedTextsForIndexWrite,
  ensureVectorStoreReady,
  isVectorStoreTransactional,
  prepareDocumentsForIndex,
  removeDocumentsFromIndex,
  stampPreparedDocumentVersion,
  writeDocumentsToIndex,
} from "./vector-store.js";

export {
  clearLongMemories,
  clearSessionMemory,
  deleteLongMemory,
  getDocument,
  getDocumentFile,
  getDocuments,
  initializeDocumentRegistry,
  initializeLongMemory,
  initializeSessionMemory,
  isDocumentRegistryShared,
  listDocuments,
  listLongMemories,
  loadDocumentsFromStore,
  refreshDocumentRegistry,
  rememberLongMemory,
  resyncDocument,
};

const getPageNumber = (metadata = {}, fallbackPageNumber = null) =>
  metadata.loc?.pageNumber ?? metadata.pageNumber ?? metadata.page ?? fallbackPageNumber;

// ---------------------------------------------------------------------------
// Ingestion
//
// One ingest is three steps after parsing: chunk the pages, embed the chunks,
// and commit the document with its chunks. A synchronous upload runs them in
// the request (ingestDocument); an async job runs them as the persisted stages
// of rag/ingest-pipeline.js, with the embeddings of concurrent jobs batched.
// Both end in commitDocument, so they index identically.
// ---------------------------------------------------------------------------

const createStatusError = (message, status, extra = {}) =>
  Object.assign(new Error(message), { expose: true, status, ...extra });

export const hashDocumentBytes = (fileBuffer) =>
  createHash("sha256").update(fileBuffer).digest("hex");

/** Chunk stage: the pages as chunk documents, plus what the registry records. */
export const chunkDocumentPages = ({ docId, fileName, pages, source = null }) => {
  const publicFilePath = buildPublicFilePath(docId);
  const chunks = chunkDocument({
    docId,
    fileName,
    publicFilePath,
    pages,
    source,
  });

  if (chunks.length === 0) {
    // 422: the upload itself is the problem, and a retry reads the same bytes.
    const error = new Error("No extractable text was found in the uploaded PDF.");
    error.status = 422;
    throw error;
  }

  return {
    documents: chunks.map((chunk) => ({
      id: chunk.id,
      pageContent: chunk.pageContent,
      metadata: chunk.metadata,
    })),
    pageCount: pages.length,
    profile: buildDocumentProfile({
      fileName,
      pages,
      source,
    }),
  };
};

/**
 * Embed stage: the chunks embedded in every space the write will most likely
 * need (vector-store.js getIndexWriteEmbeddingSpaces), through `embedInSpace`
 * -- the ingest worker passes its cross-document batcher. The provider is
 * checked first, so a misconfigured store fails before any embedding is paid.
 */
export const embedDocumentChunks = async ({
  documents,
  embedInSpace = embedDocumentTextsForIndex,
}) => {
  await ensureVectorStoreReady();

  // A space only a non-serving index version uses is best effort: when it
  // fails, that version is fenced instead of failing the job
  // (vector-store.js embedTextsForIndexWrite).
  return embedTextsForIndexWrite({
    embedInSpace,
    texts: documents.map((document) => document.pageContent),
  });
};

// Identical uploads of one tenant wait for each other in this process where no
// database lock can (the file-backed registry, a non-transactional provider).
const contentLocks = new Map();

const withProcessContentLock = async (key, callback) => {
  const previous = contentLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);

  contentLocks.set(key, chained);

  try {
    await previous;
    return await callback();
  } finally {
    release();

    if (contentLocks.get(key) === chained) {
      contentLocks.delete(key);
    }
  }
};

const toTime = (value) => {
  const time = Date.parse(String(value ?? ""));

  return Number.isNaN(time) ? null : time;
};

// A replacement requested before the document's current content was requested
// finished late: the newer content stays.
const isSupersededReplacement = (current, requestedAt) => {
  const requested = toTime(requestedAt);
  const currentUpdated = toTime(current?.updatedAt);

  return requested !== null && currentUpdated !== null && requested < currentUpdated;
};

const createDocumentGoneError = (docId) =>
  createStatusError(`Document not found for docId ${docId}.`, 404, { retryable: false });

export const REPLACEMENT_NEEDS_TRANSACTION_MESSAGE =
  "Replacing a document's content needs VECTOR_STORE_PROVIDER=pgvector: the local and Qdrant indexes cannot swap a document's chunks atomically, so a failed write would leave the document with none. Delete the document and upload the new PDF instead.";

/**
 * Whether PUT /documents/:docId can replace a document: only on a provider
 * that swaps the chunks and the registry row in one transaction (pgvector).
 */
export const supportsDocumentReplacement = () => isVectorStoreTransactional();

const createReplacementUnsupportedError = () =>
  createStatusError(REPLACEMENT_NEEDS_TRANSACTION_MESSAGE, 409, { retryable: false });

// Identical uploads of one tenant, when other processes write the same
// PostgreSQL registry (a non-transactional index with dedicated ingest
// workers): the tenant-and-hash advisory lock the pgvector path takes inside
// its write transaction, held here by a transaction of its own around the
// check, the index write and the registration. The registration commits on
// the pool before the lock is released, so the upload waiting on the lock
// finds it.
const withSharedContentLock = async (hash, owner, callback) => {
  if (!isDocumentRegistryShared()) {
    return callback(null);
  }

  return withPostgresTransaction(async (lockClient) => {
    if (!(await lockDocumentContentHash(hash, owner, { client: lockClient }))) {
      return callback(null);
    }

    return callback(lockClient);
  });
};

/**
 * Index stage, and the end of every synchronous ingest: registers the
 * document and writes its chunks to every index version that must stay
 * complete, in one transaction on pgvector.
 *
 * - mode "create" with `deduplicate`: under a tenant-and-hash lock, bytes this
 *   owner and workspace already stored resolve to that document instead
 *   (`duplicate`), so identical uploads racing each other end as one.
 * - mode "replace" (pgvector only; without a transaction it is refused with a
 *   409 before anything is written): locks the document row, keeps docId, owner and uploadedAt,
 *   bumps the content version and swaps the chunks in the same transaction, so
 *   a search sees the old chunks or the new ones and never neither; the old
 *   version's chunks are gone once it commits. A replacement older than the
 *   document's current content (`requestedAt`) changes nothing (`superseded`).
 * - `onCommit({ client, docId, duplicate, superseded, documentVersion })`
 *   runs inside that transaction (client set) on pgvector, so an ingest job
 *   records its success atomically with the document; it runs after the
 *   writes (client null) elsewhere. Throwing from it rolls the write back.
 * - Storage quotas (TENANT_MAX_DOCUMENTS / TENANT_MAX_DOCUMENT_BYTES, off by
 *   default; rag/tenant-storage-quota.js): a create that would take the
 *   owner's workspace (else the user's workspace-less documents) over a quota,
 *   or a replacement that grows it past the byte quota, is refused with
 *   TENANT_STORAGE_QUOTA_EXCEEDED before anything is written. Commits into
 *   one quota scope first take turns in this process, before any of them
 *   checks out a pooled connection, so a burst of uploads into one workspace
 *   holds at most one connection here instead of parking one per upload
 *   (which starved every other tenant of the pool and, on local / Qdrant with
 *   a PostgreSQL registry, left the turn's holder waiting forever for a
 *   second connection). On pgvector the check then runs in the transaction
 *   under an advisory lock on the quota scope (across processes), taken after
 *   the content-hash lock and before the replacement's row lock; elsewhere it
 *   runs under that in-process turn, on the content-lock transaction's
 *   connection when there is one. A duplicate resolves before the quota is
 *   read.
 * - A committed create or replacement adds its bytes (and a create one
 *   document) to the owner's usage ledger (rag/tenant-usage.js), in memory.
 *
 * Resolves to { document, docId, duplicate, superseded, documentVersion }.
 */
export const commitDocument = async ({
  docId,
  fileName,
  filePath = null,
  fileBuffer = null,
  documents,
  vectorsBySpace = null,
  pageCount,
  profile,
  ownerUserId = "",
  workspaceId = "",
  source = null,
  contentSha256 = null,
  mode = "create",
  deduplicate = false,
  requestedAt = null,
  onCommit = null,
}) => {
  const bytes = await resolveFileBuffer({ fileBuffer, sourceFilePath: filePath });
  const hash = normalizeContentSha256(contentSha256) ?? hashDocumentBytes(bytes);
  const replacing = mode === "replace";
  const checkDuplicate = !replacing && deduplicate;
  const owner = { ownerUserId, workspaceId };
  const quotaLimits = getTenantStorageQuotaLimits();
  const quotaScope = hasTenantStorageQuota(quotaLimits)
    ? resolveStorageQuotaScope({ ownerUserId, workspaceId })
    : null;
  // This process's commits into one quota scope, one at a time, before any
  // of them checks out a database connection (see the doc comment above).
  const withQuotaScopeTurn = (callback) =>
    quotaScope ? withProcessContentLock(describeStorageQuotaScopeKey(quotaScope), callback) : callback();
  const now = new Date().toISOString();
  const hasRequestTime = toTime(requestedAt) !== null;
  const contentRequestedAt = hasRequestTime ? new Date(requestedAt).toISOString() : now;
  const registrationFor = (current) => ({
    docId,
    fileName,
    fileBuffer: bytes,
    publicFilePath: buildPublicFilePath(docId),
    chunkCount: documents.length,
    pageCount,
    ownerUserId: current ? current.ownerUserId : ownerUserId,
    workspaceId: current ? current.workspaceId : workspaceId,
    profile,
    source,
    uploadedAt: current ? current.uploadedAt : now,
    contentSha256: hash,
    version: current ? current.version + 1 : 1,
    updatedAt: contentRequestedAt,
    // Without a request time (a synchronous upload or replacement) the
    // PostgreSQL registry stamps the content with its own clock, the one an
    // async job's request time comes from, so replacements from several hosts
    // are ordered by one clock. The file registry has one writer and keeps
    // this process's time.
    contentUpdatedAtFromDatabase: !hasRequestTime,
  });

  // The provider is checked first (database, extension, embedding width) so a
  // misconfigured store fails with its own reason before any embedding is
  // paid for. Embeddings are then computed (or taken from the embed stage)
  // before any storage is touched: for pgvector that keeps the remote
  // embedding call outside the transaction.
  await ensureVectorStoreReady();

  const prepared = await prepareDocumentsForIndex({ documents, vectorsBySpace });

  // What one attempt decided, for the response and for onCommit.
  const decide = async ({ client, current = null, duplicateOf = null, superseded = false }) => {
    const outcome = {
      docId: duplicateOf ? duplicateOf.docId : docId,
      documentVersion: duplicateOf
        ? duplicateOf.version
        : superseded
          ? current.version
          : current
            ? current.version + 1
            : 1,
      duplicate: Boolean(duplicateOf),
      superseded,
    };

    await onCommit?.({ client, ...outcome });
    return outcome;
  };

  const finish = async (outcome) => {
    // Answers built on the document's earlier content leave the semantic
    // answer cache now; their keys name the old content version anyway.
    invalidateSemanticCacheDocuments([docId]);

    if (!outcome.duplicate && !outcome.superseded) {
      recordTenantUsage(
        { userId: ownerUserId, workspaceId },
        {
          [TENANT_USAGE_METRICS.ingestedBytes]: bytes.length,
          [TENANT_USAGE_METRICS.documents]: replacing ? 0 : 1,
        }
      );
    }

    if (outcome.docId !== docId || outcome.superseded) {
      // A document this write did not change: read it the way another
      // process's write would be read.
      await loadDocumentsFromStore([outcome.docId]);
    }

    return { ...outcome, document: getDocument(outcome.docId) };
  };

  if (isVectorStoreTransactional()) {
    // One transaction for the document row and every chunk row. The registry
    // row goes first because the chunk table's foreign key points at it; if
    // either write fails the whole thing rolls back and the in-memory registry
    // is resynced from what the database actually holds. The map changes
    // before COMMIT, so the write is tracked until it settles.
    return trackDocumentWrite(docId, async () => {
      let outcome;

      try {
        outcome = await withQuotaScopeTurn(() => withPostgresTransaction(async (transactionClient) => {
          // The index write lock comes first: it must precede the
          // transaction's first documents-row lock
          // (vector-store-pgvector-versions.js). The content lock and the
          // replacement's row lock come after it, in that order.
          const client = await beginVectorIndexWrite({ client: transactionClient });

          if (checkDuplicate) {
            await lockDocumentContentHash(hash, owner, { client });

            const existing = await findDocumentByContentHash(hash, owner, { client });

            if (existing && existing.docId !== docId) {
              return decide({ client, duplicateOf: existing });
            }
          }

          // Commits into one quota scope of several processes queue here
          // (after the content lock, before the replacement's row lock);
          // this process's own already took turns (withQuotaScopeTurn).
          if (quotaScope) {
            await lockTenantStorageQuota(quotaScope, { client });
          }

          let current = null;

          if (replacing) {
            current = await lockDocumentForContentReplace(docId, { client });

            if (!current || !documentMatchesAccessScope(current, { userId: ownerUserId, workspaceId })) {
              throw createDocumentGoneError(docId);
            }

            if (isSupersededReplacement(current, requestedAt)) {
              return decide({ client, current, superseded: true });
            }
          }

          if (quotaScope) {
            await assertTenantStorageQuota({
              addedBytes: replacing ? bytes.length - (Number(current?.fileSize) || 0) : bytes.length,
              addedDocuments: replacing ? 0 : 1,
              client,
              limits: quotaLimits,
              ownerUserId,
              workspaceId,
            });
          }

          const registration = registrationFor(current);

          await registerDocument(registration, { client });
          await writeDocumentsToIndex({
            accessScope: { userId: registration.ownerUserId, workspaceId: registration.workspaceId },
            client,
            prepared: stampPreparedDocumentVersion(prepared, registration.version),
          });
          return decide({ client, current });
        }));
      } catch (error) {
        try {
          await resyncDocument(docId);
        } catch (resyncError) {
          console.error(
            `Failed to resync document registry entry for docId ${docId} after rollback.`,
            resyncError
          );
        }

        throw error;
      }

      return finish(outcome);
    });
  }

  // Without a database transaction a document's chunks cannot be swapped
  // atomically: the old ones would go before the new ones are written, and a
  // failed write would leave the document with none. So no replacement here.
  if (replacing) {
    throw createReplacementUnsupportedError();
  }

  // Without a database transaction the index is written first and the
  // registry last, so a registered document always has its chunks.
  const write = async (lockClient = null) => {
    if (checkDuplicate) {
      const existing = await findDocumentByContentHash(hash, owner, { client: lockClient });

      if (existing && existing.docId !== docId) {
        return decide({ client: null, duplicateOf: existing });
      }
    }

    if (quotaScope) {
      // On the content-lock transaction's connection when it holds one: a
      // second pooled connection here could wait forever behind uploads that
      // each hold one.
      await assertTenantStorageQuota({
        addedBytes: bytes.length,
        addedDocuments: 1,
        client: lockClient,
        limits: quotaLimits,
        ownerUserId,
        workspaceId,
      });
    }

    const registration = registrationFor(null);

    try {
      await writeDocumentsToIndex({
        accessScope: { userId: registration.ownerUserId, workspaceId: registration.workspaceId },
        prepared: stampPreparedDocumentVersion(prepared, registration.version),
      });
      await registerDocument(registration);
    } catch (error) {
      // Rolled back unconditionally, not only when the index write resolved.
      // The local provider writes the dense and sparse indexes concurrently,
      // so a rejection can still leave one of them populated -- and orphaned
      // sparse entries are not merely dead weight: they feed the corpus-wide
      // BM25 statistics in sparse-store.js, skewing scores for every other
      // document. Both removals ignore ids they do not hold, so this is safe
      // when nothing was written.
      try {
        await removeDocumentsFromIndex({
          docIds: [docId],
        });
      } catch (rollbackError) {
        console.error(
          `Failed to roll back vector index entries for docId ${docId}.`,
          rollbackError
        );
      }

      throw error;
    }

    return decide({ client: null });
  };

  // Identical uploads wait for each other in this process, and, when other
  // processes write the same PostgreSQL registry, across processes too. With
  // a storage quota, writes into one quota scope then take turns in this
  // process (so the count each reads includes the ones before it), before
  // the content-lock transaction checks out its connection. Lock order: the
  // content hash, then the quota scope, then the connection.
  const outcome = checkDuplicate
    ? await withProcessContentLock(`${ownerUserId}\u0000${workspaceId}\u0000${hash}`, () =>
        withQuotaScopeTurn(() => withSharedContentLock(hash, owner, write))
      )
    : await withQuotaScopeTurn(() => write());

  return finish(outcome);
};

// The document an ingest answers with: the registry's public document, and
// `duplicate: true` when the bytes resolved to a document the tenant already
// had (the route then answers 200 instead of 201).
const toIngestResponse = (outcome) =>
  outcome.duplicate || outcome.superseded
    ? {
        ...(outcome.document ?? { docId: outcome.docId }),
        ...(outcome.duplicate ? { duplicate: true } : {}),
        ...(outcome.superseded ? { superseded: true } : {}),
      }
    : outcome.document;

export const ingestDocumentPages = async ({
  docId,
  filePath,
  fileName,
  pages,
  ownerUserId = "",
  workspaceId = "",
  source = null,
  fileBuffer = null,
  contentSha256 = null,
  deduplicate = false,
  replace = false,
  requestedAt = null,
}) => {
  const chunked = chunkDocumentPages({ docId, fileName, pages, source });

  return toIngestResponse(
    await commitDocument({
      contentSha256,
      deduplicate,
      docId,
      documents: chunked.documents,
      fileBuffer,
      fileName,
      filePath,
      mode: replace ? "replace" : "create",
      ownerUserId,
      pageCount: chunked.pageCount,
      profile: chunked.profile,
      requestedAt,
      source,
      workspaceId,
    })
  );
};

/**
 * The document this owner and workspace already stored with these bytes
 * (public form, with `duplicate: true`), or null. Cheap: one indexed lookup,
 * before any parsing or embedding. commitDocument checks again under a lock.
 */
export const findDuplicateDocument = async ({
  contentSha256,
  docId = null,
  ownerUserId = "",
  workspaceId = "",
}) => {
  const existing = await findDocumentByContentHash(contentSha256, { ownerUserId, workspaceId });

  if (!existing || existing.docId === docId) {
    return null;
  }

  await loadDocumentsFromStore([existing.docId]);

  const document = getDocument(existing.docId);

  return document ? { ...document, duplicate: true } : null;
};

/**
 * Synchronous ingest of an upload: parse, chunk, embed and commit in the
 * caller. `deduplicate` answers bytes the tenant already stored with that
 * document (`duplicate: true`) before parsing; `replace` swaps an existing
 * document's content (PUT /documents/:docId).
 */
export const ingestDocument = async ({
  docId,
  filePath,
  fileName,
  ownerUserId = "",
  workspaceId = "",
  source = null,
  contentSha256 = null,
  deduplicate = false,
  replace = false,
  requestedAt = null,
}) => {
  const fileBuffer = await readBinaryFile(filePath);
  const hash = normalizeContentSha256(contentSha256) ?? hashDocumentBytes(fileBuffer);

  if (deduplicate && !replace) {
    const duplicate = await findDuplicateDocument({
      contentSha256: hash,
      docId,
      ownerUserId,
      workspaceId,
    });

    if (duplicate) {
      return duplicate;
    }
  }

  const pages = await loadPdfPages(filePath);

  return ingestDocumentPages({
    contentSha256: hash,
    deduplicate,
    docId,
    fileBuffer,
    fileName,
    filePath,
    ownerUserId,
    pages,
    replace,
    requestedAt,
    source,
    workspaceId,
  });
};

// The real ingest can also run as the staged pipeline of an async job
// (rag/ingest-stages.js STAGED_INGEST, rag/ingest-pipeline.js).
ingestDocument[STAGED_INGEST] = true;

/** PUT /documents/:docId in sync mode: ingestDocument with `replace`. */
export const replaceDocument = async (input) => {
  // Refused before the PDF is parsed or embedded (commitDocument refuses too).
  if (!supportsDocumentReplacement()) {
    throw createReplacementUnsupportedError();
  }

  return ingestDocument({ ...input, replace: true, deduplicate: false });
};

const ensureDocumentsExist = (docIds, accessScope = {}) => {
  const missingDocId = docIds.find(
    (docId) => !getDocument(docId, accessScope)
  );

  if (!missingDocId) {
    return;
  }

  const error = new Error(
    `Document not found for docId ${missingDocId}. Upload the PDF again and use the latest docId.`
  );
  error.status = 404;
  throw error;
};

const buildErrorTrace = (error) => ({
  name: error?.name ?? "Error",
  message: error?.message ?? String(error),
});

const hasScopedAccess = (accessScope = {}) =>
  Boolean(accessScope?.userId || accessScope?.workspaceId);

// Null when this caller cannot see the document, or when the registry store
// had no row left to delete (another process deleted it first): the route
// answers 404 either way. Once this delete removed the document, `cascade`
// (rag/document-deletion-cascade.js, wired by app-services.js) cancels its
// ingest jobs and, with DOCUMENT_DELETE_REDACTION=on, redacts its text from the
// caller's other records; it never fails the delete. Its chunks in every live
// index version table go with the delete itself (vector-store-pgvector.js).
export const deleteDocument = async (
  docId,
  { deleteFile = true, accessScope = {}, cascade = null } = {}
) => {
  const deleted = await deleteDocumentFromStores(docId, { accessScope });

  if (deleted) {
    await runDocumentDeletionCascade(cascade, { accessScope, docIds: [deleted.docId ?? docId] });
  }

  return deleted;
};

const deleteDocumentFromStores = async (docId, { accessScope = {} } = {}) => {
  const storedDocument = getStoredDocument(docId, accessScope);

  if (!storedDocument) {
    return null;
  }

  if (isVectorStoreTransactional()) {
    await ensureVectorStoreReady();

    return trackDocumentWrite(docId, async () => {
      let deleted;

      try {
        deleted = await withPostgresTransaction(async (transactionClient) => {
          const client = await beginVectorIndexWrite({ client: transactionClient });

          // The document row before its chunk rows, as ingest and replacement
          // take them: an index-version builder holds this row FOR SHARE
          // while it rewrites the document's chunks in the building version,
          // so removing the chunks first could deadlock with it.
          await lockDocumentForContentReplace(docId, { client });
          await removeDocumentsFromIndex({ client, docIds: [docId] });
          return deleteRegisteredDocument(docId, accessScope, { client });
        });
      } catch (error) {
        try {
          await resyncDocument(docId);
        } catch (resyncError) {
          console.error(
            `Failed to resync document registry entry for docId ${docId} after rollback.`,
            resyncError
          );
        }

        throw error;
      }

      invalidateSemanticCacheDocuments([docId]);
      return deleted ? storedDocument : null;
    });
  }

  await removeDocumentsFromIndex({
    docIds: [docId],
  });
  const deleted = await deleteRegisteredDocument(docId, accessScope);

  invalidateSemanticCacheDocuments([docId]);
  return deleted ? storedDocument : null;
};

// The registry's DELETE decides which documents a clear covers (with a
// PostgreSQL registry that includes documents other processes registered and
// this map never loaded), and the index removal and the response use the same
// ids. The map drops them before COMMIT on the pgvector path, so they are
// tracked (trackDocumentWrite) from the moment the DELETE reports them: a
// registry refresh whose listing predates the COMMIT must not bring them back.
export const clearDocuments = async ({
  deleteFiles = true,
  accessScope = {},
  cascade = null,
} = {}) => {
  const documents = await clearDocumentsFromStores({ accessScope });

  if (Array.isArray(documents) && documents.length > 0) {
    await runDocumentDeletionCascade(cascade, {
      accessScope,
      docIds: documents.map((document) => document.docId),
    });
  }

  return documents;
};

const clearDocumentsFromStores = async ({ accessScope = {} } = {}) => {
  const scoped = hasScopedAccess(accessScope);

  if (isVectorStoreTransactional()) {
    await ensureVectorStoreReady();

    return trackDocumentWrite([], (track) =>
      withPostgresTransaction(async (transactionClient) => {
        const client = await beginVectorIndexWrite({ client: transactionClient });
        const documents = await clearRegisteredDocuments({
          accessScope,
          client,
          onCleared: track,
        });

        // The chunk rows cascade with their document rows; removing them
        // explicitly keeps the provider contract, not the foreign key, in
        // charge.
        if (scoped) {
          await removeDocumentsFromIndex({
            client,
            docIds: documents.map((document) => document.docId),
          });
        } else {
          await clearVectorIndex({ client });
        }

        invalidateSemanticCacheDocuments(documents.map((document) => document.docId));
        return documents;
      })
    );
  }

  return trackDocumentWrite([], async (track) => {
    const documents = await clearRegisteredDocuments({
      accessScope,
      onCleared: track,
    });

    if (scoped) {
      await removeDocumentsFromIndex({
        docIds: documents.map((document) => document.docId),
      });
    } else {
      await clearVectorIndex();
    }

    invalidateSemanticCacheDocuments(documents.map((document) => document.docId));
    return documents;
  });
};

// Documents per erase transaction: each batch locks its rows, removes their
// chunks from every chunk table and deletes them, so a large tenant does not
// hold every row lock in one transaction, and an interrupted erase is finished
// by running it again.
const TENANT_ERASE_DOCUMENT_BATCH = 100;

const addChunkCounts = (total, counts) => {
  if (!counts) {
    return total;
  }

  const next = total ?? {};

  for (const [table, count] of Object.entries(counts)) {
    next[table] = (next[table] ?? 0) + count;
  }

  return next;
};

/**
 * The dry run of eraseTenantDocuments: the tenant's stored documents (exact
 * owner columns, rag/tenant-records.js) and, on pgvector, their chunks per
 * existing chunk table (null on local and Qdrant, which report no count).
 */
export const countTenantDocuments = async (selector) => {
  const documents = await listStoredDocumentsForTenant(selector);
  const docIds = documents.map((document) => document.docId);

  return {
    chunks: docIds.length > 0 ? await countDocumentChunksForErase({ docIds }) : null,
    documents,
  };
};

/**
 * The tenant erase of documents (rag/tenant-lifecycle.js, run as the system).
 *
 * On pgvector each batch is one transaction in the order every writer keeps:
 * the index-version write lock (beginVectorIndexWrite), the document rows
 * FOR UPDATE, then the chunks in every existing chunk table -- the write
 * targets and any other version table that still exists -- and the rows. The
 * foreign keys would cascade the chunks too; deleting them explicitly first
 * reaches a table without one and gives the per-table counts. BM25
 * statistics follow through their triggers. On local and Qdrant the vector
 * store's own delete call removes the chunks, then the registry deletes the
 * documents (the file-backed registry removes their bytes from disk). Either
 * way the semantic cache drops what was built on them.
 */
export const eraseTenantDocuments = async (selector) => {
  const documents = await listStoredDocumentsForTenant(selector);
  const docIds = documents.map((document) => document.docId);
  const erased = [];
  let chunks = null;

  if (docIds.length === 0) {
    return { chunks, documents: erased };
  }

  if (isVectorStoreTransactional()) {
    await ensureVectorStoreReady();

    for (let start = 0; start < docIds.length; start += TENANT_ERASE_DOCUMENT_BATCH) {
      const batch = docIds.slice(start, start + TENANT_ERASE_DOCUMENT_BATCH);

      await trackDocumentWrite(batch, async () => {
        try {
          const batchErased = await withPostgresTransaction(async (transactionClient) => {
            const client = await beginVectorIndexWrite({ client: transactionClient });

            return eraseStoredDocuments(batch, {
              beforeDelete: async (lockedDocIds) => {
                chunks = addChunkCounts(
                  chunks ?? {},
                  await eraseDocumentsFromIndex({ client, docIds: lockedDocIds })
                );
              },
              client,
              selector,
            });
          });

          erased.push(...batchErased);
        } catch (error) {
          for (const docId of batch) {
            try {
              await resyncDocument(docId);
            } catch (resyncError) {
              console.error(
                `Failed to resync document registry entry for docId ${docId} after rollback.`,
                resyncError
              );
            }
          }

          throw error;
        } finally {
          invalidateSemanticCacheDocuments(batch);
        }
      });
    }

    return { chunks, documents: erased };
  }

  for (let start = 0; start < docIds.length; start += TENANT_ERASE_DOCUMENT_BATCH) {
    const batch = docIds.slice(start, start + TENANT_ERASE_DOCUMENT_BATCH);

    await eraseDocumentsFromIndex({ docIds: batch });
    erased.push(...(await eraseStoredDocuments(batch, { selector })));
    invalidateSemanticCacheDocuments(batch);
  }

  return { chunks, documents: erased };
};

// The user's own exchange: one session turn (question + answer) and the
// long-term preferences the question states. Only the user's message may reach
// it, never text the agent composed.
const recordUserExchange = async ({
  accessScope = {},
  answer,
  documents,
  query,
  resolvedQuery = null,
  routeMode = null,
  sessionId = null,
  userId = null,
}) => {
  // A whole request on composed text (a background task iteration) runs
  // under runWithoutConversationMemoryWrites: nothing in it is the user's.
  if (areConversationMemoryWritesSuppressed()) {
    return;
  }

  await recordSessionTurn({
    // The tenant is part of the session key (rag/memory.js).
    accessScope,
    sessionId,
    query,
    resolvedQuery,
    answer,
    documents,
    routeMode,
  });

  if (userId) {
    try {
      await recordLongMemoryFromUserMessage({
        // The workspace under LONG_MEMORY_SCOPE=workspace (rag/long-memory.js).
        accessScope,
        userId,
        query,
      });
    } catch (error) {
      console.error("Failed to persist long-term memory from user message.", error);
    }
  }
};

/**
 * Records the user's exchange for an agent answer that no memory-writing
 * chat() call produced (a research brief, whose document lookups run with
 * memoryWrites: false). Same writes as chat()'s own: one session turn and the
 * preferences the user's question states.
 */
export const recordConversationTurn = async ({
  accessScope = {},
  answer = "",
  docIds = [],
  query,
  routeMode = null,
  sessionId = null,
  userId = null,
} = {}) => {
  if (typeof query !== "string" || !query.trim() || (!sessionId && !userId)) {
    return;
  }

  await initializeDocumentRegistry();
  const documents = getDocuments(normalizeDocIds(docIds), accessScope);

  await recordUserExchange({
    accessScope,
    answer,
    documents,
    query,
    routeMode,
    sessionId,
    userId,
  });
};

const chat = async (docIds, query, options = {}) => {
  const {
    sessionId = null,
    userId = null,
    includeRetrievedContexts = false,
    accessScope = {},
    retrievalPlan = null,
    // false for the agent's own sub-calls (follow-up retrieval, research
    // questions, composed Skill prompts): their question is system text, so
    // it must not become a session turn or a long-term preference. Memory
    // reads (query rewrite, preference block) are unchanged either way.
    memoryWrites = true,
  } = options;
  const agentRetrievalPlan = normalizeRetrievalPlan(retrievalPlan);
  const traceId = randomUUID();
  const timestamp = new Date().toISOString();
  const startedAt = Date.now();
  let normalizedDocIds = [];
  let resolvedQuery = null;
  let routeMode = null;

  const buildBaseTraceEvent = (extraFields = {}) => ({
    traceId,
    timestamp,
    routeMode,
    query,
    resolvedQuery,
    docIds: normalizedDocIds,
    ...extraFields,
    latencyMs: Date.now() - startedAt,
  });

  try {
    normalizedDocIds = normalizeDocIds(docIds);

    if (normalizedDocIds.length === 0) {
      const error = new Error("At least one document is required.");
      error.status = 404;
      throw error;
    }

    await initializeDocumentRegistry();
    ensureDocumentsExist(normalizedDocIds, accessScope);

    const selectedDocuments = getDocuments(normalizedDocIds, accessScope);
    let longMemoryContext = {
      memories: [],
      rewriteBlock: "",
      answerBlock: "",
    };

    try {
      longMemoryContext = await getLongMemoryContext({
        accessScope,
        userId,
        query,
      });
    } catch (error) {
      console.error("Failed to load long-term memory context.", error);
    }

    // The agent's follow-up (AGENT_FOLLOW_UP_ORIGINAL_QUESTION) passes the
    // question its primary call already resolved. The primary call has since
    // recorded a session turn, so rewriting again would read that turn and
    // could add to the question (a file name becomes an anchor).
    const memoryResolution =
      agentRetrievalPlan?.phase === "follow_up" && isAgentFollowUpOriginalQuestionEnabled()
        ? { resolvedQuery: query, memoryApplied: false }
        : await resolveQueryWithSessionMemory({
            accessScope,
            sessionId,
            query,
            documents: selectedDocuments,
            longTermMemory: longMemoryContext.rewriteBlock,
          });
    resolvedQuery = memoryResolution.resolvedQuery;

    const buildResponse = async (response) => {
      const abstained = Boolean(response.abstained);
      const result = {
        ...response,
        abstained,
        abstainReason: abstained ? response.abstainReason ?? response.text : null,
        resolvedQuery,
        memoryApplied: memoryResolution.memoryApplied,
      };

      if (!includeRetrievedContexts) {
        delete result.retrievedContexts;
      }

      if (memoryWrites !== false) {
        await recordUserExchange({
          accessScope,
          answer: result.text,
          documents: selectedDocuments,
          query,
          resolvedQuery,
          routeMode,
          sessionId,
          userId,
        });
      }

      return result;
    };

    const recordResponseTrace = async ({ response, traceFields }) => {
      const result = await buildResponse(response);

      await recordRagTrace(
        buildBaseTraceEvent({
          ...traceFields,
          abstained: result.abstained,
          abstainReason: result.abstainReason,
          abstainSource: result.abstainSource ?? null,
          answerLength: result.text?.length ?? 0,
          error: null,
        })
      );

      return result;
    };

    const execution = await executeDocumentRag({
      accessScope,
      agentRetrievalPlan,
      docIds: normalizedDocIds,
      includeRetrievedContexts,
      preferenceBlock: longMemoryContext.answerBlock,
      query,
      resolvedQuery,
      selectedDocuments,
    });
    routeMode = execution.routeMode;

    return recordResponseTrace({
      response: execution.response,
      traceFields: execution.traceFields,
    });
  } catch (error) {
    await recordRagTrace(
      buildBaseTraceEvent({
        error: buildErrorTrace(error),
      })
    );
    throw error;
  }
};

export default chat;
