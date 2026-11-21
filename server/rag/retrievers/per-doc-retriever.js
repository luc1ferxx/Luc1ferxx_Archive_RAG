import {
  getComparisonTopKPerDoc,
  getRerankCandidateMultiplier,
  isRerankEnabled,
} from "../config.js";
import { rerankResultsOrKeepOrder } from "../reranker.js";
import { searchDocumentsPerDocumentWithRoutes } from "../vector-store.js";

// One query's fused candidates per document, before any rerank, as
// searchGlobalCandidatesWithRoutes (global-retriever.js) for the global route.
export const searchPerDocumentCandidatesWithRoutes = async ({
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

  return { resultsByDocument: search.resultsByDocument, routes: search.routes, topKPerDoc };
};

export const retrievePerDocumentContextWithRoutes = async (args) => {
  const search = await searchPerDocumentCandidatesWithRoutes(args);
  const resultsByDocument = new Map(
    await Promise.all(
      [...search.resultsByDocument.entries()].map(async ([docId, results]) => [
        docId,
        await rerankResultsOrKeepOrder({
          queryText: args.queryText,
          results,
          topK: search.topKPerDoc,
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
