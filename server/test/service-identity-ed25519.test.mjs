import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  fingerprintServiceKeyId,
  generateServiceKeyPair,
  parseServiceSigningKey,
  parseTrustedServiceKeys,
  SERVICE_ISSUERS,
} from "../rag/service-identity-keys.js";
import {
  getServiceAuthMode,
  getServiceKeyStatus,
  SERVICE_IDENTITY_ERROR_CODES,
  ServiceIdentityError,
  signServiceToken,
  verifyServiceToken,
} from "../rag/service-identity.js";
import {
  describeServiceTopology,
  getServiceIssuer,
  validateServiceTopology,
} from "../rag/service-topology.js";

// INTERNAL_SERVICE_AUTH=ed25519 and mixed: each process signs with its own
// Ed25519 key, verifiers bind every public key to one issuer, and keys are
// pinned to their algorithm. The hmac default is covered by
// service-identity.test.mjs, which must keep passing unchanged.

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const HMAC_SECRET = "h".repeat(40);
const HMAC_KEYS = `h1:${HMAC_SECRET}`;
const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-1" };
const PAIRS = Object.fromEntries(
  ["agent", "all", "api", "retrieval"].map((issuer) => [issuer, generateServiceKeyPair({ issuer })])
);
const TRUSTED = Object.values(PAIRS)
  .map((pair) => pair.trustedEntry)
  .join(",");

// The environment of the process that runs as `issuer` under `mode`.
const tierEnv = (issuer, { mode = "ed25519", ...extra } = {}) => ({
  INTERNAL_SERVICE_AUTH: mode,
  INTERNAL_SERVICE_SIGNING_KEY: PAIRS[issuer].privateKeyBase64,
  INTERNAL_SERVICE_TRUSTED_KEYS: TRUSTED,
  ...extra,
});
const VERIFY_ONLY = { INTERNAL_SERVICE_AUTH: "ed25519", INTERNAL_SERVICE_TRUSTED_KEYS: TRUSTED };

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

const basePayload = (overrides = {}) => ({
  aud: "agent",
  exp: Math.floor(T0 / 1000) + 60,
  iat: Math.floor(T0 / 1000),
  iss: "api",
  jti: "token-1",
  scope: ALICE,
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

const signAs = (issuer, { audience = "agent", env, ...options } = {}) =>
  signServiceToken({
    accessScope: ALICE,
    audience,
    env: env ?? tierEnv(issuer),
    issuer,
    now: T0,
    ...options,
  });

test("signing keys parse from base64 DER or PEM and never echo key material", () => {
  const pair = PAIRS.api;
  const fromBase64 = parseServiceSigningKey(pair.privateKeyBase64);
  const pem = crypto
    .createPrivateKey({ format: "der", key: Buffer.from(pair.privateKeyBase64, "base64"), type: "pkcs8" })
    .export({ format: "pem", type: "pkcs8" });
  const fromPem = parseServiceSigningKey(pem);
  const fromEscapedPem = parseServiceSigningKey(pem.replace(/\n/g, "\\n"), "api-2026-10");

  assert.equal(fromBase64.error, null);
  assert.equal(fromBase64.key.keyId, pair.keyId);
  assert.equal(fromBase64.key.publicKeyBase64, pair.publicKeyBase64);
  assert.equal(fromPem.key.publicKeyBase64, pair.publicKeyBase64);
  assert.equal(fromEscapedPem.key.keyId, "api-2026-10");
  assert.equal(pair.keyId, fingerprintServiceKeyId(Buffer.from(pair.publicKeyBase64, "base64")));
  assert.deepEqual(parseServiceSigningKey(""), { error: null, key: null });

  const x25519 = crypto.generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const refusals = [
    parseServiceSigningKey("not a key!"),
    parseServiceSigningKey(x25519),
    parseServiceSigningKey(pair.privateKeyBase64.slice(0, 20)),
    parseServiceSigningKey(pair.privateKeyBase64, "bad kid"),
  ];

  for (const { error, key } of refusals) {
    assert.equal(key, null);
    assert.equal(typeof error, "string");
    assert.ok(!error.includes(pair.privateKeyBase64.slice(0, 16)));
  }

  assert.match(refusals[1].error, /Ed25519/);
});

test("trusted keys bind each public key to a known issuer", () => {
  const parsed = parseTrustedServiceKeys(` ${PAIRS.api.trustedEntry} , ${PAIRS.agent.trustedEntry} `);

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(
    parsed.entries.map(({ issuer, keyId }) => [issuer, keyId]),
    [
      ["api", PAIRS.api.keyId],
      ["agent", PAIRS.agent.keyId],
    ]
  );
  assert.deepEqual(parsed.byKeyId.get(PAIRS.api.keyId).issuers, ["api"]);

  const shared = parseTrustedServiceKeys(
    `api:k1:${PAIRS.api.publicKeyBase64},all:k1:${PAIRS.api.publicKeyBase64}`
  );

  assert.deepEqual(shared.errors, []);
  assert.deepEqual(shared.byKeyId.get("k1").issuers, ["api", "all"]);

  const broken = parseTrustedServiceKeys(
    [
      `agnet:k1:${PAIRS.agent.publicKeyBase64}`,
      `api:${PAIRS.api.publicKeyBase64}`,
      `api:bad kid:${PAIRS.api.publicKeyBase64}`,
      "api:k2:bm90LWEta2V5",
      `api:k3:${PAIRS.api.publicKeyBase64}`,
      `agent:k3:${PAIRS.agent.publicKeyBase64}`,
      `api:k3:${PAIRS.api.publicKeyBase64}`,
    ].join(",")
  );

  assert.equal(broken.errors.length, 6);
  assert.match(broken.errors[0], /unknown issuer/);
  assert.match(broken.errors[4], /two different keys/);
  assert.match(broken.errors[5], /more than once/);
  assert.ok(broken.errors.every((line) => !line.includes(PAIRS.api.publicKeyBase64)));
  assert.deepEqual(SERVICE_ISSUERS, ["agent", "all", "api", "ingest-worker", "model-gateway", "retrieval"]);
});

test("ed25519 tokens are EdDSA, signed by the process's own key, and verified by its public key", () => {
  const token = signAs("api", { claims: { runId: "run-1" } });
  const [header, payload, signature] = token.split(".");

  assert.deepEqual(decode(header), { alg: "EdDSA", kid: PAIRS.api.keyId, typ: "JWT" });
  assert.equal(decode(payload).iss, "api");
  assert.equal(Buffer.from(signature, "base64url").length, 64);

  // A tier that only verifies needs no private key.
  const identity = verifyServiceToken(token, { audience: "agent", env: VERIFY_ONLY, now: T0 + 1000 });

  assert.equal(identity.algorithm, "EdDSA");
  assert.equal(identity.issuer, "api");
  assert.equal(identity.keyId, PAIRS.api.keyId);
  assert.deepEqual(identity.accessScope, ALICE);
  assert.deepEqual(identity.claims, { runId: "run-1" });
  assert.equal(identity.binding, null);

  expectRejection(() => verifyServiceToken(token, { audience: "agent", env: VERIFY_ONLY, now: T0 + 70_000 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.expired,
    status: 401,
  });
  expectRejection(() => verifyServiceToken(token, { audience: "retrieval", env: VERIFY_ONLY, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.audience,
    status: 403,
  });

  // A verify-only tier cannot sign, and a pure signer cannot verify.
  expectRejection(() => signAs("api", { env: VERIFY_ONLY }), {
    code: SERVICE_IDENTITY_ERROR_CODES.notConfigured,
    status: 500,
  });
  expectRejection(
    () =>
      verifyServiceToken(token, {
        audience: "agent",
        env: { INTERNAL_SERVICE_AUTH: "ed25519", INTERNAL_SERVICE_SIGNING_KEY: PAIRS.api.privateKeyBase64 },
        now: T0,
      }),
    { code: SERVICE_IDENTITY_ERROR_CODES.notConfigured, status: 500 }
  );
});

test("a tier's key cannot sign as another issuer", () => {
  // The retrieval tier's real key, claiming to be the edge.
  const forged = signAs("retrieval", { env: tierEnv("retrieval"), issuer: "api" });

  expectRejection(() => verifyServiceToken(forged, { audience: "agent", env: VERIFY_ONLY, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.keyIssuer,
    status: 401,
  });
  // As itself it verifies; the receiver's policy decides whether it may call.
  assert.equal(
    verifyServiceToken(signAs("retrieval", { audience: "model-gateway" }), {
      audience: "model-gateway",
      env: VERIFY_ONLY,
      now: T0,
    }).issuer,
    "retrieval"
  );

  // A key nobody registered is unknown, even with a valid signature.
  const stranger = generateServiceKeyPair({ issuer: "api" });
  const unknown = signAs("api", {
    env: { ...VERIFY_ONLY, INTERNAL_SERVICE_SIGNING_KEY: stranger.privateKeyBase64 },
  });

  expectRejection(() => verifyServiceToken(unknown, { audience: "agent", env: VERIFY_ONLY, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.unknownKey,
    status: 401,
  });

  // A registered key id with someone else's key behind it fails the signature.
  const impostor = signAs("api", {
    env: {
      ...VERIFY_ONLY,
      INTERNAL_SERVICE_SIGNING_KEY: stranger.privateKeyBase64,
      INTERNAL_SERVICE_SIGNING_KEY_ID: PAIRS.api.keyId,
    },
  });

  expectRejection(() => verifyServiceToken(impostor, { audience: "agent", env: VERIFY_ONLY, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.signature,
    status: 401,
  });

  // Tampering with a signed payload breaks the signature.
  const [header, payload, signature] = signAs("api").split(".");
  const tampered = `${header}.${encode({ ...decode(payload), scope: { ...ALICE, userId: "mallory" } })}.${signature}`;

  expectRejection(() => verifyServiceToken(tampered, { audience: "agent", env: VERIFY_ONLY, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.signature,
    status: 401,
  });
});

test("keys are pinned to their algorithm: no alg confusion in either direction", () => {
  const edKey = PAIRS.api;
  const hmacToken = (secret, keyId, payload = basePayload()) => {
    const input = `${encode({ alg: "HS256", kid: keyId, typ: "JWT" })}.${encode(payload)}`;

    return `${input}.${crypto.createHmac("sha256", secret).update(input).digest("base64url")}`;
  };
  const mixedEnv = tierEnv("api", { INTERNAL_SERVICE_KEYS: HMAC_KEYS, mode: "mixed" });

  // The classic confusion: HS256 keyed with the Ed25519 public key, naming
  // the Ed25519 key id. Refused under ed25519 (HS256 is not accepted at all)
  // and under mixed (the key id is an EdDSA key).
  for (const secret of [edKey.publicKeyBase64, Buffer.from(edKey.publicKeyBase64, "base64")]) {
    const confused = hmacToken(secret, edKey.keyId);

    for (const env of [VERIFY_ONLY, mixedEnv]) {
      expectRejection(() => verifyServiceToken(confused, { audience: "agent", env, now: T0 }), {
        code: SERVICE_IDENTITY_ERROR_CODES.algorithm,
        status: 401,
      });
    }
  }

  // A valid HS256 token is refused under ed25519, accepted under mixed.
  const legacy = hmacToken(HMAC_SECRET, "h1");

  expectRejection(
    () => verifyServiceToken(legacy, { audience: "agent", env: { ...VERIFY_ONLY, INTERNAL_SERVICE_KEYS: HMAC_KEYS }, now: T0 }),
    { code: SERVICE_IDENTITY_ERROR_CODES.algorithm, status: 401 }
  );
  assert.equal(verifyServiceToken(legacy, { audience: "agent", env: mixedEnv, now: T0 }).algorithm, "HS256");

  // An EdDSA header naming an HMAC key id is refused under mixed; an EdDSA
  // token is refused under hmac.
  const edToken = signAs("api");
  const [, payload, signature] = edToken.split(".");
  const relabelled = `${encode({ alg: "EdDSA", kid: "h1", typ: "JWT" })}.${payload}.${signature}`;

  expectRejection(() => verifyServiceToken(relabelled, { audience: "agent", env: mixedEnv, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.algorithm,
    status: 401,
  });
  expectRejection(() => verifyServiceToken(edToken, { audience: "agent", env: { INTERNAL_SERVICE_KEYS: HMAC_KEYS }, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.algorithm,
    status: 401,
  });

  for (const alg of ["none", "ES256", "eddsa", "Ed25519", undefined]) {
    const forged = `${encode({ alg, kid: edKey.keyId })}.${payload}.${signature}`;

    expectRejection(() => verifyServiceToken(forged, { audience: "agent", env: VERIFY_ONLY, now: T0 }), {
      code: SERVICE_IDENTITY_ERROR_CODES.algorithm,
      status: 401,
    });
  }

  // A signature that is not exactly 64 bytes, or not canonically encoded, is
  // refused before verification.
  for (const bad of [signature.slice(0, -4), `${signature}AAAA`, `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`]) {
    expectRejection(() => verifyServiceToken(`${edToken.split(".").slice(0, 2).join(".")}.${bad}`, { audience: "agent", env: VERIFY_ONLY, now: T0 }), {
      code: SERVICE_IDENTITY_ERROR_CODES.signature,
      status: 401,
    });
  }

  // A key id listed both as an HMAC key and as a trusted key is refused whole.
  expectRejection(
    () =>
      verifyServiceToken(edToken, {
        audience: "agent",
        env: { ...mixedEnv, INTERNAL_SERVICE_KEYS: `${edKey.keyId}:${HMAC_SECRET}` },
        now: T0,
      }),
    { code: SERVICE_IDENTITY_ERROR_CODES.notConfigured, status: 500 }
  );
});

test("mixed mode signs EdDSA and accepts both schemes, for a rolling upgrade", () => {
  const mixedApi = tierEnv("api", { INTERNAL_SERVICE_KEYS: HMAC_KEYS, mode: "mixed" });
  const hmacApi = { INTERNAL_SERVICE_KEYS: HMAC_KEYS };
  const mixedAgent = { ...VERIFY_ONLY, INTERNAL_SERVICE_AUTH: "mixed", INTERNAL_SERVICE_KEYS: HMAC_KEYS };
  const edAgent = VERIFY_ONLY;
  const fromMixed = signAs("api", { env: mixedApi });
  const fromHmac = signAs("api", { env: hmacApi });

  assert.equal(decode(fromMixed.split(".")[0]).alg, "EdDSA");
  assert.equal(decode(fromHmac.split(".")[0]).alg, "HS256");

  // Callees first: a mixed agent takes both an old (hmac) and a new (mixed)
  // edge's tokens; an ed25519 agent only the new one.
  assert.equal(verifyServiceToken(fromMixed, { audience: "agent", env: mixedAgent, now: T0 }).algorithm, "EdDSA");
  assert.equal(verifyServiceToken(fromHmac, { audience: "agent", env: mixedAgent, now: T0 }).algorithm, "HS256");
  assert.equal(verifyServiceToken(fromMixed, { audience: "agent", env: edAgent, now: T0 }).algorithm, "EdDSA");
  expectRejection(() => verifyServiceToken(fromHmac, { audience: "agent", env: edAgent, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.algorithm,
    status: 401,
  });

  // A verifier still on hmac cannot read a mixed signer's token: that is why
  // the callees move first.
  expectRejection(() => verifyServiceToken(fromMixed, { audience: "agent", env: hmacApi, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.algorithm,
    status: 401,
  });

  // An unknown mode is a configuration error everywhere, never a fallback.
  assert.throws(() => getServiceAuthMode({ INTERNAL_SERVICE_AUTH: "rsa" }), (error) => error.status === 500);
  assert.equal(getServiceAuthMode({}), "hmac");
  assert.equal(getServiceAuthMode({ INTERNAL_SERVICE_AUTH: " Mixed " }), "mixed");
  expectRejection(() => signAs("api", { env: { ...mixedApi, INTERNAL_SERVICE_AUTH: "rsa" } }), {
    code: SERVICE_IDENTITY_ERROR_CODES.notConfigured,
    status: 500,
  });
});

test("an Ed25519 key rotates in three rolls without a refused call", () => {
  const next = generateServiceKeyPair({ issuer: "api" });
  const before = VERIFY_ONLY;
  const step1 = { ...VERIFY_ONLY, INTERNAL_SERVICE_TRUSTED_KEYS: `${TRUSTED},${next.trustedEntry}` };
  const step3 = {
    ...VERIFY_ONLY,
    INTERNAL_SERVICE_TRUSTED_KEYS: [PAIRS.agent, PAIRS.all, PAIRS.retrieval, next].map((pair) => pair.trustedEntry).join(","),
  };
  const oldToken = signAs("api");
  const newToken = signAs("api", { env: { ...step1, INTERNAL_SERVICE_SIGNING_KEY: next.privateKeyBase64 } });

  assert.notEqual(next.keyId, PAIRS.api.keyId, "fingerprint ids never collide");

  // 1. Every tier trusts both keys; the edge still signs with the old one.
  assert.equal(verifyServiceToken(oldToken, { audience: "agent", env: step1, now: T0 }).keyId, PAIRS.api.keyId);
  // 2. The edge switches; tiers that already trust the new key accept it,
  //    and the old key's tokens stay valid for their lifetime.
  assert.equal(verifyServiceToken(newToken, { audience: "agent", env: step1, now: T0 }).keyId, next.keyId);
  expectRejection(() => verifyServiceToken(newToken, { audience: "agent", env: before, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.unknownKey,
    status: 401,
  });
  // 3. The old public key is removed everywhere.
  assert.equal(verifyServiceToken(newToken, { audience: "agent", env: step3, now: T0 }).keyId, next.keyId);
  expectRejection(() => verifyServiceToken(oldToken, { audience: "agent", env: step3, now: T0 }), {
    code: SERVICE_IDENTITY_ERROR_CODES.unknownKey,
    status: 401,
  });
});

test("key status and the topology description name key ids, never keys", () => {
  const env = { ...tierEnv("agent", { mode: "mixed" }), ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_KEYS: HMAC_KEYS, RETRIEVAL_SERVICE_URL: "http://retrieval:5002" };
  const status = getServiceKeyStatus(env);
  const description = describeServiceTopology(env);
  const text = JSON.stringify({ description, status });

  assert.equal(status.configured, true);
  assert.equal(status.mode, "mixed");
  assert.equal(status.signingKeyId, PAIRS.agent.keyId);
  assert.ok(status.keyIds.includes("h1") && status.keyIds.includes(PAIRS.api.keyId));
  assert.deepEqual(
    status.trustedKeys.find((entry) => entry.issuer === "api"),
    { issuer: "api", keyId: PAIRS.api.keyId }
  );
  assert.equal(description.internalIdentity.mode, "mixed");
  assert.equal(description.internalIdentity.issuer, "agent");

  for (const pair of Object.values(PAIRS)) {
    assert.ok(!text.includes(pair.privateKeyBase64.slice(-24)));
    assert.ok(!text.includes(pair.publicKeyBase64.slice(-24)));
  }

  assert.ok(!text.includes(HMAC_SECRET));

  // Under hmac the original shape is unchanged.
  assert.deepEqual(Object.keys(getServiceKeyStatus({ INTERNAL_SERVICE_KEYS: HMAC_KEYS })).sort(), [
    "configured",
    "errors",
    "keyIds",
    "signingKeyId",
  ]);
  assert.equal(getServiceKeyStatus({ INTERNAL_SERVICE_AUTH: "rsa" }).configured, false);
  assert.equal(getServiceKeyStatus(VERIFY_ONLY).configured, true, "a verify-only gateway is configured");
});

test("topology validation refuses ed25519 setups that cannot work", () => {
  const lines = (env) => validateServiceTopology(env);
  const has = (list, pattern) => list.some((line) => pattern.test(line));

  // A calling tier without its own key.
  const agentWithoutKey = lines({ ...VERIFY_ONLY, ARCHIVE_RAG_ROLE: "agent", RETRIEVAL_SERVICE_URL: "http://r:5002" });

  assert.ok(has(agentWithoutKey.errors, /set INTERNAL_SERVICE_SIGNING_KEY/), JSON.stringify(agentWithoutKey));

  // A called tier that trusts none of its callers.
  const retrievalTrustingNobody = lines({
    ARCHIVE_RAG_ROLE: "retrieval",
    INTERNAL_SERVICE_AUTH: "ed25519",
    INTERNAL_SERVICE_TRUSTED_KEYS: PAIRS.api.trustedEntry,
  });

  assert.ok(has(retrievalTrustingNobody.errors, /accepts calls from agent, all, but INTERNAL_SERVICE_TRUSTED_KEYS holds no key/));

  // Its own key registered for another issuer: every call would be refused.
  const misbound = lines({
    ...tierEnv("api"),
    AGENT_SERVICE_URL: "http://agent:5001",
    ARCHIVE_RAG_ROLE: "agent",
    RETRIEVAL_SERVICE_URL: "http://r:5002",
  });

  assert.ok(has(misbound.errors, /binds this process's signing key .* to api, not to agent/));

  // Its own key id listed with another public key.
  const swapped = lines({
    ...tierEnv("agent"),
    ARCHIVE_RAG_ROLE: "agent",
    INTERNAL_SERVICE_TRUSTED_KEYS: `agent:${PAIRS.agent.keyId}:${PAIRS.api.publicKeyBase64}`,
    RETRIEVAL_SERVICE_URL: "http://r:5002",
  });

  assert.ok(has(swapped.errors, /with another public key/));

  // mixed on a called tier needs the HMAC keys of the tiers not yet moved.
  const mixedWithoutHmac = lines({ ...VERIFY_ONLY, ARCHIVE_RAG_ROLE: "model-gateway", INTERNAL_SERVICE_AUTH: "mixed" });

  assert.ok(has(mixedWithoutHmac.errors, /mixed accepts HS256 tokens/));

  // Unknown mode, malformed keys, a key speaking for several issuers, and a
  // leftover HMAC keyring.
  assert.ok(has(lines({ ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_AUTH: "rsa" }).errors, /INTERNAL_SERVICE_AUTH must be one of/));
  assert.ok(has(lines({ INTERNAL_SERVICE_AUTH: "rsa" }).warnings, /INTERNAL_SERVICE_AUTH must be one of/), "the monolith only warns");
  assert.ok(has(lines({ ...VERIFY_ONLY, ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_TRUSTED_KEYS: "api:k1:xx" }).errors, /not a base64 SPKI/));

  const sharedKey = lines({
    ...VERIFY_ONLY,
    ARCHIVE_RAG_ROLE: "model-gateway",
    INTERNAL_SERVICE_KEYS: HMAC_KEYS,
    INTERNAL_SERVICE_TRUSTED_KEYS: `api:k1:${PAIRS.api.publicKeyBase64},agent:k1:${PAIRS.api.publicKeyBase64}`,
  });

  assert.deepEqual(sharedKey.errors, []);
  assert.ok(has(sharedKey.warnings, /binds key "k1" to api, agent/));
  assert.ok(has(sharedKey.warnings, /INTERNAL_SERVICE_KEYS is not used/));

  // A complete split under ed25519 says nothing.
  const gateway = { MODEL_GATEWAY_URL: "http://gw:5003" };
  const calls = {
    agent: { ...gateway, RETRIEVAL_SERVICE_URL: "http://retrieval:5002" },
    api: { ...gateway, AGENT_SERVICE_URL: "http://agent:5001" },
    retrieval: gateway,
  };

  for (const [role, urls] of Object.entries(calls)) {
    assert.deepEqual(lines({ ...tierEnv(role), ...urls, ARCHIVE_RAG_ROLE: role }), { errors: [], warnings: [] }, role);
  }

  assert.deepEqual(lines({ ...VERIFY_ONLY, ARCHIVE_RAG_ROLE: "model-gateway" }), { errors: [], warnings: [] });
  // The monolith with nothing configured is unchanged by the mode.
  assert.deepEqual(lines({ INTERNAL_SERVICE_AUTH: "ed25519" }), { errors: [], warnings: [] });
});

test("only a dedicated ingest worker signs as ingest-worker", () => {
  assert.equal(getServiceIssuer({}), "all");
  assert.equal(getServiceIssuer({ ARCHIVE_RAG_ROLE: "agent" }), "agent");
  assert.equal(getServiceIssuer({ INTERNAL_SERVICE_ISSUER: " Ingest-Worker " }), "ingest-worker");
  assert.throws(() => getServiceIssuer({ INTERNAL_SERVICE_ISSUER: "api" }), /may only be ingest-worker/);
  assert.throws(() => getServiceIssuer({ ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_ISSUER: "ingest-worker" }), /ARCHIVE_RAG_ROLE is all/);

  assert.ok(
    validateServiceTopology({ INTERNAL_SERVICE_ISSUER: "api" }).errors.some((line) => /may only be ingest-worker/.test(line))
  );
  assert.ok(
    validateServiceTopology({ ARCHIVE_RAG_ROLE: "retrieval", INTERNAL_SERVICE_ISSUER: "ingest-worker", INTERNAL_SERVICE_KEYS: HMAC_KEYS })
      .errors.some((line) => /dedicated ingest worker/.test(line))
  );

  // A worker with its own key, registered as ingest-worker, calling the gateway.
  const worker = generateServiceKeyPair({ issuer: "ingest-worker" });
  const env = {
    INTERNAL_SERVICE_AUTH: "ed25519",
    INTERNAL_SERVICE_ISSUER: "ingest-worker",
    INTERNAL_SERVICE_SIGNING_KEY: worker.privateKeyBase64,
    INTERNAL_SERVICE_TRUSTED_KEYS: `${TRUSTED},${worker.trustedEntry}`,
    MODEL_GATEWAY_URL: "http://gw:5003",
  };

  assert.deepEqual(validateServiceTopology(env), { errors: [], warnings: [] });

  const token = signServiceToken({ audience: "model-gateway", env, issuer: getServiceIssuer(env), now: T0, system: true });

  assert.equal(verifyServiceToken(token, { audience: "model-gateway", env, now: T0 }).issuer, "ingest-worker");
});
