import { readFileSync } from "node:fs";

import {
  normalizeAccessPrincipalPermissions,
  normalizeAccessPrincipalRoles,
  normalizeAccessPrincipalWorkspaceIds,
  normalizeScopeId,
  normalizeScopeIds,
  normalizeScopeText,
} from "../access-scope.js";
import {
  ADMIN_PERMISSION_IDS,
  ADMIN_ROLE_CONTRACTS,
  ADMIN_ROLE_IDS,
  getPermissionForAdminAction,
} from "./admin-permissions.js";
import { isApiAuthEnabled } from "./config.js";

// Role-based access control for ordinary (tenant data) routes, composed with
// the admin permissions in admin-permissions.js.
//
// RBAC_MODE=off (default) changes nothing: the middleware calls next() for
// every request and the existing admin checks stay the only gate.
// RBAC_MODE=enforce looks every request up in RBAC_ROUTE_TABLE (method plus
// Express path) and needs the route's permission among the principal's
// effective permissions for the active workspace:
//   global roles and permissions on the principal (roleIds / permissionIds)
//   + workspaceRoles[activeWorkspaceId] (roles granted inside one workspace;
//     they carry only workspace permissions, never an admin.* permission,
//     because every admin permission reads or acts across tenants)
//   + RBAC_DEFAULT_ROLE (default workspace.member, so turning enforce on does
//     not lock out every existing static-token principal; "none" disables it),
//     only for a principal with no workspace permission of its own, so an
//     explicit workspace.viewer is not silently raised to member.
// A route missing from the table is denied. Denials answer 403
// { code: "RBAC_PERMISSION_DENIED", permission } and are written to the admin
// audit store with ids only.

export const RBAC_MODES = Object.freeze({
  enforce: "enforce",
  off: "off",
});

export const RBAC_ERROR_CODE = "RBAC_PERMISSION_DENIED";

export const RBAC_DENIAL_REASONS = Object.freeze({
  missingPermission: "rbac_missing_permission",
  routeNotInTable: "rbac_route_not_in_table",
  unknownPermission: "rbac_unknown_permission",
});

export const RBAC_PERMISSION_IDS = Object.freeze({
  chatAsk: "chat.ask",
  documentsDelete: "documents.delete",
  documentsRead: "documents.read",
  documentsWrite: "documents.write",
  memoryRead: "memory.read",
  memoryWrite: "memory.write",
  qualityFeedback: "quality.feedback",
  tasksRun: "tasks.run",
});

export const RBAC_ROLE_IDS = Object.freeze({
  workspaceAdmin: "workspace.admin",
  workspaceMember: "workspace.member",
  workspaceViewer: "workspace.viewer",
});

export const DEFAULT_RBAC_DEFAULT_ROLE = RBAC_ROLE_IDS.workspaceMember;

const ORDINARY_PERMISSION_LIST = Object.freeze(Object.values(RBAC_PERMISSION_IDS));
const ADMIN_PERMISSION_LIST = Object.freeze(Object.values(ADMIN_PERMISSION_IDS));
const ALL_PERMISSION_LIST = Object.freeze([
  ...ORDINARY_PERMISSION_LIST,
  ...ADMIN_PERMISSION_LIST,
]);
const PERMISSION_SET = new Set(ALL_PERMISSION_LIST);
const ORDINARY_PERMISSION_SET = new Set(ORDINARY_PERMISSION_LIST);

export const RBAC_PERMISSION_CATALOG = Object.freeze(
  ALL_PERMISSION_LIST.map((id) =>
    Object.freeze({
      id,
      kind: ADMIN_PERMISSION_LIST.includes(id) ? "admin" : "workspace",
    })
  )
);

export const listRbacPermissionIds = () => [...ALL_PERMISSION_LIST];

export const isKnownRbacPermission = (permissionId) =>
  PERMISSION_SET.has(normalizeScopeId(permissionId));

const VIEWER_PERMISSIONS = [
  RBAC_PERMISSION_IDS.documentsRead,
  RBAC_PERMISSION_IDS.chatAsk,
];
const MEMBER_PERMISSIONS = [
  ...VIEWER_PERMISSIONS,
  RBAC_PERMISSION_IDS.documentsWrite,
  RBAC_PERMISSION_IDS.tasksRun,
  RBAC_PERMISSION_IDS.memoryRead,
  RBAC_PERMISSION_IDS.memoryWrite,
  RBAC_PERMISSION_IDS.qualityFeedback,
];
const WORKSPACE_ADMIN_PERMISSIONS = [
  ...MEMBER_PERMISSIONS,
  RBAC_PERMISSION_IDS.documentsDelete,
  ADMIN_PERMISSION_IDS.adminStatusRead,
];

const buildDefaultRolePolicy = () => {
  const policy = {
    [RBAC_ROLE_IDS.workspaceViewer]: VIEWER_PERMISSIONS,
    [RBAC_ROLE_IDS.workspaceMember]: MEMBER_PERMISSIONS,
    [RBAC_ROLE_IDS.workspaceAdmin]: WORKSPACE_ADMIN_PERMISSIONS,
  };

  // The existing admin roles keep exactly their admin permissions; admin.owner
  // is the superuser it already was before RBAC (every permission).
  for (const [roleId, contract] of Object.entries(ADMIN_ROLE_CONTRACTS)) {
    policy[roleId] = [...contract.permissionIds];
  }

  policy[ADMIN_ROLE_IDS.owner] = [...ALL_PERMISSION_LIST];

  return Object.freeze(
    Object.fromEntries(
      Object.entries(policy).map(([roleId, permissions]) => [
        roleId,
        Object.freeze([...new Set(permissions)]),
      ])
    )
  );
};

export const DEFAULT_RBAC_ROLE_POLICY = buildDefaultRolePolicy();

class RbacConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RbacConfigurationError";
    this.status = 500;
    this.code = "RBAC_CONFIGURATION_INVALID";
  }
}

const readEnv = (env, key) => String(env?.[key] ?? "").trim();

export const getRbacMode = (env = process.env) => {
  const raw = readEnv(env, "RBAC_MODE").toLowerCase();

  if (!raw) {
    return RBAC_MODES.off;
  }

  if (raw === RBAC_MODES.off || raw === RBAC_MODES.enforce) {
    return raw;
  }

  // Fails closed: a typo must not silently leave RBAC off.
  throw new RbacConfigurationError("RBAC_MODE must be off or enforce.");
};

export const isRbacEnforced = (env = process.env) =>
  getRbacMode(env) === RBAC_MODES.enforce;

const parsePolicyOverride = (rawJson, sourceName) => {
  let parsed = null;

  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new RbacConfigurationError(`${sourceName} must be valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RbacConfigurationError(
      `${sourceName} must be a JSON object mapping role ids to permission ids.`
    );
  }

  const roles =
    parsed.roles && typeof parsed.roles === "object" && !Array.isArray(parsed.roles)
      ? parsed.roles
      : parsed;
  const overrides = {};

  for (const [rawRoleId, rawPermissions] of Object.entries(roles)) {
    const roleId = normalizeScopeId(rawRoleId);

    if (!roleId) {
      throw new RbacConfigurationError(`${sourceName} has an empty role id.`);
    }

    const permissionList = Array.isArray(rawPermissions)
      ? rawPermissions
      : rawPermissions && Array.isArray(rawPermissions.permissions)
        ? rawPermissions.permissions
        : null;

    if (!permissionList) {
      throw new RbacConfigurationError(
        `${sourceName} role ${roleId} must list its permissions as an array.`
      );
    }

    const permissions = [];

    for (const rawPermission of permissionList) {
      const permissionId =
        typeof rawPermission === "string" ? normalizeScopeId(rawPermission) : "";

      if (!PERMISSION_SET.has(permissionId)) {
        throw new RbacConfigurationError(
          `${sourceName} role ${roleId} names an unknown permission: ${normalizeScopeText(
            typeof rawPermission === "string" ? rawPermission : typeof rawPermission
          ).slice(0, 80)}.`
        );
      }

      permissions.push(permissionId);
    }

    overrides[roleId] = Object.freeze([...new Set(permissions)]);
  }

  return overrides;
};

const readPolicyOverride = (env) => {
  const rawJson = readEnv(env, "RBAC_POLICY_JSON");
  const filePath = readEnv(env, "RBAC_POLICY_FILE");

  if (rawJson && filePath) {
    throw new RbacConfigurationError(
      "Set only one of RBAC_POLICY_JSON and RBAC_POLICY_FILE."
    );
  }

  if (rawJson) {
    return { cacheKey: `json:${rawJson}`, load: () => parsePolicyOverride(rawJson, "RBAC_POLICY_JSON") };
  }

  if (filePath) {
    return {
      cacheKey: `file:${filePath}`,
      load: () => {
        let contents = "";

        try {
          contents = readFileSync(filePath, "utf8");
        } catch {
          throw new RbacConfigurationError("RBAC_POLICY_FILE could not be read.");
        }

        return parsePolicyOverride(contents, "RBAC_POLICY_FILE");
      },
    };
  }

  return { cacheKey: "", load: () => ({}) };
};

let cachedConfig = null;

/**
 * The validated RBAC configuration: mode, role -> permission policy (defaults
 * plus RBAC_POLICY_JSON / RBAC_POLICY_FILE overrides, which replace a role's
 * list or add a role), and the default role. Throws on any invalid value;
 * createApp calls assertRbacConfiguration() so a bad policy refuses the start.
 */
export const getRbacConfig = (env = process.env) => {
  const mode = getRbacMode(env);
  const override = readPolicyOverride(env);
  const rawDefaultRole = readEnv(env, "RBAC_DEFAULT_ROLE");
  const cacheKey = `${mode}\n${override.cacheKey}\n${rawDefaultRole}`;

  if (env === process.env && cachedConfig?.cacheKey === cacheKey) {
    return cachedConfig.config;
  }

  const policy = Object.freeze({
    ...DEFAULT_RBAC_ROLE_POLICY,
    ...override.load(),
  });
  const defaultRole =
    rawDefaultRole.toLowerCase() === "none"
      ? ""
      : normalizeScopeId(rawDefaultRole || DEFAULT_RBAC_DEFAULT_ROLE);

  if (defaultRole && !policy[defaultRole]) {
    throw new RbacConfigurationError(
      "RBAC_DEFAULT_ROLE names a role the RBAC policy does not define."
    );
  }

  const config = Object.freeze({ defaultRole, mode, policy });

  if (env === process.env) {
    cachedConfig = { cacheKey, config };
  }

  return config;
};

export const assertRbacConfiguration = (env = process.env) => {
  getRbacConfig(env);
  return true;
};

// Role keys are stored lower-cased; the active workspace is the tenant as
// resolved by requireApiAuth, which keeps its case when the token names no
// allowed workspaces. Matching the key against the lower-cased tenant would
// let a role granted in "acme" apply in the distinct tenant "ACME", so the
// tenant must already be in canonical form for a workspace role to apply.
const getWorkspaceRoleIds = (accessScope, workspaceId) => {
  const normalizedWorkspaceId = normalizeScopeText(workspaceId);
  const workspaceRoles =
    accessScope?.workspaceRoles ?? accessScope?.workspace_roles ?? null;

  if (
    !normalizedWorkspaceId ||
    !workspaceRoles ||
    typeof workspaceRoles !== "object" ||
    Array.isArray(workspaceRoles)
  ) {
    return [];
  }

  const roleIds = [];

  for (const [key, value] of Object.entries(workspaceRoles)) {
    if (normalizeScopeId(key) === normalizedWorkspaceId) {
      roleIds.push(...normalizeScopeIds(value));
    }
  }

  return [...new Set(roleIds)];
};

/**
 * The roles and permissions that apply to one request: global roles and
 * permissions on the principal, the roles granted inside the active workspace
 * (workspace permissions only: admin.* permissions are deployment-wide, so a
 * role granted inside one workspace never carries them), and the default role
 * when the principal holds no workspace permission of its own (an explicit
 * lower role such as workspace.viewer is not raised to the default). Roles the
 * policy does not define grant nothing; permission ids outside the catalog are
 * dropped.
 */
export const describeEffectiveAccess = (
  accessScope = {},
  { env = process.env, workspaceId } = {}
) => {
  const config = getRbacConfig(env);
  const scope = accessScope && typeof accessScope === "object" ? accessScope : {};
  const activeWorkspaceId = normalizeScopeText(workspaceId ?? scope.workspaceId);
  const globalRoleIds = normalizeAccessPrincipalRoles(scope);
  const workspaceRoleIds = getWorkspaceRoleIds(scope, activeWorkspaceId);
  const permissions = new Set();

  for (const roleId of globalRoleIds) {
    for (const permissionId of config.policy[roleId] ?? []) {
      permissions.add(permissionId);
    }
  }

  for (const roleId of workspaceRoleIds) {
    for (const permissionId of config.policy[roleId] ?? []) {
      if (ORDINARY_PERMISSION_SET.has(permissionId)) {
        permissions.add(permissionId);
      }
    }
  }

  for (const permissionId of normalizeAccessPrincipalPermissions(scope)) {
    if (PERMISSION_SET.has(permissionId)) {
      permissions.add(permissionId);
    }
  }

  const appliesDefaultRole =
    Boolean(config.defaultRole) &&
    ![...permissions].some((permissionId) => ORDINARY_PERMISSION_SET.has(permissionId));

  if (appliesDefaultRole) {
    for (const permissionId of config.policy[config.defaultRole] ?? []) {
      permissions.add(permissionId);
    }
  }

  const roleIds = [
    ...new Set([
      ...globalRoleIds,
      ...workspaceRoleIds,
      ...(appliesDefaultRole ? [config.defaultRole] : []),
    ]),
  ];

  return {
    permissions: ALL_PERMISSION_LIST.filter((id) => permissions.has(id)),
    roleIds,
    workspaceId: activeWorkspaceId,
    workspaceRoleIds,
  };
};

export const resolveEffectivePermissions = (accessScope = {}, options = {}) =>
  describeEffectiveAccess(accessScope, options).permissions;

// ---------------------------------------------------------------------------
// Route table: every route of the public app, with the permission it needs.
// `access: "public"` routes carry no tenant data (health probes, login
// configuration); `access: "authenticated"` needs only a principal that passed
// requireApiAuth. Everything else names a permission, or resolves one from
// the route params. test/rbac-routes.test.mjs walks the Express router stack
// and fails when a route has no entry here.
// ---------------------------------------------------------------------------

export const RBAC_ROUTE_ACCESS = Object.freeze({
  authenticated: "authenticated",
  permission: "permission",
  public: "public",
});

const P = RBAC_PERMISSION_IDS;
const A = ADMIN_PERMISSION_IDS;
const pub = (method, path) => ({ access: RBAC_ROUTE_ACCESS.public, method, path });
const authn = (method, path) => ({
  access: RBAC_ROUTE_ACCESS.authenticated,
  method,
  path,
});
const perm = (method, path, permission) => ({
  access: RBAC_ROUTE_ACCESS.permission,
  method,
  path,
  permission,
});

const resolveAdminActionPermission = (params = {}) =>
  getPermissionForAdminAction(params.action);

export const RBAC_ROUTE_TABLE = Object.freeze(
  [
    // System and login configuration.
    pub("GET", "/livez"),
    pub("GET", "/health"),
    pub("GET", "/ready"),
    pub("GET", "/auth/config"),
    authn("GET", "/auth/me"),

    // Documents.
    perm("GET", "/documents", P.documentsRead),
    perm("GET", "/documents/:docId/file", P.documentsRead),
    perm("DELETE", "/documents/:docId", P.documentsDelete),
    perm("POST", "/documents/clear", P.documentsDelete),
    perm("PUT", "/documents/:docId", P.documentsWrite),

    // Uploads and ingest jobs.
    perm("POST", "/upload/init", P.documentsWrite),
    perm("GET", "/upload/status", P.documentsWrite),
    perm("POST", "/upload/chunk", P.documentsWrite),
    perm("POST", "/upload/complete", P.documentsWrite),
    perm("POST", "/upload", P.documentsWrite),
    perm("GET", "/ingest-jobs/:jobId", P.documentsWrite),

    // arXiv discovery and import.
    perm("GET", "/arxiv/search", P.documentsRead),
    perm("POST", "/arxiv/import", P.documentsWrite),
    perm("GET", "/documents/arxiv/suggestions", P.documentsRead),
    perm("GET", "/documents/:docId/arxiv/suggestions", P.documentsRead),
    perm("GET", "/documents/:docId/arxiv/suggestions/saved", P.documentsRead),
    perm("POST", "/documents/:docId/arxiv/import", P.documentsWrite),

    // Workspace artifacts.
    perm("GET", "/artifacts", P.documentsRead),
    perm("GET", "/artifacts/:artifactId", P.documentsRead),
    perm("GET", "/artifacts/:artifactId/download", P.documentsRead),
    perm("POST", "/artifacts/:artifactId/archive", P.documentsWrite),

    // Chat and the caller's own agent runs.
    perm("GET", "/chat", P.chatAsk),
    perm("POST", "/chat", P.chatAsk),
    perm("POST", "/chat/stream", P.chatAsk),
    perm("GET", "/capabilities", P.chatAsk),
    perm("GET", "/agent-runs", P.chatAsk),
    perm("GET", "/agent-runs/:runId", P.chatAsk),

    // Tasks, triggers, approvals and recovery of the caller's own runs. The
    // recovery services keep their own admin permission checks on top.
    perm("GET", "/tasks", P.tasksRun),
    perm("GET", "/tasks/:taskId", P.tasksRun),
    perm("POST", "/tasks/:taskId/actions/:action", P.tasksRun),
    perm("POST", "/agent-tasks", P.tasksRun),
    perm("GET", "/agent-triggers", P.tasksRun),
    perm("POST", "/agent-triggers/:triggerId/dispatch", P.tasksRun),
    perm("GET", "/agent-runs/recovery", P.tasksRun),
    perm("POST", "/agent-runs/:runId/recovery/actions/:action", P.tasksRun),
    perm("POST", "/agent-runs/:runId/actions/:action", P.tasksRun),
    perm("POST", "/agent-runs/:runId/steps/:stepId/actions/retry", P.tasksRun),

    // Memory and sessions.
    perm("GET", "/memory", P.memoryRead),
    perm("POST", "/memory", P.memoryWrite),
    perm("DELETE", "/memory", P.memoryWrite),
    perm("DELETE", "/memory/:memoryId", P.memoryWrite),
    perm("DELETE", "/sessions/:sessionId", P.memoryWrite),

    // Quality reports and feedback.
    perm("GET", "/quality/latest", P.documentsRead),
    perm("GET", "/quality/history", P.documentsRead),
    perm("GET", "/feedback", P.qualityFeedback),
    perm("POST", "/feedback", P.qualityFeedback),

    // Admin routes: the route-level requireAdminPermission checks stay too.
    perm("GET", "/admin/status", A.adminStatusRead),
    perm("GET", "/admin/audit", A.adminAuditRead),
    perm("GET", "/admin/index-versions", A.adminStatusRead),
    perm("GET", "/admin/ingest-jobs/dead-letter", A.adminStatusRead),
    perm("POST", "/admin/ingest-jobs/:jobId/requeue", A.adminActionRecoverTasks),
    perm("POST", "/admin/actions/:action", resolveAdminActionPermission),
  ].map((entry) => Object.freeze(entry))
);

const splitPath = (path) => {
  let normalized = String(path ?? "");

  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized.split("/");
};

const compiledRoutes = RBAC_ROUTE_TABLE.map((entry, index) => {
  const segments = splitPath(entry.path).map((segment) =>
    segment.startsWith(":")
      ? { name: segment.slice(1), param: true }
      : { literal: segment.toLowerCase(), param: false }
  );

  return {
    entry,
    index,
    literalCount: segments.filter((segment) => !segment.param).length,
    method: entry.method.toUpperCase(),
    segments,
  };
});

const normalizeMethod = (method) => {
  const upper = String(method ?? "").toUpperCase();
  // Express answers HEAD with the GET handler.
  return upper === "HEAD" ? "GET" : upper;
};

/**
 * Finds the table entry Express would route method + path to: the same
 * segment count, every literal equal (case-insensitive, like Express's
 * default), every param non-empty; the entry with the most literal segments
 * wins (so /agent-runs/recovery beats /agent-runs/:runId).
 */
export const matchRbacRoute = (method, path) => {
  const normalizedMethod = normalizeMethod(method);
  const requestSegments = splitPath(path);
  let best = null;

  for (const route of compiledRoutes) {
    if (
      route.method !== normalizedMethod ||
      route.segments.length !== requestSegments.length
    ) {
      continue;
    }

    const params = {};
    let matched = true;

    for (let index = 0; index < route.segments.length; index += 1) {
      const segment = route.segments[index];
      const requestSegment = requestSegments[index];

      if (segment.param) {
        if (!requestSegment) {
          matched = false;
          break;
        }

        params[segment.name] = requestSegment;
      } else if (segment.literal !== requestSegment.toLowerCase()) {
        matched = false;
        break;
      }
    }

    if (matched && (!best || route.literalCount > best.route.literalCount)) {
      best = { params, route };
    }
  }

  return best ? { entry: best.route.entry, params: best.params } : null;
};

export const resolveRoutePermission = (entry, params = {}) => {
  if (!entry || entry.access !== RBAC_ROUTE_ACCESS.permission) {
    return "";
  }

  const permission =
    typeof entry.permission === "function"
      ? entry.permission(params)
      : entry.permission;

  return normalizeScopeId(permission);
};

const buildDenial = ({ permission, reason }) => ({
  allowed: false,
  permissionId: permission || "",
  reason,
  roleId: "",
});

/**
 * Decides one request without side effects. Off mode allows everything.
 */
export const decideRbacRequest = ({
  accessScope = {},
  env = process.env,
  method,
  path,
} = {}) => {
  const config = getRbacConfig(env);

  if (config.mode !== RBAC_MODES.enforce) {
    return { allowed: true, permissionId: "", reason: "rbac_off", roleId: "" };
  }

  if (normalizeMethod(method) === "OPTIONS") {
    // CORS preflights are answered by the cors middleware and carry no data.
    return { allowed: true, permissionId: "", reason: "preflight", roleId: "" };
  }

  const match = matchRbacRoute(method, path);

  if (!match) {
    return buildDenial({
      permission: "",
      reason: RBAC_DENIAL_REASONS.routeNotInTable,
    });
  }

  if (match.entry.access !== RBAC_ROUTE_ACCESS.permission) {
    return {
      allowed: true,
      permissionId: "",
      reason: `rbac_${match.entry.access}`,
      roleId: "",
    };
  }

  const permission = resolveRoutePermission(match.entry, match.params);

  if (!PERMISSION_SET.has(permission)) {
    return buildDenial({
      permission,
      reason: RBAC_DENIAL_REASONS.unknownPermission,
    });
  }

  const access = describeEffectiveAccess(accessScope, { env });

  if (access.permissions.includes(permission)) {
    const grantingRole =
      access.roleIds.find((roleId) =>
        (config.policy[roleId] ?? []).includes(permission)
      ) ?? "";

    return {
      allowed: true,
      permissionId: permission,
      reason: grantingRole ? "rbac_allowed_by_role" : "rbac_allowed_by_permission",
      roleId: grantingRole,
    };
  }

  return buildDenial({
    permission,
    reason: RBAC_DENIAL_REASONS.missingPermission,
  });
};

const recordDenial = async ({ auditService, decision, req }) => {
  if (typeof auditService?.recordAuthorizationDecision !== "function") {
    return;
  }

  try {
    await auditService.recordAuthorizationDecision({
      accessScope: req.accessScope ?? {},
      actionId: normalizeScopeText(req.params?.action),
      decision,
      request: { method: req.method, path: req.path, route: "" },
    });
  } catch {
    // An unavailable audit sink must not turn a denial into an allow or a 500.
  }
};

const sendDenial = (res, decision) =>
  res.status(403).json({
    code: RBAC_ERROR_CODE,
    error: "Forbidden.",
    permission: decision.permissionId || null,
  });

/**
 * App-level middleware mounted after requireApiAuth / bindDatabaseTenant and
 * before every router that touches tenant data. At the public edge of a split
 * deployment it runs before the agent routes are forwarded, so the agent tier
 * trusts the edge's signed identity and does not check again.
 */
export const createRbacMiddleware = ({ auditService = null, env = process.env } = {}) =>
  async (req, res, next) => {
    let decision = null;

    try {
      decision = decideRbacRequest({
        accessScope: req.accessScope ?? {},
        env,
        method: req.method,
        path: req.path,
      });
    } catch (error) {
      res.status(error?.status ?? 500).json({
        code: error?.code ?? "RBAC_CONFIGURATION_INVALID",
        error: "RBAC configuration is invalid.",
      });
      return;
    }

    if (decision.allowed) {
      next();
      return;
    }

    await recordDenial({ auditService, decision, req });
    sendDenial(res, decision);
  };

/**
 * Express middleware for a single route, for routers mounted outside the app
 * (the app itself enforces the whole table through createRbacMiddleware).
 */
export const requirePermission = (permissionId, { auditService = null, env = process.env } = {}) =>
  async (req, res, next) => {
    let config = null;

    try {
      config = getRbacConfig(env);
    } catch (error) {
      res.status(error?.status ?? 500).json({
        code: error?.code ?? "RBAC_CONFIGURATION_INVALID",
        error: "RBAC configuration is invalid.",
      });
      return;
    }

    if (config.mode !== RBAC_MODES.enforce) {
      next();
      return;
    }

    const permission = normalizeScopeId(permissionId);
    const permissions = resolveEffectivePermissions(req.accessScope ?? {}, { env });

    if (PERMISSION_SET.has(permission) && permissions.includes(permission)) {
      next();
      return;
    }

    const decision = buildDenial({
      permission,
      reason: PERMISSION_SET.has(permission)
        ? RBAC_DENIAL_REASONS.missingPermission
        : RBAC_DENIAL_REASONS.unknownPermission,
    });

    await recordDenial({ auditService, decision, req });
    sendDenial(res, decision);
  };

/**
 * RBAC's answer for one admin permission, used by admin-authorization.js so a
 * workspace role (workspace.admin -> admin.status.read) passes the route-level
 * admin check too. Only in enforce mode; off mode returns false.
 */
export const isAdminPermissionGrantedByRbac = (
  accessScope = {},
  permissionId,
  { env = process.env } = {}
) => {
  if (!isRbacEnforced(env)) {
    return false;
  }

  return resolveEffectivePermissions(accessScope, { env }).includes(
    normalizeScopeId(permissionId)
  );
};

const getAdminPermissionsFromPrincipal = (accessScope) => {
  const principalPermissions = new Set(
    normalizeAccessPrincipalPermissions(accessScope)
  );

  for (const roleId of normalizeAccessPrincipalRoles(accessScope)) {
    for (const permissionId of ADMIN_ROLE_CONTRACTS[roleId]?.permissionIds ?? []) {
      principalPermissions.add(permissionId);
    }
  }

  return ADMIN_PERMISSION_LIST.filter((id) => principalPermissions.has(id));
};

/**
 * The GET /auth/me body: who the caller is and what it may do in the active
 * workspace. Never carries the credential. In off mode `permissions` lists
 * what the server actually allows today: every ordinary permission, plus the
 * admin permissions the existing admin check grants (all of them when API auth
 * is disabled).
 */
export const buildAuthMeResponse = (
  accessScope = {},
  { apiAuthEnabled = isApiAuthEnabled(), env = process.env } = {}
) => {
  const scope = accessScope && typeof accessScope === "object" ? accessScope : {};
  const config = getRbacConfig(env);
  const access = describeEffectiveAccess(scope, { env });
  const workspaceId = normalizeScopeText(scope.workspaceId);
  const workspaceIds = normalizeAccessPrincipalWorkspaceIds(scope);

  if (workspaceId && !workspaceIds.includes(normalizeScopeId(workspaceId))) {
    workspaceIds.unshift(workspaceId);
  }

  const permissions =
    config.mode === RBAC_MODES.enforce
      ? access.permissions
      : [
          ...ORDINARY_PERMISSION_LIST,
          ...(apiAuthEnabled
            ? getAdminPermissionsFromPrincipal(scope)
            : ADMIN_PERMISSION_LIST),
        ];

  return {
    authProvider:
      normalizeScopeText(scope.authProvider) ||
      (scope.authenticated === true ? "static_token" : "none"),
    permissions,
    rbacMode: config.mode,
    roles: access.roleIds,
    userId: normalizeScopeText(scope.userId),
    workspaceId,
    workspaceIds,
  };
};
