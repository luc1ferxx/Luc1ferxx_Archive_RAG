// API_AUTH_OIDC_ALLOW_PLATFORM_ROLES (default true, unchanged): when false, an
// OIDC token's platform roles and permissions -- admin.* from the roles claim
// or from API_AUTH_OIDC_GROUP_ROLE_MAP, and the admin permissions -- are
// dropped, so a customer's identity provider cannot grant platform access,
// while workspace roles keep mapping.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

import express from "express";

import { requireApiAuth } from "../auth.js";
import { getAdminStatusReadPermission, requireAdminPermission } from "../rag/admin-authorization.js";
import { ADMIN_PERMISSION_IDS, ADMIN_ROLE_IDS } from "../rag/admin-permissions.js";
import { isApiAuthOidcPlatformRolesAllowed } from "../rag/config.js";
import { isOidcPlatformGrantAllowed, resolveEffectivePermissions } from "../rag/rbac.js";
import {
  createOidcVerifier,
  getDefaultOidcVerifier,
  isOidcPlatformRoleOrPermission,
  resetDefaultOidcVerifier,
} from "../rag/oidc.js";

const ISSUER = "https://idp.example.test";
const AUDIENCE = "archive-rag-api";
const NOW = Date.parse("2026-10-17T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW / 1000);

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "rsa-1", use: "sig" };

const b64 = (value) => Buffer.from(value).toString("base64url");

const signToken = (payload) => {
  const header = b64(JSON.stringify({ alg: "RS256", kid: "rsa-1", typ: "at+jwt" }));
  const body = b64(JSON.stringify(payload));
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${body}`), privateKey);

  return `${header}.${body}.${b64(signature)}`;
};

const idpFetch = async (url) => {
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }), { status: 200 });
  }

  if (url === `${ISSUER}/jwks`) {
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }

  return new Response("{}", { status: 404 });
};

const GROUP_ROLE_MAP = JSON.stringify({
  "archive-members": "workspace.member",
  "archive-operators": ["admin.operator", "workspace.viewer"],
});

const PAYLOAD = {
  aud: AUDIENCE,
  exp: NOW_SECONDS + 300,
  groups: ["archive-operators", "archive-members"],
  iat: NOW_SECONDS,
  iss: ISSUER,
  permissions: ["documents.read", "admin.audit.read", "Agent_Tasks.Action", "agent_runs.recovery.action"],
  roles: ["Admin.Owner", "workspace.admin"],
  sub: "alice",
  workspace_id: "ws-a",
  workspace_roles: { "ws-a": ["workspace.admin"] },
};

const makeVerifier = (overrides = {}) =>
  createOidcVerifier({
    audience: AUDIENCE,
    fetchImpl: idpFetch,
    groupRoleMap: GROUP_ROLE_MAP,
    issuer: ISSUER,
    now: () => NOW,
    ...overrides,
  });

test("by default every mapped role and permission is kept, platform ones included", async () => {
  const principal = await makeVerifier().verify(signToken(PAYLOAD));

  assert.deepEqual(principal.roles, [
    "Admin.Owner",
    "workspace.admin",
    "admin.operator",
    "workspace.viewer",
    "workspace.member",
  ]);
  assert.deepEqual(principal.permissions, PAYLOAD.permissions);
});

test("with platform roles off, admin roles from the roles claim and the groups map and the admin permissions are dropped; workspace grants stay", async () => {
  const principal = await makeVerifier({ allowPlatformRoles: false }).verify(signToken(PAYLOAD));

  assert.deepEqual(principal.roles, ["workspace.admin", "workspace.viewer", "workspace.member"]);
  assert.deepEqual(principal.permissions, ["documents.read"]);
  assert.deepEqual(principal.workspaceRoles, { "ws-a": ["workspace.admin"] });
  assert.equal(principal.userId, "alice");
  assert.equal(principal.workspaceId, "ws-a");
});

test("every admin role and permission of the catalog counts as a platform id; workspace ids do not", () => {
  for (const id of [...Object.values(ADMIN_ROLE_IDS), ...Object.values(ADMIN_PERMISSION_IDS)]) {
    assert.equal(isOidcPlatformRoleOrPermission(id), true, id);
    assert.equal(isOidcPlatformRoleOrPermission(` ${id.toUpperCase()} `), true, `${id} in another case`);
  }

  for (const id of ["workspace.admin", "workspace.member", "documents.read", "administrator", "admin", ""]) {
    assert.equal(isOidcPlatformRoleOrPermission(id), false, id);
  }
});

test("API_AUTH_OIDC_ALLOW_PLATFORM_ROLES: unset or empty is true; false rebuilds the default verifier without platform roles", async () => {
  const keys = [
    "API_AUTH_OIDC_ALLOW_PLATFORM_ROLES",
    "API_AUTH_OIDC_AUDIENCE",
    "API_AUTH_OIDC_GROUP_ROLE_MAP",
    "API_AUTH_OIDC_ISSUER",
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;

  try {
    delete process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES;
    assert.equal(isApiAuthOidcPlatformRolesAllowed(), true);

    for (const value of ["", "  ", "maybe"]) {
      process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES = value;
      assert.equal(isApiAuthOidcPlatformRolesAllowed(), true, JSON.stringify(value));
    }

    for (const value of ["false", "0", "off", " NO "]) {
      process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES = value;
      assert.equal(isApiAuthOidcPlatformRolesAllowed(), false, value);
    }

    // RBAC reads the flag from its own env argument, the same way.
    for (const value of [undefined, "", "  ", "maybe", "true", "1", " Yes ", "false", "0", "off", " NO "]) {
      const env = value === undefined ? {} : { API_AUTH_OIDC_ALLOW_PLATFORM_ROLES: value };

      if (value === undefined) delete process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES;
      else process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES = value;

      assert.equal(isOidcPlatformGrantAllowed(env), isApiAuthOidcPlatformRolesAllowed(), JSON.stringify(value));
    }

    process.env.API_AUTH_OIDC_ISSUER = ISSUER;
    process.env.API_AUTH_OIDC_AUDIENCE = AUDIENCE;
    process.env.API_AUTH_OIDC_GROUP_ROLE_MAP = GROUP_ROLE_MAP;
    globalThis.fetch = idpFetch;
    resetDefaultOidcVerifier();

    // A token valid now: the default verifier uses the real clock.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = signToken({ ...PAYLOAD, exp: nowSeconds + 300, iat: nowSeconds });

    process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES = "true";
    assert.ok((await getDefaultOidcVerifier().verify(token)).roles.includes("admin.operator"));

    process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES = "false";
    const restricted = await getDefaultOidcVerifier().verify(token);

    assert.deepEqual(restricted.roles, ["workspace.admin", "workspace.viewer", "workspace.member"]);
  } finally {
    globalThis.fetch = originalFetch;

    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    resetDefaultOidcVerifier();
  }
});

// The flag filters what the roles resolve to, not only their names: a token
// whose roles claim says workspace.admin (no admin.* id at all) must not reach
// admin.status.read through RBAC_MODE=enforce, which maps the global
// workspace.admin role to it. Through the real requireApiAuth and the admin
// check GET /admin/status uses (the /health details use the same decision).
test("with platform roles off, a token's global workspace.admin (or a custom role) grants no admin permission under RBAC enforce", async () => {
  const keys = [
    "API_AUTH_ENABLED",
    "API_AUTH_JWT_ENABLED",
    "API_AUTH_OIDC_ALLOW_PLATFORM_ROLES",
    "API_AUTH_OIDC_AUDIENCE",
    "API_AUTH_OIDC_CLIENT_ID",
    "API_AUTH_OIDC_ENABLED",
    "API_AUTH_OIDC_GROUP_ROLE_MAP",
    "API_AUTH_OIDC_ISSUER",
    "API_AUTH_OIDC_REQUIRE_TYP",
    "API_AUTH_REQUIRE_WORKSPACE",
    "API_AUTH_TOKEN",
    "API_AUTH_TOKENS",
    "RBAC_DEFAULT_ROLE",
    "RBAC_MODE",
    "RBAC_POLICY_FILE",
    "RBAC_POLICY_JSON",
    "TENANT_MEMBERSHIP",
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const app = express();

  app.use(requireApiAuth);
  app.get("/admin/status", requireAdminPermission(getAdminStatusReadPermission()), (req, res) => res.json({ ok: true }));
  app.get("/whoami", (req, res) => res.json({ permissions: resolveEffectivePermissions(req.accessScope), scope: req.accessScope }));

  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const api = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, {
      API_AUTH_ENABLED: "true",
      API_AUTH_OIDC_AUDIENCE: AUDIENCE,
      API_AUTH_OIDC_ENABLED: "true",
      API_AUTH_OIDC_ISSUER: ISSUER,
      RBAC_DEFAULT_ROLE: "none",
      RBAC_MODE: "enforce",
      RBAC_POLICY_JSON: JSON.stringify({ ops: [ADMIN_PERMISSION_IDS.adminStatusRead, "documents.read"] }),
    });
    // The identity provider answers through the stand-in; the API itself
    // over the real network.
    globalThis.fetch = (url, init) =>
      String(url).startsWith(ISSUER) ? idpFetch(String(url)) : originalFetch(url, init);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const tokenWith = (roles) =>
      signToken({ aud: AUDIENCE, exp: nowSeconds + 300, iat: nowSeconds, iss: ISSUER, roles, sub: "alice" });
    const call = (path, token) => originalFetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}` } });

    for (const roles of [["workspace.admin"], ["ops"]]) {
      process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES = "false";
      resetDefaultOidcVerifier();

      const token = tokenWith(roles);
      const whoami = await (await call("/whoami", token)).json();

      assert.equal(whoami.scope.authProvider, "oidc");
      assert.deepEqual(whoami.scope.roleIds, roles, "the role id itself is kept");
      assert.equal(whoami.permissions.includes(ADMIN_PERMISSION_IDS.adminStatusRead), false, roles[0]);

      const refused = await call("/admin/status", token);

      assert.equal(refused.status, 403, roles[0]);
      assert.equal((await refused.json()).adminAuthorization.permissionId, ADMIN_PERMISSION_IDS.adminStatusRead);

      // The default (platform roles allowed) is unchanged.
      process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES = "true";
      resetDefaultOidcVerifier();
      assert.equal((await call("/admin/status", token)).status, 200, roles[0]);
    }

    process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES = "false";
    resetDefaultOidcVerifier();

    const workspaceAdmin = await (await call("/whoami", tokenWith(["workspace.admin"]))).json();

    assert.ok(workspaceAdmin.permissions.includes("documents.delete"), "its workspace permissions stay");
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));

    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    resetDefaultOidcVerifier();
  }
});
