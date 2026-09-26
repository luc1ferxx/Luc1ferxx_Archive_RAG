import { randomUUID } from "node:crypto";
import { chunkDocument } from "./chunker.js";
import {
  clearDocuments as clearRegisteredDocuments,
  deleteDocument as deleteRegisteredDocument,
  getDocument,
  getDocumentFile,
  getDocuments,
  getStoredDocument,
  initializeDocumentRegistry,
  listDocuments,
  normalizeDocIds,
  registerDocument,
  resyncDocument,
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
import { recordRagTrace } from "./observability.js";
import { loadPdfPages } from "./pdf-loader.js";
import { withPostgresTransaction } from "./postgres.js";
import {
  clearVectorIndex,
  ensureVectorStoreReady,
  isVectorStoreTransactional,
  prepareDocumentsForIndex,
  removeDocumentsFromIndex,
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
  listDocuments,
  listLongMemories,
  rememberLongMemory,
};

const getPageNumber = (metadata = {}, fallbackPageNumber = null) =>
  metadata.loc?.pageNumber ?? metadata.pageNumber ?? metadata.page ?? fallbackPageNumber;

export const ingestDocumentPages = async ({
  docId,
  filePath,
  fileName,
  pages,
  ownerUserId = "",
  workspaceId = "",
  source = null,
}) => {
  const publicFilePath = buildPublicFilePath(docId);
  const chunks = chunkDocument({
    docId,
    fileName,
    publicFilePath,
    pages,
    source,
  });

  if (chunks.length === 0) {
    const error = new Error("No extractable text was found in the uploaded PDF.");
    error.status = 422;
    throw error;
  }

  const documents = chunks.map((chunk) => ({
    id: chunk.id,
    pageContent: chunk.pageContent,
    metadata: chunk.metadata,
  }));
  const registration = {
    docId,
    fileName,
    sourceFilePath: filePath,
    publicFilePath,
    chunkCount: chunks.length,
    pageCount: pages.length,
    ownerUserId,
    workspaceId,
    profile: buildDocumentProfile({
      fileName,
      pages,
      source,
    }),
    source,
    uploadedAt: new Date().toISOString(),
  };
  const accessScope = { userId: ownerUserId, workspaceId };

  // The provider is checked first (database, extension, embedding width) so
  // a misconfigured store fails with its own reason before any embedding is
  // paid for. Embeddings are then computed before any storage is touched: for
  // pgvector that keeps the remote embedding call outside the transaction.
  await ensureVectorStoreReady();

  const prepared = await prepareDocumentsForIndex({ documents });

  if (isVectorStoreTransactional()) {
    // One transaction for the document row and every chunk row. The registry
    // row goes first because the chunk table's foreign key points at it; if
    // either write fails the whole thing rolls back and the in-memory registry
    // is resynced from what the database actually holds.
    try {
      await withPostgresTransaction(async (client) => {
        await registerDocument(registration, { client });
        await writeDocumentsToIndex({ accessScope, client, prepared });
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

    return getDocument(docId);
  }

  try {
    await writeDocumentsToIndex({ accessScope, prepared });
    await registerDocument(registration);

    return getDocument(docId);
  } catch (error) {
    // Rolled back unconditionally, not only when the index write resolved. The
    // local provider writes the dense and sparse indexes concurrently, so a
    // rejection can still leave one of them populated -- and orphaned sparse
    // entries are not merely dead weight: they feed the corpus-wide BM25
    // statistics in sparse-store.js, skewing scores for every other document.
    // Both removals ignore ids they do not hold, so this is safe when nothing was
    // written.
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
};

export const ingestDocument = async ({
  docId,
  filePath,
  fileName,
  ownerUserId = "",
  workspaceId = "",
  source = null,
}) => {
  const pages = await loadPdfPages(filePath);

  return ingestDocumentPages({
    docId,
    filePath,
    fileName,
    ownerUserId,
    workspaceId,
    source,
    pages,
  });
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

export const deleteDocument = async (
  docId,
  { deleteFile = true, accessScope = {} } = {}
) => {
  const storedDocument = getStoredDocument(docId, accessScope);

  if (!storedDocument) {
    return null;
  }

  if (isVectorStoreTransactional()) {
    await ensureVectorStoreReady();

    try {
      await withPostgresTransaction(async (client) => {
        await removeDocumentsFromIndex({ client, docIds: [docId] });
        await deleteRegisteredDocument(docId, accessScope, { client });
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

    return storedDocument;
  }

  await removeDocumentsFromIndex({
    docIds: [docId],
  });
  await deleteRegisteredDocument(docId, accessScope);

  return storedDocument;
};

export const clearDocuments = async ({
  deleteFiles = true,
  accessScope = {},
} = {}) => {
  if (isVectorStoreTransactional()) {
    await ensureVectorStoreReady();

    const scoped = hasScopedAccess(accessScope);
    const scopedDocIds = scoped
      ? listDocuments(accessScope).map((document) => document.docId)
      : [];

    return withPostgresTransaction(async (client) => {
      if (scoped) {
        await removeDocumentsFromIndex({ client, docIds: scopedDocIds });
      } else {
        await clearVectorIndex({ client });
      }

      return clearRegisteredDocuments({ accessScope, client });
    });
  }

  const documents = await clearRegisteredDocuments({
    accessScope,
  });

  if (hasScopedAccess(accessScope)) {
    await removeDocumentsFromIndex({
      docIds: documents.map((document) => document.docId),
    });
  } else {
    await clearVectorIndex();
  }

  return documents;
};

const chat = async (docIds, query, options = {}) => {
  const {
    sessionId = null,
    userId = null,
    includeRetrievedContexts = false,
    accessScope = {},
    retrievalPlan = null,
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
        userId,
        query,
      });
    } catch (error) {
      console.error("Failed to load long-term memory context.", error);
    }

    const memoryResolution = await resolveQueryWithSessionMemory({
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

      await recordSessionTurn({
        sessionId,
        query,
        resolvedQuery,
        answer: result.text,
        documents: selectedDocuments,
        routeMode,
      });

      if (userId) {
        try {
          await recordLongMemoryFromUserMessage({
            userId,
            query,
          });
        } catch (error) {
          console.error("Failed to persist long-term memory from user message.", error);
        }
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
      agentRetrievalPlan,
      docIds: normalizedDocIds,
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
