import test from "node:test";
import assert from "node:assert/strict";

import {
  createHs256Jwt,
  hashAuthToken,
  verifyJwtAuthToken,
} from "../auth-jwt.js";

const fixedNow = () => new Date("2026-07-06T00:00:00.000Z");
const nowSeconds = Math.floor(fixedNow().getTime() / 1000);
const secret = "test-jwt-secret";

const createToken = (payload = {}, header = {}) =>
  createHs256Jwt({
    header,
    payload: {
      aud: "archive-rag",
      exp: nowSeconds + 60,
      iss: "https://issuer.example",
      sub: "user-1",
      ...payload,
    },
    secret,
  });

test("verifyJwtAuthToken maps validated claims into an access principal", () => {
  const token = createToken({
    jti: "jwt-1",
    permissions: ["admin.status.read"],
    roles: "admin.viewer, admin.operator",
    workspace_id: "workspace-a",
    workspaces: ["workspace-a", "workspace-b"],
  });

  const principal = verifyJwtAuthToken(token, {
    audience: "archive-rag",
    issuer: "https://issuer.example",
    now: fixedNow,
    secret,
  });

  assert.equal(principal.authProvider, "jwt");
  assert.equal(principal.issuer, "https://issuer.example");
  assert.equal(principal.jwtId, "jwt-1");
  assert.equal(principal.subject, "user-1");
  assert.equal(principal.userId, "user-1");
  assert.equal(principal.workspaceId, "workspace-a");
  assert.deepEqual(principal.allowedWorkspaceIds, [
    "workspace-a",
    "workspace-b",
  ]);
  assert.deepEqual(principal.permissions, ["admin.status.read"]);
  assert.equal(principal.roles, "admin.viewer, admin.operator");
  assert.equal(principal.tokenHash, hashAuthToken(token));
});

test("verifyJwtAuthToken supports nested custom claim paths", () => {
  const token = createToken({
    app: {
      permissions: ["quality:run"],
      roles: ["operator"],
      user: "alice",
      workspace: "workspace-a",
      workspaces: ["workspace-a"],
    },
  });

  const principal = verifyJwtAuthToken(token, {
    now: fixedNow,
    permissionsClaim: "app.permissions",
    rolesClaim: "app.roles",
    secret,
    userClaim: "app.user",
    workspaceClaim: "app.workspace",
    workspacesClaim: "app.workspaces",
  });

  assert.equal(principal.userId, "alice");
  assert.equal(principal.workspaceId, "workspace-a");
  assert.deepEqual(principal.allowedWorkspaceIds, ["workspace-a"]);
  assert.deepEqual(principal.roles, ["operator"]);
  assert.deepEqual(principal.permissions, ["quality:run"]);
});

test("verifyJwtAuthToken rejects invalid signature and audience", () => {
  const token = createToken();

  assert.throws(
    () =>
      verifyJwtAuthToken(token, {
        now: fixedNow,
        secret: "wrong-secret",
      }),
    /Invalid JWT signature/
  );

  assert.throws(
    () =>
      verifyJwtAuthToken(token, {
        audience: "different-service",
        now: fixedNow,
        secret,
      }),
    /Invalid JWT audience/
  );
});

test("verifyJwtAuthToken rejects inactive, expired, revoked, and anonymous tokens", () => {
  assert.throws(
    () =>
      verifyJwtAuthToken(
        createToken({
          exp: nowSeconds - 1,
        }),
        {
          now: fixedNow,
          secret,
        }
      ),
    /JWT is expired/
  );

  assert.throws(
    () =>
      verifyJwtAuthToken(
        createToken({
          nbf: nowSeconds + 1,
        }),
        {
          now: fixedNow,
          secret,
        }
      ),
    /JWT is not active yet/
  );

  assert.throws(
    () =>
      verifyJwtAuthToken(
        createToken({
          jti: "revoked-jwt",
        }),
        {
          now: fixedNow,
          revokedJtis: "revoked-jwt",
          secret,
        }
      ),
    /JWT id is revoked/
  );

  const revokedToken = createToken({
    jti: "hash-revoked-jwt",
  });

  assert.throws(
    () =>
      verifyJwtAuthToken(revokedToken, {
        now: fixedNow,
        revokedTokenHashes: hashAuthToken(revokedToken),
        secret,
      }),
    /JWT token hash is revoked/
  );

  assert.throws(
    () =>
      verifyJwtAuthToken(
        createToken({
          sub: "",
        }),
        {
          now: fixedNow,
          secret,
        }
      ),
    /JWT user claim is missing/
  );
});

test("verifyJwtAuthToken rejects unsupported algorithms and missing secrets", () => {
  assert.throws(
    () =>
      verifyJwtAuthToken(createToken(), {
        now: fixedNow,
        secret: "",
      }),
    /no JWT secret/
  );

  assert.throws(
    () =>
      verifyJwtAuthToken(
        createToken(
          {},
          {
            alg: "none",
          }
        ),
        {
          now: fixedNow,
          secret,
        }
      ),
    /Unsupported JWT algorithm/
  );
});
