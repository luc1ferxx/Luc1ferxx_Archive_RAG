import { Router } from "express";

import { getRequestAccessScope } from "../auth.js";
import {
  getAdminActionPermissionForRequest,
  getAdminAuditReadPermission,
  getAdminStatusReadPermission,
  requireAdminPermission,
} from "../rag/admin-authorization.js";

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

  router.get(
    "/admin/status",
    requireAdminPermission(getAdminStatusReadPermission(), {
      auditService: adminAuditService,
    }),
    async (req, res) => {
      try {
        return res.json(
          await adminStatusService.buildStatus({
            accessScope: getRequestAccessScope(req),
          })
        );
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
        return res.json(
          await adminAuditService.listEvents({
            accessScope: getRequestAccessScope(req),
            filters: req.query ?? {},
            limit: req.query?.limit,
            offset: req.query?.offset,
          })
        );
      } catch {
        return res.status(500).json({
          error: "Failed to load admin audit.",
        });
      }
    }
  );

  return router;
};
