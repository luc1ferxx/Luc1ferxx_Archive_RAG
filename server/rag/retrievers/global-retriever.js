import { getRetrievalTopK } from "../config.js";
import { searchDocuments } from "../vector-store.js";

export const retrieveGlobalContext = ({ queryVector, queryText, docIds }) =>
  searchDocuments({
    queryVector,
    queryText,
    docIds,
    topK: getRetrievalTopK(),
  });
