import { Router } from "express";

import { getRequestAccessScope } from "../auth.js";
import { ADMIN_PERMISSION_IDS } from "../rag/admin-permissions.js";
import { requireAdminPermission } from "../rag/admin-authorization.js";
import { runAsDatabaseSystem } from "../rag/postgres-tenant.js";
import { TenantRegistryError, WORKSPACE_STATUSES } from "../rag/tenant-registry.js";

// The tenant registry's admin API (migration 036, rag/tenant-registry.js).
//
//   GET    /admin/workspaces                                  admin.tenants.read
//   POST   /admin/workspaces                                  admin.tenants.write
//          body {id, plan?, region?, retentionPolicy?, status?: active|suspended}
//   GET    /admin/workspaces/:workspaceId                     admin.tenants.read
//   POST   /admin/workspaces/:workspaceId/actions/:action     admin.tenants.write (suspend | activate)
//   GET    /admin/workspaces/:workspaceId/members             admin.tenants.read
//   GET    /admin/workspaces/:workspaceId/members/:userId     admin.tenants.read
//   PUT    /admin/workspaces/:workspaceId/members/:userId     admin.tenants.write
//          body {roles: [roleId, ...]}; 201 when added, 200 when its roles were replaced
//   DELETE /admin/workspaces/:workspaceId/members/:userId     admin.tenants.write
//
// - Every call goes through requireAdminPermission, which records the
//   decision (allowed or denied, with the method, path and action) in the
//   admin audit store, as for the other admin routes. RBAC enforce checks the
//   same permissions app-wide first (rag/rbac.js RBAC_ROUTE_TABLE).
// - Reach: a platform credential (its scope names no workspace and it has no
//   workspace list; these paths are in auth.js TENANTLESS_PLATFORM_PATHS)
//   reaches every workspace. Any other holder of the permission reaches only
//   the workspace of its own scope: it may read it and manage its members,
//   another workspace answers 404 as if it did not exist, and registering a
//   workspace or changing a status is refused (TENANT_ADMIN_PLATFORM_ONLY).
// - The store calls run on the system path, after the permission and reach
//   checks: the tenant role may read only its own registry rows and may not
//   write them (migration 036).

const PLATFORM_ONLY_CODE = "TENANT_ADMIN_PLATFORM_ONLY";

const WORKSPACE_ACTIONS = Object.freeze({
  activate: "activateWorkspace",
  suspend: "suspendWorkspace",
});

const normalizeText = (value) => String(value ?? "").trim();

const describeReach = (accessScope = {}) => {
  const workspaceId = normalizeText(accessScope.workspaceId);
  const hasWorkspaceList = Array.isArray(accessScope.allowedWorkspaceIds)
    ? accessScope.allowedWorkspaceIds.length > 0
    : false;

  return { platform: !workspaceId && !hasWorkspaceList, workspaceId };
};

const notFound = () =>
  new TenantRegistryError("Workspace not found.", { code: "WORKSPACE_NOT_FOUND", status: 404 });

const platformOnly = () =>
  new TenantRegistryError(
    "Only a platform credential (no workspace in its scope and no workspace list) may register workspaces or change their status.",
    { code: PLATFORM_ONLY_CODE, status: 403 }
  );

// A workspace-scoped admin reaches its own workspace only; another one is
// answered exactly like a workspace that does not exist.
const assertReaches = (reach, workspaceId) => {
  if (!reach.platform && reach.workspaceId !== normalizeText(workspaceId)) {
    throw notFound();
  }
};

const sendError = (res, error, fallbackMessage) => {
  if (error instanceof TenantRegistryError) {
    return res.status(error.status ?? 400).json({ code: error.code, error: error.message });
  }

  console.error(fallbackMessage, error);
  return res.status(500).json({ error: fallbackMessage });
};

export const createAdminTenantsRouter = (services = {}, { tenantRegistry } = {}) => {
  const router = Router();
  const { adminAuditService } = services;
  const registry = tenantRegistry ?? services.tenantRegistry;
  const requireRead = requireAdminPermission(ADMIN_PERMISSION_IDS.adminTenantsRead, {
    auditService: adminAuditService,
  });
  const requireWrite = requireAdminPermission(ADMIN_PERMISSION_IDS.adminTenantsWrite, {
    auditService: adminAuditService,
  });
  const asSystem = (work) => runAsDatabaseSystem(work);

  router.get("/admin/workspaces", requireRead, async (req, res) => {
    const reach = describeReach(getRequestAccessScope(req));

    try {
      if (!reach.platform) {
        // Its own workspace, if registered (and matching the filter).
        const status = normalizeText(req.query?.status).toLowerCase();

        if (status && !Object.values(WORKSPACE_STATUSES).includes(status)) {
          throw new TenantRegistryError(
            `status must be one of ${Object.values(WORKSPACE_STATUSES).join(", ")}.`
          );
        }

        // A workspace id the registry cannot hold (not canonical) is simply
        // not registered.
        const own = reach.workspaceId
          ? await asSystem(() => registry.getWorkspace(reach.workspaceId)).catch((error) => {
              if (error instanceof TenantRegistryError && error.status === 400) {
                return null;
              }

              throw error;
            })
          : null;
        const workspaces = own && (!status || own.status === status) ? [own] : [];

        return res.json({ workspaces });
      }

      const workspaces = await asSystem(() =>
        registry.listWorkspaces({
          limit: req.query?.limit,
          offset: req.query?.offset,
          status: req.query?.status,
        })
      );

      return res.json({ workspaces });
    } catch (error) {
      return sendError(res, error, "Failed to list workspaces.");
    }
  });

  // The body names the new workspace as `id`: a `workspaceId` field in a
  // request body (or query) is how a request selects its own workspace
  // (auth.js resolveWorkspaceId), so it would make this request act inside
  // the workspace it means to create.
  router.post("/admin/workspaces", requireWrite, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;

      if (!body) {
        throw new TenantRegistryError('The body must be a JSON object such as {"id": "acme"}.');
      }

      if (Object.hasOwn(body, "workspaceId") || Object.hasOwn(req.query ?? {}, "workspaceId")) {
        throw new TenantRegistryError(
          "Name the new workspace as `id`: a workspaceId in the body or query selects the caller's own workspace."
        );
      }

      if (!describeReach(getRequestAccessScope(req)).platform) {
        throw platformOnly();
      }

      const { id, ...fields } = body;
      const workspace = await asSystem(() => registry.createWorkspace({ ...fields, workspaceId: id }));

      return res.status(201).json({ workspace });
    } catch (error) {
      return sendError(res, error, "Failed to register the workspace.");
    }
  });

  router.get("/admin/workspaces/:workspaceId", requireRead, async (req, res) => {
    try {
      assertReaches(describeReach(getRequestAccessScope(req)), req.params.workspaceId);

      const workspace = await asSystem(() => registry.getWorkspace(req.params.workspaceId));

      if (!workspace) {
        throw notFound();
      }

      return res.json({ workspace });
    } catch (error) {
      return sendError(res, error, "Failed to load the workspace.");
    }
  });

  router.post(
    "/admin/workspaces/:workspaceId/actions/:action",
    requireWrite,
    async (req, res) => {
      try {
        const method = Object.hasOwn(WORKSPACE_ACTIONS, req.params.action)
          ? WORKSPACE_ACTIONS[req.params.action]
          : null;

        if (!method) {
          throw new TenantRegistryError(
            `Unknown workspace action; use one of ${Object.keys(WORKSPACE_ACTIONS).join(", ")}.`,
            { code: "TENANT_REGISTRY_UNKNOWN_ACTION", status: 400 }
          );
        }

        if (!describeReach(getRequestAccessScope(req)).platform) {
          throw platformOnly();
        }

        const workspace = await asSystem(() => registry[method](req.params.workspaceId));

        return res.json({ workspace });
      } catch (error) {
        return sendError(res, error, "Failed to change the workspace status.");
      }
    }
  );

  router.get("/admin/workspaces/:workspaceId/members", requireRead, async (req, res) => {
    try {
      assertReaches(describeReach(getRequestAccessScope(req)), req.params.workspaceId);

      const members = await asSystem(() =>
        registry.listMembers(req.params.workspaceId, {
          limit: req.query?.limit,
          offset: req.query?.offset,
        })
      );

      return res.json({ members });
    } catch (error) {
      return sendError(res, error, "Failed to list workspace members.");
    }
  });

  router.get(
    "/admin/workspaces/:workspaceId/members/:userId",
    requireRead,
    async (req, res) => {
      try {
        assertReaches(describeReach(getRequestAccessScope(req)), req.params.workspaceId);

        const member = await asSystem(() =>
          registry.getMember(req.params.workspaceId, req.params.userId)
        );

        if (!member) {
          throw new TenantRegistryError("Workspace member not found.", {
            code: "WORKSPACE_MEMBER_NOT_FOUND",
            status: 404,
          });
        }

        return res.json({ member });
      } catch (error) {
        return sendError(res, error, "Failed to load the workspace member.");
      }
    }
  );

  router.put(
    "/admin/workspaces/:workspaceId/members/:userId",
    requireWrite,
    async (req, res) => {
      try {
        assertReaches(describeReach(getRequestAccessScope(req)), req.params.workspaceId);

        const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;

        if (!body) {
          throw new TenantRegistryError("The body must be a JSON object such as {\"roles\": []}.");
        }

        const { created, member } = await asSystem(() =>
          registry.putMember({
            roles: body.roles,
            userId: req.params.userId,
            workspaceId: req.params.workspaceId,
          })
        );

        return res.status(created ? 201 : 200).json({ created, member });
      } catch (error) {
        return sendError(res, error, "Failed to save the workspace member.");
      }
    }
  );

  router.delete(
    "/admin/workspaces/:workspaceId/members/:userId",
    requireWrite,
    async (req, res) => {
      try {
        assertReaches(describeReach(getRequestAccessScope(req)), req.params.workspaceId);

        await asSystem(() => registry.removeMember(req.params.workspaceId, req.params.userId));

        return res.json({ removed: true });
      } catch (error) {
        return sendError(res, error, "Failed to remove the workspace member.");
      }
    }
  );

  return router;
};
