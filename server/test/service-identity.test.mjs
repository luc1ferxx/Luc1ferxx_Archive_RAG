import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import express from "express";

import { bindDatabaseTenant, requireApiAuth } from "../auth.js";
import { getActiveDatabaseTenant } from "../rag/postgres-tenant.js";
import {
  DEFAULT_SERVICE_TOKEN_TTL_MS,
  getServiceDeadlineRemainingMs,
  getServiceKeyStatus,
  getServiceRequestId,
  normalizeServiceAccessScope,
  parseServiceKeys,
  requireServiceIdentity,
  SERVICE_DEADLINE_HEADER,
  SERVICE_IDENTITY_ERROR_CODES,
  SERVICE_REQUEST_ID_HEADER,
  SERVICE_TOKEN_HEADER,
  ServiceIdentityError,
  signServiceToken,
  stripInternalServiceHeaders,
  stripInternalServiceHeadersMiddleware,
  verifyServiceToken,
} from "../rag/service-identity.js";

const SECRET_NEW = "n".repeat(24) + "-new-secret-0123456789";
const SECRET_OLD = "o".repeat(24) + "-old-secret-0123456789";
const ENV = { INTERNAL_SERVICE_KEYS: `k2:${SECRET_NEW},k1:${SECRET_OLD}` };
const OLD_ONLY_ENV = { INTERNAL_SERVICE_KEYS: `k1:${SECRET_OLD}` };
const NEW_ONLY_ENV = { INTERNAL_SERVICE_KEYS: `k2:${SECRET_NEW}` };
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);

const ALICE = {
  authenticated: true,
  authProvider: "static_token",
  permissionIds: ["documents.read"],
  roleIds: ["admin"],
  token: "public-api-token-must-not-travel",
  userId: " alice ",
  workspaceId: "ws-1",
};

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

// An independent signer, so the tests can build tokens the module would never
// mint (other algorithms, forged lifetimes).
const forgeToken = ({ header, payload, secret = SECRET_NEW }) => {
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = crypto.createHmac("sha256", secret).update(input).digest("base64url");

  return `${input}.${signature}`;
};

const basePayload = (overrides = {}) => ({
  aud: "agent",
  exp: Math.floor(T0 / 1000) + 60,
  iat: Math.floor(T0 / 1000),
  iss: "api",
  jti: "token-1",
  scope: { authenticated: true, userId: "alice", workspaceId: "ws-1" },
  ...overrides,
});

const expectRejection = (fn, { code, status }) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ServiceIdentityError, `expected ServiceIdentityError, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
};

const runMiddleware = (middleware, headers = {}) => {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  const req = {
    get: (name) => lowerHeaders[name.toLowerCase()],
    headers: lowerHeaders,
    rawHeaders: Object.entries(lowerHeaders).flat(),
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

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

test("keys parse with rotation order and report errors without secrets", () => {
  const parsed = parseServiceKeys(` k2:${SECRET_NEW} , k1:${SECRET_OLD} `);

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.keys.map((key) => key.keyId), ["k2", "k1"]);
  assert.deepEqual(getServiceKeyStatus(ENV), {
    configured: true,
    errors: [],
    keyIds: ["k2", "k1"],
    signingKeyId: "k2",
  });

  const shortSecret = "short-secret";
  const broken = parseServiceKeys(`bad key:${SECRET_NEW},k1:${shortSecret},k2:${SECRET_NEW},k2:${SECRET_OLD},nocolon`);

  assert.equal(broken.errors.length, 4);
  assert.ok(broken.errors.some((line) => /shorter than 32/u.test(line)));
  assert.ok(broken.errors.some((line) => /more than once/u.test(line)));
  assert.ok(!JSON.stringify(broken.errors).includes(shortSecret));
  assert.ok(!JSON.stringify(broken.errors).includes(SECRET_NEW));
  assert.equal(getServiceKeyStatus({}).configured, false);
  assert.equal(getServiceKeyStatus({ INTERNAL_SERVICE_KEYS: `k1:${shortSecret}` }).configured, false);
});

test("signing without keys, scope, or audience fails before a token exists", () => {
  expectRejection(
    () => signServiceToken({ accessScope: ALICE, audience: "agent", env: {}, issuer: "api" }),
    { code: SERVICE_IDENTITY_ERROR_CODES.notConfigured, status: 500 }
  );
  expectRejection(
    () =>
      signServiceToken({
        accessScope: ALICE,
        audience: "agent",
        env: { INTERNAL_SERVICE_KEYS: `k1:${SECRET_NEW},k1:${SECRET_OLD}` },
        issuer: "api",
      }),
    { code: SERVICE_IDENTITY_ERROR_CODES.notConfigured, status: 500 }
  );
  assert.throws(() => signServiceToken({ audience: "agent", env: ENV, issuer: "api" }), TypeError);
  assert.throws(() => signServiceToken({ accessScope: ALICE, env: ENV, issuer: "api" }), TypeError);
  assert.throws(() => signServiceToken({ accessScope: ALICE, audience: "agent", env: ENV }), TypeError);
  assert.throws(
    () => signServiceToken({ accessScope: ALICE, audience: "agent", env: ENV, issuer: "api", system: true }),
    TypeError
  );
});

test("a signed scope verifies to the requireApiAuth shape and drops everything else", () => {
  const token = signServiceToken({
    accessScope: ALICE,
    audience: "agent",
    claims: { runId: "run-1" },
    env: ENV,
    issuer: "api",
    now: T0,
  });
  const [header, payload] = token.split(".").slice(0, 2).map((part) =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
  );

  assert.deepEqual(header, { alg: "HS256", kid: "k2", typ: "JWT" });
  assert.equal(payload.exp - payload.iat, DEFAULT_SERVICE_TOKEN_TTL_MS / 1000);
  assert.ok(!token.includes(Buffer.from(ALICE.token).toString("base64url")));
  assert.ok(!JSON.stringify(payload).includes(ALICE.token));

  const identity = verifyServiceToken(token, { audience: "agent", env: ENV, now: T0 + 1000 });

  assert.deepEqual(identity.accessScope, {
    authenticated: true,
    authProvider: "static_token",
    permissionIds: ["documents.read"],
    roleIds: ["admin"],
    userId: "alice",
    workspaceId: "ws-1",
  });
  assert.equal(identity.issuer, "api");
  assert.equal(identity.audience, "agent");
  assert.deepEqual(identity.claims, { runId: "run-1" });
  assert.equal(identity.system, false);
  assert.equal(identity.keyId, "k2");
  assert.equal(identity.expiresAt, T0 + DEFAULT_SERVICE_TOKEN_TTL_MS);
  assert.equal(typeof identity.tokenId, "string");
});

test("an auth-disabled scope with empty ids travels as a scope, not as a system call", () => {
  const token = signServiceToken({
    accessScope: { authenticated: false, userId: "", workspaceId: "" },
    audience: "retrieval",
    env: ENV,
    issuer: "agent",
    now: T0,
  });
  const identity = verifyServiceToken(token, { audience: "retrieval", env: ENV, now: T0 });

  assert.equal(identity.system, false);
  assert.deepEqual(identity.accessScope, { authenticated: false, userId: "", workspaceId: "" });
});

test("forged algorithms are rejected, including none", () => {
  for (const alg of ["none", "HS512", "RS256", "hs256", undefined]) {
    const token = forgeToken({ header: { alg, kid: "k2", typ: "JWT" }, payload: basePayload() });

    expectRejection(() => verifyServiceToken(token, { audience: "agent", env: ENV, now: T0 }), {
      code: SERVICE_IDENTITY_ERROR_CODES.algorithm,
      status: 401,
    });
  }

  const unsigned = `${encode({ alg: "none", kid: "k2" })}.${encode(basePayload())}.`;

  expectRejection(() => verifyServiceToken(unsigned, { audience: "agent", env: ENV, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.malformed,
    status: 401,
  });

  const critical = forgeToken({ header: { alg: "HS256", crit: ["exp"], kid: "k2" }, payload: basePayload() });

  expectRejection(() => verifyServiceToken(critical, { audience: "agent", env: ENV, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.algorithm,
    status: 401,
  });
});

test("malformed, tampered, and unknown-key tokens are rejected", () => {
  const token = signServiceToken({ accessScope: ALICE, audience: "agent", env: ENV, issuer: "api", now: T0 });
  const [header, payload, signature] = token.split(".");
  const tamperedPayload = encode({
    ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    scope: { authenticated: true, userId: "mallory", workspaceId: "ws-1" },
  });

  expectRejection(
    () => verifyServiceToken(`${header}.${tamperedPayload}.${signature}`, { audience: "agent", env: ENV, now: T0 }),
    { code: SERVICE_IDENTITY_ERROR_CODES.signature, status: 401 }
  );
  const flippedSignature = `${signature.slice(0, 5)}${signature[5] === "A" ? "B" : "A"}${signature.slice(6)}`;

  expectRejection(
    () => verifyServiceToken(`${header}.${payload}.${flippedSignature}`, { audience: "agent", env: ENV, now: T0 }),
    { code: SERVICE_IDENTITY_ERROR_CODES.signature, status: 401 }
  );

  for (const bad of ["", "a.b", "a.b.c.d", "a.b.c d", `${header}.${payload}.${signature}=`, "x".repeat(9000)]) {
    expectRejection(() => verifyServiceToken(bad, { audience: "agent", env: ENV, now: T0 }), {
      code: bad ? SERVICE_IDENTITY_ERROR_CODES.malformed : SERVICE_IDENTITY_ERROR_CODES.missing,
      status: 401,
    });
  }

  const unknownKey = forgeToken({ header: { alg: "HS256", kid: "k9" }, payload: basePayload() });

  expectRejection(() => verifyServiceToken(unknownKey, { audience: "agent", env: ENV, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.unknownKey,
    status: 401,
  });

  // Right signature, but a payload that carries both a scope and the system
  // marker (or neither) is not a token this module mints.
  for (const payloadOverrides of [{ sys: true }, { scope: undefined }]) {
    const odd = forgeToken({ header: { alg: "HS256", kid: "k2" }, payload: basePayload(payloadOverrides) });

    expectRejection(() => verifyServiceToken(odd, { audience: "agent", env: ENV, now: T0 }), {
      code: SERVICE_IDENTITY_ERROR_CODES.malformed,
      status: 401,
    });
  }
});

test("expiry, not-before, and lifetime are checked with clock skew", () => {
  const token = signServiceToken({ accessScope: ALICE, audience: "agent", env: ENV, issuer: "api", now: T0, ttlMs: 60_000 });
  const verifyAt = (nowMs) => verifyServiceToken(token, { audience: "agent", clockSkewMs: 5000, env: ENV, now: nowMs });

  assert.equal(verifyAt(T0 + 60_000 + 4999).issuer, "api");
  expectRejection(() => verifyAt(T0 + 60_000 + 5000), {
    code: SERVICE_IDENTITY_ERROR_CODES.expired,
    status: 401,
  });
  assert.equal(verifyAt(T0 - 5000).issuer, "api");
  expectRejection(() => verifyAt(T0 - 5001), {
    code: SERVICE_IDENTITY_ERROR_CODES.notYetValid,
    status: 401,
  });

  const longLived = forgeToken({
    header: { alg: "HS256", kid: "k2" },
    payload: basePayload({ exp: Math.floor(T0 / 1000) + 2 * 60 * 60 }),
  });

  expectRejection(() => verifyServiceToken(longLived, { audience: "agent", env: ENV, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.lifetime,
    status: 401,
  });

  const configuredTtl = signServiceToken({
    accessScope: ALICE,
    audience: "agent",
    env: { ...ENV, INTERNAL_SERVICE_TOKEN_TTL_MS: "5000" },
    issuer: "api",
    now: T0,
  });

  assert.equal(verifyServiceToken(configuredTtl, { audience: "agent", env: ENV, now: T0 }).expiresAt, T0 + 5000);
});

test("audience and issuer mismatches are forbidden", () => {
  const token = signServiceToken({ accessScope: ALICE, audience: "retrieval", env: ENV, issuer: "agent", now: T0 });

  expectRejection(() => verifyServiceToken(token, { audience: "agent", env: ENV, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.audience,
    status: 403,
  });
  expectRejection(() => verifyServiceToken(token, { audience: "retrieval", env: ENV, issuers: ["api"], now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.issuer,
    status: 403,
  });
  assert.equal(
    verifyServiceToken(token, { audience: "retrieval", env: ENV, issuers: ["api", "agent"], now: T0 }).issuer,
    "agent"
  );
  assert.throws(() => verifyServiceToken(token, { env: ENV, now: T0 }), TypeError);
});

test("keys rotate: the old key keeps verifying until it is removed", () => {
  const oldToken = signServiceToken({ accessScope: ALICE, audience: "agent", env: OLD_ONLY_ENV, issuer: "api", now: T0 });
  const rotatedToken = signServiceToken({ accessScope: ALICE, audience: "agent", env: ENV, issuer: "api", now: T0 });

  assert.equal(verifyServiceToken(oldToken, { audience: "agent", env: ENV, now: T0 }).keyId, "k1");
  assert.equal(verifyServiceToken(rotatedToken, { audience: "agent", env: ENV, now: T0 }).keyId, "k2");
  assert.equal(verifyServiceToken(rotatedToken, { audience: "agent", env: NEW_ONLY_ENV, now: T0 }).keyId, "k2");
  expectRejection(() => verifyServiceToken(oldToken, { audience: "agent", env: NEW_ONLY_ENV, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.unknownKey,
    status: 401,
  });
  // Same key id, different secret: a signature failure, never a pass.
  expectRejection(
    () =>
      verifyServiceToken(oldToken, {
        audience: "agent",
        env: { INTERNAL_SERVICE_KEYS: `k1:${SECRET_NEW}` },
        now: T0,
      }),
    { code: SERVICE_IDENTITY_ERROR_CODES.signature, status: 401 }
  );
});

test("the middleware sets the requireApiAuth scope and hides the token", async () => {
  const principal = {
    permissions: ["documents.read"],
    roles: ["admin"],
    userId: "alice",
    workspaceId: "ws-1",
  };
  const edgeScope = await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_JWT_ENABLED: undefined,
      API_AUTH_TOKEN: undefined,
      API_AUTH_TOKENS: JSON.stringify({ "public-token": principal }),
      API_AUTH_WORKSPACE_REQUIRED: undefined,
    },
    () => {
      const req = {
        body: {},
        get: (name) => (name.toLowerCase() === "x-api-key" ? "public-token" : ""),
        path: "/chat",
        query: {},
      };
      let nextCalled = false;

      requireApiAuth(req, { json: () => {}, status: () => ({ json: () => {} }) }, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);

      return req.accessScope;
    }
  );
  const token = signServiceToken({
    accessScope: edgeScope,
    audience: "agent",
    env: ENV,
    issuer: "api",
  });
  const middleware = requireServiceIdentity({ audience: "agent", env: ENV });
  const { body, nextCalled, req } = runMiddleware(middleware, {
    [SERVICE_DEADLINE_HEADER]: "5000",
    [SERVICE_REQUEST_ID_HEADER]: "req-123",
    [SERVICE_TOKEN_HEADER]: token,
  });

  assert.equal(body, null);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.accessScope, edgeScope);
  assert.equal(req.serviceIdentity.issuer, "api");
  assert.equal(req.serviceIdentity.system, false);
  assert.equal(req.serviceIdentity.requestId, "req-123");
  assert.equal(getServiceRequestId(req), "req-123");
  assert.equal(req.headers[SERVICE_TOKEN_HEADER], undefined);
  assert.ok(!req.rawHeaders.includes(token));

  const remaining = getServiceDeadlineRemainingMs(req);

  assert.ok(remaining > 0 && remaining <= 5000, `remaining ${remaining}`);
  assert.equal(getServiceDeadlineRemainingMs(req, { now: req.serviceIdentity.deadlineAt + 10 }), 0);

  // Mounted again for the same audience, the already-verified request passes.
  let secondNext = false;
  middleware(req, { status: () => assert.fail("must not reject") }, () => {
    secondNext = true;
  });
  assert.equal(secondNext, true);
});

test("the middleware rejects without echoing the token", () => {
  const middleware = requireServiceIdentity({ audience: "agent", env: ENV });
  const missing = runMiddleware(middleware);

  assert.equal(missing.status, 401);
  assert.equal(missing.nextCalled, false);
  assert.deepEqual(missing.body, { code: SERVICE_IDENTITY_ERROR_CODES.missing, error: "Unauthorized." });

  const wrongAudience = signServiceToken({ accessScope: ALICE, audience: "retrieval", env: ENV, issuer: "api" });
  const forbidden = runMiddleware(middleware, { [SERVICE_TOKEN_HEADER]: wrongAudience });

  assert.equal(forbidden.status, 403);
  assert.deepEqual(forbidden.body, { code: SERVICE_IDENTITY_ERROR_CODES.audience, error: "Forbidden." });
  assert.ok(!JSON.stringify(forbidden.body).includes(wrongAudience));
  assert.equal(forbidden.req.accessScope, undefined);

  const forged = forgeToken({ header: { alg: "none", kid: "k2" }, payload: basePayload() });
  const unauthorized = runMiddleware(middleware, { [SERVICE_TOKEN_HEADER]: forged });

  assert.equal(unauthorized.status, 401);
  assert.ok(!JSON.stringify(unauthorized.body).includes(forged));

  const unconfigured = runMiddleware(requireServiceIdentity({ audience: "agent", env: {} }), {
    [SERVICE_TOKEN_HEADER]: wrongAudience,
  });

  assert.equal(unconfigured.status, 500);
  assert.equal(unconfigured.body.code, SERVICE_IDENTITY_ERROR_CODES.notConfigured);
  assert.throws(() => requireServiceIdentity({}), TypeError);
});

test("system calls need allowSystem and run as no database tenant", async () => {
  const systemToken = signServiceToken({ audience: "retrieval", env: ENV, issuer: "agent", system: true });

  assert.equal(verifyServiceToken(systemToken, { audience: "retrieval", env: ENV }).accessScope, null);

  const refused = runMiddleware(requireServiceIdentity({ audience: "retrieval", env: ENV }), {
    [SERVICE_TOKEN_HEADER]: systemToken,
  });

  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, SERVICE_IDENTITY_ERROR_CODES.systemNotAllowed);

  const accepted = runMiddleware(requireServiceIdentity({ allowSystem: true, audience: "retrieval", env: ENV }), {
    [SERVICE_TOKEN_HEADER]: systemToken,
  });

  assert.equal(accepted.nextCalled, true);
  assert.deepEqual(accepted.req.accessScope, { authenticated: false, userId: "", workspaceId: "" });
  assert.equal(accepted.req.serviceIdentity.system, true);

  const tenant = await new Promise((resolve) =>
    bindDatabaseTenant(accepted.req, {}, () => resolve(getActiveDatabaseTenant()))
  );

  assert.equal(tenant, null);
});

test("the edge strips every internal header from public requests", async () => {
  const plain = {
    "Content-Type": "application/json",
    "X-Archive-Service-Token": "forged",
    "x-archive-service-deadline-ms": "1",
    "x-request-id": "public-id",
  };

  assert.deepEqual(stripInternalServiceHeaders(plain).sort(), [
    "x-archive-service-deadline-ms",
    "x-archive-service-token",
  ]);
  assert.deepEqual(Object.keys(plain).sort(), ["Content-Type", "x-request-id"]);
  assert.deepEqual(stripInternalServiceHeaders(null), []);

  const app = express();
  app.use(stripInternalServiceHeadersMiddleware);
  app.use(requireServiceIdentity({ audience: "agent", env: ENV }));
  app.get("/probe", (req, res) => res.json({ ok: true }));

  const echo = express();
  echo.use(stripInternalServiceHeadersMiddleware);
  echo.get("/echo", (req, res) =>
    res.json({
      distinct: Object.keys(req.headersDistinct),
      headers: Object.keys(req.headers),
      raw: req.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase()),
      requestId: getServiceRequestId(req),
    })
  );

  const [server, echoServer] = await Promise.all([listen(app), listen(echo)]);

  try {
    // A valid token from a public client is still stripped at the edge.
    const token = signServiceToken({ accessScope: ALICE, audience: "agent", env: ENV, issuer: "api" });
    const probe = await fetch(`http://127.0.0.1:${server.address().port}/probe`, {
      headers: { [SERVICE_TOKEN_HEADER]: token },
    });

    assert.equal(probe.status, 401);

    const echoed = await (
      await fetch(`http://127.0.0.1:${echoServer.address().port}/echo`, {
        headers: {
          [SERVICE_DEADLINE_HEADER]: "10",
          [SERVICE_REQUEST_ID_HEADER]: "forged-id",
          [SERVICE_TOKEN_HEADER]: token,
          "x-request-id": "public-id",
        },
      })
    ).json();

    for (const names of [echoed.headers, echoed.raw, echoed.distinct]) {
      assert.ok(names.includes("x-request-id"));
      assert.ok(!names.some((name) => name.startsWith("x-archive-service-")), names.join(","));
    }

    assert.equal(echoed.requestId, null);
  } finally {
    server.close();
    echoServer.close();
  }
});

test("scope normalization keeps only the requireApiAuth fields", () => {
  assert.deepEqual(
    normalizeServiceAccessScope({
      allowed_workspace_ids: ["WS-1", "ws-2"],
      authenticated: "true",
      password: "nope",
      userId: 42,
    }),
    {
      allowedWorkspaceIds: ["ws-1", "ws-2"],
      authenticated: false,
      userId: "42",
      workspaceId: "",
    }
  );
  assert.throws(() => normalizeServiceAccessScope(null), TypeError);
  assert.throws(() => normalizeServiceAccessScope([]), TypeError);
});
