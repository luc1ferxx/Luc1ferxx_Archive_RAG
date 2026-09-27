import {
  getEmbeddingIndexIdentity,
  getKeywordWeight,
  getVectorWeight,
  isEmbeddingIdentityCurrent,
} from "./config.js";
import { embedTexts } from "./openai.js";
import { buildTermSet } from "./text-utils.js";
import { getRagDataPath, readJsonFileSync, writeJsonFileSync, writeJsonFileAsync } from "./storage.js";

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
  // getEmbeddingIndexIdentity() at write time; null for entries written before
  // it was recorded.
  embeddingIdentity: typeof entry.embeddingIdentity === "string" ? entry.embeddingIdentity : null,
});

const loadVectorEntries = () => {
  const storedEntries = readJsonFileSync(vectorIndexPath(), []);

  return storedEntries
    .map((entry) => normalizeEntry(entry))
    .filter((entry) => entry.id && entry.pageContent && entry.metadata.docId && entry.vector.length > 0);
};

let vectorEntries = loadVectorEntries();

let writeQueue = Promise.resolve();

const withWriteLock = (task) => {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
};

const persistVectorEntries = () => {
  writeJsonFileSync(vectorIndexPath(), vectorEntries);
};

const persistVectorEntriesAsync = () =>
  writeJsonFileAsync(vectorIndexPath(), vectorEntries);

const magnitude = (vector) =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

const cosineSimilarity = (left, right) => {
  // Length mismatch returns 0 rather than a partial score. Comparing the first N
  // components of two different embedding spaces is meaningless, but it is not
  // harmlessly meaningless: the old code took the dot product over
  // Math.min(length) and divided by both FULL magnitudes, which yields a deflated
  // but substantial number -- two all-ones vectors of 1536 and 3072 dimensions
  // score 0.7071, well above the 0.32 default in getMinRelevanceScore(). So a
  // stale document did not merely rank badly, it qualified as evidence and got
  // cited. Silent, and worse than returning nothing.
  //
  // Reachable whenever OPENAI_EMBEDDING_MODEL or OPENAI_BASE_URL changes, which
  // for a product that supports any OpenAI-compatible endpoint is a normal user
  // action rather than an error.
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length === 0 ||
    right.length === 0 ||
    left.length !== right.length
  ) {
    return 0;
  }

  const sharedLength = left.length;
  let dotProduct = 0;

  for (let index = 0; index < sharedLength; index += 1) {
    dotProduct += left[index] * right[index];
  }

  const denominator = magnitude(left) * magnitude(right);

  return denominator > 0 ? dotProduct / denominator : 0;
};

// Scoring 0 is correct but silent, and a user whose archive suddenly stopped
// matching anything needs to know why. Deduplicated by shape so a mismatched
// archive does not print once per query.
const reportedDimensionMismatches = new Set();

export const resetDimensionMismatchReports = () => {
  reportedDimensionMismatches.clear();
  reportedIdentityMismatches.clear();
};

const reportDimensionMismatch = ({ queryLength, entries }) => {
  const storedLengths = new Set();
  let skippedCount = 0;

  for (const entry of entries) {
    const length = Array.isArray(entry.vector) ? entry.vector.length : 0;
    if (length !== queryLength) {
      storedLengths.add(length);
      skippedCount += 1;
    }
  }

  if (skippedCount === 0) {
    return null;
  }

  const signature = `${queryLength}:${[...storedLengths].sort((a, b) => a - b).join(",")}`;

  if (reportedDimensionMismatches.has(signature)) {
    return null;
  }

  reportedDimensionMismatches.add(signature);

  const message =
    `Dense retrieval skipped ${skippedCount} of ${entries.length} stored chunks: the query ` +
    `embedding is ${queryLength}-dimensional but stored chunks are ` +
    `${[...storedLengths].sort((a, b) => a - b).join("/")}-dimensional. This happens after ` +
    `OPENAI_EMBEDDING_MODEL or OPENAI_BASE_URL changes. Those documents cannot be ranked by ` +
    `meaning until they are re-ingested under the current embedding model; keyword matching ` +
    `still applies. Re-ingest them to restore dense ranking.`;

  console.warn(message);
  return message;
};


const reportedIdentityMismatches = new Set();

const reportEmbeddingIdentityMismatch = (entries) => {
  const stale = entries.filter((entry) => !isEmbeddingIdentityCurrent(entry.embeddingIdentity));

  if (stale.length === 0) {
    return;
  }

  const storedIdentities = [...new Set(stale.map((entry) => entry.embeddingIdentity ?? "unrecorded"))].sort();
  const signature = `${getEmbeddingIndexIdentity()}:${storedIdentities.join(",")}`;

  if (reportedIdentityMismatches.has(signature)) {
    return;
  }

  reportedIdentityMismatches.add(signature);
  console.warn(
    `Dense retrieval skipped ${stale.length} of ${entries.length} stored chunks embedded as ` +
      `${storedIdentities.join("/")}; the current embedding is ${getEmbeddingIndexIdentity()} ` +
      "(model plus task prefix). Keyword matching still applies. Re-ingest those documents to " +
      "restore dense ranking."
  );
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

// `vectors` are embeddings the staged ingest pipeline already computed (one per
// document, in order); without them the documents are embedded here as before.
export const addDocumentsToLocalIndex = async ({ documents, vectors: preparedVectors = null }) => {
  if (!Array.isArray(documents) || documents.length === 0) {
    return;
  }

  const vectors =
    Array.isArray(preparedVectors) && preparedVectors.length === documents.length
      ? preparedVectors
      : await embedTexts(documents.map((document) => document.pageContent));
  const nextEntries = documents.map((document, index) =>
    normalizeEntry({
      id: document.id,
      pageContent: document.pageContent,
      metadata: document.metadata,
      vector: vectors[index],
      embeddingIdentity: getEmbeddingIndexIdentity(),
    })
  );

  await withWriteLock(async () => {
    const replacementIds = new Set(nextEntries.map((entry) => entry.id));
    vectorEntries = vectorEntries.filter((entry) => !replacementIds.has(entry.id));
    vectorEntries.push(...nextEntries);
    await persistVectorEntriesAsync();
  });
};

export const removeDocumentsFromLocalIndex = async ({ docIds }) => {
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return;
  }

  await withWriteLock(async () => {
    const docIdSet = new Set(docIds);
    const remaining = vectorEntries.filter((entry) => !docIdSet.has(entry.metadata.docId));

    // Nothing matched, so there is nothing to write. Worth guarding because
    // ingest now rolls back unconditionally (rag/index.js): a failure that never
    // reached the index would otherwise rewrite this entire file, and it grows
    // with the archive.
    if (remaining.length === vectorEntries.length) {
      return;
    }

    vectorEntries = remaining;
    await persistVectorEntriesAsync();
  });
};

export const clearLocalVectorIndex = async () => {
  await withWriteLock(async () => {
    vectorEntries = [];
    await persistVectorEntriesAsync();
  });
};

// `scoreVector` (the query adapter, rag/query-adapter.js): rank by
// queryVector but report the cosine with scoreVector as vectorScore, and the
// ranking cosine as rankVectorScore. Without it nothing changes.
export const searchLocalDocuments = async ({
  queryVector,
  scoreVector = null,
  queryText = "",
  docIds,
  topK,
  scoringMode = "combined",
}) => {
  const docIdSet = new Set(docIds);
  const queryTerms = buildTermSet(queryText);
  const candidates = vectorEntries.filter((entry) => docIdSet.has(entry.metadata.docId));

  if (Array.isArray(queryVector) && queryVector.length > 0) {
    reportDimensionMismatch({ queryLength: queryVector.length, entries: candidates });
    reportEmbeddingIdentityMismatch(candidates);
  }

  return candidates
    .map((entry) => {
      // A vector from another model or task prefix lives in another space:
      // its cosine with this query means nothing, so it gets no dense score.
      const current = isEmbeddingIdentityCurrent(entry.embeddingIdentity);
      const vectorScore = current
        ? cosineSimilarity(queryVector, entry.vector)
        : 0;
      const keywordScore = buildKeywordScore(queryTerms, entry);
      const result = toSearchResult(entry, vectorScore, keywordScore, scoringMode);

      return scoreVector
        ? {
            ...result,
            rankVectorScore: vectorScore,
            vectorScore: current ? cosineSimilarity(scoreVector, entry.vector) : 0,
          }
        : result;
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
  const entries = await Promise.all(
    docIds.map(async (docId) => [
      docId,
      await searchLocalDocuments({
        queryVector,
        queryText,
        docIds: [docId],
        topK: topKPerDoc,
        scoringMode,
      }),
    ])
  );

  return new Map(entries);
};

export const resetLocalVectorStore = () => {
  vectorEntries = loadVectorEntries();
};
