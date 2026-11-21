import {
  getRerankCandidateMultiplier,
  getRetrievalTopK,
  isRerankEnabled,
} from "../config.js";
import { rerankResultsOrKeepOrder } from "../reranker.js";
import { searchDocumentsWithRoutes } from "../vector-store.js";

// Rerank sits after fusion on purpose: it reorders the candidates the two
// routes already produced and can never stand in for a route that did not run.

// One query's fused candidates, before any rerank: topK x the rerank
// multiplier while reranking is on, so the reranker has more to choose from.
// The multi-query retrievals (document-rag-execution.js) merge these across
// their queries and rerank the merged pool once; `topK` is what one query
// keeps. `queryAdapterScope`: set by the single-document QA route only
// (rag/query-adapter.js); every other caller searches unadapted.
export const searchGlobalCandidatesWithRoutes = async ({
  queryVector,
  queryText,
  docIds,
  topK: requestedTopK,
  queryAdapterScope = null,
}) => {
  const topK = Number.isFinite(Number(requestedTopK)) && Number(requestedTopK) > 0
    ? Math.floor(Number(requestedTopK))
    : getRetrievalTopK();
  const candidateK = isRerankEnabled()
    ? topK * getRerankCandidateMultiplier()
    : topK;
  const search = await searchDocumentsWithRoutes({
    queryVector,
    queryText,
    docIds,
    topK: candidateK,
    ...(queryAdapterScope ? { queryAdapterScope } : {}),
  });

  return { fusion: search.fusion, results: search.results, routes: search.routes, topK };
};

// One query searched and reranked on its own: the gap plan's supplemental
// searches (searchGlobalContextInProcess).
export const retrieveGlobalContextWithRoutes = async (args) => {
  const search = await searchGlobalCandidatesWithRoutes(args);
  const results = await rerankResultsOrKeepOrder({
    queryText: args.queryText,
    results: search.results,
    topK: search.topK,
  });

  return {
    fusion: search.fusion,
    results,
    routes: search.routes,
  };
};

export const retrieveGlobalContext = async (args) =>
  (await retrieveGlobalContextWithRoutes(args)).results;
