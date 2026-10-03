// OIDC Authorization Code + PKCE (RFC 7636, S256) for a public browser client.
// Protocol helpers only: no React, no global state. Nothing here logs a token,
// a code, a verifier or a claim.

const PENDING_LOGIN_STORAGE_KEY = "archive-rag.oidc.pending";
const PENDING_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_SCOPES = "openid profile email";

export class OidcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OidcError";
    this.code = code;
  }
}

const getCrypto = (cryptoImpl) => {
  const resolved = cryptoImpl ?? globalThis.crypto;

  if (!resolved?.getRandomValues || !resolved?.subtle?.digest) {
    throw new OidcError(
      "oidc_crypto_unavailable",
      "Web Crypto is required for sign-in (use HTTPS or localhost)."
    );
  }

  return resolved;
};

export const base64UrlEncode = (input) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64UrlDecodeToString = (value) => {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return new TextDecoder().decode(bytes);
};

export const randomUrlSafeString = (byteLength = 32, cryptoImpl) => {
  if (!Number.isInteger(byteLength) || byteLength < 32) {
    throw new OidcError("oidc_random_too_short", "At least 32 random bytes are required.");
  }

  const bytes = new Uint8Array(byteLength);
  getCrypto(cryptoImpl).getRandomValues(bytes);

  return base64UrlEncode(bytes);
};

export const computeS256Challenge = async (verifier, cryptoImpl) => {
  const digest = await getCrypto(cryptoImpl).subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );

  return base64UrlEncode(new Uint8Array(digest));
};

export const createPkcePair = async ({ byteLength = 32, crypto: cryptoImpl } = {}) => {
  const verifier = randomUrlSafeString(byteLength, cryptoImpl);
  const challenge = await computeS256Challenge(verifier, cryptoImpl);

  return { challenge, method: "S256", verifier };
};

const trimTrailingSlash = (value) => String(value ?? "").replace(/\/+$/, "");

export const discoverOidc = async (issuer, { fetchImpl = globalThis.fetch } = {}) => {
  const normalizedIssuer = trimTrailingSlash(issuer);

  if (!normalizedIssuer) {
    throw new OidcError("oidc_issuer_missing", "OIDC issuer is not configured.");
  }

  const response = await fetchImpl(
    `${normalizedIssuer}/.well-known/openid-configuration`,
    { headers: { Accept: "application/json" } }
  );

  if (!response.ok) {
    throw new OidcError(
      "oidc_discovery_failed",
      `OIDC discovery failed with status ${response.status}.`
    );
  }

  const document = await response.json();

  if (trimTrailingSlash(document?.issuer) !== normalizedIssuer) {
    throw new OidcError("oidc_issuer_mismatch", "OIDC discovery issuer does not match.");
  }

  if (!document.authorization_endpoint || !document.token_endpoint) {
    throw new OidcError(
      "oidc_discovery_incomplete",
      "OIDC discovery document lacks authorization or token endpoint."
    );
  }

  return {
    authorizationEndpoint: document.authorization_endpoint,
    endSessionEndpoint: document.end_session_endpoint ?? "",
    issuer: document.issuer,
    tokenEndpoint: document.token_endpoint,
  };
};

export const normalizeScopes = (scopes) => {
  const list = Array.isArray(scopes)
    ? scopes
    : String(scopes || DEFAULT_SCOPES).split(/[\s,]+/);
  const unique = [...new Set(list.map((scope) => String(scope).trim()).filter(Boolean))];

  if (!unique.includes("openid")) {
    unique.unshift("openid");
  }

  return unique.join(" ");
};

export const buildAuthorizationRequest = async ({
  audience = "",
  clientId,
  crypto: cryptoImpl,
  discovery,
  now = Date.now(),
  redirectUri,
  returnTo = "",
  scopes,
}) => {
  if (!clientId) {
    throw new OidcError("oidc_client_missing", "OIDC client id is not configured.");
  }

  const pkce = await createPkcePair({ crypto: cryptoImpl });
  const state = randomUrlSafeString(32, cryptoImpl);
  const nonce = randomUrlSafeString(32, cryptoImpl);
  const url = new URL(discovery.authorizationEndpoint);
  const params = {
    client_id: clientId,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
    nonce,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: normalizeScopes(scopes),
    state,
  };

  if (audience) {
    params.audience = audience;
  }

  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  return {
    pending: {
      codeVerifier: pkce.verifier,
      createdAt: now,
      nonce,
      redirectUri,
      returnTo,
      state,
    },
    url: url.toString(),
  };
};

const getSessionStorage = (storage) => {
  if (storage) {
    return storage;
  }

  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

export const savePendingLogin = (pending, storage) => {
  getSessionStorage(storage)?.setItem(PENDING_LOGIN_STORAGE_KEY, JSON.stringify(pending));
};

// Read once: the pending login is removed whether or not it is valid, so a
// replayed callback URL can never reuse a verifier.
export const takePendingLogin = (storage, now = Date.now()) => {
  const resolved = getSessionStorage(storage);
  const raw = resolved?.getItem(PENDING_LOGIN_STORAGE_KEY);

  resolved?.removeItem(PENDING_LOGIN_STORAGE_KEY);

  if (!raw) {
    return null;
  }

  try {
    const pending = JSON.parse(raw);

    if (!pending?.state || !pending?.codeVerifier || !pending?.nonce) {
      return null;
    }

    if (now - Number(pending.createdAt ?? 0) > PENDING_LOGIN_MAX_AGE_MS) {
      return null;
    }

    return pending;
  } catch {
    return null;
  }
};

export const hasPendingLogin = (storage) =>
  Boolean(getSessionStorage(storage)?.getItem(PENDING_LOGIN_STORAGE_KEY));

export const parseCallbackParams = (href) => {
  const url = new URL(href);
  const params = url.searchParams;

  return {
    code: params.get("code") ?? "",
    error: params.get("error") ?? "",
    state: params.get("state") ?? "",
  };
};

export const isCallbackUrl = (href) => {
  try {
    const { code, error, state } = parseCallbackParams(href);

    return Boolean(state && (code || error));
  } catch {
    return false;
  }
};

export const stripCallbackParams = (href) => {
  const url = new URL(href);

  ["code", "state", "session_state", "iss", "error", "error_description"].forEach((key) =>
    url.searchParams.delete(key)
  );

  return url.toString();
};

export const decodeJwtPayload = (token) => {
  const parts = String(token ?? "").split(".");

  if (parts.length < 2) {
    throw new OidcError("oidc_id_token_malformed", "ID token is malformed.");
  }

  try {
    return JSON.parse(base64UrlDecodeToString(parts[1]));
  } catch {
    throw new OidcError("oidc_id_token_malformed", "ID token is malformed.");
  }
};

// The browser cannot keep a secret, so it does not verify the ID token
// signature; the API validates every access token it receives. These checks
// bind the ID token to this login attempt (nonce) and this client.
export const validateIdTokenClaims = (
  idToken,
  { clientId, issuer, nonce, now = Date.now(), clockSkewSeconds = 120 }
) => {
  const claims = decodeJwtPayload(idToken);

  if (!nonce || claims.nonce !== nonce) {
    throw new OidcError("oidc_nonce_mismatch", "Sign-in failed: ID token nonce does not match.");
  }

  if (issuer && trimTrailingSlash(claims.iss) !== trimTrailingSlash(issuer)) {
    throw new OidcError("oidc_issuer_mismatch", "Sign-in failed: ID token issuer does not match.");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (clientId && !audiences.includes(clientId)) {
    throw new OidcError("oidc_audience_mismatch", "Sign-in failed: ID token audience does not match.");
  }

  if (Number.isFinite(claims.exp) && claims.exp + clockSkewSeconds < now / 1000) {
    throw new OidcError("oidc_id_token_expired", "Sign-in failed: ID token has expired.");
  }

  return claims;
};

const postTokenRequest = async (tokenEndpoint, form, fetchImpl) => {
  const response = await fetchImpl(tokenEndpoint, {
    body: new URLSearchParams(form).toString(),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.access_token) {
    // Only the OAuth error code is surfaced; descriptions can echo input.
    const errorCode = typeof body?.error === "string" ? body.error : "";
    const error = new OidcError(
      "oidc_token_request_failed",
      `Token request failed with status ${response.status}${errorCode ? ` (${errorCode})` : ""}.`
    );
    error.status = response.status;
    error.oauthError = errorCode;
    throw error;
  }

  return body;
};

export const exchangeAuthorizationCode = ({
  clientId,
  code,
  codeVerifier,
  discovery,
  fetchImpl = globalThis.fetch,
  redirectUri,
}) =>
  postTokenRequest(
    discovery.tokenEndpoint,
    {
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    },
    fetchImpl
  );

export const refreshTokenGrant = ({
  clientId,
  discovery,
  fetchImpl = globalThis.fetch,
  refreshToken,
  scopes,
}) =>
  postTokenRequest(
    discovery.tokenEndpoint,
    {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...(scopes ? { scope: normalizeScopes(scopes) } : {}),
    },
    fetchImpl
  );

export const completeAuthorizationCallback = async ({
  clientId,
  discovery,
  fetchImpl = globalThis.fetch,
  href,
  now = Date.now(),
  pending,
}) => {
  const { code, error, state } = parseCallbackParams(href);

  if (!pending) {
    throw new OidcError("oidc_no_pending_login", "Sign-in failed: no sign-in is in progress.");
  }

  if (!state || state !== pending.state) {
    throw new OidcError("oidc_state_mismatch", "Sign-in failed: state does not match.");
  }

  if (error) {
    throw new OidcError("oidc_authorization_denied", `Sign-in was not completed (${error}).`);
  }

  if (!code) {
    throw new OidcError("oidc_code_missing", "Sign-in failed: no authorization code returned.");
  }

  const tokens = await exchangeAuthorizationCode({
    clientId,
    code,
    codeVerifier: pending.codeVerifier,
    discovery,
    fetchImpl,
    redirectUri: pending.redirectUri,
  });

  if (!tokens.id_token) {
    throw new OidcError("oidc_id_token_missing", "Sign-in failed: no ID token returned.");
  }

  const claims = validateIdTokenClaims(tokens.id_token, {
    clientId,
    issuer: discovery.issuer,
    nonce: pending.nonce,
    now,
  });

  return { claims, tokens };
};

export const buildEndSessionUrl = ({
  clientId,
  discovery,
  idTokenHint,
  postLogoutRedirectUri,
}) => {
  if (!discovery?.endSessionEndpoint) {
    return "";
  }

  const url = new URL(discovery.endSessionEndpoint);

  if (idTokenHint) {
    url.searchParams.set("id_token_hint", idTokenHint);
  }
  if (clientId) {
    url.searchParams.set("client_id", clientId);
  }
  if (postLogoutRedirectUri) {
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  }

  return url.toString();
};

export const OIDC_PENDING_LOGIN_STORAGE_KEY = PENDING_LOGIN_STORAGE_KEY;
