import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { chunkDocument } from "./chunker.js";
import { analyzeComparison } from "./comparison-engine.js";
import { assessComparisonConfidence, assessQaConfidence } from "./confidence.js";
import {
  getDocument,
  getDocuments,
  hasDocument,
  normalizeDocIds,
  registerDocument,
} from "./doc-registry.js";
import { buildPublicFilePath } from "./document-utils.js";
import { alignComparisonEvidence } from "./evidence-aligner.js";
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
import { addDocumentsToIndex } from "./vector-store.js";

export { getDocument, getDocuments };

const getPageNumber = (metadata = {}, fallbackPageNumber = null) =>
  metadata.loc?.pageNumber ?? metadata.pageNumber ?? metadata.page ?? fallbackPageNumber;

export const ingestDocument = async ({ docId, filePath, fileName }) => {
  const loader = new PDFLoader(filePath);
  const pageDocuments = await loader.load();
  const chunks = chunkDocument({
    docId,
    fileName,
    filePath,
    pages: pageDocuments.map((document, index) => ({
      pageNumber: getPageNumber(document.metadata, index + 1),
      text: document.pageContent,
    })),
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
    pageCount: pageDocuments.length,
    uploadedAt: new Date().toISOString(),
  });

  return getDocument(docId);
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

const chat = async (docIds, query) => {
  const normalizedDocIds = normalizeDocIds(docIds);

  if (normalizedDocIds.length === 0) {
    const error = new Error("At least one document is required.");
    error.status = 404;
    throw error;
  }

  ensureDocumentsExist(normalizedDocIds);

  const selectedDocuments = getDocuments(normalizedDocIds);
  const route = routeQuery({
    query,
    docIds: normalizedDocIds,
  });
  const queryVector = await embedQuery(query);

  if (route.mode === "compare") {
    const perDocumentResults = await retrievePerDocumentContext({
      queryVector,
      docIds: normalizedDocIds,
    });
    const confidence = assessComparisonConfidence({
      docIds: normalizedDocIds,
      perDocumentResults,
    });
    const alignment = alignComparisonEvidence({
      query,
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
      return {
        text: confidence.reason,
        citations: bundle.citations,
      };
    }

    return writeComparisonAnswer({
      query,
      bundle,
      analysis,
    });
  }

  const retrievalResults = await retrieveGlobalContext({
    queryVector,
    docIds: normalizedDocIds,
  });
  const confidence = assessQaConfidence(retrievalResults);
  const bundle = prepareQASourceBundle({
    results: confidence.usableResults,
  });

  if (!confidence.confident) {
    return {
      text: confidence.reason,
      citations: bundle.citations,
    };
  }

  return writeQaAnswer({
    query,
    bundle,
  });
};

export default chat;
