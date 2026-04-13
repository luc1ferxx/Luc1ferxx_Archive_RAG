import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { getEmbeddings } from "./openai.js";

let globalVectorStorePromise = null;

const getGlobalVectorStore = async () => {
  if (!globalVectorStorePromise) {
    globalVectorStorePromise = MemoryVectorStore.fromExistingIndex(
      getEmbeddings()
    );
  }

  return globalVectorStorePromise;
};

export const addDocumentsToIndex = async ({ documents }) => {
  const vectorStore = await getGlobalVectorStore();
  await vectorStore.addDocuments(documents);
};

export const searchDocuments = async ({ queryVector, docIds, topK }) => {
  const vectorStore = await getGlobalVectorStore();
  const results = await vectorStore.similaritySearchVectorWithScore(
    queryVector,
    topK,
    (document) => docIds.includes(document.metadata?.docId)
  );

  return results.map(([document, score]) => ({
    document,
    score,
    vectorScore: score,
    keywordScore: null,
  }));
};

export const searchDocumentsPerDocument = async ({
  queryVector,
  docIds,
  topKPerDoc,
}) => {
  const perDocumentResults = new Map();

  for (const docId of docIds) {
    perDocumentResults.set(
      docId,
      await searchDocuments({
        queryVector,
        docIds: [docId],
        topK: topKPerDoc,
      })
    );
  }

  return perDocumentResults;
};
