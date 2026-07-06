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

test("admin audit service records bounded newest-first authorization events", async () => {
  let eventIdIndex = 0;
  let timeIndex = 0;
  const service = createAdminAuditService({
    createEventId: () => `audit-${++eventIdIndex}`,
    maxEvents: 2,
    now: () => `2026-07-03T00:00:0${timeIndex++}.000Z`,
  });

  await service.recordAuthorizationDecision({
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
  await service.recordAuthorizationDecision({
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
  await service.recordAuthorizationDecision({
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

  const listed = await service.listEvents({
    limit: 10,
  });

  assert.equal(listed.status, "ok");
  assert.equal(listed.total, 2);
  assert.equal(listed.limit, 2);
  assert.equal(listed.offset, 0);
  assert.equal(listed.nextOffset, null);
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

test("admin audit service filters and paginates compact authorization events", async () => {
  let eventIdIndex = 0;
  let timeIndex = 0;
  const service = createAdminAuditService({
    createEventId: () => `audit-${++eventIdIndex}`,
    maxEvents: 10,
    now: () => `2026-07-03T00:00:0${timeIndex++}.000Z`,
  });

  await service.recordAuthorizationDecision({
    accessScope: {
      authenticated: true,
      roleIds: [ADMIN_ROLE_IDS.operator],
      userId: "operator",
      workspaceId: "workspace-a",
    },
    actionId: "quality-refresh",
    decision: {
      allowed: true,
      permissionId: ADMIN_PERMISSION_IDS.adminActionQualityRefresh,
      reason: ADMIN_PERMISSION_REASONS.allowedByRole,
      roleId: ADMIN_ROLE_IDS.operator,
    },
    request: {
      method: "POST",
      path: "/admin/actions/quality-refresh",
      route: "/admin/actions/:action",
    },
  });
  await service.recordAuthorizationDecision({
    accessScope: {
      authenticated: true,
      roleIds: [ADMIN_ROLE_IDS.viewer],
      userId: "viewer",
      workspaceId: "workspace-a",
    },
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
  await service.recordAuthorizationDecision({
    accessScope: {
      authenticated: true,
      roleIds: [ADMIN_ROLE_IDS.operator],
      userId: "operator",
      workspaceId: "workspace-b",
    },
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

  const deniedInScope = await service.listEvents({
    accessScope: {
      workspaceId: "workspace-a",
    },
    filters: {
      result: ADMIN_AUDIT_RESULTS.denied,
    },
    limit: 1,
  });

  assert.equal(deniedInScope.total, 1);
  assert.equal(deniedInScope.events.length, 1);
  assert.equal(deniedInScope.events[0].principal.userId, "viewer");
  assert.equal(deniedInScope.nextOffset, null);

  const paged = await service.listEvents({
    accessScope: {
      workspaceId: "workspace-a",
    },
    limit: 1,
    offset: 1,
  });

  assert.equal(paged.total, 2);
  assert.equal(paged.offset, 1);
  assert.equal(paged.events.length, 1);
  assert.equal(paged.events[0].authorization.actionId, "quality-refresh");

  const mismatchedScope = await service.listEvents({
    accessScope: {
      workspaceId: "workspace-a",
    },
    filters: {
      workspaceId: "workspace-b",
    },
  });

  assert.equal(mismatchedScope.total, 0);
  assert.deepEqual(mismatchedScope.events, []);
});
