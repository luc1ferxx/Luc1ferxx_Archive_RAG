// Tenant isolation over the whole HTTP surface.
//
// Part A, the gate (auth.js requireApiAuth -> requireTenantScope). An
// authenticated scope that names neither a user nor a workspace reads as
// "every tenant" in the document registry, the feedback store, the ingest job
// store and the database tenant binding (an empty scope bypasses both the
// store filters and row-level security). Such a request is now refused with
// 403 on every route, except from the single shared API_AUTH_TOKEN
// (single-tenant mode) and on the platform admin paths for a principal with no
// workspace list. The sweep walks RBAC_ROUTE_TABLE, which rbac-routes.test.mjs
// keeps equal to the mounted routes, so a new route is covered here without
// being named.
//
// Part B, cross-tenant object access. Tenant A's objects are seeded through
// the real stores the app is built with (the local vector index and the
// file-backed document registry, the in-memory agent run, task, artifact and
// ingest job stores, the feedback JSONL file), then every object route is
// called as tenant B with A's ids. B must get a 404 (or its own empty result)
// and never A's data, and A's objects must be unchanged afterwards. Every
// RBAC_ROUTE_TABLE route with a :param must be in the fixture map or in
// EXEMPT, so a new object route cannot be added without a decision.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";

import { createApp as createProductionApp } from "../app.js";
import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { configureFeedbackDirectory, createFileFeedbackStore } from "../feedback.js";
import {
  createAdminAuditService,
  createInMemoryAdminAuditStore,
} from "../rag/admin-audit.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
} from "../rag/agent-run-steps.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  configureDocumentRegistryStore,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import { clearDocuments, ingestDocument } from "../rag/index.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { configureLongMemoryStore } from "../rag/long-memory.js";
import {
  configureSessionMemoryStore,
  recordSessionTurn,
  resetSessionMemoryStore,
  resolveSessionMemoryKey,
} from "../rag/memory.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { RBAC_ROUTE_ACCESS, RBAC_ROUTE_TABLE } from "../rag/rbac.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import {
  createInMemoryTenantRegistryStore,
  createTenantRegistryService,
} from "../rag/tenant-registry.js";
import { resetVectorStore } from "../rag/vector-store.js";
import {
  ARTIFACT_TYPES,
  createInMemoryWorkspaceArtifactStore,
  createWorkspaceArtifactService,
} from "../rag/workspace-artifacts/index.js";

// Part B ingests into the local index with a stand-in embedding provider, so
// no database or model is needed (the pgvector path has its own integration
// suites); app.test.mjs pins the same.
process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const SCOPE_MESSAGE =
  "This request needs a user or workspace scope: name a workspace with x-workspace-id.";

// Every variable that changes who a request acts for or which routes answer.
// The split-deployment ones are cleared so this process is always the
// monolith, whatever the shell exports.
const ENV_KEYS = [
  "AGENT_SERVICE_URL",
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_REQUIRE_WORKSPACE",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "ARCHIVE_RAG_ROLE",
  "RAG_INGEST_MODE",
  "RATE_LIMIT_ENABLED",
  "RBAC_DEFAULT_ROLE",
  "RBAC_MODE",
  "RBAC_POLICY_FILE",
  "RBAC_POLICY_JSON",
];

const applyEnv = (values) => {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  return () => {
    for (const [key, value] of original.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
};

const withEnv = async (values, run) => {
  const restore = applyEnv(values);

  try {
    return await run();
  } finally {
    restore();
  }
};

const authEnv = (tokens) => ({
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify(tokens),
});

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

// Every store the defaults would put on PostgreSQL when a database URL is in
// the environment is passed in-memory, so the suite never reaches a database.
const createApp = (tempRoot, options = {}) =>
  createProductionApp({
    adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore() }),
    agentRunStore: createInMemoryAgentRunStore(),
    executionPlannerAdapter: deterministicPlannerAdapter,
    // The JSONL store, following configureFeedbackDirectory; with a database
    // URL the default would be the PostgreSQL table.
    feedbackStore: createFileFeedbackStore(),
    healthService: okHealthService,
    ingestJobStore: createInMemoryIngestJobStore(),
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    taskStore: createInMemoryTaskStore(),
    // The in-process registry; with a database URL the default would be the
    // PostgreSQL tables of migration 036.
    tenantRegistry: createTenantRegistryService({ store: createInMemoryTenantRegistryStore() }),
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
    ...options,
  });

// Part A needs no data: a refused request never reaches a store, and the
// platform paths answer from the in-memory services.
const createStubApp = (tempRoot, ragService = {}) =>
  createApp(tempRoot, {
    ragService: {
      deleteDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeLongMemory: async () => true,
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
      ...ragService,
    },
  });

const startServer = async (app) => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const call = async (server, { body, headers = {}, method, path: requestPath }) => {
  const response = await fetch(`${server.baseUrl}${requestPath}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    method,
  });
  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { contentType: response.headers.get("content-type") ?? "", json, status: response.status, text };
};

const routeKey = (entry) => `${entry.method} ${entry.path}`;

const samplePath = (routePath) =>
  routePath
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `sample-${segment.slice(1)}` : segment))
    .join("/");

const sendsBody = (method) => method === "POST" || method === "PUT";

// Exactly the gate's answer: 403 and a body holding only the scope message.
const isScopeRefusal = (response) =>
  response.status === 403 &&
  response.json !== null &&
  Object.keys(response.json).length === 1 &&
  response.json.error === SCOPE_MESSAGE;

// ---------------------------------------------------------------------------
// Part A: the gate over every route
// ---------------------------------------------------------------------------

// The routes a principal without a workspace list may call with an empty
// scope. Written out rather than read from auth.js, so widening the exception
// there fails here.
const PLATFORM_ROUTES = new Set([
  "GET /admin/audit",
  "GET /admin/index-versions",
  "GET /admin/status",
  "GET /admin/tenants/export",
  // Migration 037's usage ledger: every tenant's totals for a platform admin.
  "GET /admin/usage",
  "GET /auth/me",
  "POST /admin/actions/:action",
  // The tenant registry (routes/admin-tenants.js, migration 036): platform
  // data by nature, behind admin.tenants.read / admin.tenants.write.
  "GET /admin/workspaces",
  "POST /admin/workspaces",
  "GET /admin/workspaces/:workspaceId",
  "PATCH /admin/workspaces/:workspaceId",
  "POST /admin/workspaces/:workspaceId/actions/:action",
  "GET /admin/workspaces/:workspaceId/members",
  "GET /admin/workspaces/:workspaceId/members/:userId",
  "PUT /admin/workspaces/:workspaceId/members/:userId",
  "DELETE /admin/workspaces/:workspaceId/members/:userId",
  "POST /admin/tenants/erase",
]);

const PART_A_TOKENS = {
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
  "bob-token": { userId: "bob", workspaceId: "ws-b" },
  // Two workspaces and no user: without x-workspace-id its scope is empty.
  "multi-workspace-token": { workspaces: ["ws-a", "ws-b"] },
  // A platform operator: admin roles, no user, no workspace, no workspace list.
  "platform-admin-token": { roles: ["admin.owner"] },
};

const gatedRoutes = () =>
  RBAC_ROUTE_TABLE.filter((entry) => entry.access !== RBAC_ROUTE_ACCESS.public);

const sampleRequest = (entry, headers) => ({
  body: sendsBody(entry.method) ? {} : undefined,
  headers,
  method: entry.method,
  path: samplePath(entry.path),
});

test("an empty scope is refused on every non-public route, the platform paths only for a principal with no workspace list", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-gate-"));

  try {
    await withEnv(authEnv(PART_A_TOKENS), async () => {
      const server = await startServer(await createStubApp(tempRoot));

      try {
        const routes = gatedRoutes();
        const tableKeys = new Set(routes.map(routeKey));
        const multiWorkspaceAnswered = [];
        const platformAdminAnswered = [];
        const platformAdminRefusedOnPlatformPath = [];

        assert.ok(routes.length > 40, "the route table walk found too few routes");
        for (const key of PLATFORM_ROUTES) {
          assert.ok(tableKeys.has(key), `platform route ${key} is in RBAC_ROUTE_TABLE`);
        }

        for (const entry of routes) {
          const key = routeKey(entry);
          const multiWorkspace = await call(
            server,
            sampleRequest(entry, { "x-api-key": "multi-workspace-token" })
          );

          // A workspace list without a chosen workspace is refused even on
          // the platform paths: that token is a tenant credential.
          if (!isScopeRefusal(multiWorkspace)) {
            multiWorkspaceAnswered.push(`${key} -> ${multiWorkspace.status}`);
          }

          const platformAdmin = await call(
            server,
            sampleRequest(entry, { "x-api-key": "platform-admin-token" })
          );

          if (PLATFORM_ROUTES.has(key)) {
            if (isScopeRefusal(platformAdmin)) {
              platformAdminRefusedOnPlatformPath.push(key);
            }
          } else if (!isScopeRefusal(platformAdmin)) {
            platformAdminAnswered.push(`${key} -> ${platformAdmin.status}`);
          }
        }

        assert.deepEqual(
          multiWorkspaceAnswered,
          [],
          "routes that answered a multi-workspace token without x-workspace-id"
        );
        assert.deepEqual(
          platformAdminAnswered,
          [],
          "tenant routes that answered a platform admin with no user or workspace"
        );
        assert.deepEqual(
          platformAdminRefusedOnPlatformPath,
          [],
          "platform paths that refused a platform admin with the scope message"
        );
      } finally {
        await server.close();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("a scope that names a workspace or a user passes the gate", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-gate-scoped-"));

  try {
    await withEnv(authEnv(PART_A_TOKENS), async () => {
      const server = await startServer(await createStubApp(tempRoot));

      try {
        for (const routePath of ["/documents", "/tasks", "/agent-runs", "/artifacts"]) {
          const chosen = await call(server, {
            headers: { "x-api-key": "multi-workspace-token", "x-workspace-id": "ws-a" },
            method: "GET",
            path: routePath,
          });

          assert.equal(isScopeRefusal(chosen), false, `GET ${routePath} with x-workspace-id`);
          assert.equal(chosen.status, 200, `GET ${routePath} with x-workspace-id`);

          const tenant = await call(server, {
            headers: { "x-api-key": "alice-token" },
            method: "GET",
            path: routePath,
          });

          assert.equal(tenant.status, 200, `GET ${routePath} as a user+workspace token`);
        }

        // A workspace outside the list is refused by the workspace check, not
        // turned into an empty scope that the gate would then have to catch.
        const outside = await call(server, {
          headers: { "x-api-key": "multi-workspace-token", "x-workspace-id": "ws-c" },
          method: "GET",
          path: "/documents",
        });

        assert.equal(outside.status, 403);
        assert.equal(outside.json.error, "Requested workspace is outside authenticated scope.");
      } finally {
        await server.close();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("the single shared API_AUTH_TOKEN keeps acting for the whole archive without a user", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-gate-shared-"));
  const listScopes = [];

  try {
    await withEnv({ API_AUTH_ENABLED: "true", API_AUTH_TOKEN: "shared-token" }, async () => {
      const server = await startServer(
        await createStubApp(tempRoot, {
          listDocuments: (accessScope) => {
            listScopes.push(accessScope);
            return [];
          },
        })
      );

      try {
        const response = await call(server, {
          headers: { "x-api-key": "shared-token" },
          method: "GET",
          path: "/documents",
        });

        assert.equal(isScopeRefusal(response), false);
        assert.equal(response.status, 200);
        assert.deepEqual(response.json, []);
        assert.equal(listScopes.length, 1);
        assert.equal(listScopes[0].authenticated, true);
        assert.equal(listScopes[0].userId, "");
        assert.equal(listScopes[0].workspaceId, "");
      } finally {
        await server.close();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("createApp refuses an API_AUTH_TOKENS entry that can act for no tenant", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-gate-start-"));
  const isUnscopedTokenError = (error) => {
    assert.equal(error.code, "API_AUTH_TOKEN_WITHOUT_SCOPE");
    // The message names the count, never the token.
    assert.equal(error.message.includes("unscoped-token"), false);
    return true;
  };

  try {
    await withEnv(authEnv({ "unscoped-token": {} }), async () => {
      await assert.rejects(() => createStubApp(tempRoot), isUnscopedTokenError);
    });
    await withEnv(
      { API_AUTH_ENABLED: "true", API_AUTH_TOKENS: JSON.stringify([{ token: "unscoped-token" }]) },
      async () => {
        await assert.rejects(() => createStubApp(tempRoot), isUnscopedTokenError);
      }
    );
    // Roles alone make a platform credential; allowClientUserId lets the
    // client name its user. Neither is refused.
    await withEnv(authEnv({ "platform-token": { roles: ["admin.owner"] } }), async () => {
      await createStubApp(tempRoot);
    });
    await withEnv(authEnv({ "delegating-token": { allowClientUserId: true } }), async () => {
      await createStubApp(tempRoot);
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Part B: cross-tenant object access
// ---------------------------------------------------------------------------

// Every string tenant B could only have from reading A's objects carries this.
const MARKER = "ALICE-PRIVATE-7f3c9e";
const BOB_MARKER = "BOB-OWN-41d2";

const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-a" };

const IDS = Object.freeze({
  artifact: "artifact-alice",
  deadJob: "job-alice-dead",
  doc: "doc-alice",
  gate: "gate-alice",
  job: "job-alice",
  runApproval: "run-alice-approval",
  runFailed: "run-alice-failed",
  session: "session-shared-id",
  step: "step-alice-failed",
  task: "task-alice",
});

const PART_B_TOKENS = {
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
  "bob-token": { userId: "bob", workspaceId: "ws-b" },
  // An admin inside tenant B: passes the route-level admin checks, still B.
  "bob-admin-token": { roles: ["admin.owner"], userId: "bob", workspaceId: "ws-b" },
  "multi-workspace-token": { workspaces: ["ws-a", "ws-b"] },
};

const ALICE_HEADERS = { "x-api-key": "alice-token" };

// Tenant B in three shapes: a user, an admin of B, and a workspace without a
// user (the multi-workspace token choosing ws-b).
const TENANT_B_PRINCIPALS = [
  { headers: { "x-api-key": "bob-token" }, name: "bob" },
  { headers: { "x-api-key": "bob-admin-token" }, name: "bob-admin" },
  {
    headers: { "x-api-key": "multi-workspace-token", "x-workspace-id": "ws-b" },
    name: "ws-b-without-user",
  },
];

/**
 * One entry per RBAC_ROUTE_TABLE route with a :param. `requests(seeded)` are
 * tenant B's attempts with A's ids; `statuses` what B may get (by principal
 * name, `default` otherwise); `check` an extra assertion on B's answer. Every
 * answer must also leave MARKER out.
 */
const OBJECT_ROUTE_FIXTURES = {
  "GET /documents/:docId/file": {
    requests: () => [{ method: "GET", path: `/documents/${IDS.doc}/file` }],
    statuses: { default: [404] },
  },
  "DELETE /documents/:docId": {
    requests: () => [{ method: "DELETE", path: `/documents/${IDS.doc}` }],
    statuses: { default: [404] },
  },
  "GET /documents/:docId/arxiv/suggestions": {
    requests: () => [{ method: "GET", path: `/documents/${IDS.doc}/arxiv/suggestions` }],
    statuses: { default: [404] },
  },
  "GET /documents/:docId/arxiv/suggestions/saved": {
    requests: () => [{ method: "GET", path: `/documents/${IDS.doc}/arxiv/suggestions/saved` }],
    statuses: { default: [404] },
  },
  "POST /documents/:docId/arxiv/import": {
    requests: () => [
      {
        body: { selectedArxivIds: ["2401.00001"], selectionToken: "forged-token" },
        method: "POST",
        path: `/documents/${IDS.doc}/arxiv/import`,
      },
    ],
    statuses: { default: [404] },
  },
  "GET /ingest-jobs/:jobId": {
    requests: () => [
      { method: "GET", path: `/ingest-jobs/${IDS.job}` },
      { method: "GET", path: `/ingest-jobs/${IDS.deadJob}` },
    ],
    statuses: { default: [404] },
  },
  "POST /admin/ingest-jobs/:jobId/requeue": {
    requests: () => [{ body: {}, method: "POST", path: `/admin/ingest-jobs/${IDS.deadJob}/requeue` }],
    // Only B's admin passes the admin check; the store then finds no job.
    statuses: { "bob-admin": [404], default: [403] },
  },
  "GET /artifacts/:artifactId": {
    requests: () => [{ method: "GET", path: `/artifacts/${IDS.artifact}` }],
    statuses: { default: [404] },
  },
  "GET /artifacts/:artifactId/download": {
    requests: () => [{ method: "GET", path: `/artifacts/${IDS.artifact}/download` }],
    statuses: { default: [404] },
  },
  "POST /artifacts/:artifactId/archive": {
    requests: () => [{ body: {}, method: "POST", path: `/artifacts/${IDS.artifact}/archive` }],
    statuses: { default: [404] },
  },
  "GET /agent-runs/:runId": {
    requests: () => [
      { method: "GET", path: `/agent-runs/${IDS.runApproval}` },
      { method: "GET", path: `/agent-runs/${IDS.runFailed}` },
    ],
    statuses: { default: [404] },
  },
  "POST /agent-runs/:runId/actions/:action": {
    requests: () =>
      ["approve", "deny"].map((action) => ({
        body: { approvalObjectHash: `sha256:${"a".repeat(64)}`, gateId: IDS.gate },
        method: "POST",
        path: `/agent-runs/${IDS.runApproval}/actions/${action}`,
      })),
    statuses: { default: [404] },
  },
  "POST /agent-runs/:runId/recovery/actions/:action": {
    requests: () =>
      ["retry_failed_step", "cancel"].map((action) => ({
        body: { stepId: IDS.step },
        method: "POST",
        path: `/agent-runs/${IDS.runFailed}/recovery/actions/${action}`,
      })),
    statuses: { default: [404] },
  },
  "POST /agent-runs/:runId/steps/:stepId/actions/retry": {
    requests: () => [
      { body: {}, method: "POST", path: `/agent-runs/${IDS.runFailed}/steps/${IDS.step}/actions/retry` },
    ],
    statuses: { default: [404] },
  },
  "GET /tasks/:taskId": {
    requests: () => [{ method: "GET", path: `/tasks/${IDS.task}` }],
    statuses: { default: [404] },
  },
  "POST /tasks/:taskId/actions/:action": {
    requests: () =>
      ["approve", "continue"].map((action) => ({
        body: {},
        method: "POST",
        path: `/tasks/${IDS.task}/actions/${action}`,
      })),
    statuses: { default: [404] },
  },
  "DELETE /memory/:memoryId": {
    requests: (seeded) => [{ method: "DELETE", path: `/memory/${seeded.aliceMemoryId}` }],
    // A workspace scope without a user has no long-term memory at all.
    statuses: { default: [404], "ws-b-without-user": [400] },
  },
  // The tenant registry: only B's admin passes the admin check, and a
  // workspace-scoped admin reaches its own workspace only, so A's answers 404
  // exactly like a workspace that does not exist; registering and changing a
  // status are platform-only (403 for every principal of B).
  "GET /admin/workspaces/:workspaceId": {
    requests: () => [{ method: "GET", path: `/admin/workspaces/${ALICE.workspaceId}` }],
    statuses: { "bob-admin": [404], default: [403] },
  },
  "POST /admin/workspaces/:workspaceId/actions/:action": {
    requests: () =>
      ["suspend", "activate"].map((action) => ({
        body: {},
        method: "POST",
        path: `/admin/workspaces/${ALICE.workspaceId}/actions/${action}`,
      })),
    statuses: { default: [403] },
  },
  // Changing a retention policy is platform-only too: 403 for every principal
  // of B, A's admin included, and A's policy stays as it was.
  "PATCH /admin/workspaces/:workspaceId": {
    requests: () => [
      {
        body: { retentionPolicy: { agentRuns: 1 } },
        method: "PATCH",
        path: `/admin/workspaces/${ALICE.workspaceId}`,
      },
    ],
    statuses: { default: [403] },
  },
  "GET /admin/workspaces/:workspaceId/members": {
    requests: () => [{ method: "GET", path: `/admin/workspaces/${ALICE.workspaceId}/members` }],
    statuses: { "bob-admin": [404], default: [403] },
  },
  "GET /admin/workspaces/:workspaceId/members/:userId": {
    requests: () => [
      { method: "GET", path: `/admin/workspaces/${ALICE.workspaceId}/members/${ALICE.userId}` },
    ],
    statuses: { "bob-admin": [404], default: [403] },
  },
  "PUT /admin/workspaces/:workspaceId/members/:userId": {
    requests: () => [
      {
        body: { roles: ["workspace.admin"] },
        method: "PUT",
        path: `/admin/workspaces/${ALICE.workspaceId}/members/bob`,
      },
      {
        body: { roles: [] },
        method: "PUT",
        path: `/admin/workspaces/${ALICE.workspaceId}/members/${ALICE.userId}`,
      },
    ],
    statuses: { "bob-admin": [404], default: [403] },
  },
  "DELETE /admin/workspaces/:workspaceId/members/:userId": {
    requests: () => [
      { method: "DELETE", path: `/admin/workspaces/${ALICE.workspaceId}/members/${ALICE.userId}` },
    ],
    statuses: { "bob-admin": [404], default: [403] },
  },
  "DELETE /sessions/:sessionId": {
    requests: () => [{ method: "DELETE", path: `/sessions/${IDS.session}` }],
    // The caller's scope is part of the session key: B clears its own
    // (absent) session of that id, never A's.
    statuses: { default: [200] },
    check: (response) => assert.deepEqual(response.json, { cleared: false }),
  },
};

const EXEMPT = {
  "PUT /documents/:docId":
    "replacement needs the transactional pgvector store; on the local store this suite runs on the route answers 409 before its scope check, so exercising that check needs PostgreSQL (not seeded here)",
  "POST /agent-triggers/:triggerId/dispatch":
    "triggerId names a trigger of the process-wide registry, not tenant data; the task it creates is in the caller's own scope (auth-user-id-trigger.test.mjs)",
  "POST /admin/actions/:action":
    "action names a controlled admin action of the fixed admin registry, not tenant data",
};

test("every :param route of RBAC_ROUTE_TABLE is a cross-tenant fixture or an explicit exemption", () => {
  const paramRoutes = RBAC_ROUTE_TABLE.filter((entry) => entry.path.includes("/:")).map(routeKey);
  const decided = [...Object.keys(OBJECT_ROUTE_FIXTURES), ...Object.keys(EXEMPT)];
  const undecided = paramRoutes.filter(
    (key) => !(key in OBJECT_ROUTE_FIXTURES) && !(key in EXEMPT)
  );

  assert.deepEqual(
    undecided,
    [],
    `routes with a :param in neither OBJECT_ROUTE_FIXTURES nor EXEMPT: ${undecided.join(", ")}`
  );
  assert.deepEqual(
    Object.keys(OBJECT_ROUTE_FIXTURES).filter((key) => key in EXEMPT),
    [],
    "a route is either a fixture or exempt"
  );
  assert.deepEqual(
    decided.filter((key) => !paramRoutes.includes(key)),
    [],
    "fixture or exemption for a route that is not in RBAC_ROUTE_TABLE"
  );

  for (const [key, reason] of Object.entries(EXEMPT)) {
    assert.ok(reason.trim().length > 20, `${key} needs a reason`);
  }
});

const DIMENSIONS = 8;

const embedText = (text) => {
  const vector = new Array(DIMENSIONS).fill(0);

  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    let hash = 0;

    for (const character of word) {
      hash = (hash * 31 + character.charCodeAt(0)) % DIMENSIONS;
    }

    vector[hash] += 1;
  }

  return vector;
};

const embeddingProvider = {
  completeText: async () => "unused",
  embedQuery: async (query) => embedText(query),
  embedTexts: async (texts) => texts.map(embedText),
};

// Stands in for the PostgreSQL long-memory store, whose only tenant rule is
// `WHERE user_id = $1` on every statement (rag/long-memory.js; migration 013's
// row policy is the same: memory belongs to a user across workspaces). What
// this suite checks is the routes' half: they hand the store the caller's own
// user, never A's.
const createLongMemoryStore = () => {
  const memories = new Map();
  let nextId = 0;
  const copy = (memory) => (memory ? structuredClone(memory) : null);
  const owned = (userId) =>
    [...memories.values()].filter((memory) => memory.userId === String(userId ?? "").trim());

  return {
    memories,
    initialize: async () => true,
    list: async ({ limit = 50, userId } = {}) => owned(userId).slice(0, limit).map(copy),
    remember: async ({ category = "note", text, userId }) => {
      nextId += 1;
      const memory = { category, memoryId: `memory-${nextId}`, text, userId: String(userId).trim() };

      memories.set(memory.memoryId, memory);
      return copy(memory);
    },
    delete: async ({ memoryId, userId }) => {
      const memory = memories.get(String(memoryId ?? "").trim());

      if (!memory || memory.userId !== String(userId ?? "").trim()) {
        return null;
      }

      memories.delete(memory.memoryId);
      return copy(memory);
    },
    clear: async ({ userId }) => {
      const removed = owned(userId);

      for (const memory of removed) memories.delete(memory.memoryId);
      return removed.length;
    },
  };
};

// The session store contract of rag/memory.js (keyed by the tenant key the
// module derives), held in memory; session-memory-tenant-isolation.test.mjs
// uses the same shape.
const createSessionStore = () => {
  const sessions = new Map();

  return {
    sessions,
    async get(sessionKey) {
      const session = sessions.get(sessionKey);
      return session ? structuredClone(session) : null;
    },
    async upsert({ messages, sessionId, updatedAt }) {
      sessions.set(sessionId, { messages: structuredClone(messages), updatedAt });
      return structuredClone(sessions.get(sessionId));
    },
    async delete(sessionKey) {
      return sessions.delete(sessionKey);
    },
  };
};

const statusesFor = (fixture, principal) =>
  fixture.statuses[principal.name] ?? fixture.statuses.default;

describe("cross-tenant object access", () => {
  const state = {};

  const asAlice = (method, routePath, body) =>
    call(state.server, { body, headers: ALICE_HEADERS, method, path: routePath });

  before(async () => {
    state.tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-objects-"));
    state.restoreEnv = applyEnv(authEnv(PART_B_TOKENS));
    state.originalRagDataDirectory = getRagDataDirectory();
    state.chatCalls = [];
    state.arxivSearches = [];
    state.arxivImports = [];
    state.longMemoryStore = createLongMemoryStore();
    state.sessionStore = createSessionStore();

    configureRagDataDirectory(path.join(state.tempRoot, "rag-data"));
    await resetDocumentRegistryStore();
    configureDocumentRegistryStore(createFileDocumentRegistryStore());
    resetVectorStore();
    configureOpenAIProvider(embeddingProvider);
    // This file runs in its own process (run.test.mjs, node --test), so no
    // other suite sees these module-level redirects.
    configureFeedbackDirectory(path.join(state.tempRoot, "feedback"));
    configureLongMemoryStore(state.longMemoryStore);
    configureSessionMemoryStore(state.sessionStore);

    state.agentRunStore = createInMemoryAgentRunStore();
    state.taskStore = createInMemoryTaskStore();
    state.ingestJobStore = createInMemoryIngestJobStore();
    state.workspaceArtifactService = createWorkspaceArtifactService({
      createArtifactId: () => IDS.artifact,
      store: createInMemoryWorkspaceArtifactStore(),
    });
    state.tenantRegistry = createTenantRegistryService({
      store: createInMemoryTenantRegistryStore(),
    });

    const app = await createApp(state.tempRoot, {
      agentExperienceMemoryService: { recordFromFeedback: async () => null },
      agentRunStore: state.agentRunStore,
      arxivImportService: {
        importPaper: async (input) => {
          state.arxivImports.push(input);
          return null;
        },
        importTopic: async (input) => {
          state.arxivImports.push(input);
          return { imported: [] };
        },
      },
      arxivService: {
        search: async (input) => {
          state.arxivSearches.push(input);
          return [];
        },
      },
      ingestJobStore: state.ingestJobStore,
      // The real document registry, index and memory functions answer; only
      // the answer model is replaced, so a retry B managed to start would
      // show up here instead of calling a model.
      ragService: {
        chat: async (...args) => {
          state.chatCalls.push(args);
          return { citations: [], text: "stub" };
        },
      },
      taskStore: state.taskStore,
      tenantRegistry: state.tenantRegistry,
      workspaceArtifactService: state.workspaceArtifactService,
    });

    state.server = await startServer(app);

    // Seeding is done after createApp, so startup recovery (agent runs,
    // runnable tasks) does not pick A's objects up.
    const pdfPath = path.join(state.tempRoot, "alice.pdf");

    await writeFile(
      pdfPath,
      buildTextPdf({ pages: [[`The ${MARKER} policy needs manager approval for remote work.`]] })
    );
    await ingestDocument({
      docId: IDS.doc,
      fileName: `${MARKER}.pdf`,
      filePath: pdfPath,
      ownerUserId: ALICE.userId,
      workspaceId: ALICE.workspaceId,
    });

    const agentRunService = createAgentRunService({ agentRunStore: state.agentRunStore });

    await agentRunService.createRun({
      accessScope: ALICE,
      goal: `Search the web for ${MARKER}`,
      runId: IDS.runApproval,
    });
    await agentRunService.completeRun({
      accessScope: ALICE,
      approvalGates: [
        {
          approvalObjectHash: `sha256:${"a".repeat(64)}`,
          capabilityId: "web_search",
          id: IDS.gate,
          inputPreview: { question: `Search the web for ${MARKER}` },
          status: "pending",
        },
      ],
      result: { answer: MARKER },
      runId: IDS.runApproval,
      status: AGENT_RUN_STATUSES.waitingForUser,
    });
    await agentRunService.createRun({
      accessScope: ALICE,
      goal: `Summarize ${MARKER}`,
      runId: IDS.runFailed,
    });
    await agentRunService.updateRun({
      accessScope: ALICE,
      patch: {
        error: { message: "Simulated process failure." },
        result: { error: "Document RAG failed." },
        status: AGENT_RUN_STATUSES.failed,
        steps: [
          {
            error: { message: "Simulated process failure." },
            id: IDS.step,
            input: { docIds: [IDS.doc], question: `What does ${MARKER} say?` },
            kind: AGENT_RUN_STEP_KINDS.toolCall,
            label: "Document RAG",
            status: AGENT_RUN_STEP_STATUSES.failed,
            type: "document_rag",
          },
        ],
      },
      runId: IDS.runFailed,
    });

    await state.taskStore.upsert({
      accessScope: ALICE,
      task: {
        id: IDS.task,
        label: `Review ${MARKER}`,
        status: "waiting_for_user",
        summary: `Recommendations for ${MARKER}`,
        type: "external_recommendation",
      },
    });

    await state.workspaceArtifactService.createArtifact({
      accessScope: ALICE,
      artifact: {
        artifactType: ARTIFACT_TYPES.report,
        content: `# ${MARKER} report`,
        fileName: "alice-report.md",
        format: "markdown",
        idempotencyKey: "alice-report",
        mimeType: "text/markdown",
        title: `Report ${MARKER}`,
      },
    });

    // A dead-letter job first (claim takes the oldest queued job), then one
    // left queued; no worker runs in this process.
    await state.ingestJobStore.enqueue({
      docId: "doc-alice-dead",
      fileBytes: Buffer.from("%PDF-1.4 dead"),
      fileName: `${MARKER}-dead.pdf`,
      jobId: IDS.deadJob,
      maxAttempts: 1,
      ownerUserId: ALICE.userId,
      workspaceId: ALICE.workspaceId,
    });
    const claimed = await state.ingestJobStore.claim({ leaseMs: 60_000, workerId: "seed-worker" });

    assert.equal(claimed?.jobId, IDS.deadJob);
    assert.equal(
      await state.ingestJobStore.fail({
        attemptCount: claimed.attemptCount,
        deadLetterReason: "parse_failed",
        error: new Error("parse failed"),
        jobId: IDS.deadJob,
        retryable: true,
        workerId: "seed-worker",
      }),
      "dead_letter"
    );
    await state.ingestJobStore.enqueue({
      docId: "doc-alice-queued",
      fileBytes: Buffer.from("%PDF-1.4 queued"),
      fileName: `${MARKER}-queued.pdf`,
      jobId: IDS.job,
      ownerUserId: ALICE.userId,
      workspaceId: ALICE.workspaceId,
    });

    let response = await asAlice("POST", "/memory", { text: `Remember ${MARKER} preferences` });
    assert.equal(response.status, 201);
    state.aliceMemoryId = response.json.memory.memoryId;

    response = await call(state.server, {
      body: { text: `Remember ${BOB_MARKER} preferences` },
      headers: { "x-api-key": "bob-token" },
      method: "POST",
      path: "/memory",
    });
    assert.equal(response.status, 201);

    response = await asAlice("POST", "/feedback", {
      answer: { agentAnswer: `The ${MARKER} policy needs approval.` },
      docIds: [IDS.doc],
      feedbackType: "helpful",
      note: MARKER,
      question: `What does the ${MARKER} policy say?`,
    });
    assert.equal(response.status, 201);

    await recordSessionTurn({
      accessScope: ALICE,
      answer: `${MARKER} answer`,
      documents: [{ fileName: `${MARKER}.pdf` }],
      query: `${MARKER} question`,
      resolvedQuery: `${MARKER} question`,
      routeMode: "qa",
      sessionId: IDS.session,
    });

    // A's workspace in the tenant registry, with A as its admin member.
    await state.tenantRegistry.createWorkspace({
      plan: `plan-${MARKER}`,
      region: `region-${MARKER}`,
      // The retention format (rag/workspace-retention-policy.js) holds only
      // day counts, so the marker rides on the descriptors.
      retentionPolicy: { agentRuns: 30 },
      workspaceId: ALICE.workspaceId,
    });
    await state.tenantRegistry.putMember({
      roles: ["workspace.admin"],
      userId: ALICE.userId,
      workspaceId: ALICE.workspaceId,
    });

    // A saved arXiv suggestion for A's document (and the recommendation task
    // it records in A's scope).
    response = await asAlice("GET", `/documents/${IDS.doc}/arxiv/suggestions`);
    assert.equal(response.status, 200);
    state.arxivSearchesBeforeB = state.arxivSearches.length;
  });

  after(async () => {
    await state.server?.close();
    await clearDocuments({ deleteFiles: false });
    resetVectorStore();
    await resetDocumentRegistryStore();
    resetOpenAIProvider();
    configureLongMemoryStore(null);
    await resetSessionMemoryStore();
    if (state.originalRagDataDirectory) configureRagDataDirectory(state.originalRagDataDirectory);
    state.restoreEnv?.();
    await rm(state.tempRoot, { force: true, recursive: true });
  });

  // What A sees of its own objects. Run before B's attempts, it shows the
  // marker is in every answer B will be checked against; run after, that
  // nothing B did changed them.
  const assertAliceObjectsIntact = async () => {
    let response = await asAlice("GET", "/documents");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.map((document) => document.docId), [IDS.doc]);
    assert.ok(response.text.includes(MARKER));

    response = await asAlice("GET", `/documents/${IDS.doc}/file`);
    assert.equal(response.status, 200);
    assert.match(response.contentType, /application\/pdf/);
    assert.ok(response.text.includes(MARKER), "A's PDF bytes carry the marker");

    response = await asAlice("GET", `/documents/${IDS.doc}/arxiv/suggestions/saved`);
    assert.equal(response.status, 200);

    response = await asAlice("GET", `/agent-runs/${IDS.runApproval}`);
    assert.equal(response.status, 200);
    assert.ok(response.text.includes(MARKER));
    assert.equal(response.json.status, AGENT_RUN_STATUSES.waitingForUser);
    assert.deepEqual(
      response.json.approvalGates.map((gate) => [gate.id, gate.status]),
      [[IDS.gate, "pending"]]
    );
    assert.deepEqual(
      response.json.events.map((event) => event.type),
      ["run_created", "approval_gate_created"]
    );

    response = await asAlice("GET", `/agent-runs/${IDS.runFailed}`);
    assert.equal(response.status, 200);
    assert.ok(response.text.includes(MARKER));
    assert.equal(response.json.status, AGENT_RUN_STATUSES.failed);
    assert.deepEqual(response.json.steps.map((step) => [step.id, step.status]), [
      [IDS.step, AGENT_RUN_STEP_STATUSES.failed],
    ]);

    response = await asAlice("GET", "/agent-runs/recovery");
    assert.equal(response.status, 200);
    const recoverable = response.json.runs.find((run) => run.runId === IDS.runFailed);
    assert.ok(recoverable, "A's failed run is recoverable by A");
    assert.ok(
      recoverable.recovery.actions.some((action) => action.type === "retry_failed_step")
    );

    response = await asAlice("GET", `/tasks/${IDS.task}`);
    assert.equal(response.status, 200);
    assert.ok(response.text.includes(MARKER));
    assert.equal(response.json.status, "waiting_for_user");

    response = await asAlice("GET", `/artifacts/${IDS.artifact}`);
    assert.equal(response.status, 200);
    assert.ok(response.text.includes(MARKER));
    assert.equal(response.json.artifact.status, "active");

    response = await asAlice("GET", `/artifacts/${IDS.artifact}/download`);
    assert.equal(response.status, 200);
    assert.ok(response.text.includes(MARKER));

    response = await asAlice("GET", `/ingest-jobs/${IDS.job}`);
    assert.equal(response.status, 200);
    assert.ok(response.text.includes(MARKER));
    assert.equal(response.json.status, "queued");

    response = await asAlice("GET", `/ingest-jobs/${IDS.deadJob}`);
    assert.equal(response.status, 200);
    assert.equal(response.json.status, "failed");
    assert.ok(response.json.deadLetter, "the job is still in the dead letter");

    response = await asAlice("GET", "/memory");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.memories.map((memory) => memory.memoryId), [
      state.aliceMemoryId,
    ]);
    assert.ok(response.text.includes(MARKER));

    response = await asAlice("GET", "/feedback");
    assert.equal(response.status, 200);
    assert.equal(response.json.feedback.length, 1);
    assert.ok(response.text.includes(MARKER));

    const aliceSession = state.sessionStore.sessions.get(
      resolveSessionMemoryKey(IDS.session, ALICE)
    );
    assert.equal(aliceSession?.messages.length, 2, "A's session keeps its turn");

    // No tenant-B token is a platform credential, so A's registry entry is
    // checked on the registry itself.
    const workspace = await state.tenantRegistry.getWorkspace(ALICE.workspaceId);
    assert.equal(workspace.status, "active");
    assert.ok(workspace.plan.includes(MARKER));
    assert.deepEqual(
      (await state.tenantRegistry.listMembers(ALICE.workspaceId)).map((member) => [
        member.userId,
        member.roles,
      ]),
      [[ALICE.userId, ["workspace.admin"]]]
    );
  };

  test("tenant A sees each of its seeded objects (so B's 404s are scope decisions)", async () => {
    await assertAliceObjectsIntact();
  });

  test("tenant B's list and clear routes show and remove none of tenant A's objects", async () => {
    const failures = [];
    const requests = [
      { method: "GET", path: "/documents" },
      { method: "GET", path: "/documents/arxiv/suggestions" },
      { method: "GET", path: "/agent-runs" },
      { method: "GET", path: "/agent-runs/recovery" },
      { method: "GET", path: "/tasks" },
      { method: "GET", path: "/artifacts" },
      { method: "GET", path: "/memory" },
      { method: "GET", path: "/feedback" },
      { method: "GET", path: "/admin/ingest-jobs/dead-letter" },
      { method: "GET", path: "/admin/status" },
      { method: "GET", path: "/admin/workspaces" },
      { method: "GET", path: "/admin/usage" },
      { body: {}, method: "POST", path: "/documents/clear" },
      { method: "DELETE", path: "/memory" },
    ];

    for (const principal of TENANT_B_PRINCIPALS) {
      for (const request of requests) {
        const response = await call(state.server, { ...request, headers: principal.headers });
        const label = `${principal.name}: ${request.method} ${request.path} -> ${response.status}`;

        if (response.text.includes(MARKER)) {
          failures.push(`${label} returned tenant A's data`);
        } else if (response.status >= 500) {
          failures.push(`${label} failed`);
        }
      }
    }

    assert.deepEqual(failures, []);

    // The lists are filtered, not broken: B's own objects still show.
    const bob = { "x-api-key": "bob-token" };
    let response = await call(state.server, { headers: bob, method: "GET", path: "/documents" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, []);

    response = await call(state.server, { headers: bob, method: "GET", path: "/agent-runs" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.runs, []);

    response = await call(state.server, {
      body: { text: `Remember ${BOB_MARKER} preferences again` },
      headers: bob,
      method: "POST",
      path: "/memory",
    });
    assert.equal(response.status, 201);
    response = await call(state.server, { headers: bob, method: "GET", path: "/memory" });
    assert.equal(response.status, 200);
    assert.ok(response.text.includes(BOB_MARKER));
    assert.equal(response.text.includes(MARKER), false);
  });

  test("tenant B cannot read, change or delete tenant A's objects by id", async () => {
    const failures = [];

    for (const [key, fixture] of Object.entries(OBJECT_ROUTE_FIXTURES)) {
      for (const principal of TENANT_B_PRINCIPALS) {
        for (const request of fixture.requests(state)) {
          const response = await call(state.server, { ...request, headers: principal.headers });
          const label = `${key} as ${principal.name} (${request.method} ${request.path}) -> ${response.status}`;
          const expected = statusesFor(fixture, principal);

          if (response.text.includes(MARKER)) {
            failures.push(`${label}: returned tenant A's data`);
            continue;
          }

          if (!expected.includes(response.status)) {
            failures.push(`${label}: expected ${expected.join(" or ")}, body ${response.text.slice(0, 200)}`);
            continue;
          }

          try {
            fixture.check?.(response);
          } catch (error) {
            failures.push(`${label}: ${error.message}`);
          }
        }
      }
    }

    assert.deepEqual(failures, []);
    assert.equal(state.chatCalls.length, 0, "no retry or approval of A's runs reached the model");
    assert.equal(
      state.arxivSearches.length,
      state.arxivSearchesBeforeB,
      "no arXiv search ran for A's document on B's request"
    );
    assert.deepEqual(state.arxivImports, [], "no arXiv import ran for A's document");
  });

  test("tenant A's objects are unchanged after tenant B's attempts", async () => {
    await assertAliceObjectsIntact();
  });
});
