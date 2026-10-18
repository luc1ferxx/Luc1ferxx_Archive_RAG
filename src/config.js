import { getAccessToken } from "./auth/tokenStore";
import {
  getActiveWorkspaceId,
  normalizeWorkspaceId,
  WORKSPACE_HEADER,
} from "./auth/workspaceSelection";

// "same-origin" is for the single-container deployment, where the API server
// also serves this build (FRONTEND_BUILD_DIRECTORY): requests go to relative
// paths on whatever host served the page.
export const resolveApiDomain = (configuredDomain) =>
  configuredDomain === "same-origin" ? "" : configuredDomain || "http://localhost:5001";

export const API_DOMAIN = resolveApiDomain(import.meta.env.VITE_DOMAIN);

export const API_AUTH_TOKEN = import.meta.env.VITE_API_AUTH_TOKEN || "";

// `omitWorkspaceHeader: true` sends the request without the selected
// workspace (WorkspaceProvider's first /auth/me, which asks what the
// credential itself allows). `workspaceId` (a string, "" for none) pins the
// workspace instead of reading the selection now: apiClient and the chat
// stream read it once per logical request and hand the same value to the
// retry after a 401, so a switch during the token refresh can never send the
// retry (a clear, a delete) to the workspace switched to. Only the
// Authorization header is rebuilt for the retry.
export const buildApiRequestConfig = (config = {}) => {
  const {
    omitWorkspaceHeader = false,
    workspaceId: pinnedWorkspaceId,
    ...requestConfig
  } = config ?? {};
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
  const workspaceId = omitWorkspaceHeader
    ? ""
    : typeof pinnedWorkspaceId === "string"
      ? normalizeWorkspaceId(pinnedWorkspaceId)
      : getActiveWorkspaceId();

  if (workspaceId && !Object.hasOwn(nextHeaders, WORKSPACE_HEADER)) {
    nextHeaders[WORKSPACE_HEADER] = workspaceId;
  }

  if (Object.keys(nextHeaders).length > 0) {
    nextConfig.headers = nextHeaders;
  }

  return Object.keys(nextConfig).length > 0 ? nextConfig : undefined;
};
