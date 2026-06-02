import {
  getHybridFusionMethod,
  getHybridDenseWeight,
  getHybridSparseWeight,
  getRetrievalScoringMode,
  getRrfK,
  getSparseRetrievalTopK,
  getVectorStoreProvider,
  isHybridRetrievalEnabled,
} from "./config.js";
import { getResultKey } from "./citations.js";
import {
  addDocumentsToLocalIndex,
  clearLocalVectorIndex,
  removeDocumentsFromLocalIndex,
  resetLocalVectorStore,
  searchLocalDocuments,
} from "./vector-store-local.js";
import {
  addDocumentsToQdrantIndex,
  clearQdrantVectorIndex,
  removeDocumentsFromQdrantIndex,
  resetQdrantVectorStore,
  searchQdrantDocuments,
  searchQdrantSparseDocuments,
} from "./vector-store-qdrant.js";
import {
  addDocumentsToSparseIndex,
  clearSparseIndex,
  removeDocumentsFromSparseIndex,
  resetSparseStore,
  searchSparseDocuments,
} from "./sparse-store.js";

const normalizeWeights = () => {
  const denseWeight = getHybridDenseWeight();
  const sparseWeight = getHybridSparseWeight();
  const weightSum = denseWeight + sparseWeight;

  if (weightSum <= 0) {
    return {
      denseWeight: 0.5,
      sparseWeight: 0.5,
    };
  }

  return {
    denseWeight: denseWeight / weightSum,
    sparseWeight: sparseWeight / weightSum,
  };
};

const normalizeByMaximum = (value, maximum) =>
  maximum > 0 ? value / maximum : 0;

const noop = () => {};
const asyncNoop = async () => {};

const getVectorStoreImplementation = () => {
  const provider = getVectorStoreProvider();

  if (provider === "qdrant") {
    return {
      addDocumentsToDenseIndex: addDocumentsToQdrantIndex,
      removeDocumentsFromDenseIndex: removeDocumentsFromQdrantIndex,
      clearDenseIndex: clearQdrantVectorIndex,
      searchDenseDocuments: searchQdrantDocuments,
      resetDenseVectorStore: resetQdrantVectorStore,
      addDocumentsToSparseIndex: asyncNoop,
      removeDocumentsFromSparseIndex: asyncNoop,
      clearSparseIndex: asyncNoop,
      searchSparseDocuments: searchQdrantSparseDocuments,
      resetSparseStore: noop,
    };
  }

  return {
    addDocumentsToDenseIndex: addDocumentsToLocalIndex,
    removeDocumentsFromDenseIndex: removeDocumentsFromLocalIndex,
    clearDenseIndex: clearLocalVectorIndex,
    searchDenseDocuments: searchLocalDocuments,
    resetDenseVectorStore: resetLocalVectorStore,
    addDocumentsToSparseIndex,
    removeDocumentsFromSparseIndex,
    clearSparseIndex,
    searchSparseDocuments,
    resetSparseStore,
  };
};

const fuseSearchResultsByWeightedScore = ({ denseResults, sparseResults, topK }) => {
  const { denseWeight, sparseWeight } = normalizeWeights();
  const denseMaximumScore = Math.max(
    0,
    ...denseResults.map((result) => result.vectorScore ?? 0)
  );
  const sparseMaximumScore = Math.max(
    0,
    ...sparseResults.map((result) => result.sparseScore ?? 0)
  );
  const fusedResultsByKey = new Map();

  for (const denseResult of denseResults) {
    fusedResultsByKey.set(getResultKey(denseResult), {
      document: denseResult.document,
      denseScore: denseResult.vectorScore ?? 0,
      sparseScore: 0,
      keywordScore: denseResult.keywordScore ?? null,
    });
  }

  for (const sparseResult of sparseResults) {
    const resultKey = getResultKey(sparseResult);
    const existing = fusedResultsByKey.get(resultKey);

    fusedResultsByKey.set(resultKey, {
      document: existing?.document ?? sparseResult.document,
      denseScore: existing?.denseScore ?? 0,
      sparseScore: sparseResult.sparseScore ?? 0,
      keywordScore:
        existing?.keywordScore ?? sparseResult.keywordScore ?? null,
    });
  }

  return [...fusedResultsByKey.values()]
    .map((result) => {
      const normalizedDenseScore = normalizeByMaximum(
        result.denseScore,
        denseMaximumScore
      );
      const normalizedSparseScore = normalizeByMaximum(
        result.sparseScore,
        sparseMaximumScore
      );
      const fusedScore =
        normalizedDenseScore * denseWeight +
        normalizedSparseScore * sparseWeight;

      return {
        document: result.document,
        score: fusedScore,
        vectorScore: result.denseScore,
        sparseScore: result.sparseScore,
        keywordScore: result.keywordScore,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.sparseScore - left.sparseScore ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    )
    .slice(0, topK);
};

const getRrfContribution = ({ rankIndex, weight }) =>
  weight / (getRrfK() + rankIndex + 1);

const fuseSearchResultsByRrf = ({ denseResults, sparseResults, topK }) => {
  const { denseWeight, sparseWeight } = normalizeWeights();
  const fusedResultsByKey = new Map();

  const ensureEntry = (result) => {
    const resultKey = getResultKey(result);
    const existing = fusedResultsByKey.get(resultKey);

    if (existing) {
      return existing;
    }

    const entry = {
      document: result.document,
      denseScore: 0,
      sparseScore: 0,
      keywordScore: null,
      rrfScore: 0,
      denseRank: Number.POSITIVE_INFINITY,
      sparseRank: Number.POSITIVE_INFINITY,
    };

    fusedResultsByKey.set(resultKey, entry);
    return entry;
  };

  denseResults.forEach((denseResult, index) => {
    const entry = ensureEntry(denseResult);

    entry.denseScore = denseResult.vectorScore ?? 0;
    entry.keywordScore = denseResult.keywordScore ?? entry.keywordScore;
    entry.denseRank = Math.min(entry.denseRank, index + 1);
    entry.rrfScore += getRrfContribution({
      rankIndex: index,
      weight: denseWeight,
    });
  });

  sparseResults.forEach((sparseResult, index) => {
    const entry = ensureEntry(sparseResult);

    entry.sparseScore = sparseResult.sparseScore ?? 0;
    entry.keywordScore = Math.max(
      entry.keywordScore ?? 0,
      sparseResult.keywordScore ?? 0
    );
    entry.sparseRank = Math.min(entry.sparseRank, index + 1);
    entry.rrfScore += getRrfContribution({
      rankIndex: index,
      weight: sparseWeight,
    });
  });

  return [...fusedResultsByKey.values()]
    .map((result) => ({
      document: result.document,
      score: result.rrfScore,
      rrfScore: result.rrfScore,
      vectorScore: result.denseScore,
      sparseScore: result.sparseScore,
      keywordScore: result.keywordScore,
      denseRank: Number.isFinite(result.denseRank) ? result.denseRank : null,
      sparseRank: Number.isFinite(result.sparseRank) ? result.sparseRank : null,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.sparseRank ?? Number.POSITIVE_INFINITY) -
          (right.sparseRank ?? Number.POSITIVE_INFINITY) ||
        (left.denseRank ?? Number.POSITIVE_INFINITY) -
          (right.denseRank ?? Number.POSITIVE_INFINITY) ||
        right.sparseScore - left.sparseScore ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    )
    .slice(0, topK);
};

const searchHybridDocuments = async ({
  queryVector,
  queryText = "",
  docIds,
  topK,
}) => {
  const sparseTopK = Math.max(topK, getSparseRetrievalTopK());
  const denseTopK = Math.max(topK, sparseTopK);
  const implementation = getVectorStoreImplementation();
  const [denseResults, sparseResults] = await Promise.all([
    implementation.searchDenseDocuments({
      queryVector,
      queryText,
      docIds,
      topK: denseTopK,
      scoringMode: "dense",
    }),
    implementation.searchSparseDocuments({
      queryText,
      docIds,
      topK: sparseTopK,
    }),
  ]);

  if (getHybridFusionMethod() === "rrf") {
    return fuseSearchResultsByRrf({
      denseResults,
      sparseResults,
      topK,
    });
  }

  return fuseSearchResultsByWeightedScore({
    denseResults,
    sparseResults,
    topK,
  });
};

export const addDocumentsToIndex = async ({ documents }) => {
  const implementation = getVectorStoreImplementation();

  await Promise.all([
    implementation.addDocumentsToDenseIndex({
      documents,
    }),
    implementation.addDocumentsToSparseIndex({
      documents,
    }),
  ]);
};

export const removeDocumentsFromIndex = async ({ docIds }) => {
  const implementation = getVectorStoreImplementation();

  await Promise.all([
    implementation.removeDocumentsFromDenseIndex({
      docIds,
    }),
    implementation.removeDocumentsFromSparseIndex({
      docIds,
    }),
  ]);
};

export const clearVectorIndex = async () => {
  const implementation = getVectorStoreImplementation();

  await Promise.all([
    implementation.clearDenseIndex(),
    implementation.clearSparseIndex(),
  ]);
};

export const searchDocuments = async (args) => {
  const implementation = getVectorStoreImplementation();

  if (isHybridRetrievalEnabled()) {
    return searchHybridDocuments(args);
  }

  return implementation.searchDenseDocuments({
    ...args,
    scoringMode: getRetrievalScoringMode(),
  });
};

export const searchDocumentsPerDocument = async ({
  queryVector,
  queryText = "",
  docIds,
  topKPerDoc,
}) => {
  const resultsByDocument = await Promise.all(
    docIds.map(async (docId) => [
      docId,
      await searchDocuments({
        queryVector,
        queryText,
        docIds: [docId],
        topK: topKPerDoc,
      }),
    ])
  );

  return new Map(resultsByDocument);
};

export const resetVectorStore = () => {
  const implementation = getVectorStoreImplementation();

  implementation.resetDenseVectorStore();
  implementation.resetSparseStore();
};
