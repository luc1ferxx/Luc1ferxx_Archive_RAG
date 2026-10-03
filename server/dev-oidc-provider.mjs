#!/usr/bin/env node
// A tiny OpenID Connect provider for local development and tests ONLY.
//
//   node dev-oidc-provider.mjs [--port 5556] [--users ./dev-oidc-users.json]
//
// It binds 127.0.0.1, refuses NODE_ENV=production, keeps everything in
// memory, and auto-approves every login (pick the user with login_hint or the
// HTML form). Endpoints: discovery, JWKS, /authorize (Authorization Code with
// PKCE S256 required), /token (authorization_code and refresh_token with
// rotation), and POST /admin/rotate-keys guarded by a per-start secret.
// Access tokens are RS256 JWTs with typ at+jwt, aud = the configured audience
// and azp = client_id, carrying the user's claims (workspace_id, workspaces,
// roles, groups, permissions, workspace_roles).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const CODE_TTL_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const DEV_OIDC_DEMO_USERS = Object.freeze([
  {
    sub: "alice",
    name: "Alice Admin",
    email: "alice@example.test",
    claims: {
      roles: ["admin.operator"],
      workspace_roles: { "workspace-a": ["workspace.admin"], "workspace-b": ["workspace.viewer"] },
      workspaces: ["workspace-a", "workspace-b"],
    },
  },
  {
    sub: "bob",
    name: "Bob Member",
    email: "bob@example.test",
    claims: {
      workspace_id: "workspace-a",
      workspace_roles: { "workspace-a": ["workspace.member"] },
      workspaces: ["workspace-a"],
    },
  },
  {
    sub: "carol",
    name: "Carol Viewer",
    email: "carol@example.test",
    claims: {
      groups: ["archive-viewers"],
      workspace_roles: { "workspace-b": ["workspace.viewer"] },
      workspaces: ["workspace-b"],
    },
  },
]);

const base64Url = (buffer) => Buffer.from(buffer).toString("base64url");
const randomToken = (bytes = 32) => base64Url(crypto.randomBytes(bytes));
const sha256Base64Url = (value) =>
  base64Url(crypto.createHash("sha256").update(value).digest());

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

const isLoopbackRedirectUri = (value) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (host === "localhost" || host === "127.0.0.1" || host === "[::1]") &&
      !url.hash
    );
  } catch {
    return false;
  }
};

const createSigningKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = randomToken(9);

  return {
    kid,
    privateKey,
    publicJwk: { ...publicKey.export({ format: "jwk" }), alg: "RS256", kid, use: "sig" },
  };
};

const signJwt = ({ key, payload, typ }) => {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: key.kid, typ }));
  const body = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    "sha256",
    Buffer.from(`${header}.${body}`),
    key.privateKey
  );

  return `${header}.${body}.${base64Url(signature)}`;
};

const normalizeUsers = (users) => {
  const list = Array.isArray(users) ? users : [];
  const normalized = list
    .filter((user) => user && typeof user.sub === "string" && user.sub.trim())
    .map((user) => ({
      claims: user.claims && typeof user.claims === "object" ? user.claims : {},
      email: typeof user.email === "string" ? user.email : "",
      name: typeof user.name === "string" ? user.name : user.sub,
      sub: user.sub.trim(),
      username: typeof user.username === "string" ? user.username : user.sub.trim(),
    }));

  if (normalized.length === 0) {
    throw new Error("The dev OIDC provider needs at least one user with a sub.");
  }

  return normalized;
};

export const loadDevOidcUsersFile = (filePath) =>
  normalizeUsers(JSON.parse(readFileSync(filePath, "utf8")));

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large."), { status: 413 }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const parseForm = (req, body) => {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();

  if (contentType.startsWith("application/json")) {
    const parsed = JSON.parse(body || "{}");
    return new URLSearchParams(
      Object.entries(parsed).filter(([, value]) => typeof value === "string")
    );
  }

  return new URLSearchParams(body);
};

const corsHeaders = {
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
};

const sendJson = (res, status, body, extraHeaders = {}) => {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    pragma: "no-cache",
    ...corsHeaders,
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
};

const sendHtml = (res, status, html) => {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    "content-type": "text/html; charset=utf-8",
  });
  res.end(html);
};

const tokenError = (res, error, description, status = 400) =>
  sendJson(res, status, { error, error_description: description });

/**
 * Starts the dev IdP. Resolves to { issuer, port, adminSecret, clientId,
 * audience, users, rotateKeys(), stop() }. port 0 picks a free port.
 */
export const startDevOidcProvider = async ({
  accessTokenTtlSec = 600,
  audience = "archive-rag-api",
  clientId = "archive-rag-spa",
  idTokenTtlSec = 600,
  port = 0,
  redirectUris = [],
  refreshTokenTtlSec = 8 * 60 * 60,
  users = DEV_OIDC_DEMO_USERS,
  now = () => Date.now(),
} = {}) => {
  if (String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    throw new Error("The dev OIDC provider refuses to start with NODE_ENV=production.");
  }

  const userList = normalizeUsers(users);
  const registeredRedirectUris = new Set(redirectUris);
  const adminSecret = randomToken(32);
  const keys = [createSigningKey()];
  const codes = new Map();
  const refreshTokens = new Map();
  const revokedRefreshFamilies = new Set();
  let issuer = "";

  const findUser = (hint) => {
    const value = String(hint ?? "").trim();
    return value
      ? userList.find((user) => user.sub === value || user.username === value) ?? null
      : null;
  };

  const isAllowedRedirectUri = (value) =>
    registeredRedirectUris.has(value) ||
    (registeredRedirectUris.size === 0 && isLoopbackRedirectUri(value));

  const rotateKeys = ({ dropPrevious = false } = {}) => {
    const key = createSigningKey();
    keys.unshift(key);

    if (dropPrevious) {
      keys.splice(1);
    } else {
      keys.splice(2);
    }

    return key.kid;
  };

  const issueTokens = ({ family, nonce, scope, user }) => {
    const nowSeconds = Math.floor(now() / 1000);
    const signingKey = keys[0];
    const accessToken = signJwt({
      key: signingKey,
      payload: {
        ...user.claims,
        aud: audience,
        azp: clientId,
        client_id: clientId,
        exp: nowSeconds + accessTokenTtlSec,
        iat: nowSeconds,
        iss: issuer,
        jti: randomToken(12),
        nbf: nowSeconds,
        scope,
        sub: user.sub,
      },
      typ: "at+jwt",
    });
    const scopes = scope.split(/\s+/u);
    const response = {
      access_token: accessToken,
      expires_in: accessTokenTtlSec,
      scope,
      token_type: "Bearer",
    };

    if (scopes.includes("openid")) {
      response.id_token = signJwt({
        key: signingKey,
        payload: {
          aud: clientId,
          azp: clientId,
          ...(scopes.includes("email") && user.email ? { email: user.email } : {}),
          exp: nowSeconds + idTokenTtlSec,
          iat: nowSeconds,
          iss: issuer,
          ...(scopes.includes("profile") ? { name: user.name, preferred_username: user.username } : {}),
          ...(nonce ? { nonce } : {}),
          sub: user.sub,
        },
        typ: "JWT",
      });
    }

    if (scopes.includes("offline_access")) {
      const refreshToken = randomToken(32);
      refreshTokens.set(refreshToken, {
        expiresAt: now() + refreshTokenTtlSec * 1000,
        family: family ?? randomToken(12),
        scope,
        used: false,
        userSub: user.sub,
      });
      response.refresh_token = refreshToken;
    }

    return response;
  };

  const renderLoginForm = (params) => {
    const hidden = [...params.entries()]
      .filter(([name]) => name !== "login_hint")
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
      )
      .join("");
    const options = userList
      .map(
        (user) =>
          `<option value="${escapeHtml(user.sub)}">${escapeHtml(user.name)} (${escapeHtml(user.sub)})</option>`
      )
      .join("");

    return `<!doctype html><html><head><meta charset="utf-8"><title>Dev OIDC login</title></head>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto">
<h1>Dev OIDC login</h1><p>Development only. Pick a user; no password is checked.</p>
<form method="get" action="/authorize">${hidden}
<label>User <select name="login_hint">${options}</select></label>
<button type="submit">Sign in</button></form></body></html>`;
  };

  const handleAuthorize = (req, res, url) => {
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri") ?? "";

    if (params.get("client_id") !== clientId) {
      sendHtml(res, 400, "<p>Unknown client_id.</p>");
      return;
    }

    if (!isAllowedRedirectUri(redirectUri)) {
      sendHtml(res, 400, "<p>redirect_uri is not registered.</p>");
      return;
    }

    const redirectWith = (values) => {
      const target = new URL(redirectUri);

      for (const [name, value] of Object.entries(values)) {
        if (value) {
          target.searchParams.set(name, value);
        }
      }

      target.searchParams.set("iss", issuer);

      if (params.get("state")) {
        target.searchParams.set("state", params.get("state"));
      }

      res.writeHead(302, { "cache-control": "no-store", location: target.toString() });
      res.end();
    };

    if (params.get("response_type") !== "code") {
      redirectWith({ error: "unsupported_response_type" });
      return;
    }

    if (
      params.get("code_challenge_method") !== "S256" ||
      !PKCE_CHALLENGE_PATTERN.test(params.get("code_challenge") ?? "")
    ) {
      redirectWith({
        error: "invalid_request",
        error_description: "PKCE with code_challenge_method=S256 is required.",
      });
      return;
    }

    const user = findUser(params.get("login_hint"));

    if (!user) {
      sendHtml(res, 200, renderLoginForm(params));
      return;
    }

    const code = randomToken(32);
    codes.set(code, {
      clientId,
      codeChallenge: params.get("code_challenge"),
      expiresAt: now() + CODE_TTL_MS,
      nonce: params.get("nonce") ?? "",
      redirectUri,
      scope: (params.get("scope") ?? "openid").trim() || "openid",
      userSub: user.sub,
    });
    redirectWith({ code });
  };

  const handleToken = async (req, res) => {
    let params = null;

    try {
      params = parseForm(req, await readBody(req));
    } catch (error) {
      tokenError(res, "invalid_request", "Malformed request body.", error?.status ?? 400);
      return;
    }

    if (params.get("client_id") !== clientId) {
      tokenError(res, "invalid_client", "Unknown client_id.", 401);
      return;
    }

    const grantType = params.get("grant_type");

    if (grantType === "authorization_code") {
      const code = params.get("code") ?? "";
      const entry = codes.get(code);
      // Single use: the code is gone after the first attempt, right or wrong.
      codes.delete(code);

      if (!entry || entry.expiresAt <= now()) {
        tokenError(res, "invalid_grant", "Authorization code is invalid or expired.");
        return;
      }

      if (entry.redirectUri !== params.get("redirect_uri")) {
        tokenError(res, "invalid_grant", "redirect_uri does not match the authorization request.");
        return;
      }

      const verifier = params.get("code_verifier") ?? "";

      if (
        !PKCE_VERIFIER_PATTERN.test(verifier) ||
        sha256Base64Url(verifier) !== entry.codeChallenge
      ) {
        tokenError(res, "invalid_grant", "PKCE code_verifier does not match.");
        return;
      }

      const user = findUser(entry.userSub);

      if (!user) {
        tokenError(res, "invalid_grant", "User no longer exists.");
        return;
      }

      sendJson(res, 200, issueTokens({ nonce: entry.nonce, scope: entry.scope, user }));
      return;
    }

    if (grantType === "refresh_token") {
      const presented = params.get("refresh_token") ?? "";
      const entry = refreshTokens.get(presented);

      if (!entry || revokedRefreshFamilies.has(entry.family) || entry.expiresAt <= now()) {
        tokenError(res, "invalid_grant", "Refresh token is invalid or expired.");
        return;
      }

      if (entry.used) {
        // Reuse of a rotated refresh token: revoke the whole family.
        revokedRefreshFamilies.add(entry.family);
        tokenError(res, "invalid_grant", "Refresh token was already used.");
        return;
      }

      entry.used = true;
      const user = findUser(entry.userSub);

      if (!user) {
        tokenError(res, "invalid_grant", "User no longer exists.");
        return;
      }

      sendJson(res, 200, issueTokens({ family: entry.family, scope: entry.scope, user }));
      return;
    }

    tokenError(res, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  };

  const handleRotate = async (req, res, url) => {
    const presented = String(req.headers["x-dev-oidc-admin-secret"] ?? "");
    const expected = Buffer.from(adminSecret);
    const actual = Buffer.from(presented);

    await readBody(req).catch(() => "");

    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }

    const dropPrevious = ["1", "true"].includes(url.searchParams.get("drop_previous") ?? "");
    const kid = rotateKeys({ dropPrevious });
    sendJson(res, 200, { kid, kids: keys.map((key) => key.kid) });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer || `http://${LOOPBACK_HOST}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      sendJson(res, 200, {
        authorization_endpoint: `${issuer}/authorize`,
        claims_supported: ["sub", "name", "email", "workspace_id", "workspaces", "roles", "groups", "permissions", "workspace_roles"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        scopes_supported: ["openid", "profile", "email", "offline_access"],
        subject_types_supported: ["public"],
        token_endpoint: `${issuer}/token`,
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      sendJson(res, 200, { keys: keys.map((key) => key.publicJwk) }, {
        "cache-control": "public, max-age=60",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      handleAuthorize(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      handleToken(req, res).catch(() => {
        if (!res.headersSent) {
          tokenError(res, "server_error", "Token request failed.", 500);
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/rotate-keys") {
      handleRotate(req, res, url).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: "server_error" });
        }
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const boundPort = server.address().port;
  issuer = `http://${LOOPBACK_HOST}:${boundPort}`;

  return {
    adminSecret,
    audience,
    clientId,
    issuer,
    port: boundPort,
    rotateKeys,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    users: userList.map((user) => user.sub),
  };
};

const readFlag = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const isMainModule = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const usersFile = readFlag(argv, "--users") ?? process.env.DEV_OIDC_USERS_FILE;
  const redirectUris = String(process.env.DEV_OIDC_REDIRECT_URIS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  startDevOidcProvider({
    accessTokenTtlSec: Number(process.env.DEV_OIDC_ACCESS_TOKEN_TTL_SEC) || 600,
    audience: process.env.DEV_OIDC_AUDIENCE || "archive-rag-api",
    clientId: process.env.DEV_OIDC_CLIENT_ID || "archive-rag-spa",
    port: Number(readFlag(argv, "--port") ?? process.env.DEV_OIDC_PORT ?? 5556),
    redirectUris,
    users: usersFile ? loadDevOidcUsersFile(usersFile) : DEV_OIDC_DEMO_USERS,
  })
    .then((provider) => {
      console.log(`[dev-oidc] DEVELOPMENT ONLY identity provider at ${provider.issuer}`);
      console.log(`[dev-oidc] client_id=${provider.clientId} audience=${provider.audience} users=${provider.users.join(",")}`);
      console.log(`[dev-oidc] rotate keys: POST ${provider.issuer}/admin/rotate-keys with header x-dev-oidc-admin-secret: ${provider.adminSecret}`);
      console.log(
        `[dev-oidc] API: API_AUTH_ENABLED=true API_AUTH_OIDC_ENABLED=true API_AUTH_OIDC_ISSUER=${provider.issuer} API_AUTH_OIDC_AUDIENCE=${provider.audience} API_AUTH_OIDC_CLIENT_ID=${provider.clientId}`
      );
    })
    .catch((error) => {
      console.error(`[dev-oidc] ${error instanceof Error ? error.message : "failed to start"}`);
      process.exitCode = 1;
    });
}
