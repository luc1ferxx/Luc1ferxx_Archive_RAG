import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../app.js";
import { AGENT_EDGE_ROUTES } from "../rag/agent-service/edge-router.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import {
  matchRbacRoute,
  RBAC_ERROR_CODE,
  RBAC_PERMISSION_IDS,
  RBAC_ROUTE_ACCESS,
  RBAC_ROUTE_TABLE,
} from "../rag/rbac.js";

const RBAC_ENV_KEYS = [
  "API_AUTH_ENABLED",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "RBAC_DEFAULT_ROLE",
  "RBAC_MODE",
  "RBAC_POLICY_FILE",
  "RBAC_POLICY_JSON",
];

const withEnv = async (values, run) => {
  const original = Object.fromEntries(RBAC_ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of RBAC_ENV_KEYS) {
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

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const startServer = async (app) => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const createTestApp = async (tempRoot) =>
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
  });

const collectRoutes = (stack, routes = []) => {
  for (const layer of stack ?? []) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    } else if (layer.handle?.stack) {
      collectRoutes(layer.handle.stack, routes);
    }
  }

  return routes;
};

const samplePath = (routePath) =>
  routePath
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `sample-${segment.slice(1)}` : segment))
    .join("/");

const TOKENS = {
  "admin-viewer-token": { roles: ["admin.viewer"], userId: "victor", workspaceId: "ws-a" },
  "member-token": { roles: ["workspace.member"], userId: "mia", workspaceId: "ws-a" },
  "no-role-token": { userId: "nora", workspaceId: "ws-a" },
  "owner-token": { roles: ["admin.owner"], userId: "olga", workspaceId: "ws-a" },
  "viewer-token": { roles: ["workspace.viewer"], userId: "vera", workspaceId: "ws-a" },
};

const authEnv = (extra = {}) => ({
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKEN: "",
  API_AUTH_TOKENS: JSON.stringify(TOKENS),
  ...extra,
});

const call = (server, token, method, route, body) =>
  fetch(`${server.baseUrl}${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "x-api-key": token,
    },
    method,
  });

const isRbacDenial = async (response) => {
  if (response.status !== 403) return false;
  const body = await response.clone().json().catch(() => ({}));
  return body.code === RBAC_ERROR_CODE;
};

test("every route of the app has an RBAC route table entry that resolves to itself", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rbac-routes-"));

  try {
    await withEnv({}, async () => {
      const app = await createTestApp(tempRoot);
      const routes = collectRoutes(app._router.stack);
      const tableKeys = new Set(RBAC_ROUTE_TABLE.map((entry) => `${entry.method} ${entry.path}`));
      const missing = [];
      const misrouted = [];

      assert.ok(routes.length > 40, "router walk found too few routes");

      for (const route of routes) {
        if (!tableKeys.has(`${route.method} ${route.path}`)) {
          missing.push(`${route.method} ${route.path}`);
          continue;
        }

        const match = matchRbacRoute(route.method, samplePath(route.path));
        if (match?.entry.path !== route.path) {
          misrouted.push(`${route.method} ${route.path} -> ${match?.entry.path ?? "none"}`);
        }
      }

      assert.deepEqual(missing, [], "routes without an RBAC_ROUTE_TABLE entry");
      assert.deepEqual(misrouted, [], "table entries the matcher resolves to another route");

      // Every entry is a real route (GET /auth/config belongs to the OIDC track
      // and may not be mounted yet).
      const appKeys = new Set(routes.map((route) => `${route.method} ${route.path}`));
      const stale = [...tableKeys].filter(
        (key) => !appKeys.has(key) && key !== "GET /auth/config"
      );
      assert.deepEqual(stale, [], "route table entries without a route");

      // The split edge forwards the same chat/task routes after the same check.
      for (const route of AGENT_EDGE_ROUTES) {
        assert.ok(
          tableKeys.has(`${route.method.toUpperCase()} ${route.path}`),
          `${route.method} ${route.path}`
        );
      }

      for (const entry of RBAC_ROUTE_TABLE) {
        if (entry.access === RBAC_ROUTE_ACCESS.public) {
          assert.ok(
            ["/livez", "/health", "/ready", "/auth/config"].includes(entry.path),
            `${entry.path} must not be public`
          );
        }
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("RBAC enforce: viewer reads and chats, member uploads, only admins delete, denials are audited", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rbac-enforce-"));

  try {
    await withEnv(authEnv({ RBAC_DEFAULT_ROLE: "none", RBAC_MODE: "enforce" }), async () => {
      const server = await startServer(await createTestApp(tempRoot));

      try {
        // Viewer: read + chat.
        let response = await call(server, "viewer-token", "GET", "/documents");
        assert.equal(response.status, 200);
        response = await call(server, "viewer-token", "POST", "/chat", {});
        assert.equal(await isRbacDenial(response), false);
        assert.equal(response.status, 400, "past RBAC, the chat validation answers");
        response = await call(server, "viewer-token", "POST", "/upload/init", {});
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), {
          code: RBAC_ERROR_CODE,
          error: "Forbidden.",
          permission: RBAC_PERMISSION_IDS.documentsWrite,
        });
        response = await call(server, "viewer-token", "DELETE", "/documents/doc-1");
        assert.equal(await isRbacDenial(response), true);

        // Member: upload, not delete.
        response = await call(server, "member-token", "POST", "/upload/init", {});
        assert.equal(await isRbacDenial(response), false);
        response = await call(server, "member-token", "DELETE", "/documents/doc-1");
        const memberDenial = await response.json();
        assert.equal(response.status, 403);
        assert.equal(memberDenial.permission, RBAC_PERMISSION_IDS.documentsDelete);
        assert.equal(JSON.stringify(memberDenial).includes("member-token"), false);

        // No role at all (default role off): nothing but /auth/me.
        response = await call(server, "no-role-token", "GET", "/documents");
        assert.equal(await isRbacDenial(response), true);
        response = await call(server, "no-role-token", "GET", "/auth/me");
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).permissions, []);

        // Global admin roles keep working.
        response = await call(server, "owner-token", "DELETE", "/documents/doc-1");
        assert.equal(response.status, 404, "past RBAC, the stub registry has no such document");
        response = await call(server, "admin-viewer-token", "GET", "/admin/status");
        assert.equal(await isRbacDenial(response), false);
        response = await call(server, "admin-viewer-token", "GET", "/admin/audit");
        assert.equal(await isRbacDenial(response), true);

        // A path outside the table is denied, not passed through.
        response = await call(server, "owner-token", "GET", "/not-a-route");
        assert.equal(response.status, 403);
        assert.equal((await response.json()).permission, null);

        // Denials are in the admin audit store with ids only.
        response = await call(server, "owner-token", "GET", "/admin/audit?result=denied&limit=50");
        assert.equal(response.status, 200);
        const audit = await response.json();
        const rbacEvents = audit.events.filter((event) =>
          event.authorization.reason.startsWith("rbac_")
        );
        assert.ok(rbacEvents.length >= 5, `expected RBAC denials, got ${rbacEvents.length}`);
        const memberEvent = rbacEvents.find((event) => event.principal.userId === "mia");
        assert.equal(memberEvent.authorization.permissionId, RBAC_PERMISSION_IDS.documentsDelete);
        assert.equal(memberEvent.request.method, "DELETE");
        assert.equal(memberEvent.request.path, "/documents/doc-1");
        for (const token of Object.keys(TOKENS)) {
          assert.equal(JSON.stringify(audit).includes(token), false);
        }

        // /auth/me: contract shape, effective permissions, no credential.
        response = await call(server, "viewer-token", "GET", "/auth/me");
        assert.equal(response.status, 200);
        const me = await response.json();
        assert.deepEqual(me, {
          authProvider: "static_token",
          permissions: [RBAC_PERMISSION_IDS.chatAsk, RBAC_PERMISSION_IDS.documentsRead],
          rbacMode: "enforce",
          roles: ["workspace.viewer"],
          userId: "vera",
          workspaceId: "ws-a",
          workspaceIds: ["ws-a"],
        });
        assert.equal(response.headers.get("cache-control"), "no-store");
      } finally {
        await server.close();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("RBAC enforce: the default role keeps static-token users working", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rbac-default-"));

  try {
    await withEnv(authEnv({ RBAC_MODE: "enforce" }), async () => {
      const server = await startServer(await createTestApp(tempRoot));

      try {
        let response = await call(server, "no-role-token", "POST", "/upload/init", {});
        assert.equal(await isRbacDenial(response), false);
        response = await call(server, "no-role-token", "DELETE", "/documents/doc-1");
        assert.equal(await isRbacDenial(response), true);
      } finally {
        await server.close();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("RBAC off (default): no route answers an RBAC denial and /auth/me reports off", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rbac-off-"));

  try {
    await withEnv(authEnv(), async () => {
      const server = await startServer(await createTestApp(tempRoot));

      try {
        let response = await call(server, "viewer-token", "DELETE", "/documents/doc-1");
        assert.equal(response.status, 404);
        response = await call(server, "no-role-token", "POST", "/upload/init", {});
        assert.equal(await isRbacDenial(response), false);
        response = await call(server, "no-role-token", "GET", "/not-a-route");
        assert.equal(response.status, 404);
        // The existing admin check still applies unchanged.
        response = await call(server, "viewer-token", "GET", "/admin/status");
        assert.equal(response.status, 403);
        assert.equal((await response.json()).adminAuthorization.reason, "denied_missing_permission");
        response = await call(server, "viewer-token", "GET", "/auth/me");
        const me = await response.json();
        assert.equal(me.rbacMode, "off");
        assert.ok(me.permissions.includes(RBAC_PERMISSION_IDS.documentsDelete));
      } finally {
        await server.close();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("an invalid RBAC policy refuses the start", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rbac-invalid-"));

  try {
    await withEnv(
      { RBAC_POLICY_JSON: JSON.stringify({ "workspace.viewer": ["documents.raed"] }) },
      async () => {
        await assert.rejects(() => createTestApp(tempRoot), /unknown permission/);
      }
    );
    await withEnv({ RBAC_MODE: "on" }, async () => {
      await assert.rejects(() => createTestApp(tempRoot), /RBAC_MODE/);
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

// Static-token principals carry workspaceRoles: requireApiAuth (auth.js) adds
// them to the access scope, so this runs through the real createApp chain.
test(
  "RBAC enforce: a token's workspace.admin role deletes only inside that workspace",
  async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rbac-workspace-"));
    const tokens = {
      "dana-token": {
        userId: "dana",
        workspaceIds: ["ws-a", "ws-b"],
        workspaceRoles: { "ws-a": ["workspace.admin"], "ws-b": ["workspace.viewer"] },
      },
    };

    try {
      await withEnv(
        authEnv({
          API_AUTH_TOKENS: JSON.stringify(tokens),
          RBAC_DEFAULT_ROLE: "none",
          RBAC_MODE: "enforce",
        }),
        async () => {
          const server = await startServer(await createTestApp(tempRoot));
          const remove = (workspaceId) =>
            fetch(`${server.baseUrl}/documents/doc-1`, {
              headers: { "x-api-key": "dana-token", "x-workspace-id": workspaceId },
              method: "DELETE",
            });

          try {
            assert.equal((await remove("ws-a")).status, 404);
            assert.equal(await isRbacDenial(await remove("ws-b")), true);
          } finally {
            await server.close();
          }
        }
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  }
);
