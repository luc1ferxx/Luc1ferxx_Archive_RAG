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
import { buildPublicFilePath } from "./document-utils.js";
import {
  addDocumentsToLocalIndex,
  clearLocalVectorIndex,
  removeDocumentsFromLocalIndex,
  resetLocalVectorStore,
  searchLocalDocuments,
} from "./vector-store-local.js";
import { embedTexts } from "./openai.js";
import { instrumentVectorStoreSearch, timeRetrievalRoute } from "./metrics-retrieval.js";
import { adaptQueryVectorForSearch, stampQueryAdapterProvenance } from "./query-adapter.js";
import {
  addDocumentsToPgvectorIndex,
  beginPgvectorIndexWrite,
  clearPgvectorIndex,
  embedDocumentsInSpace,
  ensurePgvectorSchema,
  fenceFailedWriteSpace,
  prepareDocumentsForPgvectorIndex,
  removeDocumentsFromPgvectorIndex,
  resetPgvectorVectorStore,
  searchPgvectorDocuments,
  searchPgvectorSparseDocuments,
  writeDocumentsToPgvectorIndex,
} from "./vector-store-pgvector.js";
import {
  getConfiguredEmbeddingSpace,
  getHintedWriteSpaces,
} from "./vector-store-pgvector-versions.js";
import { getPgvectorSparseBackend } from "./vector-store-pgvector-sparse.js";
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

// The local and Qdrant providers embed in the configured model only. Vectors a
// staged ingest computed earlier ride along in `prepared.vectors`; without them
// the provider embeds at write time, as it always did.
const prepareWithConfiguredVectors = async ({ documents, vectorsBySpace = null }) => {
  const vectors = vectorsBySpace?.[getConfiguredEmbeddingSpace().key];

  return Array.isArray(vectors) && vectors.length === documents.length
    ? { documents, vectors }
    : { documents };
};

// Embeds in the configured model without a width check: the local and Qdrant
// indexes take whatever width the model returns (Qdrant sizes its collection
// from the first vector), exactly as their write path does.
const embedInConfiguredModel = async (texts) => {
  const vectors = await embedTexts(texts);

  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(
      `Embedding provider returned ${Array.isArray(vectors) ? vectors.length : 0} vector(s) for ${texts.length} chunk(s).`
    );
  }

  return vectors;
};

const buildLocalImplementation = () => ({
  id: VECTOR_STORE_PROVIDERS.local,
  denseBackend: "local_json_cosine",
  sparseBackend: "local_json_bm25",
  embedInSpace: (texts) => embedInConfiguredModel(texts),
  getWriteSpaces: () => [getConfiguredEmbeddingSpace()],
  prepareDocuments: prepareWithConfiguredVectors,
  writeDocuments: async ({ prepared }) => {
    await Promise.all([
      addDocumentsToLocalIndex({ documents: prepared.documents, vectors: prepared.vectors ?? null }),
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
  // Dense search takes `scoreVector`: ranks by queryVector, reports the
  // cosine with scoreVector as vectorScore (rag/query-adapter.js).
  denseScoreVector: true,
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
  embedInSpace: (texts) => embedInConfiguredModel(texts),
  getWriteSpaces: () => [getConfiguredEmbeddingSpace()],
  prepareDocuments: prepareWithConfiguredVectors,
  writeDocuments: async ({ prepared }) => {
    await addDocumentsToQdrantIndex({ documents: prepared.documents, vectors: prepared.vectors ?? null });
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
  // postgres_fts_ts_rank_cd or postgres_bm25, as RAG_SPARSE_SCORING says.
  sparseBackend: getPgvectorSparseBackend(),
  transactional: true,
  // Index versions: the version tables a transaction writes are fixed by its
  // first statements (vector-store-pgvector-versions.js).
  beginWrite: async ({ client }) => beginPgvectorIndexWrite({ client }),
  // Every version a write will most likely reach (active first), each in its
  // own embedding space, width-checked.
  embedInSpace: (texts, space) => embedDocumentsInSpace(texts, space),
  // A write target no search reads is best effort (fenceFailedWriteSpace).
  fenceWriteSpace: fenceFailedWriteSpace,
  getWriteSpaces: () => getHintedWriteSpaces(),
  prepareDocuments: async ({ documents, vectorsBySpace = null }) => ({
    preparedDocuments: await prepareDocumentsForPgvectorIndex({ documents, vectorsBySpace }),
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
  denseScoreVector: true,
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
    return instrumentVectorStoreSearch(buildQdrantImplementation());
  }

  if (provider === VECTOR_STORE_PROVIDERS.pgvector) {
    return instrumentVectorStoreSearch(buildPgvectorImplementation());
  }

  if (provider === VECTOR_STORE_PROVIDERS.local) {
    return instrumentVectorStoreSearch(buildLocalImplementation());
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

// Whether the dense search can rank by one vector and report another's
// cosine as vectorScore, which the query adapter needs (rag/query-adapter.js).
export const supportsDenseScoreVector = () =>
  Boolean(getVectorStoreImplementation().denseScoreVector);

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

/**
 * The first call inside an ingest, delete or clear transaction on a
 * transactional provider. pgvector takes the index-version write lock and
 * decides which version tables the transaction writes; the returned client is
 * the one the rest of the transaction must use. Other providers hand the
 * client back unchanged.
 */
export const beginVectorIndexWrite = async ({ client }) => {
  const implementation = getVectorStoreImplementation();

  return implementation.beginWrite ? implementation.beginWrite({ client }) : client;
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

const toChunkDocumentVersion = (result) => {
  const version = Number(result?.document?.metadata?.documentVersion);

  // Chunks from before migration 018 carry no version: they are version 1.
  return Number.isInteger(version) && version > 0 ? version : 1;
};

/**
 * Per document, the results of the newest content version any route returned.
 * Chunk ids are `<docId>:<chunkIndex>` in every version, and the two routes
 * are separate statements: a replacement that commits between them can hand
 * fusion the old text from one route and the new from the other under one
 * key. Dropping the older version's results keeps one answer on one version.
 */
export const keepNewestDocumentVersion = (...routes) => {
  const newest = new Map();

  for (const results of routes) {
    for (const result of results) {
      const docId = result?.document?.metadata?.docId;

      newest.set(docId, Math.max(newest.get(docId) ?? 0, toChunkDocumentVersion(result)));
    }
  }

  return routes.map((results) =>
    results.filter(
      (result) => toChunkDocumentVersion(result) === newest.get(result?.document?.metadata?.docId)
    )
  );
};

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
  queryAdapterScope = null,
}) => {
  const sparseTopK = Math.max(topK, getSparseRetrievalTopK());
  const denseTopK = Math.max(topK, sparseTopK);
  const implementation = getVectorStoreImplementation();
  // The query adapter (rag/query-adapter.js) only reorders the dense route:
  // it ranks by W q while vectorScore stays the model vector's cosine, the
  // scale every admission floor was set on.
  const adaptation = adaptQueryVectorForSearch({
    docIds,
    fusion: getHybridFusionMethod(),
    hybrid: true,
    queryVector,
    scope: queryAdapterScope,
    supportsScoreVector: Boolean(implementation.denseScoreVector),
  });
  const [rawDenseResults, rawSparseResults] = await Promise.all([
    implementation.searchDenseDocuments({
      queryVector: adaptation?.rankVector ?? queryVector,
      ...(adaptation ? { scoreVector: queryVector } : {}),
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
  const [denseResults, sparseResults] = keepNewestDocumentVersion(rawDenseResults, rawSparseResults);
  const method = getHybridFusionMethod();
  const results =
    method === "rrf"
      ? fuseSearchResultsByRrf({ denseResults, sparseResults, topK })
      : fuseSearchResultsByWeightedScore({ denseResults, sparseResults, topK });
  // The store ranked by the adapted vector only when every dense result says
  // so; pgvector falls back to its own unadapted vector when the active
  // version moved to another space between the embedding and the search.
  const adapterFingerprint =
    adaptation && rawDenseResults.length > 0 && rawDenseResults.every((result) => Number.isFinite(result?.rankVectorScore))
      ? adaptation.fingerprint
      : null;

  return stampQueryAdapterProvenance({
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
  }, adapterFingerprint);
};

const searchDenseOnlyDocumentsWithRoutes = async (args) => {
  const implementation = getVectorStoreImplementation();

  // Never adapted: the dense-only route measured worse with the query
  // adapter. This only warns (once) when it is configured for this caller.
  adaptQueryVectorForSearch({
    docIds: args.docIds,
    hybrid: false,
    queryVector: args.queryVector,
    scope: args.queryAdapterScope ?? null,
    supportsScoreVector: Boolean(implementation.denseScoreVector),
  });
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

// `queryAdapterScope` (rag/query-adapter.js) is set by the single-document QA
// route only; the hybrid route then ranks its dense candidates with the query
// adapter when one is configured and applies, and stamps its fingerprint.
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
    return timeRetrievalRoute("hybrid", () => searchHybridDocumentsWithRoutes(args));
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

      if (routeSummary.queryAdapter) {
        merged[route].queryAdapter = routeSummary.queryAdapter;
      }
    }
  }

  return merged;
};

/**
 * Embeds (provider permitting) without touching storage. Split from the write
 * so the ingest path can compute embeddings before it opens a transaction.
 */
export const prepareDocumentsForIndex = async ({ documents, vectorsBySpace = null }) => {
  const implementation = getVectorStoreImplementation();

  return {
    provider: implementation.id,
    ...(await implementation.prepareDocuments({ documents, vectorsBySpace })),
  };
};

/**
 * The embedding spaces an ingest write will most likely need, the active one
 * first: for pgvector the active index version and every version that must
 * stay complete (a build, a rollback target), from the cached pointer; for the
 * other providers the configured model. Call ensureVectorStoreReady first so
 * the pointer has been read. A space the write's locked read adds later is
 * embedded inside the write, so this is a hint, never a correctness input.
 */
export const getIndexWriteEmbeddingSpaces = () => {
  const spaces = [];

  for (const space of getVectorStoreImplementation().getWriteSpaces()) {
    if (!spaces.some((candidate) => candidate.key === space.key)) {
      spaces.push(space);
    }
  }

  return spaces;
};

/**
 * Embeds document texts in one of those spaces the way the active provider's
 * write would (pgvector checks the space's width). The staged ingest's
 * embedding batcher (rag/ingest-embedding-batcher.js) sends its merged batches
 * through here, which reaches the model through rag/openai.js and therefore
 * through the model-call guard.
 */
export const embedDocumentTextsForIndex = (texts, space) =>
  getVectorStoreImplementation().embedInSpace(texts, space);

/**
 * The texts embedded in every space getIndexWriteEmbeddingSpaces names,
 * through `embedInSpace` (the staged ingest passes its batcher). A space other
 * than the active one that fails is dropped when the provider can fence the
 * versions in it (pgvector: fenceFailedWriteSpace), so a version nobody
 * searches never fails an upload; any other failure is thrown. Resolves to
 * { spaces, vectorsBySpace } for the spaces that were embedded.
 */
export const embedTextsForIndexWrite = async ({ texts, embedInSpace = embedDocumentTextsForIndex }) => {
  const implementation = getVectorStoreImplementation();
  const spaces = [];
  const vectorsBySpace = {};

  for (const [spaceIndex, space] of getIndexWriteEmbeddingSpaces().entries()) {
    try {
      const vectors = await embedInSpace(texts, space);

      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(
          `Embedding returned ${Array.isArray(vectors) ? vectors.length : 0} vector(s) for ${texts.length} chunk(s).`
        );
      }

      vectorsBySpace[space.key] = vectors;
      spaces.push(space);
    } catch (error) {
      // The first space is the active version's: its failure fails the write.
      if (
        spaceIndex === 0 ||
        typeof implementation.fenceWriteSpace !== "function" ||
        !(await implementation.fenceWriteSpace({ error, space }))
      ) {
        throw error;
      }
    }
  }

  if (spaces.length === 0) {
    throw new Error("No embedding space of the index could embed the document.");
  }

  return { spaces, vectorsBySpace };
};

/**
 * A chunk's metadata stamped with the content version it was cut from. From
 * version 2 on (a replaced document) the file link names that version too
 * (`documents/<id>/file?version=N`), so a citation of replaced content never
 * silently opens the newer PDF: GET /documents/:docId/file refuses a version
 * that is no longer the document's. Version 1 keeps the plain link.
 */
export const stampChunkDocumentVersion = (metadata = {}, documentVersion = 1) => {
  const version = Number(documentVersion);
  const stamped = { ...(metadata ?? {}), documentVersion };

  if (Number.isInteger(version) && version > 1 && stamped.docId) {
    stamped.publicFilePath = `${buildPublicFilePath(stamped.docId)}?version=${version}`;
  }

  return stamped;
};

/**
 * `prepared` with `documentVersion` (the document's content version) added to
 * every chunk's metadata, so the chunks of a replaced document say which
 * version they came from. The version is decided inside the write transaction.
 */
export const stampPreparedDocumentVersion = (prepared, documentVersion) => {
  const stamp = (document) => ({
    ...document,
    metadata: stampChunkDocumentVersion(document.metadata, documentVersion),
  });

  return {
    ...prepared,
    ...(Array.isArray(prepared?.preparedDocuments)
      ? { preparedDocuments: prepared.preparedDocuments.map(stamp) }
      : {}),
    ...(Array.isArray(prepared?.documents) ? { documents: prepared.documents.map(stamp) } : {}),
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
