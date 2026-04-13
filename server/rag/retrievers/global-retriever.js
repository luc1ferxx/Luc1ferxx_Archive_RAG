import { getRetrievalTopK } from "../config.js";
import { searchDocuments } from "../vector-store.js";

export const retrieveGlobalContext = ({ queryVector, docIds }) =>
  searchDocuments({
    queryVector,
    docIds,
    topK: getRetrievalTopK(),
  });
