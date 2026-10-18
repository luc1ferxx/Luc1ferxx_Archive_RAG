import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { requireApiAuth } from "../auth.js";
import { describeEffectiveAccess } from "../rag/rbac.js";
import {
  MAX_FORWARDED_ROLE_ID_LENGTH,
  MAX_FORWARDED_WORKSPACE_ROLES,
  normalizeServiceAccessScope,
  requireServiceIdentity,
  SERVICE_IDENTITY_ERROR_CODES,
  SERVICE_TOKEN_HEADER,
  ServiceIdentityError,
  signServiceToken,
  verifyServiceToken,
} from "../rag/service-identity.js";

// Workspace roles in the signed scope of a split deployment: the edge forwards
// the active workspace's grants (and nothing else), bounded, and a receiving
// tier refuses any other shape, so the agent tier's scope grants what the
// edge's does and a token stays small. A token without the field (an edge from
// before it was forwarded) still verifies.

const SECRET = "w".repeat(24) + "-workspace-roles-0123456789";
const ENV = { INTERNAL_SERVICE_KEYS: `wr1:${SECRET}` };
const RBAC_ENV = { RBAC_MODE: "enforce" };
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

// An independent HS256 signer, so a test can send shapes the module never mints.
const forgeToken = (payload) => {
  const input = `${encode({ alg: "HS256", kid: "wr1", typ: "JWT" })}.${encode(payload)}`;
  const signature = crypto.createHmac("sha256", SECRET).update(input).digest("base64url");

  return `${input}.${signature}`;
};

const forgeScopeToken = (scope) =>
  forgeToken({
    aud: "agent",
    exp: Math.floor(T0 / 1000) + 60,
    iat: Math.floor(T0 / 1000),
    iss: "api",
    jti: crypto.randomUUID(),
    scope,
  });

const verify = (token) => verifyServiceToken(token, { audience: "agent", env: ENV, now: T0 });

const sign = (accessScope) =>
  signServiceToken({ accessScope, audience: "agent", env: ENV, issuer: "api", now: T0 });

const readPayload = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

const expectMalformed = (fn, label) => {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof ServiceIdentityError, `${label}: expected ServiceIdentityError, got ${error}`);
      assert.equal(error.code, SERVICE_IDENTITY_ERROR_CODES.malformed, label);
      assert.equal(error.status, 401, label);
      return true;
    },
    label
  );
};

const withEnv = async (overrides, fn) => {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));

  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });

  try {
    return await fn();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
};

// The scope requireApiAuth builds at the edge for one public token.
const resolveEdgeScope = (principal, headers = {}) =>
  withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_JWT_ENABLED: undefined,
      API_AUTH_OIDC_ENABLED: undefined,
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: JSON.stringify({ "public-token": principal }),
      API_AUTH_WORKSPACE_REQUIRED: undefined,
    },
    () => {
      const lowerHeaders = Object.fromEntries(
        Object.entries({ "x-api-key": "public-token", ...headers }).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ])
      );
      const req = {
        body: {},
        get: (name) => lowerHeaders[name.toLowerCase()] ?? "",
        path: "/tasks",
        query: {},
      };
      let nextCalled = false;

      const refuse = (body) => assert.fail(`requireApiAuth refused: ${JSON.stringify(body)}`);

      requireApiAuth(req, { json: refuse, status: () => ({ json: refuse }) }, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);

      return req.accessScope;
    }
  );

const runMiddleware = (middleware, token) => {
  const headers = { [SERVICE_TOKEN_HEADER]: token };
  const req = {
    get: (name) => headers[name.toLowerCase()],
    headers,
    method: "GET",
    originalUrl: "/tasks",
    rawHeaders: Object.entries(headers).flat(),
  };
  const outcome = { body: null, nextCalled: false, status: 200 };
  const res = {
    json(body) {
      outcome.body = body;
      return res;
    },
    status(code) {
      outcome.status = code;
      return res;
    },
  };

  middleware(req, res, () => {
    outcome.nextCalled = true;
  });

  return { ...outcome, req };
};

const MEMBER = {
  userId: "alice",
  workspaceRoles: {
    "ws-a": ["workspace.viewer"],
    "ws-b": ["workspace.admin", "workspace.member"],
  },
  workspaces: ["ws-a", "ws-b"],
};

test("the token carries the active workspace's roles, and the receiver grants what the edge does", async () => {
  for (const [workspaceId, expectedRoles] of [
    ["ws-a", ["workspace.viewer"]],
    ["ws-b", ["workspace.admin", "workspace.member"]],
  ]) {
    const edgeScope = await resolveEdgeScope(MEMBER, { "x-workspace-id": workspaceId });

    // The edge's scope holds every workspace's grants.
    assert.deepEqual(Object.keys(edgeScope.workspaceRoles).sort(), ["ws-a", "ws-b"]);

    const token = sign(edgeScope);

    // Only the active workspace's grant travels.
    assert.deepEqual(readPayload(token).scope.workspaceRoles, { [workspaceId]: expectedRoles });

    const received = verify(token).accessScope;

    assert.deepEqual(received, {
      allowedWorkspaceIds: ["ws-a", "ws-b"],
      authProvider: "static_token",
      authenticated: true,
      userId: "alice",
      workspaceId,
      workspaceRoles: { [workspaceId]: expectedRoles },
    });
    assert.deepEqual(
      describeEffectiveAccess(received, { env: RBAC_ENV }),
      describeEffectiveAccess(edgeScope, { env: RBAC_ENV })
    );

    // The middleware sets the same scope on the request.
    const { nextCalled, req } = runMiddleware(
      requireServiceIdentity({ audience: "agent", env: ENV, now: T0 }),
      sign(edgeScope)
    );

    assert.equal(nextCalled, true);
    assert.deepEqual(req.accessScope, received);
  }
});

test("grants that apply to no request under the scope never travel", async () => {
  // A token without an allowed list keeps the tenant as sent, and a role
  // granted in "acme" never applies in the distinct tenant "ACME" (rag/rbac.js).
  const upperTenant = await resolveEdgeScope(
    { userId: "alice", workspaceRoles: { acme: ["workspace.admin"] } },
    { "x-workspace-id": "ACME" }
  );

  assert.equal(upperTenant.workspaceId, "ACME");
  assert.deepEqual(upperTenant.workspaceRoles, { acme: ["workspace.admin"] });

  const upperReceived = verify(sign(upperTenant)).accessScope;

  assert.equal("workspaceRoles" in upperReceived, false);
  assert.deepEqual(
    describeEffectiveAccess(upperReceived, { env: RBAC_ENV }),
    describeEffectiveAccess(upperTenant, { env: RBAC_ENV })
  );

  // No active workspace: no workspace role applies, none travels.
  const noWorkspace = normalizeServiceAccessScope({
    authenticated: true,
    userId: "alice",
    workspaceId: "",
    workspaceRoles: { "ws-a": ["workspace.admin"] },
  });

  assert.equal("workspaceRoles" in noWorkspace, false);

  // Grant keys that RBAC folds onto the active workspace are merged, as RBAC
  // merges them; the snake_case alias is read like requireApiAuth reads it.
  assert.deepEqual(
    normalizeServiceAccessScope({
      authenticated: true,
      userId: "alice",
      workspaceId: "ws-a",
      workspaceRoles: { "WS-A": ["Workspace.Viewer"], "ws-a": ["workspace.member", "workspace.viewer"] },
    }).workspaceRoles,
    { "ws-a": ["workspace.viewer", "workspace.member"] }
  );
  assert.deepEqual(
    normalizeServiceAccessScope({
      authenticated: true,
      userId: "alice",
      workspace_roles: { "ws-a": "workspace.viewer,workspace.member" },
      workspaceId: "ws-a",
    }).workspaceRoles,
    { "ws-a": ["workspace.viewer", "workspace.member"] }
  );
});

test("a scope without workspace roles keeps its shape, and an older token still verifies", () => {
  const plain = { authenticated: true, userId: "alice", workspaceId: "ws-a" };
  const signed = sign(plain);

  assert.equal("workspaceRoles" in readPayload(signed).scope, false);
  assert.deepEqual(verify(signed).accessScope, plain);

  // A token minted before workspace roles were forwarded: no field, no roles.
  const older = forgeScopeToken({ authenticated: true, roleIds: ["admin"], userId: "alice", workspaceId: "ws-a" });

  assert.deepEqual(verify(older).accessScope, {
    authenticated: true,
    roleIds: ["admin"],
    userId: "alice",
    workspaceId: "ws-a",
  });

  // Only the camelCase field a signer writes is read on receipt.
  const alias = verify(
    forgeScopeToken({
      authenticated: true,
      userId: "alice",
      workspace_roles: { "ws-a": ["workspace.admin"] },
      workspaceId: "ws-a",
    })
  ).accessScope;

  assert.equal("workspaceRoles" in alias, false);
});

test("signing refuses workspace roles past the bound instead of forwarding a different scope", () => {
  const scopeWith = (roles) => ({
    authenticated: true,
    userId: "alice",
    workspaceId: "ws-a",
    workspaceRoles: { "ws-a": roles },
  });
  const roleOfLength = (index, length) => `r${index}-`.padEnd(length, "x");
  const largest = Array.from({ length: MAX_FORWARDED_WORKSPACE_ROLES }, (_, index) =>
    roleOfLength(index, MAX_FORWARDED_ROLE_ID_LENGTH)
  );

  // The largest grant that travels still makes a token well inside the limit.
  const token = sign(scopeWith(largest));

  assert.ok(token.length < 8192, `token length ${token.length}`);
  assert.deepEqual(verify(token).accessScope.workspaceRoles, { "ws-a": largest });

  assert.throws(() => sign(scopeWith([...largest, "one-more"])), RangeError);
  assert.throws(
    () => sign(scopeWith([roleOfLength(0, MAX_FORWARDED_ROLE_ID_LENGTH + 1)])),
    RangeError
  );
  assert.throws(() => sign(scopeWith(["workspace\u0000admin"])), RangeError);
});

test("a received scope with workspace roles in any other shape is malformed", () => {
  const scope = (workspaceRoles, workspaceId = "ws-a") => ({
    authenticated: true,
    userId: "alice",
    workspaceId,
    workspaceRoles,
  });
  const tooMany = Array.from({ length: MAX_FORWARDED_WORKSPACE_ROLES + 1 }, (_, index) => `role-${index}`);

  // The shape a signer writes is accepted.
  assert.deepEqual(verify(forgeScopeToken(scope({ "ws-a": ["workspace.viewer"] }))).accessScope.workspaceRoles, {
    "ws-a": ["workspace.viewer"],
  });

  for (const [label, forged] of [
    ["null", scope(null)],
    ["an array", scope([["ws-a", ["workspace.viewer"]]])],
    ["two workspaces", scope({ "ws-a": ["workspace.viewer"], "ws-b": ["workspace.admin"] })],
    ["another workspace", scope({ "ws-b": ["workspace.admin"] })],
    ["another case of the workspace", scope({ "WS-A": ["workspace.admin"] })],
    ["a prototype key", JSON.parse('{"authenticated":true,"userId":"alice","workspaceId":"ws-a","workspaceRoles":{"__proto__":["workspace.admin"]}}')],
    ["no active workspace", scope({ "ws-a": ["workspace.admin"] }, "")],
    ["a role string instead of a list", scope({ "ws-a": "workspace.admin" })],
    ["an empty list", scope({ "ws-a": [] })],
    ["a non-string role", scope({ "ws-a": [42] })],
    ["a non-canonical role", scope({ "ws-a": ["Workspace.Admin"] })],
    ["a padded role", scope({ "ws-a": [" workspace.admin"] })],
    ["a control character", scope({ "ws-a": ["workspace\u0007admin"] })],
    ["a duplicate role", scope({ "ws-a": ["workspace.admin", "workspace.admin"] })],
    ["too many roles", scope({ "ws-a": tooMany })],
    ["a role too long", scope({ "ws-a": ["r".repeat(MAX_FORWARDED_ROLE_ID_LENGTH + 1)] })],
  ]) {
    expectMalformed(() => verify(forgeScopeToken(forged)), label);
  }

  // The middleware answers it like any malformed token, without a scope.
  const { body, nextCalled, req, status } = runMiddleware(
    requireServiceIdentity({ audience: "agent", env: ENV, now: T0 }),
    forgeScopeToken(scope({ "ws-b": ["workspace.admin"] }))
  );

  assert.equal(nextCalled, false);
  assert.equal(status, 401);
  assert.equal(body.code, SERVICE_IDENTITY_ERROR_CODES.malformed);
  assert.equal(req.accessScope, undefined);
});
