import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_AUDIT_EVENT_TYPES,
  ADMIN_AUDIT_RESULTS,
  compactAdminAuditEvent,
  createAdminAuditService,
} from "../rag/admin-audit.js";
import {
  ADMIN_PERMISSION_IDS,
  ADMIN_PERMISSION_REASONS,
  ADMIN_ROLE_IDS,
} from "../rag/admin-permissions.js";

test("admin audit compacts authorization decisions without secrets", () => {
  const event = compactAdminAuditEvent({
    accessScope: {
      apiKey: "sk-secret-admin",
      authenticated: true,
      roleIds: [ADMIN_ROLE_IDS.viewer],
      token: "sk-secret-token",
      userId: " alice ",
      workspaceId: " workspace-a ",
    },
    authorization: {
      actionId: " recover-tasks ",
      allowed: false,
      permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
      reason: ADMIN_PERMISSION_REASONS.deniedMissingPermission,
      roleId: "",
    },
    createdAt: "2026-07-03T00:00:00.000Z",
    eventId: "audit-1",
    request: {
      method: "post",
      path: "/admin/actions/recover-tasks",
      route: "/admin/actions/:action",
    },
  });
  const serialized = JSON.stringify(event);

  assert.deepEqual(event, {
    authorization: {
      actionId: "recover-tasks",
      allowed: false,
      permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
      reason: ADMIN_PERMISSION_REASONS.deniedMissingPermission,
      roleId: "",
    },
    createdAt: "2026-07-03T00:00:00.000Z",
    eventId: "audit-1",
    principal: {
      authenticated: true,
      permissionIds: [],
      roleIds: [ADMIN_ROLE_IDS.viewer],
      userId: "alice",
      workspaceId: "workspace-a",
    },
    request: {
      method: "POST",
      path: "/admin/actions/recover-tasks",
      route: "/admin/actions/:action",
    },
    result: ADMIN_AUDIT_RESULTS.denied,
    type: ADMIN_AUDIT_EVENT_TYPES.authorizationDecision,
  });
  assert.doesNotMatch(serialized, /sk-secret/);
});

test("admin audit service records bounded newest-first authorization events", () => {
  let eventIdIndex = 0;
  let timeIndex = 0;
  const service = createAdminAuditService({
    createEventId: () => `audit-${++eventIdIndex}`,
    maxEvents: 2,
    now: () => `2026-07-03T00:00:0${timeIndex++}.000Z`,
  });

  service.recordAuthorizationDecision({
    accessScope: {
      authenticated: true,
      roles: [ADMIN_ROLE_IDS.viewer],
      userId: "alice",
      workspaceId: "workspace-a",
    },
    decision: {
      allowed: true,
      permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
      reason: ADMIN_PERMISSION_REASONS.allowedByRole,
      roleId: ADMIN_ROLE_IDS.viewer,
    },
    request: {
      method: "GET",
      path: "/admin/status",
      route: "/admin/status",
    },
  });
  service.recordAuthorizationDecision({
    decision: {
      allowed: false,
      permissionId: ADMIN_PERMISSION_IDS.adminAuditRead,
      reason: ADMIN_PERMISSION_REASONS.deniedMissingPermission,
      roleId: "",
    },
    request: {
      method: "GET",
      path: "/admin/audit",
      route: "/admin/audit",
    },
  });
  service.recordAuthorizationDecision({
    actionId: "quality-refresh",
    decision: {
      allowed: true,
      permissionId: ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
      reason: ADMIN_PERMISSION_REASONS.allowedByPermission,
      roleId: "",
    },
    request: {
      method: "POST",
      path: "/admin/actions/quality-refresh",
      route: "/admin/actions/:action",
    },
  });

  const listed = service.listEvents({
    limit: 10,
  });

  assert.equal(listed.status, "ok");
  assert.equal(listed.total, 2);
  assert.equal(listed.limit, 2);
  assert.deepEqual(
    listed.events.map((event) => event.eventId),
    ["audit-3", "audit-2"]
  );
  assert.deepEqual(
    listed.events.map((event) => event.authorization.permissionId),
    [
      ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
      ADMIN_PERMISSION_IDS.adminAuditRead,
    ]
  );
});
