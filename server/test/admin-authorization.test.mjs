import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_AUTHORIZATION_REASONS,
  buildAdminAuthorizationDecision,
  getAdminActionPermissionForRequest,
  getAdminAuditReadPermission,
  getAdminStatusReadPermission,
  requireAdminPermission,
} from "../rag/admin-authorization.js";
import { ADMIN_ACTION_IDS } from "../rag/admin-actions.js";
import {
  ADMIN_PERMISSION_IDS,
  ADMIN_PERMISSION_REASONS,
  ADMIN_ROLE_IDS,
} from "../rag/admin-permissions.js";

test("admin authorization decisions bypass only when API auth is disabled", () => {
  assert.deepEqual(
    buildAdminAuthorizationDecision({
      accessScope: {},
      apiAuthEnabled: false,
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
    }),
    {
      allowed: true,
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      reason: ADMIN_AUTHORIZATION_REASONS.apiAuthDisabled,
      roleId: "",
    }
  );

  assert.deepEqual(
    buildAdminAuthorizationDecision({
      accessScope: {
        authenticated: true,
        roleIds: [ADMIN_ROLE_IDS.viewer],
      },
      apiAuthEnabled: true,
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
    }),
    {
      allowed: true,
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      reason: ADMIN_PERMISSION_REASONS.allowedByRole,
      roleId: ADMIN_ROLE_IDS.viewer,
    }
  );
});

test("admin authorization decisions require least-privilege permissions", () => {
  assert.deepEqual(
    buildAdminAuthorizationDecision({
      accessScope: {
        authenticated: true,
        roleIds: [ADMIN_ROLE_IDS.viewer],
      },
      apiAuthEnabled: true,
      permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
    }),
    {
      allowed: false,
      permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
      reason: ADMIN_PERMISSION_REASONS.deniedMissingPermission,
      roleId: "",
    }
  );

  assert.deepEqual(
    buildAdminAuthorizationDecision({
      accessScope: {
        authenticated: true,
        permissionIds: [ADMIN_PERMISSION_IDS.adminActionRecoverTasks],
      },
      apiAuthEnabled: true,
      permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
    }),
    {
      allowed: true,
      permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
      reason: ADMIN_PERMISSION_REASONS.allowedByPermission,
      roleId: "",
    }
  );
});

test("admin authorization middleware returns compact forbidden responses", async () => {
  const req = {
    accessScope: {
      apiKey: "sk-secret-admin",
      authenticated: true,
      roleIds: [ADMIN_ROLE_IDS.viewer],
      token: "sk-secret-token",
    },
  };
  let statusCode = 200;
  let jsonPayload = null;
  let nextCalled = false;
  const res = {
    json: (payload) => {
      jsonPayload = payload;
      return res;
    },
    status: (code) => {
      statusCode = code;
      return res;
    },
  };

  await requireAdminPermission(ADMIN_PERMISSION_IDS.adminActionRecoverTasks, {
    isAuthEnabled: () => true,
  })(req, res, () => {
    nextCalled = true;
  });

  const serialized = JSON.stringify(jsonPayload);

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.deepEqual(jsonPayload, {
    adminAuthorization: {
      permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
      reason: ADMIN_PERMISSION_REASONS.deniedMissingPermission,
    },
    error: "Forbidden.",
  });
  assert.doesNotMatch(serialized, /sk-secret/);
});

test("admin authorization middleware records decisions through optional audit service", async () => {
  const recordedEvents = [];
  const req = {
    accessScope: {
      authenticated: true,
      roleIds: [ADMIN_ROLE_IDS.operator],
      userId: "operator",
      workspaceId: "workspace-a",
    },
    method: "POST",
    params: {
      action: ADMIN_ACTION_IDS.recoverTasks,
    },
    path: `/admin/actions/${ADMIN_ACTION_IDS.recoverTasks}`,
    route: {
      path: "/admin/actions/:action",
    },
  };
  const res = {
    json: () => res,
    status: () => res,
  };
  let nextCalled = false;

  await requireAdminPermission(ADMIN_PERMISSION_IDS.adminActionRecoverTasks, {
    auditService: {
      recordAuthorizationDecision: async (event) => {
        recordedEvents.push(event);
      },
    },
    isAuthEnabled: () => true,
  })(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(recordedEvents, [
    {
      accessScope: req.accessScope,
      actionId: ADMIN_ACTION_IDS.recoverTasks,
      decision: {
        allowed: true,
        permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
        reason: ADMIN_PERMISSION_REASONS.allowedByRole,
        roleId: ADMIN_ROLE_IDS.operator,
      },
      request: {
        method: "POST",
        path: `/admin/actions/${ADMIN_ACTION_IDS.recoverTasks}`,
        route: "/admin/actions/:action",
      },
    },
  ]);
});

test("admin authorization middleware does not fail when audit sink is unavailable", async () => {
  const req = {
    accessScope: {
      authenticated: true,
      roleIds: [ADMIN_ROLE_IDS.viewer],
    },
    method: "GET",
    params: {},
    path: "/admin/status",
    route: {
      path: "/admin/status",
    },
  };
  const res = {
    json: () => res,
    status: () => res,
  };
  let nextCalled = false;

  await requireAdminPermission(ADMIN_PERMISSION_IDS.adminStatusRead, {
    auditService: {
      recordAuthorizationDecision: async () => {
        throw new Error("audit unavailable");
      },
    },
    isAuthEnabled: () => true,
  })(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test("admin action permission resolver preserves unknown action routing", () => {
  assert.equal(getAdminAuditReadPermission(), ADMIN_PERMISSION_IDS.adminAuditRead);
  assert.equal(getAdminStatusReadPermission(), ADMIN_PERMISSION_IDS.adminStatusRead);
  assert.equal(
    getAdminActionPermissionForRequest({
      params: {
        action: ADMIN_ACTION_IDS.qualityRefresh,
      },
    }),
    ADMIN_PERMISSION_IDS.adminActionQualityRefresh
  );
  assert.equal(
    getAdminActionPermissionForRequest({
      params: {
        action: "unknown-action",
      },
    }),
    null
  );
});
