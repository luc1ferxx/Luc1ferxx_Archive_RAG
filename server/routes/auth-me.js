import { Router } from "express";

import { getRequestAccessScope, listRequestRegistryWorkspaces } from "../auth.js";
import { isApiAuthEnabled, isApiAuthWorkspaceRequired } from "../rag/config.js";
import { buildAuthMeResponse } from "../rag/rbac.js";
import { TENANT_REGISTRY_ERROR_CODES } from "../rag/tenant-registry.js";

// GET /auth/me: the caller's identity and its effective permissions for the
// active workspace (rag/rbac.js). Mounted after requireApiAuth, so with API
// auth on it needs a valid credential; the body never carries the credential.
//
// Two additions, each present only when it applies, so every other
// configuration answers exactly as before:
//
//   - Under TENANT_MEMBERSHIP=enforce, a credential that fixes no workspace
//     and lists none gets its user's active registry memberships appended to
//     `workspaceIds` (auth.js listRequestRegistryWorkspaces), so the SPA can
//     offer them (src/auth/WorkspaceProvider.jsx). A registry fault answers
//     503 TENANT_REGISTRY_UNAVAILABLE, as the membership check does.
//   - `workspaceRequired: true` with API auth on and
//     API_AUTH_REQUIRE_WORKSPACE, so the SPA does not offer acting in no
//     workspace ("Personal"), which every request would then be refused for.
export const createAuthMeRouter = () => {
  const router = Router();

  router.get("/auth/me", async (req, res) => {
    res.set("Cache-Control", "no-store");

    try {
      const body = buildAuthMeResponse(getRequestAccessScope(req));

      for (const workspaceId of await listRequestRegistryWorkspaces(req)) {
        if (!body.workspaceIds.includes(workspaceId)) {
          body.workspaceIds.push(workspaceId);
        }
      }

      if (isApiAuthEnabled() && isApiAuthWorkspaceRequired()) {
        body.workspaceRequired = true;
      }

      return res.json(body);
    } catch (error) {
      if (error?.code === TENANT_REGISTRY_ERROR_CODES.unavailable) {
        return res.status(503).json({ code: error.code, error: error.message });
      }

      return res.status(error?.status ?? 500).json({
        code: error?.code ?? "AUTH_ME_FAILED",
        error: "Failed to describe the authenticated principal.",
      });
    }
  });

  return router;
};
