// TENANT_MEMBERSHIP=enforce through the real createApp chain (auth.js
// requireApiAuth -> rag/tenant-registry.js decideTenantMembership), with an
// in-process tenant registry the test seeds directly. Off (the default) is
// checked to read nothing and change nothing.
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
import { RBAC_ERROR_CODE } from "../rag/rbac.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import {
  createInMemoryTenantRegistryStore,
  createTenantRegistryService,
  MAX_MEMBER_ROLES,
  MAX_SCOPE_WORKSPACE_ROLES,
  TENANT_MEMBERSHIP_CODES,
} from "../rag/tenant-registry.js";
import { createInMemoryWorkspaceArtifactStore } from "../rag/workspace-artifacts/index.js";

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
  "TENANT_MEMBERSHIP",
  "TENANT_REGISTRY_CACHE_TTL_MS",
];

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

const TOKENS = {
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
  "alice-suspended-token": { userId: "alice", workspaceId: "ws-s" },
  "alice-deleting-token": { userId: "alice", workspaceId: "ws-d" },
  "alice-multi-token": { userId: "alice", workspaces: ["ws-a", "ws-x"] },
  "alice-user-token": { userId: "alice" },
  "bob-token": { userId: "bob", workspaceId: "ws-a" },
  "carol-token": { userId: "carol", workspaceId: "ws-x" },
  "dave-token": { userId: "dave" },
  "delegating-token": { allowClientUserId: true },
  "header-token": { roles: ["workspace.member"] },
  "platform-token": { roles: ["admin.owner"] },
  "platform-user-token": { roles: ["admin.owner"], userId: "olga" },
  "rita-token": { userId: "rita", workspaceId: "ws-a", workspaceRoles: { "ws-a": ["custom.extra"] } },
  "rita-overlap-token": { userId: "rita", workspaceId: "ws-a", workspaceRoles: { "ws-a": ["custom.r00"] } },
  "ops-a-token": { roles: ["admin.viewer"], userId: "ops", workspaceId: "ws-a" },
  "ops-s-token": { roles: ["admin.viewer"], userId: "ops", workspaceId: "ws-s" },
  "ws-a-token": { workspaceId: "ws-a" },
  "ws-s-token": { workspaceId: "ws-s" },
  "ws-x-token": { workspaceId: "ws-x" },
  "ws-list-token": { workspaces: ["ws-a", "ws-x"] },
};

const authEnv = (extra = {}) => ({
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify(TOKENS),
  ...extra,
});

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-membership-"));
  configureFeedbackDirectory(path.join(tempRoot, "feedback"));
});

after(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

// Records every store read, so a test can say whether enforcement looked.
const createSeededRegistry = async ({ failing = false } = {}) => {
  const store = createInMemoryTenantRegistryStore();
  const reads = [];
  const registry = createTenantRegistryService({
    store: {
      ...store,
      async getMember(workspaceId, userId) {
        reads.push(`member:${workspaceId}:${userId}`);
        if (failing) throw new Error("database unreachable");
        return store.getMember(workspaceId, userId);
      },
      async getWorkspace(workspaceId) {
        reads.push(`workspace:${workspaceId}`);
        if (failing) throw new Error("database unreachable");
        return store.getWorkspace(workspaceId);
      },
    },
  });

  // Seeded on the store itself, so the reads above count requests only.
  const seed = createTenantRegistryService({ store });

  await seed.createWorkspace({ workspaceId: "ws-a" });
  await seed.createWorkspace({ status: "suspended", workspaceId: "ws-s" });
  await seed.createWorkspace({ workspaceId: "ws-d" });
  await seed.putMember({ roles: ["workspace.viewer"], userId: "alice", workspaceId: "ws-a" });
  await seed.putMember({ userId: "alice", workspaceId: "ws-s" });
  await seed.putMember({ userId: "alice", workspaceId: "ws-d" });
  await seed.putMember({ userId: "ops", workspaceId: "ws-a" });
  await seed.putMember({ userId: "ops", workspaceId: "ws-s" });
  // A deleting workspace takes no new members, so it is marked last.
  await seed.setWorkspaceStatus("ws-d", "deleting");

  return { reads, registry };
};

const createApp = (registry, options = {}) =>
  createProductionApp({
    adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore() }),
    agentRunStore: createInMemoryAgentRunStore(),
    executionPlannerAdapter: deterministicPlannerAdapter,
    feedbackStore: createFileFeedbackStore(),
    healthService: okHealthService,
    ingestJobStore: createInMemoryIngestJobStore(),
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService: {
      deleteDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeLongMemory: async () => true,
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
    },
    taskStore: createInMemoryTaskStore(),
    tenantRegistry: registry,
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
    ...options,
  });

const startServer = async (app) => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const call = async (server, { body, headers = {}, method = "GET", path: requestPath }) => {
  const response = await fetch(`${server.baseUrl}${requestPath}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    method,
  });
  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { json, status: response.status, text };
};

const asToken = (token, extra = {}) => ({ "x-api-key": token, ...extra });

const withServer = async (env, registry, run, options) =>
  withEnv(env, async () => {
    const server = await startServer(await createApp(registry, options));

    try {
      return await run(server);
    } finally {
      await server.close();
    }
  });

const assertRefusal = (response, code, label) => {
  assert.equal(response.status, code === TENANT_MEMBERSHIP_CODES.registryUnavailable ? 503 : 403, label);
  assert.deepEqual(Object.keys(response.json ?? {}).sort(), ["code", "error"], label);
  assert.equal(response.json.code, code, label);
};

test("TENANT_MEMBERSHIP off (default): nothing is read and nothing is refused", async () => {
  const { reads, registry } = await createSeededRegistry();

  await withServer(authEnv(), registry, async (server) => {
    for (const [token, extra] of [
      ["alice-token", {}],
      ["bob-token", {}],
      ["carol-token", {}],
      ["ws-x-token", {}],
      ["ws-s-token", {}],
      ["header-token", { "x-workspace-id": "ws-anything" }],
    ]) {
      const response = await call(server, { headers: asToken(token, extra), path: "/documents" });

      assert.equal(response.status, 200, token);
    }

    // No role is added from the registry either (workspace.member is the
    // RBAC default role, as before).
    const me = await call(server, { headers: asToken("alice-token"), path: "/auth/me" });
    assert.deepEqual(me.json.roles, ["workspace.member"]);
  });

  assert.deepEqual(reads, []);
});

test("enforce: a member of an active workspace passes and its membership roles reach RBAC", async () => {
  const { registry } = await createSeededRegistry();

  await withServer(
    authEnv({ RBAC_DEFAULT_ROLE: "none", RBAC_MODE: "enforce", TENANT_MEMBERSHIP: "enforce" }),
    registry,
    async (server) => {
      let response = await call(server, { headers: asToken("alice-token"), path: "/documents" });
      assert.equal(response.status, 200);

      response = await call(server, { headers: asToken("alice-token"), path: "/auth/me" });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json.roles, ["workspace.viewer"]);
      assert.deepEqual(response.json.permissions, ["chat.ask", "documents.read"]);

      // A viewer may not delete...
      response = await call(server, {
        headers: asToken("alice-token"),
        method: "DELETE",
        path: "/documents/doc-1",
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.code, RBAC_ERROR_CODE);

      // ...until a platform admin makes her the workspace's admin; the change
      // applies to her next request in this process.
      response = await call(server, {
        body: { roles: ["workspace.admin"] },
        headers: asToken("platform-token"),
        method: "PUT",
        path: "/admin/workspaces/ws-a/members/alice",
      });
      assert.equal(response.status, 200);

      response = await call(server, {
        headers: asToken("alice-token"),
        method: "DELETE",
        path: "/documents/doc-1",
      });
      assert.equal(response.status, 404, "past RBAC, the stub registry has no such document");

      // The role applies inside ws-a only: alice's list token choosing ws-x
      // is not a member there at all.
      response = await call(server, {
        headers: asToken("alice-multi-token", { "x-workspace-id": "ws-x" }),
        path: "/documents",
      });
      assertRefusal(response, TENANT_MEMBERSHIP_CODES.membershipRequired, "alice in ws-x");
      response = await call(server, {
        headers: asToken("alice-multi-token", { "x-workspace-id": "ws-a" }),
        path: "/documents",
      });
      assert.equal(response.status, 200);
    }
  );
});

test("enforce: a non-member, an unregistered, suspended or deleting workspace and a header-chosen workspace are refused", async () => {
  const { registry } = await createSeededRegistry();

  await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), registry, async (server) => {
    const cases = [
      ["bob-token", {}, TENANT_MEMBERSHIP_CODES.membershipRequired],
      // A non-member learns nothing about the workspace: an unregistered one
      // answers the same.
      ["carol-token", {}, TENANT_MEMBERSHIP_CODES.membershipRequired],
      ["ws-x-token", {}, TENANT_MEMBERSHIP_CODES.notRegistered],
      ["ws-s-token", {}, TENANT_MEMBERSHIP_CODES.workspaceSuspended],
      ["alice-suspended-token", {}, TENANT_MEMBERSHIP_CODES.workspaceSuspended],
      ["alice-deleting-token", {}, TENANT_MEMBERSHIP_CODES.workspaceDeleting],
      // A principal without a workspace list can no longer pick a workspace
      // by header: nothing ties it to the one it names.
      ["header-token", { "x-workspace-id": "ws-a" }, TENANT_MEMBERSHIP_CODES.membershipRequired],
      // A delegating token may name its user, who must then be a member.
      [
        "delegating-token",
        { "x-user-id": "bob", "x-workspace-id": "ws-a" },
        TENANT_MEMBERSHIP_CODES.membershipRequired,
      ],
    ];

    for (const [token, extra, code] of cases) {
      for (const [method, requestPath] of [
        ["GET", "/documents"],
        ["GET", "/auth/me"],
        ["POST", "/chat"],
      ]) {
        const response = await call(server, {
          body: method === "POST" ? {} : undefined,
          headers: asToken(token, extra),
          method,
          path: requestPath,
        });

        assertRefusal(response, code, `${token} ${method} ${requestPath}`);
      }
    }

    const messages = await call(server, { headers: asToken("ws-s-token"), path: "/documents" });
    assert.equal(messages.json.error, "This workspace is suspended.");

    // The ones that pass.
    for (const [token, extra] of [
      ["alice-token", {}],
      ["ws-a-token", {}],
      ["delegating-token", { "x-user-id": "alice", "x-workspace-id": "ws-a" }],
    ]) {
      const response = await call(server, { headers: asToken(token, extra), path: "/documents" });

      assert.equal(response.status, 200, token);
    }
  });
});

test("enforce: auth off, the single shared token, a scope without a workspace and platform paths are not checked", async () => {
  const { reads, registry } = await createSeededRegistry();

  await withServer({ TENANT_MEMBERSHIP: "enforce" }, registry, async (server) => {
    const response = await call(server, { headers: { "x-workspace-id": "ws-unknown" }, path: "/documents" });

    assert.equal(response.status, 200, "auth off");
  });

  await withServer(
    { API_AUTH_ENABLED: "true", API_AUTH_TOKEN: "shared-token", TENANT_MEMBERSHIP: "enforce" },
    registry,
    async (server) => {
      const response = await call(server, {
        headers: asToken("shared-token", { "x-workspace-id": "ws-unknown" }),
        path: "/documents",
      });

      assert.equal(response.status, 200, "the single shared token");
    }
  );

  await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), registry, async (server) => {
    let response = await call(server, { headers: asToken("dave-token"), path: "/documents" });
    assert.equal(response.status, 200, "a user-only tenant names no workspace");

    for (const requestPath of ["/admin/status", "/admin/audit", "/auth/me", "/admin/workspaces"]) {
      response = await call(server, { headers: asToken("platform-token"), path: requestPath });
      assert.equal(response.status, 200, `platform admin ${requestPath}`);
    }
  });

  assert.deepEqual(reads, [], "none of these read the registry");
});

test("enforce: suspending and activating through the admin API take effect on the next request", async () => {
  const { registry } = await createSeededRegistry();

  await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), registry, async (server) => {
    const documents = () => call(server, { headers: asToken("alice-token"), path: "/documents" });
    const action = (name) =>
      call(server, {
        body: {},
        headers: asToken("platform-token"),
        method: "POST",
        path: `/admin/workspaces/ws-a/actions/${name}`,
      });

    assert.equal((await documents()).status, 200);
    assert.equal((await action("suspend")).json.workspace.status, "suspended");
    assertRefusal(await documents(), TENANT_MEMBERSHIP_CODES.workspaceSuspended, "after suspend");
    assert.equal((await action("activate")).json.workspace.status, "active");
    assert.equal((await documents()).status, 200);

    // Removing the membership refuses her next request too.
    const removed = await call(server, {
      headers: asToken("platform-token"),
      method: "DELETE",
      path: "/admin/workspaces/ws-a/members/alice",
    });
    assert.deepEqual(removed.json, { removed: true });
    assertRefusal(await documents(), TENANT_MEMBERSHIP_CODES.membershipRequired, "after removal");
  });
});

test("enforce: a registry that cannot answer refuses with 503, never lets the request through", async () => {
  const { registry } = await createSeededRegistry({ failing: true });
  const originalError = console.error;
  console.error = () => {};

  try {
    await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), registry, async (server) => {
      for (const token of ["alice-token", "ws-a-token"]) {
        const response = await call(server, { headers: asToken(token), path: "/documents" });

        assertRefusal(response, TENANT_MEMBERSHIP_CODES.registryUnavailable, token);
        assert.equal(response.text.includes("database unreachable"), false);
      }
    });
  } finally {
    console.error = originalError;
  }
});

test("enforce: the probes show their details only to a scope requireApiAuth would let through", async () => {
  const { registry } = await createSeededRegistry();

  await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), registry, async (server) => {
    const member = await call(server, { headers: asToken("ops-a-token"), path: "/livez" });

    assert.equal(member.status, 200);
    assert.ok("role" in member.json, "an admin.viewer in an active workspace reads the details");

    const suspended = await call(server, { headers: asToken("ops-s-token"), path: "/livez" });

    assert.equal(suspended.status, 200, "the probe still answers");
    assert.deepEqual(suspended.json, { status: "ok" }, "a suspended workspace's credential reads the status only");
  });
});

test("an unknown TENANT_MEMBERSHIP refuses the start; enforce initializes the registry at start-up, off does not", async () => {
  const registry = createTenantRegistryService({ store: createInMemoryTenantRegistryStore() });
  let initialized = 0;
  const watched = { ...registry, initialize: async () => { initialized += 1; return true; } };

  await withEnv(authEnv({ TENANT_MEMBERSHIP: "on" }), async () => {
    await assert.rejects(() => createApp(watched), /TENANT_MEMBERSHIP must be one of off, enforce/);
  });
  assert.equal(initialized, 0);

  await withEnv(authEnv(), async () => {
    await createApp(watched);
  });
  assert.equal(initialized, 0, "off: the registry is initialized lazily");

  await withEnv(authEnv({ TENANT_MEMBERSHIP: "enforce" }), async () => {
    await createApp(watched);
  });
  assert.equal(initialized, 1);
});

test("enforce: a platform admin narrowing GET /admin/audit or /admin/usage to a workspace is not asked for a membership", async () => {
  const { reads, registry } = await createSeededRegistry();

  await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), registry, async (server) => {
    // A platform admin (no fixed workspace, no workspace list), with or
    // without a user of its own, names the workspace to read: a filter over a
    // read its admin permission allows across tenants, also for a workspace
    // it is not a member of, an unregistered one or a suspended one.
    for (const token of ["platform-token", "platform-user-token"]) {
      for (const [requestPath, headers] of [
        ["/admin/audit?workspaceId=ws-a", {}],
        ["/admin/audit", { "x-workspace-id": "ws-a" }],
        ["/admin/audit", { "x-workspace-id": "ws-unknown" }],
        ["/admin/audit?workspaceId=ws-s", {}],
      ]) {
        const response = await call(server, { headers: asToken(token, headers), path: requestPath });

        assert.equal(response.status, 200, `${token} ${requestPath} ${JSON.stringify(headers)}: ${response.text}`);
      }

      // GET /admin/usage reaches its route too (409 here: no database), not
      // the membership refusal.
      const usage = await call(server, {
        headers: asToken(token, { "x-workspace-id": "ws-a" }),
        path: "/admin/usage",
      });

      assert.notEqual(usage.status, 403, `${token} /admin/usage: ${usage.text}`);
      assert.equal(Object.values(TENANT_MEMBERSHIP_CODES).includes(usage.json?.code), false);
    }

    assert.deepEqual(reads, [], "a narrowed platform read does not consult the registry");

    // The exemption is only that: the same admin acting in the workspace
    // elsewhere is still checked...
    assertRefusal(
      await call(server, { headers: asToken("platform-token", { "x-workspace-id": "ws-a" }), path: "/documents" }),
      TENANT_MEMBERSHIP_CODES.membershipRequired,
      "platform admin on /documents"
    );
    // ...a credential without the admin permission is refused by the route's
    // permission check (not let through)...
    const tenant = await call(server, {
      headers: asToken("header-token", { "x-workspace-id": "ws-a" }),
      path: "/admin/audit",
    });

    assert.equal(tenant.status, 403);
    assert.equal(Object.values(TENANT_MEMBERSHIP_CODES).includes(tenant.json?.code), false);
    // ...and a principal bound to a workspace is checked on these paths too.
    assertRefusal(
      await call(server, { headers: asToken("ops-s-token"), path: "/admin/audit" }),
      TENANT_MEMBERSHIP_CODES.workspaceSuspended,
      "workspace-bound admin of a suspended workspace"
    );
  });
});

test("enforce: a membership whose roles and the credential's exceed the forwarded bound is refused in every topology", async () => {
  const store = createInMemoryTenantRegistryStore();
  const registry = createTenantRegistryService({ store });
  const memberRoles = Array.from({ length: MAX_MEMBER_ROLES }, (_, index) => `custom.r${String(index).padStart(2, "0")}`);

  await registry.createWorkspace({ workspaceId: "ws-a" });
  await registry.putMember({ roles: memberRoles, userId: "rita", workspaceId: "ws-a" });

  assert.equal(MAX_SCOPE_WORKSPACE_ROLES, MAX_MEMBER_ROLES);

  await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), registry, async (server) => {
    // 32 membership roles plus one more from the token: 33 distinct roles,
    // which the split edge cannot sign into the agent tier's token, so the
    // monolith refuses them too instead of answering what a split deployment
    // would fail with 502.
    for (const [method, requestPath] of [
      ["GET", "/documents"],
      ["POST", "/chat"],
    ]) {
      assertRefusal(
        await call(server, {
          body: method === "POST" ? {} : undefined,
          headers: asToken("rita-token"),
          method,
          path: requestPath,
        }),
        TENANT_MEMBERSHIP_CODES.rolesLimitExceeded,
        `rita ${method} ${requestPath}`
      );
    }

    // A token role the membership already grants adds nothing: 32, allowed.
    const overlap = await call(server, { headers: asToken("rita-overlap-token"), path: "/documents" });

    assert.equal(overlap.status, 200, overlap.text);
  });
});

test("enforce: GET /auth/me lists a user-only credential's active memberships; a fixed or listed credential keeps its own", async () => {
  const { reads, registry } = await createSeededRegistry();
  const me = async (server, token, extra = {}) => call(server, { headers: asToken(token, extra), path: "/auth/me" });

  // Off (the default): nothing is read and nothing is added.
  await withServer(authEnv(), registry, async (server) => {
    const response = await me(server, "alice-user-token");

    assert.equal(response.status, 200);
    assert.deepEqual(response.json.workspaceIds, []);
    assert.equal(Object.hasOwn(response.json, "workspaceRequired"), false);
  });
  assert.deepEqual(reads, []);

  await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), registry, async (server) => {
    // alice is a member of ws-a (active), ws-s (suspended) and ws-d
    // (deleting): only the active one is offered.
    let response = await me(server, "alice-user-token");

    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.workspaceId, "");
    assert.deepEqual(response.json.workspaceIds, ["ws-a"]);

    // With the workspace named, the membership check passes and the same
    // list comes back (the SPA's OIDC reload after a switch).
    response = await me(server, "alice-user-token", { "x-workspace-id": "ws-a" });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.workspaceIds, ["ws-a"]);

    // Its own fixed workspace or list is all a credential may use, so nothing
    // is added; a user without memberships gets none.
    assert.deepEqual((await me(server, "alice-token")).json.workspaceIds, ["ws-a"]);
    assert.deepEqual([...(await me(server, "alice-multi-token")).json.workspaceIds].sort(), ["ws-a", "ws-x"]);
    assert.deepEqual((await me(server, "dave-token")).json.workspaceIds, []);
  });

  // A registry that cannot answer refuses, as the membership check does.
  const failing = await createSeededRegistry({ failing: true });
  const originalError = console.error;
  console.error = () => {};

  try {
    await withServer(authEnv({ TENANT_MEMBERSHIP: "enforce" }), failing.registry, async (server) => {
      const response = await me(server, "alice-user-token");

      assert.equal(response.status, 503);
      assert.equal(response.json.code, TENANT_MEMBERSHIP_CODES.registryUnavailable);
      assert.equal(response.text.includes("database unreachable"), false);
    });
  } finally {
    console.error = originalError;
  }
});

test("GET /auth/me answers a workspace-list credential without a user, and says when a workspace is required", async () => {
  const { registry } = await createSeededRegistry();

  for (const required of [false, true]) {
    await withServer(authEnv(required ? { API_AUTH_REQUIRE_WORKSPACE: "true" } : {}), registry, async (server) => {
      // No user, no fixed workspace, two listed: a tenantless scope, which
      // only /auth/me answers.
      const response = await call(server, { headers: asToken("ws-list-token"), path: "/auth/me" });

      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.userId, "");
      assert.deepEqual([...response.json.workspaceIds].sort(), ["ws-a", "ws-x"]);
      assert.equal(response.json.workspaceRequired, required ? true : undefined);

      const documents = await call(server, { headers: asToken("ws-list-token"), path: "/documents" });

      assert.equal(documents.status, 403, "every other route still needs a workspace");

      const named = await call(server, {
        headers: asToken("ws-list-token", { "x-workspace-id": "ws-a" }),
        path: "/documents",
      });

      assert.equal(named.status, 200, named.text);
    });
  }
});
