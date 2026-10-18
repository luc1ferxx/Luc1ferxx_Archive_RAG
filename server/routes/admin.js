import { Router } from "express";

import { getRequestAccessScope } from "../auth.js";
import { DATA_ACCESS_ACTION_IDS } from "../rag/admin-audit.js";
import { runAsDatabaseSystem } from "../rag/postgres-tenant.js";
import {
  getAdminActionPermissionForRequest,
  getAdminAuditReadPermission,
  getAdminStatusReadPermission,
  requireAdminPermission,
} from "../rag/admin-authorization.js";
import {
  createDataAccessAudit,
  isPlatformAdminReadScope,
} from "../rag/data-access-audit.js";

import { serializeError } from "./helpers.js";

/**
 * Runs one controlled admin action (POST /admin/actions/:action) once the
 * permission check has passed. The agent tier of a split deployment mounts it
 * behind the edge's authorization (rag/agent-service/app.js), because the
 * actions recover agent tasks and run model evaluations.
 */
export const createAdminActionHandler = ({ adminActionRegistry }) => async (req, res) => {
  try {
    return res.json(
      await adminActionRegistry.runAction({
        accessScope: getRequestAccessScope(req),
        actionId: req.params.action,
        payload: req.body,
      })
    );
  } catch (error) {
    return res.status(error.status ?? 500).json({
      error:
        error?.expose === true
          ? error.message
          : "Failed to run admin action.",
    });
  }
};

/**
 * `actionHandler` replaces what runs after the action's permission check; the
 * public edge of a split deployment passes one that forwards the action to the
 * agent tier. Authorization and its audit record stay here either way.
 */
export const createAdminRouter = (services, { actionHandler } = {}) => {
  const router = Router();
  const { adminAuditService, adminStatusService } = services;
  // ADMIN_AUDIT_DATA_EVENTS: a platform admin's reads across tenants.
  const dataAudit = createDataAccessAudit({ auditService: adminAuditService });

  router.get(
    "/admin/status",
    requireAdminPermission(getAdminStatusReadPermission(), {
      auditService: adminAuditService,
    }),
    async (req, res) => {
      try {
        const accessScope = getRequestAccessScope(req);
        const status = await adminStatusService.buildStatus({
          accessScope,
        });

        if (isPlatformAdminReadScope(accessScope)) {
          await dataAudit.recordOutcome(req, {
            accessScope,
            actionId: DATA_ACCESS_ACTION_IDS.adminStatusCrossTenantRead,
            status: 200,
          });
        }

        return res.json(status);
      } catch {
        return res.status(500).json({
          error: "Failed to load admin status.",
        });
      }
    }
  );

  router.post(
    "/admin/actions/:action",
    requireAdminPermission(getAdminActionPermissionForRequest, {
      auditService: adminAuditService,
    }),
    actionHandler ?? createAdminActionHandler(services)
  );

  router.get(
    "/admin/audit",
    requireAdminPermission(getAdminAuditReadPermission(), {
      auditService: adminAuditService,
    }),
    async (req, res) => {
      try {
        const accessScope = getRequestAccessScope(req);
        const listEvents = () =>
          adminAuditService.listEvents({
            accessScope,
            filters: req.query ?? {},
            limit: req.query?.limit,
            offset: req.query?.offset,
          });

        // Migration 032 limits a tenant to its own workspace's audit events
        // (its own user's without a workspace). A platform admin, whose scope
        // names no workspace and who has no workspace list, reads across
        // tenants as before the policy, so that read runs as the owner, and
        // only here, after the permission check above. A principal limited to
        // a workspace list that names none keeps the tenant read.
        const platformRead = isPlatformAdminReadScope(accessScope);

        if (!platformRead) {
          return res.json(await listEvents());
        }

        const page = await runAsDatabaseSystem(listEvents);

        // Recorded under the request's own binding, not the owner path the
        // read ran on, so the event extends the admin's own chain. The target
        // is the userId filter, if any (a workspaceId in the request makes it
        // that workspace's read, not a platform one).
        await dataAudit.recordOutcome(req, {
          accessScope,
          actionId: DATA_ACCESS_ACTION_IDS.adminAuditCrossTenantRead,
          count: Array.isArray(page?.events) ? page.events.length : null,
          status: 200,
          target: { userId: req.query?.userId },
        });

        return res.json(page);
      } catch {
        return res.status(500).json({
          error: "Failed to load admin audit.",
        });
      }
    }
  );

  return router;
};
