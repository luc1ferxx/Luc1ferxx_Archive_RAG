import { getComparisonTopKPerDoc } from "../config.js";
import { searchDocumentsPerDocument } from "../vector-store.js";

export const retrievePerDocumentContext = ({ queryVector, queryText, docIds }) =>
  searchDocumentsPerDocument({
    queryVector,
    queryText,
    docIds,
    topKPerDoc: getComparisonTopKPerDoc(),
  });
