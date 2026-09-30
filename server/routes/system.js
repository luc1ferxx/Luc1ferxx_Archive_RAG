import { Router } from "express";

import { getServiceRole } from "../rag/service-topology.js";

import { serializeError } from "./helpers.js";

const readServiceRole = () => {
  try {
    return getServiceRole();
  } catch {
    return "invalid";
  }
};

export const createSystemRouter = (services) => {
  const router = Router();
  const { healthService } = services;
  const serviceRole = readServiceRole();

  // Liveness only: the process is up and serving HTTP. It checks nothing else,
  // so an orchestrator restarts a hung process without restarting one whose
  // database or neighbouring tier is merely down (that is /ready's job).
  router.get("/livez", (req, res) => res.json({ role: serviceRole, status: "ok" }));

  router.get("/health", async (req, res) => {
    try {
      const report = await healthService.buildHealthReport();
      return res.json(report);
    } catch (error) {
      return res.status(500).json({
        status: "error",
        error: serializeError(error, "Failed to collect health status."),
      });
    }
  });

  router.get("/ready", async (req, res) => {
    try {
      const report = await healthService.buildHealthReport();

      return res.status(report.status === "ok" ? 200 : 503).json(report);
    } catch (error) {
      return res.status(503).json({
        status: "error",
        error: serializeError(error, "Readiness check failed."),
      });
    }
  });

  return router;
};
