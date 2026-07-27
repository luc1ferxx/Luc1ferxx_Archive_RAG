import { embedQuery } from "./openai.js";
import { getEmbeddingModel } from "./config.js";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

let cache = new Map();
let inflightPromises = new Map();

const isEnabled = () => {
  const raw = process.env.RAG_EMBEDDING_CACHE_ENABLED;
  if (typeof raw !== "string" || raw.trim() === "") {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return true;
};

const getMaxEntries = () => {
  const raw = process.env.RAG_EMBEDDING_CACHE_MAX;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MAX_ENTRIES;
};

const getTtlMs = () => {
  const raw = process.env.RAG_EMBEDDING_CACHE_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TTL_MS;
};

const buildCacheKey = (query) => `${getEmbeddingModel()}\n${query}`;

const evictExpired = (now) => {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      inflightPromises.delete(key);
    }
  }
};

const evictLru = () => {
  const maxEntries = getMaxEntries();
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    inflightPromises.delete(oldestKey);
  }
};

export const embedQueryCached = async (query) => {
  if (!isEnabled()) {
    return embedQuery(query);
  }

  const key = buildCacheKey(query);
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

  const promise = embedQuery(query).then(
    (vector) => {
      inflightPromises.delete(key);
      cache.delete(key);
      cache.set(key, { vector, expiresAt: Date.now() + getTtlMs() });
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

export const resetEmbeddingCache = () => {
  cache = new Map();
  inflightPromises = new Map();
};
