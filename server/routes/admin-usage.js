import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
import { ADMIN_PERMISSION_IDS } from "../rag/admin-permissions.js";
import { requireAdminPermission } from "../rag/admin-authorization.js";
import { getTenantUsageFlushMs, isTenantUsageLedgerEnabled } from "../rag/config.js";
import { isPostgresConfigured } from "../rag/postgres.js";
import { runAsDatabaseSystem } from "../rag/postgres-tenant.js";
import {
  listTenantUsageTop,
  TENANT_USAGE_GROUP_BY,
  TENANT_USAGE_MAX_TOP,
  TENANT_USAGE_METRICS,
} from "../rag/tenant-usage.js";

import { parseOrRespond } from "./validation.js";

// GET /admin/usage: the top tenants by one usage metric over a time range,
// from the usage ledger (migration 037, rag/tenant-usage.js).
//
//   metric   model_tokens (default), model_cost_micro_usd, chat_requests,
//            ingested_bytes, documents
//   from,to  ISO 8601 instants; default the 24 hours before now. Hours that
//            start at or after `from` (rounded down to its hour) and before
//            `to` count. At most USAGE_MAX_RANGE_DAYS apart.
//   limit    1..100, default 10
//   groupBy  tenant (default: one row per user and workspace pair) or
//            workspace (one row per workspace)
//
// Needs admin.usage.read (admin.viewer, admin.operator, admin.owner). Who sees
// what follows the caller's scope, as GET /admin/audit does:
//   - a platform admin (no workspace and no workspace list in its scope) sees
//     every tenant; naming a workspace (x-workspace-id or ?workspaceId, which
//     the auth layer resolves) narrows the view to it;
//   - an admin scoped to a workspace sees that workspace only;
//   - a credential limited to a workspace list that names none is refused
//     (403) until it names one.
// Both reads run as system work after the permission check, because a
// workspace's rows belong to several users and the tenant row policy shows a
// tenant only its own pair. Totals lag by up to TENANT_USAGE_FLUSH_MS: each
// process flushes its own on that interval.

const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;
export const USAGE_MAX_RANGE_DAYS = 400;

const instant = (field) =>
  z
    .string({ error: `${field} must be an ISO 8601 date-time.` })
    .trim()
    .refine((value) => Number.isFinite(Date.parse(value)), {
      error: `${field} must be an ISO 8601 date-time.`,
    })
    .optional();

const usageQuerySchema = z.object({
  from: instant("from"),
  groupBy: z
    .enum(Object.values(TENANT_USAGE_GROUP_BY), {
      error: "groupBy must be tenant or workspace.",
    })
    .optional(),
  limit: z.coerce
    .number({ error: `limit must be an integer from 1 to ${TENANT_USAGE_MAX_TOP}.` })
    .int({ error: `limit must be an integer from 1 to ${TENANT_USAGE_MAX_TOP}.` })
    .min(1, { error: `limit must be an integer from 1 to ${TENANT_USAGE_MAX_TOP}.` })
    .max(TENANT_USAGE_MAX_TOP, { error: `limit must be an integer from 1 to ${TENANT_USAGE_MAX_TOP}.` })
    .optional(),
  metric: z
    .enum(Object.values(TENANT_USAGE_METRICS), {
      error: `metric must be one of ${Object.values(TENANT_USAGE_METRICS).join(", ")}.`,
    })
    .optional(),
  to: instant("to"),
});

export const createAdminUsageRouter = (services = {}) => {
  const router = Router();
  // Test seam: an in-memory reader instead of the PostgreSQL table.
  const readUsage = services.listTenantUsageTop ?? listTenantUsageTop;
  const now = services.now ?? Date.now;

  router.get(
    "/admin/usage",
    requireAdminPermission(ADMIN_PERMISSION_IDS.adminUsageRead, {
      auditService: services.adminAuditService,
    }),
    async (req, res) => {
      const parsed = parseOrRespond(usageQuerySchema, req.query ?? {}, res);
      if (!parsed) return;

      const accessScope = getRequestAccessScope(req);
      const workspaceId = String(accessScope.workspaceId ?? "").trim();

      if (!workspaceId && accessScope.allowedWorkspaceIds?.length > 0) {
        return res.status(403).json({
          error:
            "This credential is limited to a list of workspaces: name the workspace to read (x-workspace-id).",
        });
      }

      if (!services.listTenantUsageTop && !isPostgresConfigured()) {
        return res.status(409).json({
          error: "Tenant usage is kept in PostgreSQL (migration 037); this deployment has no database.",
        });
      }

      const to = parsed.to ? new Date(parsed.to) : new Date(now());
      const from = parsed.from ? new Date(parsed.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);

      if (!(from.getTime() < to.getTime())) {
        return res.status(400).json({ error: "from must be before to." });
      }

      if (to.getTime() - from.getTime() > USAGE_MAX_RANGE_DAYS * DEFAULT_RANGE_MS) {
        return res.status(400).json({
          error: `from and to may be at most ${USAGE_MAX_RANGE_DAYS} days apart.`,
        });
      }

      const metric = parsed.metric ?? TENANT_USAGE_METRICS.modelTokens;
      const groupBy = parsed.groupBy ?? TENANT_USAGE_GROUP_BY.tenant;

      try {
        const result = await runAsDatabaseSystem(() =>
          readUsage({
            from,
            groupBy,
            limit: parsed.limit ?? 10,
            metric,
            to,
            workspaceId: workspaceId || null,
          })
        );

        return res.json({
          from: result.from,
          groupBy,
          ledger: {
            enabled: isTenantUsageLedgerEnabled(),
            flushIntervalMs: getTenantUsageFlushMs(),
          },
          metric,
          scope: workspaceId ? { kind: "workspace", workspaceId } : { kind: "platform" },
          tenants: result.rows,
          to: result.to,
        });
      } catch {
        return res.status(500).json({ error: "Failed to read tenant usage." });
      }
    }
  );

  return router;
};
