import {
  getComparisonTopKPerDoc,
  getHybridFusionMethod,
  getRerankCandidateMultiplier,
  getRerankProvider,
  getRerankWeight,
  getRetrievalTopK,
  getRrfK,
  getVectorStoreProvider,
  isHybridRetrievalEnabled,
  isQueryDecompositionEnabled,
  isRerankEnabled,
  isSemanticCacheEnabled,
} from "./config.js";
import {
  buildComparisonAnalysisFromContexts,
} from "./comparison-analysis-summary.js";
import {
  assessComparisonConfidence,
  assessQaConfidence,
  selectQaContext,
} from "./confidence.js";
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
import { embedQueryCached, prefetchQueryEmbeddings } from "./embedding-cache.js";
import {
  buildEvidenceRequirements,
  buildRetrievalQueries,
} from "./query-decomposer.js";
import { routeQuery } from "./query-router.js";
import { retrieveGlobalContextWithRoutes } from "./retrievers/global-retriever.js";
import { retrievePerDocumentContextWithRoutes } from "./retrievers/per-doc-retriever.js";
import { QUERY_ADAPTER_SCOPE_QA } from "./query-adapter.js";
import {
  isRetrievalRemote,
  retrieveGlobalContextRemotely,
  retrievePerDocumentContextRemotely,
  searchGlobalContextRemotely,
} from "./retrieval-service/remote-retrieval.js";
import { describeVectorStoreRuntime, mergeRouteSummaries } from "./vector-store.js";
import {
  prepareComparisonSourceBundle,
  prepareQASourceBundle,
  writeComparisonAnswer,
  writeQaAnswer,
} from "./answer-writer.js";
import { getAdmissionScore, getResultKey } from "./citations.js";
import { lookupSemanticCache, storeSemanticCacheAnswer } from "./semantic-cache.js";

const getResultMergeScore = (result = {}) =>
  (Number(result.keywordScore) || 0) * 2 + (Number(result.score) || 0);

// One candidate can arrive from several retrieval queries, each with its own
// route ranks. The merged result keeps the strongest scoring copy but the
// union of every query that produced it, so the trace can show the whole path.
const mergeProvenance = (kept = {}, incoming = {}) => {
  const keptProvenance = kept.provenance ?? {};
  const incomingProvenance = incoming.provenance ?? {};
  const seen = new Set();
  const queries = [];

  for (const query of [
    ...(Array.isArray(keptProvenance.queries) ? keptProvenance.queries : []),
    ...(Array.isArray(incomingProvenance.queries) ? incomingProvenance.queries : []),
  ]) {
    const key = String(query?.queryId ?? "");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    queries.push(query);
  }

  return {
    ...keptProvenance,
    queries,
  };
};

const mergeResultPair = (existing, incoming) => {
  const kept =
    getResultMergeScore(incoming) > getResultMergeScore(existing)
      ? incoming
      : existing;

  return {
    ...kept,
    provenance: mergeProvenance(kept, kept === existing ? incoming : existing),
  };
};

// The id prefix of a retrieval query that searches a cross-language rewrite
// (chat(), rag/query-translation.js).
const TRANSLATION_QUERY_ID_PREFIX = "translation-";

// Whether a candidate's stored keywordScore was measured against a rewrite:
// mergeProvenance lists the winning copy's query first.
const foundByTranslation = (result) =>
  String(result?.provenance?.queries?.[0]?.queryId ?? "").startsWith(TRANSLATION_QUERY_ID_PREFIX);

export const tagResultsWithQuery = (results = [], retrievalQuery = {}) =>
  (Array.isArray(results) ? results : []).map((result) => {
    const provenance = result.provenance ?? { fusion: null, routes: [] };

    return {
      ...result,
      provenance: {
        ...provenance,
        queries: [
          {
            fusion: provenance.fusion ?? null,
            primary: Boolean(retrievalQuery.primary),
            queryId: String(retrievalQuery.id ?? "query"),
            routes: Array.isArray(provenance.routes) ? provenance.routes : [],
          },
        ],
      },
    };
  });

export const mergeRetrievedResults = (...resultGroups) => {
  const mergedResults = [];
  const resultIndexByKey = new Map();

  for (const results of resultGroups) {
    for (const result of results ?? []) {
      const resultKey = getResultKey(result);
      const existingIndex = resultIndexByKey.get(resultKey);

      if (existingIndex !== undefined) {
        mergedResults[existingIndex] = mergeResultPair(
          mergedResults[existingIndex],
          result
        );
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
          mergedResults[existingIndex] = mergeResultPair(
            mergedResults[existingIndex],
            result
          );
          continue;
        }

        resultIndexByKey.set(resultKey, mergedResults.length);
        mergedResults.push(result);
      }
    }
  }

  return mergedResultsByDoc;
};

const toComparableScore = (value) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
};

const toComparableRank = (value) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

// A single request fans out into several retrieval queries, and their results are
// merged into one candidate pool that -- until here -- kept first-query-wins order
// (mergeRetrievedResults preserves insertion order). Re-rank the whole pool by one
// global order so the final Top-K and every citation rank reflect the merged
// evidence, not the order the sub-queries happened to run in. `score` (the fusion
// rank, or the rerank-blended score when rerank ran) stays the primary key -- RRF
// and rerank are the legitimate candidate rankers -- with the raw admission and
// route signals as deterministic tiebreakers and getResultKey as a unique total
// order, so the sort is fully stable and identical across runs.
const compareMergedResults = (left, right) =>
  toComparableScore(right.score) - toComparableScore(left.score) ||
  getAdmissionScore(right) - getAdmissionScore(left) ||
  toComparableRank(left.denseRank) - toComparableRank(right.denseRank) ||
  toComparableRank(left.sparseRank) - toComparableRank(right.sparseRank) ||
  toComparableScore(right.vectorScore) - toComparableScore(left.vectorScore) ||
  toComparableScore(right.sparseScore) - toComparableScore(left.sparseScore) ||
  toComparableScore(right.keywordScore) - toComparableScore(left.keywordScore) ||
  getResultKey(left).localeCompare(getResultKey(right));

// Order the merged pool globally and cut to the unified final Top-K. A non-finite
// or non-positive topK means "keep every candidate", only re-rank. Pure: it copies
// before sorting so callers that also hold the raw merged array are unaffected.
const rerankMergedResults = (results, finalTopK) => {
  const ordered = [...(Array.isArray(results) ? results : [])].sort(
    compareMergedResults
  );

  return Number.isFinite(finalTopK) && finalTopK > 0
    ? ordered.slice(0, finalTopK)
    : ordered;
};

/**
 * What actually ran for this request: the provider, whether both routes
 * executed, and how many candidates each produced across every retrieval
 * query. Recorded in the trace and returned on the response so an evaluation
 * report can be checked against it rather than against a config flag.
 */
const buildRetrievalSummary = ({ queryCount, routes }) => {
  const runtime = describeVectorStoreRuntime();

  return {
    denseBackend: runtime.denseBackend,
    fallback: null,
    hybridEnabled: runtime.hybridEnabled,
    hybridFusion: runtime.hybridFusion,
    queryCount,
    routes,
    sparseBackend: runtime.sparseBackend,
    vectorStoreProvider: runtime.vectorStoreProvider,
  };
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

// The retrieval seam. Every chunk the document RAG path reads -- the QA and
// comparison retrievals, the gap plan's supplemental searches, and
// retrieveQaCandidates for the evaluation entry points -- comes
// through retrieveGlobalContextForQueries,
// retrievePerDocumentContextForQueries or searchGlobalContext below. In
// process they run the *InProcess functions against this process's vector
// store. When retrieval runs remotely (RETRIEVAL_SERVICE_URL,
// service-topology.js) they send the query texts, docIds and options to the
// retrieval tier (retrieval-service/), which runs the same *InProcess
// functions under the caller's tenant and embeds every query itself; this
// process then reads no chunk table and embeds nothing for retrieval.
// `accessScope` is the tenant a remote retrieval acts for
// (remote-retrieval.js resolveRetrievalAccessScope); in process it is unused,
// since the database tenant bound to the request already scopes the search.

// `queryAdapterScope` (rag/query-adapter.js): the single-document QA route's
// own retrieval passes QUERY_ADAPTER_SCOPE_QA; agent-planned retrieval does
// not, so it stays unadapted until it is measured. A retrieval query marked
// primary whose text is `primaryQueryText` searches with `primaryQueryVector`;
// every other query is embedded here (the retrieval tier passes neither, so
// each query goes through the same embedding cache).
export const retrieveGlobalContextForQueriesInProcess = async ({
  docIds,
  primaryQueryVector,
  primaryQueryText,
  retrievalQueries,
  retrievalOptions = {},
  queryAdapterScope = null,
}) => {
  const searches = await Promise.all(
    retrievalQueries.map(async (retrievalQuery) => {
      const queryVector =
        retrievalQuery.primary && retrievalQuery.query === primaryQueryText
          ? primaryQueryVector
          : await embedQueryCached(retrievalQuery.query);
      const search = await retrieveGlobalContextWithRoutes({
        queryVector,
        queryText: retrievalQuery.query,
        docIds,
        topK: retrievalOptions.topK,
        queryAdapterScope,
      });

      return {
        results: tagResultsWithQuery(search.results, retrievalQuery),
        routes: search.routes,
      };
    })
  );

  return {
    // The unified final Top-K budgets one retrieval depth (topK) per requirement,
    // not per request: query decomposition fans a compound question into several
    // sub-queries so that "when does it take effect AND which regions" retrieves
    // evidence for both aspects, and each aspect needs room for its own topK. A
    // per-request cap of topK would collapse the union back to a single aspect (at
    // topK=1 it would strand every requirement but one). Each sub-query already
    // returns at most topK, so topK*queryCount never truncates real per-requirement
    // evidence -- it only bounds a runaway pool -- and the value here is the global
    // re-rank that makes citation rank follow the merged order, not the sub-query
    // order.
    results: rerankMergedResults(
      mergeRetrievedResults(...searches.map((search) => search.results)),
      (retrievalOptions.topK ?? getRetrievalTopK()) * retrievalQueries.length
    ),
    retrieval: buildRetrievalSummary({
      queryCount: retrievalQueries.length,
      routes: mergeRouteSummaries(...searches.map((search) => search.routes)),
    }),
  };
};

export const retrievePerDocumentContextForQueriesInProcess = async ({
  docIds,
  primaryQueryVector,
  primaryQueryText,
  retrievalQueries,
  retrievalOptions = {},
}) => {
  const searches = await Promise.all(
    retrievalQueries.map(async (retrievalQuery) => {
      const queryVector =
        retrievalQuery.primary && retrievalQuery.query === primaryQueryText
          ? primaryQueryVector
          : await embedQueryCached(retrievalQuery.query);
      const search = await retrievePerDocumentContextWithRoutes({
        queryVector,
        queryText: retrievalQuery.query,
        docIds,
        topKPerDoc: retrievalOptions.topKPerDoc,
      });

      return {
        resultsByDocument: new Map(
          [...search.resultsByDocument.entries()].map(([docId, results]) => [
            docId,
            tagResultsWithQuery(results, retrievalQuery),
          ])
        ),
        routes: search.routes,
      };
    })
  );

  // Per document, budget one retrieval depth (topKPerDoc) per requirement for the
  // same reason as the global path: a decomposed comparison retrieves evidence for
  // each aspect within each document, and a per-request cap would drop all but one
  // aspect's evidence. Each sub-query returns at most topKPerDoc per document, so
  // topKPerDoc*queryCount preserves the union while the global re-rank fixes order.
  const finalTopKPerDoc =
    (retrievalOptions.topKPerDoc ?? getComparisonTopKPerDoc()) *
    retrievalQueries.length;
  const mergedResultsByDocument = mergePerDocumentResults(
    docIds,
    ...searches.map((search) => search.resultsByDocument)
  );

  return {
    resultsByDocument: new Map(
      [...mergedResultsByDocument.entries()].map(([docId, results]) => [
        docId,
        rerankMergedResults(results, finalTopKPerDoc),
      ])
    ),
    retrieval: buildRetrievalSummary({
      queryCount: retrievalQueries.length,
      routes: mergeRouteSummaries(...searches.map((search) => search.routes)),
    }),
  };
};

// One query's retrieveGlobalContextWithRoutes, embedded here: the gap plan's
// supplemental searches, which keep the retriever's own order and are tagged
// by the caller.
export const searchGlobalContextInProcess = async ({ docIds, queryText, topK = null }) =>
  retrieveGlobalContextWithRoutes({
    queryVector: await embedQueryCached(queryText),
    queryText,
    docIds,
    topK,
  });

const retrieveGlobalContextForQueries = ({ accessScope = null, ...args }) =>
  isRetrievalRemote()
    ? retrieveGlobalContextRemotely({ accessScope, ...args })
    : retrieveGlobalContextForQueriesInProcess(args);

const retrievePerDocumentContextForQueries = ({ accessScope = null, ...args }) =>
  isRetrievalRemote()
    ? retrievePerDocumentContextRemotely({ accessScope, ...args })
    : retrievePerDocumentContextForQueriesInProcess(args);

const searchGlobalContext = ({ accessScope = null, ...args }) =>
  isRetrievalRemote()
    ? searchGlobalContextRemotely({ accessScope, ...args })
    : searchGlobalContextInProcess(args);

const buildQaGapPlan = async ({
  accessScope = null,
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
      const { results: supplementalResults } = await searchGlobalContext({
        accessScope,
        queryText: supplementalQuery.query,
        docIds,
      });

      return {
        ...supplementalQuery,
        results: tagResultsWithQuery(supplementalResults, {
          id: supplementalQuery.id ?? `supplemental-${supplementalQuery.label ?? ""}`,
          primary: false,
        }),
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
  vectorStoreProvider: getVectorStoreProvider(),
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

const buildRetrievalInputs = async ({
  agentRetrievalPlan,
  docIds,
  queryTranslations = [],
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
  const plannedRetrievalQueries = [
    ...(agentRetrievalPlan?.retrievalQueries?.length
      ? agentRetrievalPlan.retrievalQueries
      : retrievalQueries),
    // The question rewritten for the selected documents in other scripts
    // (chat(), rag/query-translation.js). The plan itself, and so the semantic
    // cache key, stays as planned: a rewrite follows from the question and the
    // documents, which the key already holds.
    ...queryTranslations
      .filter((translation) => translation.query)
      .map(({ query, script }) => ({
        id: `${TRANSLATION_QUERY_ID_PREFIX}${script}`,
        label: `Question in ${script} script`,
        query,
        primary: false,
      })),
  ];
  const retrievalOptions = agentRetrievalPlan?.retrievalOptions ?? {};
  const retrievalRemote = isRetrievalRemote();
  const semanticCacheEnabled = isSemanticCacheEnabled();
  // With remote retrieval the retrieval tier embeds every query it searches;
  // the vector is needed here only for the semantic answer cache's lookup,
  // and is then embedded through this process's own embedding path (the
  // model gateway when one is configured), in the space the index serves.
  const queryEmbedding =
    retrievalRemote && !semanticCacheEnabled ? null : embedQueryCached(resolvedQuery);

  // In process with the semantic cache off, retrieval embeds every planned
  // query right after this (retrieve*ForQueriesInProcess). Their embeddings
  // start now, next to the question's, so retrieval finds them done or in
  // flight instead of starting them only once the question's is back. A
  // remote tier embeds its own queries, and a semantic cache hit would leave
  // them unused.
  if (!retrievalRemote && !semanticCacheEnabled) {
    prefetchQueryEmbeddings(
      plannedRetrievalQueries
        .map((retrievalQuery) => retrievalQuery.query)
        .filter((queryText) => queryText !== resolvedQuery)
    );
  }

  return {
    agentRetrievalPlan,
    evidenceRequirements,
    plannedRetrievalQueries,
    queryVector: await queryEmbedding,
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
  accessScope = null,
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
  const { resultsByDocument: perDocumentResults, retrieval } =
    await retrievePerDocumentContextForQueries({
      accessScope,
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
  const retrievalAlignment = alignComparisonEvidence({
    query: resolvedQuery,
    documents: selectedDocuments,
    perDocumentResults: confidence.usableResultsByDoc,
  });
  const bundle = prepareComparisonSourceBundle({
    alignment: retrievalAlignment,
  });
  const {
    alignment,
    analysis,
    summary: comparisonAnalysisSummary,
  } = buildComparisonAnalysisFromContexts({
    query: resolvedQuery,
    documents: selectedDocuments,
    retrievedContexts: bundle.retrievedContexts,
  });
  const traceFields = {
    ...buildCommonTraceFields({
      agentRetrievalPlan,
      evidenceRequirements,
      plannedRetrievalQueries,
      route,
    }),
    retrieval,
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
        retrieval,
        abstained: true,
        abstainReason: confidence.reason,
      },
    };
  }

  const { trace: answerTrace, ...generatedAnswer } = await writeComparisonAnswer({
    query,
    resolvedQuery,
    bundle,
    analysis,
    preferenceBlock,
  });

  // The writer's trace-only diagnostics (why the model's comparison answer
  // was replaced; codes and counts only) go to the trace, never into the
  // response.
  Object.assign(traceFields, answerTrace);

  return {
    routeMode: route.mode,
    traceFields,
    response: {
      ...generatedAnswer,
      retrievedContexts: bundle.retrievedContexts,
      evidenceSummary,
      comparisonAnalysisSummary,
      retrieval,
    },
  };
};

/**
 * The single-document QA route up to its confidence gate: the candidates
 * assessQaConfidence judges, built as executeDocumentRag builds them when no
 * agent retrieval plan is given, except that no cross-language rewrite
 * (rag/query-translation.js) is searched, since that takes a model call.
 * Exported so the abstention-gate analysis can replay the real gate over real
 * candidates under different thresholds without calling a chat model.
 */
export const retrieveQaCandidates = async ({ accessScope = null, docIds, resolvedQuery }) => {
  const inputs = await buildRetrievalInputs({
    agentRetrievalPlan: null,
    docIds,
    resolvedQuery,
  });
  const { results } = await retrieveGlobalContextForQueries({
    accessScope,
    primaryQueryVector: inputs.queryVector,
    primaryQueryText: resolvedQuery,
    retrievalQueries: inputs.plannedRetrievalQueries,
    retrievalOptions: inputs.retrievalOptions,
    docIds,
    queryAdapterScope: QUERY_ADAPTER_SCOPE_QA,
  });

  return {
    evidenceRequirementCount: inputs.evidenceRequirements?.length ?? 1,
    results,
    routeMode: inputs.route.mode,
  };
};

const executeQaRag = async ({
  accessScope = null,
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
  const queryAdapterScope = agentRetrievalPlan ? null : QUERY_ADAPTER_SCOPE_QA;
  // The agent's follow-up asks the original question but retrieves with
  // gap-repair queries built from the unsupported claims; its gate judges every
  // candidate against the question.
  const coverageFromQueryText = agentRetrievalPlan?.phase === "follow_up";
  const { results: retrievalResults, retrieval } =
    await retrieveGlobalContextForQueries({
      accessScope,
      primaryQueryVector: queryVector,
      primaryQueryText: resolvedQuery,
      retrievalQueries: plannedRetrievalQueries,
      retrievalOptions,
      docIds,
      queryAdapterScope,
    });
  // A rewrite is a paraphrase in another language: a candidate it found may
  // clear the gate on semantic similarity, as a comparison's may (X3).
  const confidence = assessQaConfidence({
    allowSemanticBypassFor: foundByTranslation,
    coverageFromQueryText,
    results: retrievalResults,
    queryText: resolvedQuery,
  });
  const evidenceSummary = buildQaEvidenceSummary({
    confidence,
    docIds,
    requirements: evidenceRequirements,
    results: retrievalResults,
  });
  // The gate decides whether to answer; once it does, the model also sees the
  // further candidates selectQaContext lets through, not only the chunks each
  // clearing the coverage floor on its own.
  const contextResults = confidence.confident
    ? selectQaContext({
        confidence,
        limit: retrievalOptions.topK ?? getRetrievalTopK(),
        minCoverage: QA_CONTEXT_MIN_COVERAGE,
        queryText: resolvedQuery,
        results: retrievalResults,
      })
    : confidence.usableResults;
  const bundle = prepareQASourceBundle({
    results: contextResults,
  });
  const traceFields = {
    ...buildCommonTraceFields({
      agentRetrievalPlan,
      evidenceRequirements,
      plannedRetrievalQueries,
      route,
    }),
    retrieval,
    retrievalResults: retrievalResults.map((result) => buildResultTrace(result)),
    contextExtraCount: contextResults.length - confidence.usableResults.length,
    confidence: buildConfidenceTrace(confidence),
    evidenceSummary,
    finalSourceBundle: buildBundleTrace(bundle),
  };

  if (!confidence.confident) {
    const gapPlan = await buildQaGapPlan({
      accessScope,
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
        retrieval,
        abstained: true,
        abstainReason: gapPlan.userMessage,
        gapPlan: {
          missingAspects: gapPlan.missingAspects,
          supplementalSearches: gapPlan.supplementalSearches,
        },
      },
    };
  }

  const answer = await writeQaAnswer({
    query,
    resolvedQuery,
    bundle,
    preferenceBlock,
  });

  // The answer's trace fields go to the RAG trace, never into the response.
  const { trace: answerTrace, ...response } = answer;

  Object.assign(traceFields, answerTrace);

  return {
    routeMode: route.mode,
    traceFields,
    response: {
      ...response,
      retrievedContexts: bundle.retrievedContexts,
      evidenceSummary,
      retrieval,
    },
  };
};

// Further candidates need no query term of their own: a paragraph answering in
// other words ("We evaluate on SQuAD" for "What datasets do they use?") often
// shares none. On QASPER train this floor put the most evidence in the context
// (0.335 against 0.318 at one shared term and 0.23 before widening).
export const QA_CONTEXT_MIN_COVERAGE = 0;

const runDocumentRag = ({
  accessScope,
  docIds,
  preferenceBlock,
  query,
  resolvedQuery,
  retrievalInputs,
  selectedDocuments,
}) =>
  retrievalInputs.route.mode === "compare"
    ? executeComparisonRag({
        ...retrievalInputs,
        accessScope,
        docIds,
        preferenceBlock,
        query,
        resolvedQuery,
        selectedDocuments,
      })
    : executeQaRag({
        ...retrievalInputs,
        accessScope,
        docIds,
        preferenceBlock,
        query,
        resolvedQuery,
      });

// `accessScope` is the request's tenant; the semantic answer cache
// (semantic-cache.js, RAG_SEMANTIC_CACHE=on) keys on it and is skipped for a
// caller that does not pass one. `includeRetrievedContexts` says whether the
// caller will read retrievedContexts: the cache keeps chunk text only for
// such callers and serves them only entries that kept it. With the cache off
// nothing here changes.
export const executeDocumentRag = async ({
  accessScope = null,
  agentRetrievalPlan = null,
  docIds,
  includeRetrievedContexts = false,
  preferenceBlock = "",
  query,
  queryTranslations = [],
  resolvedQuery,
  selectedDocuments,
}) => {
  const retrievalInputs = await buildRetrievalInputs({
    agentRetrievalPlan,
    docIds,
    queryTranslations,
    resolvedQuery,
  });
  const cacheLookup = await lookupSemanticCache({
    accessScope,
    agentRetrievalPlan,
    docIds,
    includeRetrievedContexts,
    preferenceBlock,
    query,
    queryVector: retrievalInputs.queryVector,
    requirementCount: retrievalInputs.evidenceRequirements?.length ?? 1,
    resolvedQuery,
    routeMode: retrievalInputs.route.mode,
    selectedDocuments,
  });

  if (cacheLookup?.hit) {
    return {
      routeMode: retrievalInputs.route.mode,
      traceFields: {
        ...buildCommonTraceFields(retrievalInputs),
        semanticCache: cacheLookup.trace,
      },
      response: cacheLookup.response,
    };
  }

  const execution = await runDocumentRag({
    accessScope,
    docIds,
    preferenceBlock,
    query,
    resolvedQuery,
    retrievalInputs,
    selectedDocuments,
  });

  if (cacheLookup) {
    execution.traceFields = {
      ...execution.traceFields,
      semanticCache: {
        ...cacheLookup.trace,
        ...storeSemanticCacheAnswer(cacheLookup, execution.response),
      },
    };
  }

  return execution;
};
