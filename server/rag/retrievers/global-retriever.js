import {
  getRerankCandidateMultiplier,
  getRetrievalTopK,
  isRerankEnabled,
} from "../config.js";
import { rerankResultsWithProvider } from "../reranker.js";
import { searchDocuments } from "../vector-store.js";

export const retrieveGlobalContext = async ({
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
  const results = await searchDocuments({
    queryVector,
    queryText,
    docIds,
    topK: candidateK,
  });

  return rerankResultsWithProvider({
    queryText,
    results,
    topK,
  });
};
