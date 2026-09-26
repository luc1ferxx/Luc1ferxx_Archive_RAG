import { createHash } from "node:crypto";
import Redis from "ioredis";
import { getRedisUrl, getSharedStatePrefix, getSharedStateProvider } from "./config.js";

// Cross-instance state for the model call guard and the claim-judge cache.
//
// With RAG_SHARED_STATE=redis every instance reads and writes the same keys,
// so a circuit one instance opened is open for all of them, the concurrency
// cap bounds the whole deployment rather than each process, and a verdict one
// instance paid for is reused by the others. Each read-modify-write is one Lua
// script, so two instances cannot interleave inside it.
//
// Redis is an optimization, never a dependency of a request: every caller
// falls back to its in-process state when a command fails, and the client
// fails commands fast (no offline queue) instead of letting them wait.

let client = null;
let firstConnection = null;

export const isSharedStateEnabled = () => getSharedStateProvider() === "redis";

// Fails commands fast instead of queueing them while disconnected, and carries
// the Lua commands below.
export const createSharedRedisClient = (url) => {
  const redis = new Redis(url, {
    commandTimeout: 1000,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  // Connection errors surface on the commands that fail; without a listener
  // ioredis would report them as unhandled 'error' events.
  redis.on("error", () => {});
  defineSharedStateCommands(redis);

  return redis;
};

export const getSharedRedisClient = () => {
  if (!isSharedStateEnabled()) {
    return null;
  }

  if (!client) {
    client = createSharedRedisClient(getRedisUrl());
    firstConnection = waitUntilReady(client, 2000);
    // Settled either way; a rejection only means "fall back until connected".
    firstConnection.catch(() => {});
  }

  return client;
};

const waitUntilReady = (redis, timeoutMs) =>
  redis.status === "ready"
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          redis.off("ready", onReady);
          reject(new Error(`Redis did not become ready within ${timeoutMs} ms.`));
        }, timeoutMs);
        const onReady = () => {
          clearTimeout(timer);
          resolve();
        };

        redis.once("ready", onReady);
      });

/**
 * Commands fail fast when the client is not connected (no offline queue), so
 * the very first calls after startup would all fall back to per-process state
 * while the connection is still being made. They wait for that first
 * connection instead, once and at most 2 s; afterwards a disconnected client
 * fails fast and callers fall back.
 */
export const whenSharedStateReady = async () => {
  if (firstConnection) {
    await firstConnection;
  }
};

export const resetSharedState = async () => {
  if (!client) {
    return;
  }

  const closing = client;

  client = null;
  firstConnection = null;

  try {
    await closing.quit();
  } catch {
    closing.disconnect();
  }
};

export const buildSharedStateKey = (kind, key) =>
  `${getSharedStatePrefix()}${kind}:${createHash("sha256").update(String(key)).digest("hex").slice(0, 32)}`;

// Kept for a day after the last write so an idle endpoint's state expires.
export const SHARED_STATE_TTL_MS = 24 * 60 * 60 * 1000;

// --- Circuit breaker ------------------------------------------------------
// Hash fields: state (closed|open|half_open), failures, openedAt, probeUntil.
// The half-open probe is a lease rather than a flag, so an instance that dies
// holding it does not keep the circuit shut forever.

const CIRCUIT_PEEK_SCRIPT = `
local threshold = tonumber(ARGV[3])
if threshold <= 0 then return 0 end
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local now = tonumber(ARGV[1])
if state == 'open' then
  local openedAt = tonumber(redis.call('HGET', KEYS[1], 'openedAt') or '0')
  if now - openedAt < tonumber(ARGV[2]) then return 1 end
  return 0
end
if state == 'half_open' then
  local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0')
  if probeUntil > now then return 1 end
end
return 0
`;

const CIRCUIT_ADMIT_SCRIPT = `
local threshold = tonumber(ARGV[3])
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
if threshold <= 0 or state == 'closed' then return 1 end
local now = tonumber(ARGV[1])
if state == 'open' then
  local openedAt = tonumber(redis.call('HGET', KEYS[1], 'openedAt') or '0')
  if now - openedAt < tonumber(ARGV[2]) then return 0 end
  redis.call('HSET', KEYS[1], 'state', 'half_open')
end
local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0')
if probeUntil > now then return 0 end
redis.call('HSET', KEYS[1], 'probeUntil', now + tonumber(ARGV[4]))
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

const CIRCUIT_FAILURE_SCRIPT = `
local threshold = tonumber(ARGV[2])
if threshold <= 0 then return 0 end
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
if state == 'half_open' then
  redis.call('HSET', KEYS[1], 'state', 'open', 'openedAt', ARGV[1], 'probeUntil', 0)
else
  local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
  if failures >= threshold then
    redis.call('HSET', KEYS[1], 'state', 'open', 'openedAt', ARGV[1], 'probeUntil', 0)
  end
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

const CIRCUIT_SUCCESS_SCRIPT = `
redis.call('HSET', KEYS[1], 'state', 'closed', 'failures', 0, 'probeUntil', 0)
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
`;

// --- Concurrency cap ------------------------------------------------------
// A sorted set of slot leases scored by expiry. Expired leases are dropped
// before counting, so a crashed instance's slots come back after the lease.

const SLOT_ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[3]), ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0
`;

const defineSharedStateCommands = (redis) => {
  redis.defineCommand("archiveCircuitPeek", { lua: CIRCUIT_PEEK_SCRIPT, numberOfKeys: 1 });
  redis.defineCommand("archiveCircuitAdmit", { lua: CIRCUIT_ADMIT_SCRIPT, numberOfKeys: 1 });
  redis.defineCommand("archiveCircuitFailure", { lua: CIRCUIT_FAILURE_SCRIPT, numberOfKeys: 1 });
  redis.defineCommand("archiveCircuitSuccess", { lua: CIRCUIT_SUCCESS_SCRIPT, numberOfKeys: 1 });
  redis.defineCommand("archiveSlotAcquire", { lua: SLOT_ACQUIRE_SCRIPT, numberOfKeys: 1 });
};

export const checkSharedStateHealth = async () => {
  if (!isSharedStateEnabled()) {
    return {
      provider: "memory",
      status: "ok",
      message:
        "Circuit breakers, the model concurrency cap and the claim-judge cache are per process; run one instance or set RAG_SHARED_STATE=redis.",
    };
  }

  try {
    const redis = getSharedRedisClient();

    await whenSharedStateReady();
    await redis.ping();

    return { provider: "redis", status: "ok", message: "Shared state is reachable in Redis." };
  } catch (error) {
    return {
      provider: "redis",
      status: "error",
      message: `Redis is unreachable; every instance falls back to per-process state. ${
        error instanceof Error ? error.message : ""
      }`.trim(),
    };
  }
};
