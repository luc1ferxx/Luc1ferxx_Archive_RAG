import {
  getRerankCandidateMultiplier,
  getRetrievalTopK,
  isRerankEnabled,
} from "../config.js";
import { rerankResults } from "../reranker.js";
import { searchDocuments } from "../vector-store.js";

export const retrieveGlobalContext = async ({ queryVector, queryText, docIds }) => {
  const topK = getRetrievalTopK();
  const candidateK = isRerankEnabled()
    ? topK * getRerankCandidateMultiplier()
    : topK;
  const results = await searchDocuments({
    queryVector,
    queryText,
    docIds,
    topK: candidateK,
  });

  return rerankResults({
    queryText,
    results,
    topK,
  });
};
