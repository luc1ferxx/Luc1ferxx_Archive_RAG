import {
  normalizeAccessPrincipalPermissions,
  normalizeAccessPrincipalRoles,
  normalizeScopeId,
  normalizeScopeText,
  toScopeArray,
} from "../access-scope.js";
import { ADMIN_ACTION_IDS } from "./admin-actions.js";

export const ADMIN_PERMISSION_IDS = Object.freeze({
  adminActionQualityRefresh: "admin.actions.quality_refresh",
  adminActionRecoverTasks: "admin.actions.recover_tasks",
  adminActionRecoveryScan: "admin.actions.recovery_scan",
  adminAuditRead: "admin.audit.read",
  adminStatusRead: "admin.status.read",
  adminTenantsRead: "admin.tenants.read",
  adminTenantsWrite: "admin.tenants.write",
  adminTenantsErase: "admin.tenants.erase",
  adminTenantsExport: "admin.tenants.export",
  adminUsageRead: "admin.usage.read",
  agentRunsRecoveryAction: "agent_runs.recovery.action",
  agentTasksAction: "agent_tasks.action",
});

export const ADMIN_ROLE_IDS = Object.freeze({
  operator: "admin.operator",
  owner: "admin.owner",
  qualityOperator: "admin.quality_operator",
  recoveryOperator: "admin.recovery_operator",
  tenantManager: "admin.tenant_manager",
  viewer: "admin.viewer",
});

export const ADMIN_PERMISSION_REASONS = Object.freeze({
  allowedByPermission: "allowed_by_permission",
  allowedByRole: "allowed_by_role",
  deniedMissingPermission: "denied_missing_permission",
  deniedUnauthenticated: "denied_unauthenticated",
  unknownPermission: "unknown_permission",
});

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const freezeContract = (contract) =>
  Object.freeze({
    ...contract,
    actionIds: Object.freeze(toScopeArray(contract.actionIds)),
    permissionIds: Object.freeze(toScopeArray(contract.permissionIds)),
  });

const cloneContract = (contract) =>
  contract
    ? {
        ...contract,
        ...(contract.actionIds ? { actionIds: [...contract.actionIds] } : {}),
        ...(contract.permissionIds
          ? { permissionIds: [...contract.permissionIds] }
          : {}),
      }
    : null;

export const ADMIN_PERMISSION_CONTRACTS = Object.freeze({
  [ADMIN_PERMISSION_IDS.adminStatusRead]: freezeContract({
    id: ADMIN_PERMISSION_IDS.adminStatusRead,
    label: "Read admin status",
    resource: "admin.status",
    risk: "read",
  }),
  [ADMIN_PERMISSION_IDS.adminActionRecoverTasks]: freezeContract({
    actionIds: [ADMIN_ACTION_IDS.recoverTasks],
    id: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
    label: "Recover runnable tasks",
    resource: "admin.actions",
    risk: "controlled_write",
  }),
  [ADMIN_PERMISSION_IDS.adminActionRecoveryScan]: freezeContract({
    actionIds: [ADMIN_ACTION_IDS.recoveryScan],
    id: ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
    label: "Scan recoverable agent runs",
    resource: "admin.actions",
    risk: "read",
  }),
  [ADMIN_PERMISSION_IDS.adminActionQualityRefresh]: freezeContract({
    actionIds: [ADMIN_ACTION_IDS.qualityRefresh],
    id: ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
    label: "Refresh historical quality metrics",
    resource: "admin.actions",
    risk: "controlled_compute",
  }),
  [ADMIN_PERMISSION_IDS.adminAuditRead]: freezeContract({
    id: ADMIN_PERMISSION_IDS.adminAuditRead,
    label: "Read admin audit events",
    resource: "admin.audit",
    risk: "read",
  }),
  [ADMIN_PERMISSION_IDS.adminTenantsRead]: freezeContract({
    id: ADMIN_PERMISSION_IDS.adminTenantsRead,
    label: "Read the tenant registry",
    resource: "admin.tenants",
    risk: "read",
  }),
  [ADMIN_PERMISSION_IDS.adminTenantsWrite]: freezeContract({
    id: ADMIN_PERMISSION_IDS.adminTenantsWrite,
    label: "Register, suspend and activate workspaces and manage their members",
    resource: "admin.tenants",
    risk: "controlled_write",
  }),
  // Tenant erase and export (routes/admin-tenant-lifecycle.js): they read or
  // remove one tenant's whole archive, so only admin.owner holds them.
  [ADMIN_PERMISSION_IDS.adminTenantsErase]: freezeContract({
    id: ADMIN_PERMISSION_IDS.adminTenantsErase,
    label: "Erase a tenant's data",
    resource: "admin.tenants",
    risk: "irreversible_delete",
  }),
  [ADMIN_PERMISSION_IDS.adminTenantsExport]: freezeContract({
    id: ADMIN_PERMISSION_IDS.adminTenantsExport,
    label: "Export a tenant's data",
    resource: "admin.tenants",
    risk: "read_all_tenant_data",
  }),
  // GET /admin/usage (routes/admin-usage.js): per-tenant usage totals, every
  // tenant's for a platform admin, its own workspace's for one scoped to a
  // workspace.
  [ADMIN_PERMISSION_IDS.adminUsageRead]: freezeContract({
    id: ADMIN_PERMISSION_IDS.adminUsageRead,
    label: "Read tenant usage",
    resource: "admin.usage",
    risk: "read",
  }),
  [ADMIN_PERMISSION_IDS.agentRunsRecoveryAction]: freezeContract({
    id: ADMIN_PERMISSION_IDS.agentRunsRecoveryAction,
    label: "Run agent recovery action",
    resource: "agent_runs.recovery",
    risk: "controlled_replay",
  }),
  [ADMIN_PERMISSION_IDS.agentTasksAction]: freezeContract({
    id: ADMIN_PERMISSION_IDS.agentTasksAction,
    label: "Run agent task action",
    resource: "agent_tasks",
    risk: "controlled_write",
  }),
});

const permissionIds = Object.freeze(Object.values(ADMIN_PERMISSION_IDS));

// The tenant registry permissions (routes/admin-tenants.js) decide which
// workspaces exist, who belongs to them and with which roles, so they are
// held apart: only admin.owner and admin.tenant_manager carry them, and
// admin.operator, which had every admin permission before they existed, keeps
// exactly the ones it had.
const TENANT_REGISTRY_PERMISSION_IDS = Object.freeze([
  ADMIN_PERMISSION_IDS.adminTenantsRead,
  ADMIN_PERMISSION_IDS.adminTenantsWrite,
]);

// The permissions only admin.owner holds; admin.operator has every other one.
export const OWNER_ONLY_ADMIN_PERMISSION_IDS = Object.freeze([
  ADMIN_PERMISSION_IDS.adminTenantsErase,
  ADMIN_PERMISSION_IDS.adminTenantsExport,
]);
const operatorPermissionIds = Object.freeze(
  permissionIds.filter(
    (id) =>
      !TENANT_REGISTRY_PERMISSION_IDS.includes(id) &&
      !OWNER_ONLY_ADMIN_PERMISSION_IDS.includes(id)
  )
);

export const ADMIN_ACTION_PERMISSION_IDS = Object.freeze({
  [ADMIN_ACTION_IDS.qualityRefresh]:
    ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
  [ADMIN_ACTION_IDS.recoverTasks]: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
  [ADMIN_ACTION_IDS.recoveryScan]: ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
});

export const ADMIN_ROLE_CONTRACTS = Object.freeze({
  [ADMIN_ROLE_IDS.viewer]: freezeContract({
    id: ADMIN_ROLE_IDS.viewer,
    label: "Admin viewer",
    permissionIds: [
      ADMIN_PERMISSION_IDS.adminStatusRead,
      ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
      ADMIN_PERMISSION_IDS.adminUsageRead,
    ],
  }),
  [ADMIN_ROLE_IDS.qualityOperator]: freezeContract({
    id: ADMIN_ROLE_IDS.qualityOperator,
    label: "Quality operator",
    permissionIds: [
      ADMIN_PERMISSION_IDS.adminStatusRead,
      ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
      ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
    ],
  }),
  [ADMIN_ROLE_IDS.recoveryOperator]: freezeContract({
    id: ADMIN_ROLE_IDS.recoveryOperator,
    label: "Recovery operator",
    permissionIds: [
      ADMIN_PERMISSION_IDS.adminStatusRead,
      ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
      ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
      ADMIN_PERMISSION_IDS.agentRunsRecoveryAction,
      ADMIN_PERMISSION_IDS.agentTasksAction,
    ],
  }),
  [ADMIN_ROLE_IDS.tenantManager]: freezeContract({
    id: ADMIN_ROLE_IDS.tenantManager,
    label: "Tenant manager",
    permissionIds: TENANT_REGISTRY_PERMISSION_IDS,
  }),
  [ADMIN_ROLE_IDS.operator]: freezeContract({
    id: ADMIN_ROLE_IDS.operator,
    label: "Admin operator",
    permissionIds: operatorPermissionIds,
  }),
  [ADMIN_ROLE_IDS.owner]: freezeContract({
    id: ADMIN_ROLE_IDS.owner,
    label: "Admin owner",
    permissionIds: permissionIds,
  }),
});

const permissionSet = Object.freeze(new Set(permissionIds));

export const listAdminPermissionContracts = () =>
  Object.values(ADMIN_PERMISSION_CONTRACTS).map(cloneContract);

export const getAdminPermissionContract = (permissionId) =>
  cloneContract(
    ADMIN_PERMISSION_CONTRACTS[normalizeScopeId(permissionId)] ?? null
  );

export const listAdminRoleContracts = () =>
  Object.values(ADMIN_ROLE_CONTRACTS).map(cloneContract);

export const getAdminRoleContract = (roleId) =>
  cloneContract(ADMIN_ROLE_CONTRACTS[normalizeScopeId(roleId)] ?? null);

export const getPermissionForAdminAction = (actionId) =>
  ADMIN_ACTION_PERMISSION_IDS[normalizeScopeId(actionId)] ?? null;

// Neither of these two is required by any route, on purpose. The routes they
// name (routes/tasks.js) act only on the caller's own runs and tasks:
//   GET  /agent-runs/recovery
//   POST /agent-runs/:runId/recovery/actions/:action
//   POST /tasks/:taskId/actions/:action
// The run and task stores look a record up by its exact (user, workspace)
// pair, so another tenant's id is a 404
// (test/tenant-isolation-route-sweep.test.mjs). They are self-service and RBAC
// gates them with tasks.run. The operator actions that do cross tenants
// (recover-tasks, recovery-scan) go through POST /admin/actions/:action, which
// requires their admin.actions.* permission. Requiring an admin permission on
// the self-service routes would take recovery of a member's own stuck run away
// from the member without protecting any other tenant. The two stay in the
// catalog and in the recovery operator role so existing role grants keep
// their meaning; enforce them only on a route that acts beyond the caller's
// scope.
export const getPermissionForAgentRunRecoveryAction = () =>
  ADMIN_PERMISSION_IDS.agentRunsRecoveryAction;

export const getPermissionForAgentTaskAction = () =>
  ADMIN_PERMISSION_IDS.agentTasksAction;

const normalizePrincipalRoles = (principal = {}) =>
  normalizeAccessPrincipalRoles(principal);

const normalizePrincipalPermissions = (principal = {}) =>
  normalizeAccessPrincipalPermissions(principal);

export const normalizeAdminPrincipal = (principal = {}) => {
  const normalizedPrincipal = normalizeRecord(principal);

  return {
    authenticated: normalizedPrincipal.authenticated === true,
    permissionIds: normalizePrincipalPermissions(normalizedPrincipal),
    roleIds: normalizePrincipalRoles(normalizedPrincipal),
    userId: normalizeScopeText(
      normalizedPrincipal.userId ?? normalizedPrincipal.user_id
    ),
    workspaceId: normalizeScopeText(
      normalizedPrincipal.workspaceId ?? normalizedPrincipal.workspace_id
    ),
  };
};

const getPermissionSource = ({ permissionId, principal }) => {
  if (principal.permissionIds.includes(permissionId)) {
    return {
      reason: ADMIN_PERMISSION_REASONS.allowedByPermission,
      roleId: "",
    };
  }

  for (const roleId of principal.roleIds) {
    const role = ADMIN_ROLE_CONTRACTS[roleId];

    if (role?.permissionIds.includes(permissionId)) {
      return {
        reason: ADMIN_PERMISSION_REASONS.allowedByRole,
        roleId,
      };
    }
  }

  return null;
};

export const buildAdminAccessDecision = ({
  permissionId,
  principal = {},
  requireAuthenticated = true,
} = {}) => {
  const normalizedPermissionId = normalizeScopeId(permissionId);
  const normalizedPrincipal = normalizeAdminPrincipal(principal);

  if (!permissionSet.has(normalizedPermissionId)) {
    return {
      allowed: false,
      permissionId: normalizedPermissionId,
      reason: ADMIN_PERMISSION_REASONS.unknownPermission,
      roleId: "",
      roleIds: normalizedPrincipal.roleIds,
    };
  }

  if (requireAuthenticated && !normalizedPrincipal.authenticated) {
    return {
      allowed: false,
      permissionId: normalizedPermissionId,
      reason: ADMIN_PERMISSION_REASONS.deniedUnauthenticated,
      roleId: "",
      roleIds: normalizedPrincipal.roleIds,
    };
  }

  const permissionSource = getPermissionSource({
    permissionId: normalizedPermissionId,
    principal: normalizedPrincipal,
  });

  if (permissionSource) {
    return {
      allowed: true,
      permissionId: normalizedPermissionId,
      reason: permissionSource.reason,
      roleId: permissionSource.roleId,
      roleIds: normalizedPrincipal.roleIds,
    };
  }

  return {
    allowed: false,
    permissionId: normalizedPermissionId,
    reason: ADMIN_PERMISSION_REASONS.deniedMissingPermission,
    roleId: "",
    roleIds: normalizedPrincipal.roleIds,
  };
};
