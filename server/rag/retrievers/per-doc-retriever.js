import {
  getComparisonTopKPerDoc,
  getRerankCandidateMultiplier,
  isRerankEnabled,
} from "../config.js";
import { rerankResultsOrKeepOrder } from "../reranker.js";
import { searchDocumentsPerDocumentWithRoutes } from "../vector-store.js";

export const retrievePerDocumentContextWithRoutes = async ({
  queryVector,
  queryText,
  docIds,
  topKPerDoc: requestedTopKPerDoc,
}) => {
  const topKPerDoc =
    Number.isFinite(Number(requestedTopKPerDoc)) && Number(requestedTopKPerDoc) > 0
      ? Math.floor(Number(requestedTopKPerDoc))
      : getComparisonTopKPerDoc();
  const candidateKPerDoc = isRerankEnabled()
    ? topKPerDoc * getRerankCandidateMultiplier()
    : topKPerDoc;
  const search = await searchDocumentsPerDocumentWithRoutes({
    queryVector,
    queryText,
    docIds,
    topKPerDoc: candidateKPerDoc,
  });
  const resultsByDocument = new Map(
    await Promise.all(
      [...search.resultsByDocument.entries()].map(async ([docId, results]) => [
        docId,
        await rerankResultsOrKeepOrder({
          queryText,
          results,
          topK: topKPerDoc,
        }),
      ])
    )
  );

  return {
    resultsByDocument,
    routes: search.routes,
  };
};

export const retrievePerDocumentContext = async (args) =>
  (await retrievePerDocumentContextWithRoutes(args)).resultsByDocument;
