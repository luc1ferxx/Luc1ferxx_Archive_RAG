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
  isApiAuthOidcEnabled,
  isApiAuthWorkspaceRequired,
} from "./rag/config.js";
import {
  normalizeWorkspaceRoles,
  peekJwtHeader,
  verifyOidcAccessToken,
} from "./rag/oidc.js";
import { runWithDatabaseTenant } from "./rag/postgres-tenant.js";

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

// Per-workspace role grants ({ [workspaceId]: roleId[] }), set only when the
// principal has some, so every existing access scope keeps its shape.
const addWorkspaceRoles = (target, principal = {}) => {
  const workspaceRoles = normalizeWorkspaceRoles(
    principal.workspaceRoles ?? principal.workspace_roles
  );

  if (Object.keys(workspaceRoles).length > 0) {
    target.workspaceRoles = workspaceRoles;
  }

  return target;
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

  return addWorkspaceRoles(
    addAccessPrincipalAuthorizationMetadata(
      {
        authProvider: "static_token",
        token,
        userId: normalizeString(principal.userId ?? principal.user_id),
        workspaceId: normalizeString(
          principal.workspaceId ?? principal.workspace_id
        ),
      },
      principal
    ),
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
    if (allowedWorkspaceIds.length === 0) {
      return requestedWorkspaceId;
    }

    const allowedWorkspaceId = normalizeScopeId(requestedWorkspaceId);

    if (!allowedWorkspaceIds.includes(allowedWorkspaceId)) {
      throw new AccessScopeError(
        "Requested workspace is outside authenticated scope."
      );
    }

    // The allowed list is compared case-insensitively, so the tenant must be
    // the canonical allowed id (as the single-workspace branch below already
    // returns), not the header as sent: "ACME" for a token limited to "acme"
    // would otherwise become another database tenant.
    return allowedWorkspaceId;
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

  return addWorkspaceRoles(
    addAccessPrincipalAuthorizationMetadata(target, principal),
    principal
  );
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

  // API_AUTH_OIDC_ENABLED: a JWS bearer token goes to the OIDC verifier
  // (asynchronous: discovery and JWKS), except an HS* token while HS256 JWT
  // auth is on, which stays with the shared-secret verifier. The OIDC verifier
  // itself refuses every HS* and "none" token.
  if (providedToken && isApiAuthOidcEnabled()) {
    const header = peekJwtHeader(providedToken);
    const sharedSecretToken =
      isApiAuthJwtEnabled() &&
      typeof header?.alg === "string" &&
      /^HS/iu.test(header.alg);

    if (header && !sharedSecretToken) {
      return verifyOidcAccessToken(providedToken);
    }
  }

  if (providedToken && isApiAuthJwtEnabled()) {
    return verifyJwtAuthToken(providedToken);
  }

  return null;
};

const sendAuthError = (res, error) => {
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
};

export const getRequestAccessScope = (req) => req.accessScope ?? {};

/**
 * Runs the rest of the request under its access scope as the database tenant,
 * so every PostgreSQL query a route issues is checked by row-level security
 * whether or not the store filtered it. Mounted after requireApiAuth; a
 * middleware that resumes the chain from a stream callback loses the async
 * context (multer's memory storage does) and must be followed by this again.
 */
export const bindDatabaseTenant = (req, res, next) =>
  runWithDatabaseTenant(getRequestAccessScope(req), next);

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

  const continueWithPrincipal = (resolvedPrincipal) => {
    if (!resolvedPrincipal) {
      res.status(401).json({
        error: "Unauthorized.",
      });
      return;
    }

    try {
      req.accessScope = buildAccessScope(req, {
        ...resolvedPrincipal,
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
    sendAuthError(res, error);
    return;
  }

  // Only the OIDC verifier is asynchronous; every other path stays synchronous.
  if (typeof principal?.then === "function") {
    principal.then(continueWithPrincipal, (error) => {
      if (!res.headersSent) {
        sendAuthError(res, error);
      }
    });
    return;
  }

  continueWithPrincipal(principal);
};
