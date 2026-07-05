import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_ACTION_PERMISSION_IDS,
  ADMIN_PERMISSION_IDS,
  ADMIN_PERMISSION_REASONS,
  ADMIN_ROLE_IDS,
  buildAdminAccessDecision,
  getAdminPermissionContract,
  getAdminRoleContract,
  getPermissionForAdminAction,
  getPermissionForAgentRunRecoveryAction,
  getPermissionForAgentTaskAction,
  listAdminPermissionContracts,
  listAdminRoleContracts,
  normalizeAdminPrincipal,
} from "../rag/admin-permissions.js";
import { ADMIN_ACTION_IDS } from "../rag/admin-actions.js";

test("admin permissions define the required RBAC contract surface", () => {
  assert.deepEqual(ADMIN_ACTION_PERMISSION_IDS, {
    [ADMIN_ACTION_IDS.qualityRefresh]:
      ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
    [ADMIN_ACTION_IDS.recoverTasks]:
      ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
    [ADMIN_ACTION_IDS.recoveryScan]:
      ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
  });
  assert.equal(
    getPermissionForAdminAction(ADMIN_ACTION_IDS.recoverTasks),
    ADMIN_PERMISSION_IDS.adminActionRecoverTasks
  );
  assert.equal(
    getPermissionForAdminAction("QUALITY-REFRESH"),
    ADMIN_PERMISSION_IDS.adminActionQualityRefresh
  );
  assert.equal(getPermissionForAdminAction("unknown-action"), null);
  assert.equal(
    getPermissionForAgentRunRecoveryAction("resume_from_step"),
    ADMIN_PERMISSION_IDS.agentRunsRecoveryAction
  );
  assert.equal(
    getPermissionForAgentTaskAction("approve_deliverables"),
    ADMIN_PERMISSION_IDS.agentTasksAction
  );

  const permissionIds = listAdminPermissionContracts().map(
    (permission) => permission.id
  );

  assert.deepEqual(permissionIds.sort(), [
    ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
    ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
    ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
    ADMIN_PERMISSION_IDS.adminAuditRead,
    ADMIN_PERMISSION_IDS.adminStatusRead,
    ADMIN_PERMISSION_IDS.agentRunsRecoveryAction,
    ADMIN_PERMISSION_IDS.agentTasksAction,
  ].sort());
});

test("admin role matrix grants least-privilege defaults", () => {
  const viewer = getAdminRoleContract(ADMIN_ROLE_IDS.viewer);
  const qualityOperator = getAdminRoleContract(ADMIN_ROLE_IDS.qualityOperator);
  const recoveryOperator = getAdminRoleContract(ADMIN_ROLE_IDS.recoveryOperator);
  const operator = getAdminRoleContract(ADMIN_ROLE_IDS.operator);
  const owner = getAdminRoleContract(ADMIN_ROLE_IDS.owner);
  const allPermissionIds = listAdminPermissionContracts().map(
    (permission) => permission.id
  );

  assert.deepEqual(viewer.permissionIds, [
    ADMIN_PERMISSION_IDS.adminStatusRead,
    ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
  ]);
  assert.equal(
    viewer.permissionIds.includes(ADMIN_PERMISSION_IDS.adminAuditRead),
    false
  );
  assert.equal(
    qualityOperator.permissionIds.includes(
      ADMIN_PERMISSION_IDS.adminActionQualityRefresh
    ),
    true
  );
  assert.equal(
    qualityOperator.permissionIds.includes(
      ADMIN_PERMISSION_IDS.adminActionRecoverTasks
    ),
    false
  );
  assert.equal(
    qualityOperator.permissionIds.includes(ADMIN_PERMISSION_IDS.adminAuditRead),
    false
  );
  assert.equal(
    recoveryOperator.permissionIds.includes(
      ADMIN_PERMISSION_IDS.adminActionRecoverTasks
    ),
    true
  );
  assert.equal(
    recoveryOperator.permissionIds.includes(
      ADMIN_PERMISSION_IDS.agentTasksAction
    ),
    true
  );
  assert.equal(
    recoveryOperator.permissionIds.includes(ADMIN_PERMISSION_IDS.adminAuditRead),
    false
  );
  assert.deepEqual(operator.permissionIds.sort(), allPermissionIds.sort());
  assert.deepEqual(owner.permissionIds.sort(), allPermissionIds.sort());

  for (const role of listAdminRoleContracts()) {
    for (const permissionId of role.permissionIds) {
      assert.notEqual(getAdminPermissionContract(permissionId), null);
    }
  }
});

test("admin access decisions use role and explicit permission grants", () => {
  assert.deepEqual(
    buildAdminAccessDecision({
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      principal: {
        authenticated: true,
        roles: [ADMIN_ROLE_IDS.viewer],
      },
    }),
    {
      allowed: true,
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      reason: ADMIN_PERMISSION_REASONS.allowedByRole,
      roleId: ADMIN_ROLE_IDS.viewer,
      roleIds: [ADMIN_ROLE_IDS.viewer],
    }
  );
  assert.equal(
    buildAdminAccessDecision({
      permissionId: ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
      principal: {
        authenticated: true,
        roles: [ADMIN_ROLE_IDS.viewer],
      },
    }).allowed,
    false
  );
  assert.deepEqual(
    buildAdminAccessDecision({
      permissionId: ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
      principal: {
        authenticated: true,
        permissions: [ADMIN_PERMISSION_IDS.adminActionQualityRefresh],
      },
    }),
    {
      allowed: true,
      permissionId: ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
      reason: ADMIN_PERMISSION_REASONS.allowedByPermission,
      roleId: "",
      roleIds: [],
    }
  );
});

test("admin access decisions deny unauthenticated and unknown permissions", () => {
  assert.deepEqual(
    buildAdminAccessDecision({
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      principal: {
        roles: [ADMIN_ROLE_IDS.owner],
      },
    }),
    {
      allowed: false,
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      reason: ADMIN_PERMISSION_REASONS.deniedUnauthenticated,
      roleId: "",
      roleIds: [ADMIN_ROLE_IDS.owner],
    }
  );
  assert.deepEqual(
    buildAdminAccessDecision({
      permissionId: "admin.unknown",
      principal: {
        authenticated: true,
        roles: [ADMIN_ROLE_IDS.owner],
      },
    }),
    {
      allowed: false,
      permissionId: "admin.unknown",
      reason: ADMIN_PERMISSION_REASONS.unknownPermission,
      roleId: "",
      roleIds: [ADMIN_ROLE_IDS.owner],
    }
  );
});

test("admin permission contracts do not expose mutable state or principal secrets", () => {
  const roles = listAdminRoleContracts();

  roles[0].permissionIds.push("mutated.permission");
  assert.equal(
    getAdminRoleContract(roles[0].id).permissionIds.includes(
      "mutated.permission"
    ),
    false
  );

  const normalizedPrincipal = normalizeAdminPrincipal({
    apiKey: "sk-secret-api-key",
    authenticated: true,
    permissions: `${ADMIN_PERMISSION_IDS.adminStatusRead}, ${ADMIN_PERMISSION_IDS.adminActionRecoveryScan}`,
    roles: `${ADMIN_ROLE_IDS.viewer}, ${ADMIN_ROLE_IDS.qualityOperator}`,
    token: "sk-secret-token",
    userId: " alice ",
    workspace_id: " workspace-a ",
  });
  const decision = buildAdminAccessDecision({
    permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
    principal: {
      ...normalizedPrincipal,
      token: "sk-secret-token",
    },
  });
  const serialized = JSON.stringify({
    decision,
    normalizedPrincipal,
  });

  assert.deepEqual(normalizedPrincipal, {
    authenticated: true,
    permissionIds: [
      ADMIN_PERMISSION_IDS.adminStatusRead,
      ADMIN_PERMISSION_IDS.adminActionRecoveryScan,
    ],
    roleIds: [ADMIN_ROLE_IDS.viewer, ADMIN_ROLE_IDS.qualityOperator],
    userId: "alice",
    workspaceId: "workspace-a",
  });
  assert.doesNotMatch(serialized, /sk-secret/);
});
