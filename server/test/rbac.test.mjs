import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import {
  ADMIN_AUTHORIZATION_REASONS,
  buildAdminAuthorizationDecision,
} from "../rag/admin-authorization.js";
import { createAdminAuditService } from "../rag/admin-audit.js";
import { ADMIN_PERMISSION_IDS, ADMIN_ROLE_IDS } from "../rag/admin-permissions.js";
import {
  assertRbacConfiguration,
  buildAuthMeResponse,
  createRbacMiddleware,
  decideRbacRequest,
  DEFAULT_RBAC_ROLE_POLICY,
  getRbacConfig,
  getRbacMode,
  matchRbacRoute,
  RBAC_DENIAL_REASONS,
  RBAC_ERROR_CODE,
  RBAC_PERMISSION_IDS,
  RBAC_ROLE_IDS,
  RBAC_ROUTE_TABLE,
  requirePermission,
  resolveEffectivePermissions,
} from "../rag/rbac.js";

const ENFORCE = Object.freeze({ RBAC_MODE: "enforce", RBAC_DEFAULT_ROLE: "none" });
const P = RBAC_PERMISSION_IDS;

test("RBAC mode defaults to off and fails closed on an unknown value", () => {
  assert.equal(getRbacMode({}), "off");
  assert.equal(getRbacMode({ RBAC_MODE: " Enforce " }), "enforce");
  assert.throws(() => getRbacMode({ RBAC_MODE: "enforcing" }), /RBAC_MODE/);
  assert.equal(getRbacConfig({}).defaultRole, RBAC_ROLE_IDS.workspaceMember);
  assert.equal(getRbacConfig({ RBAC_DEFAULT_ROLE: "none" }).defaultRole, "");
});

test("the default role catalog composes the existing admin permissions", () => {
  assert.deepEqual(DEFAULT_RBAC_ROLE_POLICY[RBAC_ROLE_IDS.workspaceViewer], [
    P.documentsRead,
    P.chatAsk,
  ]);

  const member = DEFAULT_RBAC_ROLE_POLICY[RBAC_ROLE_IDS.workspaceMember];
  for (const permission of [
    P.documentsWrite,
    P.tasksRun,
    P.memoryRead,
    P.memoryWrite,
    P.qualityFeedback,
  ]) {
    assert.ok(member.includes(permission), permission);
  }
  assert.equal(member.includes(P.documentsDelete), false);

  const workspaceAdmin = DEFAULT_RBAC_ROLE_POLICY[RBAC_ROLE_IDS.workspaceAdmin];
  assert.ok(workspaceAdmin.includes(P.documentsDelete));
  assert.ok(workspaceAdmin.includes(ADMIN_PERMISSION_IDS.adminStatusRead));
  assert.equal(workspaceAdmin.includes(ADMIN_PERMISSION_IDS.adminAuditRead), false);

  assert.deepEqual(DEFAULT_RBAC_ROLE_POLICY[ADMIN_ROLE_IDS.viewer], [
    ADMIN_PERMISSION_IDS.adminStatusRead,
    ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
  ]);
  assert.ok(DEFAULT_RBAC_ROLE_POLICY[ADMIN_ROLE_IDS.owner].includes(P.documentsDelete));
});

test("effective permissions combine global roles, the active workspace's roles and the default role", () => {
  const principal = {
    authenticated: true,
    roleIds: [RBAC_ROLE_IDS.workspaceViewer],
    workspaceId: "ws-a",
    workspaceRoles: { "WS-A": [RBAC_ROLE_IDS.workspaceAdmin], "ws-b": "workspace.member" },
  };

  assert.ok(resolveEffectivePermissions(principal, { env: ENFORCE }).includes(P.documentsDelete));
  // Another workspace's role does not leak into this one.
  const inB = resolveEffectivePermissions(principal, { env: ENFORCE, workspaceId: "ws-b" });
  assert.equal(inB.includes(P.documentsDelete), false);
  assert.ok(inB.includes(P.documentsWrite));
  const inC = resolveEffectivePermissions(principal, { env: ENFORCE, workspaceId: "ws-c" });
  assert.deepEqual(inC, [P.chatAsk, P.documentsRead]);

  // The default role fills in for a principal with no workspace permission of
  // its own (security review: it no longer raises an explicit grant), unknown
  // roles grant nothing, and unknown permission ids on the principal are
  // dropped.
  assert.deepEqual(
    resolveEffectivePermissions(
      { permissionIds: ["made.up"], roleIds: ["nobody"] },
      { env: { RBAC_MODE: "enforce" } }
    ),
    [
      P.chatAsk,
      P.documentsRead,
      P.documentsWrite,
      P.memoryRead,
      P.memoryWrite,
      P.qualityFeedback,
      P.tasksRun,
    ]
  );
  assert.deepEqual(
    resolveEffectivePermissions(
      { permissionIds: ["memory.read", "made.up"], roleIds: ["nobody"] },
      { env: { RBAC_MODE: "enforce" } }
    ),
    [P.memoryRead]
  );
  assert.deepEqual(
    resolveEffectivePermissions({ permissionIds: ["memory.read", "made.up"] }, { env: ENFORCE }),
    [P.memoryRead]
  );
});

test("a policy override replaces or adds roles and unknown permission ids are errors", async () => {
  const env = {
    ...ENFORCE,
    RBAC_POLICY_JSON: JSON.stringify({
      roles: {
        "workspace.viewer": ["documents.read"],
        "workspace.auditor": ["documents.read", "admin.audit.read"],
      },
    }),
  };

  assert.deepEqual(resolveEffectivePermissions({ roleIds: ["workspace.viewer"] }, { env }), [
    P.documentsRead,
  ]);
  assert.deepEqual(resolveEffectivePermissions({ roleIds: ["workspace.auditor"] }, { env }), [
    P.documentsRead,
    ADMIN_PERMISSION_IDS.adminAuditRead,
  ]);

  assert.throws(
    () => assertRbacConfiguration({ RBAC_POLICY_JSON: '{"workspace.viewer":["documents.reed"]}' }),
    (error) => error.code === "RBAC_CONFIGURATION_INVALID" && /unknown permission/.test(error.message)
  );
  assert.throws(() => assertRbacConfiguration({ RBAC_POLICY_JSON: "{" }), /valid JSON/);
  assert.throws(
    () => assertRbacConfiguration({ RBAC_POLICY_JSON: '{"workspace.viewer":"documents.read"}' }),
    /array/
  );
  assert.throws(
    () => assertRbacConfiguration({ RBAC_DEFAULT_ROLE: "workspace.ghost" }),
    /RBAC_DEFAULT_ROLE/
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rbac-policy-"));
  try {
    const policyFile = path.join(tempRoot, "policy.json");
    await writeFile(policyFile, JSON.stringify({ "workspace.member": ["documents.read"] }));
    assert.deepEqual(
      resolveEffectivePermissions({}, { env: { RBAC_MODE: "enforce", RBAC_POLICY_FILE: policyFile } }),
      [P.documentsRead]
    );
    assert.throws(
      () => assertRbacConfiguration({ RBAC_POLICY_FILE: path.join(tempRoot, "missing.json") }),
      /could not be read/
    );
    assert.throws(
      () => assertRbacConfiguration({ RBAC_POLICY_FILE: policyFile, RBAC_POLICY_JSON: "{}" }),
      /only one/
    );
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("the route matcher prefers literal segments and follows Express's matching rules", () => {
  assert.equal(matchRbacRoute("GET", "/agent-runs/recovery").entry.path, "/agent-runs/recovery");
  assert.equal(matchRbacRoute("GET", "/agent-runs/run-1").entry.path, "/agent-runs/:runId");
  assert.equal(matchRbacRoute("HEAD", "/documents/").entry.permission, P.documentsRead);
  assert.equal(matchRbacRoute("post", "/Documents/Clear").entry.permission, P.documentsDelete);
  assert.equal(matchRbacRoute("DELETE", "/documents/clear").entry.permission, P.documentsDelete);
  assert.equal(matchRbacRoute("GET", "/documents/arxiv/suggestions").entry.path, "/documents/arxiv/suggestions");
  assert.equal(matchRbacRoute("GET", "/documents//file"), null);
  assert.equal(matchRbacRoute("GET", "/nope"), null);

  const keys = RBAC_ROUTE_TABLE.map((entry) => `${entry.method} ${entry.path}`);
  assert.equal(new Set(keys).size, keys.length, "route table has duplicate entries");
});

test("off mode allows everything; enforce denies routes outside the table", () => {
  assert.equal(
    decideRbacRequest({ accessScope: {}, env: {}, method: "DELETE", path: "/documents/x" }).allowed,
    true
  );
  assert.deepEqual(
    decideRbacRequest({ accessScope: {}, env: ENFORCE, method: "GET", path: "/secret" }),
    { allowed: false, permissionId: "", reason: RBAC_DENIAL_REASONS.routeNotInTable, roleId: "" }
  );
  assert.equal(
    decideRbacRequest({ accessScope: {}, env: ENFORCE, method: "OPTIONS", path: "/secret" }).allowed,
    true
  );
  assert.equal(
    decideRbacRequest({ accessScope: {}, env: ENFORCE, method: "GET", path: "/auth/me" }).allowed,
    true
  );
  const adminAction = decideRbacRequest({
    accessScope: { roleIds: [ADMIN_ROLE_IDS.viewer] },
    env: ENFORCE,
    method: "POST",
    path: "/admin/actions/recovery-scan",
  });
  assert.equal(adminAction.allowed, true);
  assert.equal(adminAction.permissionId, ADMIN_PERMISSION_IDS.adminActionRecoveryScan);
  assert.equal(
    decideRbacRequest({
      accessScope: { roleIds: [ADMIN_ROLE_IDS.owner] },
      env: ENFORCE,
      method: "POST",
      path: "/admin/actions/not_an_action",
    }).reason,
    RBAC_DENIAL_REASONS.unknownPermission
  );
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

// A request's principal comes from a test header here so workspace roles can be
// exercised without the OIDC track; createApp-level tests live in
// rbac-routes.test.mjs.
const PRINCIPALS = {
  "ws-admin-a": {
    authenticated: true,
    userId: "dana",
    workspaceId: "ws-a",
    workspaceRoles: { "ws-a": ["workspace.admin"], "ws-b": ["workspace.viewer"] },
  },
  "ws-admin-a-in-b": {
    allowedWorkspaceIds: ["ws-a", "ws-b"],
    authenticated: true,
    userId: "dana",
    workspaceId: "ws-b",
    workspaceRoles: { "ws-a": ["workspace.admin"], "ws-b": ["workspace.viewer"] },
  },
};

test("workspace.admin deletes only in its own workspace and denials are audited with ids only", async () => {
  const auditService = createAdminAuditService();
  const app = express();
  app.use((req, res, next) => {
    req.accessScope = PRINCIPALS[req.get("x-test-principal")] ?? {};
    next();
  });
  app.use(createRbacMiddleware({ auditService, env: ENFORCE }));
  app.delete("/documents/:docId", (req, res) => res.json({ deleted: req.params.docId }));
  app.get("/documents", (req, res) => res.json([]));
  app.post("/single", requirePermission(P.memoryWrite, { auditService, env: ENFORCE }), (req, res) =>
    res.json({ ok: true })
  );
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/documents/doc-1`, {
      headers: { "x-test-principal": "ws-admin-a" },
      method: "DELETE",
    });
    assert.equal(response.status, 200);

    response = await fetch(`${server.baseUrl}/documents/doc-1`, {
      headers: { authorization: "Bearer sk-should-not-echo", "x-test-principal": "ws-admin-a-in-b" },
      method: "DELETE",
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.deepEqual(body, {
      code: RBAC_ERROR_CODE,
      error: "Forbidden.",
      permission: P.documentsDelete,
    });

    response = await fetch(`${server.baseUrl}/documents`, {
      headers: { "x-test-principal": "ws-admin-a-in-b" },
    });
    assert.equal(response.status, 200);

    response = await fetch(`${server.baseUrl}/single`, {
      headers: { "x-test-principal": "ws-admin-a-in-b" },
      method: "POST",
    });
    // /single is not in the route table, so the app-level middleware denies it
    // before requirePermission runs.
    assert.equal(response.status, 403);
    assert.equal((await response.json()).permission, null);

    const audit = await auditService.listEvents({});
    assert.equal(audit.events.length, 2);
    const [routeDenial, deleteDenial] = audit.events;
    assert.equal(routeDenial.authorization.reason, RBAC_DENIAL_REASONS.routeNotInTable);
    assert.equal(deleteDenial.result, "denied");
    assert.equal(deleteDenial.authorization.permissionId, P.documentsDelete);
    assert.equal(deleteDenial.principal.userId, "dana");
    assert.equal(deleteDenial.principal.workspaceId, "ws-b");
    assert.equal(deleteDenial.request.path, "/documents/doc-1");
    assert.equal(JSON.stringify(audit).includes("sk-should-not-echo"), false);
  } finally {
    await server.close();
  }
});

test("requirePermission guards a single route and is a no-op in off mode", async () => {
  const calls = [];
  const res = {
    json(payload) {
      calls.push(["json", payload]);
      return res;
    },
    status(code) {
      calls.push(["status", code]);
      return res;
    },
  };
  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };

  await requirePermission(P.documentsDelete, { env: {} })({ accessScope: {} }, res, next);
  assert.equal(nextCalls, 1);

  await requirePermission(P.documentsDelete, { env: ENFORCE })(
    { accessScope: { roleIds: ["workspace.member"] }, method: "DELETE", path: "/x" },
    res,
    next
  );
  assert.equal(nextCalls, 1);
  assert.deepEqual(calls, [
    ["status", 403],
    ["json", { code: RBAC_ERROR_CODE, error: "Forbidden.", permission: P.documentsDelete }],
  ]);

  await requirePermission(P.documentsDelete, { env: ENFORCE })(
    { accessScope: { roleIds: ["workspace.admin"] } },
    res,
    next
  );
  assert.equal(nextCalls, 2);
});

test("GET /auth/me body has the contract shape and never the credential", () => {
  const scope = {
    allowedWorkspaceIds: ["ws-a", "ws-b"],
    authProvider: "oidc",
    authenticated: true,
    roleIds: ["workspace.viewer"],
    token: "sk-secret",
    userId: "erin",
    workspaceId: "ws-b",
    workspaceRoles: { "ws-a": ["workspace.admin"] },
  };

  const enforced = buildAuthMeResponse(scope, { apiAuthEnabled: true, env: ENFORCE });
  assert.deepEqual(enforced, {
    authProvider: "oidc",
    permissions: [P.chatAsk, P.documentsRead],
    rbacMode: "enforce",
    roles: ["workspace.viewer"],
    userId: "erin",
    workspaceId: "ws-b",
    workspaceIds: ["ws-a", "ws-b"],
  });
  assert.equal(JSON.stringify(enforced).includes("sk-secret"), false);

  // Off mode reports what the server allows today.
  const off = buildAuthMeResponse(
    { authenticated: true, roleIds: [ADMIN_ROLE_IDS.viewer], userId: "erin", workspaceId: "ws-a" },
    { apiAuthEnabled: true, env: {} }
  );
  assert.equal(off.rbacMode, "off");
  assert.ok(off.permissions.includes(P.documentsDelete));
  assert.ok(off.permissions.includes(ADMIN_PERMISSION_IDS.adminStatusRead));
  assert.equal(off.permissions.includes(ADMIN_PERMISSION_IDS.adminAuditRead), false);
  assert.equal(off.authProvider, "static_token");
  assert.deepEqual(off.workspaceIds, ["ws-a"]);

  const anonymous = buildAuthMeResponse({ authenticated: false }, { apiAuthEnabled: false, env: {} });
  assert.equal(anonymous.authProvider, "none");
  assert.ok(anonymous.permissions.includes(ADMIN_PERMISSION_IDS.adminAuditRead));
});

test("the admin check accepts an RBAC global grant only in enforce mode", () => {
  // A role granted inside one workspace never carries an admin permission
  // (security review), so the RBAC path is exercised with workspace.admin held
  // as a global role.
  const scope = {
    authenticated: true,
    roleIds: ["workspace.admin"],
    workspaceId: "ws-a",
  };
  const originalMode = process.env.RBAC_MODE;
  const originalDefault = process.env.RBAC_DEFAULT_ROLE;

  try {
    delete process.env.RBAC_MODE;
    assert.equal(
      buildAdminAuthorizationDecision({
        accessScope: scope,
        apiAuthEnabled: true,
        permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      }).allowed,
      false
    );

    process.env.RBAC_MODE = "enforce";
    process.env.RBAC_DEFAULT_ROLE = "none";
    assert.deepEqual(
      buildAdminAuthorizationDecision({
        accessScope: scope,
        apiAuthEnabled: true,
        permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      }),
      {
        allowed: true,
        permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
        reason: ADMIN_AUTHORIZATION_REASONS.allowedByRbac,
        roleId: "",
      }
    );
    assert.equal(
      buildAdminAuthorizationDecision({
        accessScope: {
          authenticated: true,
          workspaceId: "ws-a",
          workspaceRoles: { "ws-a": ["workspace.admin"] },
        },
        apiAuthEnabled: true,
        permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      }).allowed,
      false
    );
    assert.equal(
      buildAdminAuthorizationDecision({
        accessScope: scope,
        apiAuthEnabled: true,
        permissionId: ADMIN_PERMISSION_IDS.adminAuditRead,
      }).allowed,
      false
    );
  } finally {
    if (originalMode === undefined) delete process.env.RBAC_MODE;
    else process.env.RBAC_MODE = originalMode;
    if (originalDefault === undefined) delete process.env.RBAC_DEFAULT_ROLE;
    else process.env.RBAC_DEFAULT_ROLE = originalDefault;
  }
});
