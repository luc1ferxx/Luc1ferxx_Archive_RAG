import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import express from "express";

import { requireApiAuth } from "../auth.js";
import { DEV_OIDC_DEMO_USERS, startDevOidcProvider } from "../dev-oidc-provider.mjs";
import { createOidcVerifier, resetDefaultOidcVerifier } from "../rag/oidc.js";

const REDIRECT_URI = "http://localhost:3000/auth/callback";

const createPkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { challenge, verifier };
};

const authorize = async (provider, overrides = {}) => {
  const pkce = createPkce();
  const params = new URLSearchParams({
    client_id: provider.clientId,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    login_hint: "alice",
    nonce: "nonce-1",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email",
    state: "state-1",
    ...overrides,
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      params.delete(key);
    }
  }

  const response = await fetch(`${provider.issuer}/authorize?${params}`, { redirect: "manual" });
  const location = response.headers.get("location");
  return {
    location: location ? new URL(location) : null,
    pkce,
    response,
  };
};

const exchange = (provider, fields) =>
  fetch(`${provider.issuer}/token`, {
    body: new URLSearchParams({ client_id: provider.clientId, ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

const exchangeCode = (provider, { code, verifier, redirectUri = REDIRECT_URI }) =>
  exchange(provider, {
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

const makeVerifier = (provider, overrides = {}) =>
  createOidcVerifier({
    audience: provider.audience,
    clientId: provider.clientId,
    issuer: provider.issuer,
    jwksMinRefreshMs: 0,
    requireTyp: true,
    revokedJtis: "",
    revokedTokenHashes: "",
    ...overrides,
  });

test("authorization code + PKCE issues tokens the OIDC verifier accepts", async () => {
  const provider = await startDevOidcProvider({ port: 0 });

  try {
    const discovery = await (await fetch(`${provider.issuer}/.well-known/openid-configuration`)).json();
    assert.equal(discovery.issuer, provider.issuer);
    assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
    assert.match(provider.issuer, /^http:\/\/127\.0\.0\.1:\d+$/u);

    const { location, pkce, response } = await authorize(provider);
    assert.equal(response.status, 302);
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
    assert.equal(location.searchParams.get("state"), "state-1");
    assert.equal(location.searchParams.get("iss"), provider.issuer);

    const tokenResponse = await exchangeCode(provider, {
      code: location.searchParams.get("code"),
      verifier: pkce.verifier,
    });
    assert.equal(tokenResponse.status, 200);
    assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
    const tokens = await tokenResponse.json();
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(tokens.id_token);
    assert.equal(tokens.refresh_token, undefined, "no refresh token without offline_access");

    const idClaims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url"));
    assert.equal(idClaims.aud, provider.clientId);
    assert.equal(idClaims.nonce, "nonce-1");

    const principal = await makeVerifier(provider).verify(tokens.access_token);
    assert.equal(principal.authProvider, "oidc");
    assert.equal(principal.userId, "alice");
    assert.deepEqual(principal.allowedWorkspaceIds, ["workspace-a", "workspace-b"]);
    assert.deepEqual(principal.workspaceRoles, {
      "workspace-a": ["workspace.admin"],
      "workspace-b": ["workspace.viewer"],
    });
  } finally {
    await provider.stop();
  }
});

test("PKCE: a wrong verifier, a reused code and a wrong redirect_uri are refused", async () => {
  const provider = await startDevOidcProvider({ port: 0 });

  try {
    // Wrong verifier burns the code: the right verifier afterwards fails too.
    let flow = await authorize(provider);
    let code = flow.location.searchParams.get("code");
    let response = await exchangeCode(provider, { code, verifier: createPkce().verifier });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_grant");
    response = await exchangeCode(provider, { code, verifier: flow.pkce.verifier });
    assert.equal(response.status, 400);

    // A code is single use.
    flow = await authorize(provider);
    code = flow.location.searchParams.get("code");
    response = await exchangeCode(provider, { code, verifier: flow.pkce.verifier });
    assert.equal(response.status, 200);
    response = await exchangeCode(provider, { code, verifier: flow.pkce.verifier });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_grant");

    // redirect_uri must match the authorization request exactly.
    flow = await authorize(provider);
    response = await exchangeCode(provider, {
      code: flow.location.searchParams.get("code"),
      redirectUri: "http://localhost:3000/other",
      verifier: flow.pkce.verifier,
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_grant");
    assert.equal(JSON.stringify(body).includes(flow.location.searchParams.get("code")), false);

    // PKCE is required, and only S256.
    flow = await authorize(provider, { code_challenge: undefined, code_challenge_method: undefined });
    assert.equal(flow.location.searchParams.get("error"), "invalid_request");
    flow = await authorize(provider, { code_challenge_method: "plain" });
    assert.equal(flow.location.searchParams.get("error"), "invalid_request");

    // A non-loopback redirect_uri is never redirected to.
    flow = await authorize(provider, { redirect_uri: "https://evil.example/cb" });
    assert.equal(flow.response.status, 400);
    assert.equal(flow.location, null);

    // An unknown client is refused at both endpoints.
    flow = await authorize(provider, { client_id: "other" });
    assert.equal(flow.response.status, 400);
    response = await exchange(provider, { client_id: "other", grant_type: "authorization_code" });
    assert.equal(response.status, 401);
  } finally {
    await provider.stop();
  }
});

test("refresh tokens rotate, and reusing a rotated one revokes the family", async () => {
  const provider = await startDevOidcProvider({ port: 0 });

  try {
    const flow = await authorize(provider, { scope: "openid offline_access" });
    const first = await (
      await exchangeCode(provider, { code: flow.location.searchParams.get("code"), verifier: flow.pkce.verifier })
    ).json();
    assert.ok(first.refresh_token);

    const second = await (
      await exchange(provider, { grant_type: "refresh_token", refresh_token: first.refresh_token })
    ).json();
    assert.ok(second.access_token);
    assert.ok(second.refresh_token);
    assert.notEqual(second.refresh_token, first.refresh_token);

    let response = await exchange(provider, { grant_type: "refresh_token", refresh_token: first.refresh_token });
    assert.equal(response.status, 400);
    response = await exchange(provider, { grant_type: "refresh_token", refresh_token: second.refresh_token });
    assert.equal(response.status, 400, "the whole family is revoked after a reuse");
  } finally {
    await provider.stop();
  }
});

test("the login form lists users when no login_hint is given, escaped", async () => {
  const provider = await startDevOidcProvider({
    port: 0,
    users: [{ claims: {}, name: "<script>x</script>", sub: "eve" }],
  });

  try {
    const { response } = await authorize(provider, { login_hint: undefined, state: "\"><b>" });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/u);
    assert.equal(html.includes("<script>x"), false);
    assert.equal(html.includes("\"><b>"), false);
  } finally {
    await provider.stop();
  }
});

test("key rotation: the verifier picks up the new kid and refuses the removed one", async () => {
  const provider = await startDevOidcProvider({ port: 0 });

  try {
    const verifier = makeVerifier(provider);
    const issue = async () => {
      const flow = await authorize(provider, { login_hint: "bob" });
      const tokens = await (
        await exchangeCode(provider, { code: flow.location.searchParams.get("code"), verifier: flow.pkce.verifier })
      ).json();
      return tokens.access_token;
    };

    const oldToken = await issue();
    assert.equal((await verifier.verify(oldToken)).userId, "bob");

    let response = await fetch(`${provider.issuer}/admin/rotate-keys`, {
      headers: { "x-dev-oidc-admin-secret": "wrong" },
      method: "POST",
    });
    assert.equal(response.status, 403);

    response = await fetch(`${provider.issuer}/admin/rotate-keys?drop_previous=1`, {
      headers: { "x-dev-oidc-admin-secret": provider.adminSecret },
      method: "POST",
    });
    assert.equal(response.status, 200);
    const { kids } = await response.json();
    assert.equal(kids.length, 1);

    const newToken = await issue();
    assert.equal((await verifier.verify(newToken)).userId, "bob", "the new kid is fetched on demand");
    await assert.rejects(verifier.verify(oldToken), /No matching signing key/);
  } finally {
    await provider.stop();
  }
});

test("refuses NODE_ENV=production and binds loopback only", async () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    await assert.rejects(startDevOidcProvider({ port: 0 }), /NODE_ENV=production/);
  } finally {
    if (saved === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = saved;
    }
  }

  assert.ok(DEV_OIDC_DEMO_USERS.length >= 2);
});

test("end to end: requireApiAuth accepts a dev IdP access token", async () => {
  const provider = await startDevOidcProvider({ port: 0 });
  const app = express();
  app.use(requireApiAuth);
  app.get("/whoami", (req, res) => res.json(req.accessScope));
  const server = await new Promise((resolve) => {
    const listening = http.createServer(app).listen(0, "127.0.0.1", () => resolve(listening));
  });
  const keys = [
    "API_AUTH_ENABLED",
    "API_AUTH_OIDC_ENABLED",
    "API_AUTH_OIDC_ISSUER",
    "API_AUTH_OIDC_AUDIENCE",
    "API_AUTH_OIDC_CLIENT_ID",
    "API_AUTH_OIDC_REQUIRE_TYP",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    Object.assign(process.env, {
      API_AUTH_ENABLED: "true",
      API_AUTH_OIDC_AUDIENCE: provider.audience,
      API_AUTH_OIDC_CLIENT_ID: provider.clientId,
      API_AUTH_OIDC_ENABLED: "true",
      API_AUTH_OIDC_ISSUER: provider.issuer,
      API_AUTH_OIDC_REQUIRE_TYP: "true",
    });
    resetDefaultOidcVerifier();

    const flow = await authorize(provider, { login_hint: "bob" });
    const tokens = await (
      await exchangeCode(provider, { code: flow.location.searchParams.get("code"), verifier: flow.pkce.verifier })
    ).json();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/whoami`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(response.status, 200);
    const scope = await response.json();
    assert.equal(scope.authProvider, "oidc");
    assert.equal(scope.userId, "bob");
    assert.equal(scope.workspaceId, "workspace-a");
    assert.deepEqual(scope.workspaceRoles, { "workspace-a": ["workspace.member"] });

    const idTokenResponse = await fetch(`http://127.0.0.1:${server.address().port}/whoami`, {
      headers: { authorization: `Bearer ${tokens.id_token}` },
    });
    assert.equal(idTokenResponse.status, 401, "an ID token is not an access token for the API");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }

    resetDefaultOidcVerifier();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await provider.stop();
  }
});
