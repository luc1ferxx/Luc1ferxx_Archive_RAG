import { once } from "node:events";
import { Router } from "express";

import { getRequestAccessScope } from "../auth.js";
import { DATA_ACCESS_ACTION_IDS } from "../rag/admin-audit.js";
import { requireAdminPermission } from "../rag/admin-authorization.js";
import { ADMIN_PERMISSION_IDS } from "../rag/admin-permissions.js";
import { isApiAuthEnabled } from "../rag/config.js";
import { createDataAccessAudit } from "../rag/data-access-audit.js";
import { normalizeTenantSelector, TENANT_SELECTOR_ERROR_CODE } from "../rag/tenant-records.js";

import { setTenantDataCacheHeaders } from "./helpers.js";

export const TENANT_LIFECYCLE_ROUTE_CODES = Object.freeze({
  invalidRequest: "TENANT_LIFECYCLE_INVALID_REQUEST",
  platformOnly: "TENANT_LIFECYCLE_PLATFORM_ONLY",
  requiresAuth: "TENANT_LIFECYCLE_REQUIRES_AUTH",
});

// With API auth off there is no admin: every caller would be allowed
// (admin-authorization.js answers api_auth_disabled), so a tenant's whole
// archive would be one unauthenticated request away from deletion or
// download. npm run tenant:erase / tenant:export serve that setup.
const requireApiAuthForTenantLifecycle = (req, res, next) => {
  if (isApiAuthEnabled()) {
    next();
    return;
  }

  res.status(403).json({
    code: TENANT_LIFECYCLE_ROUTE_CODES.requiresAuth,
    error: "Tenant erase and export need API auth; use npm run tenant:erase or tenant:export.",
  });
};

// A platform admin acts for no workspace: its scope names none and it has no
// workspace list (the same rule as GET /admin/audit's cross-tenant read). A
// workspace-bound principal, even one holding the permission, may not erase
// or export its own or another workspace here.
const requirePlatformPrincipal = (req, res, next) => {
  const accessScope = getRequestAccessScope(req);
  const platform =
    !String(accessScope.workspaceId ?? "").trim() &&
    !(accessScope.allowedWorkspaceIds?.length > 0);

  if (platform) {
    next();
    return;
  }

  res.status(403).json({
    code: TENANT_LIFECYCLE_ROUTE_CODES.platformOnly,
    error: "Only a platform admin (no workspace scope) may erase or export a tenant.",
  });
};

const getAuditRequest = (req) => ({
  method: req.method,
  path: req.path,
  route: req.route?.path,
});

const readOptionalString = (value, name) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    const error = new Error(`${name} must be a string.`);

    error.code = TENANT_SELECTOR_ERROR_CODE;
    throw error;
  }

  return value;
};

const sendSelectorError = (res, error) =>
  res.status(400).json({
    code: error.code,
    error: error.message,
  });

/**
 * POST /admin/tenants/erase { workspaceId, userId?, dryRun?, force? } and
 * GET /admin/tenants/export?workspaceId=&userId= (rag/tenant-lifecycle.js).
 * Both need API auth, their admin permission (admin.tenants.erase /
 * admin.tenants.export, held by admin.owner only; the decision is audited)
 * and a platform principal. In these two routes `workspaceId` and `userId`
 * name the target tenant, never the caller (auth.js TENANT_TARGET_PATHS).
 *
 * The erase is a dry run unless the body says `dryRun: false`. It answers 200
 * with the per-store report (also for a partial erase, `complete: false`),
 * 409 TENANT_ERASE_ACTIVE_WORK while the tenant has work in flight and
 * `force` is not true, 500 with the report when a store failed, 400
 * TENANT_SELECTOR_INVALID for a selector naming neither workspace nor user or
 * a userId that is given but empty (only a missing userId means every user of
 * the workspace; the export answers the same), and, with
 * ADMIN_AUDIT_DATA_EVENTS on, 503 AUDIT_UNAVAILABLE (nothing erased) when the
 * applied erase's data-access intent (tenant.erase) cannot be recorded.
 *
 * The export streams application/x-ndjson as an attachment; a failure after
 * the first line can only end the stream with an error line.
 */
export const createAdminTenantLifecycleRouter = (services) => {
  const router = Router();
  const { adminAuditService, tenantLifecycleService } = services;
  const dataAudit = createDataAccessAudit({ auditService: adminAuditService });

  router.post(
    "/admin/tenants/erase",
    requireApiAuthForTenantLifecycle,
    requireAdminPermission(ADMIN_PERMISSION_IDS.adminTenantsErase, {
      auditService: adminAuditService,
    }),
    requirePlatformPrincipal,
    async (req, res) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};

      for (const flag of ["dryRun", "force"]) {
        if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
          return res.status(400).json({
            code: TENANT_LIFECYCLE_ROUTE_CODES.invalidRequest,
            error: `${flag} must be a boolean.`,
          });
        }
      }

      let selector;

      try {
        selector = normalizeTenantSelector({
          userId: readOptionalString(body.userId, "userId"),
          workspaceId: readOptionalString(body.workspaceId, "workspaceId") ?? "",
        });
      } catch (error) {
        if (error?.code === TENANT_SELECTOR_ERROR_CODE) {
          return sendSelectorError(res, error);
        }

        console.error("[tenant-lifecycle] erase failed.", error);
        return res.status(500).json({ error: "Failed to erase the tenant." });
      }

      const accessScope = getRequestAccessScope(req);
      const dryRun = body.dryRun !== false;
      // ADMIN_AUDIT_DATA_EVENTS (rag/data-access-audit.js): an applied erase is
      // destructive, so its intent is recorded first and the erase does not
      // run (503 AUDIT_UNAVAILABLE) when that record cannot be written; its
      // outcome follows with the deleted count. A dry run deletes nothing and
      // records no data event (its authorization decision is audited above).
      // The target is the erased tenant, never the caller.
      const audited = {
        accessScope,
        actionId: DATA_ACCESS_ACTION_IDS.tenantErase,
        target: { userId: selector.userId ?? "", workspaceId: selector.workspaceId },
      };

      if (!dryRun && !(await dataAudit.recordIntent(req, res, audited))) {
        return undefined;
      }

      try {
        const result = await tenantLifecycleService.eraseTenant({
          actor: accessScope,
          dryRun,
          force: body.force === true,
          permissionId: ADMIN_PERMISSION_IDS.adminTenantsErase,
          request: getAuditRequest(req),
          userId: selector.userId,
          workspaceId: selector.workspaceId,
        });
        const status =
          result.status === "refused" ? 409 : result.status === "failed" ? 500 : 200;

        if (!dryRun) {
          await dataAudit.recordOutcome(req, {
            ...audited,
            count: Object.values(result.totals?.deleted ?? {}).reduce(
              (total, count) => total + (Number(count) || 0),
              0
            ),
            status,
          });
        }

        return res.status(status).json(result);
      } catch (error) {
        if (!dryRun) {
          await dataAudit.recordOutcome(req, { ...audited, status: error?.status ?? 500 });
        }

        if (error?.code === TENANT_SELECTOR_ERROR_CODE) {
          return sendSelectorError(res, error);
        }

        console.error("[tenant-lifecycle] erase failed.", error);
        return res.status(500).json({ error: "Failed to erase the tenant." });
      }
    }
  );

  router.get(
    "/admin/tenants/export",
    requireApiAuthForTenantLifecycle,
    requireAdminPermission(ADMIN_PERMISSION_IDS.adminTenantsExport, {
      auditService: adminAuditService,
    }),
    requirePlatformPrincipal,
    async (req, res) => {
      let lines;

      try {
        lines = tenantLifecycleService.exportTenant({
          actor: getRequestAccessScope(req),
          permissionId: ADMIN_PERMISSION_IDS.adminTenantsExport,
          request: getAuditRequest(req),
          userId: readOptionalString(req.query?.userId, "userId"),
          workspaceId: readOptionalString(req.query?.workspaceId, "workspaceId") ?? "",
        });
      } catch (error) {
        if (error?.code === TENANT_SELECTOR_ERROR_CODE) {
          return sendSelectorError(res, error);
        }

        console.error("[tenant-lifecycle] export failed.", error);
        return res.status(500).json({ error: "Failed to export the tenant." });
      }

      let clientGone = false;

      res.on("close", () => {
        clientGone = !res.writableFinished;
      });

      try {
        let started = false;

        for await (const line of lines) {
          if (clientGone) {
            break;
          }

          if (!started) {
            started = true;
            res.status(200);
            res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
            res.setHeader("Content-Disposition", 'attachment; filename="tenant-export.jsonl"');
            setTenantDataCacheHeaders(res);
          }

          if (!res.write(`${line}\n`)) {
            await Promise.race([once(res, "drain"), once(res, "close")]);
          }
        }

        return res.end();
      } catch (error) {
        console.error("[tenant-lifecycle] export failed.", error);

        if (!res.headersSent) {
          return res.status(500).json({ error: "Failed to export the tenant." });
        }

        return res.end();
      }
    }
  );

  return router;
};
