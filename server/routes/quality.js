import { Router } from "express";

import { getRequestAccessScope } from "../auth.js";
import { markHistoricalQualityEvidence } from "../evaluation/quality-evidence-scope.js";
import { buildFeedbackRecord } from "../feedback.js";

import { resolveScopedUserId, serializeError } from "./helpers.js";

export const createQualityRouter = (services) => {
  const router = Router();
  const { agentExperienceMemoryService, feedbackService, qualityService } = services;

  router.get("/quality/latest", async (req, res) => {
    try {
      return res.json(
        markHistoricalQualityEvidence(
          await qualityService.readLatestQualityReport()
        )
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load the latest quality report."),
      });
    }
  });

  router.get("/quality/history", async (req, res) => {
    try {
      return res.json(
        markHistoricalQualityEvidence(
          await qualityService.readQualityHistory()
        )
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load quality history."),
      });
    }
  });

  router.get("/feedback", async (req, res) => {
    const limit = Number.parseInt(req.query.limit ?? "25", 10);

    try {
      const feedback = await feedbackService.listFeedback({
        accessScope: getRequestAccessScope(req),
        limit,
      });

      return res.json({
        feedback,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load answer feedback."),
      });
    }
  });

  router.post("/feedback", async (req, res) => {
    try {
      // The record's user and workspace come from the access scope only. The
      // user goes through the decision every route that reads one uses: an
      // authenticated request acts for its credential's user.
      const accessScope = getRequestAccessScope(req);
      const feedback = buildFeedbackRecord({
        payload: req.body,
        accessScope: {
          ...accessScope,
          userId: resolveScopedUserId(req, req.body?.userId),
        },
      });
      const storedFeedback = await feedbackService.recordFeedback(feedback);
      let agentExperienceMemory = null;

      try {
        const writeResult = await agentExperienceMemoryService.recordFromFeedback?.({
          feedback: storedFeedback,
        });
        agentExperienceMemory = writeResult?.observability ?? null;
      } catch (error) {
        console.error("Failed to record agent experience from feedback.", error);
        agentExperienceMemory = {
          error: error instanceof Error ? error.message : "write_failed",
          status: "error",
          writeAttempted: true,
        };
      }

      return res.status(201).json({
        agentExperienceMemory,
        feedback: storedFeedback,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to store answer feedback."),
      });
    }
  });

  return router;
};
