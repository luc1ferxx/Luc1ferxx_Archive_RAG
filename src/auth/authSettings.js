// Decides whether the SPA offers OIDC sign-in and with which settings.
// GET /auth/config (no secrets) wins over the VITE_OIDC_* build variables;
// the build variables apply only when the endpoint is missing or unreachable.

export const DEFAULT_OIDC_SCOPES = "openid profile email";

const OIDC_MODE_PATTERN = /(^|[^a-z0-9])oidc([^a-z0-9]|$)/i;

export const isOidcMode = (mode) =>
  Array.isArray(mode)
    ? mode.some((entry) => OIDC_MODE_PATTERN.test(String(entry ?? "")))
    : OIDC_MODE_PATTERN.test(String(mode ?? ""));

const isServerConfig = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && "mode" in value;

const text = (value) => (typeof value === "string" ? value.trim() : "");

const scopesText = (value) =>
  Array.isArray(value) ? value.map(String).join(" ") : text(value);

export const resolveOidcSettings = ({ env = {}, origin = "", serverConfig = null } = {}) => {
  const fromEnv = {
    audience: text(env.VITE_OIDC_AUDIENCE),
    clientId: text(env.VITE_OIDC_CLIENT_ID),
    issuer: text(env.VITE_OIDC_ISSUER),
    scopes: scopesText(env.VITE_OIDC_SCOPES),
  };
  const redirectUri = text(env.VITE_OIDC_REDIRECT_URI) || (origin ? `${origin}/` : "");
  const postLogoutRedirectUri = text(env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI) || redirectUri;
  let settings = fromEnv;

  if (isServerConfig(serverConfig)) {
    if (!isOidcMode(serverConfig.mode)) {
      return null;
    }

    const fromServer = serverConfig.oidc ?? {};

    settings = {
      audience: text(fromServer.audience) || fromEnv.audience,
      clientId: text(fromServer.clientId) || fromEnv.clientId,
      issuer: text(fromServer.issuer) || fromEnv.issuer,
      scopes: scopesText(fromServer.scopes) || fromEnv.scopes,
    };
  }

  if (!settings.issuer || !settings.clientId) {
    return null;
  }

  return {
    ...settings,
    postLogoutRedirectUri,
    redirectUri,
    scopes: settings.scopes || DEFAULT_OIDC_SCOPES,
  };
};
