import { randomUUID } from "node:crypto";
import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { chunkDocument } from "./chunker.js";
import {
  getRerankCandidateMultiplier,
  getHybridFusionMethod,
  getRerankProvider,
  getRerankWeight,
  getRrfK,
  getRetrievalTopK,
  isQueryDecompositionEnabled,
  isHybridRetrievalEnabled,
  isRerankEnabled,
} from "./config.js";
import { analyzeComparison } from "./comparison-engine.js";
import { assessComparisonConfidence, assessQaConfidence } from "./confidence.js";
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
} from "./doc-registry.js";
import { buildPublicFilePath } from "./document-utils.js";
import { buildDocumentProfile } from "./document-profiler.js";
import {
  buildComparisonEvidenceSummary,
  buildQaEvidenceSummary,
} from "./evidence-summary.js";
import { alignComparisonEvidence } from "./evidence-aligner.js";
import { planQaEvidenceGap } from "./gap-planner.js";
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
import {
  buildBundleTrace,
  buildConfidenceTrace,
  buildResultTrace,
  recordRagTrace,
} from "./observability.js";
import { embedQuery } from "./openai.js";
import {
  buildEvidenceRequirements,
  buildRetrievalQueries,
} from "./query-decomposer.js";
import { routeQuery } from "./query-router.js";
import { retrieveGlobalContext } from "./retrievers/global-retriever.js";
import { retrievePerDocumentContext } from "./retrievers/per-doc-retriever.js";
import {
  prepareComparisonSourceBundle,
  prepareQASourceBundle,
  writeComparisonAnswer,
  writeQaAnswer,
} from "./answer-writer.js";
import { getResultKey } from "./citations.js";
import { addDocumentsToIndex, clearVectorIndex, removeDocumentsFromIndex } from "./vector-store.js";

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
}) => {
  const publicFilePath = buildPublicFilePath(docId);
  const chunks = chunkDocument({
    docId,
    fileName,
    publicFilePath,
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
  let indexed = false;

  try {
    await addDocumentsToIndex({
      documents: langChainDocuments,
    });
    indexed = true;

    await registerDocument({
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
      }),
      uploadedAt: new Date().toISOString(),
    });

    return getDocument(docId);
  } catch (error) {
    if (indexed) {
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
}) => {
  const loader = new PDFLoader(filePath);
  const pageDocuments = await loader.load();

  return ingestDocumentPages({
    docId,
    filePath,
    fileName,
    ownerUserId,
    workspaceId,
    pages: pageDocuments.map((document, index) => ({
      pageNumber: getPageNumber(document.metadata, index + 1),
      text: document.pageContent,
    })),
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

const getResultMergeScore = (result = {}) =>
  (Number(result.keywordScore) || 0) * 2 + (Number(result.score) || 0);

const mergeRetrievedResults = (...resultGroups) => {
  const mergedResults = [];
  const resultIndexByKey = new Map();

  for (const results of resultGroups) {
    for (const result of results ?? []) {
      const resultKey = getResultKey(result);
      const existingIndex = resultIndexByKey.get(resultKey);

      if (existingIndex !== undefined) {
        if (
          getResultMergeScore(result) >
          getResultMergeScore(mergedResults[existingIndex])
        ) {
          mergedResults[existingIndex] = result;
        }
        continue;
      }

      resultIndexByKey.set(resultKey, mergedResults.length);
      mergedResults.push(result);
    }
  }

  return mergedResults;
};

const mergePerDocumentResults = (docIds, ...perDocumentResultGroups) => {
  const mergedResultsByDoc = new Map(docIds.map((docId) => [docId, []]));
  const resultIndexesByDoc = new Map(docIds.map((docId) => [docId, new Map()]));

  for (const resultGroup of perDocumentResultGroups) {
    if (!(resultGroup instanceof Map)) {
      continue;
    }

    for (const docId of docIds) {
      const resultIndexByKey = resultIndexesByDoc.get(docId);
      const mergedResults = mergedResultsByDoc.get(docId);

      for (const result of resultGroup.get(docId) ?? []) {
        const resultKey = getResultKey(result);
        const existingIndex = resultIndexByKey.get(resultKey);

        if (existingIndex !== undefined) {
          if (
            getResultMergeScore(result) >
            getResultMergeScore(mergedResults[existingIndex])
          ) {
            mergedResults[existingIndex] = result;
          }
          continue;
        }

        resultIndexByKey.set(resultKey, mergedResults.length);
        mergedResults.push(result);
      }
    }
  }

  return mergedResultsByDoc;
};

const buildRequirementTrace = (requirements = []) =>
  requirements.map((requirement) => ({
    id: requirement.id,
    label: requirement.label,
    query: requirement.query,
    primary: Boolean(requirement.primary),
  }));

const retrieveGlobalContextForQueries = async ({
  docIds,
  primaryQueryVector,
  retrievalQueries,
}) => {
  const resultGroups = await Promise.all(
    retrievalQueries.map(async (retrievalQuery) => {
      const queryVector = retrievalQuery.primary
        ? primaryQueryVector
        : await embedQuery(retrievalQuery.query);

      return retrieveGlobalContext({
        queryVector,
        queryText: retrievalQuery.query,
        docIds,
      });
    })
  );

  return mergeRetrievedResults(...resultGroups);
};

const retrievePerDocumentContextForQueries = async ({
  docIds,
  primaryQueryVector,
  retrievalQueries,
}) => {
  const resultGroups = await Promise.all(
    retrievalQueries.map(async (retrievalQuery) => {
      const queryVector = retrievalQuery.primary
        ? primaryQueryVector
        : await embedQuery(retrievalQuery.query);

      return retrievePerDocumentContext({
        queryVector,
        queryText: retrievalQuery.query,
        docIds,
      });
    })
  );

  return mergePerDocumentResults(docIds, ...resultGroups);
};

const buildQaGapPlan = async ({
  query,
  results,
  confidence,
  docIds,
}) => {
  const toClientGapPlan = (gapPlan, supplementalSearches = []) => ({
    userMessage: gapPlan.userMessage,
    missingAspects: (gapPlan.missingAspects ?? []).map((aspect) => ({
      label: aspect.label,
    })),
    supplementalSearches,
  });
  const initialGapPlan = planQaEvidenceGap({
    query,
    results,
    confidence,
  });
  const supplementalQueries = initialGapPlan.supplementalQueries ?? [];

  if (supplementalQueries.length === 0) {
    return toClientGapPlan(initialGapPlan);
  }

  const supplementalSearches = await Promise.all(
    supplementalQueries.map(async (supplementalQuery) => {
      const supplementalVector = await embedQuery(supplementalQuery.query);
      const supplementalResults = await retrieveGlobalContext({
        queryVector: supplementalVector,
        queryText: supplementalQuery.query,
        docIds,
      });

      return {
        ...supplementalQuery,
        results: supplementalResults,
      };
    })
  );
  const mergedResults = mergeRetrievedResults(
    results,
    ...supplementalSearches.map((search) => search.results)
  );

  if (mergedResults.length === results.length) {
    return toClientGapPlan(
      initialGapPlan,
      supplementalSearches.map((search) => ({
        label: search.label,
        query: search.query,
        resultCount: search.results.length,
      }))
    );
  }

  return toClientGapPlan(
    planQaEvidenceGap({
      query,
      results: mergedResults,
      confidence,
    }),
    supplementalSearches.map((search) => ({
      label: search.label,
      query: search.query,
      resultCount: search.results.length,
    }))
  );
};

const buildRetrievalConfigTrace = () => ({
  hybridEnabled: isHybridRetrievalEnabled(),
  hybridFusionMethod: getHybridFusionMethod(),
  rrfK: getRrfK(),
  rerankEnabled: isRerankEnabled(),
  rerankProvider: getRerankProvider(),
  queryDecompositionEnabled: isQueryDecompositionEnabled(),
  retrievalTopK: getRetrievalTopK(),
  rerankCandidateMultiplier: getRerankCandidateMultiplier(),
  rerankWeight: getRerankWeight(),
});

const buildPerDocumentResultsTrace = (docIds, perDocumentResults) =>
  Object.fromEntries(
    docIds.map((docId) => [
      docId,
      (perDocumentResults.get(docId) ?? []).map((result) => buildResultTrace(result)),
    ])
  );

const buildAlignmentSummaryTrace = (alignment = {}) => ({
  missingDocuments: alignment.missingDocuments ?? [],
  sharedTerms: alignment.sharedTerms ?? [],
  perDocumentEvidenceCounts: (alignment.perDocument ?? []).map((entry) => ({
    docId: entry.docId,
    fileName: entry.fileName,
    evidenceCount: entry.results.length,
  })),
});

const buildComparisonPairTrace = (pair = {}) => ({
  leftDocId: pair.leftDocId ?? null,
  leftFileName: pair.leftFileName ?? null,
  rightDocId: pair.rightDocId ?? null,
  rightFileName: pair.rightFileName ?? null,
  termJaccard: pair.termJaccard ?? null,
  sentenceOverlap: pair.sentenceOverlap ?? null,
  nearDuplicate: Boolean(pair.nearDuplicate),
  strongNearDuplicate: Boolean(pair.strongNearDuplicate),
  explicitConflict: Boolean(pair.explicitConflict),
  numericTokensOnlyInLeft: pair.numericTokensOnlyInLeft ?? [],
  numericTokensOnlyInRight: pair.numericTokensOnlyInRight ?? [],
});

const buildComparisonAnalysisSummaryTrace = (analysis = {}) => ({
  evidenceBalance: analysis.evidenceBalance ?? null,
  nearDuplicatePairs: (analysis.nearDuplicatePairs ?? []).map(
    buildComparisonPairTrace
  ),
  explicitConflictPairs: (analysis.explicitConflictPairs ?? []).map(
    buildComparisonPairTrace
  ),
  shouldShortCircuitNoMaterialDifference: Boolean(
    analysis.shouldShortCircuitNoMaterialDifference
  ),
});

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
  } = options;
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
          answerLength: result.text?.length ?? 0,
          error: null,
        })
      );

      return result;
    };

    const route = routeQuery({
      query: resolvedQuery,
      docIds: normalizedDocIds,
    });
    routeMode = route.mode;
    const evidenceRequirements = buildEvidenceRequirements({
      query: resolvedQuery,
      mode: routeMode,
    });
    const retrievalQueries = buildRetrievalQueries({
      query: resolvedQuery,
      requirements: evidenceRequirements,
    });
    const queryVector = await embedQuery(resolvedQuery);

    if (routeMode === "compare") {
      const perDocumentResults = await retrievePerDocumentContextForQueries({
        primaryQueryVector: queryVector,
        retrievalQueries,
        docIds: normalizedDocIds,
      });
      const confidence = assessComparisonConfidence({
        docIds: normalizedDocIds,
        perDocumentResults,
        queryText: resolvedQuery,
      });
      const evidenceSummary = buildComparisonEvidenceSummary({
        confidence,
        docIds: normalizedDocIds,
        perDocumentResults,
        requirements: evidenceRequirements,
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
      const traceFields = {
        retrievalConfig: buildRetrievalConfigTrace(),
        queryIntent: route,
        queryRequirements: buildRequirementTrace(evidenceRequirements),
        perDocumentResults: buildPerDocumentResultsTrace(
          normalizedDocIds,
          perDocumentResults
        ),
        confidence: buildConfidenceTrace(confidence),
        evidenceSummary,
        alignmentSummary: buildAlignmentSummaryTrace(alignment),
        comparisonAnalysisSummary: buildComparisonAnalysisSummaryTrace(analysis),
        finalSourceBundle: buildBundleTrace(bundle),
      };

      if (!confidence.confident) {
        return recordResponseTrace({
          traceFields,
          response: {
            text: confidence.reason,
            citations: bundle.citations,
            retrievedContexts: bundle.retrievedContexts,
            evidenceSummary,
            abstained: true,
            abstainReason: confidence.reason,
          },
        });
      }

      return recordResponseTrace({
        traceFields,
        response: {
          ...(await writeComparisonAnswer({
            query,
            resolvedQuery,
            bundle,
            analysis,
            preferenceBlock: longMemoryContext.answerBlock,
          })),
          retrievedContexts: bundle.retrievedContexts,
          evidenceSummary,
        },
      });
    }

    const retrievalResults = await retrieveGlobalContextForQueries({
      primaryQueryVector: queryVector,
      retrievalQueries,
      docIds: normalizedDocIds,
    });
    const confidence = assessQaConfidence({
      results: retrievalResults,
      queryText: resolvedQuery,
    });
    const evidenceSummary = buildQaEvidenceSummary({
      confidence,
      docIds: normalizedDocIds,
      requirements: evidenceRequirements,
      results: retrievalResults,
    });
    const bundle = prepareQASourceBundle({
      results: confidence.usableResults,
    });
    const traceFields = {
      retrievalConfig: buildRetrievalConfigTrace(),
      queryIntent: route,
      queryRequirements: buildRequirementTrace(evidenceRequirements),
      retrievalResults: retrievalResults.map((result) => buildResultTrace(result)),
      confidence: buildConfidenceTrace(confidence),
      evidenceSummary,
      finalSourceBundle: buildBundleTrace(bundle),
    };

    if (!confidence.confident) {
      const gapPlan = await buildQaGapPlan({
        query: resolvedQuery,
        results: retrievalResults,
        confidence,
        docIds: normalizedDocIds,
      });

      return recordResponseTrace({
        traceFields,
        response: {
          text: gapPlan.userMessage,
          citations: bundle.citations,
          retrievedContexts: bundle.retrievedContexts,
          evidenceSummary,
          abstained: true,
          abstainReason: gapPlan.userMessage,
          gapPlan: {
            missingAspects: gapPlan.missingAspects,
            supplementalSearches: gapPlan.supplementalSearches,
          },
        },
      });
    }

    return recordResponseTrace({
      traceFields,
      response: {
        ...(await writeQaAnswer({
          query,
          resolvedQuery,
          bundle,
          preferenceBlock: longMemoryContext.answerBlock,
        })),
        retrievedContexts: bundle.retrievedContexts,
        evidenceSummary,
      },
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
