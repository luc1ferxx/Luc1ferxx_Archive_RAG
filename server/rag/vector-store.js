import {
  VECTOR_STORE_PROVIDERS,
  getHybridFusionMethod,
  getHybridDenseWeight,
  getHybridSparseWeight,
  getRetrievalRoute,
  getRetrievalScoringMode,
  getRrfK,
  getSparseRetrievalTopK,
  getVectorStoreProvider,
  isHybridRetrievalEnabled,
} from "./config.js";
import { computeAdmissionScore, getResultKey } from "./citations.js";
import {
  addDocumentsToLocalIndex,
  clearLocalVectorIndex,
  removeDocumentsFromLocalIndex,
  resetLocalVectorStore,
  searchLocalDocuments,
} from "./vector-store-local.js";
import {
  addDocumentsToPgvectorIndex,
  clearPgvectorIndex,
  ensurePgvectorSchema,
  prepareDocumentsForPgvectorIndex,
  removeDocumentsFromPgvectorIndex,
  resetPgvectorVectorStore,
  searchPgvectorDocuments,
  searchPgvectorSparseDocuments,
  writeDocumentsToPgvectorIndex,
} from "./vector-store-pgvector.js";
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

// The retrieval seam. Everything above this file asks for "the index"; this
// file decides which provider that is (strict allowlist, no fallback), runs the
// dense and sparse routes, fuses them, and stamps every result with where it
// came from: which route, at what rank, with what raw score, and what the
// fusion made of it. That provenance is what lets a report prove both routes
// really produced candidates instead of trusting a config flag.

export const RETRIEVAL_ROUTES = Object.freeze({
  dense: "dense",
  sparse: "sparse",
});

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

const buildLocalImplementation = () => ({
  id: VECTOR_STORE_PROVIDERS.local,
  denseBackend: "local_json_cosine",
  sparseBackend: "local_json_bm25",
  prepareDocuments: async ({ documents }) => ({ documents }),
  writeDocuments: async ({ prepared }) => {
    await Promise.all([
      addDocumentsToLocalIndex({ documents: prepared.documents }),
      addDocumentsToSparseIndex({ documents: prepared.documents }),
    ]);
  },
  removeDocuments: async ({ docIds }) => {
    await Promise.all([
      removeDocumentsFromLocalIndex({ docIds }),
      removeDocumentsFromSparseIndex({ docIds }),
    ]);
  },
  clear: async () => {
    await Promise.all([clearLocalVectorIndex(), clearSparseIndex()]);
  },
  searchDenseDocuments: searchLocalDocuments,
  searchSparseDocuments,
  reset: () => {
    resetLocalVectorStore();
    resetSparseStore();
  },
});

const buildQdrantImplementation = () => ({
  id: VECTOR_STORE_PROVIDERS.qdrant,
  denseBackend: "qdrant_dense",
  sparseBackend: "qdrant_sparse_bm25",
  prepareDocuments: async ({ documents }) => ({ documents }),
  writeDocuments: async ({ prepared }) => {
    await addDocumentsToQdrantIndex({ documents: prepared.documents });
  },
  removeDocuments: async ({ docIds }) => {
    await removeDocumentsFromQdrantIndex({ docIds });
  },
  clear: async () => {
    await clearQdrantVectorIndex();
  },
  searchDenseDocuments: searchQdrantDocuments,
  searchSparseDocuments: searchQdrantSparseDocuments,
  reset: resetQdrantVectorStore,
});

const buildPgvectorImplementation = () => ({
  id: VECTOR_STORE_PROVIDERS.pgvector,
  denseBackend: "pgvector_cosine",
  sparseBackend: "postgres_fts_ts_rank_cd",
  transactional: true,
  prepareDocuments: async ({ documents }) => ({
    preparedDocuments: await prepareDocumentsForPgvectorIndex({ documents }),
  }),
  writeDocuments: async ({ prepared, accessScope, client }) => {
    await writeDocumentsToPgvectorIndex({
      accessScope,
      client,
      preparedDocuments: prepared.preparedDocuments,
    });
  },
  removeDocuments: async ({ docIds, client }) => {
    await removeDocumentsFromPgvectorIndex({ client, docIds });
  },
  clear: async ({ client } = {}) => {
    await clearPgvectorIndex({ client });
  },
  searchDenseDocuments: searchPgvectorDocuments,
  searchSparseDocuments: searchPgvectorSparseDocuments,
  reset: resetPgvectorVectorStore,
});

/**
 * Resolves the provider from the strict allowlist. getVectorStoreProvider()
 * throws on an unknown value, so a typo can never land on the local index.
 */
const getVectorStoreImplementation = () => {
  const provider = getVectorStoreProvider();

  if (provider === VECTOR_STORE_PROVIDERS.qdrant) {
    return buildQdrantImplementation();
  }

  if (provider === VECTOR_STORE_PROVIDERS.pgvector) {
    return buildPgvectorImplementation();
  }

  if (provider === VECTOR_STORE_PROVIDERS.local) {
    return buildLocalImplementation();
  }

  throw new Error(`Unsupported vector store provider: ${provider}`);
};

export const describeVectorStoreRuntime = () => {
  const implementation = getVectorStoreImplementation();
  const hybridEnabled = isHybridRetrievalEnabled();

  return {
    denseBackend: implementation.denseBackend,
    hybridEnabled,
    hybridFusion: hybridEnabled ? getHybridFusionMethod() : null,
    sparseBackend: hybridEnabled ? implementation.sparseBackend : null,
    transactional: Boolean(implementation.transactional),
    vectorStoreProvider: implementation.id,
  };
};

export const isVectorStoreTransactional = () =>
  Boolean(getVectorStoreImplementation().transactional);

/**
 * Verifies the active provider can accept writes before any work is done on
 * its behalf. For pgvector that is the schema check (database reachable,
 * extension installed, column width and embedding model consistent); it runs
 * before embeddings are computed so a misconfigured database costs nothing.
 * The other providers have no preconditions.
 */
export const ensureVectorStoreReady = async () => {
  const implementation = getVectorStoreImplementation();

  if (implementation.id === VECTOR_STORE_PROVIDERS.pgvector) {
    await ensurePgvectorSchema();
  }

  return implementation.id;
};

const withDenseProvenance = (results) =>
  results.map((result, index) => ({
    ...result,
    // Dense-only route: the raw dense similarity is the admission signal. Some
    // scoring modes expose it as vectorScore, others only as score, so fall back
    // the same way the route provenance below does.
    admissionScore: Math.max(
      Number(result.vectorScore ?? result.score) || 0,
      Number(result.keywordScore) || 0
    ),
    provenance: {
      fusion: null,
      routes: [
        {
          rank: index + 1,
          route: RETRIEVAL_ROUTES.dense,
          score: result.vectorScore ?? result.score ?? 0,
        },
      ],
    },
  }));

// Sparse-only route provenance (measurement arm). Admission is computed from the
// bounded vector/keyword components only -- computeAdmissionScore never reads
// sparseScore -- so switching the dense route off cannot let an unbounded sparse
// rank (BM25 on the local/qdrant backends, ts_rank_cd on pgvector) clear the
// evidence gate. The unbounded sparse rank is kept as route provenance, not as a
// confidence.
const withSparseProvenance = (results) =>
  results.map((result, index) => ({
    ...result,
    admissionScore: computeAdmissionScore(result),
    provenance: {
      fusion: null,
      routes: [
        {
          rank: index + 1,
          route: RETRIEVAL_ROUTES.sparse,
          score: result.sparseScore ?? result.score ?? 0,
        },
      ],
    },
  }));

const buildFusedProvenance = ({ entry, method }) => ({
  fusion: {
    method,
    score: entry.score,
  },
  routes: [
    ...(entry.denseRank
      ? [{ rank: entry.denseRank, route: RETRIEVAL_ROUTES.dense, score: entry.vectorScore }]
      : []),
    ...(entry.sparseRank
      ? [{ rank: entry.sparseRank, route: RETRIEVAL_ROUTES.sparse, score: entry.sparseScore }]
      : []),
  ],
});

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

  denseResults.forEach((denseResult, index) => {
    fusedResultsByKey.set(getResultKey(denseResult), {
      document: denseResult.document,
      denseScore: denseResult.vectorScore ?? 0,
      denseRank: index + 1,
      sparseScore: 0,
      sparseRank: null,
      keywordScore: denseResult.keywordScore ?? null,
    });
  });

  sparseResults.forEach((sparseResult, index) => {
    const resultKey = getResultKey(sparseResult);
    const existing = fusedResultsByKey.get(resultKey);

    fusedResultsByKey.set(resultKey, {
      document: existing?.document ?? sparseResult.document,
      denseScore: existing?.denseScore ?? 0,
      denseRank: existing?.denseRank ?? null,
      sparseScore: sparseResult.sparseScore ?? 0,
      sparseRank: index + 1,
      keywordScore:
        existing?.keywordScore ?? sparseResult.keywordScore ?? null,
    });
  });

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
      const entry = {
        document: result.document,
        score: fusedScore,
        vectorScore: result.denseScore,
        sparseScore: result.sparseScore,
        keywordScore: result.keywordScore,
        denseRank: result.denseRank,
        sparseRank: result.sparseRank,
      };

      return {
        ...entry,
        admissionScore: computeAdmissionScore(entry),
        provenance: buildFusedProvenance({ entry, method: "weighted" }),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.sparseScore - left.sparseScore ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0) ||
        getResultKey(left).localeCompare(getResultKey(right))
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

  // A raw RRF sum tops out at 1/(k+1) (rank 1 on every route), which at the
  // default k=60 is ~0.016. Scaling by (k+1) maps the sum into [0, 1] so the
  // fused `score` is a readable ranking figure -- a chunk ranked first on both
  // routes scores 1.0, first on one route scores that route's weight -- and so
  // rerank can blend it with a comparable rerank score. This scaled `score` is a
  // fusion RANK, not a confidence: evidence admission is gated on admissionScore
  // (raw dense/keyword signal), never on this value. The raw sum is kept as
  // rrfScore for provenance.
  const rrfScale = getRrfK() + 1;

  return [...fusedResultsByKey.values()]
    .map((result) => {
      const entry = {
        document: result.document,
        score: result.rrfScore * rrfScale,
        rrfScore: result.rrfScore,
        vectorScore: result.denseScore,
        sparseScore: result.sparseScore,
        keywordScore: result.keywordScore,
        denseRank: Number.isFinite(result.denseRank) ? result.denseRank : null,
        sparseRank: Number.isFinite(result.sparseRank) ? result.sparseRank : null,
      };

      return {
        ...entry,
        admissionScore: computeAdmissionScore(entry),
        provenance: buildFusedProvenance({ entry, method: "rrf" }),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.sparseRank ?? Number.POSITIVE_INFINITY) -
          (right.sparseRank ?? Number.POSITIVE_INFINITY) ||
        (left.denseRank ?? Number.POSITIVE_INFINITY) -
          (right.denseRank ?? Number.POSITIVE_INFINITY) ||
        right.sparseScore - left.sparseScore ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0) ||
        getResultKey(left).localeCompare(getResultKey(right))
    )
    .slice(0, topK);
};

const buildRouteSummary = ({ candidateCount, executed, topK }) => ({
  candidateCount,
  executed,
  topK,
});

/**
 * Runs both routes independently and fuses them. Each route is a separate
 * query against the provider -- a dense cosine search and a lexical search --
 * so the summary this returns can state how many candidates each route
 * actually produced, which is what the quality gate checks.
 */
const searchHybridDocumentsWithRoutes = async ({
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
  const method = getHybridFusionMethod();
  const results =
    method === "rrf"
      ? fuseSearchResultsByRrf({ denseResults, sparseResults, topK })
      : fuseSearchResultsByWeightedScore({ denseResults, sparseResults, topK });

  return {
    results,
    fusion: { enabled: true, method },
    routes: {
      dense: buildRouteSummary({
        candidateCount: denseResults.length,
        executed: true,
        topK: denseTopK,
      }),
      sparse: buildRouteSummary({
        candidateCount: sparseResults.length,
        executed: true,
        topK: sparseTopK,
      }),
    },
  };
};

const searchDenseOnlyDocumentsWithRoutes = async (args) => {
  const implementation = getVectorStoreImplementation();
  const results = withDenseProvenance(
    await implementation.searchDenseDocuments({
      ...args,
      scoringMode: getRetrievalScoringMode(),
    })
  );

  return {
    results,
    fusion: { enabled: false, method: null },
    routes: {
      dense: buildRouteSummary({
        candidateCount: results.length,
        executed: true,
        topK: args.topK,
      }),
      sparse: buildRouteSummary({
        candidateCount: 0,
        executed: false,
        topK: null,
      }),
    },
  };
};

// Sparse-only route: run the lexical route alone and normalise its results the
// same way the dense-only path does, so downstream admission/citation code sees a
// consistent shape. Used by the evaluation harness to measure the sparse arm; the
// default route never reaches here.
const searchSparseOnlyDocumentsWithRoutes = async ({
  queryText = "",
  docIds,
  topK,
}) => {
  const implementation = getVectorStoreImplementation();
  const sparseTopK = Math.max(topK, getSparseRetrievalTopK());
  const sparseResults = await implementation.searchSparseDocuments({
    queryText,
    docIds,
    topK: sparseTopK,
  });
  const results = withSparseProvenance(sparseResults).slice(0, topK);

  return {
    results,
    fusion: { enabled: false, method: null },
    routes: {
      dense: buildRouteSummary({
        candidateCount: 0,
        executed: false,
        topK: null,
      }),
      sparse: buildRouteSummary({
        candidateCount: sparseResults.length,
        executed: true,
        topK: sparseTopK,
      }),
    },
  };
};

export const searchDocumentsWithRoutes = async (args) => {
  const route = getRetrievalRoute();

  if (route === "sparse") {
    return searchSparseOnlyDocumentsWithRoutes(args);
  }

  if (route === "dense") {
    return searchDenseOnlyDocumentsWithRoutes(args);
  }

  // route === "hybrid": the documented default. Hybrid on fuses both routes;
  // hybrid off is the dense-only opt-out, exactly as before this selector existed.
  if (isHybridRetrievalEnabled()) {
    return searchHybridDocumentsWithRoutes(args);
  }

  return searchDenseOnlyDocumentsWithRoutes(args);
};

export const mergeRouteSummaries = (...summaries) => {
  const merged = {
    dense: { candidateCount: 0, executed: false, queryCount: 0 },
    sparse: { candidateCount: 0, executed: false, queryCount: 0 },
  };

  for (const summary of summaries) {
    for (const route of Object.keys(merged)) {
      const routeSummary = summary?.[route];

      if (!routeSummary) {
        continue;
      }

      merged[route].queryCount += 1;
      merged[route].executed = merged[route].executed || Boolean(routeSummary.executed);
      merged[route].candidateCount += Number(routeSummary.candidateCount) || 0;
    }
  }

  return merged;
};

/**
 * Embeds (provider permitting) without touching storage. Split from the write
 * so the ingest path can compute embeddings before it opens a transaction.
 */
export const prepareDocumentsForIndex = async ({ documents }) => {
  const implementation = getVectorStoreImplementation();

  return {
    provider: implementation.id,
    ...(await implementation.prepareDocuments({ documents })),
  };
};

export const writeDocumentsToIndex = async ({
  accessScope = {},
  client = null,
  prepared,
}) => {
  const implementation = getVectorStoreImplementation();

  if (prepared?.provider && prepared.provider !== implementation.id) {
    throw new Error(
      `Documents were prepared for the ${prepared.provider} provider but ${implementation.id} is active.`
    );
  }

  await implementation.writeDocuments({ accessScope, client, prepared });
};

export const addDocumentsToIndex = async ({
  accessScope = {},
  client = null,
  documents,
}) => {
  const prepared = await prepareDocumentsForIndex({ documents });

  await writeDocumentsToIndex({ accessScope, client, prepared });
};

export const removeDocumentsFromIndex = async ({ client = null, docIds }) => {
  const implementation = getVectorStoreImplementation();

  await implementation.removeDocuments({ client, docIds });
};

export const clearVectorIndex = async ({ client = null } = {}) => {
  const implementation = getVectorStoreImplementation();

  await implementation.clear({ client });
};

export const searchDocuments = async (args) =>
  (await searchDocumentsWithRoutes(args)).results;

export const searchDocumentsPerDocumentWithRoutes = async ({
  queryVector,
  queryText = "",
  docIds,
  topKPerDoc,
}) => {
  const resultsByDocument = await Promise.all(
    docIds.map(async (docId) => [
      docId,
      await searchDocumentsWithRoutes({
        queryVector,
        queryText,
        docIds: [docId],
        topK: topKPerDoc,
      }),
    ])
  );

  return {
    resultsByDocument: new Map(
      resultsByDocument.map(([docId, search]) => [docId, search.results])
    ),
    routes: mergeRouteSummaries(
      ...resultsByDocument.map(([, search]) => search.routes)
    ),
  };
};

export const searchDocumentsPerDocument = async (args) =>
  (await searchDocumentsPerDocumentWithRoutes(args)).resultsByDocument;

export const resetVectorStore = () => {
  // Reset every backend's in-process state, not only the active one: tests and
  // the archive MCP bridge switch providers at runtime and expect a cold start.
  resetLocalVectorStore();
  resetSparseStore();
  resetQdrantVectorStore();
  resetPgvectorVectorStore();
};
