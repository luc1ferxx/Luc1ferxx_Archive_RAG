import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

import { bindDatabaseTenant, requireApiAuth } from "../auth.js";
import { createAdminAuditService, createInMemoryAdminAuditStore } from "../rag/admin-audit.js";
import { ADMIN_PERMISSION_IDS, getAdminRoleContract } from "../rag/admin-permissions.js";
import { getDatabaseTenantContext } from "../rag/postgres-tenant.js";
import { RBAC_ROUTE_TABLE } from "../rag/rbac.js";
import { createAdminUsageRouter } from "../routes/admin-usage.js";

const TOKENS = {
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
  "list-admin-token": { roles: ["admin.viewer"], userId: "lou", workspaces: ["ws-a", "ws-b"] },
  "platform-admin-token": { roles: ["admin.owner"] },
  "viewer-platform-token": { roles: ["admin.viewer"], userId: "vera" },
  "ws-admin-token": { roles: ["admin.viewer"], userId: "olga", workspaceId: "ws-a" },
};
const NOW = Date.UTC(2026, 9, 17, 12, 30);

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

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const get = async (server, requestPath, token, headers = {}) => {
  const response = await fetch(`${server.baseUrl}${requestPath}`, {
    headers: { ...(token ? { "x-api-key": token } : {}), ...headers },
  });

  return { body: await response.json(), headers: response.headers, status: response.status };
};

const withUsageApp = async (run, { env = {}, tenantRegistry = null } = {}) =>
  withEnv({ API_AUTH_ENABLED: "true", API_AUTH_TOKENS: JSON.stringify(TOKENS), RBAC_MODE: undefined, ...env }, async () => {
    const reads = [];
    const app = express();

    if (tenantRegistry) {
      app.locals.tenantRegistry = tenantRegistry;
    }

    app.use(requireApiAuth);
    app.use(bindDatabaseTenant);
    app.use(
      createAdminUsageRouter({
        adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore() }),
        listTenantUsageTop: async (options) => {
          reads.push({ context: getDatabaseTenantContext(), options });
          return {
            from: options.from.toISOString(),
            rows: [{ userId: "alice", value: 42, workspaceId: "ws-a" }],
            to: options.to.toISOString(),
          };
        },
        now: () => NOW,
      })
    );

    const server = await startServer(app);

    try {
      return await run({ reads, server });
    } finally {
      await server.close();
    }
  });

test("admin.usage.read exists, is granted to admin.viewer, operator and owner, and gates GET /admin/usage", () => {
  assert.equal(ADMIN_PERMISSION_IDS.adminUsageRead, "admin.usage.read");

  for (const role of ["admin.viewer", "admin.operator", "admin.owner"]) {
    assert.ok(getAdminRoleContract(role).permissionIds.includes("admin.usage.read"), role);
  }

  for (const role of ["admin.quality_operator", "admin.recovery_operator"]) {
    assert.equal(getAdminRoleContract(role).permissionIds.includes("admin.usage.read"), false, role);
  }

  const entry = RBAC_ROUTE_TABLE.find((route) => route.method === "GET" && route.path === "/admin/usage");

  assert.ok(entry, "GET /admin/usage is in RBAC_ROUTE_TABLE");
  assert.equal(entry.permission, "admin.usage.read");
});

test("a platform admin reads every tenant's usage as system work; defaults are model_tokens over the last 24 hours", async () => {
  await withUsageApp(async ({ reads, server }) => {
    const response = await get(server, "/admin/usage", "platform-admin-token");

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.scope, { kind: "platform" });
    assert.equal(response.body.metric, "model_tokens");
    assert.equal(response.body.groupBy, "tenant");
    assert.deepEqual(response.body.tenants, [{ userId: "alice", value: 42, workspaceId: "ws-a" }]);
    assert.equal(typeof response.body.ledger.enabled, "boolean");
    assert.equal(reads.length, 1);
    assert.equal(reads[0].context, "system");
    assert.equal(reads[0].options.workspaceId, null);
    assert.equal(reads[0].options.limit, 10);
    assert.equal(reads[0].options.to.getTime(), NOW);
    assert.equal(reads[0].options.from.getTime(), NOW - 24 * 60 * 60 * 1000);

    // A user-only admin with no workspace list is a platform admin too.
    assert.equal((await get(server, "/admin/usage", "viewer-platform-token")).body.scope.kind, "platform");

    // Naming a workspace narrows the platform view to it.
    const narrowed = await get(
      server,
      "/admin/usage?metric=ingested_bytes&groupBy=workspace&limit=3&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z",
      "platform-admin-token",
      { "x-workspace-id": "ws-b" }
    );

    assert.equal(narrowed.status, 200);
    assert.deepEqual(narrowed.body.scope, { kind: "workspace", workspaceId: "ws-b" });
    assert.deepEqual(
      {
        ...reads[2].options,
        from: reads[2].options.from.toISOString(),
        to: reads[2].options.to.toISOString(),
      },
      {
        from: "2026-10-01T00:00:00.000Z",
        groupBy: "workspace",
        limit: 3,
        metric: "ingested_bytes",
        to: "2026-10-02T00:00:00.000Z",
        workspaceId: "ws-b",
      }
    );
    assert.equal(reads[2].context, "system");
  });
});

test("a workspace-scoped admin reads its own workspace only; another workspace is refused by the auth layer", async () => {
  await withUsageApp(async ({ reads, server }) => {
    const own = await get(server, "/admin/usage?metric=chat_requests", "ws-admin-token");

    assert.equal(own.status, 200);
    assert.deepEqual(own.body.scope, { kind: "workspace", workspaceId: "ws-a" });
    assert.equal(reads.at(-1).options.workspaceId, "ws-a");
    assert.equal(reads.at(-1).context, "system");

    const other = await get(server, "/admin/usage?workspaceId=ws-b", "ws-admin-token");

    assert.equal(other.status, 403);
    assert.equal(reads.length, 1, "no read for the refused request");
  });
});

test("a workspace-list admin must name a workspace; a tenant without the permission is refused", async () => {
  await withUsageApp(async ({ reads, server }) => {
    const unnamed = await get(server, "/admin/usage", "list-admin-token");

    assert.equal(unnamed.status, 403);
    assert.match(unnamed.body.error, /name the workspace/);

    const named = await get(server, "/admin/usage", "list-admin-token", { "x-workspace-id": "ws-b" });

    assert.equal(named.status, 200);
    assert.deepEqual(named.body.scope, { kind: "workspace", workspaceId: "ws-b" });

    const tenant = await get(server, "/admin/usage", "alice-token");

    assert.equal(tenant.status, 403);
    assert.equal(reads.length, 1);
  });
});

test("TENANT_MEMBERSHIP=enforce: a platform admin still narrows the view to a workspace it is not a member of", async () => {
  const lookups = [];
  const tenantRegistry = {
    lookupMembership: async (workspaceId, userId) => {
      lookups.push(`member:${workspaceId}:${userId}`);
      return null;
    },
    lookupWorkspace: async (workspaceId) => {
      lookups.push(`workspace:${workspaceId}`);
      return workspaceId === "ws-a" ? { status: "active", workspaceId } : null;
    },
  };

  await withUsageApp(
    async ({ reads, server }) => {
      for (const [token, query, headers] of [
        ["platform-admin-token", "?workspaceId=ws-b", {}],
        ["platform-admin-token", "", { "x-workspace-id": "ws-b" }],
        // A platform admin with a user of its own (an OIDC admin) is no
        // member of ws-b either.
        ["viewer-platform-token", "?workspaceId=ws-b", {}],
      ]) {
        const narrowed = await get(server, `/admin/usage${query}`, token, headers);

        assert.equal(narrowed.status, 200, `${token} ${query}: ${JSON.stringify(narrowed.body)}`);
        assert.deepEqual(narrowed.body.scope, { kind: "workspace", workspaceId: "ws-b" });
        assert.equal(reads.at(-1).options.workspaceId, "ws-b");
      }

      assert.deepEqual(lookups, [], "the narrowing is a filter: no membership lookup");

      // A workspace-bound admin is still checked: ws-a is registered, but
      // olga is not a member of it.
      const bound = await get(server, "/admin/usage", "ws-admin-token");

      assert.equal(bound.status, 403);
      assert.equal(bound.body.code, "WORKSPACE_MEMBERSHIP_REQUIRED");
      assert.equal(reads.length, 3, "no read for the refused request");
    },
    { env: { TENANT_MEMBERSHIP: "enforce" }, tenantRegistry }
  );
});

test("bad parameters are refused before any read", async () => {
  await withUsageApp(async ({ reads, server }) => {
    for (const query of [
      "metric=tokens",
      "limit=0",
      "limit=101",
      "limit=abc",
      "groupBy=user",
      "from=yesterday",
      "from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z",
      "from=2020-01-01T00:00:00Z&to=2026-10-01T00:00:00Z",
    ]) {
      const response = await get(server, `/admin/usage?${query}`, "platform-admin-token");

      assert.equal(response.status, 400, query);
    }

    assert.equal(reads.length, 0);
  });
});

test("metric=refusals reads the per-tenant refusals, optionally one reason; reason needs that metric", async () => {
  await withUsageApp(async ({ reads, server }) => {
    const all = await get(server, "/admin/usage?metric=refusals", "platform-admin-token");

    assert.equal(all.status, 200);
    assert.equal(all.body.metric, "refusals");
    assert.equal(Object.hasOwn(all.body, "reason"), false);
    assert.equal(reads[0].options.metric, "refusals");
    assert.equal(Object.hasOwn(reads[0].options, "reason"), false);

    const one = await get(
      server,
      "/admin/usage?metric=refusals&reason=TENANT_RATE_LIMITED&groupBy=workspace",
      "ws-admin-token"
    );

    assert.equal(one.status, 200);
    assert.equal(one.body.reason, "TENANT_RATE_LIMITED");
    assert.deepEqual(one.body.scope, { kind: "workspace", workspaceId: "ws-a" });
    assert.equal(reads[1].options.reason, "TENANT_RATE_LIMITED");
    assert.equal(reads[1].options.workspaceId, "ws-a");
    assert.equal(reads[1].context, "system");

    for (const query of ["metric=refusals&reason=tenant_rate_limited", "metric=refusals&reason=NOPE", "reason=TENANT_RATE_LIMITED"]) {
      assert.equal((await get(server, `/admin/usage?${query}`, "platform-admin-token")).status, 400, query);
    }

    assert.equal(reads.length, 2);
  });
});

test("in the app: GET /admin/usage is mounted, open to a platform admin past the tenant gate, and needs a database", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "admin-usage-"));

  try {
    await withEnv(
      {
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKENS: JSON.stringify(TOKENS),
        LONG_MEMORY_DATABASE_URL: undefined,
        POSTGRES_DATABASE_URL: undefined,
      },
      async () => {
        const [{ createApp }, runs, artifacts, jobs, tasks] = await Promise.all([
          import("../app.js"),
          import("../rag/agent-runs.js"),
          import("../rag/workspace-artifacts/memory-store.js"),
          import("../rag/ingest-job-store.js"),
          import("../rag/tasks.js"),
        ]);
        const app = await createApp({
          adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore() }),
          agentRunStore: runs.createInMemoryAgentRunStore(),
          healthService: {
            buildHealthReport: async () => ({ checks: {}, status: "ok" }),
            runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
          },
          ingestJobStore: jobs.createInMemoryIngestJobStore(),
          ragService: {
            initializeDocumentRegistry: async () => [],
            initializeLongMemory: async () => true,
            initializeSessionMemory: async () => true,
            listDocuments: () => [],
          },
          taskStore: tasks.createInMemoryTaskStore(),
          uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
          uploadsDirectory: path.join(tempRoot, "uploads"),
          workspaceArtifactStore: artifacts.createInMemoryWorkspaceArtifactStore(),
        });
        const server = await startServer(app);

        try {
          const platform = await get(server, "/admin/usage", "platform-admin-token");

          assert.equal(platform.status, 409);
          assert.match(platform.body.error, /PostgreSQL/);
          assert.match(platform.headers.get("cache-control") ?? "", /no-store/);
          assert.equal((await get(server, "/admin/usage", "alice-token")).status, 403);
        } finally {
          await server.close();
          await app.locals.stop?.();
        }
      }
    );
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});
