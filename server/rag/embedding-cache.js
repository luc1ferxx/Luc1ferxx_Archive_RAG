import { embedQuery } from "./openai.js";
import {
  getQueryEmbeddingCacheMaxEntries,
  getQueryEmbeddingCacheTtlMs,
  isQueryEmbeddingCacheEnabled,
} from "./config.js";
import {
  getConfiguredEmbeddingSpace,
  isSameQuerySpace,
  peekServingQueryEmbeddingSpace,
  resolveServingQueryEmbeddingSpace,
} from "./vector-store-pgvector-versions.js";

// The per-process query embedding cache, keyed by embedding space and text.
//
// A query is embedded in the space the index serves: the configured model for
// the local and Qdrant providers and for a pgvector index whose active version
// lives in the configured space, and the active version's own model, task
// prefix and width when that version is pinned to another one
// (resolveServingQueryEmbeddingSpace). One embedding per query either way; the
// configured space is embedded only when something asks for it. Every returned
// vector is tagged with its space (getQueryVectorEmbeddingSpace), so the
// pgvector search uses it as is when it matches the version it searches, and
// embeds the text again only when the pointer moved in between.
//
// One LRU for every space, bounded by RAG_EMBEDDING_CACHE_MAX entries with a
// RAG_EMBEDDING_CACHE_TTL_MS lifetime; RAG_EMBEDDING_CACHE_ENABLED=false turns
// caching off (a query is then embedded once per call, still in one space).

let cache = new Map();
let inflightPromises = new Map();
// vector -> the space it was embedded in. Weak: a vector nobody holds is gone.
let vectorSpaces = new WeakMap();

const toEmbeddingSpaceRequest = (space) => ({
  dimensions: space.dimensions,
  documentPrefix: space.documentPrefix,
  identity: space.identity,
  model: space.model,
  queryPrefix: space.queryPrefix,
});

// The cache holds the model's own vectors only: the query adapter
// (rag/query-adapter.js) adapts a copy at the retrieval seam, so it is not
// part of the key.
const buildCacheKey = (space, query) =>
  [space.key, space.model, space.queryPrefix].join("\u0000") + `\n${query}`;

const evictExpired = (now) => {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      inflightPromises.delete(key);
    }
  }
};

const evictLru = () => {
  const maxEntries = getQueryEmbeddingCacheMaxEntries();
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    inflightPromises.delete(oldestKey);
  }
};

/** The space a vector from embedQueryCached was embedded in, or null for any other vector. */
export const getQueryVectorEmbeddingSpace = (vector) =>
  vector && typeof vector === "object" ? vectorSpaces.get(vector) ?? null : null;

// The configured space goes through the exact configured path (a stand-in
// provider gets one argument, the real client the configured prefix); another
// space names its model and prefixes.
const embedInSpace = async (query, space) => {
  const vector = isSameQuerySpace(space, getConfiguredEmbeddingSpace())
    ? await embedQuery(query)
    : await embedQuery(query, { embeddingSpace: toEmbeddingSpaceRequest(space) });

  if (vector && typeof vector === "object") {
    vectorSpaces.set(vector, space);
  }

  return vector;
};

/**
 * The query's vector in `space`, or in the space the index serves when no
 * space is given. Concurrent callers of one key share one request.
 */
export const embedQueryCached = async (query, { space = null } = {}) => {
  // Known without I/O almost always (the pointer snapshot inside its TTL);
  // otherwise the pointer read the search would make next anyway.
  const target = space ?? peekServingQueryEmbeddingSpace() ?? (await resolveServingQueryEmbeddingSpace());

  if (!isQueryEmbeddingCacheEnabled()) {
    return embedInSpace(query, target);
  }

  const key = buildCacheKey(target, query);
  const now = Date.now();

  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    cache.delete(key);
    cache.set(key, existing);
    return existing.vector;
  }

  const inflight = inflightPromises.get(key);
  if (inflight) {
    return inflight;
  }

  const promise = embedInSpace(query, target).then(
    (vector) => {
      inflightPromises.delete(key);
      cache.delete(key);
      cache.set(key, { vector, expiresAt: Date.now() + getQueryEmbeddingCacheTtlMs() });
      evictExpired(Date.now());
      evictLru();
      return vector;
    },
    (error) => {
      inflightPromises.delete(key);
      cache.delete(key);
      throw error;
    }
  );

  inflightPromises.set(key, promise);
  return promise;
};

/** Entries currently cached, per space key (tests and diagnostics). */
export const describeEmbeddingCache = () => {
  const bySpace = {};

  for (const key of cache.keys()) {
    const spaceKey = key.slice(0, key.indexOf("\u0000"));

    bySpace[spaceKey] = (bySpace[spaceKey] ?? 0) + 1;
  }

  return { bySpace, entries: cache.size, maxEntries: getQueryEmbeddingCacheMaxEntries() };
};

export const resetEmbeddingCache = () => {
  cache = new Map();
  inflightPromises = new Map();
  vectorSpaces = new WeakMap();
};
