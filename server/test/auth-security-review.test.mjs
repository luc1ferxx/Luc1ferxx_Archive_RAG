// Security review of the OIDC / RBAC tracks: regressions for the issues the
// review fixed. Each test failed before its fix.
import assert from "node:assert/strict";
import test from "node:test";

import { buildAdminAuthorizationDecision } from "../rag/admin-authorization.js";
import { ADMIN_PERMISSION_IDS } from "../rag/admin-permissions.js";
import {
  decideRbacRequest,
  describeEffectiveAccess,
  RBAC_PERMISSION_IDS,
  resolveEffectivePermissions,
} from "../rag/rbac.js";

const P = RBAC_PERMISSION_IDS;
const ENFORCE_NO_DEFAULT = Object.freeze({ RBAC_MODE: "enforce", RBAC_DEFAULT_ROLE: "none" });
// RBAC_DEFAULT_ROLE unset: the shipped default (workspace.member).
const ENFORCE_DEFAULTS = Object.freeze({ RBAC_MODE: "enforce" });
const MEMBER = [
  P.chatAsk,
  P.documentsRead,
  P.documentsWrite,
  P.memoryRead,
  P.memoryWrite,
  P.qualityFeedback,
  P.tasksRun,
];

const withProcessEnv = (values, run) => {
  const original = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    return run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("a role granted inside one workspace never carries a deployment-wide admin permission", () => {
  // workspace.admin inside ws-a used to grant admin.status.read, which opens
  // /admin/status (deployment snapshot, health, LLMOps, quality) and
  // /admin/index-versions: data about every tenant, not about ws-a.
  const scope = {
    authenticated: true,
    userId: "dana",
    workspaceId: "ws-a",
    workspaceRoles: { "ws-a": ["workspace.admin"] },
  };
  const permissions = resolveEffectivePermissions(scope, { env: ENFORCE_NO_DEFAULT });

  assert.ok(permissions.includes(P.documentsDelete), "workspace permissions still apply");
  assert.equal(permissions.includes(ADMIN_PERMISSION_IDS.adminStatusRead), false);
  assert.equal(
    decideRbacRequest({
      accessScope: scope,
      env: ENFORCE_NO_DEFAULT,
      method: "GET",
      path: "/admin/status",
    }).allowed,
    false
  );

  withProcessEnv({ RBAC_DEFAULT_ROLE: "none", RBAC_MODE: "enforce" }, () => {
    assert.equal(
      buildAdminAuthorizationDecision({
        accessScope: scope,
        apiAuthEnabled: true,
        permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      }).allowed,
      false
    );
  });

  // A custom policy cannot turn a workspace role into a cross-tenant operator
  // either; the same role held globally still grants it.
  const env = {
    ...ENFORCE_NO_DEFAULT,
    RBAC_POLICY_JSON: JSON.stringify({
      "workspace.ops": ["documents.read", "admin.actions.recover_tasks"],
    }),
  };
  assert.deepEqual(
    resolveEffectivePermissions(
      { workspaceId: "ws-a", workspaceRoles: { "ws-a": ["workspace.ops"] } },
      { env }
    ),
    [P.documentsRead]
  );
  assert.deepEqual(
    resolveEffectivePermissions({ roleIds: ["workspace.ops"], workspaceId: "ws-a" }, { env }),
    [P.documentsRead, ADMIN_PERMISSION_IDS.adminActionRecoverTasks]
  );
});

test("the default role does not override an explicitly lower workspace role", () => {
  // With RBAC_DEFAULT_ROLE unset (workspace.member) a workspace.viewer used to
  // get member permissions anyway, so the viewer role restricted nothing.
  const viewerInB = {
    authenticated: true,
    userId: "carol",
    workspaceId: "workspace-b",
    workspaceRoles: { "workspace-b": ["workspace.viewer"] },
  };

  assert.deepEqual(resolveEffectivePermissions(viewerInB, { env: ENFORCE_DEFAULTS }), [
    P.chatAsk,
    P.documentsRead,
  ]);
  assert.equal(
    decideRbacRequest({
      accessScope: viewerInB,
      env: ENFORCE_DEFAULTS,
      method: "POST",
      path: "/upload",
    }).allowed,
    false
  );
  assert.deepEqual(
    describeEffectiveAccess(viewerInB, { env: ENFORCE_DEFAULTS }).roleIds,
    ["workspace.viewer"]
  );

  // A global viewer role is explicit too.
  assert.deepEqual(
    resolveEffectivePermissions(
      { roleIds: ["workspace.viewer"], workspaceId: "ws-a" },
      { env: ENFORCE_DEFAULTS }
    ),
    [P.chatAsk, P.documentsRead]
  );

  // The default still fills in for a principal with no workspace grant of its
  // own: no role at all, an admin-only role, or roles only in another workspace.
  assert.deepEqual(
    resolveEffectivePermissions({ workspaceId: "ws-a" }, { env: ENFORCE_DEFAULTS }),
    MEMBER
  );
  const adminViewer = resolveEffectivePermissions(
    { roleIds: ["admin.viewer"], workspaceId: "ws-a" },
    { env: ENFORCE_DEFAULTS }
  );
  for (const permission of MEMBER) {
    assert.ok(adminViewer.includes(permission), permission);
  }
  assert.ok(adminViewer.includes(ADMIN_PERMISSION_IDS.adminStatusRead));
  assert.deepEqual(
    resolveEffectivePermissions(
      { workspaceId: "workspace-a", workspaceRoles: { "workspace-b": ["workspace.viewer"] } },
      { env: ENFORCE_DEFAULTS }
    ),
    MEMBER
  );
});

test("a header that differs only in case resolves to the token's own tenant, and a workspace role never crosses case", async () => {
  const [{ default: express }, { requireApiAuth }, { normalizeWorkspaceRoles }] = await Promise.all([
    import("express"),
    import("../auth.js"),
    import("../rag/oidc.js"),
  ]);
  const env = {
    API_AUTH_ENABLED: "true",
    API_AUTH_TOKENS: JSON.stringify({
      "limited-token": { userId: "alice", workspaces: ["acme"] },
      "open-token": { userId: "bob", workspaceRoles: { acme: ["workspace.admin"] } },
    }),
  };
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const app = express();
  app.use(requireApiAuth);
  app.get("/scope", (req, res) => res.json(req.accessScope));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const scopeFor = async (token, workspaceId) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/scope`, {
      headers: { "x-api-key": token, "x-workspace-id": workspaceId },
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  try {
    // Before: the raw header became the database tenant, so a token limited
    // to "acme" acted inside the distinct tenant "ACME".
    assert.equal((await scopeFor("limited-token", "ACME")).workspaceId, "acme");
    assert.equal((await scopeFor("limited-token", "Acme")).workspaceId, "acme");

    // A token without an allowed list keeps the tenant as sent; a role granted
    // in "acme" applies there and nowhere else.
    const upper = await scopeFor("open-token", "ACME");
    const lower = await scopeFor("open-token", "acme");

    assert.equal(upper.workspaceId, "ACME");
    assert.equal(
      resolveEffectivePermissions(upper, { env: ENFORCE_NO_DEFAULT }).includes(P.documentsDelete),
      false
    );
    assert.equal(
      resolveEffectivePermissions(lower, { env: ENFORCE_NO_DEFAULT }).includes(P.documentsDelete),
      true
    );
  } finally {
    server.close();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  // A workspace named like an Object.prototype member is just a workspace.
  assert.deepEqual(normalizeWorkspaceRoles({ constructor: ["workspace.viewer"], toString: ["x"] }), {
    constructor: ["workspace.viewer"],
    tostring: ["x"],
  });
});
