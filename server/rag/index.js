import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { unlink } from "fs/promises";
import { chunkDocument } from "./chunker.js";
import { analyzeComparison } from "./comparison-engine.js";
import { assessComparisonConfidence, assessQaConfidence } from "./confidence.js";
import {
  clearDocuments as clearRegisteredDocuments,
  deleteDocument as deleteRegisteredDocument,
  getDocument,
  getDocuments,
  getStoredDocument,
  hasDocument,
  listDocuments,
  normalizeDocIds,
  registerDocument,
} from "./doc-registry.js";
import { buildPublicFilePath } from "./document-utils.js";
import { alignComparisonEvidence } from "./evidence-aligner.js";
import {
  clearSessionMemory,
  recordSessionTurn,
  resolveQueryWithSessionMemory,
} from "./memory.js";
import { embedQuery } from "./openai.js";
import { routeQuery } from "./query-router.js";
import { retrieveGlobalContext } from "./retrievers/global-retriever.js";
import { retrievePerDocumentContext } from "./retrievers/per-doc-retriever.js";
import {
  prepareComparisonSourceBundle,
  prepareQASourceBundle,
  writeComparisonAnswer,
  writeQaAnswer,
} from "./answer-writer.js";
import { addDocumentsToIndex, clearVectorIndex, removeDocumentsFromIndex } from "./vector-store.js";

export { clearSessionMemory, getDocument, getDocuments, listDocuments };

const getPageNumber = (metadata = {}, fallbackPageNumber = null) =>
  metadata.loc?.pageNumber ?? metadata.pageNumber ?? metadata.page ?? fallbackPageNumber;

export const ingestDocumentPages = async ({ docId, filePath, fileName, pages }) => {
  const chunks = chunkDocument({
    docId,
    fileName,
    filePath,
    pages,
  });

  if (chunks.length === 0) {
    const error = new Error("No extractable text was found in the uploaded PDF.");
    error.status = 422;
    throw error;
  }

  const langChainDocuments = chunks.map(
    (chunk) =>
      new Document({
        id: chunk.id,
        pageContent: chunk.pageContent,
        metadata: chunk.metadata,
      })
  );
  await addDocumentsToIndex({
    documents: langChainDocuments,
  });

  registerDocument({
    docId,
    fileName,
    filePath,
    publicFilePath: buildPublicFilePath(filePath),
    chunkCount: chunks.length,
    pageCount: pages.length,
    uploadedAt: new Date().toISOString(),
  });

  return getDocument(docId);
};

export const ingestDocument = async ({ docId, filePath, fileName }) => {
  const loader = new PDFLoader(filePath);
  const pageDocuments = await loader.load();

  return ingestDocumentPages({
    docId,
    filePath,
    fileName,
    pages: pageDocuments.map((document, index) => ({
      pageNumber: getPageNumber(document.metadata, index + 1),
      text: document.pageContent,
    })),
  });
};

const ensureDocumentsExist = (docIds) => {
  const missingDocId = docIds.find((docId) => !hasDocument(docId));

  if (!missingDocId) {
    return;
  }

  const error = new Error(
    `Document not found for docId ${missingDocId}. Upload the PDF again and use the latest docId.`
  );
  error.status = 404;
  throw error;
};

export const deleteDocument = async (docId, { deleteFile = true } = {}) => {
  const storedDocument = getStoredDocument(docId);

  if (!storedDocument) {
    return null;
  }

  await removeDocumentsFromIndex({
    docIds: [docId],
  });
  deleteRegisteredDocument(docId);

  if (deleteFile) {
    try {
      await unlink(storedDocument.filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return storedDocument;
};

export const clearDocuments = async ({ deleteFiles = true } = {}) => {
  const documents = clearRegisteredDocuments();

  await clearVectorIndex();

  if (deleteFiles) {
    await Promise.all(
      documents.map(async (document) => {
        try {
          await unlink(document.filePath);
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      })
    );
  }

  return documents;
};

const chat = async (docIds, query, options = {}) => {
  const { sessionId = null } = options;
  const normalizedDocIds = normalizeDocIds(docIds);

  if (normalizedDocIds.length === 0) {
    const error = new Error("At least one document is required.");
    error.status = 404;
    throw error;
  }

  ensureDocumentsExist(normalizedDocIds);

  const selectedDocuments = getDocuments(normalizedDocIds);
  const memoryResolution = await resolveQueryWithSessionMemory({
    sessionId,
    query,
    documents: selectedDocuments,
  });
  const resolvedQuery = memoryResolution.resolvedQuery;
  const buildResponse = (response) => {
    const result = {
      ...response,
      resolvedQuery,
      memoryApplied: memoryResolution.memoryApplied,
    };

    recordSessionTurn({
      sessionId,
      query,
      resolvedQuery,
      answer: result.text,
      documents: selectedDocuments,
      routeMode: route.mode,
    });

    return result;
  };
  const route = routeQuery({
    query: resolvedQuery,
    docIds: normalizedDocIds,
  });
  const queryVector = await embedQuery(resolvedQuery);

  if (route.mode === "compare") {
    const perDocumentResults = await retrievePerDocumentContext({
      queryVector,
      queryText: resolvedQuery,
      docIds: normalizedDocIds,
    });
    const confidence = assessComparisonConfidence({
      docIds: normalizedDocIds,
      perDocumentResults,
    });
    const alignment = alignComparisonEvidence({
      query: resolvedQuery,
      documents: selectedDocuments,
      perDocumentResults: confidence.usableResultsByDoc,
    });
    const analysis = analyzeComparison({
      alignment,
    });
    const bundle = prepareComparisonSourceBundle({
      alignment,
    });

    if (!confidence.confident) {
      return buildResponse({
        text: confidence.reason,
        citations: bundle.citations,
      });
    }

    return buildResponse(
      await writeComparisonAnswer({
        query,
        resolvedQuery,
        bundle,
        analysis,
      })
    );
  }

  const retrievalResults = await retrieveGlobalContext({
    queryVector,
    queryText: resolvedQuery,
    docIds: normalizedDocIds,
  });
  const confidence = assessQaConfidence(retrievalResults);
  const bundle = prepareQASourceBundle({
    results: confidence.usableResults,
  });

  if (!confidence.confident) {
    return buildResponse({
      text: confidence.reason,
      citations: bundle.citations,
    });
  }

  return buildResponse(
    await writeQaAnswer({
      query,
      resolvedQuery,
      bundle,
    })
  );
};

export default chat;
