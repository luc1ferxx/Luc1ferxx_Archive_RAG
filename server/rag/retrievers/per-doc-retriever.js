import {
  getComparisonTopKPerDoc,
  getRerankCandidateMultiplier,
  isRerankEnabled,
} from "../config.js";
import { rerankResultsWithProvider } from "../reranker.js";
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
    await Promise.all(
      [...perDocumentCandidates.entries()].map(async ([docId, results]) => [
        docId,
        await rerankResultsWithProvider({
          queryText,
          results,
          topK: topKPerDoc,
        }),
      ])
    )
  );
};
