import {
  buildTermFrequencyMap,
  extractMeaningfulTokens,
} from "./text-utils.js";
import { getRagDataPath, readJsonFileSync, writeJsonFileSync } from "./storage.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const sparseIndexPath = () => getRagDataPath("sparse-index.json");

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
});

const toStoredEntry = (entry) => ({
  id: entry.id,
  pageContent: entry.pageContent,
  metadata: entry.metadata,
});

const getSearchableText = (entry) =>
  [entry.metadata?.fileName, entry.metadata?.sectionHeading, entry.pageContent]
    .filter(Boolean)
    .join("\n");

const hydrateEntry = (entry) => {
  const normalizedEntry = normalizeEntry(entry);
  const termFrequencies = buildTermFrequencyMap(getSearchableText(normalizedEntry));
  const terms = [...termFrequencies.keys()];

  return {
    ...normalizedEntry,
    termFrequencies,
    termSet: new Set(terms),
    documentLength: [...termFrequencies.values()].reduce((sum, value) => sum + value, 0),
  };
};

const loadSparseEntries = () => {
  const storedEntries = readJsonFileSync(sparseIndexPath(), []);

  return storedEntries
    .map((entry) => hydrateEntry(entry))
    .filter((entry) => entry.id && entry.pageContent && entry.metadata.docId);
};

let sparseEntries = loadSparseEntries();
let documentFrequencyByTerm = new Map();
let averageDocumentLength = 0;

const rebuildSparseStatistics = () => {
  const nextDocumentFrequencyByTerm = new Map();
  let totalDocumentLength = 0;

  for (const entry of sparseEntries) {
    totalDocumentLength += entry.documentLength;

    for (const term of entry.termSet) {
      nextDocumentFrequencyByTerm.set(term, (nextDocumentFrequencyByTerm.get(term) ?? 0) + 1);
    }
  }

  documentFrequencyByTerm = nextDocumentFrequencyByTerm;
  averageDocumentLength =
    sparseEntries.length > 0 ? totalDocumentLength / sparseEntries.length : 0;
};

const persistSparseEntries = () => {
  writeJsonFileSync(
    sparseIndexPath(),
    sparseEntries.map((entry) => toStoredEntry(entry))
  );
};

const getKeywordScore = (queryTerms, entry) => {
  if (queryTerms.length === 0) {
    return null;
  }

  let overlap = 0;

  for (const term of queryTerms) {
    if (entry.termSet.has(term)) {
      overlap += 1;
    }
  }

  return overlap / queryTerms.length;
};

const getDocumentFrequency = (term) => documentFrequencyByTerm.get(term) ?? 0;

const getInverseDocumentFrequency = (term) => {
  const documentCount = sparseEntries.length;

  if (documentCount === 0) {
    return 0;
  }

  const documentFrequency = getDocumentFrequency(term);

  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
};

const getBm25Score = (entry, queryTerms) => {
  if (queryTerms.length === 0 || entry.documentLength === 0) {
    return 0;
  }

  const averageLength = averageDocumentLength || 1;
  let score = 0;

  for (const term of queryTerms) {
    const termFrequency = entry.termFrequencies.get(term) ?? 0;

    if (termFrequency === 0) {
      continue;
    }

    const idf = getInverseDocumentFrequency(term);
    const denominator =
      termFrequency +
      BM25_K1 * (1 - BM25_B + BM25_B * (entry.documentLength / averageLength));

    score += idf * ((termFrequency * (BM25_K1 + 1)) / denominator);
  }

  return score;
};

const toSearchResult = (entry, sparseScore, keywordScore) => ({
  document: {
    id: entry.id,
    pageContent: entry.pageContent,
    metadata: entry.metadata,
  },
  score: sparseScore,
  sparseScore,
  keywordScore,
});

export const addDocumentsToSparseIndex = async ({ documents }) => {
  if (!Array.isArray(documents) || documents.length === 0) {
    return;
  }

  const nextEntries = documents.map((document) =>
    hydrateEntry({
      id: document.id,
      pageContent: document.pageContent,
      metadata: document.metadata,
    })
  );
  const replacementIds = new Set(nextEntries.map((entry) => entry.id));

  sparseEntries = sparseEntries.filter((entry) => !replacementIds.has(entry.id));
  sparseEntries.push(...nextEntries);
  rebuildSparseStatistics();
  persistSparseEntries();
};

export const removeDocumentsFromSparseIndex = async ({ docIds }) => {
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return;
  }

  const docIdSet = new Set(docIds);
  sparseEntries = sparseEntries.filter((entry) => !docIdSet.has(entry.metadata.docId));
  rebuildSparseStatistics();
  persistSparseEntries();
};

export const clearSparseIndex = async () => {
  sparseEntries = [];
  rebuildSparseStatistics();
  persistSparseEntries();
};

export const searchSparseDocuments = async ({ queryText = "", docIds, topK }) => {
  const queryTerms = [...new Set(extractMeaningfulTokens(queryText))];

  if (queryTerms.length === 0) {
    return [];
  }

  const docIdSet = new Set(docIds);

  return sparseEntries
    .filter((entry) => docIdSet.has(entry.metadata.docId))
    .map((entry) => {
      const sparseScore = getBm25Score(entry, queryTerms);
      const keywordScore = getKeywordScore(queryTerms, entry);

      return toSearchResult(entry, sparseScore, keywordScore);
    })
    .filter((result) => result.sparseScore > 0 || (result.keywordScore ?? 0) > 0)
    .sort(
      (left, right) =>
        right.sparseScore - left.sparseScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    )
    .slice(0, topK);
};

export const searchSparseDocumentsPerDocument = async ({
  queryText = "",
  docIds,
  topKPerDoc,
}) => {
  const perDocumentResults = new Map();

  for (const docId of docIds) {
    perDocumentResults.set(
      docId,
      await searchSparseDocuments({
        queryText,
        docIds: [docId],
        topK: topKPerDoc,
      })
    );
  }

  return perDocumentResults;
};

export const resetSparseStore = () => {
  sparseEntries = loadSparseEntries();
  rebuildSparseStatistics();
};

rebuildSparseStatistics();
