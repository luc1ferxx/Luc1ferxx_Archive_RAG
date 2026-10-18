import { getAccessToken } from "./auth/tokenStore";
import { getActiveWorkspaceId, WORKSPACE_HEADER } from "./auth/workspaceSelection";

// "same-origin" is for the single-container deployment, where the API server
// also serves this build (FRONTEND_BUILD_DIRECTORY): requests go to relative
// paths on whatever host served the page.
export const resolveApiDomain = (configuredDomain) =>
  configuredDomain === "same-origin" ? "" : configuredDomain || "http://localhost:5001";

export const API_DOMAIN = resolveApiDomain(import.meta.env.VITE_DOMAIN);

export const API_AUTH_TOKEN = import.meta.env.VITE_API_AUTH_TOKEN || "";

// `omitWorkspaceHeader: true` sends the request without the selected
// workspace (WorkspaceProvider's first /auth/me, which asks what the
// credential itself allows).
export const buildApiRequestConfig = (config = {}) => {
  const { omitWorkspaceHeader = false, ...requestConfig } = config ?? {};
  const nextConfig = { ...requestConfig };
  const nextHeaders = {
    ...(requestConfig.headers ?? {}),
  };

  // An OIDC session (src/auth) wins; without one the static token path is
  // exactly what it was before OIDC existed.
  const oidcAccessToken = getAccessToken();

  if (oidcAccessToken) {
    nextHeaders.Authorization = `Bearer ${oidcAccessToken}`;
  } else if (API_AUTH_TOKEN) {
    nextHeaders["x-api-key"] = API_AUTH_TOKEN;
  }

  // The workspace switcher's choice (src/auth/workspaceSelection.js), on
  // every API request; nothing is added while none is selected.
  const workspaceId = omitWorkspaceHeader ? "" : getActiveWorkspaceId();

  if (workspaceId && !Object.hasOwn(nextHeaders, WORKSPACE_HEADER)) {
    nextHeaders[WORKSPACE_HEADER] = workspaceId;
  }

  if (Object.keys(nextHeaders).length > 0) {
    nextConfig.headers = nextHeaders;
  }

  return Object.keys(nextConfig).length > 0 ? nextConfig : undefined;
};
