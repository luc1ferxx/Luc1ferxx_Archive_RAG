import { randomUUID } from "node:crypto";
import {
  getLlmCircuitCooldownMs,
  getLlmCircuitFailureThreshold,
  getLlmMaxConcurrency,
  getLlmRequestTimeoutMs,
} from "./config.js";
import {
  buildSharedStateKey,
  getSharedRedisClient,
  SHARED_STATE_TTL_MS,
  whenSharedStateReady,
} from "./shared-state.js";

// Client-side protection for one model endpoint: a concurrency cap and a
// circuit breaker, applied to every HTTP request the model client sends.
//
// Retries and failover (openai.js) handle a failure after it happens. They
// cannot stop the two ways a client makes things worse:
//
// - Overload. A self-hosted server (Ollama, vLLM) queues whatever it is sent,
//   and every queued request makes the ones behind it slower. Once the queue is
//   longer than the request timeout, callers time out, retry, and join the back
//   of the same queue while the server is still working on the requests they
//   abandoned. The cap keeps the queue at the server short enough to drain.
// - A dead model. Each call spends its full retry schedule on a model that has
//   failed every request for the last minute before failing over. The breaker
//   remembers: after enough consecutive failures it rejects immediately, so the
//   call goes straight to the fallback model, or fails fast when there is none.
//
// State is per endpoint and model. By default it lives in this process; with
// RAG_SHARED_STATE=redis the breaker and the cap are shared by every instance
// (createSharedCircuitBreaker / createSharedConcurrencyLimiter below), and each
// falls back to this process's state whenever Redis does not answer. The cap
// counts requests in flight, not tokens per minute.

export const CIRCUIT_OPEN_CODE = "CIRCUIT_OPEN";

export const CIRCUIT_STATES = Object.freeze({
  closed: "closed",
  halfOpen: "half_open",
  open: "open",
});

// Only failures that say the endpoint is unavailable open the circuit. A 429
// means it is up and asking us to slow down, which backoff already does; a 4xx
// or an empty completion is about the request, not the model's health.
const UNAVAILABLE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

export const isUnavailableError = (error) => {
  const status = Number(error?.status);

  if (status >= 500 || status === 408) {
    return true;
  }

  return UNAVAILABLE_ERROR_CODES.has(
    String(error?.code ?? error?.cause?.code ?? "").toUpperCase()
  );
};

export const createCircuitOpenError = (key) => {
  const error = new Error(
    `Circuit open for ${key}: recent requests to this model failed; not sending another until the cooldown ends.`
  );
  error.code = CIRCUIT_OPEN_CODE;
  error.status = 503;

  return error;
};

/**
 * FIFO semaphore. `acquire` resolves with a release function; releasing twice
 * is a no-op, so a finally block cannot hand out a slot that is still in use.
 * A limit of 0 means unlimited.
 */
export const createConcurrencyLimiter = (limit) => {
  const waiting = [];
  let inFlight = 0;

  const grant = () => {
    inFlight += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      inFlight -= 1;
      const next = waiting.shift();

      if (next) {
        next(grant());
      }
    };
  };

  return {
    acquire: () => {
      if (limit <= 0 || inFlight < limit) {
        return Promise.resolve(grant());
      }

      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    snapshot: () => ({ inFlight, limit, waiting: waiting.length }),
  };
};

/**
 * Consecutive-failure breaker. Closed until `failureThreshold` unavailable
 * errors in a row; then open for `cooldownMs`; then half-open, where exactly
 * one probe request is let through. The probe's outcome closes the circuit or
 * opens it for another cooldown. A threshold of 0 disables the breaker.
 */
export const createCircuitBreaker = ({
  cooldownMs,
  failureThreshold,
  now = Date.now,
}) => {
  let state = CIRCUIT_STATES.closed;
  let consecutiveFailures = 0;
  let openedAt = 0;
  let probeInFlight = false;

  const open = () => {
    state = CIRCUIT_STATES.open;
    openedAt = now();
    probeInFlight = false;
  };

  const cooldownOver = () => now() - openedAt >= cooldownMs;

  return {
    // Cheap check before queueing for a slot; changes no state.
    isRejecting: () =>
      failureThreshold > 0 &&
      ((state === CIRCUIT_STATES.open && !cooldownOver()) ||
        (state === CIRCUIT_STATES.halfOpen && probeInFlight)),
    // Called once the request holds a slot and is about to be sent. Returns
    // false when it must not be sent.
    admit: () => {
      if (failureThreshold <= 0 || state === CIRCUIT_STATES.closed) {
        return true;
      }

      if (state === CIRCUIT_STATES.open) {
        if (!cooldownOver()) {
          return false;
        }

        state = CIRCUIT_STATES.halfOpen;
      }

      if (probeInFlight) {
        return false;
      }

      probeInFlight = true;
      return true;
    },
    recordFailure: () => {
      if (failureThreshold <= 0) {
        return;
      }

      if (state === CIRCUIT_STATES.halfOpen) {
        open();
        return;
      }

      consecutiveFailures += 1;

      if (consecutiveFailures >= failureThreshold) {
        open();
      }
    },
    // Anything that is not an unavailable error proves the endpoint answered.
    recordSuccess: () => {
      state = CIRCUIT_STATES.closed;
      consecutiveFailures = 0;
      probeInFlight = false;
    },
    snapshot: () => ({ consecutiveFailures, state }),
  };
};

const createFallbackCounter = () => {
  const counter = { fallbacks: 0, lastError: null };

  return {
    counter,
    record: (error) => {
      counter.fallbacks += 1;
      counter.lastError = error instanceof Error ? error.message : String(error);
    },
  };
};

/**
 * The same breaker, with its state in Redis so every instance sees one
 * circuit. `local` is kept up to date with every outcome and answers whenever
 * a Redis command fails, so an unreachable Redis degrades to per-process
 * protection instead of failing model calls. The half-open probe is a lease of
 * `probeLeaseMs`: an instance that dies while probing releases it by expiry.
 */
export const createSharedCircuitBreaker = ({
  cooldownMs,
  failureThreshold,
  key,
  local,
  now = Date.now,
  probeLeaseMs,
  redis,
}) => {
  const redisKey = buildSharedStateKey("circuit", key);
  const { counter, record } = createFallbackCounter();
  const withFallback = async (sharedCall, localCall) => {
    try {
      await whenSharedStateReady();
      return await sharedCall();
    } catch (error) {
      record(error);
      return localCall();
    }
  };

  return {
    isRejecting: () =>
      withFallback(
        async () =>
          (await redis.archiveCircuitPeek(redisKey, now(), cooldownMs, failureThreshold)) === 1,
        () => local.isRejecting()
      ),
    admit: () =>
      withFallback(
        async () =>
          (await redis.archiveCircuitAdmit(
            redisKey,
            now(),
            cooldownMs,
            failureThreshold,
            probeLeaseMs,
            SHARED_STATE_TTL_MS
          )) === 1,
        () => local.admit()
      ),
    recordFailure: async () => {
      local.recordFailure();
      await withFallback(
        () => redis.archiveCircuitFailure(redisKey, now(), failureThreshold, SHARED_STATE_TTL_MS),
        () => null
      );
    },
    recordSuccess: async () => {
      local.recordSuccess();
      await withFallback(
        () => redis.archiveCircuitSuccess(redisKey, SHARED_STATE_TTL_MS),
        () => null
      );
    },
    snapshot: () => ({ ...local.snapshot(), shared: { provider: "redis", ...counter } }),
  };
};

/**
 * A deployment-wide cap: each request holds a lease in a Redis sorted set.
 * Waiters queue FIFO in this process and the head polls for a slot (10 ms,
 * backing off to 100 ms); a release in this process wakes it at once, one in
 * another instance is seen at the next poll, so fairness across instances is
 * approximate. A lease outlives the longest request (the request timeout plus
 * a margin), so slots held by a crashed instance return on expiry. If Redis
 * fails, every waiter falls back to the local cap.
 */
export const createSharedConcurrencyLimiter = ({
  key,
  leaseMs,
  limit,
  local,
  maxPollMs = 100,
  now = Date.now,
  pollMs = 10,
  redis,
}) => {
  const redisKey = buildSharedStateKey("slots", key);
  const { counter, record } = createFallbackCounter();
  const waiting = [];
  let pumping = false;
  let wake = null;

  const sleep = (ms) =>
    new Promise((resolve) => {
      const done = () => {
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);

      wake = () => {
        clearTimeout(timer);
        done();
      };
    });

  const makeRelease = (leaseId) => {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      redis
        .zrem(redisKey, leaseId)
        .catch(() => {})
        .finally(() => {
          wake?.();
          pump();
        });
    };
  };

  const pump = async () => {
    if (pumping) {
      return;
    }

    pumping = true;
    let delay = pollMs;

    try {
      while (waiting.length > 0) {
        const leaseId = randomUUID();
        let acquired;

        try {
          await whenSharedStateReady();
          acquired =
            (await redis.archiveSlotAcquire(
              redisKey,
              now(),
              limit,
              leaseMs,
              leaseId,
              SHARED_STATE_TTL_MS
            )) === 1;
        } catch (error) {
          record(error);

          for (const waiter of waiting.splice(0)) {
            waiter.resolve(local.acquire());
          }

          break;
        }

        if (acquired) {
          waiting.shift().resolve(makeRelease(leaseId));
          delay = pollMs;
          continue;
        }

        await sleep(delay);
        delay = Math.min(maxPollMs, delay * 2);
      }
    } finally {
      pumping = false;
    }
  };

  return {
    acquire: () => {
      if (limit <= 0) {
        return Promise.resolve(() => {});
      }

      return new Promise((resolve) => {
        waiting.push({ resolve });
        pump();
      });
    },
    snapshot: () => ({
      limit,
      waiting: waiting.length,
      shared: { provider: "redis", ...counter },
    }),
  };
};

const guards = new Map();

// Slightly longer than any request may run, so a lease never expires under a
// request that is still in flight.
const SHARED_SLOT_LEASE_MARGIN_MS = 5000;

const getGuard = (key) => {
  if (!guards.has(key)) {
    const cooldownMs = getLlmCircuitCooldownMs();
    const failureThreshold = getLlmCircuitFailureThreshold();
    const limit = getLlmMaxConcurrency();
    const breaker = createCircuitBreaker({ cooldownMs, failureThreshold });
    const limiter = createConcurrencyLimiter(limit);
    const redis = getSharedRedisClient();
    const leaseMs = getLlmRequestTimeoutMs() + SHARED_SLOT_LEASE_MARGIN_MS;

    guards.set(
      key,
      redis
        ? {
            breaker: createSharedCircuitBreaker({
              cooldownMs,
              failureThreshold,
              key,
              local: breaker,
              probeLeaseMs: leaseMs,
              redis,
            }),
            limiter: createSharedConcurrencyLimiter({ key, leaseMs, limit, local: limiter, redis }),
          }
        : { breaker, limiter }
    );
  }

  return guards.get(key);
};

/**
 * Sends one request through the endpoint's breaker and concurrency cap. The
 * slot is held only while the request is in flight, never across a retry
 * backoff, so a caller waiting to retry does not block one that is ready.
 */
export const guardModelCall = async (key, send) => {
  const { breaker, limiter } = getGuard(key);

  if (await breaker.isRejecting()) {
    throw createCircuitOpenError(key);
  }

  const release = await limiter.acquire();

  try {
    // Re-check after the wait: the circuit may have opened while this request
    // was queued behind the ones that tripped it.
    if (!(await breaker.admit())) {
      throw createCircuitOpenError(key);
    }

    try {
      const result = await send();
      await breaker.recordSuccess();
      return result;
    } catch (error) {
      if (isUnavailableError(error)) {
        await breaker.recordFailure();
      } else {
        await breaker.recordSuccess();
      }

      throw error;
    }
  } finally {
    release();
  }
};

export const getModelCallGuardSnapshot = (key) => {
  const guard = guards.get(key);

  return guard
    ? { breaker: guard.breaker.snapshot(), limiter: guard.limiter.snapshot() }
    : null;
};

export const resetModelCallGuards = () => {
  guards.clear();
};
