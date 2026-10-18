import { Router } from "express";

import { presentsSingleTenantCredential, resolveOptionalAccessScope } from "../auth.js";
import {
  buildAdminAuthorizationDecision,
  getAdminStatusReadPermission,
} from "../rag/admin-authorization.js";
import { isApiAuthEnabled } from "../rag/config.js";
import { getServiceRole } from "../rag/service-topology.js";

import { serializeError } from "./helpers.js";

const readServiceRole = () => {
  try {
    return getServiceRole();
  } catch {
    return "invalid";
  }
};

// These routes stay public (RBAC_ROUTE_TABLE marks them so, and they are
// mounted before rate limiting and requireApiAuth) because orchestrators probe
// them without a key and read only the status code. What they say beyond the
// status is another matter: the health report names the topology, the stores,
// table and model names, and dependency error messages. With API auth on, only
// a caller holding admin.status.read (the permission GET /admin/status needs,
// decided the same way, RBAC_MODE=enforce grants included) gets it; everyone
// else, an invalid credential included, gets the status alone. Auth off keeps
// the full body. The decision is not written to the admin audit log, which
// every probe would otherwise flood.
const canReadHealthDetails = async (req) => {
  if (!isApiAuthEnabled()) {
    return true;
  }

  // The single shared API_AUTH_TOKEN carries no permissions but already acts
  // for the whole archive (the single-tenant setup), so its operator reads the
  // details the deployment and incident runbooks tell them to.
  if (presentsSingleTenantCredential(req)) {
    return true;
  }

  const accessScope = await resolveOptionalAccessScope(req);

  if (!accessScope) {
    return false;
  }

  try {
    return buildAdminAuthorizationDecision({
      accessScope,
      apiAuthEnabled: true,
      permissionId: getAdminStatusReadPermission(),
    }).allowed;
  } catch {
    // An RBAC policy that no longer parses withholds the details; the probe
    // itself still answers.
    return false;
  }
};

// With auth on the body depends on the credential, so no cache may hand an
// administrator's report to the next caller.
const preventSharedCaching = (res) => {
  if (isApiAuthEnabled()) {
    res.set("Cache-Control", "no-store");
  }
};

const toStatusOnly = (body) => ({ status: body?.status });

export const createSystemRouter = (services) => {
  const router = Router();
  const { healthService } = services;
  const serviceRole = readServiceRole();

  // Liveness only: the process is up and serving HTTP. It checks nothing else,
  // so an orchestrator restarts a hung process without restarting one whose
  // database or neighbouring tier is merely down (that is /ready's job).
  router.get("/livez", async (req, res) => {
    const body = { role: serviceRole, status: "ok" };

    preventSharedCaching(res);

    return res.json((await canReadHealthDetails(req)) ? body : toStatusOnly(body));
  });

  router.get("/health", async (req, res) => {
    const detailed = await canReadHealthDetails(req);

    preventSharedCaching(res);

    try {
      const report = await healthService.buildHealthReport();
      return res.json(detailed ? report : toStatusOnly(report));
    } catch (error) {
      const body = {
        status: "error",
        error: serializeError(error, "Failed to collect health status."),
      };

      return res.status(500).json(detailed ? body : toStatusOnly(body));
    }
  });

  router.get("/ready", async (req, res) => {
    const detailed = await canReadHealthDetails(req);

    preventSharedCaching(res);

    try {
      const report = await healthService.buildHealthReport();

      return res
        .status(report.status === "ok" ? 200 : 503)
        .json(detailed ? report : toStatusOnly(report));
    } catch (error) {
      const body = {
        status: "error",
        error: serializeError(error, "Readiness check failed."),
      };

      return res.status(503).json(detailed ? body : toStatusOnly(body));
    }
  });

  return router;
};
