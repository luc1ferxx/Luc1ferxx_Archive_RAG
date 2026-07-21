import {
  getHybridFusionMethod,
  getRerankCandidateMultiplier,
  getRerankProvider,
  getRerankWeight,
  getRetrievalTopK,
  getRrfK,
  isHybridRetrievalEnabled,
  isQueryDecompositionEnabled,
  isRerankEnabled,
} from "./config.js";
import { analyzeComparison } from "./comparison-engine.js";
import { assessComparisonConfidence, assessQaConfidence } from "./confidence.js";
import {
  buildComparisonEvidenceSummary,
  buildQaEvidenceSummary,
} from "./evidence-summary.js";
import { alignComparisonEvidence } from "./evidence-aligner.js";
import { planQaEvidenceGap } from "./gap-planner.js";
import {
  buildBundleTrace,
  buildConfidenceTrace,
  buildResultTrace,
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

const toPositiveInteger = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.floor(Number(value))
    : null;

export const normalizeRetrievalPlan = (retrievalPlan = null) => {
  if (!retrievalPlan || typeof retrievalPlan !== "object") {
    return null;
  }

  const retrievalQueries = (retrievalPlan.retrievalQueries ?? [])
    .map((query, index) => ({
      id: String(query?.id || `agent-query-${index + 1}`),
      label: String(query?.label || query?.id || `Agent query ${index + 1}`),
      query: String(query?.query ?? "").trim(),
      primary: Boolean(query?.primary),
    }))
    .filter((query) => query.query);

  if (retrievalQueries.length === 0) {
    return null;
  }

  const topK = toPositiveInteger(retrievalPlan.retrievalOptions?.topK);
  const topKPerDoc = toPositiveInteger(retrievalPlan.retrievalOptions?.topKPerDoc);

  return {
    source: String(retrievalPlan.source || "agent-query-planner"),
    phase: String(retrievalPlan.phase || "primary"),
    intent: String(retrievalPlan.intent || "unknown"),
    retrievalQueries,
    retrievalOptions: {
      profile: String(retrievalPlan.retrievalOptions?.profile || "default"),
      ...(topK ? { topK } : {}),
      ...(topKPerDoc ? { topKPerDoc } : {}),
      queryCount: retrievalQueries.length,
    },
  };
};

const retrieveGlobalContextForQueries = async ({
  docIds,
  primaryQueryVector,
  primaryQueryText,
  retrievalQueries,
  retrievalOptions = {},
}) => {
  const resultGroups = await Promise.all(
    retrievalQueries.map(async (retrievalQuery) => {
      const queryVector =
        retrievalQuery.primary && retrievalQuery.query === primaryQueryText
          ? primaryQueryVector
          : await embedQuery(retrievalQuery.query);

      return retrieveGlobalContext({
        queryVector,
        queryText: retrievalQuery.query,
        docIds,
        topK: retrievalOptions.topK,
      });
    })
  );

  return mergeRetrievedResults(...resultGroups);
};

const retrievePerDocumentContextForQueries = async ({
  docIds,
  primaryQueryVector,
  primaryQueryText,
  retrievalQueries,
  retrievalOptions = {},
}) => {
  const resultGroups = await Promise.all(
    retrievalQueries.map(async (retrievalQuery) => {
      const queryVector =
        retrievalQuery.primary && retrievalQuery.query === primaryQueryText
          ? primaryQueryVector
          : await embedQuery(retrievalQuery.query);

      return retrievePerDocumentContext({
        queryVector,
        queryText: retrievalQuery.query,
        docIds,
        topKPerDoc: retrievalOptions.topKPerDoc,
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
  comparedDocIds: (analysis.perDocumentSummary ?? [])
    .map((entry) => entry.docId)
    .filter(Boolean),
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

const buildRetrievalInputs = async ({
  agentRetrievalPlan,
  docIds,
  resolvedQuery,
}) => {
  const route = routeQuery({
    query: resolvedQuery,
    docIds,
  });
  const evidenceRequirements = buildEvidenceRequirements({
    query: resolvedQuery,
    mode: route.mode,
  });
  const retrievalQueries = buildRetrievalQueries({
    query: resolvedQuery,
    requirements: evidenceRequirements,
  });
  const plannedRetrievalQueries =
    agentRetrievalPlan?.retrievalQueries?.length
      ? agentRetrievalPlan.retrievalQueries
      : retrievalQueries;
  const retrievalOptions = agentRetrievalPlan?.retrievalOptions ?? {};
  const queryVector = await embedQuery(resolvedQuery);

  return {
    agentRetrievalPlan,
    evidenceRequirements,
    plannedRetrievalQueries,
    queryVector,
    retrievalOptions,
    route,
  };
};

const buildCommonTraceFields = ({
  agentRetrievalPlan,
  evidenceRequirements,
  plannedRetrievalQueries,
  route,
}) => ({
  retrievalConfig: buildRetrievalConfigTrace(),
  agentRetrievalPlan,
  queryIntent: route,
  queryRequirements: buildRequirementTrace(evidenceRequirements),
  retrievalQueries: buildRequirementTrace(plannedRetrievalQueries),
});

const executeComparisonRag = async ({
  agentRetrievalPlan,
  docIds,
  evidenceRequirements,
  plannedRetrievalQueries,
  preferenceBlock,
  query,
  queryVector,
  resolvedQuery,
  retrievalOptions,
  route,
  selectedDocuments,
}) => {
  const perDocumentResults = await retrievePerDocumentContextForQueries({
    primaryQueryVector: queryVector,
    primaryQueryText: resolvedQuery,
    retrievalQueries: plannedRetrievalQueries,
    retrievalOptions,
    docIds,
  });
  const confidence = assessComparisonConfidence({
    docIds,
    perDocumentResults,
    queryText: resolvedQuery,
  });
  const evidenceSummary = buildComparisonEvidenceSummary({
    confidence,
    docIds,
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
  const comparisonAnalysisSummary =
    buildComparisonAnalysisSummaryTrace(analysis);
  const traceFields = {
    ...buildCommonTraceFields({
      agentRetrievalPlan,
      evidenceRequirements,
      plannedRetrievalQueries,
      route,
    }),
    perDocumentResults: buildPerDocumentResultsTrace(docIds, perDocumentResults),
    confidence: buildConfidenceTrace(confidence),
    evidenceSummary,
    alignmentSummary: buildAlignmentSummaryTrace(alignment),
    comparisonAnalysisSummary,
    finalSourceBundle: buildBundleTrace(bundle),
  };

  if (!confidence.confident) {
    return {
      routeMode: route.mode,
      traceFields,
      response: {
        text: confidence.reason,
        citations: bundle.citations,
        retrievedContexts: bundle.retrievedContexts,
        evidenceSummary,
        comparisonAnalysisSummary,
        abstained: true,
        abstainReason: confidence.reason,
      },
    };
  }

  const generatedAnswer = await writeComparisonAnswer({
    query,
    resolvedQuery,
    bundle,
    analysis,
    preferenceBlock,
  });
  return {
    routeMode: route.mode,
    traceFields,
    response: {
      ...generatedAnswer,
      retrievedContexts: bundle.retrievedContexts,
      evidenceSummary,
      comparisonAnalysisSummary,
    },
  };
};

const executeQaRag = async ({
  agentRetrievalPlan,
  docIds,
  evidenceRequirements,
  plannedRetrievalQueries,
  preferenceBlock,
  query,
  queryVector,
  resolvedQuery,
  retrievalOptions,
  route,
}) => {
  const retrievalResults = await retrieveGlobalContextForQueries({
    primaryQueryVector: queryVector,
    primaryQueryText: resolvedQuery,
    retrievalQueries: plannedRetrievalQueries,
    retrievalOptions,
    docIds,
  });
  const confidence = assessQaConfidence({
    results: retrievalResults,
    queryText: resolvedQuery,
  });
  const evidenceSummary = buildQaEvidenceSummary({
    confidence,
    docIds,
    requirements: evidenceRequirements,
    results: retrievalResults,
  });
  const bundle = prepareQASourceBundle({
    results: confidence.usableResults,
  });
  const traceFields = {
    ...buildCommonTraceFields({
      agentRetrievalPlan,
      evidenceRequirements,
      plannedRetrievalQueries,
      route,
    }),
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
      docIds,
    });

    return {
      routeMode: route.mode,
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
    };
  }

  return {
    routeMode: route.mode,
    traceFields,
    response: {
      ...(await writeQaAnswer({
        query,
        resolvedQuery,
        bundle,
        preferenceBlock,
      })),
      retrievedContexts: bundle.retrievedContexts,
      evidenceSummary,
    },
  };
};

export const executeDocumentRag = async ({
  agentRetrievalPlan = null,
  docIds,
  preferenceBlock = "",
  query,
  resolvedQuery,
  selectedDocuments,
}) => {
  const retrievalInputs = await buildRetrievalInputs({
    agentRetrievalPlan,
    docIds,
    resolvedQuery,
  });

  if (retrievalInputs.route.mode === "compare") {
    return executeComparisonRag({
      ...retrievalInputs,
      docIds,
      preferenceBlock,
      query,
      resolvedQuery,
      selectedDocuments,
    });
  }

  return executeQaRag({
    ...retrievalInputs,
    docIds,
    preferenceBlock,
    query,
    resolvedQuery,
  });
};
