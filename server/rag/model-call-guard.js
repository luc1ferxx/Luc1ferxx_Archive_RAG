import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { getActiveDatabaseTenant } from "./postgres-tenant.js";
import { isRequestCancelledError } from "./request-deadline.js";
import {
  getLlmCircuitCooldownMs,
  getLlmCircuitFailureThreshold,
  getLlmIngestMaxConcurrency,
  getLlmMaxConcurrency,
  getLlmMaxQueue,
  getLlmRequestTimeoutMs,
} from "./config.js";
import {
  buildSharedStateKey,
  getSharedRedisClient,
  SHARED_STATE_TTL_MS,
  whenSharedStateReady,
} from "./shared-state.js";
import { recordTenantRefusal } from "./tenant-refusals.js";

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
//
// Fairness. Requests that find every slot busy wait per tenant -- the active
// database tenant (postgres-tenant.js), else one shared "system" queue -- and a
// freed slot goes to the tenant served longest ago, oldest request first
// (createTenantFairQueue). One tenant's burst therefore no longer queues every
// other tenant behind it: a tenant that arrives behind a backlog waits for at
// most one slot release per tenant ahead of it. For a single tenant the order
// is exactly the FIFO it always was. A waiter whose caller's signal aborts
// leaves the queue at once; RAG_LLM_MAX_QUEUE bounds each tenant's queue. With
// RAG_SHARED_STATE=redis the cap is shared but the order is per process: the
// local queue is fair, and the shared ticket queue between instances stays
// first come first served.
//
// Lanes. Document (batch) embeddings -- ingest, index builds -- ask for the
// ingest lane (MODEL_CALL_LANES.ingest). With RAG_LLM_INGEST_MAX_CONCURRENCY
// set, that lane is a guard of its own for the endpoint and model (its own
// cap and its own circuit), so a large ingest cannot take the slots query
// embeddings wait for; the endpoint may then see both caps in flight at once.
// Unset (the default), document embeddings use the endpoint's one guard, as
// they always did: RAG_LLM_MAX_CONCURRENCY stays the endpoint's whole cap (a
// self-hosted server sized to it never sees twice as many requests), one
// circuit sees every failure, and the fair queue still serves a query's
// tenant after at most one slot release per tenant ahead of it
// (resolveModelCallLane).

export const CIRCUIT_OPEN_CODE = "CIRCUIT_OPEN";
export const MODEL_CALL_QUEUE_FULL_CODE = "MODEL_CALL_QUEUE_FULL";

export const MODEL_CALL_LANES = Object.freeze({
  default: "default",
  ingest: "ingest",
});

/**
 * The guard key of `key` (`<endpoint>|<model>`) in `lane`. The lane goes in
 * front: rag/metrics-model.js labels a guard by the text after the key's last
 * "|", which must stay the model name. The default lane keeps the key it has
 * always had.
 */
export const buildModelCallGuardKey = (key, lane = MODEL_CALL_LANES.default) =>
  lane === MODEL_CALL_LANES.ingest ? `${MODEL_CALL_LANES.ingest}|${key}` : String(key);

// Whether RAG_LLM_INGEST_MAX_CONCURRENCY names a cap: a number of 0 or more
// (0 = no cap). Unset, empty, whitespace or not a number means unset, exactly
// as config.js getLlmIngestMaxConcurrency falls back to RAG_LLM_MAX_CONCURRENCY.
const isIngestLaneConfigured = (env = process.env) => {
  const raw = env.RAG_LLM_INGEST_MAX_CONCURRENCY;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return false;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0;
};

/**
 * The lane whose guard a call of `lane` uses: the ingest lane is a guard of
 * its own only while RAG_LLM_INGEST_MAX_CONCURRENCY is set; otherwise its
 * calls share the default lane's guard (one cap and one circuit for the
 * endpoint and model, as before lanes existed).
 */
export const resolveModelCallLane = (lane = MODEL_CALL_LANES.default, env = process.env) =>
  lane === MODEL_CALL_LANES.ingest && isIngestLaneConfigured(env) ? MODEL_CALL_LANES.ingest : MODEL_CALL_LANES.default;

const SYSTEM_QUEUE_KEY = "system";
const SYSTEM_TENANT_REF = "system";

/**
 * The reference a guard records for a tenant ({ userId, workspaceId }) in its
 * observable state: a short hash, so health output never carries a tenant's
 * ids. "system" for a call without a tenant. An operator computes a known
 * tenant's reference with this function.
 */
export const describeModelCallTenantRef = (tenant) =>
  tenant && (tenant.userId || tenant.workspaceId)
    ? `tenant:${createHash("sha256")
        .update(JSON.stringify(["model_call_tenant", String(tenant.userId ?? ""), String(tenant.workspaceId ?? "")]))
        .digest("hex")
        .slice(0, 16)}`
    : SYSTEM_TENANT_REF;

// A model call made for several tenants at once (an ingest batch that merged
// their texts) is not one tenant's: it waits in the system queue and a failure
// is recorded against every tenant it carried.
const attributionStorage = new AsyncLocalStorage();

/** Runs `action` with its model calls attributed to `tenants` (an array of tenants or nulls). */
export const runWithModelCallAttribution = (tenants, action) =>
  attributionStorage.run(
    {
      refs: [...new Set((Array.isArray(tenants) ? tenants : []).map(describeModelCallTenantRef))].sort(),
    },
    action
  );

const resolveModelCallTenant = () => {
  const attribution = attributionStorage.getStore();

  if (attribution) {
    return { queueKey: SYSTEM_QUEUE_KEY, refs: attribution.refs.length > 0 ? attribution.refs : [SYSTEM_TENANT_REF] };
  }

  const tenant = getActiveDatabaseTenant();

  return tenant
    ? {
        queueKey: `tenant:${JSON.stringify([tenant.userId, tenant.workspaceId])}`,
        refs: [describeModelCallTenantRef(tenant)],
        tenant,
      }
    : { queueKey: SYSTEM_QUEUE_KEY, refs: [SYSTEM_TENANT_REF] };
};

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

const isCallerCancellation = (error) => {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (isRequestCancelledError(current)) {
      return true;
    }
  }

  return false;
};

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
 * A refused wait: the tenant already has RAG_LLM_MAX_QUEUE calls waiting for
 * this guard. A 429 (the tenant is sending too much, the endpoint is not
 * down): it never counts against the circuit, the retry loop backs off and
 * tries again, and the model gateway answers it as a 429 with this code.
 */
export const createQueueFullError = (maxQueue) => {
  const error = new Error(
    `Too many model calls of this tenant are already waiting for this model (RAG_LLM_MAX_QUEUE=${maxQueue}).`
  );

  error.code = MODEL_CALL_QUEUE_FULL_CODE;
  error.status = 429;
  error.gatewayError = { code: MODEL_CALL_QUEUE_FULL_CODE, status: 429 };

  return error;
};

const toAbortReason = (signal) => {
  if (signal.reason !== undefined) {
    return signal.reason;
  }

  const error = new Error("The model call was aborted while it waited for a slot.");

  error.name = "AbortError";
  return error;
};

// Tenants whose last grant a fair queue remembers once they are idle.
export const FAIR_QUEUE_MAX_TRACKED_TENANTS = 1024;

/**
 * The wait queue of one guard: a FIFO per tenant (`queueKey`), and between
 * tenants the one served longest ago goes first (each grant stamps its tenant
 * with a rising turn number). With every tenant backlogged that is plain
 * round robin; with one tenant it is FIFO. `started(queueKey)` /
 * `finished(queueKey)` track grants so a tenant that holds slots keeps its
 * place in the rotation.
 *
 * The stamps outlive a tenant's idle periods (like the ingest batcher's
 * servedTurns): a tenant that makes one call at a time is idle between its
 * calls, and coming back as a newcomer at turn 0 every time it would always
 * go before a tenant waiting with a second call, which then never got a slot
 * while such tenants kept the cap busy. Only a tenant never served (or one
 * whose stamp was the oldest of `maxTrackedTenants` and was dropped, which
 * sorts the same) starts at 0.
 */
export const createTenantFairQueue = ({ maxTrackedTenants = FAIR_QUEUE_MAX_TRACKED_TENANTS } = {}) => {
  const tenants = new Map();
  // queueKey -> its last grant's turn, oldest first (re-inserted on each grant).
  const servedTurns = new Map();
  let size = 0;
  let turn = 0;

  const lastServedOf = (queueKey) => servedTurns.get(queueKey) ?? 0;

  const markServed = (queueKey) => {
    turn += 1;
    servedTurns.delete(queueKey);
    servedTurns.set(queueKey, turn);

    if (servedTurns.size > maxTrackedTenants) {
      servedTurns.delete(servedTurns.keys().next().value);
    }
  };

  const entryFor = (queueKey) => {
    let entry = tenants.get(queueKey);

    if (!entry) {
      entry = { inFlight: 0, waiters: [] };
      tenants.set(queueKey, entry);
    }

    return entry;
  };

  const forget = (queueKey, entry) => {
    if (entry.inFlight <= 0 && entry.waiters.length === 0) {
      tenants.delete(queueKey);
    }
  };

  return {
    get size() {
      return size;
    },
    waitingFor: (queueKey) => tenants.get(queueKey)?.waiters.length ?? 0,
    push(waiter) {
      entryFor(waiter.queueKey).waiters.push(waiter);
      size += 1;
    },
    /** Removes a waiter that has not been taken; false when it is not queued. */
    remove(waiter) {
      const entry = tenants.get(waiter.queueKey);
      const index = entry ? entry.waiters.indexOf(waiter) : -1;

      if (index < 0) {
        return false;
      }

      entry.waiters.splice(index, 1);
      size -= 1;
      forget(waiter.queueKey, entry);
      return true;
    },
    /** The next waiter: the oldest of the tenant served longest ago; null when none waits. */
    take() {
      let chosenKey = null;
      let chosen = null;
      let chosenTurn = 0;

      for (const [queueKey, entry] of tenants) {
        const entryTurn = lastServedOf(queueKey);

        if (entry.waiters.length > 0 && (chosen === null || entryTurn < chosenTurn)) {
          chosenKey = queueKey;
          chosen = entry;
          chosenTurn = entryTurn;
        }
      }

      if (!chosen) {
        return null;
      }

      const waiter = chosen.waiters.shift();

      size -= 1;
      forget(chosenKey, chosen);
      return waiter;
    },
    started(queueKey) {
      entryFor(queueKey).inFlight += 1;
      markServed(queueKey);
    },
    finished(queueKey) {
      const entry = tenants.get(queueKey);

      if (entry) {
        entry.inFlight = Math.max(0, entry.inFlight - 1);
        forget(queueKey, entry);
      }
    },
    /** Every waiter, in the order take() would hand them out. */
    drain() {
      const waiters = [];

      for (let waiter = this.take(); waiter; waiter = this.take()) {
        waiters.push(waiter);
      }

      return waiters;
    },
  };
};

// Queues a waiter that leaves when `signal` aborts; resolves with what
// `waiter.resolve` is later given.
const enqueueWaiter = (queue, { queueKey, signal }) => {
  let waiter;
  const promise = new Promise((resolve, reject) => {
    waiter = { detach: () => {}, queueKey, reject, resolve, signal };

    if (signal) {
      const onAbort = () => {
        if (queue.remove(waiter)) {
          reject(toAbortReason(signal));
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      waiter.detach = () => signal.removeEventListener("abort", onAbort);
    }
  });

  queue.push(waiter);
  return promise;
};

const describeQueueBound = (maxQueue, queueRejections) =>
  maxQueue > 0 ? { maxQueue, queueRejections } : {};

/**
 * Semaphore with a per-tenant fair wait queue (createTenantFairQueue).
 * `acquire({ queueKey, signal })` resolves with a release function; releasing
 * twice is a no-op, so a finally block cannot hand out a slot that is still in
 * use. A waiter whose `signal` aborts leaves the queue and rejects with the
 * signal's reason. A limit of 0 means unlimited; `maxQueue` (0 = unbounded)
 * caps how many calls of one tenant may wait.
 */
export const createConcurrencyLimiter = (limit, { maxQueue = 0 } = {}) => {
  const queue = createTenantFairQueue();
  let inFlight = 0;
  let queueRejections = 0;

  const grant = (queueKey) => {
    inFlight += 1;
    queue.started(queueKey);
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      inFlight -= 1;
      queue.finished(queueKey);
      const next = queue.take();

      if (next) {
        next.detach();
        next.resolve(grant(next.queueKey));
      }
    };
  };

  return {
    acquire: ({ queueKey = SYSTEM_QUEUE_KEY, signal } = {}) => {
      if (signal?.aborted) {
        return Promise.reject(toAbortReason(signal));
      }

      if (limit <= 0 || inFlight < limit) {
        return Promise.resolve(grant(queueKey));
      }

      if (maxQueue > 0 && queue.waitingFor(queueKey) >= maxQueue) {
        queueRejections += 1;
        return Promise.reject(createQueueFullError(maxQueue));
      }

      return enqueueWaiter(queue, { queueKey, signal });
    },
    snapshot: () => ({
      inFlight,
      limit,
      waiting: queue.size,
      ...describeQueueBound(maxQueue, queueRejections),
    }),
  };
};

// At most this many distinct tenants are named per open circuit; the rest are
// counted together, so a circuit tripped by a crowd keeps a bounded state.
const MAX_OPENER_REFS = 16;
const OTHER_TENANTS_REF = "other";

/**
 * Consecutive-failure breaker. Closed until `failureThreshold` unavailable
 * errors in a row; then open for `cooldownMs`; then half-open, where exactly
 * one probe request is let through. The probe's outcome closes the circuit or
 * opens it for another cooldown. A threshold of 0 disables the breaker.
 *
 * For observability only, each failure carries the tenant references of the
 * call (describeModelCallTenantRef): while the circuit is open or half-open
 * its snapshot names, as `openedBy`, the tenants whose failures since the last
 * success opened it, with how many each contributed. The counting itself is
 * independent of the tenants.
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
  // Tenant reference -> failures since the last success (the streak that
  // opens the circuit), and the openers recorded when it last opened.
  let streak = new Map();
  let openedBy = null;

  const noteFailure = (refs) => {
    for (const ref of Array.isArray(refs) && refs.length > 0 ? refs : [SYSTEM_TENANT_REF]) {
      const key = streak.has(ref) || streak.size < MAX_OPENER_REFS ? ref : OTHER_TENANTS_REF;

      streak.set(key, (streak.get(key) ?? 0) + 1);
    }
  };

  const open = () => {
    state = CIRCUIT_STATES.open;
    openedAt = now();
    probeInFlight = false;
    openedBy = [...streak]
      .map(([tenant, failures]) => ({ failures, tenant }))
      .sort((left, right) => right.failures - left.failures || (left.tenant < right.tenant ? -1 : 1));
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
    // `tenantRefs`: who the failed call was for (observability only).
    recordFailure: (tenantRefs) => {
      if (failureThreshold <= 0) {
        return;
      }

      if (state === CIRCUIT_STATES.halfOpen) {
        // The failed probe alone reopens the circuit.
        streak = new Map();
        noteFailure(tenantRefs);
        open();
        return;
      }

      consecutiveFailures += 1;
      noteFailure(tenantRefs);

      if (consecutiveFailures >= failureThreshold) {
        open();
      }
    },
    // Anything that is not an unavailable error proves the endpoint answered.
    recordSuccess: () => {
      state = CIRCUIT_STATES.closed;
      consecutiveFailures = 0;
      probeInFlight = false;
      streak = new Map();
      openedBy = null;
    },
    // The caller cancelled the call: no verdict on the endpoint. A half-open
    // probe gives its turn back so the next request probes instead.
    abandon: () => {
      if (state === CIRCUIT_STATES.halfOpen) {
        probeInFlight = false;
      }
    },
    snapshot: () =>
      state !== CIRCUIT_STATES.closed && openedBy
        ? { consecutiveFailures, openedBy: openedBy.map((opener) => ({ ...opener })), state }
        : { consecutiveFailures, state },
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
    // The tenants are kept by the local mirror only (its snapshot's openedBy):
    // the shared circuit counts failures, not who sent them.
    recordFailure: async (tenantRefs) => {
      local.recordFailure(tenantRefs);
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
    // The shared probe is a lease, so an abandoned probe frees itself when the
    // lease expires; only the local mirror is released at once.
    abandon: async () => {
      local.abandon();
    },
    snapshot: () => ({ ...local.snapshot(), shared: { provider: "redis", ...counter } }),
  };
};

/**
 * A deployment-wide cap: each request holds a lease in a Redis sorted set.
 * Waiters queue in this process, fair per tenant (createTenantFairQueue; the
 * order between instances is not per tenant, only this process's own), and
 * the head holds a ticket in a queue shared by every instance; a freed slot
 * goes to the oldest ticket, so an instance whose own releases wake its head
 * at once cannot keep re-taking the slots it frees while other instances wait
 * (each instance gets one slot per turn of the queue). The ticket belongs to
 * the head of the local queue, whichever waiter that is when a slot comes in.
 * The head polls: at `pollMs` while its ticket could be served by the next
 * free slots, otherwise backing off to `maxPollMs`; a release in this process
 * wakes it at once. A ticket expires unless refreshed within `ticketTtlMs`, and
 * a lease outlives the longest request (the request timeout plus a margin), so
 * a crashed instance neither holds its slots nor blocks the queue for long. If
 * Redis fails, every waiter falls back to the local cap. A waiter whose signal
 * aborts leaves the local queue; `maxQueue` bounds each tenant's local queue.
 */
export const createSharedConcurrencyLimiter = ({
  key,
  leaseMs,
  limit,
  local,
  maxPollMs = 100,
  maxQueue = 0,
  now = Date.now,
  pollMs = 10,
  redis,
  ticketTtlMs = 2000,
}) => {
  const redisKey = buildSharedStateKey("slots", key);
  const ticketQueueKey = `${redisKey}:queue`;
  const queueDeadlinesKey = `${redisKey}:queue-deadlines`;
  const { counter, record } = createFallbackCounter();
  // Acquire scripts this process ran (each poll of a waiting head is one) and
  // how many of them took a slot: the polling's cost is per second of waiting,
  // not per request, so it is reported as a count.
  const calls = { acquireCalls: 0, acquired: 0 };
  const waiting = createTenantFairQueue();
  let pumping = false;
  let queueRejections = 0;
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

  const returnLease = (leaseId) =>
    redis
      .zrem(redisKey, leaseId)
      .catch(() => {})
      .finally(() => {
        wake?.();
        pump();
      });

  const makeRelease = (leaseId, tenantQueueKey) => {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      waiting.finished(tenantQueueKey);
      returnLease(leaseId);
    };
  };

  const pump = async () => {
    if (pumping) {
      return;
    }

    pumping = true;
    let delay = pollMs;
    // One ticket per head of the local queue; a new head queues behind the
    // instances already waiting.
    let ticket = randomUUID();

    try {
      while (waiting.size > 0) {
        const leaseId = randomUUID();
        let acquired;
        let position;

        try {
          await whenSharedStateReady();
          calls.acquireCalls += 1;
          [acquired, position] = await redis.archiveSlotAcquire(
            redisKey,
            ticketQueueKey,
            queueDeadlinesKey,
            now(),
            limit,
            leaseMs,
            leaseId,
            SHARED_STATE_TTL_MS,
            ticket,
            ticketTtlMs
          );
        } catch (error) {
          record(error);

          for (const waiter of waiting.drain()) {
            waiter.detach();
            waiter.resolve(local.acquire({ queueKey: waiter.queueKey, signal: waiter.signal }));
          }

          break;
        }

        if (acquired === 1) {
          calls.acquired += 1;
          const waiter = waiting.take();

          if (!waiter) {
            // Every waiter left (aborted) while the script ran: give the slot back.
            returnLease(leaseId);
            break;
          }

          waiter.detach();
          waiting.started(waiter.queueKey);
          waiter.resolve(makeRelease(leaseId, waiter.queueKey));
          ticket = randomUUID();
          delay = pollMs;
          continue;
        }

        // Within the first `limit` tickets, the next releases serve this one:
        // keep polling at the base interval so a slot another instance frees
        // does not sit idle for a backed-off poll.
        const nearFront = position < limit;

        await sleep(nearFront ? pollMs : delay);
        delay = nearFront ? pollMs : Math.min(maxPollMs, delay * 2);
      }
    } finally {
      pumping = false;
    }
  };

  return {
    acquire: ({ queueKey = SYSTEM_QUEUE_KEY, signal } = {}) => {
      if (signal?.aborted) {
        return Promise.reject(toAbortReason(signal));
      }

      if (limit <= 0) {
        return Promise.resolve(() => {});
      }

      if (maxQueue > 0 && waiting.waitingFor(queueKey) >= maxQueue) {
        queueRejections += 1;
        return Promise.reject(createQueueFullError(maxQueue));
      }

      const promise = enqueueWaiter(waiting, { queueKey, signal });

      pump();
      return promise;
    },
    snapshot: () => ({
      limit,
      waiting: waiting.size,
      ...describeQueueBound(maxQueue, queueRejections),
      shared: { provider: "redis", ...counter, ...calls },
    }),
  };
};

const guards = new Map();

// Slightly longer than any request may run, so a lease never expires under a
// request that is still in flight.
const SHARED_SLOT_LEASE_MARGIN_MS = 5000;

const getGuard = (key, lane) => {
  if (!guards.has(key)) {
    const cooldownMs = getLlmCircuitCooldownMs();
    const failureThreshold = getLlmCircuitFailureThreshold();
    const limit = lane === MODEL_CALL_LANES.ingest ? getLlmIngestMaxConcurrency() : getLlmMaxConcurrency();
    const maxQueue = getLlmMaxQueue();
    const breaker = createCircuitBreaker({ cooldownMs, failureThreshold });
    const limiter = createConcurrencyLimiter(limit, { maxQueue });
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
            limiter: createSharedConcurrencyLimiter({ key, leaseMs, limit, local: limiter, maxQueue, redis }),
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
 *
 * `key` is `<endpoint>|<model>`; `lane` picks the guard of that key
 * (MODEL_CALL_LANES, through resolveModelCallLane: the ingest lane has a
 * guard of its own only with RAG_LLM_INGEST_MAX_CONCURRENCY set;
 * buildModelCallGuardKey names it). `signal`, the caller's,
 * takes a request still waiting for a slot out of the queue when it aborts
 * (it rejects with the signal's reason and is never sent); once sent, the
 * request itself carries the signal. The wait is fair per tenant (see the top
 * of this file).
 */
export const guardModelCall = async (
  key,
  send,
  { lane = MODEL_CALL_LANES.default, signal } = {}
) => {
  const guardLane = resolveModelCallLane(lane);
  const guardKey = buildModelCallGuardKey(key, guardLane);
  const { breaker, limiter } = getGuard(guardKey, guardLane);
  const tenant = resolveModelCallTenant();

  if (await breaker.isRejecting()) {
    throw createCircuitOpenError(guardKey);
  }

  let release;

  try {
    release = await limiter.acquire({ queueKey: tenant.queueKey, signal });
  } catch (error) {
    // RAG_LLM_MAX_QUEUE: counted for the tenant whose queue was full
    // (rag/tenant-refusals.js); the system queue (a merged ingest batch, a
    // call without a tenant) is ('', ''). Each refused attempt counts once.
    if (error?.code === MODEL_CALL_QUEUE_FULL_CODE) {
      recordTenantRefusal(MODEL_CALL_QUEUE_FULL_CODE, tenant.tenant ?? null);
    }

    throw error;
  }

  try {
    // Re-check after the wait: the circuit may have opened while this request
    // was queued behind the ones that tripped it.
    if (!(await breaker.admit())) {
      throw createCircuitOpenError(guardKey);
    }

    try {
      const result = await send();
      await breaker.recordSuccess();
      return result;
    } catch (error) {
      // A call its own caller cancelled (request deadline passed, client left)
      // says nothing about the model. Counted as a failure, a few short
      // deadlines opened the circuit for every tenant of the process; counted
      // as a success, a cancelled half-open probe closed it unanswered.
      if (isCallerCancellation(error)) {
        await breaker.abandon();
      } else if (isUnavailableError(error)) {
        await breaker.recordFailure(tenant.refs);
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

/** [key, snapshot] for every guard this process holds (rag/metrics-model.js). */
export const listModelCallGuardSnapshots = () =>
  [...guards.keys()].map((key) => [key, getModelCallGuardSnapshot(key)]);

/**
 * Shared-cap acquire scripts this process ran over every guard, and how many
 * took a slot (both 0 without shared state). A running total: read it twice
 * and subtract for a window.
 */
export const getModelCallGuardTotals = () => {
  let sharedSlotAcquireCalls = 0;
  let sharedSlotsAcquired = 0;

  for (const guard of guards.values()) {
    const shared = guard.limiter.snapshot().shared;

    sharedSlotAcquireCalls += shared?.acquireCalls ?? 0;
    sharedSlotsAcquired += shared?.acquired ?? 0;
  }

  return { sharedSlotAcquireCalls, sharedSlotsAcquired };
};

export const resetModelCallGuards = () => {
  guards.clear();
};
