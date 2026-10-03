// In-memory holder for the OIDC session. The access token and ID token never
// touch storage; a refresh token, when the provider issues one, is kept in
// sessionStorage only (never localStorage) so a reload in the same tab can
// restore the session. No function here logs a token.

const REFRESH_TOKEN_STORAGE_KEY = "archive-rag.oidc.refresh";

let accessToken = "";
let accessTokenExpiresAt = 0;
let idToken = "";
let refreshHandler = null;
let reauthHandler = null;
let inFlightRefresh = null;
const listeners = new Set();

const getSessionStorage = () => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const notify = () => {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A broken listener must not break token bookkeeping.
    }
  });
};

export const getAccessToken = () => accessToken;

export const getAccessTokenExpiresAt = () => accessTokenExpiresAt;

export const getIdToken = () => idToken;

export const hasOidcAccessToken = () => Boolean(accessToken);

export const getStoredRefreshToken = () =>
  getSessionStorage()?.getItem(REFRESH_TOKEN_STORAGE_KEY) ?? "";

export const setOidcTokens = (tokens = {}, now = Date.now()) => {
  accessToken = String(tokens.access_token ?? "");
  const expiresIn = Number(tokens.expires_in);
  accessTokenExpiresAt =
    accessToken && Number.isFinite(expiresIn) && expiresIn > 0
      ? now + expiresIn * 1000
      : 0;

  if (tokens.id_token) {
    idToken = String(tokens.id_token);
  }

  const storage = getSessionStorage();

  if (tokens.refresh_token) {
    storage?.setItem(REFRESH_TOKEN_STORAGE_KEY, String(tokens.refresh_token));
  }

  notify();
};

export const clearOidcTokens = () => {
  accessToken = "";
  accessTokenExpiresAt = 0;
  idToken = "";
  inFlightRefresh = null;
  getSessionStorage()?.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  notify();
};

export const subscribeToTokens = (listener) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};

// The auth provider registers how to refresh (it knows the token endpoint)
// and what to do when the session cannot be recovered (start a new login).
export const setTokenHandlers = ({ onRefresh = null, onReauthRequired = null } = {}) => {
  refreshHandler = onRefresh;
  reauthHandler = onReauthRequired;

  return () => {
    if (refreshHandler === onRefresh) refreshHandler = null;
    if (reauthHandler === onReauthRequired) reauthHandler = null;
  };
};

export const refreshAccessToken = async () => {
  if (!refreshHandler) {
    return false;
  }

  if (!inFlightRefresh) {
    inFlightRefresh = Promise.resolve()
      .then(() => refreshHandler())
      .then((refreshed) => refreshed === true)
      .catch(() => false)
      .finally(() => {
        inFlightRefresh = null;
      });
  }

  return inFlightRefresh;
};

/**
 * Called by the API client after a 401 on a request that carried an OIDC
 * bearer token. Returns true when a refresh produced a new access token and
 * the caller may retry once; otherwise drops the session and asks for a new
 * login.
 */
export const handleUnauthorizedResponse = async () => {
  if (!accessToken && !refreshHandler) {
    return false;
  }

  if (await refreshAccessToken()) {
    return true;
  }

  accessToken = "";
  accessTokenExpiresAt = 0;
  notify();
  reauthHandler?.();

  return false;
};

export const OIDC_REFRESH_TOKEN_STORAGE_KEY = REFRESH_TOKEN_STORAGE_KEY;

// Test helper: reset module state between tests.
export const resetTokenStoreForTests = () => {
  accessToken = "";
  accessTokenExpiresAt = 0;
  idToken = "";
  refreshHandler = null;
  reauthHandler = null;
  inFlightRefresh = null;
  listeners.clear();
  getSessionStorage()?.removeItem(REFRESH_TOKEN_STORAGE_KEY);
};
