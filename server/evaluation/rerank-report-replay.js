import { buildExpectedEvidenceUnits, toDeterministicEmbedding } from "./eval-case-helpers.js";
import { chunkDocumentWithConfig } from "../rag/chunker.js";
import { rerankResultsWithConfig } from "../rag/reranker.js";
import { buildTermSet } from "../rag/text-utils.js";

const SUPPORTED_MODE_FIELDS = Object.freeze({
  chunkStrategy: "structured",
  vectorStoreProvider: "local",
  hybridEnabled: false,
  retrievalScoringMode: "combined",
  embeddingProvider: "deterministic",
  rerankProvider: "heuristic",
});

const POSITIVE_INTEGER_FIELDS = Object.freeze([
  "chunkSize",
  "topK",
  "topKPerDoc",
  "candidateMultiplier",
]);

const UNIT_NUMBER_FIELDS = Object.freeze([
  "vectorWeight",
  "keywordWeight",
  "rerankWeight",
]);

const magnitude = (vector) =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

const cosineSimilarity = (left, right) => {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length === 0 ||
    right.length === 0
  ) {
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

const buildKeywordScore = (queryTerms, document) => {
  if (queryTerms.size === 0) {
    return null;
  }

  const searchableText = [
    document.metadata?.fileName,
    document.metadata?.sectionHeading,
    document.pageContent,
  ]
    .filter(Boolean)
    .join("\n");
  const documentTerms = buildTermSet(searchableText);

  if (documentTerms.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const term of queryTerms) {
    if (documentTerms.has(term)) {
      overlap += 1;
    }
  }

  return overlap / queryTerms.size;
};

const buildCombinedScore = ({
  keywordScore,
  keywordWeight,
  vectorScore,
  vectorWeight,
}) => {
  if (keywordScore === null) {
    return vectorScore;
  }

  const weightedScore =
    vectorScore * vectorWeight + keywordScore * keywordWeight;

  return Math.max(vectorScore, keywordScore, weightedScore);
};

const roundScore = (value) =>
  Number.isFinite(value) ? Number(value.toFixed(6)) : null;

const toRankingEntry = ({
  docKeyByDocId,
  includeText = false,
  rank,
  result,
}) => ({
  rank,
  resultKey: `${result.document.metadata.docId}:${result.document.metadata.chunkIndex}`,
  docKey: docKeyByDocId.get(result.document.metadata.docId) ?? null,
  pageNumber: result.document.metadata.pageNumber ?? null,
  chunkIndex: result.document.metadata.chunkIndex ?? null,
  fileName: result.document.metadata.fileName ?? null,
  score: roundScore(Number(result.score)),
  originalScore: roundScore(Number(result.originalScore)),
  rerankScore: roundScore(Number(result.rerankScore)),
  vectorScore: roundScore(Number(result.vectorScore)),
  keywordScore: roundScore(Number(result.keywordScore)),
  ...(includeText ? { text: String(result.document.pageContent ?? "") } : {}),
});

const validateDocuments = (documentContracts) => {
  if (!Array.isArray(documentContracts) || documentContracts.length === 0) {
    throw new Error("documentContracts must be a non-empty array");
  }

  const seenDocKeys = new Set();

  for (const document of documentContracts) {
    const docKey = typeof document?.key === "string" ? document.key.trim() : "";

    if (
      !docKey ||
      seenDocKeys.has(docKey) ||
      typeof document?.fileName !== "string" ||
      !document.fileName.trim() ||
      !Array.isArray(document?.pages)
    ) {
      throw new Error("documentContracts contain an invalid or duplicate document");
    }

    seenDocKeys.add(docKey);
  }
};

export const getUnsupportedRerankReplayConfig = (config = {}) => {
  const issues = [];

  for (const [field, expected] of Object.entries(SUPPORTED_MODE_FIELDS)) {
    if (config?.[field] !== expected) {
      issues.push({ field, expected, actual: config?.[field] ?? null });
    }
  }

  for (const field of POSITIVE_INTEGER_FIELDS) {
    const value = config?.[field];

    if (!Number.isInteger(value) || value <= 0) {
      issues.push({ field, expected: "positive integer", actual: value ?? null });
    }
  }

  if (
    !Number.isInteger(config?.chunkOverlap) ||
    config.chunkOverlap < 0 ||
    (Number.isInteger(config?.chunkSize) &&
      config.chunkOverlap >= config.chunkSize)
  ) {
    issues.push({
      field: "chunkOverlap",
      expected: "integer >= 0 and < chunkSize",
      actual: config?.chunkOverlap ?? null,
    });
  }

  for (const field of UNIT_NUMBER_FIELDS) {
    const value = config?.[field];

    if (!Number.isFinite(value) || value < 0 || value > 1) {
      issues.push({
        field,
        expected: "finite number between 0 and 1",
        actual: value ?? null,
      });
    }
  }

  return issues;
};

const buildReplayIndex = ({ config, documentContracts }) => {
  validateDocuments(documentContracts);

  const docIdByKey = new Map();
  const docKeyByDocId = new Map();
  const indexedChunks = [];

  for (const document of documentContracts) {
    const docId = `rerank-replay:${document.key}`;
    const chunks = chunkDocumentWithConfig({
      docId,
      fileName: document.fileName,
      publicFilePath: "/evaluation-contract",
      pages: document.pages.map((text, index) => ({
        pageNumber: index + 1,
        text,
      })),
      chunkStrategy: config.chunkStrategy,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
    });

    docIdByKey.set(document.key, docId);
    docKeyByDocId.set(docId, document.key);
    indexedChunks.push(
      ...chunks.map((documentChunk, originalIndex) => ({
        document: documentChunk,
        originalIndex: indexedChunks.length + originalIndex,
        vector: toDeterministicEmbedding(documentChunk.pageContent),
      }))
    );
  }

  return {
    docIdByKey,
    docKeyByDocId,
    indexedChunks,
  };
};

export const buildRerankReplayContext = ({
  config,
  documentContracts,
} = {}) => {
  const unsupportedConfig = getUnsupportedRerankReplayConfig(config);

  if (unsupportedConfig.length > 0) {
    throw new Error(
      `unsupported rerank replay config: ${unsupportedConfig
        .map((issue) => issue.field)
        .join(", ")}`
    );
  }

  return {
    config,
    ...buildReplayIndex({ config, documentContracts }),
  };
};

const searchReplayIndex = ({
  config,
  docIds,
  indexedChunks,
  queryText,
  topK,
}) => {
  const allowedDocIds = new Set(docIds);
  const queryTerms = buildTermSet(queryText);
  const queryVector = toDeterministicEmbedding(queryText);

  return indexedChunks
    .filter((entry) => allowedDocIds.has(entry.document.metadata.docId))
    .map((entry) => {
      const vectorScore = cosineSimilarity(queryVector, entry.vector);
      const keywordScore = buildKeywordScore(queryTerms, entry.document);

      return {
        document: entry.document,
        originalIndex: entry.originalIndex,
        vectorScore,
        keywordScore,
        score: buildCombinedScore({
          vectorScore,
          keywordScore,
          vectorWeight: config.vectorWeight,
          keywordWeight: config.keywordWeight,
        }),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0) ||
        left.originalIndex - right.originalIndex
    )
    .slice(0, topK)
    .map(({ originalIndex: _originalIndex, ...result }) => result);
};

const replayRankingEntry = ({
  allowedDocKeys,
  config,
  docIdByKey,
  docKeyByDocId,
  expectedUnits,
  indexedChunks,
  k,
  question,
}) => {
  const docIds = allowedDocKeys.map((docKey) => {
    const docId = docIdByKey.get(docKey);

    if (!docId) {
      throw new Error(`unknown corpus document key: ${docKey}`);
    }

    return docId;
  });
  const candidates = searchReplayIndex({
    config,
    docIds,
    indexedChunks,
    queryText: question,
    topK: k * config.candidateMultiplier,
  });
  const baseline = candidates.slice(0, k);
  const reranked = rerankResultsWithConfig({
    queryText: question,
    results: candidates,
    topK: k,
    rerankEnabled: true,
    rerankWeight: config.rerankWeight,
  });

  return {
    k,
    candidateCount: candidates.length,
    expectedUnits,
    candidateRanking: candidates.map((result, index) =>
      toRankingEntry({
        result,
        docKeyByDocId,
        includeText: true,
        rank: index + 1,
      })
    ),
    baselineRanking: baseline.map((result, index) =>
      toRankingEntry({ result, docKeyByDocId, rank: index + 1 })
    ),
    rerankedRanking: reranked.map((result, index) =>
      toRankingEntry({ result, docKeyByDocId, rank: index + 1 })
    ),
  };
};

export const replayRerankCaseRankings = ({
  caseContract,
  config,
  documentContracts,
  replayContext = null,
} = {}) => {
  const resolvedContext =
    replayContext ?? buildRerankReplayContext({ config, documentContracts });
  const resolvedConfig = resolvedContext.config;

  const question =
    typeof caseContract?.question === "string" ? caseContract.question : "";
  const docKeys = Array.isArray(caseContract?.docKeys)
    ? caseContract.docKeys
    : [];

  if (!question.trim() || docKeys.length === 0) {
    throw new Error("caseContract must bind a question and document keys");
  }

  const expectedUnits = buildExpectedEvidenceUnits(
    caseContract.expectedEvidence
  );
  const { docIdByKey, docKeyByDocId, indexedChunks } = resolvedContext;

  if (caseContract.type === "compare" && docKeys.length > 1) {
    const perDocument = docKeys.flatMap((docKey) => {
      const documentExpectedUnits = expectedUnits.filter(
        (unit) => unit.docKey === docKey
      );

      // Keep replay partitioning identical to run-rerank-eval: comparison
      // documents without an expected evidence unit are not evaluated.
      if (documentExpectedUnits.length === 0) {
        return [];
      }

      return [
        {
          docKey,
          ...replayRankingEntry({
            allowedDocKeys: [docKey],
            config: resolvedConfig,
            docIdByKey,
            docKeyByDocId,
            expectedUnits: documentExpectedUnits,
            indexedChunks,
            k: resolvedConfig.topKPerDoc,
            question,
          }),
        },
      ];
    });

    return {
      retrievalMode: "per-document",
      k: resolvedConfig.topKPerDoc,
      candidateCount: perDocument.reduce(
        (sum, entry) => sum + entry.candidateCount,
        0
      ),
      expectedUnits,
      perDocument,
    };
  }

  return {
    retrievalMode: "global",
    ...replayRankingEntry({
      allowedDocKeys: docKeys,
      config: resolvedConfig,
      docIdByKey,
      docKeyByDocId,
      expectedUnits,
      indexedChunks,
      k: resolvedConfig.topK,
      question,
    }),
  };
};
