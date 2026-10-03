import { Router } from "express";

import { getRequestAccessScope } from "../auth.js";
import { buildAuthMeResponse } from "../rag/rbac.js";

// GET /auth/me: the caller's identity and its effective permissions for the
// active workspace (rag/rbac.js). Mounted after requireApiAuth, so with API
// auth on it needs a valid credential; the body never carries the credential.
export const createAuthMeRouter = () => {
  const router = Router();

  router.get("/auth/me", (req, res) => {
    res.set("Cache-Control", "no-store");

    try {
      return res.json(buildAuthMeResponse(getRequestAccessScope(req)));
    } catch (error) {
      return res.status(error?.status ?? 500).json({
        code: error?.code ?? "AUTH_ME_FAILED",
        error: "Failed to describe the authenticated principal.",
      });
    }
  });

  return router;
};
