import { getModelGatewayQuotaLimits } from "../config.js";
import {
  buildSharedStateKey,
  getSharedRedisClient,
  whenSharedStateReady,
} from "../shared-state.js";
import { MODEL_GATEWAY_QUOTAS } from "./protocol.js";

// Per-workspace quotas at the model gateway: requests per minute, tokens per
// minute, and tokens per UTC day. Each is off at 0, the default.
//
// Windows are fixed (the current minute, the current UTC day). A request is
// admitted while the workspace is under every limit; its tokens are charged
// when the model answers, so a workspace can overshoot a token limit by the
// calls already in flight, never by more. Only answered calls are charged, as
// run-level usage is (run-usage.js): a failed or rate-limited upstream request
// is not billed.
//
// The quota key is the workspace, or the user for a scope without one. A
// system call (no tenant) is never limited.
//
// With RAG_SHARED_STATE=redis the counters are shared by every gateway
// replica; each admission is one Lua script. Redis is never a request
// dependency: when a command fails the counters of this process answer, and
// they are kept up to date with every admission and charge for that purpose.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// KEYS: requests-this-minute, tokens-this-minute, tokens-today.
// ARGV: rpm limit, tpm limit, daily limit, minute key TTL ms.
// Returns 0 when admitted (and counts the request), 1/2/3 for the limit hit.
const QUOTA_ADMIT_SCRIPT = `
local tpmLimit = tonumber(ARGV[2])
if tpmLimit > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= tpmLimit then return 2 end
local dailyLimit = tonumber(ARGV[3])
if dailyLimit > 0 and tonumber(redis.call('GET', KEYS[3]) or '0') >= dailyLimit then return 3 end
local rpmLimit = tonumber(ARGV[1])
if rpmLimit > 0 then
  if tonumber(redis.call('GET', KEYS[1]) or '0') >= rpmLimit then return 1 end
  redis.call('INCR', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
end
return 0
`;

// KEYS: tokens-this-minute, tokens-today. ARGV: tokens, minute TTL, day TTL.
const QUOTA_CHARGE_SCRIPT = `
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`;

const REJECTION_BY_SCRIPT_RESULT = Object.freeze({
  1: MODEL_GATEWAY_QUOTAS.requestsPerMinute,
  2: MODEL_GATEWAY_QUOTAS.tokensPerMinute,
  3: MODEL_GATEWAY_QUOTAS.dailyTokens,
});

const normalizeId = (value) => String(value ?? "").trim();

/** The quota key for a tenant ({ userId, workspaceId }), or null for a system call. */
export const getQuotaTenantKey = (tenant) => {
  const workspaceId = normalizeId(tenant?.workspaceId);
  const userId = normalizeId(tenant?.userId);

  if (workspaceId) {
    return `workspace:${workspaceId}`;
  }

  return userId ? `user:${userId}` : null;
};

const toLimit = (value) => Math.max(0, Math.floor(Number(value) || 0));

export const createModelGatewayQuotas = ({
  limits = getModelGatewayQuotaLimits(),
  now = Date.now,
  redis = getSharedRedisClient(),
} = {}) => {
  const configured = {
    dailyTokens: toLimit(limits?.dailyTokens),
    requestsPerMinute: toLimit(limits?.requestsPerMinute),
    tokensPerMinute: toLimit(limits?.tokensPerMinute),
  };
  const enabled = Object.values(configured).some((limit) => limit > 0);
  const counters = new Map();
  const fallback = { fallbacks: 0, lastError: null };

  const windows = (nowMs) => {
    const minute = Math.floor(nowMs / MINUTE_MS);
    const day = Math.floor(nowMs / DAY_MS);

    return {
      day,
      dayEndsInMs: (day + 1) * DAY_MS - nowMs,
      minute,
      minuteEndsInMs: (minute + 1) * MINUTE_MS - nowMs,
    };
  };

  const localKey = (kind, tenantKey, window) => `${kind}|${tenantKey}|${window}`;
  const readLocal = (key) => counters.get(key) ?? 0;
  const addLocal = (key, amount) => counters.set(key, readLocal(key) + amount);

  // Drops counters of windows that have ended. The kind is the first field and
  // the window the last: a workspace id may itself contain "|".
  const prune = ({ day, minute }) => {
    for (const key of counters.keys()) {
      const kind = key.slice(0, key.indexOf("|"));
      const window = key.slice(key.lastIndexOf("|") + 1);
      const current = kind === MODEL_GATEWAY_QUOTAS.dailyTokens ? day : minute;

      if (Number(window) < current) {
        counters.delete(key);
      }
    }
  };

  const keysFor = (tenantKey, { day, minute }) => ({
    daily: localKey(MODEL_GATEWAY_QUOTAS.dailyTokens, tenantKey, day),
    rpm: localKey(MODEL_GATEWAY_QUOTAS.requestsPerMinute, tenantKey, minute),
    tpm: localKey(MODEL_GATEWAY_QUOTAS.tokensPerMinute, tenantKey, minute),
  });

  const sharedKey = (key) => buildSharedStateKey("quota", key);

  const recordFallback = (error) => {
    fallback.fallbacks += 1;
    fallback.lastError = error instanceof Error ? error.message : String(error);
  };

  const admitLocally = (keys) => {
    if (configured.tokensPerMinute > 0 && readLocal(keys.tpm) >= configured.tokensPerMinute) {
      return MODEL_GATEWAY_QUOTAS.tokensPerMinute;
    }

    if (configured.dailyTokens > 0 && readLocal(keys.daily) >= configured.dailyTokens) {
      return MODEL_GATEWAY_QUOTAS.dailyTokens;
    }

    if (configured.requestsPerMinute > 0) {
      if (readLocal(keys.rpm) >= configured.requestsPerMinute) {
        return MODEL_GATEWAY_QUOTAS.requestsPerMinute;
      }

      addLocal(keys.rpm, 1);
    }

    return null;
  };

  const admitShared = async (keys, window) => {
    await whenSharedStateReady();
    const result = Number(
      await redis.eval(
        QUOTA_ADMIT_SCRIPT,
        3,
        sharedKey(keys.rpm),
        sharedKey(keys.tpm),
        sharedKey(keys.daily),
        configured.requestsPerMinute,
        configured.tokensPerMinute,
        configured.dailyTokens,
        window.minuteEndsInMs + MINUTE_MS
      )
    );
    const rejected = REJECTION_BY_SCRIPT_RESULT[result] ?? null;

    if (!rejected && configured.requestsPerMinute > 0) {
      // Keeps this process's counters close to the shared ones for the case
      // where Redis stops answering.
      addLocal(keys.rpm, 1);
    }

    return rejected;
  };

  /**
   * Whether a tenant ({ userId, workspaceId } or null) may send a request now.
   * Resolves { ok: true } and counts the request, or { ok: false, quota,
   * retryAfterMs } with the limit that refused it and when its window ends.
   */
  const admit = async (tenant) => {
    const tenantKey = getQuotaTenantKey(tenant);

    if (!enabled || !tenantKey) {
      return { ok: true };
    }

    const window = windows(now());
    const keys = keysFor(tenantKey, window);
    let rejected;

    prune(window);

    if (redis) {
      try {
        rejected = await admitShared(keys, window);
      } catch (error) {
        recordFallback(error);
        rejected = admitLocally(keys);
      }
    } else {
      rejected = admitLocally(keys);
    }

    if (!rejected) {
      return { ok: true };
    }

    return {
      ok: false,
      quota: rejected,
      retryAfterMs:
        rejected === MODEL_GATEWAY_QUOTAS.dailyTokens ? window.dayEndsInMs : window.minuteEndsInMs,
    };
  };

  /** Charges an answered call's tokens to the tenant's minute and day. */
  const chargeTokens = async (tenant, tokens) => {
    const tenantKey = getQuotaTenantKey(tenant);
    const amount = Math.max(0, Math.floor(Number(tokens) || 0));

    if (!enabled || !tenantKey || amount === 0) {
      return;
    }

    const window = windows(now());
    const keys = keysFor(tenantKey, window);

    addLocal(keys.tpm, amount);
    addLocal(keys.daily, amount);

    if (!redis) {
      return;
    }

    try {
      await whenSharedStateReady();
      await redis.eval(
        QUOTA_CHARGE_SCRIPT,
        2,
        sharedKey(keys.tpm),
        sharedKey(keys.daily),
        amount,
        window.minuteEndsInMs + MINUTE_MS,
        window.dayEndsInMs + MINUTE_MS
      );
    } catch (error) {
      recordFallback(error);
    }
  };

  const describe = () => ({
    enabled,
    limits: { ...configured },
    // Counters this process holds (current windows only).
    localCounters: counters.size,
    scope: "workspace",
    shared: redis ? { provider: "redis", ...fallback } : { provider: "memory" },
  });

  return { admit, chargeTokens, describe, enabled };
};
