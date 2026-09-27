import {
  getRerankCandidateMultiplier,
  getRetrievalTopK,
  isRerankEnabled,
} from "../config.js";
import { rerankResultsOrKeepOrder } from "../reranker.js";
import { searchDocumentsWithRoutes } from "../vector-store.js";

// Rerank sits after fusion on purpose: it reorders the candidates the two
// routes already produced and can never stand in for a route that did not run.

// `queryAdapterScope`: set by the single-document QA route only
// (rag/query-adapter.js); every other caller searches unadapted.
export const retrieveGlobalContextWithRoutes = async ({
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
  const results = await rerankResultsOrKeepOrder({
    queryText,
    results: search.results,
    topK,
  });

  return {
    fusion: search.fusion,
    results,
    routes: search.routes,
  };
};

export const retrieveGlobalContext = async (args) =>
  (await retrieveGlobalContextWithRoutes(args)).results;
