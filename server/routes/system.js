import { Router } from "express";

import { serializeError } from "./helpers.js";

export const createSystemRouter = (services) => {
  const router = Router();
  const { healthService } = services;

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
