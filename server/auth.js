import crypto from "crypto";
import {
  addAccessPrincipalAuthorizationMetadata,
  normalizeAccessPrincipalWorkspaceIds,
  normalizeScopeId,
} from "./access-scope.js";
import { verifyJwtAuthToken } from "./auth-jwt.js";
import {
  getApiAuthConfigStatus,
  getApiAuthToken,
  getApiAuthTokens,
  isApiAuthEnabled,
  isApiAuthJwtEnabled,
  isApiAuthWorkspaceRequired,
} from "./rag/config.js";

const PUBLIC_PATH_PREFIXES = ["/health", "/ready"];

const normalizeString = (value) => String(value ?? "").trim();

class AccessScopeError extends Error {
  constructor(message, { status = 403 } = {}) {
    super(message);
    this.name = "AccessScopeError";
    this.status = status;
  }
}

const getRequestValue = (req, key) =>
  normalizeString(req.get(key)) ||
  normalizeString(req.body?.[key]) ||
  normalizeString(req.query?.[key]);

const getProvidedToken = (req) => {
  const apiKeyHeader = req.get("x-api-key")?.trim();

  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  const authorizationHeader = req.get("authorization")?.trim() ?? "";
  const bearerMatch = authorizationHeader.match(/^bearer\s+(.+)$/i);

  return bearerMatch?.[1]?.trim() ?? "";
};

const normalizeTokenPrincipal = (token, principal = {}) => {
  if (typeof principal === "string") {
    return {
      authProvider: "static_token",
      token,
      userId: principal.trim(),
      workspaceId: "",
    };
  }

  return addAccessPrincipalAuthorizationMetadata(
    {
      authProvider: "static_token",
      token,
      userId: normalizeString(principal.userId ?? principal.user_id),
      workspaceId: normalizeString(
        principal.workspaceId ?? principal.workspace_id
      ),
    },
    principal
  );
};

const parseConfiguredTokenPrincipals = () => {
  const rawTokenMap = getApiAuthTokens().trim();

  if (rawTokenMap) {
    let parsedTokens = null;

    try {
      parsedTokens = JSON.parse(rawTokenMap);
    } catch {
      const error = new Error("API_AUTH_TOKENS must be valid JSON.");
      error.status = 500;
      throw error;
    }

    if (Array.isArray(parsedTokens)) {
      return parsedTokens
        .map((entry) =>
          normalizeTokenPrincipal(normalizeString(entry?.token), entry)
        )
        .filter((entry) => entry.token);
    }

    if (parsedTokens && typeof parsedTokens === "object") {
      return Object.entries(parsedTokens)
        .map(([token, principal]) => normalizeTokenPrincipal(token, principal))
        .filter((entry) => entry.token);
    }

    const error = new Error(
      "API_AUTH_TOKENS must be a JSON object or array."
    );
    error.status = 500;
    throw error;
  }

  const fallbackToken = getApiAuthToken().trim();

  return fallbackToken
    ? [
        {
          authProvider: "static_token",
          token: fallbackToken,
          userId: "",
          workspaceId: "",
        },
      ]
    : [];
};

const constantTimeEqual = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const resolveWorkspaceId = (req, principal = {}) => {
  const requestedWorkspaceId =
    getRequestValue(req, "x-workspace-id") ||
    getRequestValue(req, "workspaceId");
  const principalWorkspaceId = normalizeString(principal.workspaceId);
  const allowedWorkspaceIds = normalizeAccessPrincipalWorkspaceIds(principal);

  if (principalWorkspaceId) {
    if (
      allowedWorkspaceIds.length > 0 &&
      !allowedWorkspaceIds.includes(normalizeScopeId(principalWorkspaceId))
    ) {
      throw new AccessScopeError(
        "Authenticated workspace is outside allowed workspace scope."
      );
    }

    if (
      requestedWorkspaceId &&
      normalizeScopeId(requestedWorkspaceId) !==
        normalizeScopeId(principalWorkspaceId)
    ) {
      throw new AccessScopeError(
        "Requested workspace is outside authenticated scope."
      );
    }

    return principalWorkspaceId;
  }

  if (requestedWorkspaceId) {
    if (
      allowedWorkspaceIds.length > 0 &&
      !allowedWorkspaceIds.includes(normalizeScopeId(requestedWorkspaceId))
    ) {
      throw new AccessScopeError(
        "Requested workspace is outside authenticated scope."
      );
    }

    return requestedWorkspaceId;
  }

  if (allowedWorkspaceIds.length === 1) {
    return allowedWorkspaceIds[0];
  }

  if (isApiAuthWorkspaceRequired() && Boolean(principal.authenticated)) {
    throw new AccessScopeError("Authenticated requests require a workspace scope.");
  }

  return "";
};

const buildAccessScope = (req, principal = {}) => {
  const target = {
    authenticated: Boolean(principal.authenticated),
    authProvider: normalizeString(principal.authProvider),
    userId:
      normalizeString(principal.userId) ||
      getRequestValue(req, "x-user-id") ||
      getRequestValue(req, "userId"),
    workspaceId: resolveWorkspaceId(req, principal),
  };

  if (!target.authProvider) {
    delete target.authProvider;
  }

  return addAccessPrincipalAuthorizationMetadata(target, principal);
};

const resolveAuthenticatedPrincipal = ({ providedToken, staticPrincipals }) => {
  const staticPrincipal = providedToken
    ? staticPrincipals.find((entry) =>
        constantTimeEqual(providedToken, entry.token)
      )
    : null;

  if (staticPrincipal) {
    return staticPrincipal;
  }

  if (providedToken && isApiAuthJwtEnabled()) {
    return verifyJwtAuthToken(providedToken);
  }

  return null;
};

export const getRequestAccessScope = (req) => req.accessScope ?? {};

export const requireApiAuth = (req, res, next) => {
  if (!isApiAuthEnabled()) {
    req.accessScope = buildAccessScope(req, {
      authenticated: false,
    });
    next();
    return;
  }

  if (
    PUBLIC_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))
  ) {
    next();
    return;
  }

  let principal = null;

  try {
    const configuredPrincipals = parseConfiguredTokenPrincipals();
    const authConfig = getApiAuthConfigStatus();

    if (authConfig.status !== "ok") {
      res.status(500).json({
        error: "API authentication is enabled, but no authentication method is configured.",
      });
      return;
    }

    const providedToken = getProvidedToken(req);
    principal = resolveAuthenticatedPrincipal({
      providedToken,
      staticPrincipals: configuredPrincipals,
    });
  } catch (error) {
    const status = Number(error?.status ?? 500) || 500;
    const message =
      status === 401
        ? "Unauthorized."
        : error instanceof Error
          ? error.message
          : "API authentication configuration is invalid.";

    res.status(status).json({
      error: message,
    });
    return;
  }

  if (!principal) {
    res.status(401).json({
      error: "Unauthorized.",
    });
    return;
  }

  try {
    req.accessScope = buildAccessScope(req, {
      ...principal,
      authenticated: true,
    });
  } catch (error) {
    res.status(error?.status ?? 403).json({
      error: error instanceof Error ? error.message : "Forbidden.",
    });
    return;
  }

  next();
};
