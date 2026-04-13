import { getComparisonTopKPerDoc } from "../config.js";
import { searchDocumentsPerDocument } from "../vector-store.js";

export const retrievePerDocumentContext = ({ queryVector, docIds }) =>
  searchDocumentsPerDocument({
    queryVector,
    docIds,
    topKPerDoc: getComparisonTopKPerDoc(),
  });
