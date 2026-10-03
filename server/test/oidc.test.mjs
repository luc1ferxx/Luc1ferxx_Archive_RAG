import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import express from "express";

import { requireApiAuth } from "../auth.js";
import { createHs256Jwt, hashAuthToken } from "../auth-jwt.js";
import { getApiAuthConfigStatus } from "../rag/config.js";
import {
  buildPublicAuthConfig,
  createOidcVerifier,
  normalizeWorkspaceRoles,
  peekJwtHeader,
  resetDefaultOidcVerifier,
} from "../rag/oidc.js";
import { createAuthConfigRouter } from "../routes/auth-config.js";

const ISSUER = "https://idp.example.test";
const AUDIENCE = "archive-rag-api";
const CLIENT_ID = "archive-rag-spa";
const T0 = Date.parse("2026-10-03T00:00:00.000Z");
const T0_SECONDS = Math.floor(T0 / 1000);

const generateKey = (type, options, { alg, kid }) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync(type, options);
  return {
    alg,
    kid,
    privateKey,
    publicKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig" },
  };
};

const keys = {
  rsa: generateKey("rsa", { modulusLength: 2048 }, { alg: "RS256", kid: "rsa-1" }),
  rsa2: generateKey("rsa", { modulusLength: 2048 }, { alg: "RS256", kid: "rsa-2" }),
  ec: generateKey("ec", { namedCurve: "P-256" }, { alg: "ES256", kid: "ec-1" }),
  ed: generateKey("ed25519", undefined, { alg: "EdDSA", kid: "ed-1" }),
};

const b64 = (value) => Buffer.from(value).toString("base64url");

const signToken = ({ alg, header = {}, key, payload, signer }) => {
  const encodedHeader = b64(JSON.stringify({ alg, kid: key?.kid, typ: "at+jwt", ...header }));
  const encodedPayload = b64(JSON.stringify(payload));
  const input = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  let signature = Buffer.alloc(0);

  if (signer) {
    signature = signer(input);
  } else if (alg === "RS256") {
    signature = crypto.sign("sha256", input, key.privateKey);
  } else if (alg === "PS256") {
    signature = crypto.sign("sha256", input, {
      key: key.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
  } else if (alg === "ES256") {
    signature = crypto.sign("sha256", input, { dsaEncoding: "ieee-p1363", key: key.privateKey });
  } else if (alg === "EdDSA") {
    signature = crypto.sign(null, input, key.privateKey);
  }

  return `${encodedHeader}.${encodedPayload}.${b64(signature)}`;
};

const claims = (overrides = {}) => ({
  aud: AUDIENCE,
  azp: CLIENT_ID,
  exp: T0_SECONDS + 300,
  iat: T0_SECONDS,
  iss: ISSUER,
  jti: "jti-1",
  sub: "alice",
  ...overrides,
});

// An in-memory IdP behind a fetch stub: counts discovery and JWKS requests,
// and can be taken down.
const createFakeIdp = ({ issuer = ISSUER, jwks = [keys.rsa.jwk] } = {}) => {
  const idp = {
    calls: { discovery: 0, jwks: 0 },
    down: false,
    discoveryIssuer: issuer,
    jwks,
  };
  idp.fetch = async (url) => {
    if (idp.down) {
      throw new TypeError("fetch failed");
    }

    if (url === `${issuer}/.well-known/openid-configuration`) {
      idp.calls.discovery += 1;
      return new Response(
        JSON.stringify({ issuer: idp.discoveryIssuer, jwks_uri: `${issuer}/jwks` }),
        { status: 200 }
      );
    }

    if (url === `${issuer}/jwks`) {
      idp.calls.jwks += 1;
      return new Response(JSON.stringify({ keys: idp.jwks }), { status: 200 });
    }

    return new Response("{}", { status: 404 });
  };
  return idp;
};

const createClock = (start = T0) => {
  let current = start;
  const clock = () => current;
  clock.advance = (ms) => {
    current += ms;
  };
  return clock;
};

const makeVerifier = (idp, overrides = {}) =>
  createOidcVerifier({
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    fetchImpl: idp.fetch,
    issuer: ISSUER,
    jwksMinRefreshMs: 30_000,
    jwksTtlMs: 600_000,
    now: createClock(),
    revokedJtis: "",
    revokedTokenHashes: "",
    ...overrides,
  });

test("verifies RS256, PS256, ES256 and EdDSA tokens and maps claims", async () => {
  const idp = createFakeIdp({ jwks: [keys.rsa.jwk, keys.ec.jwk, keys.ed.jwk] });
  const verifier = makeVerifier(idp, {
    groupRoleMap: JSON.stringify({ "archive-admins": ["admin.operator"], viewers: "workspace.viewer" }),
  });
  const payload = claims({
    groups: ["archive-admins", "unmapped"],
    permissions: ["documents.read"],
    roles: ["workspace.member"],
    workspace_id: "Workspace-A",
    workspace_roles: { "Workspace-A": ["Workspace.Admin"], "workspace-b": "workspace.viewer" },
    workspaces: ["Workspace-A", "workspace-b"],
  });

  for (const [alg, key] of [
    ["RS256", keys.rsa],
    ["PS256", keys.rsa],
    ["ES256", keys.ec],
    ["EdDSA", keys.ed],
  ]) {
    const token = signToken({ alg, key, payload });
    const principal = await verifier.verify(token);

    assert.equal(principal.authProvider, "oidc", alg);
    assert.equal(principal.userId, "alice");
    assert.equal(principal.issuer, ISSUER);
    assert.equal(principal.jwtId, "jti-1");
    assert.equal(principal.workspaceId, "Workspace-A");
    assert.deepEqual(principal.allowedWorkspaceIds, ["Workspace-A", "workspace-b"]);
    assert.deepEqual(principal.roles, ["workspace.member", "admin.operator"]);
    assert.deepEqual(principal.permissions, ["documents.read"]);
    assert.deepEqual(principal.workspaceRoles, {
      "workspace-a": ["workspace.admin"],
      "workspace-b": ["workspace.viewer"],
    });
    assert.equal(principal.tokenHash, hashAuthToken(token));
  }

  assert.equal(idp.calls.discovery, 1);
  assert.equal(idp.calls.jwks, 1, "the key set is fetched once and cached");
});

test("an unknown kid refreshes the JWKS once per min-refresh window and picks up a rotated key", async () => {
  const idp = createFakeIdp({ jwks: [keys.rsa.jwk] });
  const clock = createClock();
  const verifier = makeVerifier(idp, { now: clock });

  await verifier.verify(signToken({ alg: "RS256", key: keys.rsa, payload: claims() }));
  assert.equal(idp.calls.jwks, 1);

  // A flood of unknown kids inside the window costs at most one refresh.
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      verifier.verify(
        signToken({ alg: "RS256", header: { kid: `bogus-${index}` }, key: keys.rsa, payload: claims() })
      ),
      /No matching signing key/
    );
  }
  assert.equal(idp.calls.jwks, 1, "a refresh was attempted at load; the window throttles the flood");

  clock.advance(31_000);
  await assert.rejects(
    verifier.verify(signToken({ alg: "RS256", header: { kid: "bogus-x" }, key: keys.rsa, payload: claims() }))
  );
  assert.equal(idp.calls.jwks, 2);

  // The IdP rotates: the new key is published and the old one removed.
  idp.jwks = [keys.rsa2.jwk];
  clock.advance(31_000);
  const principal = await verifier.verify(
    signToken({ alg: "RS256", key: keys.rsa2, payload: claims({ sub: "bob" }) })
  );
  assert.equal(principal.userId, "bob");
  assert.equal(idp.calls.jwks, 3);

  // The removed kid no longer verifies.
  await assert.rejects(
    verifier.verify(signToken({ alg: "RS256", key: keys.rsa, payload: claims() })),
    /No matching signing key/
  );
});

test("keeps serving the last good keys while the IdP is down; no keys at all is a 503", async () => {
  const idp = createFakeIdp();
  const clock = createClock();
  const verifier = makeVerifier(idp, { now: clock, jwksTtlMs: 1000 });
  const token = () => signToken({ alg: "RS256", key: keys.rsa, payload: claims() });

  await verifier.verify(token());
  idp.down = true;
  clock.advance(31_000);

  const principal = await verifier.verify(token());
  assert.equal(principal.userId, "alice");
  assert.equal(verifier.getStatus().lastError, "jwks_refresh_failed");
  assert.equal(verifier.getStatus().keyCount, 1);

  const coldVerifier = makeVerifier(idp);
  await assert.rejects(coldVerifier.verify(token()), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.message, "OIDC provider is unavailable.");
    return true;
  });
});

test("discovery must name the configured issuer exactly", async () => {
  const idp = createFakeIdp();
  idp.discoveryIssuer = `${ISSUER}/`;
  const verifier = makeVerifier(idp);

  await assert.rejects(
    verifier.verify(signToken({ alg: "RS256", key: keys.rsa, payload: claims() })),
    (error) => error.status === 503
  );
});

test("refuses algorithm confusion: HS256 with the RSA public key, ES key claiming RS256, none, oct keys", async () => {
  const octJwk = { k: b64("shared-secret-shared-secret-1234"), kid: "oct-1", kty: "oct" };
  const idp = createFakeIdp({ jwks: [keys.rsa.jwk, keys.ec.jwk, octJwk] });
  const verifier = makeVerifier(idp);
  const publicPem = keys.rsa.publicKey.export({ format: "pem", type: "spki" });

  const hsWithPublicKey = signToken({
    alg: "HS256",
    key: keys.rsa,
    payload: claims(),
    signer: (input) => crypto.createHmac("sha256", publicPem).update(input).digest(),
  });
  await assert.rejects(verifier.verify(hsWithPublicKey), /Unsupported token algorithm/);

  const hsWithOctKey = signToken({
    alg: "HS256",
    header: { kid: "oct-1" },
    payload: claims(),
    signer: (input) => crypto.createHmac("sha256", "shared-secret-shared-secret-1234").update(input).digest(),
  });
  await assert.rejects(verifier.verify(hsWithOctKey), /Unsupported token algorithm/);

  const ecClaimingRs = signToken({
    alg: "RS256",
    header: { kid: "ec-1" },
    payload: claims(),
    signer: (input) => crypto.sign("sha256", input, keys.ec.privateKey),
  });
  await assert.rejects(verifier.verify(ecClaimingRs), /does not match the signing key/);

  const rsKeyClaimingEs = signToken({
    alg: "ES256",
    header: { kid: "rsa-1" },
    payload: claims(),
    signer: (input) => crypto.sign("sha256", input, keys.rsa.privateKey),
  });
  await assert.rejects(verifier.verify(rsKeyClaimingEs), /does not match the signing key/);

  const unsigned = `${b64(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64(JSON.stringify(claims()))}.`;
  await assert.rejects(verifier.verify(unsigned), /Invalid token format|Unsupported token algorithm/);
  const unsignedWithSig = signToken({ alg: "none", payload: claims(), signer: () => Buffer.from("x") });
  await assert.rejects(verifier.verify(unsignedWithSig), /Unsupported token algorithm/);

  // A JWK that pins its own alg refuses a different (otherwise compatible) alg.
  const pinned = createFakeIdp({ jwks: [{ ...keys.rsa.jwk, alg: "PS256" }] });
  await assert.rejects(
    makeVerifier(pinned).verify(signToken({ alg: "RS256", key: keys.rsa, payload: claims() })),
    /does not match the signing key/
  );

  // An alg outside API_AUTH_OIDC_ALGORITHMS is refused even with a valid key.
  const rsOnly = makeVerifier(createFakeIdp({ jwks: [keys.ec.jwk] }), { algorithms: ["RS256"] });
  await assert.rejects(
    rsOnly.verify(signToken({ alg: "ES256", key: keys.ec, payload: claims() })),
    /Unsupported token algorithm/
  );

  // A tampered payload fails the signature.
  const valid = signToken({ alg: "RS256", key: keys.rsa, payload: claims() });
  const [header, , signature] = valid.split(".");
  const tampered = `${header}.${b64(JSON.stringify(claims({ sub: "mallory" })))}.${signature}`;
  await assert.rejects(verifier.verify(tampered), /Invalid token signature/);

  // crit headers are not understood, so they are refused.
  await assert.rejects(
    verifier.verify(signToken({ alg: "RS256", header: { crit: ["exp"] }, key: keys.rsa, payload: claims() })),
    /critical/
  );
});

test("checks issuer, audience, authorized party, typ and revocation", async () => {
  const idp = createFakeIdp();
  const verifier = makeVerifier(idp);
  const sign = (overrides, header) =>
    signToken({ alg: "RS256", header, key: keys.rsa, payload: claims(overrides) });

  await assert.rejects(verifier.verify(sign({ iss: `${ISSUER}/` })), /Invalid token issuer/);
  await assert.rejects(verifier.verify(sign({ aud: "other-api" })), /Invalid token audience/);
  assert.equal((await verifier.verify(sign({ aud: ["other-api", AUDIENCE] }))).userId, "alice");
  await assert.rejects(verifier.verify(sign({ azp: "other-client" })), /authorized party/);
  await assert.rejects(verifier.verify(sign({ azp: undefined })), /authorized party/);
  assert.equal(
    (await verifier.verify(sign({ azp: undefined, client_id: CLIENT_ID }))).userId,
    "alice"
  );

  // Without API_AUTH_OIDC_CLIENT_ID the authorized party is not checked.
  const anyClient = makeVerifier(idp, { clientId: "" });
  assert.equal((await anyClient.verify(sign({ azp: "other-client" }))).userId, "alice");

  const typRequired = makeVerifier(idp, { requireTyp: true });
  assert.equal((await typRequired.verify(sign({}))).userId, "alice");
  await assert.rejects(typRequired.verify(sign({}, { typ: "JWT" })), /not an access token/);

  const revoked = makeVerifier(idp, { revokedJtis: "jti-9" });
  await assert.rejects(revoked.verify(sign({ jti: "jti-9" })), /revoked/);
  const token = sign({});
  const revokedHash = makeVerifier(idp, { revokedTokenHashes: hashAuthToken(token) });
  await assert.rejects(revokedHash.verify(token), /revoked/);
});

test("checks exp, nbf and iat with the configured clock skew", async () => {
  const idp = createFakeIdp();
  const verifier = makeVerifier(idp, { clockSkewSec: 60 });
  const sign = (overrides) => signToken({ alg: "RS256", key: keys.rsa, payload: claims(overrides) });

  await assert.rejects(verifier.verify(sign({ exp: T0_SECONDS - 61 })), /expired/);
  assert.equal((await verifier.verify(sign({ exp: T0_SECONDS - 30 }))).userId, "alice", "inside skew");
  await assert.rejects(verifier.verify(sign({ exp: undefined })), /no expiry/);
  await assert.rejects(verifier.verify(sign({ exp: "9999999999" })), /time claim/);
  await assert.rejects(verifier.verify(sign({ nbf: T0_SECONDS + 120 })), /not active yet/);
  assert.equal((await verifier.verify(sign({ nbf: T0_SECONDS + 30 }))).userId, "alice");
  await assert.rejects(verifier.verify(sign({ iat: T0_SECONDS + 120 })), /issued in the future/);

  const strict = makeVerifier(idp, { clockSkewSec: 0 });
  await assert.rejects(strict.verify(sign({ exp: T0_SECONDS })), /expired/);
});

test("a token without the user claim is refused; custom claim paths work", async () => {
  const idp = createFakeIdp();
  const verifier = makeVerifier(idp);

  await assert.rejects(
    verifier.verify(signToken({ alg: "RS256", key: keys.rsa, payload: claims({ sub: undefined }) })),
    /user claim is missing/
  );
  await assert.rejects(
    verifier.verify(signToken({ alg: "RS256", key: keys.rsa, payload: claims({ sub: { id: "x" } }) })),
    /user claim is missing/
  );

  const custom = makeVerifier(idp, {
    claims: { roles: "app.roles", user: "app.user", workspaceRoles: "app.ws_roles" },
  });
  const principal = await custom.verify(
    signToken({
      alg: "RS256",
      key: keys.rsa,
      payload: claims({ app: { roles: ["r1"], user: "carol", ws_roles: [{ roles: ["editor"], workspace_id: "w1" }] } }),
    })
  );
  assert.equal(principal.userId, "carol");
  assert.deepEqual(principal.roles, ["r1"]);
  assert.deepEqual(principal.workspaceRoles, { w1: ["editor"] });
});

test("configuration errors are 500s and never a pass", async () => {
  const idp = createFakeIdp();
  const token = signToken({ alg: "RS256", key: keys.rsa, payload: claims() });

  await assert.rejects(makeVerifier(idp, { audience: "" }).verify(token), (error) => error.status === 500);
  await assert.rejects(
    makeVerifier(idp, { issuer: "http://idp.example.test" }).verify(token),
    (error) => error.status === 500,
    "plain http is accepted for loopback issuers only"
  );
  await assert.rejects(makeVerifier(idp, { algorithms: ["HS256", "none"] }).verify(token), (error) => error.status === 500);
  assert.throws(() => makeVerifier(idp, { groupRoleMap: "[1]" }), (error) => error.status === 500);
});

test("normalizeWorkspaceRoles and peekJwtHeader", () => {
  assert.deepEqual(normalizeWorkspaceRoles({ " WS-A ": "Editor, viewer", b: [], c: [1, "x"] }), {
    "ws-a": ["editor", "viewer"],
    c: ["x"],
  });
  assert.deepEqual(normalizeWorkspaceRoles("ws-a:editor"), {});
  assert.deepEqual(normalizeWorkspaceRoles(null), {});
  assert.equal(peekJwtHeader("not-a-jwt"), null);
  assert.equal(peekJwtHeader("static-token-value"), null);
  assert.equal(peekJwtHeader(signToken({ alg: "RS256", key: keys.rsa, payload: claims() })).alg, "RS256");
});

// --- requireApiAuth with OIDC -------------------------------------------------

const AUTH_ENV_KEYS = [
  "API_AUTH_ENABLED",
  "API_AUTH_TOKEN",
  "API_AUTH_TOKENS",
  "API_AUTH_JWT_ENABLED",
  "API_AUTH_JWT_SECRET",
  "API_AUTH_JWT_HS256_SECRET",
  "API_AUTH_REQUIRE_WORKSPACE",
  "API_AUTH_REVOKED_JTIS",
  "API_AUTH_REVOKED_TOKEN_HASHES",
  "API_AUTH_OIDC_ENABLED",
  "API_AUTH_OIDC_ISSUER",
  "API_AUTH_OIDC_AUDIENCE",
  "API_AUTH_OIDC_CLIENT_ID",
  "API_AUTH_OIDC_SCOPES",
  "API_AUTH_OIDC_JWKS_MIN_REFRESH_MS",
];

const withEnv = async (values, run) => {
  const saved = Object.fromEntries(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of AUTH_ENV_KEYS) {
    delete process.env[key];
  }

  Object.assign(process.env, values);
  resetDefaultOidcVerifier();

  try {
    return await run();
  } finally {
    for (const key of AUTH_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }

    resetDefaultOidcVerifier();
  }
};

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
        url: `http://127.0.0.1:${port}`,
      });
    });
  });

// A loopback discovery + JWKS server, so the default verifier (global fetch)
// runs exactly as in production.
const startLoopbackIdp = async (jwks = [keys.rsa.jwk, keys.ec.jwk]) => {
  let issuer = "";
  const server = await listen((req, res) => {
    res.setHeader("content-type", "application/json");

    if (req.url === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }

    if (req.url === "/jwks") {
      res.end(JSON.stringify({ keys: jwks }));
      return;
    }

    res.statusCode = 404;
    res.end("{}");
  });
  issuer = server.url;
  return { ...server, issuer };
};

const startApi = () => {
  const app = express();
  app.use(express.json());
  app.use(createAuthConfigRouter());
  app.use(requireApiAuth);
  app.get("/whoami", (req, res) => res.json(req.accessScope));
  return listen(app);
};

const loopbackClaims = (issuer, overrides = {}) =>
  claims({ exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), iss: issuer, ...overrides });

test("requireApiAuth accepts OIDC tokens and applies today's workspace selection rules", async () => {
  const idp = await startLoopbackIdp();
  const api = await startApi();

  try {
    await withEnv(
      {
        API_AUTH_ENABLED: "true",
        API_AUTH_OIDC_AUDIENCE: AUDIENCE,
        API_AUTH_OIDC_CLIENT_ID: CLIENT_ID,
        API_AUTH_OIDC_ENABLED: "true",
        API_AUTH_OIDC_ISSUER: idp.issuer,
        API_AUTH_TOKENS: JSON.stringify({
          "static-token-1": {
            userId: "svc",
            workspaceId: "workspace-a",
            workspaceRoles: { "workspace-a": ["workspace.editor"] },
          },
        }),
      },
      async () => {
        assert.deepEqual(getApiAuthConfigStatus().modes, ["static_token", "oidc"]);
        assert.equal(getApiAuthConfigStatus().status, "ok");

        const call = (token, headers = {}) =>
          fetch(`${api.url}/whoami`, {
            headers: { authorization: `Bearer ${token}`, ...headers },
          });
        const multi = signToken({
          alg: "ES256",
          key: keys.ec,
          payload: loopbackClaims(idp.issuer, {
            roles: ["Workspace.Member"],
            workspace_roles: { "workspace-a": ["workspace.admin"] },
            workspaces: ["workspace-a", "workspace-b"],
          }),
        });

        let response = await call(multi, { "x-workspace-id": "workspace-b" });
        assert.equal(response.status, 200);
        let scope = await response.json();
        assert.equal(scope.authenticated, true);
        assert.equal(scope.authProvider, "oidc");
        assert.equal(scope.userId, "alice");
        assert.equal(scope.workspaceId, "workspace-b");
        assert.deepEqual(scope.allowedWorkspaceIds, ["workspace-a", "workspace-b"]);
        assert.deepEqual(scope.roleIds, ["workspace.member"]);
        assert.deepEqual(scope.workspaceRoles, { "workspace-a": ["workspace.admin"] });
        assert.equal(JSON.stringify(scope).includes(multi), false, "the token is never on the scope");

        response = await call(multi, { "x-workspace-id": "workspace-c" });
        assert.equal(response.status, 403);
        assert.match((await response.json()).error, /outside authenticated scope/);

        response = await call(multi);
        assert.equal((await response.json()).workspaceId, "", "two workspaces and no header: none chosen");

        const single = signToken({
          alg: "RS256",
          key: keys.rsa,
          payload: loopbackClaims(idp.issuer, { workspaces: ["workspace-a"] }),
        });
        response = await call(single);
        assert.equal((await response.json()).workspaceId, "workspace-a", "a single workspace is selected");

        const pinned = signToken({
          alg: "RS256",
          key: keys.rsa,
          payload: loopbackClaims(idp.issuer, { workspace_id: "workspace-a" }),
        });
        response = await call(pinned, { "x-workspace-id": "workspace-b" });
        assert.equal(response.status, 403);

        const expired = signToken({
          alg: "RS256",
          key: keys.rsa,
          payload: loopbackClaims(idp.issuer, { exp: Math.floor(Date.now() / 1000) - 3600 }),
        });
        response = await call(expired);
        assert.equal(response.status, 401);
        const body = await response.text();
        assert.equal(body, JSON.stringify({ error: "Unauthorized." }));
        assert.equal(body.includes(expired), false);

        // Static tokens keep working next to OIDC, and carry workspaceRoles.
        response = await call("static-token-1");
        assert.equal(response.status, 200);
        scope = await response.json();
        assert.equal(scope.authProvider, "static_token");
        assert.deepEqual(scope.workspaceRoles, { "workspace-a": ["workspace.editor"] });

        response = await fetch(`${api.url}/auth/config`);
        assert.deepEqual(await response.json(), {
          mode: "oidc",
          oidc: {
            audience: AUDIENCE,
            clientId: CLIENT_ID,
            issuer: idp.issuer,
            scopes: ["openid", "profile", "email"],
          },
        });
      }
    );
  } finally {
    await api.close();
    await idp.close();
  }
});

test("HS256 JWTs keep their verifier next to OIDC; an HS token never reaches OIDC", async () => {
  const idp = await startLoopbackIdp();
  const api = await startApi();

  try {
    const env = {
      API_AUTH_ENABLED: "true",
      API_AUTH_OIDC_AUDIENCE: AUDIENCE,
      API_AUTH_OIDC_ENABLED: "true",
      API_AUTH_OIDC_ISSUER: idp.issuer,
    };
    const hsToken = createHs256Jwt({
      payload: { exp: Math.floor(Date.now() / 1000) + 60, sub: "hs-user" },
      secret: "hs-secret",
    });

    await withEnv({ ...env, API_AUTH_JWT_ENABLED: "true", API_AUTH_JWT_SECRET: "hs-secret" }, async () => {
      const response = await fetch(`${api.url}/whoami`, { headers: { authorization: `Bearer ${hsToken}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).authProvider, "jwt");
    });

    await withEnv(env, async () => {
      const response = await fetch(`${api.url}/whoami`, { headers: { authorization: `Bearer ${hsToken}` } });
      assert.equal(response.status, 401, "with HS256 JWT auth off an HS token goes to OIDC, which refuses it");
    });
  } finally {
    await api.close();
    await idp.close();
  }
});

test("with API_AUTH_OIDC_ENABLED unset an OIDC token is not accepted and nothing changes", async () => {
  const idp = await startLoopbackIdp();
  const api = await startApi();

  try {
    await withEnv(
      {
        API_AUTH_ENABLED: "true",
        API_AUTH_OIDC_AUDIENCE: AUDIENCE,
        API_AUTH_OIDC_ISSUER: idp.issuer,
        API_AUTH_TOKEN: "static-token",
      },
      async () => {
        const status = getApiAuthConfigStatus();
        assert.deepEqual(status.modes, ["static_token"]);
        assert.equal("oidcEnabled" in status, false, "the status report keeps its shape");

        const oidcToken = signToken({ alg: "RS256", key: keys.rsa, payload: loopbackClaims(idp.issuer) });
        let response = await fetch(`${api.url}/whoami`, { headers: { authorization: `Bearer ${oidcToken}` } });
        assert.equal(response.status, 401);

        response = await fetch(`${api.url}/whoami`, { headers: { "x-api-key": "static-token" } });
        assert.equal(response.status, 200);
        const scope = await response.json();
        assert.equal("workspaceRoles" in scope, false);

        response = await fetch(`${api.url}/auth/config`);
        assert.deepEqual(await response.json(), { mode: "token", oidc: null });
      }
    );

    await withEnv({}, async () => {
      assert.deepEqual(buildPublicAuthConfig(), { mode: "disabled", oidc: null });
    });
  } finally {
    await api.close();
    await idp.close();
  }
});

test("OIDC enabled without an audience refuses requests with a configuration error", async () => {
  const api = await startApi();

  try {
    await withEnv(
      { API_AUTH_ENABLED: "true", API_AUTH_OIDC_ENABLED: "true", API_AUTH_OIDC_ISSUER: "https://idp.example.test" },
      async () => {
        assert.equal(getApiAuthConfigStatus().status, "error");
        const response = await fetch(`${api.url}/whoami`, { headers: { authorization: "Bearer a.b.c" } });
        assert.equal(response.status, 500);
      }
    );
  } finally {
    await api.close();
  }
});
