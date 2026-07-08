import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_AUDIT_RESULTS,
  createAdminAuditService,
} from "../rag/admin-audit.js";
import { ADMIN_PERMISSION_IDS, ADMIN_PERMISSION_REASONS, ADMIN_ROLE_IDS } from "../rag/admin-permissions.js";
import { createPostgresAdminAuditStore } from "../rag/postgres-admin-audit-store.js";

const parseJson = (value, fallback = null) =>
  value === null || value === undefined ? fallback : JSON.parse(value);

const createFakePostgresAuditHarness = () => {
  const rows = [];
  const retentionDeletes = [];
  let migrationRuns = 0;

  const applyFilters = (queryText, values = []) => {
    if (queryText.includes("WHERE FALSE")) {
      return [];
    }

    return rows.filter((row) => {
      let valueIndex = 0;

      if (queryText.includes("workspace_id = $")) {
        if (row.workspace_id !== values[valueIndex++]) {
          return false;
        }
      }

      if (queryText.includes("user_id = $")) {
        if (row.user_id !== values[valueIndex++]) {
          return false;
        }
      }

      if (queryText.includes("action_id = $")) {
        if (row.action_id !== values[valueIndex++]) {
          return false;
        }
      }

      if (queryText.includes("permission_id = $")) {
        if (row.permission_id !== values[valueIndex++]) {
          return false;
        }
      }

      if (queryText.includes("result = $")) {
        if (row.result !== values[valueIndex++]) {
          return false;
        }
      }

      if (queryText.includes("created_at >= $")) {
        if (new Date(row.created_at) < new Date(values[valueIndex++])) {
          return false;
        }
      }

      if (queryText.includes("created_at <= $")) {
        if (new Date(row.created_at) > new Date(values[valueIndex++])) {
          return false;
        }
      }

      return true;
    });
  };

  const query = async (queryText, values = []) => {
    if (queryText.includes("INSERT INTO rag_admin_audit_events_test")) {
      const row = {
        id: rows.length + 1,
        event_id: values[0],
        event_type: values[1],
        result: values[2],
        user_id: values[3],
        workspace_id: values[4],
        permission_id: values[5],
        action_id: values[6],
        method: values[7],
        path: values[8],
        route: values[9],
        authorization_decision: parseJson(values[10], {}),
        principal: parseJson(values[11], {}),
        request: parseJson(values[12], {}),
        created_at: values[13],
      };

      if (!rows.some((existing) => existing.event_id === row.event_id)) {
        rows.push(row);
      }

      return {
        rowCount: 1,
        rows: [],
      };
    }

    if (queryText.includes("DELETE FROM rag_admin_audit_events_test")) {
      retentionDeletes.push(values[0]);
      return {
        rowCount: 0,
        rows: [],
      };
    }

    if (queryText.includes("SELECT COUNT(*)::int AS total")) {
      return {
        rowCount: 1,
        rows: [
          {
            total: applyFilters(queryText, values).length,
          },
        ],
      };
    }

    if (queryText.includes("FROM rag_admin_audit_events_test")) {
      const limit = Number(values.at(-2));
      const offset = Number(values.at(-1));
      const filteredRows = applyFilters(queryText, values.slice(0, -2))
        .sort((left, right) => right.id - left.id)
        .slice(offset, offset + limit);

      return {
        rowCount: filteredRows.length,
        rows: filteredRows,
      };
    }

    throw new Error(`Unexpected query: ${queryText}`);
  };

  const createService = () =>
    createAdminAuditService({
      createEventId: () => `audit-${rows.length + 1}`,
      now: () => "2026-07-06T00:00:00.000Z",
      store: createPostgresAdminAuditStore({
        now: () => "2026-07-06T00:00:00.000Z",
        query,
        retentionDays: 30,
        runMigrations: async () => {
          migrationRuns += 1;
          return {
            appliedMigrations: [],
            status: "ok",
          };
        },
        tableName: "rag_admin_audit_events_test",
      }),
    });

  return {
    createService,
    get migrationRuns() {
      return migrationRuns;
    },
    retentionDeletes,
    rows,
  };
};

test("postgres admin audit store persists compact append-only authorization events", async () => {
  const harness = createFakePostgresAuditHarness();
  const service = harness.createService();

  await service.initialize();
  await service.initialize();
  assert.equal(harness.migrationRuns, 1);

  await service.recordAuthorizationDecision({
    accessScope: {
      apiKey: "sk-secret-api-key",
      authenticated: true,
      roleIds: [ADMIN_ROLE_IDS.operator],
      token: "sk-secret-token",
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

  const serializedRows = JSON.stringify(harness.rows);
  assert.equal(harness.rows.length, 3);
  assert.doesNotMatch(serializedRows, /sk-secret/);
  assert.equal(harness.retentionDeletes.length, 3);
  assert.match(harness.retentionDeletes[0], /^2026-06-06T00:00:00\.000Z$/);

  const deniedInScope = await service.listEvents({
    accessScope: {
      workspaceId: "workspace-a",
    },
    filters: {
      result: ADMIN_AUDIT_RESULTS.denied,
    },
    limit: 10,
  });

  assert.equal(deniedInScope.status, "ok");
  assert.equal(deniedInScope.total, 1);
  assert.equal(deniedInScope.events[0].principal.userId, "viewer");
  assert.equal(deniedInScope.events[0].result, ADMIN_AUDIT_RESULTS.denied);

  const actionFiltered = await service.listEvents({
    accessScope: {
      workspaceId: "workspace-a",
    },
    filters: {
      actionId: "quality-refresh",
    },
    limit: 1,
  });

  assert.equal(actionFiltered.total, 1);
  assert.equal(actionFiltered.events[0].authorization.actionId, "quality-refresh");
  assert.equal(actionFiltered.nextOffset, null);

  const firstPage = await service.listEvents({
    accessScope: {
      workspaceId: "workspace-a",
    },
    limit: 1,
  });

  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.nextOffset, 1);

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
