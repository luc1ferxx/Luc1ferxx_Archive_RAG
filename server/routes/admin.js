import { Router } from "express";

import { getRequestAccessScope } from "../auth.js";
import {
  getAdminActionPermissionForRequest,
  getAdminAuditReadPermission,
  getAdminStatusReadPermission,
  requireAdminPermission,
} from "../rag/admin-authorization.js";

import { serializeError } from "./helpers.js";

export const createAdminRouter = (services) => {
  const router = Router();
  const { adminActionRegistry, adminAuditService, adminStatusService } = services;

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
    async (req, res) => {
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
    }
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
