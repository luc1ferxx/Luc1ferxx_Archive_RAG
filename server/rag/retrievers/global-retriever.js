import {
  getRerankCandidateMultiplier,
  getRetrievalTopK,
  isRerankEnabled,
} from "../config.js";
import { rerankResultsWithProvider } from "../reranker.js";
import { searchDocumentsWithRoutes } from "../vector-store.js";

// Rerank sits after fusion on purpose: it reorders the candidates the two
// routes already produced and can never stand in for a route that did not run.

export const retrieveGlobalContextWithRoutes = async ({
  queryVector,
  queryText,
  docIds,
  topK: requestedTopK,
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
  });
  const results = await rerankResultsWithProvider({
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
