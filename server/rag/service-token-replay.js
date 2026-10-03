import {
  buildSharedStateKey,
  getSharedRedisClient,
  isSharedStateEnabled,
  whenSharedStateReady,
} from "./shared-state.js";

// Remembers the internal service tokens (service-identity.js) this process has
// accepted until they expire, so a captured token is refused the second time
// it is presented. Every attempt of the service client carries a freshly
// signed token, so a failover or retry never presents one twice.
//
// The cache is per process and bounded: past maxEntries the oldest entries
// are dropped (and counted as evictions), which reopens the replay window for
// exactly those tokens rather than refusing new ones. With
// RAG_SHARED_STATE=redis every replica of a tier also records the token id in
// Redis (SET NX PX, one command), so a token cannot be replayed against a
// sibling replica either. Redis stays an optimization, as everywhere in
// shared-state.js: when a command fails the local verdict stands and the
// fallback is counted.
//
// Keys are the issuer and the token id (a random UUID); nothing else from the
// token is stored, and Redis sees only a hash of them.

export const DEFAULT_SERVICE_REPLAY_CACHE_MAX_ENTRIES = 100_000;
const MAX_SERVICE_REPLAY_CACHE_MAX_ENTRIES = 10_000_000;

const defaultSharedStore = Object.freeze({
  client: () => (isSharedStateEnabled() ? getSharedRedisClient() : null),
  key: (key) => buildSharedStateKey("service-token", key),
  ready: whenSharedStateReady,
});

export const getServiceReplayCacheMaxEntries = (env = process.env) => {
  const parsed = Number(env.INTERNAL_SERVICE_REPLAY_CACHE_MAX_ENTRIES);

  return String(env.INTERNAL_SERVICE_REPLAY_CACHE_MAX_ENTRIES ?? "").trim() &&
    Number.isFinite(parsed) &&
    parsed >= 1
    ? Math.min(MAX_SERVICE_REPLAY_CACHE_MAX_ENTRIES, Math.floor(parsed))
    : DEFAULT_SERVICE_REPLAY_CACHE_MAX_ENTRIES;
};

/**
 * Creates a replay cache. claim(key, expiresAtMs) returns true the first time
 * a key is claimed before it expires and false afterwards; it returns a
 * Promise of the same answer when shared state is in use (the local verdict
 * is final when it is already false). `shared` ({ client, key, ready }) and
 * `now` are injectable for tests; pass shared: null for a local-only cache.
 */
export const createServiceTokenReplayCache = ({
  maxEntries = DEFAULT_SERVICE_REPLAY_CACHE_MAX_ENTRIES,
  now = Date.now,
  shared = defaultSharedStore,
} = {}) => {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_SERVICE_REPLAY_CACHE_MAX_ENTRIES));
  // key -> expiresAt. Tokens share one lifetime, so insertion order is close
  // to expiry order and a sweep from the front stops at the first live entry.
  const entries = new Map();
  const counters = { accepted: 0, evictions: 0, replays: 0, sharedFallbacks: 0, sharedReplays: 0 };

  const sweep = (nowMs) => {
    for (const [key, expiresAt] of entries) {
      if (expiresAt > nowMs) {
        break;
      }

      entries.delete(key);
    }

    while (entries.size > limit) {
      entries.delete(entries.keys().next().value);
      counters.evictions += 1;
    }
  };

  const claimLocally = (key, expiresAt, nowMs) => {
    const existing = entries.get(key);

    if (existing !== undefined && existing > nowMs) {
      return false;
    }

    entries.delete(key);
    entries.set(key, expiresAt);
    sweep(nowMs);

    return true;
  };

  const claimShared = async (redis, key, ttlMs) => {
    try {
      await shared.ready?.();

      const result = await redis.set(shared.key(key), "1", "PX", ttlMs, "NX");

      if (result === null) {
        counters.sharedReplays += 1;
        counters.replays += 1;
        return false;
      }

      counters.accepted += 1;
      return true;
    } catch {
      counters.sharedFallbacks += 1;
      counters.accepted += 1;
      return true;
    }
  };

  const claim = (key, expiresAt) => {
    const nowMs = now();
    const normalizedKey = String(key ?? "");

    if (!normalizedKey || !Number.isFinite(expiresAt)) {
      throw new TypeError("A replay cache claim needs a key and an expiry time.");
    }

    if (!claimLocally(normalizedKey, expiresAt, nowMs)) {
      counters.replays += 1;
      return false;
    }

    let redis = null;

    try {
      redis = shared?.client?.() ?? null;
    } catch {
      counters.sharedFallbacks += 1;
    }

    if (!redis) {
      counters.accepted += 1;
      return true;
    }

    return claimShared(redis, normalizedKey, Math.max(1, Math.ceil(expiresAt - nowMs)));
  };

  return {
    claim,
    clear: () => entries.clear(),
    describe: () => ({ entries: entries.size, maxEntries: limit, ...counters }),
  };
};

let processCache = null;

/** The process-wide cache requireServiceIdentity uses by default. */
export const getServiceTokenReplayCache = (env = process.env) => {
  if (!processCache) {
    processCache = createServiceTokenReplayCache({ maxEntries: getServiceReplayCacheMaxEntries(env) });
  }

  return processCache;
};

/** Counters of the process-wide cache (null before first use), for health or metrics. */
export const describeServiceTokenReplayCache = () => processCache?.describe() ?? null;

export const resetServiceTokenReplayCache = () => {
  processCache = null;
};
