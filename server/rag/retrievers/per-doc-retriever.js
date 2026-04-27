import {
  getComparisonTopKPerDoc,
  getRerankCandidateMultiplier,
  isRerankEnabled,
} from "../config.js";
import { rerankResults } from "../reranker.js";
import { searchDocumentsPerDocument } from "../vector-store.js";

export const retrievePerDocumentContext = async ({ queryVector, queryText, docIds }) => {
  const topKPerDoc = getComparisonTopKPerDoc();
  const candidateKPerDoc = isRerankEnabled()
    ? topKPerDoc * getRerankCandidateMultiplier()
    : topKPerDoc;
  const perDocumentCandidates = await searchDocumentsPerDocument({
    queryVector,
    queryText,
    docIds,
    topKPerDoc: candidateKPerDoc,
  });

  return new Map(
    [...perDocumentCandidates.entries()].map(([docId, results]) => [
      docId,
      rerankResults({
        queryText,
        results,
        topK: topKPerDoc,
      }),
    ])
  );
};
