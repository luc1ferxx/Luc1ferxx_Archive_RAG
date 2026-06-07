import crypto from "crypto";
import { getApiAuthToken, isApiAuthEnabled } from "./rag/config.js";

const PUBLIC_PATH_PREFIXES = ["/health", "/ready"];

const normalizeString = (value) => String(value ?? "").trim();

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
      token,
      userId: principal.trim(),
      workspaceId: "",
    };
  }

  return {
    token,
    userId: normalizeString(principal.userId ?? principal.user_id),
    workspaceId: normalizeString(
      principal.workspaceId ?? principal.workspace_id
    ),
  };
};

const parseConfiguredTokenPrincipals = () => {
  const rawTokenMap = process.env.API_AUTH_TOKENS?.trim();

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

const findTokenPrincipal = (providedToken) =>
  parseConfiguredTokenPrincipals().find((entry) =>
    constantTimeEqual(providedToken, entry.token)
  );

const buildAccessScope = (req, principal = {}) => ({
  authenticated: Boolean(principal.authenticated),
  userId:
    normalizeString(principal.userId) ||
    getRequestValue(req, "x-user-id") ||
    getRequestValue(req, "userId"),
  workspaceId:
    normalizeString(principal.workspaceId) ||
    getRequestValue(req, "x-workspace-id") ||
    getRequestValue(req, "workspaceId"),
});

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

    if (configuredPrincipals.length === 0) {
      res.status(500).json({
        error: "API authentication is enabled, but no API token is configured.",
      });
      return;
    }

    const providedToken = getProvidedToken(req);
    principal = providedToken ? findTokenPrincipal(providedToken) : null;
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "API authentication configuration is invalid.",
    });
    return;
  }

  if (!principal) {
    res.status(401).json({
      error: "Unauthorized.",
    });
    return;
  }

  req.accessScope = buildAccessScope(req, {
    ...principal,
    authenticated: true,
  });

  next();
};
