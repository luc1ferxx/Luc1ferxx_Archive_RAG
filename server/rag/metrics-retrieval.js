import { isRerankEnabled, isSemanticCacheEnabled } from "./config.js";
import { getMetricsRegistry, isMetricsEnabled, secondsSince } from "./metrics.js";

// Retrieval, wherever it runs (the monolith, or the retrieval tier of a split
// deployment):
//   - per route: `dense` and `sparse` are the vector store's two searches
//     (vector-store.js wraps its implementation with instrumentVectorStoreSearch),
//     `hybrid` is both plus fusion, `rerank` the reordering after it (only
//     while reranking is on). Each records its latency and how many
//     candidates it returned.
//   - rerank degradations: a reranker that failed, so the query kept the fused
//     order (rerankResultsOrKeepOrder).
//   - the semantic answer cache's hits, misses and bypasses, read on scrape
//     from its own running counters while RAG_SEMANTIC_CACHE is on.

export const RETRIEVAL_ROUTES = Object.freeze(["dense", "hybrid", "rerank", "sparse"]);

export const RETRIEVAL_DURATION_BUCKETS = Object.freeze([
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);
export const RETRIEVAL_CANDIDATE_BUCKETS = Object.freeze([0, 1, 2, 5, 10, 20, 50, 100, 200, 500]);

const ROUTE_SET = new Set(RETRIEVAL_ROUTES);

const registry = getMetricsRegistry();

const routeDuration = registry.histogram({
  buckets: RETRIEVAL_DURATION_BUCKETS,
  help: "Latency of one retrieval route call (dense, sparse, hybrid = both plus fusion, rerank), in seconds.",
  labelNames: ["outcome", "route"],
  name: "archive_rag_retrieval_route_duration_seconds",
});
const routeCandidates = registry.histogram({
  buckets: RETRIEVAL_CANDIDATE_BUCKETS,
  help: "Candidates one successful retrieval route call returned.",
  labelNames: ["route"],
  name: "archive_rag_retrieval_route_candidates",
});
const rerankDegradations = registry.counter({
  help: "Queries whose reranker failed, so they kept the fused retrieval order.",
  name: "archive_rag_retrieval_rerank_degradations_total",
});
const cacheLookups = registry.counter({
  help: "Semantic answer cache lookups by result (hit, miss, bypass); no series while RAG_SEMANTIC_CACHE is off.",
  labelNames: ["result"],
  name: "archive_rag_semantic_cache_lookups_total",
});
const cacheEntries = registry.gauge({
  help: "Entries held by this process's semantic answer cache.",
  name: "archive_rag_semantic_cache_entries",
});

const countResults = (value) => {
  if (Array.isArray(value)) {
    return value.length;
  }

  return Array.isArray(value?.results) ? value.results.length : null;
};

const timeRoute = async (route, run) => {
  const label = ROUTE_SET.has(route) ? route : "other";
  const startedAt = performance.now();
  let result;

  try {
    result = await run();
  } catch (error) {
    routeDuration.observe({ outcome: "error", route: label }, secondsSince(startedAt));
    throw error;
  }

  routeDuration.observe({ outcome: "ok", route: label }, secondsSince(startedAt));

  const candidates = countResults(result);

  if (candidates !== null) {
    routeCandidates.observe({ route: label }, candidates);
  }

  return result;
};

/**
 * Runs `run` as one call of retrieval `route` and records its latency and
 * candidate count. The result and any error pass through unchanged; while
 * metrics are off this is `run()` itself.
 */
export const timeRetrievalRoute = (route, run) => (isMetricsEnabled() ? timeRoute(route, run) : run());

/**
 * The vector store implementation with its dense and sparse searches timed.
 * Returns `implementation` itself while metrics are off.
 */
export const instrumentVectorStoreSearch = (implementation) => {
  if (!isMetricsEnabled() || !implementation) {
    return implementation;
  }

  const { searchDenseDocuments, searchSparseDocuments } = implementation;

  return {
    ...implementation,
    ...(typeof searchDenseDocuments === "function"
      ? { searchDenseDocuments: (args) => timeRetrievalRoute("dense", () => searchDenseDocuments(args)) }
      : {}),
    ...(typeof searchSparseDocuments === "function"
      ? { searchSparseDocuments: (args) => timeRetrievalRoute("sparse", () => searchSparseDocuments(args)) }
      : {}),
  };
};

/** The rerank step, timed only while reranking is on (otherwise it only slices). */
export const observeRerank = (run) =>
  isMetricsEnabled() && isRerankEnabled() ? timeRetrievalRoute("rerank", run) : run();

export const recordRerankDegradation = () => {
  if (isMetricsEnabled()) {
    rerankDegradations.inc();
  }
};

// Read only while the cache is on (its counters stay 0 otherwise), and
// imported on scrape, so a tier that never answers questions never loads it.
export const collectSemanticCache = async () => {
  if (!isSemanticCacheEnabled()) {
    return;
  }

  const { getSemanticCacheStats } = await import("./semantic-cache.js");
  const stats = getSemanticCacheStats();

  cacheLookups.setTotal({ result: "hit" }, Number(stats.hits) || 0);
  cacheLookups.setTotal({ result: "miss" }, Number(stats.misses) || 0);
  cacheLookups.setTotal({ result: "bypass" }, Number(stats.bypasses) || 0);
  cacheEntries.set(Number(stats.entries) || 0);
};

registry.addCollector("semantic_cache", collectSemanticCache);
