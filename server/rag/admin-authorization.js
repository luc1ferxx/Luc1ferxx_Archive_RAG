import { isApiAuthEnabled } from "./config.js";
import {
  ADMIN_PERMISSION_IDS,
  buildAdminAccessDecision,
  getPermissionForAdminAction,
} from "./admin-permissions.js";
import { isAdminPermissionGrantedByRbac } from "./rbac.js";

export const ADMIN_AUTHORIZATION_REASONS = Object.freeze({
  allowedByRbac: "allowed_by_rbac",
  apiAuthDisabled: "api_auth_disabled",
  notRequired: "not_required",
});

const getDefaultAccessScope = (req) => req.accessScope ?? {};

const compactDecision = (decision = {}) => ({
  allowed: decision.allowed === true,
  permissionId: String(decision.permissionId ?? ""),
  reason: String(decision.reason ?? ""),
  roleId: String(decision.roleId ?? ""),
});

const resolvePermissionId = (permission, req) =>
  typeof permission === "function" ? permission(req) : permission;

export const getAdminStatusReadPermission = () =>
  ADMIN_PERMISSION_IDS.adminStatusRead;

export const getAdminAuditReadPermission = () =>
  ADMIN_PERMISSION_IDS.adminAuditRead;

export const getAdminActionPermissionForRequest = (req) =>
  getPermissionForAdminAction(req.params?.action);

export const buildAdminAuthorizationDecision = ({
  accessScope = {},
  apiAuthEnabled = isApiAuthEnabled(),
  permissionId,
} = {}) => {
  if (!permissionId) {
    return {
      allowed: true,
      permissionId: "",
      reason: ADMIN_AUTHORIZATION_REASONS.notRequired,
      roleId: "",
    };
  }

  if (!apiAuthEnabled) {
    return {
      allowed: true,
      permissionId,
      reason: ADMIN_AUTHORIZATION_REASONS.apiAuthDisabled,
      roleId: "",
    };
  }

  const decision = compactDecision(
    buildAdminAccessDecision({
      permissionId,
      principal: accessScope,
      requireAuthenticated: true,
    })
  );

  // RBAC_MODE=enforce: a workspace role may grant an admin permission inside
  // its workspace (workspace.admin -> admin.status.read). Off mode: unchanged.
  if (
    !decision.allowed &&
    accessScope?.authenticated === true &&
    isAdminPermissionGrantedByRbac(accessScope, permissionId)
  ) {
    return {
      allowed: true,
      permissionId: decision.permissionId,
      reason: ADMIN_AUTHORIZATION_REASONS.allowedByRbac,
      roleId: "",
    };
  }

  return decision;
};

const getRequestAuditContext = (req) => ({
  method: req.method,
  path: req.path,
  route: req.route?.path,
});

const safeRecordAuthorizationDecision = async ({
  accessScope,
  auditService,
  decision,
  req,
} = {}) => {
  if (typeof auditService?.recordAuthorizationDecision !== "function") {
    return;
  }

  try {
    await auditService.recordAuthorizationDecision({
      accessScope,
      actionId: req.params?.action,
      decision,
      request: getRequestAuditContext(req),
    });
  } catch {
    // Authorization must not fail closed because an optional audit sink is down.
  }
};

export const requireAdminPermission = (
  permission,
  {
    auditService = null,
    getAccessScope = getDefaultAccessScope,
    isAuthEnabled = isApiAuthEnabled,
  } = {}
) => async (req, res, next) => {
  const accessScope = getAccessScope(req);
  const decision = buildAdminAuthorizationDecision({
    accessScope,
    apiAuthEnabled: isAuthEnabled(),
    permissionId: resolvePermissionId(permission, req),
  });

  await safeRecordAuthorizationDecision({
    accessScope,
    auditService,
    decision,
    req,
  });

  if (decision.allowed) {
    next();
    return;
  }

  res.status(403).json({
    adminAuthorization: {
      permissionId: decision.permissionId,
      reason: decision.reason,
    },
    error: "Forbidden.",
  });
};
