// Per-tenant refusal accounting (rag/tenant-refusals.js): every refusal a
// per-tenant limit, quota or registry check makes is counted once in
// archive_rag_tenant_refusals_total{reason} (never with a tenant label) and
// once in the usage ledger under the tenant it was decided for. Each site is
// driven through its own module with the process-wide ledger replaced by a
// recorder; the model gateway's site is covered in model-gateway.test.mjs.
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

import { bindDatabaseTenant, requireApiAuth } from "../auth.js";
import { createAgentTaskService } from "../rag/agent-tasks.js";
import {
  createInMemoryIngestJobStore,
  INGEST_PENDING_LIMIT_EXCEEDED,
  INGEST_WORKSPACE_PENDING_LIMIT_EXCEEDED,
} from "../rag/ingest-job-store.js";
import { TENANT_TASK_LIMITED } from "../rag/job-orchestrator.js";
import { getMetricsRegistry, setMetricsEnabled } from "../rag/metrics.js";
import "../rag/metrics-tenant.js";
import { recordTenantRefusalMetric } from "../rag/metrics-tenant.js";
import {
  admitModelCallQuota,
  configureInProcessModelQuotas,
  resetInProcessModelQuotas,
} from "../rag/model-call-quota.js";
import {
  guardModelCall,
  MODEL_CALL_QUEUE_FULL_CODE,
  resetModelCallGuards,
} from "../rag/model-call-guard.js";
import { MODEL_GATEWAY_ERROR_CODES } from "../rag/model-gateway/protocol.js";
import { createWorkspaceModelQuotas } from "../rag/model-quotas.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { createInMemoryTaskStore, createTaskService } from "../rag/tasks.js";
import {
  createTenantConcurrencyLimiter,
  createTenantLimits,
  createTenantRateLimiter,
  TENANT_CONCURRENCY_LIMITED_CODE,
  TENANT_RATE_LIMITED_CODE,
} from "../rag/tenant-limits.js";
import {
  TENANT_REFUSAL_LEDGER_METRICS,
  TENANT_REFUSAL_REASON_LIST,
  TENANT_REFUSAL_REASONS,
  toTenantRefusalLedgerMetric,
} from "../rag/tenant-refusal-reasons.js";
import { recordTenantRefusal } from "../rag/tenant-refusals.js";
import {
  createInMemoryTenantRegistryStore,
  createTenantRegistryService,
  resolveMembershipRefusalTenant,
  TENANT_MEMBERSHIP_CODES,
} from "../rag/tenant-registry.js";
import {
  assertTenantStorageQuota,
  TENANT_STORAGE_QUOTA_EXCEEDED,
} from "../rag/tenant-storage-quota.js";
import { configureTenantUsageLedger } from "../rag/tenant-usage.js";
import {
  configureUploadSessionDirectory,
  initializeUploadSession,
  UPLOAD_SESSION_LIMIT_EXCEEDED,
} from "../upload-session-store.js";

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const FAMILY = "archive_rag_tenant_refusals_total";

const withEnv = async (values, run) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// The process-wide ledger, replaced by one that records what reached it.
let refusals = [];

const recordingLedger = {
  record: () => false,
  recordRefusal: (tenant, reason) => {
    refusals.push({ reason, tenant });
    return true;
  },
};

const counted = () => {
  const family = getMetricsRegistry().getFamily(FAMILY);
  const values = {};

  for (const entry of family.series.values()) {
    values[entry.labelValues[0]] = entry.value;
  }

  return values;
};

before(() => setMetricsEnabled(true));
after(() => {
  setMetricsEnabled(null);
  configureTenantUsageLedger(null);
});

beforeEach(() => {
  refusals = [];
  configureTenantUsageLedger(recordingLedger);
  getMetricsRegistry().getFamily(FAMILY).clear();
});

afterEach(() => configureTenantUsageLedger(null));

test("every reason code is the constant its refusal already answers with", () => {
  assert.deepEqual(
    [...TENANT_REFUSAL_REASON_LIST],
    [
      INGEST_PENDING_LIMIT_EXCEEDED,
      INGEST_WORKSPACE_PENDING_LIMIT_EXCEEDED,
      MODEL_CALL_QUEUE_FULL_CODE,
      MODEL_GATEWAY_ERROR_CODES.quotaExceeded,
      TENANT_CONCURRENCY_LIMITED_CODE,
      TENANT_RATE_LIMITED_CODE,
      TENANT_MEMBERSHIP_CODES.registryUnavailable,
      TENANT_STORAGE_QUOTA_EXCEEDED,
      TENANT_TASK_LIMITED,
      UPLOAD_SESSION_LIMIT_EXCEEDED,
      TENANT_MEMBERSHIP_CODES.workspaceDeleting,
      TENANT_MEMBERSHIP_CODES.membershipRequired,
      TENANT_MEMBERSHIP_CODES.notRegistered,
      TENANT_MEMBERSHIP_CODES.rolesLimitExceeded,
      TENANT_MEMBERSHIP_CODES.workspaceSuspended,
    ].sort()
  );
  // Every membership refusal code is counted.
  for (const code of Object.values(TENANT_MEMBERSHIP_CODES)) {
    assert.ok(TENANT_REFUSAL_REASON_LIST.includes(code), code);
  }

  // The ledger keeps each as a metric its check constraint admits.
  for (const metric of TENANT_REFUSAL_LEDGER_METRICS) {
    assert.match(metric, /^refused_[a-z][a-z0-9_]{0,55}$/u);
  }

  assert.equal(toTenantRefusalLedgerMetric(TENANT_REFUSAL_REASONS.rateLimited), "refused_tenant_rate_limited");
  assert.equal(toTenantRefusalLedgerMetric("NOT_A_REASON"), null);
});

test("the metric has only a reason label; unknown codes count as other; off records nothing", () => {
  const family = getMetricsRegistry().getFamily(FAMILY);

  assert.deepEqual([...family.labelNames], ["reason"]);

  recordTenantRefusal(TENANT_RATE_LIMITED_CODE, ALICE);
  recordTenantRefusal(TENANT_RATE_LIMITED_CODE, { userId: "bob" });
  recordTenantRefusalMetric("tenant-alice");
  assert.deepEqual(counted(), { other: 1, [TENANT_RATE_LIMITED_CODE]: 2 });
  // The ledger got the tenants (an unknown code never reaches it from the hook's callers).
  assert.deepEqual(refusals, [
    { reason: TENANT_RATE_LIMITED_CODE, tenant: ALICE },
    { reason: TENANT_RATE_LIMITED_CODE, tenant: { userId: "bob", workspaceId: "" } },
  ]);

  setMetricsEnabled(false);

  try {
    recordTenantRefusal(TENANT_TASK_LIMITED, ALICE);
    assert.equal(counted()[TENANT_TASK_LIMITED], undefined);
    // The ledger part does not depend on METRICS_ENABLED.
    assert.equal(refusals.at(-1).reason, TENANT_TASK_LIMITED);
  } finally {
    setMetricsEnabled(true);
  }
});

test("the hook reads the scope like the database tenant binding and never throws", () => {
  recordTenantRefusal(TENANT_RATE_LIMITED_CODE, { authenticated: true, userId: " carol ", workspaceId: "" });
  recordTenantRefusal(TENANT_RATE_LIMITED_CODE, {});
  recordTenantRefusal(TENANT_RATE_LIMITED_CODE, null);

  assert.deepEqual(
    refusals.map((entry) => entry.tenant),
    [{ userId: "carol", workspaceId: "" }, null, null]
  );

  configureTenantUsageLedger({
    recordRefusal: () => {
      throw new Error("ledger down");
    },
  });
  assert.doesNotThrow(() => recordTenantRefusal(TENANT_RATE_LIMITED_CODE, ALICE));
  assert.equal(counted()[TENANT_RATE_LIMITED_CODE], 4);
});

// --- the sites -------------------------------------------------------------

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

test("tenant limits: a rate-limited and a concurrency-limited request are counted for the request's tenant", async () => {
  const limits = createTenantLimits({
    concurrencyLimiter: createTenantConcurrencyLimiter({ maxConcurrent: 1 }),
    rateLimiter: createTenantRateLimiter({
      enabled: true,
      limits: { chat: 0, default: 1, destructive: 0, ingest: 0 },
      redis: null,
      windowMs: 60_000,
    }),
  });
  const app = express();
  let releaseChat;
  const chatHeld = new Promise((resolve) => {
    releaseChat = resolve;
  });

  app.use((req, _res, next) => {
    req.accessScope = { authenticated: true, ...ALICE };
    next();
  });
  app.use(limits.middleware);
  app.get("/documents", (_req, res) => res.json({ ok: true }));
  app.post("/chat", async (_req, res) => {
    await chatHeld;
    res.json({ ok: true });
  });

  const server = await startServer(app);

  try {
    assert.equal((await fetch(`${server.baseUrl}/documents`)).status, 200);
    const limited = await fetch(`${server.baseUrl}/documents`);

    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, TENANT_RATE_LIMITED_CODE);

    const first = fetch(`${server.baseUrl}/chat`, { method: "POST" });

    // The first chat holds the tenant's one slot until released.
    for (let attempt = 0; attempt < 100 && limits.concurrencyLimiter.getInFlight("workspace:ws-a") === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const second = await fetch(`${server.baseUrl}/chat`, { method: "POST" });

    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, TENANT_CONCURRENCY_LIMITED_CODE);
    releaseChat();
    assert.equal((await first).status, 200);
  } finally {
    await server.close();
  }

  assert.deepEqual(refusals, [
    { reason: TENANT_RATE_LIMITED_CODE, tenant: ALICE },
    { reason: TENANT_CONCURRENCY_LIMITED_CODE, tenant: ALICE },
  ]);
  assert.deepEqual(counted(), { [TENANT_CONCURRENCY_LIMITED_CODE]: 1, [TENANT_RATE_LIMITED_CODE]: 1 });
});

// Only a member's refusal for a registered workspace that is not deleting is
// counted under the workspace. A workspace id the registry does not hold
// (made up, or erased), a registered workspace the user does not belong to,
// one being deleted and an undecided one are counted for the user alone.
// Before, every made-up x-workspace-id became ledger rows of its own, a
// non-member's user id showed in the named workspace's usage view and export,
// and the hardened demo's erase test saw an erased workspace's id come back
// into the ledger with a former member's first refused request
// (test/tenant-isolation-hardened.e2e.test.mjs).
test("membership: every refusal of TENANT_MEMBERSHIP=enforce is counted; only a member's keeps the workspace it asked for", async () => {
  const store = createInMemoryTenantRegistryStore();
  const registry = createTenantRegistryService({ cacheTtlMs: 0, store });
  const broken = createTenantRegistryService({
    cacheTtlMs: 0,
    store: {
      ...createInMemoryTenantRegistryStore(),
      getMember: async () => {
        throw new Error("registry down");
      },
      getWorkspace: async () => {
        throw new Error("registry down");
      },
    },
  });

  await registry.createWorkspace({ workspaceId: "ws-a" });
  await registry.createWorkspace({ status: "suspended", workspaceId: "ws-s" });
  await registry.createWorkspace({ workspaceId: "ws-c" });
  await registry.createWorkspace({ workspaceId: "ws-d" });
  await registry.putMember({ roles: [], userId: "alice", workspaceId: "ws-a" });
  await registry.putMember({ roles: [], userId: "alice", workspaceId: "ws-s" });
  await registry.putMember({ roles: [], userId: "alice", workspaceId: "ws-d" });
  await registry.setWorkspaceStatus("ws-d", "deleting");

  const tokens = { "alice-token": { userId: "alice" } };
  const call = async (activeRegistry, workspaceId) => {
    const app = express();

    app.locals.tenantRegistry = activeRegistry;
    app.use(requireApiAuth);
    app.use(bindDatabaseTenant);
    app.get("/documents", (_req, res) => res.json({ ok: true }));

    const server = await startServer(app);

    try {
      const response = await fetch(`${server.baseUrl}/documents`, {
        headers: { "x-api-key": "alice-token", "x-workspace-id": workspaceId },
      });

      return { body: await response.json(), status: response.status };
    } finally {
      await server.close();
    }
  };

  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: JSON.stringify(tokens),
      RBAC_MODE: undefined,
      TENANT_MEMBERSHIP: "enforce",
    },
    async () => {
      assert.equal((await call(registry, "ws-a")).status, 200);
      // Not registered, then registered but not hers: the same answer, and
      // neither is counted under the workspace.
      assert.equal((await call(registry, "ws-b")).body.code, TENANT_MEMBERSHIP_CODES.membershipRequired);
      assert.equal((await call(registry, "ws-c")).body.code, TENANT_MEMBERSHIP_CODES.membershipRequired);
      assert.equal((await call(registry, "ws-s")).body.code, TENANT_MEMBERSHIP_CODES.workspaceSuspended);
      assert.equal((await call(registry, "ws-d")).body.code, TENANT_MEMBERSHIP_CODES.workspaceDeleting);

      const consoleError = console.error;

      console.error = () => {};

      const unavailable = await call(broken, "ws-a").finally(() => {
        console.error = consoleError;
      });

      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.code, TENANT_MEMBERSHIP_CODES.registryUnavailable);
    }
  );

  // A non-member's refusal, one for a deleting workspace and one the registry
  // could not decide go to the user's own user-level tenant. Her refusal for
  // a suspended workspace she is a member of keeps the pair.
  assert.deepEqual(refusals, [
    { reason: TENANT_MEMBERSHIP_CODES.membershipRequired, tenant: { userId: "alice", workspaceId: "" } },
    { reason: TENANT_MEMBERSHIP_CODES.membershipRequired, tenant: { userId: "alice", workspaceId: "" } },
    { reason: TENANT_MEMBERSHIP_CODES.workspaceSuspended, tenant: { userId: "alice", workspaceId: "ws-s" } },
    { reason: TENANT_MEMBERSHIP_CODES.workspaceDeleting, tenant: { userId: "alice", workspaceId: "" } },
    { reason: TENANT_MEMBERSHIP_CODES.registryUnavailable, tenant: { userId: "alice", workspaceId: "" } },
  ]);
});

test("membership: probing workspace ids makes no ledger row per id, and without a user none at all", async () => {
  const registry = createTenantRegistryService({ cacheTtlMs: 0, store: createInMemoryTenantRegistryStore() });

  await registry.createWorkspace({ workspaceId: "alpha" });
  await registry.putMember({ roles: [], userId: "alice", workspaceId: "alpha" });

  const tokens = {
    "bob-token": { userId: "bob" },
    "header-token": { roles: ["workspace.member"] },
  };
  const app = express();

  app.locals.tenantRegistry = registry;
  app.use(requireApiAuth);
  app.get("/documents", (_req, res) => res.json({ ok: true }));

  const server = await startServer(app);

  try {
    await withEnv(
      {
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKEN: undefined,
        API_AUTH_TOKENS: JSON.stringify(tokens),
        RBAC_MODE: undefined,
        TENANT_MEMBERSHIP: "enforce",
      },
      async () => {
        const probe = async (token, workspaceId) => {
          const response = await fetch(`${server.baseUrl}/documents`, {
            headers: { "x-api-key": token, "x-workspace-id": workspaceId },
          });

          return (await response.json()).code;
        };

        // bob is no member of alpha, nor of any probed id: every refusal is
        // charged to bob outside any workspace, never to alpha, so alpha's
        // usage view, export and erase never see bob.
        assert.equal(await probe("bob-token", "alpha"), TENANT_MEMBERSHIP_CODES.membershipRequired);

        for (let index = 0; index < 20; index += 1) {
          assert.equal(await probe("bob-token", `probe-${index}`), TENANT_MEMBERSHIP_CODES.membershipRequired);
        }

        // A credential without a user naming a workspace by header.
        for (let index = 0; index < 5; index += 1) {
          assert.equal(await probe("header-token", `probe-${index}`), TENANT_MEMBERSHIP_CODES.membershipRequired);
        }
      }
    );
  } finally {
    await server.close();
  }

  assert.equal(refusals.length, 21);
  assert.deepEqual(
    [...new Set(refusals.map((entry) => JSON.stringify(entry.tenant)))],
    [JSON.stringify({ userId: "bob", workspaceId: "" })]
  );
  assert.deepEqual(counted(), { [TENANT_MEMBERSHIP_CODES.membershipRequired]: 26 });
});

test("membership: the ledger tenant follows the order of the checks", () => {
  const scope = { authenticated: true, userId: "alice", workspaceId: "ws-a" };
  const headerScope = { authenticated: true, userId: "", workspaceId: "ws-a" };
  const refusal = (code) => ({ allowed: false, code });

  for (const code of [TENANT_MEMBERSHIP_CODES.workspaceSuspended, TENANT_MEMBERSHIP_CODES.rolesLimitExceeded]) {
    assert.deepEqual(resolveMembershipRefusalTenant(scope, refusal(code)), ALICE, code);
    assert.deepEqual(
      resolveMembershipRefusalTenant(headerScope, refusal(code)),
      { userId: "", workspaceId: "ws-a" },
      `${code} for the credential's own workspace`
    );
  }

  // A deleting workspace is the erase's: no new row under it.
  for (const code of [
    TENANT_MEMBERSHIP_CODES.membershipRequired,
    TENANT_MEMBERSHIP_CODES.notRegistered,
    TENANT_MEMBERSHIP_CODES.registryUnavailable,
    TENANT_MEMBERSHIP_CODES.workspaceDeleting,
  ]) {
    assert.deepEqual(resolveMembershipRefusalTenant(scope, refusal(code)), { userId: "alice", workspaceId: "" }, code);
    assert.equal(resolveMembershipRefusalTenant(headerScope, refusal(code)), null, code);
  }

  // metricOnly counts the refusal and leaves the ledger alone.
  recordTenantRefusal(TENANT_MEMBERSHIP_CODES.membershipRequired, null, { metricOnly: true });
  assert.deepEqual(refusals, []);
  assert.equal(counted()[TENANT_MEMBERSHIP_CODES.membershipRequired], 1);
});

test("storage quota: a refused check is counted for the document's owner pair", async () => {
  await assert.rejects(
    assertTenantStorageQuota({
      addedDocuments: 1,
      limits: { maxDocumentBytes: 0, maxDocuments: 1 },
      ownerUserId: "alice",
      readTotals: async () => ({ documentBytes: 0, documentCount: 1 }),
      workspaceId: "ws-a",
    }),
    (error) => error.code === TENANT_STORAGE_QUOTA_EXCEEDED
  );
  // Under the quota nothing is counted.
  await assertTenantStorageQuota({
    addedDocuments: 1,
    limits: { maxDocumentBytes: 0, maxDocuments: 2 },
    ownerUserId: "alice",
    readTotals: async () => ({ documentBytes: 0, documentCount: 1 }),
    workspaceId: "ws-a",
  });

  assert.deepEqual(refusals, [{ reason: TENANT_STORAGE_QUOTA_EXCEEDED, tenant: ALICE }]);
});

test("in-process model quota: a refused admission is counted for the tenant it acted for", async () => {
  configureInProcessModelQuotas({
    quotas: createWorkspaceModelQuotas({ limits: { requestsPerMinute: 1 }, redis: null }),
  });

  try {
    await withEnv({ MODEL_GATEWAY_URL: undefined, MODEL_QUOTA_ENABLED: "true" }, async () => {
      await admitModelCallQuota(ALICE);
      await assert.rejects(
        admitModelCallQuota(ALICE),
        (error) => error.code === MODEL_GATEWAY_ERROR_CODES.quotaExceeded && error.status === 429
      );
      // A call without a tenant is never limited, so never counted.
      assert.equal(admitModelCallQuota(null), null);
    });
  } finally {
    resetInProcessModelQuotas();
  }

  assert.deepEqual(refusals, [{ reason: MODEL_GATEWAY_ERROR_CODES.quotaExceeded, tenant: ALICE }]);
});

test("model-call guard: a full tenant queue is counted for that tenant, once per refused attempt", async () => {
  await withEnv(
    { RAG_LLM_MAX_CONCURRENCY: "1", RAG_LLM_MAX_QUEUE: "1", RAG_SHARED_STATE: undefined },
    async () => {
      resetModelCallGuards();

      try {
        const key = "http://model.test/v1|queue-model";
        let releaseFirst;
        const first = runWithDatabaseTenant(ALICE, () =>
          guardModelCall(key, () => new Promise((resolve) => (releaseFirst = resolve)))
        );

        while (!releaseFirst) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        const queued = runWithDatabaseTenant(ALICE, () => guardModelCall(key, async () => "second"));

        await assert.rejects(
          runWithDatabaseTenant(ALICE, () => guardModelCall(key, async () => "third")),
          (error) => error.code === MODEL_CALL_QUEUE_FULL_CODE && error.status === 429
        );
        releaseFirst("first");
        assert.equal(await first, "first");
        assert.equal(await queued, "second");
      } finally {
        resetModelCallGuards();
      }
    }
  );

  assert.deepEqual(refusals, [{ reason: MODEL_CALL_QUEUE_FULL_CODE, tenant: ALICE }]);
});

test("task cap: a refused task creation is counted for its tenant", async () => {
  const service = createAgentTaskService({
    jobOrchestrator: null,
    taskLimits: () => ({ maxQueued: 1, maxRunning: 0 }),
    taskService: createTaskService({ taskStore: createInMemoryTaskStore() }),
  });

  await service.createTask({ accessScope: ALICE, question: "Summarize the renewal terms." });
  await assert.rejects(
    service.createTask({ accessScope: ALICE, question: "Summarize the payment terms." }),
    (error) => error.code === TENANT_TASK_LIMITED
  );

  assert.deepEqual(refusals, [{ reason: TENANT_TASK_LIMITED, tenant: ALICE }]);
});

test("upload sessions: a refused session is counted for its tenant", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-refusals-uploads-"));

  configureUploadSessionDirectory(path.join(tempRoot, "sessions"));

  try {
    await withEnv({ UPLOAD_SESSION_MAX_BYTES_PER_TENANT: undefined, UPLOAD_SESSION_MAX_PER_TENANT: "1" }, async () => {
      const metadata = (fileId) => ({
        chunkSize: 6,
        fileId,
        fileName: `${fileId}.pdf`,
        fileSize: 10,
        lastModified: 1,
        totalChunks: 2,
      });

      await initializeUploadSession({ accessScope: ALICE, ...metadata("one") });
      await assert.rejects(
        initializeUploadSession({ accessScope: ALICE, ...metadata("two") }),
        (error) => error.code === UPLOAD_SESSION_LIMIT_EXCEEDED
      );
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }

  assert.deepEqual(refusals, [{ reason: UPLOAD_SESSION_LIMIT_EXCEEDED, tenant: ALICE }]);
});

test("ingest queue: both pending caps are counted for the job's owner pair and carry their code", async () => {
  const store = createInMemoryIngestJobStore({
    getPendingLimits: () => ({ maxPendingBytes: 0, maxPendingJobs: 1, maxPendingJobsPerWorkspace: 2 }),
  });
  let counter = 0;
  const enqueue = (ownerUserId, workspaceId) => {
    counter += 1;

    return store.enqueue({
      docId: `doc-${counter}`,
      fileBytes: Buffer.from("%PDF-1.4 refusals"),
      fileName: "a.pdf",
      ownerUserId,
      workspaceId,
    });
  };

  await enqueue("alice", "ws-a");
  await assert.rejects(enqueue("alice", "ws-a"), (error) => error.code === INGEST_PENDING_LIMIT_EXCEEDED);
  await enqueue("bob", "ws-a");
  await assert.rejects(enqueue("carol", "ws-a"), (error) => error.code === INGEST_WORKSPACE_PENDING_LIMIT_EXCEEDED);

  assert.deepEqual(refusals, [
    { reason: INGEST_PENDING_LIMIT_EXCEEDED, tenant: ALICE },
    { reason: INGEST_WORKSPACE_PENDING_LIMIT_EXCEEDED, tenant: { userId: "carol", workspaceId: "ws-a" } },
  ]);
  assert.deepEqual(counted(), { [INGEST_PENDING_LIMIT_EXCEEDED]: 1, [INGEST_WORKSPACE_PENDING_LIMIT_EXCEEDED]: 1 });
});
