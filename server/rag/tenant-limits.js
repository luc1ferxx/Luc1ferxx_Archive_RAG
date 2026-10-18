import {
  getTenantMaxConcurrentRuns,
  getTenantRateLimits,
  getTenantRateLimitWindowMs,
  isTenantRateLimitEnabled,
} from "./config.js";
import { matchRbacRoute } from "./rbac.js";
import {
  buildSharedStateKey,
  getSharedRedisClient,
  whenSharedStateReady,
} from "./shared-state.js";
import { recordTenantRefusal } from "./tenant-refusals.js";

// Per-tenant HTTP limits, mounted app-wide in app.js after requireApiAuth and
// bindDatabaseTenant (so the tenant is known), before RBAC and the routers.
//
// Two independent limits, both off by default:
//
// - TENANT_RATE_LIMIT_ENABLED: fixed-window request counts per tenant and per
//   cost class (chat, ingest, destructive, default), TENANT_RATE_LIMIT_<CLASS>_MAX
//   per TENANT_RATE_LIMIT_WINDOW_MS. Over a limit: 429 TENANT_RATE_LIMITED with
//   Retry-After (the end of the window). With RAG_SHARED_STATE=redis the
//   counters are shared by every instance (one Lua script per admission);
//   Redis is never a request dependency, so a failing command falls back to
//   this process's counters, which every shared admission keeps up to date.
// - TENANT_MAX_CONCURRENT_RUNS: agent-running requests (/chat, /chat/stream,
//   the agent-run actions) one tenant may have in flight in this process.
//   Over it: 429 TENANT_CONCURRENCY_LIMITED with Retry-After. A slot is
//   released once, when the response finishes or the client leaves (the
//   response's close), whichever comes first, so an error answer or a dropped
//   connection never keeps it. A run whose client left keeps running unless
//   AGENT_CANCEL_ON_DISCONNECT is on, after its slot was released.
//
// The tenant is the access scope's workspace, else its user, else the client
// IP (req.ip, which TRUST_PROXY makes the client behind a reverse proxy) for a
// scope naming neither. With API auth off, or for a principal that may choose
// its workspace or user, those ids are the client's own choice: a client that
// rotates them gets a budget per id, which only the per-IP limiter
// (RATE_LIMIT_ENABLED) bounds. Ids are compared case-insensitively, which can
// only merge budgets, never split one.
//
// The cost class is decided from the route Express would run (matchRbacRoute:
// case-insensitive literals, an optional trailing slash, HEAD as GET), so
// /CHAT/ costs what /chat costs.
//
// Every refusal is counted (rag/tenant-refusals.js): in
// archive_rag_tenant_refusals_total by its code, and in the usage ledger
// under the request's (user, workspace) pair, so GET /admin/usage
// ?metric=refusals&groupBy=workspace gives the per-workspace totals these
// workspace-keyed limits count. An IP-keyed refusal is recorded under ('', '').

export const TENANT_LIMIT_CLASSES = Object.freeze({
  chat: "chat",
  default: "default",
  destructive: "destructive",
  ingest: "ingest",
});

export const TENANT_RATE_LIMITED_CODE = "TENANT_RATE_LIMITED";
export const TENANT_CONCURRENCY_LIMITED_CODE = "TENANT_CONCURRENCY_LIMITED";

// No one knows when a slot frees; a chat takes seconds.
export const TENANT_CONCURRENCY_RETRY_AFTER_SECONDS = 5;

// Route patterns in RBAC_ROUTE_TABLE's syntax ("METHOD /express/path"); a
// test checks that each one names a route of that table.
//
// chat: every route that starts or continues agent work, which is what calls
// the model: /chat, /chat/stream and /agent-tasks, plus the run and task
// actions that resume such work (an approval continues a run's graph, a step
// retry reruns a step, a task action or a trigger dispatch starts a task).
export const TENANT_CHAT_CLASS_ROUTES = Object.freeze([
  "GET /chat",
  "POST /chat",
  "POST /chat/stream",
  "POST /agent-tasks",
  "POST /tasks/:taskId/actions/:action",
  "POST /agent-triggers/:triggerId/dispatch",
  "POST /agent-runs/:runId/actions/:action",
  "POST /agent-runs/:runId/steps/:stepId/actions/retry",
  "POST /agent-runs/:runId/recovery/actions/:action",
]);

// ingest: everything that brings document bytes in (direct and chunked
// uploads, one request per chunk; a document replace; an arXiv import, which
// downloads and ingests a PDF), and a restore from the trash, which parses
// and embeds a stored PDF again.
export const TENANT_INGEST_CLASS_ROUTES = Object.freeze([
  "POST /upload",
  "POST /upload/init",
  "POST /upload/chunk",
  "POST /upload/complete",
  "PUT /documents/:docId",
  "POST /documents/:docId/restore",
  "POST /arxiv/import",
  "POST /documents/:docId/arxiv/import",
]);

// destructive: every DELETE (documents, memory, the memory clear, sessions),
// decided by the method so a new DELETE route is covered without an entry
// here, plus the routes below.
export const TENANT_DESTRUCTIVE_CLASS_ROUTES = Object.freeze(["POST /documents/clear"]);

// The requests TENANT_MAX_CONCURRENT_RUNS counts: the ones that run the agent
// while the client waits.
export const TENANT_CONCURRENT_RUN_ROUTES = Object.freeze([
  "GET /chat",
  "POST /chat",
  "POST /chat/stream",
  "POST /agent-runs/:runId/actions/:action",
  "POST /agent-runs/:runId/steps/:stepId/actions/retry",
  "POST /agent-runs/:runId/recovery/actions/:action",
]);

const ROUTE_CLASS = new Map([
  ...TENANT_CHAT_CLASS_ROUTES.map((route) => [route, TENANT_LIMIT_CLASSES.chat]),
  ...TENANT_INGEST_CLASS_ROUTES.map((route) => [route, TENANT_LIMIT_CLASSES.ingest]),
  ...TENANT_DESTRUCTIVE_CLASS_ROUTES.map((route) => [route, TENANT_LIMIT_CLASSES.destructive]),
]);
const CONCURRENT_RUN_ROUTES = new Set(TENANT_CONCURRENT_RUN_ROUTES);

/**
 * The cost class of a request and whether it counts as a concurrent run.
 * `route` is the matched "METHOD /path" pattern, or null for a path no route
 * answers (it still costs `default`, or `destructive` for a DELETE).
 */
export const classifyTenantLimitRequest = (method, path) => {
  const match = matchRbacRoute(method, path);
  const route = match ? `${String(match.entry.method).toUpperCase()} ${match.entry.path}` : null;
  const isDelete = String(method ?? "").toUpperCase() === "DELETE";
  const costClass =
    (route && ROUTE_CLASS.get(route)) ||
    (isDelete ? TENANT_LIMIT_CLASSES.destructive : TENANT_LIMIT_CLASSES.default);

  return {
    costClass,
    countsAsRun: route !== null && CONCURRENT_RUN_ROUTES.has(route),
    route,
  };
};

const normalizeKeyPart = (value) => String(value ?? "").trim().toLowerCase();

/** The tenant a request is counted under: workspace, else user, else client IP. */
export const resolveTenantLimitKey = (req) => {
  const accessScope = req?.accessScope ?? {};
  const workspaceId = normalizeKeyPart(accessScope.workspaceId);

  if (workspaceId) {
    return `workspace:${workspaceId}`;
  }

  const userId = normalizeKeyPart(accessScope.userId);

  if (userId) {
    return `user:${userId}`;
  }

  return `ip:${req?.ip || req?.socket?.remoteAddress || "unknown"}`;
};

const toLimit = (value) => Math.max(0, Math.floor(Number(value) || 0));

// KEYS[1]: the class+tenant+window counter. ARGV: limit, key TTL ms.
// Returns -1 when the window is full (nothing counted), else the new count.
const TENANT_RATE_ADMIT_SCRIPT = `
local limit = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') >= limit then return -1 end
local count = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return count
`;

export const createTenantRateLimiter = ({
  enabled = isTenantRateLimitEnabled(),
  limits = getTenantRateLimits(),
  now = Date.now,
  // undefined: the process-wide shared-state client (null unless
  // RAG_SHARED_STATE=redis); null: this process's counters only.
  redis,
  windowMs = getTenantRateLimitWindowMs(),
} = {}) => {
  const configured = Object.fromEntries(
    Object.values(TENANT_LIMIT_CLASSES).map((costClass) => [
      costClass,
      toLimit(limits?.[costClass]),
    ])
  );
  const window = Math.max(1, Math.floor(Number(windowMs) || 0));
  const isEnabled = Boolean(enabled);
  const sharedRedis = isEnabled ? (redis === undefined ? getSharedRedisClient() : redis) : null;
  // window index -> (class|tenant -> count); only the current window is kept.
  const counters = new Map();
  const fallback = { fallbacks: 0, lastError: null };

  const countersFor = (windowIndex) => {
    for (const index of counters.keys()) {
      if (index < windowIndex) {
        counters.delete(index);
      }
    }

    let current = counters.get(windowIndex);

    if (!current) {
      current = new Map();
      counters.set(windowIndex, current);
    }

    return current;
  };

  const admitLocally = (local, key, limit) => {
    const count = local.get(key) ?? 0;

    if (count >= limit) {
      return false;
    }

    local.set(key, count + 1);
    return true;
  };

  const admitShared = async ({ key, limit, local, remainingMs, windowIndex }) => {
    await whenSharedStateReady();

    const result = Number(
      await sharedRedis.eval(
        TENANT_RATE_ADMIT_SCRIPT,
        1,
        buildSharedStateKey("tenant_rate", `${key}|${window}|${windowIndex}`),
        limit,
        remainingMs + window
      )
    );

    if (!Number.isFinite(result)) {
      throw new Error("Unexpected tenant rate-limit script result.");
    }

    if (result < 0) {
      return false;
    }

    // Keeps this process's counters close to the shared ones for the case
    // where Redis stops answering.
    local.set(key, (local.get(key) ?? 0) + 1);
    return true;
  };

  /**
   * Counts one request of `costClass` for `tenantKey`. Resolves { ok: true },
   * or { ok: false, costClass, limit, retryAfterMs } when the class's window
   * is full (the request is not counted then).
   */
  const admit = async (costClass, tenantKey) => {
    const limit = configured[costClass] ?? configured[TENANT_LIMIT_CLASSES.default];

    if (!isEnabled || !(limit > 0)) {
      return { ok: true };
    }

    const nowMs = now();
    const windowIndex = Math.floor(nowMs / window);
    const remainingMs = (windowIndex + 1) * window - nowMs;
    const local = countersFor(windowIndex);
    const key = `${costClass}|${tenantKey}`;
    let admitted;

    if (sharedRedis) {
      try {
        admitted = await admitShared({ key, limit, local, remainingMs, windowIndex });
      } catch (error) {
        fallback.fallbacks += 1;
        fallback.lastError = error instanceof Error ? error.message : String(error);
        admitted = admitLocally(local, key, limit);
      }
    } else {
      admitted = admitLocally(local, key, limit);
    }

    return admitted ? { ok: true } : { costClass, limit, ok: false, retryAfterMs: remainingMs };
  };

  const describe = () => ({
    enabled: isEnabled,
    limits: { ...configured },
    // Counters this process holds for the current window.
    localCounters: [...counters.values()].reduce((total, local) => total + local.size, 0),
    shared: sharedRedis ? { provider: "redis", ...fallback } : { provider: "memory" },
    windowMs: window,
  });

  return { admit, describe, enabled: isEnabled };
};

export const createTenantConcurrencyLimiter = ({
  maxConcurrent = getTenantMaxConcurrentRuns(),
} = {}) => {
  const max = toLimit(maxConcurrent);
  const inFlight = new Map();

  /**
   * A release function when `tenantKey` is under the cap (call it once; later
   * calls do nothing), or null when it is not. Without a cap every request
   * gets a release that does nothing.
   */
  const tryAcquire = (tenantKey) => {
    if (max <= 0) {
      return () => {};
    }

    const current = inFlight.get(tenantKey) ?? 0;

    if (current >= max) {
      return null;
    }

    inFlight.set(tenantKey, current + 1);

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;

      const remaining = (inFlight.get(tenantKey) ?? 1) - 1;

      if (remaining > 0) {
        inFlight.set(tenantKey, remaining);
      } else {
        inFlight.delete(tenantKey);
      }
    };
  };

  return {
    describe: () => ({ enabled: max > 0, maxConcurrent: max, tenantsInFlight: inFlight.size }),
    enabled: max > 0,
    getInFlight: (tenantKey) => inFlight.get(tenantKey) ?? 0,
    maxConcurrent: max,
    tryAcquire,
  };
};

const toRetryAfterSeconds = (milliseconds) => Math.max(1, Math.ceil(milliseconds / 1000));

const sendRateLimited = (res, decision) => {
  const retryAfterSeconds = toRetryAfterSeconds(decision.retryAfterMs);

  res.set("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    code: TENANT_RATE_LIMITED_CODE,
    error: "Too many requests for this tenant. Please retry later.",
    limitClass: decision.costClass,
    retryable: true,
    retryAfterSeconds,
  });
};

const sendConcurrencyLimited = (res) => {
  res.set("Retry-After", String(TENANT_CONCURRENCY_RETRY_AFTER_SECONDS));
  res.status(429).json({
    code: TENANT_CONCURRENCY_LIMITED_CODE,
    error: "Too many agent requests in flight for this tenant. Please retry later.",
    retryable: true,
    retryAfterSeconds: TENANT_CONCURRENCY_RETRY_AFTER_SECONDS,
  });
};

/**
 * The per-tenant limits for one app: { enabled, middleware, rateLimiter,
 * concurrencyLimiter }. `enabled` is false when neither limit is on; app.js
 * then mounts nothing.
 */
export const createTenantLimits = ({
  concurrencyLimiter = createTenantConcurrencyLimiter(),
  rateLimiter = createTenantRateLimiter(),
} = {}) => {
  const enabled = Boolean(rateLimiter.enabled || concurrencyLimiter.enabled);

  // Resolves true when the request may go on to the routes.
  const admit = async (req, res) => {
    const { costClass, countsAsRun } = classifyTenantLimitRequest(req.method, req.path);
    const tenantKey = resolveTenantLimitKey(req);
    const tracksRun = countsAsRun && concurrencyLimiter.enabled;
    let settled = false;
    let release = null;

    if (tracksRun) {
      // Listening before anything is awaited: a client that leaves while the
      // rate limit waits for Redis is seen, and no slot is taken for it.
      const onSettled = () => {
        settled = true;

        const pending = release;

        release = null;
        pending?.();
      };

      res.once("finish", onSettled);
      res.once("close", onSettled);
    }

    if (rateLimiter.enabled) {
      const decision = await rateLimiter.admit(costClass, tenantKey);

      if (!decision.ok) {
        recordTenantRefusal(TENANT_RATE_LIMITED_CODE, req.accessScope);
        sendRateLimited(res, decision);
        return false;
      }
    }

    if (!tracksRun) {
      return true;
    }

    if (settled || res.closed || res.destroyed) {
      return false;
    }

    const acquired = concurrencyLimiter.tryAcquire(tenantKey);

    if (!acquired) {
      recordTenantRefusal(TENANT_CONCURRENCY_LIMITED_CODE, req.accessScope);
      sendConcurrencyLimited(res);
      return false;
    }

    release = acquired;
    return true;
  };

  const middleware = (req, res, next) => {
    admit(req, res).then(
      (proceed) => {
        if (proceed) {
          next();
        }
      },
      (error) => next(error)
    );
  };

  return { concurrencyLimiter, enabled, middleware, rateLimiter };
};
