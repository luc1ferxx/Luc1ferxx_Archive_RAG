// The per-tenant limits and TRUST_PROXY as createApp wires them: nothing is
// mounted by default, the limits count after API auth (an unauthenticated
// request is answered 401 and never counted), one tenant's limit never
// touches another's, and a concurrency slot of a real agent-run action route
// is released on success, on error and when the client leaves.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../app.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { getRequestSignal } from "../rag/request-deadline.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import {
  TENANT_CONCURRENCY_LIMITED_CODE,
  TENANT_RATE_LIMITED_CODE,
} from "../rag/tenant-limits.js";

const ENV_KEYS = [
  "AGENT_CANCEL_ON_DISCONNECT",
  "AGENT_REQUEST_TIMEOUT_MS",
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "RAG_SHARED_STATE",
  "RATE_LIMIT_ENABLED",
  "RBAC_MODE",
  "TENANT_MAX_CONCURRENT_RUNS",
  "TENANT_RATE_LIMIT_CHAT_MAX",
  "TENANT_RATE_LIMIT_DEFAULT_MAX",
  "TENANT_RATE_LIMIT_DESTRUCTIVE_MAX",
  "TENANT_RATE_LIMIT_ENABLED",
  "TENANT_RATE_LIMIT_INGEST_MAX",
  "TENANT_RATE_LIMIT_WINDOW_MS",
  "TRUST_PROXY",
];

const withEnv = async (values, run) => {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of ENV_KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }

    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const TOKENS = {
  "acme-token": { userId: "alice", workspaceId: "acme" },
  "globex-token": { userId: "bob", workspaceId: "globex" },
};

const authEnv = (extra = {}) => ({
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify(TOKENS),
  ...extra,
});

// A window no test run crosses, so no count restarts mid-test.
const NEVER_ENDING_WINDOW_MS = String(10 ** 12);

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const createTestApp = (tempRoot, options = {}) =>
  createApp({
    agentRunStore: createInMemoryAgentRunStore(),
    healthService: okHealthService,
    ragService: {
      deleteDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeLongMemory: async () => true,
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
    },
    taskStore: createInMemoryTaskStore(),
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    ...options,
  });

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await app.locals.stop?.();
    },
    port,
  };
};

const withApp = async (env, options, run) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-limits-app-"));

  try {
    await withEnv(env, async () => {
      const app = await createTestApp(tempRoot, options);
      const server = await startServer(app);

      try {
        await run({ app, server });
      } finally {
        await server.close();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

const get = (server, route, token) =>
  fetch(`${server.baseUrl}${route}`, { headers: token ? { "x-api-key": token } : {} });

const approve = (server, token, runId = "run-1") =>
  fetch(`${server.baseUrl}/agent-runs/${runId}/actions/approve`, {
    body: "{}",
    headers: { "Content-Type": "application/json", "x-api-key": token },
    method: "POST",
  });

test("by default nothing is mounted and Express trusts no proxy", async () => {
  await withApp(authEnv(), {}, async ({ app, server }) => {
    assert.equal(app.locals.tenantLimits, undefined);
    assert.equal(app.get("trust proxy"), false);

    for (let index = 0; index < 30; index += 1) {
      assert.equal((await get(server, "/documents", "acme-token")).status, 200);
    }
  });
});

test("TRUST_PROXY reaches Express, and an invalid value refuses the start", async () => {
  await withApp(authEnv({ TRUST_PROXY: "1" }), {}, async ({ app }) => {
    assert.equal(app.get("trust proxy"), 1);
  });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-limits-app-"));

  try {
    await withEnv(authEnv({ TRUST_PROXY: "proxy.internal" }), async () => {
      await assert.rejects(createTestApp(tempRoot), (error) => error.code === "TRUST_PROXY_INVALID");
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("the rate limit counts per tenant after auth, and answers 429 TENANT_RATE_LIMITED", async () => {
  await withApp(
    authEnv({
      TENANT_RATE_LIMIT_DEFAULT_MAX: "2",
      TENANT_RATE_LIMIT_ENABLED: "true",
      TENANT_RATE_LIMIT_WINDOW_MS: NEVER_ENDING_WINDOW_MS,
    }),
    {},
    async ({ app, server }) => {
      assert.equal(app.locals.tenantLimits.enabled, true);

      // Unauthenticated requests are refused before the limiter counts them.
      for (let index = 0; index < 3; index += 1) {
        assert.equal((await get(server, "/documents")).status, 401);
      }

      assert.equal((await get(server, "/documents", "acme-token")).status, 200);
      assert.equal((await get(server, "/documents", "acme-token")).status, 200);

      const refused = await get(server, "/documents", "acme-token");

      assert.equal(refused.status, 429);
      assert.ok(Number(refused.headers.get("retry-after")) > 0);
      // Mounted after noStoreTenantData: the refusal is not cacheable either.
      assert.equal(refused.headers.get("cache-control"), "private, no-store");

      const body = await refused.json();

      assert.equal(body.code, TENANT_RATE_LIMITED_CODE);
      assert.equal(body.limitClass, "default");
      assert.doesNotMatch(JSON.stringify(body), /acme|alice/u, "the answer names no tenant");

      // The other tenant keeps its whole budget.
      assert.equal((await get(server, "/documents", "globex-token")).status, 200);
      assert.equal((await get(server, "/documents", "globex-token")).status, 200);
      assert.equal((await get(server, "/documents", "globex-token")).status, 429);

      // The probes are mounted before auth and the limiter.
      assert.equal((await get(server, "/livez", "acme-token")).status, 200);
    }
  );
});

test("TENANT_MAX_CONCURRENT_RUNS caps a tenant's agent-run actions and frees the slot", async () => {
  const pending = [];
  const waiters = [];

  const nextCall = () => {
    if (pending.length > 0) {
      return Promise.resolve(pending.shift());
    }

    const deferred = createDeferred();

    waiters.push(deferred);
    return deferred.promise;
  };

  const agentRunStepExecutor = {
    applyApprovalAction: async ({ accessScope, runId }) => {
      const outcome = createDeferred();
      const signal = getRequestSignal();
      const call = { accessScope, finish: outcome.resolve, runId, signal };
      const waiter = waiters.shift();

      if (waiter) waiter.resolve(call);
      else pending.push(call);

      const result = await outcome.promise;

      if (result === "fail") {
        const error = new Error("approval failed");
        error.status = 409;
        throw error;
      }

      return { ok: true, runId };
    },
  };

  await withApp(
    authEnv({ AGENT_CANCEL_ON_DISCONNECT: "on", TENANT_MAX_CONCURRENT_RUNS: "1" }),
    { agentRunStepExecutor },
    async ({ app, server }) => {
      const { concurrencyLimiter } = app.locals.tenantLimits;

      // The rate limit is off: only the concurrency cap is mounted.
      assert.equal(app.locals.tenantLimits.rateLimiter.enabled, false);

      const first = approve(server, "acme-token", "run-1");
      const firstCall = await nextCall();

      assert.equal(firstCall.accessScope.workspaceId, "acme");

      const refused = await approve(server, "acme-token", "run-2");

      assert.equal(refused.status, 429);
      assert.equal(refused.headers.get("retry-after"), "5");
      assert.equal((await refused.json()).code, TENANT_CONCURRENCY_LIMITED_CODE);

      // Another tenant runs meanwhile, and reads are never capped.
      const other = approve(server, "globex-token", "run-3");
      const otherCall = await nextCall();

      assert.equal(otherCall.accessScope.workspaceId, "globex");
      assert.equal((await get(server, "/documents", "acme-token")).status, 200);

      firstCall.finish("ok");
      otherCall.finish("ok");
      assert.equal((await first).status, 200);
      assert.equal((await other).status, 200);
      assert.equal(concurrencyLimiter.getInFlight("workspace:acme"), 0);
      assert.equal(concurrencyLimiter.getInFlight("workspace:globex"), 0);

      // An error answer frees the slot.
      const failing = approve(server, "acme-token", "run-4");
      const failingCall = await nextCall();

      failingCall.finish("fail");
      assert.equal((await failing).status, 409);
      assert.equal(concurrencyLimiter.getInFlight("workspace:acme"), 0);

      // So does a client that leaves: the route's own disconnect cancellation
      // fires on the same close, after the limiter's listener.
      const abandoned = httpRequest({
        headers: { "Content-Type": "application/json", "x-api-key": "acme-token" },
        host: "127.0.0.1",
        method: "POST",
        path: "/agent-runs/run-5/actions/approve",
        port: server.port,
      });

      abandoned.on("error", () => {});
      abandoned.end("{}");

      const abandonedCall = await nextCall();
      const cancelled = createDeferred();

      abandonedCall.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      assert.equal(concurrencyLimiter.getInFlight("workspace:acme"), 1);
      abandoned.destroy();
      await cancelled.promise;
      assert.equal(concurrencyLimiter.getInFlight("workspace:acme"), 0);

      const after = approve(server, "acme-token", "run-6");
      const afterCall = await nextCall();

      afterCall.finish("ok");
      assert.equal((await after).status, 200);
      abandonedCall.finish("ok");
    }
  );
});
