import { Router } from "express";

import { buildPublicAuthConfig } from "../rag/oidc.js";

// GET /auth/config: what the SPA needs to start a login. Public (mounted next
// to the system routes, ahead of requireApiAuth) and read-only; it carries the
// issuer, client id, scopes and audience, never a secret or a token.
export const createAuthConfigRouter = () => {
  const router = Router();

  router.get("/auth/config", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(buildPublicAuthConfig());
  });

  return router;
};
