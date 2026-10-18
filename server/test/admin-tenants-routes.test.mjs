// The tenant registry's admin API (routes/admin-tenants.js) through the real
// createApp chain: permissions, the platform-or-own-workspace reach, the
// audit records, validation answers, RBAC enforce, and that every store call
// runs on the system path.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createApp as createProductionApp } from "../app.js";
import { configureFeedbackDirectory, createFileFeedbackStore } from "../feedback.js";
import { createAdminAuditService, createInMemoryAdminAuditStore } from "../rag/admin-audit.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { getDatabaseTenantContext } from "../rag/postgres-tenant.js";
import { RBAC_ERROR_CODE } from "../rag/rbac.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import {
  createInMemoryTenantRegistryStore,
  createTenantRegistryService,
} from "../rag/tenant-registry.js";
import { createInMemoryWorkspaceArtifactStore } from "../rag/workspace-artifacts/index.js";

const ENV_KEYS = [
  "AGENT_SERVICE_URL",
  "API_AUTH_ENABLED",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "ARCHIVE_RAG_ROLE",
  "RATE_LIMIT_ENABLED",
  "RBAC_DEFAULT_ROLE",
  "RBAC_MODE",
  "RBAC_POLICY_FILE",
  "RBAC_POLICY_JSON",
  "TENANT_MEMBERSHIP",
];

const TOKENS = {
  "manager-token": { roles: ["admin.tenant_manager"] },
  "owner-token": { roles: ["admin.owner"] },
  "operator-token": { roles: ["admin.operator"] },
  "viewer-token": { roles: ["admin.viewer"] },
  // Holds the permissions but is bound to ws-a: reaches ws-a only.
  "scoped-manager-token": { roles: ["admin.tenant_manager"], userId: "sam", workspaceId: "ws-a" },
  "member-token": { userId: "mia", workspaceId: "ws-a" },
  "workspace-admin-token": {
    userId: "wanda",
    workspaceId: "ws-a",
    workspaceRoles: { "ws-a": ["workspace.admin"] },
  },
};

const withEnv = async (values, run) => {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  try {
    return await run();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const authEnv = (extra = {}) => ({
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify(TOKENS),
  ...extra,
});

let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "admin-tenants-"));
  configureFeedbackDirectory(path.join(tempRoot, "feedback"));
});

after(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

// Every registry method call, with the database context it ran in.
const watchRegistry = (registry) => {
  const contexts = [];
  const watched = new Proxy(registry, {
    get(target, property) {
      const value = target[property];

      if (typeof value !== "function" || property === "describe" || property === "initialize") {
        return value;
      }

      return (...args) => {
        contexts.push({ context: getDatabaseTenantContext(), method: String(property) });
        return value.apply(target, args);
      };
    },
  });

  return { contexts, watched };
};

const setup = async (env = authEnv()) => {
  const registry = createTenantRegistryService({ store: createInMemoryTenantRegistryStore() });
  const { contexts, watched } = watchRegistry(registry);
  const auditStore = createInMemoryAdminAuditStore({ maxEvents: 1000 });
  const auditService = createAdminAuditService({ store: auditStore });
  const restore = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const app = await createProductionApp({
    adminAuditService: auditService,
    agentRunStore: createInMemoryAgentRunStore(),
    executionPlannerAdapter: deterministicPlannerAdapter,
    feedbackStore: createFileFeedbackStore(),
    healthService: {
      buildHealthReport: async () => ({ checks: {}, status: "ok" }),
      runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
    },
    ingestJobStore: createInMemoryIngestJobStore(),
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeLongMemory: async () => true,
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
    },
    taskStore: createInMemoryTaskStore(),
    tenantRegistry: watched,
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
  });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, requestPath, body) => {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { "x-api-key": token } : {}),
      },
      method,
    });
    const text = await response.text();

    return { json: text ? JSON.parse(text) : null, status: response.status };
  };

  return {
    auditService,
    call,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      for (const [key, value] of restore.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    contexts,
    registry,
  };
};

test("a platform credential registers, reads, suspends and activates workspaces and manages members", async () => {
  const harness = await setup();
  const { call } = harness;

  try {
    let response = await call("manager-token", "POST", "/admin/workspaces", {
      plan: "team",
      region: "eu-west",
      retentionPolicy: { agentRuns: 30 },
      id: "ws-a",
    });
    assert.equal(response.status, 201);
    assert.equal(response.json.workspace.workspaceId, "ws-a");
    assert.equal(response.json.workspace.status, "active");
    assert.deepEqual(response.json.workspace.retentionPolicy, { agentRuns: 30 });

    response = await call("manager-token", "POST", "/admin/workspaces", { id: "ws-a" });
    assert.equal(response.status, 409);
    assert.equal(response.json.code, "WORKSPACE_EXISTS");

    for (const body of [
      {},
      { id: "WS-B" },
      { id: "ws-b", retentionPolicy: "30d" },
      // A key the retention sweep does not read is refused, not stored.
      { id: "ws-b", retentionPolicy: { days: 30 } },
      [],
    ]) {
      response = await call("manager-token", "POST", "/admin/workspaces", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.json.code, "TENANT_REGISTRY_INVALID_INPUT");
    }

    // `workspaceId` in a body selects the request's own workspace (auth.js),
    // so the new workspace is named `id`, and a body naming workspaceId is
    // refused rather than read as either.
    response = await call("manager-token", "POST", "/admin/workspaces", { workspaceId: "ws-b" });
    assert.equal(response.status, 400);
    assert.match(response.json.error, /Name the new workspace as `id`/);
    assert.equal(await harness.registry.getWorkspace("ws-b"), null);

    response = await call("owner-token", "POST", "/admin/workspaces", { id: "ws-b", status: "suspended" });
    assert.equal(response.status, 201);

    response = await call("manager-token", "GET", "/admin/workspaces");
    assert.deepEqual(response.json.workspaces.map((workspace) => workspace.workspaceId), ["ws-a", "ws-b"]);
    response = await call("manager-token", "GET", "/admin/workspaces?status=suspended");
    assert.deepEqual(response.json.workspaces.map((workspace) => workspace.workspaceId), ["ws-b"]);
    response = await call("manager-token", "GET", "/admin/workspaces?limit=1&offset=1");
    assert.deepEqual(response.json.workspaces.map((workspace) => workspace.workspaceId), ["ws-b"]);
    response = await call("manager-token", "GET", "/admin/workspaces?limit=5000");
    assert.equal(response.status, 400);

    response = await call("manager-token", "GET", "/admin/workspaces/ws-a");
    assert.equal(response.json.workspace.plan, "team");
    response = await call("manager-token", "GET", "/admin/workspaces/ws-missing");
    assert.equal(response.status, 404);
    assert.equal(response.json.code, "WORKSPACE_NOT_FOUND");

    response = await call("manager-token", "POST", "/admin/workspaces/ws-a/actions/suspend", {});
    assert.equal(response.json.workspace.status, "suspended");
    response = await call("manager-token", "POST", "/admin/workspaces/ws-a/actions/activate", {});
    assert.equal(response.json.workspace.status, "active");
    response = await call("manager-token", "POST", "/admin/workspaces/ws-a/actions/delete", {});
    assert.equal(response.status, 400);
    assert.equal(response.json.code, "TENANT_REGISTRY_UNKNOWN_ACTION");
    response = await call("manager-token", "POST", "/admin/workspaces/ws-a/actions/constructor", {});
    assert.equal(response.status, 400, "an inherited name is not an action");
    response = await call("manager-token", "POST", "/admin/workspaces/ws-missing/actions/suspend", {});
    assert.equal(response.status, 404);

    response = await call("manager-token", "PUT", "/admin/workspaces/ws-a/members/alice", {
      roles: ["workspace.viewer"],
    });
    assert.equal(response.status, 201);
    assert.equal(response.json.created, true);
    response = await call("manager-token", "PUT", "/admin/workspaces/ws-a/members/alice", {
      roles: ["workspace.admin"],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.member.roles, ["workspace.admin"]);
    response = await call("manager-token", "PUT", "/admin/workspaces/ws-a/members/eve", {
      roles: ["admin.owner"],
    });
    assert.equal(response.status, 400, "an admin role is never granted inside a workspace");
    response = await call("manager-token", "PUT", "/admin/workspaces/ws-missing/members/alice", { roles: [] });
    assert.equal(response.status, 404);
    // Express decodes the path, so an encoded user id is the id itself.
    response = await call("manager-token", "PUT", "/admin/workspaces/ws-a/members/user%40example.com", {});
    assert.equal(response.json.member.userId, "user@example.com");

    response = await call("manager-token", "GET", "/admin/workspaces/ws-a/members/alice");
    assert.deepEqual(response.json.member.roles, ["workspace.admin"]);
    response = await call("manager-token", "GET", "/admin/workspaces/ws-a/members");
    assert.deepEqual(response.json.members.map((member) => member.userId), ["alice", "user@example.com"]);
    response = await call("manager-token", "GET", "/admin/workspaces/ws-missing/members");
    assert.equal(response.status, 404);

    response = await call("manager-token", "DELETE", "/admin/workspaces/ws-a/members/alice");
    assert.deepEqual(response.json, { removed: true });
    response = await call("manager-token", "DELETE", "/admin/workspaces/ws-a/members/alice");
    assert.equal(response.status, 404);
    assert.equal(response.json.code, "WORKSPACE_MEMBER_NOT_FOUND");
    response = await call("manager-token", "GET", "/admin/workspaces/ws-a/members/alice");
    assert.equal(response.status, 404);

    // Every registry call ran on the system path.
    assert.ok(harness.contexts.length > 15);
    assert.deepEqual([...new Set(harness.contexts.map((entry) => entry.context))], ["system"]);
  } finally {
    await harness.close();
  }
});

test("only admin.owner and admin.tenant_manager hold the permissions; every decision is audited", async () => {
  const harness = await setup();
  const { call } = harness;

  try {
    await harness.registry.createWorkspace({ workspaceId: "ws-a" });

    for (const token of ["operator-token", "viewer-token", "member-token", "workspace-admin-token"]) {
      for (const [method, requestPath, body] of [
        ["GET", "/admin/workspaces"],
        ["POST", "/admin/workspaces", { id: "ws-z" }],
        ["GET", "/admin/workspaces/ws-a/members"],
        ["PUT", "/admin/workspaces/ws-a/members/mallory", { roles: ["workspace.admin"] }],
        ["POST", "/admin/workspaces/ws-a/actions/suspend", {}],
      ]) {
        const response = await call(token, method, requestPath, body);

        assert.equal(response.status, 403, `${token} ${method} ${requestPath}`);
        assert.equal(response.json.adminAuthorization.reason, "denied_missing_permission");
      }
    }

    assert.equal((await call("owner-token", "GET", "/admin/workspaces")).status, 200);
    assert.equal(
      (await call(null, "GET", "/admin/workspaces")).status,
      401,
      "no credential, no answer"
    );
    assert.equal((await harness.registry.getWorkspace("ws-a")).status, "active");
    assert.equal(await harness.registry.getWorkspace("ws-z"), null);
    assert.equal(await harness.registry.getMember("ws-a", "mallory"), null);

    const { events } = await harness.auditService.listEvents({ accessScope: {}, limit: 200 });
    const denied = events.filter((event) => event.result === "denied");
    const suspendDenial = denied.find(
      (event) => event.request.path === "/admin/workspaces/ws-a/actions/suspend"
    );

    assert.ok(denied.length >= 20, `expected the denials in the audit store, got ${denied.length}`);
    assert.equal(suspendDenial.authorization.permissionId, "admin.tenants.write");
    assert.equal(suspendDenial.authorization.actionId, "suspend");
    assert.ok(
      events.some(
        (event) =>
          event.result === "allowed" &&
          event.authorization.permissionId === "admin.tenants.read" &&
          event.authorization.roleId === "admin.owner"
      )
    );
  } finally {
    await harness.close();
  }
});

test("a workspace-scoped holder reaches its own workspace only and may not register or change a status", async () => {
  const harness = await setup();
  const { call } = harness;

  try {
    await harness.registry.createWorkspace({ plan: "team", workspaceId: "ws-a" });
    await harness.registry.createWorkspace({ plan: "secret-plan", workspaceId: "ws-b" });
    await harness.registry.putMember({ roles: ["workspace.admin"], userId: "bea", workspaceId: "ws-b" });

    let response = await call("scoped-manager-token", "GET", "/admin/workspaces");
    assert.deepEqual(response.json.workspaces.map((workspace) => workspace.workspaceId), ["ws-a"]);
    response = await call("scoped-manager-token", "GET", "/admin/workspaces?status=suspended");
    assert.deepEqual(response.json.workspaces, []);

    response = await call("scoped-manager-token", "GET", "/admin/workspaces/ws-a");
    assert.equal(response.json.workspace.plan, "team");
    response = await call("scoped-manager-token", "PUT", "/admin/workspaces/ws-a/members/mia", {
      roles: ["workspace.member"],
    });
    assert.equal(response.status, 201);
    response = await call("scoped-manager-token", "GET", "/admin/workspaces/ws-a/members");
    assert.deepEqual(response.json.members.map((member) => member.userId), ["mia"]);

    // Another workspace answers exactly like one that does not exist.
    for (const [method, requestPath, body] of [
      ["GET", "/admin/workspaces/ws-b"],
      ["GET", "/admin/workspaces/ws-b/members"],
      ["GET", "/admin/workspaces/ws-b/members/bea"],
      ["PUT", "/admin/workspaces/ws-b/members/sam", { roles: ["workspace.admin"] }],
      ["DELETE", "/admin/workspaces/ws-b/members/bea"],
    ]) {
      const other = await call("scoped-manager-token", method, requestPath, body);
      const missing = await call("scoped-manager-token", method, requestPath.replace("ws-b", "ws-none"), body);

      assert.equal(other.status, 404, `${method} ${requestPath}`);
      assert.deepEqual(other.json, missing.json, `${method} ${requestPath} reveals nothing`);
      assert.equal(JSON.stringify(other.json).includes("secret-plan"), false);
    }

    for (const [method, requestPath, body] of [
      ["POST", "/admin/workspaces", { id: "ws-c" }],
      ["POST", "/admin/workspaces/ws-a/actions/suspend", {}],
      ["POST", "/admin/workspaces/ws-b/actions/suspend", {}],
    ]) {
      const refused = await call("scoped-manager-token", method, requestPath, body);

      assert.equal(refused.status, 403, `${method} ${requestPath}`);
      assert.equal(refused.json.code, "TENANT_ADMIN_PLATFORM_ONLY");
    }

    assert.equal((await harness.registry.getWorkspace("ws-b")).status, "active");
    assert.equal((await harness.registry.getWorkspace("ws-a")).status, "active");
    assert.equal(await harness.registry.getWorkspace("ws-c"), null);
    assert.deepEqual(
      (await harness.registry.listMembers("ws-b")).map((member) => member.userId),
      ["bea"]
    );
  } finally {
    await harness.close();
  }
});

test("PATCH /admin/workspaces/:workspaceId replaces the retention policy: platform only, validated, audited, refused while deleting", async () => {
  const harness = await setup();
  const { call } = harness;

  try {
    await harness.registry.createWorkspace({ retentionPolicy: { agentRuns: 30 }, workspaceId: "ws-a" });
    await harness.registry.createWorkspace({ workspaceId: "ws-gone" });

    let response = await call("manager-token", "PATCH", "/admin/workspaces/ws-a", {
      retentionPolicy: { feedback: 0, tasks: 90 },
    });
    assert.equal(response.status, 200);
    // The whole policy is replaced, not merged.
    assert.deepEqual(response.json.workspace.retentionPolicy, { feedback: 0, tasks: 90 });
    assert.deepEqual((await harness.registry.getWorkspace("ws-a")).retentionPolicy, { feedback: 0, tasks: 90 });

    response = await call("owner-token", "PATCH", "/admin/workspaces/ws-a", { retentionPolicy: null });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.workspace.retentionPolicy, {}, "null (or {}) clears every override");

    for (const body of [
      {},
      [],
      { retentionPolicy: "30d" },
      // Keys and values the sweep does not read are refused, as at creation.
      { retentionPolicy: { days: 30 } },
      { retentionPolicy: { agentRuns: -1 } },
      { retentionPolicy: { agentRuns: 1.5 } },
      { retentionPolicy: { agentRuns: 36501 } },
      // Only the policy may change here, and a workspaceId never names the target.
      { plan: "enterprise", retentionPolicy: {} },
      { retentionPolicy: {}, workspaceId: "ws-a" },
    ]) {
      response = await call("manager-token", "PATCH", "/admin/workspaces/ws-a", body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }

    assert.deepEqual((await harness.registry.getWorkspace("ws-a")).retentionPolicy, {});

    response = await call("manager-token", "PATCH", "/admin/workspaces/ws-missing", { retentionPolicy: {} });
    assert.equal(response.status, 404);
    assert.equal(response.json.code, "WORKSPACE_NOT_FOUND");

    await harness.registry.markWorkspaceDeleting("ws-gone");
    response = await call("manager-token", "PATCH", "/admin/workspaces/ws-gone", {
      retentionPolicy: { agentRuns: 0 },
    });
    assert.equal(response.status, 409);
    assert.equal(response.json.code, "WORKSPACE_DELETING");

    // A workspace-scoped holder may not change a policy, not even its own;
    // a holder without the permission is refused before that.
    for (const workspaceId of ["ws-a", "ws-gone"]) {
      response = await call("scoped-manager-token", "PATCH", `/admin/workspaces/${workspaceId}`, {
        retentionPolicy: { agentRuns: 1 },
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.code, "TENANT_ADMIN_PLATFORM_ONLY");
    }

    for (const token of ["operator-token", "viewer-token", "workspace-admin-token"]) {
      response = await call(token, "PATCH", "/admin/workspaces/ws-a", { retentionPolicy: { agentRuns: 1 } });
      assert.equal(response.status, 403, token);
      assert.equal(response.json.adminAuthorization.reason, "denied_missing_permission");
    }

    assert.deepEqual((await harness.registry.getWorkspace("ws-a")).retentionPolicy, {});

    const { events } = await harness.auditService.listEvents({ accessScope: {}, limit: 500 });
    const patches = events.filter(
      (event) => event.request?.method === "PATCH" && event.request?.path === "/admin/workspaces/ws-a"
    );

    assert.ok(
      patches.some((event) => event.result === "allowed" && event.authorization.permissionId === "admin.tenants.write")
    );
    assert.ok(patches.some((event) => event.result === "denied"));
    assert.deepEqual([...new Set(harness.contexts.map((entry) => entry.context))], ["system"]);
  } finally {
    await harness.close();
  }
});

test("RBAC enforce checks the same permissions app-wide first", async () => {
  const harness = await setup(authEnv({ RBAC_DEFAULT_ROLE: "none", RBAC_MODE: "enforce" }));
  const { call } = harness;

  try {
    let response = await call("manager-token", "POST", "/admin/workspaces", { id: "ws-a" });
    assert.equal(response.status, 201);

    // workspace.admin is a workspace role: it never carries an admin.*
    // permission, so RBAC denies before the route's own check.
    response = await call("workspace-admin-token", "GET", "/admin/workspaces");
    assert.equal(response.status, 403);
    assert.equal(response.json.code, RBAC_ERROR_CODE);
    assert.equal(response.json.permission, "admin.tenants.read");

    response = await call("operator-token", "PUT", "/admin/workspaces/ws-a/members/x", { roles: [] });
    assert.equal(response.status, 403);
    assert.equal(response.json.permission, "admin.tenants.write");
  } finally {
    await harness.close();
  }
});
