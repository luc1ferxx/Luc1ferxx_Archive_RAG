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
  isTenantMembershipEnforced,
} from "./rag/config.js";
import {
  normalizeWorkspaceRoles,
  peekJwtHeader,
  verifyOidcAccessToken,
} from "./rag/oidc.js";
import { runWithDatabaseTenant } from "./rag/postgres-tenant.js";
import { recordTenantRefusal } from "./rag/tenant-refusals.js";
import {
  decideTenantMembership,
  getDefaultTenantRegistry,
  resolveMembershipScope,
} from "./rag/tenant-registry.js";

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

// Set only by this module on a static principal that may name its user per
// request: the single shared API_AUTH_TOKEN (the documented local setup) and an
// API_AUTH_TOKENS entry with "allowClientUserId": true. A symbol, so no token
// claim or JSON field can set it on another principal.
const CLIENT_USER_ID_ALLOWED = Symbol("archiveRag.clientUserIdAllowed");

const CLIENT_USER_ID_KEYS = ["x-user-id", "userId"];

// Set only on the single shared API_AUTH_TOKEN principal. That credential is
// the documented single-tenant setup: it may already act as any user, so a
// request that names none keeps acting for the whole archive, as auth off does.
// Every other authenticated principal must end up with a user or a workspace
// (see requireTenantScope).
const SINGLE_TENANT_CREDENTIAL = Symbol("archiveRag.singleTenantCredential");

// Platform admin routes that answer across tenants by design, behind their own
// admin permission checks (routes/admin.js, GET /admin/index-versions in
// routes/documents.js, the tenant registry in routes/admin-tenants.js, GET
// /admin/usage in routes/admin-usage.js), plus GET /auth/me. Only a principal
// with no workspace list may call them without a user or workspace.
const TENANTLESS_PLATFORM_PATHS = new Set([
  "/admin/audit",
  "/admin/index-versions",
  "/admin/status",
  "/admin/workspaces",
  "/admin/tenants/erase",
  "/admin/tenants/export",
  "/admin/usage",
  "/auth/me",
]);
const TENANTLESS_PLATFORM_PATH_PREFIXES = ["/admin/actions/", "/admin/workspaces/"];

// Routes whose `userId` query parameter is a filter over other users' records,
// not the caller's identity: GET /admin/audit?userId=... (admin.audit.read).
const USER_ID_FILTER_QUERY_PATHS = new Set(["/admin/audit"]);

// Routes whose `workspaceId` and `userId` (JSON body or query) name the
// tenant the route acts on, not the caller: the tenant erase and export
// (routes/admin-tenant-lifecycle.js). There only the x-workspace-id and
// x-user-id headers select the caller's own scope, so a platform admin naming
// a target stays a platform admin, and naming a user is not a request to act
// as that user.
const TENANT_TARGET_PATHS = new Set(["/admin/tenants/erase", "/admin/tenants/export"]);

const isTenantTargetPath = (req) => TENANT_TARGET_PATHS.has(req.path);

// Platform admin reads across tenants where naming a workspace (x-workspace-id
// or ?workspaceId) narrows the view to it: GET /admin/usage
// (routes/admin-usage.js) and GET /admin/audit (routes/admin.js). For a
// principal with neither a fixed workspace nor a workspace list, that
// workspace is a filter over a read the admin permission already allows
// across every tenant, not a tenant the credential acts in, so
// TENANT_MEMBERSHIP=enforce does not ask for a membership there (it would
// refuse every such narrowing with WORKSPACE_MEMBERSHIP_REQUIRED); the route's
// own admin permission check decides. A principal bound to a workspace or a
// workspace list is still checked on these paths as on every other.
const WORKSPACE_FILTER_PLATFORM_PATHS = new Set(["/admin/audit", "/admin/usage"]);

// Every userId the client sent, from each place getRequestValue reads (header,
// JSON body, query), so a refusal cannot be dodged by putting the value where
// the first non-empty read does not look.
const listRequestedUserIds = (req) => {
  const userIdQueryIsFilter = USER_ID_FILTER_QUERY_PATHS.has(req.path);
  const userIdNamesTarget = isTenantTargetPath(req);

  return [
    ...new Set(
      CLIENT_USER_ID_KEYS.flatMap((key) => [
        normalizeString(req.get(key)),
        key === "userId" && userIdNamesTarget ? "" : normalizeString(req.body?.[key]),
        key === "userId" && (userIdQueryIsFilter || userIdNamesTarget)
          ? ""
          : normalizeString(req.query?.[key]),
      ]).filter(Boolean)
    ),
  ];
};

const allowsClientUserId = (principal = {}) =>
  !principal.authenticated || principal[CLIENT_USER_ID_ALLOWED] === true;

/**
 * The one decision about which user a request acts for.
 *
 * - A principal with its own userId (a token entry with one, an HS256 JWT,
 *   OIDC) acts as that user; a client userId is ignored, as before (pinned by
 *   app.test.mjs and service-roles.test.mjs).
 * - Without one, auth off, the single API_AUTH_TOKEN (the documented local
 *   setup) and an API_AUTH_TOKENS entry with "allowClientUserId": true take the
 *   client's x-user-id / userId (header, body, query), unchanged.
 * - Every other principal without a userId acts as no user, and a request that
 *   names one anyway is refused with 403 instead of acting as that user (an
 *   empty value is ignored). Before, such a workspace token could read and
 *   delete any user's documents and long-term memory by naming them.
 */
const resolveUserId = (req, principal = {}) => {
  const principalUserId = normalizeString(principal.userId);

  if (principalUserId) {
    return principalUserId;
  }

  if (allowsClientUserId(principal)) {
    return (
      getRequestValue(req, "x-user-id") ||
      (isTenantTargetPath(req) ? "" : getRequestValue(req, "userId"))
    );
  }

  if (listRequestedUserIds(req).length > 0) {
    throw new AccessScopeError(
      "This credential does not allow the client to choose a user."
    );
  }

  return "";
};

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

  const normalized = addWorkspaceRoles(
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

  // Only the literal JSON true opts in; "true", 1 and the like do not.
  if (principal?.allowClientUserId === true) {
    normalized[CLIENT_USER_ID_ALLOWED] = true;
  }

  return normalized;
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
          [CLIENT_USER_ID_ALLOWED]: true,
          [SINGLE_TENANT_CREDENTIAL]: true,
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

// API_AUTH_REQUIRE_WORKSPACE asks every authenticated request for a
// workspace, except a principal with no workspace list on a tenantless
// platform route (TENANTLESS_PLATFORM_PATHS): requireTenantScope lets exactly
// those principals through there without a tenant, because the platform
// routes act across tenants by design. Without the exception the setting
// refused every platform admin: no workspace could be registered (POST
// /admin/workspaces), erased or exported, and no usage or audit read across
// tenants, since naming a workspace makes the routes treat the caller as that
// workspace's admin instead.
const waivesWorkspaceRequirement = (req, principal = {}) =>
  normalizeAccessPrincipalWorkspaceIds(principal).length === 0 && isTenantlessPlatformPath(req.path);

const resolveWorkspaceId = (req, principal = {}, { requireWorkspace = isApiAuthWorkspaceRequired() } = {}) => {
  const requestedWorkspaceId =
    getRequestValue(req, "x-workspace-id") ||
    (isTenantTargetPath(req) ? "" : getRequestValue(req, "workspaceId"));
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

  if (requireWorkspace && Boolean(principal.authenticated) && !waivesWorkspaceRequirement(req, principal)) {
    throw new AccessScopeError("Authenticated requests require a workspace scope.");
  }

  return "";
};

const buildAccessScope = (req, principal = {}, options = {}) => {
  const target = {
    authenticated: Boolean(principal.authenticated),
    authProvider: normalizeString(principal.authProvider),
    userId: resolveUserId(req, principal),
    workspaceId: resolveWorkspaceId(req, principal, options),
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
 * The access scope of a request to a public route that answers everyone but
 * shows more to a caller with a permission (GET /health, /ready and /livez in
 * routes/system.js, which are mounted before requireApiAuth). With API auth on
 * it resolves the presented credential exactly as requireApiAuth does, but
 * never answers: no credential, an unknown or invalid one, an auth
 * configuration error, or a scope requireApiAuth would refuse all resolve to
 * null, so a probe without a key keeps its status code. requireTenantScope is
 * not applied: the scope only feeds a permission decision and never binds a
 * database tenant or reaches a store, which is what a tenantless scope would
 * widen. For the same reason API_AUTH_REQUIRE_WORKSPACE does not ask for a
 * workspace here, so a platform admin (no workspace) reads the details with
 * the setting on as with it off. The TENANT_MEMBERSHIP=enforce check is (a
 * refusal, or a registry that cannot answer, is null too). With auth off it is
 * the unauthenticated scope requireApiAuth builds.
 */
export const resolveOptionalAccessScope = async (req) => {
  if (!isApiAuthEnabled()) {
    return buildAccessScope(req, { authenticated: false });
  }

  const providedToken = getProvidedToken(req);

  if (!providedToken) {
    return null;
  }

  try {
    const staticPrincipals = parseConfiguredTokenPrincipals();

    if (getApiAuthConfigStatus().status !== "ok") {
      return null;
    }

    // Only the OIDC verifier is asynchronous; awaiting covers both.
    const principal = await resolveAuthenticatedPrincipal({
      providedToken,
      staticPrincipals,
    });

    if (!principal) {
      return null;
    }

    const accessScope = buildAccessScope(
      req,
      { ...principal, authenticated: true },
      { requireWorkspace: false }
    );
    const membership = checkTenantMembership(req, principal, accessScope);

    if (!membership) {
      return accessScope;
    }

    const decision = await membership;

    return decision.allowed ? decision.accessScope : null;
  } catch {
    return null;
  }
};

/**
 * Whether the request presents the single shared API_AUTH_TOKEN (no
 * API_AUTH_TOKENS): the single-tenant credential that already acts for the
 * whole archive. routes/system.js lets it read the health details, which no
 * other permission-less credential may.
 */
export const presentsSingleTenantCredential = (req) => {
  if (!isApiAuthEnabled()) {
    return false;
  }

  const providedToken = getProvidedToken(req);

  if (!providedToken) {
    return false;
  }

  try {
    return parseConfiguredTokenPrincipals().some(
      (principal) =>
        principal[SINGLE_TENANT_CREDENTIAL] === true &&
        constantTimeEqual(providedToken, principal.token)
    );
  } catch {
    return false;
  }
};

// An authenticated scope that names neither a user nor a workspace. The
// document registry, the feedback store, the ingest job store and the database
// tenant binding all read such a scope as "every tenant" (the auth-off
// meaning), so requireApiAuth lets it through only where that is intended.
export const isTenantlessAuthenticatedScope = (accessScope = {}) =>
  accessScope?.authenticated === true &&
  !normalizeString(accessScope.userId) &&
  !normalizeString(accessScope.workspaceId);

const isTenantlessPlatformPath = (path = "") =>
  TENANTLESS_PLATFORM_PATHS.has(path) ||
  TENANTLESS_PLATFORM_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));

/**
 * Refuses (403) an authenticated request whose scope names neither a user nor
 * a workspace, unless it comes from the single shared API_AUTH_TOKEN (the
 * single-tenant setup) or is a platform admin route called by a principal with
 * no workspace list. Before, such a request (for example an API_AUTH_TOKENS
 * entry with two workspaces and no x-workspace-id) listed, read and cleared
 * every tenant's documents, because an empty scope bypasses both the store
 * filters and row-level security.
 */
const requireTenantScope = (req, principal = {}) => {
  if (!isTenantlessAuthenticatedScope(req.accessScope)) {
    return;
  }

  if (principal[SINGLE_TENANT_CREDENTIAL] === true) {
    return;
  }

  if (
    isTenantlessPlatformPath(req.path) &&
    normalizeAccessPrincipalWorkspaceIds(principal).length === 0
  ) {
    return;
  }

  throw new AccessScopeError(
    "This request needs a user or workspace scope: name a workspace with x-workspace-id."
  );
};

// Where requireApiAuth and resolveOptionalAccessScope find the registry:
// createApp puts its own on app.locals; a router mounted elsewhere (tests)
// gets the process default.
const resolveTenantRegistry = (req) =>
  req.app?.locals?.tenantRegistry ?? getDefaultTenantRegistry();

/**
 * TENANT_MEMBERSHIP=enforce (rag/tenant-registry.js decideTenantMembership):
 * null when the check does not apply, else a promise of the decision with
 * the scope to use (the membership's roles merged into workspaceRoles for the
 * active workspace, refused when that makes more than the forwarded token's
 * MAX_SCOPE_WORKSPACE_ROLES: resolveMembershipScope). It does not apply with
 * the mode off (default), to the single shared API_AUTH_TOKEN (the
 * single-tenant setup), to a scope that names no workspace (a user-only
 * tenant, a platform admin on a platform path), or to a platform principal
 * narrowing GET /admin/usage or /admin/audit to a workspace
 * (WORKSPACE_FILTER_PLATFORM_PATHS). Called only with API auth on; auth off
 * never reaches it.
 */
const checkTenantMembership = (req, principal = {}, accessScope = {}) => {
  if (!isTenantMembershipEnforced()) {
    return null;
  }

  if (principal[SINGLE_TENANT_CREDENTIAL] === true) {
    return null;
  }

  const workspaceId = normalizeString(accessScope.workspaceId);

  if (!workspaceId) {
    return null;
  }

  // The workspace is the principal's own (its fixed workspace, or one of its
  // workspace list) rather than one the client named by header with nothing
  // binding the credential to it.
  const workspaceBoundByPrincipal =
    Boolean(normalizeString(principal.workspaceId)) ||
    normalizeAccessPrincipalWorkspaceIds(principal).length > 0;

  if (!workspaceBoundByPrincipal && WORKSPACE_FILTER_PLATFORM_PATHS.has(req.path)) {
    return null;
  }

  return decideTenantMembership({
    registry: resolveTenantRegistry(req),
    userId: normalizeString(accessScope.userId),
    workspaceBoundByPrincipal,
    workspaceId,
  }).then((decision) => resolveMembershipScope(accessScope, workspaceId, decision));
};

/**
 * Refuses an API_AUTH_TOKENS entry that names no user, no workspace, no
 * workspace list, no roles, no workspace roles and no permissions and does not
 * let the client choose its user. Without x-workspace-id such a token acts for
 * no tenant (requireTenantScope refuses it), and with one it acts for any
 * workspace it names, which is not a credential to issue on purpose.
 * createApp calls this so the misconfiguration stops the start.
 */
export const assertApiAuthTokenConfiguration = () => {
  if (!isApiAuthEnabled() || !getApiAuthTokens().trim()) {
    return;
  }

  const unusable = parseConfiguredTokenPrincipals().filter(
    (principal) =>
      !principal.userId &&
      !principal.workspaceId &&
      !principal.allowedWorkspaceIds?.length &&
      !principal.roleIds?.length &&
      !principal.permissionIds?.length &&
      !principal.workspaceRoles &&
      principal[CLIENT_USER_ID_ALLOWED] !== true
  );

  if (unusable.length > 0) {
    const error = new Error(
      `API_AUTH_TOKENS has ${unusable.length} ${
        unusable.length === 1 ? "entry" : "entries"
      } without a userId, workspaceId, workspaces, roles or permissions; such a token acts for no tenant, or for any workspace it names in x-workspace-id. Give it a userId, a workspaceId or the workspaces it may use.`
    );
    error.code = "API_AUTH_TOKEN_WITHOUT_SCOPE";
    throw error;
  }
};

/**
 * The user a route acts for, given the userId the route itself read from the
 * request (body or query). Every route that takes a client userId goes through
 * this (routes/helpers.js resolveScopedUserId). An authenticated scope already
 * carries the user resolveUserId decided (and requireApiAuth refused a
 * conflicting client value with 403), so the raw value is never consulted for
 * it; the agent tier's scope comes from the edge's token and is treated the
 * same. Without authentication the scope's user, else the raw value, as before.
 */
export const resolveRequestUserId = (req, rawUserId) => {
  const accessScope = getRequestAccessScope(req);
  const scopedUserId = normalizeString(accessScope.userId);

  if (accessScope.authenticated === true) {
    return scopedUserId;
  }

  return scopedUserId || (typeof rawUserId === "string" ? rawUserId.trim() : "");
};

/**
 * Runs the rest of the request under its access scope as the database tenant,
 * so every PostgreSQL query a route issues is checked by row-level security
 * whether or not the store filtered it. A scope that names no tenant (auth
 * off, the single shared API_AUTH_TOKEN, a platform admin path) is bound as
 * the explicit unscoped state, which runs as the owner like before but is not
 * the unbound state POSTGRES_TENANT_CONTEXT=strict refuses
 * (rag/postgres-tenant.js). Mounted after requireApiAuth; a middleware that
 * resumes the chain from a stream callback loses the async context (multer's
 * memory storage does) and must be followed by this again.
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

    let membership = null;

    try {
      req.accessScope = buildAccessScope(req, {
        ...resolvedPrincipal,
        authenticated: true,
      });
      requireTenantScope(req, resolvedPrincipal);
      membership = checkTenantMembership(req, resolvedPrincipal, req.accessScope);
    } catch (error) {
      res.status(error?.status ?? 403).json({
        error: error instanceof Error ? error.message : "Forbidden.",
      });
      return;
    }

    if (!membership) {
      next();
      return;
    }

    // TENANT_MEMBERSHIP=enforce: the registry lookups are asynchronous. The
    // decision itself never rejects (a registry fault is its 503); anything
    // else fails the request closed rather than leaving it unanswered. A
    // refusal is counted (rag/tenant-refusals.js) under the scope it was
    // decided for: the user and the workspace it asked for, which is how an
    // operator sees who is knocking on which workspace. The probes'
    // resolveOptionalAccessScope only hides details and counts nothing.
    membership
      .then((decision) => {
        if (!decision.allowed) {
          recordTenantRefusal(decision.code, req.accessScope);
          res.status(decision.status).json({ code: decision.code, error: decision.message });
          return;
        }

        req.accessScope = decision.accessScope;
        next();
      })
      .catch((error) => {
        console.error("Tenant membership check failed.", error);

        if (!res.headersSent) {
          res.status(500).json({ error: "Tenant membership check failed." });
        }
      });
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
