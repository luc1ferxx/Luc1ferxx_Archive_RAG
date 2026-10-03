import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { AGENT_SERVICE_CALLER_ROLES } from "../rag/agent-service/contract.js";
import { DEFAULT_RETRIEVAL_SERVICE_ISSUERS } from "../rag/retrieval-service/app.js";
import { createServiceClient } from "../rag/service-client.js";
import { generateServiceKeyPair, SERVICE_ISSUERS } from "../rag/service-identity-keys.js";
import {
  canonicalizeServiceRequestTarget,
  digestServiceRequestBody,
  getServiceCallPolicyIssuers,
  handleServiceRequestBodyError,
  isServiceReplayCacheEnabled,
  isServiceRequestBindingRequired,
  listServiceIdentitySettingErrors,
  requireServiceIdentity,
  SERVICE_CALL_POLICY,
  SERVICE_IDENTITY_ERROR_CODES,
  SERVICE_TOKEN_HEADER,
  ServiceIdentityError,
  signServiceToken,
  verifyServiceRequestBody,
  verifyServiceToken,
} from "../rag/service-identity.js";
import {
  createServiceTokenReplayCache,
  describeServiceTokenReplayCache,
  getServiceReplayCacheMaxEntries,
  getServiceTokenReplayCache,
  resetServiceTokenReplayCache,
} from "../rag/service-token-replay.js";
import { SERVICE_ROLES, SERVICE_TIERS, validateServiceTopology } from "../rag/service-topology.js";

// Who may call whom (SERVICE_CALL_POLICY), request binding (method, target,
// body), and the replay cache, end to end through the real service client
// and requireServiceIdentity over HTTP, under hmac and ed25519.

const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-1" };
const HMAC_ENV = Object.freeze({ INTERNAL_SERVICE_KEYS: `b1:${"b".repeat(40)}` });
const PAIRS = Object.fromEntries(
  ["agent", "all", "api", "ingest-worker", "retrieval"].map((issuer) => [issuer, generateServiceKeyPair({ issuer })])
);
const TRUSTED = Object.values(PAIRS)
  .map((pair) => pair.trustedEntry)
  .join(",");
const edEnv = (issuer) => ({
  INTERNAL_SERVICE_AUTH: "ed25519",
  INTERNAL_SERVICE_SIGNING_KEY: PAIRS[issuer]?.privateKeyBase64 ?? "",
  INTERNAL_SERVICE_TRUSTED_KEYS: TRUSTED,
});
// The signing and the verifying side's environment per scheme.
const MODES = {
  ed25519: { caller: (issuer) => edEnv(issuer), receiver: () => edEnv("model-gateway") },
  hmac: { caller: () => HMAC_ENV, receiver: () => HMAC_ENV },
};

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

// One internal tier: identity, then the JSON parser with the body check, as
// the agent, retrieval and gateway apps mount them.
const startReceiver = async (t, { audience = "agent", env, issuers, purpose, replayCache } = {}) => {
  const app = express();
  const seen = [];

  app.use(requireServiceIdentity({ allowSystem: true, audience, env, issuers, purpose, replayCache }));
  app.use(express.json({ verify: verifyServiceRequestBody }));
  app.use(handleServiceRequestBodyError);
  app.all("*", (req, res) => {
    seen.push({ body: req.body, issuer: req.serviceIdentity.issuer, method: req.method, url: req.originalUrl });
    res.json({ ok: true });
  });

  const server = await listen(app);

  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { seen, url: `http://127.0.0.1:${server.address().port}` };
};

// A service client that records every request it sends, tokens included.
const createRecordingClient = ({ audience = "agent", env, issuer, urls }) => {
  const sent = [];
  const client = createServiceClient({
    audience,
    env,
    fetch: (url, init) => {
      sent.push({ body: init.body, headers: { ...init.headers }, method: init.method, url });
      return fetch(url, init);
    },
    issuer,
    urls,
  });

  return { client, sent };
};

// A raw request, as an attacker holding a captured token would send it
// (node:http, which unlike fetch sends a body with any method).
const send = (url, { body, contentType = "application/json", method = "GET", token }) =>
  new Promise((resolve, reject) => {
    const request = http.request(url, {
      headers: {
        ...(body === undefined
          ? {}
          : { "content-length": Buffer.byteLength(body), ...(contentType ? { "content-type": contentType } : {}) }),
        [SERVICE_TOKEN_HEADER]: token,
      },
      method,
    });

    request.on("response", (response) => {
      let text = "";

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => resolve({ json: JSON.parse(text), status: response.statusCode }));
    });
    request.on("error", reject);
    request.end(body);
  });

test("the call policy is one table that matches every call site", () => {
  const tiers = Object.values(SERVICE_TIERS);

  assert.deepEqual(Object.keys(SERVICE_CALL_POLICY).sort(), [...tiers].sort());

  for (const [audience, { callers, probers }] of Object.entries(SERVICE_CALL_POLICY)) {
    for (const issuer of [...callers, ...probers]) {
      assert.ok(SERVICE_ISSUERS.includes(issuer), `${audience}: ${issuer}`);
      assert.notEqual(issuer, audience, "no tier calls itself");
      assert.notEqual(issuer, "model-gateway", "the gateway calls nobody");
    }

    assert.ok(callers.every((issuer) => probers.includes(issuer)), `${audience}: a caller may also probe`);
  }

  // Every issuer but the gateway is a role or the ingest worker, and every
  // calling role reaches the gateway.
  assert.deepEqual(
    SERVICE_ISSUERS.filter((issuer) => issuer !== "ingest-worker"),
    [...SERVICE_ROLES].sort()
  );
  assert.deepEqual(getServiceCallPolicyIssuers("model-gateway"), ["agent", "all", "api", "ingest-worker", "retrieval"]);
  assert.deepEqual(getServiceCallPolicyIssuers("agent"), ["all", "api"]);
  assert.deepEqual(getServiceCallPolicyIssuers("retrieval"), ["agent", "all"]);
  assert.deepEqual(getServiceCallPolicyIssuers("retrieval", "probe"), ["agent", "all", "api"]);
  assert.deepEqual(getServiceCallPolicyIssuers("api"), []);
  // The call sites read the table.
  assert.equal(AGENT_SERVICE_CALLER_ROLES, SERVICE_CALL_POLICY.agent.callers);
  assert.equal(DEFAULT_RETRIEVAL_SERVICE_ISSUERS, SERVICE_CALL_POLICY.retrieval.callers);

  // A call site may narrow the table, never widen it or invent an audience.
  assert.throws(() => requireServiceIdentity({ audience: "retrieval", issuers: ["api"] }), /SERVICE_CALL_POLICY/);
  assert.throws(() => requireServiceIdentity({ audience: "web" }), /SERVICE_CALL_POLICY/);
  assert.throws(() => requireServiceIdentity({ audience: "agent", purpose: "admin" }), TypeError);
  assert.doesNotThrow(() => requireServiceIdentity({ audience: "retrieval", issuers: ["agent"] }));
});

for (const mode of Object.keys(MODES)) {
  test(`${mode}: the receiver admits only the issuers the policy names`, async (t) => {
    const { caller, receiver } = MODES[mode];
    const tiers = {
      agent: await startReceiver(t, { audience: "agent", env: receiver(), replayCache: createServiceTokenReplayCache({ shared: null }) }),
      "model-gateway": await startReceiver(t, { audience: "model-gateway", env: receiver() }),
      retrieval: await startReceiver(t, { audience: "retrieval", env: receiver() }),
      retrievalPing: await startReceiver(t, { audience: "retrieval", env: receiver(), purpose: "probe" }),
    };
    const call = async (issuer, tier, { system = false } = {}) => {
      const audience = tier === "retrievalPing" ? "retrieval" : tier;
      const { client } = createRecordingClient({ audience, env: caller(issuer), issuer, urls: [tiers[tier].url] });

      return client.request({ accessScope: system ? undefined : ALICE, path: "/probe", system });
    };

    for (const [tier, admitted] of [
      ["agent", ["all", "api"]],
      ["retrieval", ["agent", "all"]],
      ["model-gateway", ["agent", "all", "api", "ingest-worker", "retrieval"]],
      ["retrievalPing", ["agent", "all", "api"]],
    ]) {
      for (const issuer of Object.keys(PAIRS)) {
        const answer = await call(issuer, tier, { system: tier === "retrievalPing" });

        assert.equal(answer.status, admitted.includes(issuer) ? 200 : 403, `${issuer} -> ${tier}`);

        if (!admitted.includes(issuer)) {
          assert.equal(answer.json.code, SERVICE_IDENTITY_ERROR_CODES.issuer);
        }
      }
    }
  });

  test(`${mode}: a token is bound to its method, target and body`, async (t) => {
    const { caller, receiver } = MODES[mode];
    const tier = await startReceiver(t, { env: receiver(), replayCache: createServiceTokenReplayCache({ shared: null }) });
    const { client, sent } = createRecordingClient({ env: caller("api"), issuer: "api", urls: [tier.url] });

    // A query with characters fetch percent-encodes still matches.
    const posted = await client.request({ accessScope: ALICE, body: { question: "q" }, method: "POST", path: '/chat?mode="fast"&n=1' });
    const fetched = await client.request({ accessScope: ALICE, path: "/agent-runs/run-1" });

    assert.equal(posted.status, 200);
    assert.equal(fetched.status, 200);
    assert.deepEqual(tier.seen[0], { body: { question: "q" }, issuer: "api", method: "POST", url: "/chat?mode=%22fast%22&n=1" });

    const postToken = sent[0].headers[SERVICE_TOKEN_HEADER];
    const getToken = sent[1].headers[SERVICE_TOKEN_HEADER];
    const identity = verifyServiceToken(postToken, { audience: "agent", env: receiver() });

    assert.equal(identity.binding.method, "POST");
    assert.equal(identity.binding.bodyDigest, digestServiceRequestBody('{"question":"q"}'));
    assert.equal(verifyServiceToken(getToken, { audience: "agent", env: receiver() }).binding.bodyDigest, null);

    // Every refusal below is checked before the replay cache, so each would
    // be a binding refusal even for a fresh token.
    const refusals = [
      [{ body: '{"question":"q"}', method: "POST", path: "/admin/actions/recovery-scan", token: postToken }, "requestMismatch"],
      [{ body: '{"question":"q"}', method: "PUT", path: '/chat?mode="fast"&n=1', token: postToken }, "requestMismatch"],
      [{ body: '{"question":"q"}', method: "POST", path: "/chat?mode=%22fast%22&n=2", token: postToken }, "requestMismatch"],
      [{ method: "GET", path: "/agent-runs/run-2", token: getToken }, "requestMismatch"],
      [{ method: "DELETE", path: "/agent-runs/run-1", token: getToken }, "requestMismatch"],
      // The same route with a body the token never named.
      [{ body: '{"question":"q"}', method: "GET", path: "/agent-runs/run-1", token: getToken }, "bodyMismatch"],
      // The signed route without its body.
      [{ method: "POST", path: '/chat?mode="fast"&n=1', token: postToken }, "bodyMismatch"],
    ];

    for (const [{ body, method, path, token }, code] of refusals) {
      const answer = await send(`${tier.url}${path}`, { body, method, token });

      assert.equal(answer.status, 401, `${method} ${path}`);
      assert.deepEqual(answer.json, { code: SERVICE_IDENTITY_ERROR_CODES[code], error: "Unauthorized." });
    }

    // Another body of the same length on the signed route, with a token
    // nobody has used yet: the header checks pass and the parser's body check
    // refuses it.
    const unused = signServiceToken({
      accessScope: ALICE,
      audience: "agent",
      env: caller("api"),
      issuer: "api",
      request: { body: '{"question":"q"}', method: "POST", target: "/chat" },
    });
    const swapped = await send(`${tier.url}/chat`, { body: '{"question":"x"}', method: "POST", token: unused });

    assert.equal(swapped.status, 401);
    assert.deepEqual(swapped.json, { code: SERVICE_IDENTITY_ERROR_CODES.bodyMismatch, error: "Unauthorized." });

    // The parser checks the bytes of JSON only. Any other content type (or
    // none) would reach the route with the body unparsed and unchecked, so a
    // token that names a body is refused with it, even an unused one; JSON
    // with any letter case and parameters still gets through.
    const signChat = () =>
      signServiceToken({
        accessScope: ALICE,
        audience: "agent",
        env: caller("api"),
        issuer: "api",
        request: { body: '{"question":"q"}', method: "POST", target: "/chat" },
      });

    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const answer = await send(`${tier.url}/chat`, { body: '{"question":"x"}', contentType, method: "POST", token: signChat() });

      assert.equal(answer.status, 401, String(contentType));
      assert.deepEqual(answer.json, { code: SERVICE_IDENTITY_ERROR_CODES.bodyMismatch, error: "Unauthorized." });
    }

    const accepted = await send(`${tier.url}/chat`, {
      body: '{"question":"q"}',
      contentType: "Application/JSON; charset=utf-8",
      method: "POST",
      token: signChat(),
    });

    assert.equal(accepted.status, 200);
    assert.deepEqual(tier.seen.at(-1).body, { question: "q" });
    assert.equal(tier.seen.length, 3, "no refused request reached a route");
  });
}

test("binding is required for EdDSA, optional for HS256, and settable either way", async (t) => {
  const unboundEd = signServiceToken({ accessScope: ALICE, audience: "agent", env: edEnv("api"), issuer: "api" });
  const unboundHmac = signServiceToken({ accessScope: ALICE, audience: "agent", env: HMAC_ENV, issuer: "api" });
  const request = { hasBody: false, method: "GET", target: "/probe" };
  const verify = (token, env) => verifyServiceToken(token, { audience: "agent", env, request });

  assert.throws(() => verify(unboundEd, edEnv("agent")), (error) => error.code === SERVICE_IDENTITY_ERROR_CODES.requestUnbound);
  assert.equal(verify(unboundHmac, HMAC_ENV).issuer, "api", "older HS256 callers keep working");
  assert.throws(
    () => verify(unboundHmac, { ...HMAC_ENV, INTERNAL_SERVICE_REQUEST_BINDING: "required" }),
    (error) => error.code === SERVICE_IDENTITY_ERROR_CODES.requestUnbound
  );
  assert.equal(verify(unboundEd, { ...edEnv("agent"), INTERNAL_SERVICE_REQUEST_BINDING: "optional" }).issuer, "api");
  // Without a request, verification does not judge the binding.
  assert.equal(verifyServiceToken(unboundEd, { audience: "agent", env: edEnv("agent") }).binding, null);

  assert.equal(isServiceRequestBindingRequired("EdDSA", {}), true);
  assert.equal(isServiceRequestBindingRequired("HS256", {}), false);
  assert.equal(isServiceRequestBindingRequired("HS256", { INTERNAL_SERVICE_REQUEST_BINDING: "required" }), true);

  // A binding that claims a body is refused on a request without one, and a
  // malformed binding is malformed.
  const bound = signServiceToken({
    accessScope: ALICE,
    audience: "agent",
    env: edEnv("api"),
    issuer: "api",
    request: { body: "{}", method: "post", target: "/chat" },
  });

  assert.throws(
    () => verifyServiceToken(bound, { audience: "agent", env: edEnv("agent"), request: { hasBody: false, method: "POST", target: "/chat" } }),
    (error) => error.code === SERVICE_IDENTITY_ERROR_CODES.bodyMismatch
  );
  assert.equal(
    verifyServiceToken(bound, { audience: "agent", env: edEnv("agent"), request: { hasBody: true, method: "POST", target: "/chat" } }).binding.method,
    "POST"
  );
  assert.throws(
    () => signServiceToken({ accessScope: ALICE, audience: "agent", env: HMAC_ENV, issuer: "api", request: { method: "GET", target: "chat" } }),
    TypeError
  );
  assert.throws(
    () => signServiceToken({ accessScope: ALICE, audience: "agent", env: HMAC_ENV, issuer: "api", request: { body: {}, method: "POST", target: "/chat" } }),
    TypeError
  );

  // The canonical target is what fetch sends and Node receives.
  assert.equal(canonicalizeServiceRequestTarget('/a/./b/../c?q="x y"'), "/a/c?q=%22x%20y%22");
  assert.equal(canonicalizeServiceRequestTarget("/a?x"), "/a?x");
  assert.equal(digestServiceRequestBody(""), null);
  assert.equal(digestServiceRequestBody(new TextEncoder().encode("{}")), digestServiceRequestBody("{}"));

  // The middleware refuses an unbound EdDSA token over HTTP too.
  const tier = await startReceiver(t, { env: edEnv("agent"), replayCache: createServiceTokenReplayCache({ shared: null }) });
  const answer = await send(`${tier.url}/probe`, { token: unboundEd });

  assert.equal(answer.status, 401);
  assert.equal(answer.json.code, SERVICE_IDENTITY_ERROR_CODES.requestUnbound);
});

test("a mistyped binding or replay switch refuses a split tier instead of falling back", () => {
  // A split tier under hmac that asked for the replay cache and strict binding.
  const agentTier = {
    ...HMAC_ENV,
    ARCHIVE_RAG_ROLE: "agent",
    INTERNAL_SERVICE_REPLAY_CACHE: "on",
    INTERNAL_SERVICE_REQUEST_BINDING: "required",
  };

  assert.deepEqual(validateServiceTopology(agentTier).errors, []);
  assert.equal(isServiceReplayCacheEnabled(agentTier), true);

  // Mistyped, each would quietly mean the hmac defaults: no replay cache, and
  // HS256 tokens without a binding accepted.
  for (const [variable, value] of [
    ["INTERNAL_SERVICE_REPLAY_CACHE", "enabled"],
    ["INTERNAL_SERVICE_REQUEST_BINDING", "strict"],
  ]) {
    const { errors } = validateServiceTopology({ ...agentTier, [variable]: value });

    assert.equal(errors.length, 1, variable);
    assert.match(errors[0], new RegExp(`^${variable} must be`, "u"));
    assert.doesNotMatch(errors[0], new RegExp(value, "u"), "the value is not echoed");
  }

  // Every spelling the switches read is accepted; the monolith only warns.
  for (const value of ["1", "ON", "true", "yes", "0", "off", "False", "no", ""]) {
    assert.deepEqual(listServiceIdentitySettingErrors({ INTERNAL_SERVICE_REPLAY_CACHE: value }), [], value);
  }

  for (const value of ["required", "Optional", ""]) {
    assert.deepEqual(listServiceIdentitySettingErrors({ INTERNAL_SERVICE_REQUEST_BINDING: value }), [], value);
  }

  const monolith = validateServiceTopology({ INTERNAL_SERVICE_REPLAY_CACHE: "enabled" });

  assert.deepEqual(monolith.errors, []);
  assert.equal(monolith.warnings.length, 1);
});

test("a token is accepted once; failover and retries use fresh tokens", async (t) => {
  const shared = createServiceTokenReplayCache({ shared: null });
  // Two replicas of one tier sharing a replay cache, as RAG_SHARED_STATE=redis
  // does across processes. The first answers 503 once, so the client fails over.
  let firstReplicaCalls = 0;
  const flaky = express();

  flaky.use(requireServiceIdentity({ audience: "agent", env: edEnv("agent"), replayCache: shared }));
  flaky.use((req, res) => {
    firstReplicaCalls += 1;
    res.status(503).json({ code: "BUSY" });
  });

  const flakyServer = await listen(flaky);

  t.after(() => new Promise((resolve) => flakyServer.close(resolve)));

  const healthy = await startReceiver(t, { env: edEnv("agent"), replayCache: shared });
  const { client, sent } = createRecordingClient({
    env: edEnv("api"),
    issuer: "api",
    urls: [`http://127.0.0.1:${flakyServer.address().port}`, healthy.url],
  });
  const answer = await client.request({ accessScope: ALICE, path: "/agent-runs/run-1" });

  assert.equal(answer.status, 200);
  assert.equal(firstReplicaCalls, 1);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].headers[SERVICE_TOKEN_HEADER], sent[1].headers[SERVICE_TOKEN_HEADER]);

  // Replaying either attempt's token, to either replica, is refused.
  for (const { headers } of sent) {
    for (const url of [healthy.url, `http://127.0.0.1:${flakyServer.address().port}`]) {
      const replay = await send(`${url}/agent-runs/run-1`, { token: headers[SERVICE_TOKEN_HEADER] });

      assert.equal(replay.status, 401);
      assert.equal(replay.json.code, SERVICE_IDENTITY_ERROR_CODES.replayed);
    }
  }

  assert.equal(healthy.seen.length, 1);
  assert.equal(shared.describe().replays, 4);

  // Under hmac the cache is off by default (tokens stay bearer tokens for
  // their lifetime, as before) and can be turned on.
  assert.equal(isServiceReplayCacheEnabled({}), false);
  assert.equal(isServiceReplayCacheEnabled({ INTERNAL_SERVICE_AUTH: "ed25519" }), true);
  assert.equal(isServiceReplayCacheEnabled({ INTERNAL_SERVICE_AUTH: "mixed", INTERNAL_SERVICE_REPLAY_CACHE: "off" }), false);

  const hmacTier = await startReceiver(t, { env: HMAC_ENV, replayCache: createServiceTokenReplayCache({ shared: null }) });
  const strictHmacTier = await startReceiver(t, {
    env: { ...HMAC_ENV, INTERNAL_SERVICE_REPLAY_CACHE: "on" },
    replayCache: createServiceTokenReplayCache({ shared: null }),
  });
  const hmacToken = signServiceToken({
    accessScope: ALICE,
    audience: "agent",
    env: HMAC_ENV,
    issuer: "api",
    request: { method: "GET", target: "/x" },
  });

  assert.equal((await send(`${hmacTier.url}/x`, { token: hmacToken })).status, 200);
  assert.equal((await send(`${hmacTier.url}/x`, { token: hmacToken })).status, 200);
  assert.equal((await send(`${strictHmacTier.url}/x`, { token: hmacToken })).status, 200);
  assert.equal((await send(`${strictHmacTier.url}/x`, { token: hmacToken })).json.code, SERVICE_IDENTITY_ERROR_CODES.replayed);
});

test("the replay cache is bounded, expires entries, and shares through a store", async () => {
  let nowMs = 1_000;
  const local = createServiceTokenReplayCache({ maxEntries: 3, now: () => nowMs, shared: null });

  assert.equal(local.claim("api:a", 5_000), true);
  assert.equal(local.claim("api:a", 5_000), false);
  assert.equal(local.claim("api:b", 5_000), true);
  assert.equal(local.claim("api:c", 5_000), true);
  assert.equal(local.claim("api:d", 5_000), true);
  assert.deepEqual(
    { entries: local.describe().entries, evictions: local.describe().evictions, replays: local.describe().replays },
    { entries: 3, evictions: 1, replays: 1 }
  );
  // The evicted oldest entry is the one whose replay window reopens.
  assert.equal(local.claim("api:a", 5_000), true);

  nowMs = 6_000;
  assert.equal(local.claim("api:b", 9_000), true, "an expired entry is forgotten");
  assert.throws(() => local.claim("", 1), TypeError);

  // A shared store with SET NX semantics: a sibling process's claim counts.
  const keys = new Map();
  const store = {
    client: () => ({
      set: async (key, value, px, ttl, nx) => {
        assert.equal(px, "PX");
        assert.equal(nx, "NX");
        assert.ok(ttl >= 1);

        if (keys.has(key)) {
          return null;
        }

        keys.set(key, value);
        return "OK";
      },
    }),
    key: (key) => `test:${key}`,
    ready: async () => {},
  };
  const replicaA = createServiceTokenReplayCache({ shared: store });
  const replicaB = createServiceTokenReplayCache({ shared: store });

  assert.equal(await replicaA.claim("api:x", Date.now() + 60_000), true);
  assert.equal(await replicaB.claim("api:x", Date.now() + 60_000), false);
  assert.equal(replicaA.claim("api:x", Date.now() + 60_000), false, "a local hit needs no round trip");
  assert.equal(replicaB.describe().sharedReplays, 1);

  // Redis failing never refuses a request: the local verdict stands.
  const broken = createServiceTokenReplayCache({
    shared: { client: () => ({ set: async () => { throw new Error("down"); } }), key: (key) => key, ready: async () => {} },
  });

  assert.equal(await broken.claim("api:y", Date.now() + 60_000), true);
  assert.equal(broken.claim("api:y", Date.now() + 60_000), false);
  assert.equal(broken.describe().sharedFallbacks, 1);

  // The process-wide cache is bounded by INTERNAL_SERVICE_REPLAY_CACHE_MAX_ENTRIES.
  resetServiceTokenReplayCache();
  assert.equal(describeServiceTokenReplayCache(), null);
  assert.equal(getServiceReplayCacheMaxEntries({ INTERNAL_SERVICE_REPLAY_CACHE_MAX_ENTRIES: "42" }), 42);
  assert.equal(getServiceReplayCacheMaxEntries({ INTERNAL_SERVICE_REPLAY_CACHE_MAX_ENTRIES: "zero" }), 100_000);
  assert.equal(getServiceTokenReplayCache({ INTERNAL_SERVICE_REPLAY_CACHE_MAX_ENTRIES: "7" }).describe().maxEntries, 7);
  resetServiceTokenReplayCache();
});

test("the middleware waits for a shared claim and refuses a replay it reports", async (t) => {
  const keys = new Set();
  const replayCache = createServiceTokenReplayCache({
    shared: {
      client: () => ({
        set: async (key) => {
          await new Promise((resolve) => setImmediate(resolve));
          return keys.has(key) ? null : (keys.add(key), "OK");
        },
      }),
      key: (key) => key,
      ready: async () => {},
    },
  });
  const tier = await startReceiver(t, { env: edEnv("agent"), replayCache });
  const token = signServiceToken({
    accessScope: ALICE,
    audience: "agent",
    env: edEnv("api"),
    issuer: "api",
    request: { method: "GET", target: "/probe" },
  });

  assert.equal((await send(`${tier.url}/probe`, { token })).status, 200);

  // A sibling replica with its own (empty) local cache, sharing the store.
  const viaSibling = express();
  const siblingCache = createServiceTokenReplayCache({
    shared: { client: () => ({ set: async (key) => (keys.has(key) ? null : "OK") }), key: (key) => key, ready: async () => {} },
  });

  viaSibling.use(requireServiceIdentity({ audience: "agent", env: edEnv("agent"), replayCache: siblingCache }));
  viaSibling.use((req, res) => res.json({ ok: true }));

  const server = await listen(viaSibling);

  t.after(() => new Promise((resolve) => server.close(resolve)));

  const replay = await send(`http://127.0.0.1:${server.address().port}/probe`, { token });

  assert.equal(replay.status, 401);
  assert.equal(replay.json.code, SERVICE_IDENTITY_ERROR_CODES.replayed);
  assert.equal(siblingCache.describe().sharedReplays, 1);
});

test("the body check's error handler drops the raw body and passes other errors on", () => {
  const error = new ServiceIdentityError("Invalid internal service token.", {
    code: SERVICE_IDENTITY_ERROR_CODES.bodyMismatch,
    status: 401,
  });
  const answered = {};
  const res = {
    headersSent: false,
    json(body) {
      answered.body = body;
      return res;
    },
    status(code) {
      answered.status = code;
      return res;
    },
  };

  error.body = '{"question":"secret question"}';
  handleServiceRequestBodyError(error, {}, res, () => assert.fail("must answer"));
  assert.deepEqual(answered, { body: { code: SERVICE_IDENTITY_ERROR_CODES.bodyMismatch, error: "Unauthorized." }, status: 401 });
  assert.equal(error.body, undefined);

  const other = new Error("parse");
  let passed = null;

  handleServiceRequestBodyError(other, {}, res, (value) => {
    passed = value;
  });
  assert.equal(passed, other);

  // An unbound request is not the hook's business; a bound one is checked.
  assert.doesNotThrow(() => verifyServiceRequestBody({}, {}, Buffer.from("anything")));
});

// The default shared store over a real Redis (RAG_SHARED_STATE=redis): two
// replicas, each with its own process cache, share one replay verdict. Runs
// only when REDIS_TEST_URL points at a Redis it may write to under a throwaway
// key prefix; otherwise it is reported as skipped, never passed.
const redisTestUrl = String(process.env.REDIS_TEST_URL ?? "").trim();

test(
  "sibling replicas share the replay cache through Redis",
  { skip: redisTestUrl ? false : "REDIS_TEST_URL is not set; point it at a disposable Redis to run it" },
  async (t) => {
    const { getSharedRedisClient, resetSharedState } = await import("../rag/shared-state.js");
    const prefix = `archive-rag-test:${crypto.randomUUID()}:`;
    const saved = Object.fromEntries(
      ["RAG_SHARED_STATE", "RAG_SHARED_STATE_PREFIX", "REDIS_URL"].map((name) => [name, process.env[name]])
    );

    Object.assign(process.env, { RAG_SHARED_STATE: "redis", RAG_SHARED_STATE_PREFIX: prefix, REDIS_URL: redisTestUrl });
    t.after(async () => {
      const redis = getSharedRedisClient();
      const keys = await redis.keys(`${prefix}*`);

      if (keys.length > 0) {
        await redis.del(keys);
      }

      await resetSharedState();

      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });

    const replicaCaches = [createServiceTokenReplayCache(), createServiceTokenReplayCache()];
    const replicas = [];

    for (const replayCache of replicaCaches) {
      replicas.push(await startReceiver(t, { env: edEnv("agent"), replayCache }));
    }

    const token = signServiceToken({
      accessScope: ALICE,
      audience: "agent",
      env: edEnv("api"),
      issuer: "api",
      request: { method: "GET", target: "/probe" },
    });

    assert.equal((await send(`${replicas[0].url}/probe`, { token })).status, 200);

    const replay = await send(`${replicas[1].url}/probe`, { token });

    assert.equal(replay.status, 401);
    assert.equal(replay.json.code, SERVICE_IDENTITY_ERROR_CODES.replayed);
    assert.equal(replicaCaches[1].describe().sharedReplays, 1);
    assert.equal(replicaCaches[0].describe().sharedFallbacks + replicaCaches[1].describe().sharedFallbacks, 0);

    // One key, under the prefix, that expires with the token.
    const keys = await getSharedRedisClient().keys(`${prefix}*`);

    assert.equal(keys.length, 1);
    assert.match(keys[0], /service-token:/u);

    const ttlMs = await getSharedRedisClient().pttl(keys[0]);

    assert.ok(ttlMs > 0 && ttlMs <= 65_000 + 5_000, String(ttlMs));
    assert.equal(replicas[1].seen.length, 0);
  }
);
