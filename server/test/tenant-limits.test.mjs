// Per-tenant HTTP limits (rag/tenant-limits.js): fixed-window rate limits per
// tenant and cost class, the per-process cap on concurrent agent requests,
// the Redis-shared counters and their per-process fallback, and TRUST_PROXY.
//
// Concurrency is driven with barriers and deferred promises: a handler
// announces that it is running and waits until the test lets it answer, so no
// assertion depends on timing.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import express from "express";

import { getTrustProxySetting } from "../rag/config.js";
import { getActiveDatabaseTenant, runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { RBAC_ROUTE_TABLE } from "../rag/rbac.js";
import { createSharedRedisClient } from "../rag/shared-state.js";
import {
  classifyTenantLimitRequest,
  createTenantConcurrencyLimiter,
  createTenantLimits,
  createTenantRateLimiter,
  resolveTenantLimitKey,
  TENANT_CHAT_CLASS_ROUTES,
  TENANT_CONCURRENCY_LIMITED_CODE,
  TENANT_CONCURRENCY_RETRY_AFTER_SECONDS,
  TENANT_CONCURRENT_RUN_ROUTES,
  TENANT_DESTRUCTIVE_CLASS_ROUTES,
  TENANT_INGEST_CLASS_ROUTES,
  TENANT_RATE_LIMITED_CODE,
} from "../rag/tenant-limits.js";

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

const startServer = async (app) => {
  const server = createServer(app);

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
    port: server.address().port,
  };
};

// What requireApiAuth would decide from the identity headers.
const scopeFromHeaders = (req, res, next) => {
  req.accessScope = {
    authenticated: true,
    userId: req.get("x-user-id") ?? "",
    workspaceId: req.get("x-workspace-id") ?? "",
  };
  next();
};

const AS_ACME = { "x-user-id": "alice", "x-workspace-id": "acme" };
const AS_GLOBEX = { "x-user-id": "bob", "x-workspace-id": "globex" };

// A Redis stand-in that runs the admission script's logic over one shared map,
// as every instance pointing at one Redis would.
const createFakeSharedRedis = () => {
  const store = new Map();
  const calls = [];

  return {
    calls,
    eval: async (script, numberOfKeys, key, limit, ttlMs) => {
      calls.push({ key, limit: Number(limit), numberOfKeys, script, ttlMs: Number(ttlMs) });

      const count = store.get(key) ?? 0;

      if (count >= Number(limit)) {
        return -1;
      }

      store.set(key, count + 1);
      return count + 1;
    },
    store,
  };
};

const ROUTE_KEYS = new Set(
  RBAC_ROUTE_TABLE.map((entry) => `${entry.method.toUpperCase()} ${entry.path}`)
);

const samplePath = (routePath) =>
  routePath
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `sample-${segment.slice(1)}` : segment))
    .join("/");

test("every listed route pattern names a route of RBAC_ROUTE_TABLE", () => {
  for (const route of [
    ...TENANT_CHAT_CLASS_ROUTES,
    ...TENANT_INGEST_CLASS_ROUTES,
    ...TENANT_DESTRUCTIVE_CLASS_ROUTES,
    ...TENANT_CONCURRENT_RUN_ROUTES,
  ]) {
    assert.ok(ROUTE_KEYS.has(route), `${route} is not a route`);
  }

  // A run the client waits for is a chat-class request too.
  for (const route of TENANT_CONCURRENT_RUN_ROUTES) {
    assert.ok(TENANT_CHAT_CLASS_ROUTES.includes(route), `${route} is not chat-class`);
  }
});

test("every route of RBAC_ROUTE_TABLE gets its cost class", () => {
  const expected = new Map([
    ...TENANT_CHAT_CLASS_ROUTES.map((route) => [route, "chat"]),
    ...TENANT_INGEST_CLASS_ROUTES.map((route) => [route, "ingest"]),
    ...TENANT_DESTRUCTIVE_CLASS_ROUTES.map((route) => [route, "destructive"]),
  ]);

  for (const entry of RBAC_ROUTE_TABLE) {
    const method = entry.method.toUpperCase();
    const route = `${method} ${entry.path}`;
    const result = classifyTenantLimitRequest(method, samplePath(entry.path));
    const costClass = method === "DELETE" ? "destructive" : expected.get(route) ?? "default";

    assert.equal(result.route, route, `${route} matched`);
    assert.equal(result.costClass, costClass, route);
    assert.equal(result.countsAsRun, TENANT_CONCURRENT_RUN_ROUTES.includes(route), route);
  }

  // The classes the part names, spelled out.
  assert.equal(classifyTenantLimitRequest("POST", "/chat").costClass, "chat");
  assert.equal(classifyTenantLimitRequest("GET", "/chat").costClass, "chat");
  assert.equal(classifyTenantLimitRequest("POST", "/chat/stream").costClass, "chat");
  assert.equal(classifyTenantLimitRequest("POST", "/agent-tasks").costClass, "chat");
  assert.equal(classifyTenantLimitRequest("POST", "/upload").costClass, "ingest");
  assert.equal(classifyTenantLimitRequest("POST", "/upload/chunk").costClass, "ingest");
  assert.equal(classifyTenantLimitRequest("PUT", "/documents/doc-1").costClass, "ingest");
  assert.equal(classifyTenantLimitRequest("DELETE", "/documents/doc-1").costClass, "destructive");
  assert.equal(classifyTenantLimitRequest("POST", "/documents/clear").costClass, "destructive");
  assert.equal(classifyTenantLimitRequest("DELETE", "/memory").costClass, "destructive");
  assert.equal(classifyTenantLimitRequest("GET", "/documents").costClass, "default");
  assert.equal(classifyTenantLimitRequest("GET", "/upload/status").costClass, "default");
});

test("the class follows the route Express runs: case, a trailing slash, HEAD, unknown paths", () => {
  assert.deepEqual(classifyTenantLimitRequest("POST", "/CHAT/"), {
    costClass: "chat",
    countsAsRun: true,
    route: "POST /chat",
  });
  assert.equal(classifyTenantLimitRequest("post", "/Chat/Stream").costClass, "chat");
  assert.equal(classifyTenantLimitRequest("DELETE", "/Documents/doc-1/").costClass, "destructive");
  assert.equal(classifyTenantLimitRequest("POST", "/documents/CLEAR").costClass, "destructive");
  assert.equal(classifyTenantLimitRequest("HEAD", "/documents").costClass, "default");
  // /agent-runs/recovery is the listing route, not a run id.
  assert.equal(classifyTenantLimitRequest("GET", "/agent-runs/recovery").costClass, "default");
  assert.deepEqual(classifyTenantLimitRequest("GET", "/no-such-route"), {
    costClass: "default",
    countsAsRun: false,
    route: null,
  });
  assert.equal(classifyTenantLimitRequest("DELETE", "/no-such-route").costClass, "destructive");
});

test("the tenant key is the workspace, else the user, else the client IP", () => {
  assert.equal(
    resolveTenantLimitKey({ accessScope: { userId: "alice", workspaceId: "Acme" }, ip: "10.0.0.1" }),
    "workspace:acme"
  );
  assert.equal(
    resolveTenantLimitKey({ accessScope: { userId: " Alice ", workspaceId: "  " }, ip: "10.0.0.1" }),
    "user:alice"
  );
  assert.equal(resolveTenantLimitKey({ accessScope: {}, ip: "10.0.0.1" }), "ip:10.0.0.1");
  assert.equal(
    resolveTenantLimitKey({ socket: { remoteAddress: "10.0.0.2" } }),
    "ip:10.0.0.2"
  );
  assert.equal(resolveTenantLimitKey({}), "ip:unknown");
});

test("one tenant over its limit leaves another tenant's budget alone", async () => {
  let nowMs = 60_000 * 100 + 15_000;
  const limiter = createTenantRateLimiter({
    enabled: true,
    limits: { chat: 2, default: 5, destructive: 1, ingest: 3 },
    now: () => nowMs,
    redis: null,
    windowMs: 60_000,
  });

  assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });
  assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });
  assert.deepEqual(await limiter.admit("chat", "workspace:acme"), {
    costClass: "chat",
    limit: 2,
    ok: false,
    retryAfterMs: 45_000,
  });

  // Another tenant, and another class of the same tenant, are unaffected.
  assert.deepEqual(await limiter.admit("chat", "workspace:globex"), { ok: true });
  assert.deepEqual(await limiter.admit("default", "workspace:acme"), { ok: true });

  // The next window starts empty, and the old one is dropped.
  nowMs = 60_000 * 101;
  assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });
  assert.equal(limiter.describe().localCounters, 1);
});

test("a class maximum of 0 is no limit, and a disabled limiter counts nothing", async () => {
  const unlimitedChat = createTenantRateLimiter({
    enabled: true,
    limits: { chat: 0, default: 1, destructive: 1, ingest: 1 },
    redis: null,
  });

  for (let index = 0; index < 50; index += 1) {
    assert.deepEqual(await unlimitedChat.admit("chat", "workspace:acme"), { ok: true });
  }

  const disabled = createTenantRateLimiter({
    enabled: false,
    limits: { chat: 1, default: 1, destructive: 1, ingest: 1 },
  });

  assert.equal(disabled.enabled, false);
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await disabled.admit("chat", "workspace:acme"), { ok: true });
  }
  assert.equal(disabled.describe().shared.provider, "memory");
});

test("with Redis the counters are shared by every instance under hashed keys", async () => {
  const redis = createFakeSharedRedis();
  const nowMs = 60_000 * 7 + 30_000;
  const limits = { chat: 3, default: 10, destructive: 1, ingest: 5 };
  const first = createTenantRateLimiter({ enabled: true, limits, now: () => nowMs, redis });
  const second = createTenantRateLimiter({ enabled: true, limits, now: () => nowMs, redis });

  assert.deepEqual(await first.admit("chat", "workspace:acme"), { ok: true });
  assert.deepEqual(await second.admit("chat", "workspace:acme"), { ok: true });
  assert.deepEqual(await first.admit("chat", "workspace:acme"), { ok: true });

  // The fourth request of the deployment is refused, whichever instance gets it.
  const refused = await second.admit("chat", "workspace:acme");

  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterMs, 30_000);
  assert.deepEqual(await first.admit("chat", "workspace:globex"), { ok: true });

  const keys = new Set(redis.calls.map((call) => call.key));

  assert.equal(keys.size, 2, "one key per tenant and class");
  for (const key of keys) {
    assert.doesNotMatch(key, /acme|globex|chat/u, "no tenant id or class in a key name");
  }
  for (const call of redis.calls) {
    assert.equal(call.numberOfKeys, 1);
    assert.equal(call.limit, 3);
    // The key outlives its window, never by more than one more window.
    assert.equal(call.ttlMs, 30_000 + 60_000);
  }
  assert.deepEqual(first.describe().shared, { fallbacks: 0, lastError: null, provider: "redis" });
});

test("a failing Redis falls back to this process's counters, kept up to date", async () => {
  const redis = createFakeSharedRedis();
  let failing = false;
  const flaky = {
    eval: async (...args) => {
      if (failing) {
        throw new Error("Connection is closed.");
      }

      return redis.eval(...args);
    },
  };
  const limiter = createTenantRateLimiter({
    enabled: true,
    limits: { chat: 3, default: 10, destructive: 1, ingest: 5 },
    now: () => 1_000,
    redis: flaky,
  });

  assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });
  assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });

  failing = true;

  // The two shared admissions were mirrored locally: one more fits, then the
  // limit holds without Redis, and the request never fails.
  assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });
  assert.equal((await limiter.admit("chat", "workspace:acme")).ok, false);
  assert.deepEqual(await limiter.admit("chat", "workspace:globex"), { ok: true });

  const { shared } = limiter.describe();

  assert.equal(shared.provider, "redis");
  assert.equal(shared.fallbacks, 3);
  assert.equal(shared.lastError, "Connection is closed.");
});

test("a real Redis client that cannot connect falls back without failing a request", async () => {
  // A port nothing listens on: the client fails commands at once (no offline
  // queue) while it keeps trying to connect.
  const probe = createServer();

  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");

  const { port } = probe.address();

  await new Promise((resolve) => probe.close(resolve));

  const redis = createSharedRedisClient(`redis://127.0.0.1:${port}`);

  try {
    const limiter = createTenantRateLimiter({
      enabled: true,
      limits: { chat: 2, default: 2, destructive: 2, ingest: 2 },
      redis,
    });

    assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });
    assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });
    assert.equal((await limiter.admit("chat", "workspace:acme")).ok, false);
    assert.equal(limiter.describe().shared.fallbacks, 3);
  } finally {
    redis.disconnect();
  }
});

test("an unexpected Redis answer falls back too", async () => {
  const limiter = createTenantRateLimiter({
    enabled: true,
    limits: { chat: 1, default: 1, destructive: 1, ingest: 1 },
    redis: { eval: async () => "OK" },
  });

  assert.deepEqual(await limiter.admit("chat", "workspace:acme"), { ok: true });
  assert.equal((await limiter.admit("chat", "workspace:acme")).ok, false);
  assert.equal(limiter.describe().shared.fallbacks, 2);
});

test("the concurrency limiter caps a tenant and releases each slot once", () => {
  const limiter = createTenantConcurrencyLimiter({ maxConcurrent: 2 });
  const first = limiter.tryAcquire("workspace:acme");
  const second = limiter.tryAcquire("workspace:acme");

  assert.equal(typeof first, "function");
  assert.equal(typeof second, "function");
  assert.equal(limiter.tryAcquire("workspace:acme"), null);
  assert.equal(typeof limiter.tryAcquire("workspace:globex"), "function");

  first();
  first();
  assert.equal(limiter.getInFlight("workspace:acme"), 1, "a second release changes nothing");

  second();
  assert.equal(limiter.getInFlight("workspace:acme"), 0);
  assert.equal(limiter.describe().tenantsInFlight, 1);

  const uncapped = createTenantConcurrencyLimiter({ maxConcurrent: 0 });

  assert.equal(uncapped.enabled, false);
  assert.equal(typeof uncapped.tryAcquire("workspace:acme"), "function");
  assert.equal(uncapped.getInFlight("workspace:acme"), 0);
});

test("createTenantLimits is disabled when neither limit is on", () => {
  const limits = createTenantLimits({
    concurrencyLimiter: createTenantConcurrencyLimiter({ maxConcurrent: 0 }),
    rateLimiter: createTenantRateLimiter({ enabled: false }),
  });

  assert.equal(limits.enabled, false);
});

// An app whose POST /chat and POST /agent-runs/:runId/actions/:action wait
// until the test lets them answer. Each request announces itself on
// `arrivals` with a handle to finish it.
// `responseClosed` resolves, for each request in arrival order, when the
// server side of its response closes; it is registered ahead of the limiter,
// so by then the limiter has seen the close too.
const createHarness = async ({ maxConcurrent = 1, rateLimiter } = {}) => {
  const tenantLimits = createTenantLimits({
    concurrencyLimiter: createTenantConcurrencyLimiter({ maxConcurrent }),
    rateLimiter: rateLimiter ?? createTenantRateLimiter({ enabled: false }),
  });
  const waiting = [];
  const arrived = [];
  const responseClosed = [];
  const app = express();

  app.use((req, res, next) => {
    const closed = createDeferred();

    responseClosed.push(closed.promise);
    res.on("close", () => closed.resolve());
    next();
  });

  const nextArrival = () => {
    if (arrived.length > 0) {
      return Promise.resolve(arrived.shift());
    }

    const deferred = createDeferred();

    waiting.push(deferred);
    return deferred.promise;
  };

  const hold = async (req, res, next) => {
    const finish = createDeferred();
    const closed = createDeferred();

    res.on("close", () => closed.resolve());

    const arrival = { closed: closed.promise, finish: finish.resolve, path: req.path };
    const waiter = waiting.shift();

    if (waiter) {
      waiter.resolve(arrival);
    } else {
      arrived.push(arrival);
    }

    const outcome = await finish.promise;

    if (outcome === "error") {
      next(new Error("handler failed"));
      return;
    }

    if (outcome === "throw") {
      throw new Error("handler threw");
    }

    res.json({ ok: true });
  };

  app.use(express.json());
  app.use(scopeFromHeaders);
  app.use(tenantLimits.middleware);
  app.post("/chat", (req, res, next) => hold(req, res, next).catch(next));
  app.post("/agent-runs/:runId/actions/:action", (req, res, next) =>
    hold(req, res, next).catch(next)
  );
  app.get("/documents", (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => {
    res.status(500).json({ error: error.message });
  });

  const server = await startServer(app);

  return { ...server, nextArrival, responseClosed, tenantLimits };
};

const post = (baseUrl, path, headers) =>
  fetch(`${baseUrl}${path}`, {
    body: "{}",
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });

test("a tenant at its concurrency cap gets 429 while another tenant still runs", async () => {
  const harness = await createHarness({ maxConcurrent: 1 });

  try {
    const acmeFirst = post(harness.baseUrl, "/chat", AS_ACME);
    const acmeRun = await harness.nextArrival();

    const acmeSecond = await post(harness.baseUrl, "/agent-runs/run-1/actions/approve", AS_ACME);

    assert.equal(acmeSecond.status, 429);
    assert.equal(acmeSecond.headers.get("retry-after"), String(TENANT_CONCURRENCY_RETRY_AFTER_SECONDS));
    assert.deepEqual(await acmeSecond.json(), {
      code: TENANT_CONCURRENCY_LIMITED_CODE,
      error: "Too many agent requests in flight for this tenant. Please retry later.",
      retryable: true,
      retryAfterSeconds: TENANT_CONCURRENCY_RETRY_AFTER_SECONDS,
    });

    // Requests that are not runs are not capped.
    assert.equal((await fetch(`${harness.baseUrl}/documents`, { headers: AS_ACME })).status, 200);

    const globex = post(harness.baseUrl, "/chat", AS_GLOBEX);
    const globexRun = await harness.nextArrival();

    assert.equal(harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:acme"), 1);
    assert.equal(harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:globex"), 1);

    acmeRun.finish("ok");
    globexRun.finish("ok");
    assert.equal((await acmeFirst).status, 200);
    assert.equal((await globex).status, 200);
    await acmeRun.closed;
    await globexRun.closed;

    assert.equal(harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:acme"), 0);

    // The slot is free again.
    const again = post(harness.baseUrl, "/chat", AS_ACME);
    const againRun = await harness.nextArrival();

    againRun.finish("ok");
    assert.equal((await again).status, 200);
  } finally {
    await harness.close();
  }
});

test("a slot is released when the handler fails", async () => {
  const harness = await createHarness({ maxConcurrent: 1 });

  try {
    for (const outcome of ["error", "throw"]) {
      const failing = post(harness.baseUrl, "/chat", AS_ACME);
      const run = await harness.nextArrival();

      run.finish(outcome);
      assert.equal((await failing).status, 500, outcome);
      await run.closed;
      assert.equal(harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:acme"), 0, outcome);
    }

    const next = post(harness.baseUrl, "/chat", AS_ACME);
    const run = await harness.nextArrival();

    run.finish("ok");
    assert.equal((await next).status, 200);
  } finally {
    await harness.close();
  }
});

// A raw request whose socket the test can drop mid-flight.
const sendAndAbandon = (port, path, headers) => {
  const request = httpRequest({
    headers: { "Content-Type": "application/json", ...headers },
    host: "127.0.0.1",
    method: "POST",
    path,
    port,
  });

  request.on("error", () => {});
  request.end("{}");
  return request;
};

test("a slot is released when the client leaves before the answer", async () => {
  const harness = await createHarness({ maxConcurrent: 1 });

  try {
    const abandoned = sendAndAbandon(harness.port, "/chat", AS_ACME);
    const run = await harness.nextArrival();

    assert.equal(harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:acme"), 1);

    abandoned.destroy();
    await run.closed;

    // The limiter listened on the same close, before the handler did.
    assert.equal(harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:acme"), 0);

    const next = post(harness.baseUrl, "/chat", AS_ACME);
    const nextRun = await harness.nextArrival();

    nextRun.finish("ok");
    assert.equal((await next).status, 200);

    // The abandoned handler answering later releases nothing twice.
    run.finish("ok");
    assert.equal(harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:acme"), 0);
  } finally {
    await harness.close();
  }
});

test("a client that leaves while the rate limit waits for Redis takes no slot", async () => {
  const redisAnswer = createDeferred();
  const redisAsked = createDeferred();
  const redis = {
    eval: async () => {
      redisAsked.resolve();
      return redisAnswer.promise;
    },
  };
  const harness = await createHarness({
    maxConcurrent: 1,
    rateLimiter: createTenantRateLimiter({
      enabled: true,
      limits: { chat: 10, default: 10, destructive: 10, ingest: 10 },
      redis,
    }),
  });
  try {
    const abandoned = sendAndAbandon(harness.port, "/chat", AS_ACME);

    await redisAsked.promise;
    abandoned.destroy();
    // The server has seen the client leave (and so has the limiter).
    await harness.responseClosed[0];

    // Redis answers the abandoned admission first: its continuation is queued
    // before the next request even arrives.
    redisAnswer.resolve(1);

    const next = post(harness.baseUrl, "/agent-runs/run-1/actions/approve", AS_ACME);
    // A leaked slot would answer the next request 429 instead of running it.
    const outcome = await Promise.race([
      harness.nextArrival().then((run) => ({ run })),
      next.then((response) => ({ response })),
    ]);

    assert.ok(outcome.run, `the next request was answered ${outcome.response?.status}`);

    const nextRun = outcome.run;

    assert.equal(
      nextRun.path,
      "/agent-runs/run-1/actions/approve",
      "the abandoned request never reached the route"
    );
    assert.equal(
      harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:acme"),
      1,
      "only the second request holds a slot"
    );

    nextRun.finish("ok");
    assert.equal((await next).status, 200);
    await nextRun.closed;
    assert.equal(harness.tenantLimits.concurrencyLimiter.getInFlight("workspace:acme"), 0);
  } finally {
    await harness.close();
  }
});

test("rate-limited requests answer 429 with Retry-After and leave other tenants alone", async () => {
  const nowMs = 60_000 * 9 + 50_500;
  const harness = await createHarness({
    maxConcurrent: 0,
    rateLimiter: createTenantRateLimiter({
      enabled: true,
      limits: { chat: 1, default: 2, destructive: 1, ingest: 1 },
      now: () => nowMs,
      redis: null,
      windowMs: 60_000,
    }),
  });

  try {
    assert.equal((await fetch(`${harness.baseUrl}/documents`, { headers: AS_ACME })).status, 200);
    assert.equal((await fetch(`${harness.baseUrl}/documents`, { headers: AS_ACME })).status, 200);

    const refused = await fetch(`${harness.baseUrl}/documents`, { headers: AS_ACME });

    assert.equal(refused.status, 429);
    // 9.5 s left in the window, rounded up.
    assert.equal(refused.headers.get("retry-after"), "10");
    assert.deepEqual(await refused.json(), {
      code: TENANT_RATE_LIMITED_CODE,
      error: "Too many requests for this tenant. Please retry later.",
      limitClass: "default",
      retryable: true,
      retryAfterSeconds: 10,
    });

    assert.equal((await fetch(`${harness.baseUrl}/documents`, { headers: AS_GLOBEX })).status, 200);

    // A user without a workspace is its own tenant.
    assert.equal(
      (await fetch(`${harness.baseUrl}/documents`, { headers: { "x-user-id": "carol" } })).status,
      200
    );

    // The chat class has its own budget.
    const chat = post(harness.baseUrl, "/chat", AS_ACME);
    const run = await harness.nextArrival();

    run.finish("ok");
    assert.equal((await chat).status, 200);
    assert.equal((await post(harness.baseUrl, "/chat", AS_ACME)).status, 429);
  } finally {
    await harness.close();
  }
});

test("the database tenant is still bound in the route after a Redis admission", async () => {
  const redis = {
    eval: (script, numberOfKeys, key) =>
      new Promise((resolve) => setImmediate(() => resolve(1))),
  };
  const tenantLimits = createTenantLimits({
    concurrencyLimiter: createTenantConcurrencyLimiter({ maxConcurrent: 1 }),
    rateLimiter: createTenantRateLimiter({
      enabled: true,
      limits: { chat: 5, default: 5, destructive: 5, ingest: 5 },
      redis,
    }),
  });
  const app = express();

  app.use(express.json());
  app.use(scopeFromHeaders);
  // What bindDatabaseTenant does.
  app.use((req, res, next) => runWithDatabaseTenant(req.accessScope, next));
  app.use(tenantLimits.middleware);
  app.post("/chat", (req, res) => res.json({ tenant: getActiveDatabaseTenant() }));

  const server = await startServer(app);

  try {
    const response = await post(server.baseUrl, "/chat", AS_ACME);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tenant: { userId: "alice", workspaceId: "acme" },
    });
  } finally {
    await server.close();
  }
});

const withTrustProxy = (value, run) => {
  const saved = process.env.TRUST_PROXY;

  try {
    if (value === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = value;
    }

    return run();
  } finally {
    if (saved === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = saved;
    }
  }
};

test("TRUST_PROXY accepts true/false, a hop count, or a list of addresses and ranges", () => {
  const cases = [
    [undefined, undefined],
    ["", undefined],
    ["  ", undefined],
    ["true", true],
    [" TRUE ", true],
    ["false", false],
    ["0", 0],
    ["2", 2],
    ["loopback", ["loopback"]],
    [
      "loopback, 10.0.0.0/8 ,192.168.1.10,fd00::/8,::1,172.16.0.0/255.240.0.0,LinkLocal,uniquelocal",
      [
        "loopback",
        "10.0.0.0/8",
        "192.168.1.10",
        "fd00::/8",
        "::1",
        "172.16.0.0/255.240.0.0",
        // Express knows the preset names in lower case only.
        "linklocal",
        "uniquelocal",
      ],
    ],
  ];

  for (const [value, expected] of cases) {
    const setting = withTrustProxy(value, () => getTrustProxySetting());

    assert.deepEqual(setting, expected, JSON.stringify(value));

    if (setting !== undefined) {
      // Express compiles it at once and throws on what it cannot use.
      const app = express();

      app.set("trust proxy", setting);
      assert.equal(typeof app.get("trust proxy fn"), "function");
    }
  }
});

test("an invalid TRUST_PROXY throws TRUST_PROXY_INVALID", () => {
  for (const value of [
    "yes",
    "-1",
    "1.5",
    "proxy.example.com",
    "10.0.0.0/33",
    "fd00::/129",
    "10.0.0.0/",
    "fd00::/255.255.0.0",
    // Express refuses a netmask that is not contiguous.
    "10.0.0.0/255.0.255.0",
    "loopback,,10.0.0.1",
    "256.1.1.1",
  ]) {
    assert.throws(
      () => withTrustProxy(value, () => getTrustProxySetting()),
      (error) => error.code === "TRUST_PROXY_INVALID",
      value
    );
  }
});

test("with a trusted hop, req.ip and the IP tenant key are the forwarded client", async () => {
  const app = express();
  const trusted = withTrustProxy("1", () => getTrustProxySetting());

  app.set("trust proxy", trusted);
  app.get("/whoami", (req, res) => {
    req.accessScope = {};
    res.json({ ip: req.ip, key: resolveTenantLimitKey(req) });
  });

  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/whoami`, {
      headers: { "X-Forwarded-For": "203.0.113.7, 198.51.100.2" },
    });

    // One hop trusted: the address that proxy saw, not the client's own claim.
    assert.deepEqual(await response.json(), {
      ip: "198.51.100.2",
      key: "ip:198.51.100.2",
    });
  } finally {
    await server.close();
  }
});
