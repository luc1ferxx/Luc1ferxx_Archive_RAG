import test from "node:test";
import assert from "node:assert/strict";

import {
  createHs256Jwt,
  hashAuthToken,
  isJwtSecretTooShort,
  verifyJwtAuthToken,
} from "../auth-jwt.js";
import { MIN_SERVICE_KEY_SECRET_LENGTH } from "../rag/service-identity.js";

const fixedNow = () => new Date("2026-07-06T00:00:00.000Z");
const nowSeconds = Math.floor(fixedNow().getTime() / 1000);
// At least MIN_SERVICE_KEY_SECRET_LENGTH characters: the verifier refuses a
// shorter secret.
const secret = "test-jwt-secret-of-at-least-32-chars";

// A JwtAuthError with the status requireApiAuth answers with.
const isJwtError = (status, message) => (error) => {
  assert.equal(error.name, "JwtAuthError");
  assert.equal(error.status, status);
  assert.match(error.message, message);
  return true;
};

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
        secret: "wrong-secret-that-is-also-long-enough",
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

test("verifyJwtAuthToken requires a numeric exp and refuses non-numeric nbf and iat", () => {
  const verify = (payload) =>
    verifyJwtAuthToken(createToken(payload), {
      now: fixedNow,
      secret,
    });

  // No exp at all: before, such a token never expired.
  assert.throws(() => verify({ exp: undefined }), isJwtError(401, /JWT has no expiry/));

  // A NumericDate is a JSON number: a numeric string, a word (Number() gives
  // NaN, which no comparison rejects), null or a boolean is refused, not
  // coerced.
  for (const exp of [String(nowSeconds + 60), "never", null, true, {}]) {
    assert.throws(() => verify({ exp }), isJwtError(401, /Invalid JWT exp claim/), String(exp));
  }

  for (const nbf of [String(nowSeconds - 60), "now", null]) {
    assert.throws(() => verify({ nbf }), isJwtError(401, /Invalid JWT nbf claim/), String(nbf));
  }

  for (const iat of [String(nowSeconds - 60), "yesterday", null]) {
    assert.throws(() => verify({ iat }), isJwtError(401, /Invalid JWT iat claim/), String(iat));
  }

  // Numbers behave as before: exp is exclusive, nbf inclusive, and with no
  // clock skew a future iat is only type-checked.
  assert.throws(() => verify({ exp: nowSeconds }), isJwtError(401, /JWT is expired/));
  assert.equal(verify({ iat: nowSeconds - 60, nbf: nowSeconds }).userId, "user-1");
  assert.equal(verify({ exp: nowSeconds + 1, iat: nowSeconds + 30 }).userId, "user-1");
});

test("verifyJwtAuthToken refuses a secret shorter than the service-key floor", () => {
  const shortSecret = "s".repeat(MIN_SERVICE_KEY_SECRET_LENGTH - 1);
  const tokenSignedWithShortSecret = createHs256Jwt({
    payload: { exp: nowSeconds + 60, sub: "user-1" },
    secret: shortSecret,
  });

  assert.equal(MIN_SERVICE_KEY_SECRET_LENGTH, 32);
  assert.throws(
    () =>
      verifyJwtAuthToken(tokenSignedWithShortSecret, {
        now: fixedNow,
        secret: shortSecret,
      }),
    isJwtError(500, /shorter than 32 characters/)
  );

  // Whitespace around the secret does not count, as the verifier trims it.
  assert.equal(isJwtSecretTooShort(` ${shortSecret} `), true);
  assert.equal(isJwtSecretTooShort(""), true);
  assert.equal(isJwtSecretTooShort(undefined), true);
  assert.equal(isJwtSecretTooShort("s".repeat(MIN_SERVICE_KEY_SECRET_LENGTH)), false);

  const longSecret = "s".repeat(MIN_SERVICE_KEY_SECRET_LENGTH);
  const principal = verifyJwtAuthToken(
    createHs256Jwt({ payload: { exp: nowSeconds + 60, sub: "user-1" }, secret: longSecret }),
    { now: fixedNow, secret: longSecret }
  );

  assert.equal(principal.userId, "user-1");
});
