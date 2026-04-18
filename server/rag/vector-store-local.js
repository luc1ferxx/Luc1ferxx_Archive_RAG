import { getKeywordWeight, getVectorWeight } from "./config.js";
import { embedTexts } from "./openai.js";
import { buildTermSet } from "./text-utils.js";
import { getRagDataPath, readJsonFileSync, writeJsonFileSync } from "./storage.js";

const vectorIndexPath = () => getRagDataPath("vector-index.json");

const normalizeMetadata = (metadata = {}) => ({
  ...metadata,
  docId: metadata.docId ?? "",
  fileName: metadata.fileName ?? "Unknown document",
  filePath: metadata.filePath ?? "",
  publicFilePath: metadata.publicFilePath ?? "",
  pageNumber: metadata.pageNumber ?? null,
  chunkIndex: metadata.chunkIndex ?? null,
  sectionHeading: metadata.sectionHeading ?? null,
});

const normalizeEntry = (entry = {}) => ({
  id: String(entry.id ?? ""),
  pageContent: String(entry.pageContent ?? ""),
  metadata: normalizeMetadata(entry.metadata),
  vector: Array.isArray(entry.vector) ? entry.vector.map((value) => Number(value) || 0) : [],
});

const loadVectorEntries = () => {
  const storedEntries = readJsonFileSync(vectorIndexPath(), []);

  return storedEntries
    .map((entry) => normalizeEntry(entry))
    .filter((entry) => entry.id && entry.pageContent && entry.metadata.docId && entry.vector.length > 0);
};

let vectorEntries = loadVectorEntries();

const persistVectorEntries = () => {
  writeJsonFileSync(vectorIndexPath(), vectorEntries);
};

const magnitude = (vector) =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

const cosineSimilarity = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return 0;
  }

  const sharedLength = Math.min(left.length, right.length);
  let dotProduct = 0;

  for (let index = 0; index < sharedLength; index += 1) {
    dotProduct += left[index] * right[index];
  }

  const denominator = magnitude(left) * magnitude(right);

  return denominator > 0 ? dotProduct / denominator : 0;
};

const buildKeywordScore = (queryTerms, entry) => {
  if (queryTerms.size === 0) {
    return null;
  }

  const searchableText = [
    entry.metadata?.fileName,
    entry.metadata?.sectionHeading,
    entry.pageContent,
  ]
    .filter(Boolean)
    .join("\n");
  const entryTerms = buildTermSet(searchableText);

  if (entryTerms.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const term of queryTerms) {
    if (entryTerms.has(term)) {
      overlap += 1;
    }
  }

  return overlap / queryTerms.size;
};

const buildCombinedScore = (vectorScore, keywordScore) => {
  if (keywordScore === null) {
    return vectorScore;
  }

  const weightedScore = vectorScore * getVectorWeight() + keywordScore * getKeywordWeight();

  return Math.max(vectorScore, keywordScore, weightedScore);
};

const buildResultScore = ({ vectorScore, keywordScore, scoringMode }) =>
  scoringMode === "dense"
    ? vectorScore
    : buildCombinedScore(vectorScore, keywordScore);

const toSearchResult = (entry, vectorScore, keywordScore, scoringMode) => ({
  document: {
    id: entry.id,
    pageContent: entry.pageContent,
    metadata: entry.metadata,
  },
  score: buildResultScore({
    vectorScore,
    keywordScore,
    scoringMode,
  }),
  vectorScore,
  keywordScore,
});

export const addDocumentsToLocalIndex = async ({ documents }) => {
  if (!Array.isArray(documents) || documents.length === 0) {
    return;
  }

  const vectors = await embedTexts(documents.map((document) => document.pageContent));
  const nextEntries = documents.map((document, index) =>
    normalizeEntry({
      id: document.id,
      pageContent: document.pageContent,
      metadata: document.metadata,
      vector: vectors[index],
    })
  );
  const replacementIds = new Set(nextEntries.map((entry) => entry.id));

  vectorEntries = vectorEntries.filter((entry) => !replacementIds.has(entry.id));
  vectorEntries.push(...nextEntries);
  persistVectorEntries();
};

export const removeDocumentsFromLocalIndex = async ({ docIds }) => {
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return;
  }

  const docIdSet = new Set(docIds);
  vectorEntries = vectorEntries.filter((entry) => !docIdSet.has(entry.metadata.docId));
  persistVectorEntries();
};

export const clearLocalVectorIndex = async () => {
  vectorEntries = [];
  persistVectorEntries();
};

export const searchLocalDocuments = async ({
  queryVector,
  queryText = "",
  docIds,
  topK,
  scoringMode = "combined",
}) => {
  const docIdSet = new Set(docIds);
  const queryTerms = buildTermSet(queryText);

  return vectorEntries
    .filter((entry) => docIdSet.has(entry.metadata.docId))
    .map((entry) => {
      const vectorScore = cosineSimilarity(queryVector, entry.vector);
      const keywordScore = buildKeywordScore(queryTerms, entry);
      return toSearchResult(entry, vectorScore, keywordScore, scoringMode);
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    )
    .slice(0, topK);
};

export const searchLocalDocumentsPerDocument = async ({
  queryVector,
  queryText = "",
  docIds,
  topKPerDoc,
  scoringMode = "combined",
}) => {
  const perDocumentResults = new Map();

  for (const docId of docIds) {
    perDocumentResults.set(
      docId,
      await searchLocalDocuments({
        queryVector,
        queryText,
        docIds: [docId],
        topK: topKPerDoc,
        scoringMode,
      })
    );
  }

  return perDocumentResults;
};

export const resetLocalVectorStore = () => {
  vectorEntries = loadVectorEntries();
};
