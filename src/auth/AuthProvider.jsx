import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import axios from "axios";
import { apiGet } from "../apiClient";
import { API_DOMAIN } from "../config";
import { resolveOidcSettings } from "./authSettings";
import {
  buildAuthorizationRequest,
  buildEndSessionUrl,
  completeAuthorizationCallback,
  discoverOidc,
  isCallbackUrl,
  refreshTokenGrant,
  savePendingLogin,
  stripCallbackParams,
  takePendingLogin,
} from "./oidc";
import { decideCapability } from "./permissions";
import {
  clearOidcTokens,
  getAccessTokenExpiresAt,
  getIdToken,
  getStoredRefreshToken,
  hasOidcAccessToken,
  refreshAccessToken,
  setOidcTokens,
  setTokenHandlers,
} from "./tokenStore";

// Refresh this long before the access token expires.
export const REFRESH_LEAD_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5_000;
// An automatic re-login (after a 401 the session could not recover from) is
// attempted at most once per window, so a misconfigured API cannot bounce
// the browser between the app and the identity provider forever.
const AUTO_LOGIN_WINDOW_MS = 60_000;
const AUTO_LOGIN_STORAGE_KEY = "archive-rag.oidc.auto-login-at";

const DISABLED_AUTH = Object.freeze({
  can: () => true,
  error: "",
  me: null,
  oidcEnabled: false,
  signIn: () => undefined,
  signOut: () => undefined,
  status: "disabled",
});

export const AuthContext = createContext(DISABLED_AUTH);

export const useAuth = () => useContext(AuthContext);

const safeMessage = (error, fallback) =>
  typeof error?.message === "string" && error.message ? error.message : fallback;

const readSessionValue = (key) => {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? "";
  } catch {
    return "";
  }
};

const writeSessionValue = (key, value) => {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Storage may be blocked; the guard then simply does not apply.
  }
};

// Public endpoint, no credentials; a short timeout so an unreachable API does
// not hold the first render (the app renders once auth is settled).
const AUTH_CONFIG_TIMEOUT_MS = 5_000;
const defaultLoadServerConfig = async () =>
  (await axios.get(`${API_DOMAIN}/auth/config`, { timeout: AUTH_CONFIG_TIMEOUT_MS })).data;
const defaultLoadMe = () => apiGet("/auth/me");
const defaultReplaceUrl = (url) => window.history.replaceState(null, "", url);
const defaultNow = () => Date.now();
const defaultFetch = (...args) => globalThis.fetch(...args);

export const AuthProvider = ({
  children,
  cryptoImpl,
  env = import.meta.env,
  fetchImpl = defaultFetch,
  loadMe = defaultLoadMe,
  loadServerConfig = defaultLoadServerConfig,
  location = typeof window !== "undefined" ? window.location : undefined,
  now = defaultNow,
  replaceUrl = defaultReplaceUrl,
}) => {
  const [state, setState] = useState({
    error: "",
    me: null,
    oidcEnabled: false,
    status: "loading",
  });
  const settingsRef = useRef(null);
  const discoveryRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const startedRef = useRef(false);
  const fetcher = fetchImpl;

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    clearRefreshTimer();
    const expiresAt = getAccessTokenExpiresAt();

    if (!expiresAt || !getStoredRefreshToken()) {
      return;
    }

    const delay = Math.max(MIN_REFRESH_DELAY_MS, expiresAt - now() - REFRESH_LEAD_MS);

    refreshTimerRef.current = setTimeout(() => {
      void refreshAccessToken();
    }, delay);
  }, [clearRefreshTimer, now]);

  const refreshWithStoredToken = useCallback(async () => {
    const refreshToken = getStoredRefreshToken();
    const settings = settingsRef.current;
    const discovery = discoveryRef.current;

    if (!refreshToken || !settings || !discovery) {
      return false;
    }

    try {
      const tokens = await refreshTokenGrant({
        clientId: settings.clientId,
        discovery,
        fetchImpl: fetcher,
        refreshToken,
      });

      setOidcTokens(tokens, now());
      scheduleRefresh();

      return true;
    } catch {
      clearOidcTokens();

      return false;
    }
  }, [fetcher, now, scheduleRefresh]);

  const signIn = useCallback(
    async ({ automatic = false } = {}) => {
      const settings = settingsRef.current;
      const discovery = discoveryRef.current;

      if (!settings || !discovery || !location) {
        return;
      }

      try {
        const { pending, url } = await buildAuthorizationRequest({
          audience: settings.audience,
          clientId: settings.clientId,
          crypto: cryptoImpl,
          discovery,
          now: now(),
          redirectUri: settings.redirectUri,
          scopes: settings.scopes,
        });

        savePendingLogin(pending);
        if (automatic) {
          writeSessionValue(AUTO_LOGIN_STORAGE_KEY, String(now()));
        }
        location.assign(url);
      } catch (error) {
        setState((current) => ({
          ...current,
          error: safeMessage(error, "Unable to start sign-in."),
          status: "signed_out",
        }));
      }
    },
    [cryptoImpl, location, now]
  );

  const handleReauthRequired = useCallback(() => {
    clearRefreshTimer();
    const lastAutomaticLogin = Number(readSessionValue(AUTO_LOGIN_STORAGE_KEY) || 0);
    const canRedirect = now() - lastAutomaticLogin > AUTO_LOGIN_WINDOW_MS;

    setState((current) => ({
      ...current,
      error: canRedirect ? "" : "Your session could not be renewed. Sign in again.",
      me: null,
      status: "signed_out",
    }));

    if (canRedirect) {
      void signIn({ automatic: true });
    }
  }, [clearRefreshTimer, now, signIn]);

  const signOut = useCallback(() => {
    const settings = settingsRef.current;
    const idTokenHint = getIdToken();

    clearRefreshTimer();
    clearOidcTokens();
    setState((current) => ({ ...current, error: "", me: null, status: "signed_out" }));

    const endSessionUrl = buildEndSessionUrl({
      clientId: settings?.clientId,
      discovery: discoveryRef.current,
      idTokenHint,
      postLogoutRedirectUri: settings?.postLogoutRedirectUri,
    });

    if (endSessionUrl && location) {
      location.assign(endSessionUrl);
    }
  }, [clearRefreshTimer, location]);

  useEffect(() => {
    // StrictMode runs effects twice; the callback code must be redeemed once.
    if (startedRef.current) {
      return undefined;
    }
    startedRef.current = true;

    const initialize = async () => {
      const serverConfig = await Promise.resolve()
        .then(() => loadServerConfig())
        .catch(() => null);
      const settings = resolveOidcSettings({
        env,
        origin: location?.origin ?? "",
        serverConfig,
      });

      if (!settings) {
        setState({ error: "", me: null, oidcEnabled: false, status: "disabled" });
        return;
      }

      settingsRef.current = settings;

      try {
        discoveryRef.current = await discoverOidc(settings.issuer, { fetchImpl: fetcher });
      } catch (error) {
        setState({
          error: safeMessage(error, "Sign-in is unavailable."),
          me: null,
          oidcEnabled: true,
          status: "error",
        });
        return;
      }

      let error = "";
      const href = location?.href ?? "";

      if (href && isCallbackUrl(href)) {
        const pending = takePendingLogin(undefined, now());

        try {
          const { tokens } = await completeAuthorizationCallback({
            clientId: settings.clientId,
            discovery: discoveryRef.current,
            fetchImpl: fetcher,
            href,
            now: now(),
            pending,
          });

          setOidcTokens(tokens, now());
        } catch (callbackError) {
          error = safeMessage(callbackError, "Sign-in failed.");
        }

        replaceUrl(stripCallbackParams(href));
      } else if (getStoredRefreshToken()) {
        await refreshWithStoredToken();
      }

      if (!hasOidcAccessToken()) {
        setState({ error, me: null, oidcEnabled: true, status: "signed_out" });
        return;
      }

      scheduleRefresh();
      const me = await Promise.resolve()
        .then(() => loadMe())
        .catch(() => null);

      setState({
        error: "",
        me: me && typeof me === "object" && !Array.isArray(me) ? me : null,
        oidcEnabled: true,
        status: hasOidcAccessToken() ? "signed_in" : "signed_out",
      });
    };

    void initialize();

    return undefined;
    // Runs once per mounted provider; handlers read the latest refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () =>
      setTokenHandlers({
        onReauthRequired: handleReauthRequired,
        onRefresh: refreshWithStoredToken,
      }),
    [handleReauthRequired, refreshWithStoredToken]
  );

  useEffect(() => clearRefreshTimer, [clearRefreshTimer]);

  const can = useCallback((capability) => decideCapability(state, capability), [state]);

  const value = useMemo(
    () => ({ ...state, can, signIn: () => signIn(), signOut }),
    [can, signIn, signOut, state]
  );

  // Children mount only once auth is settled, so the app's first requests
  // already carry the bearer token after a sign-in callback.
  return (
    <AuthContext.Provider value={value}>
      {state.status === "loading" ? (
        <div className="archive-auth-loading" role="status" aria-live="polite">
          Checking sign-in…
        </div>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
