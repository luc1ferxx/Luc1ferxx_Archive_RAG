import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";

import { parseDocIds, serializeError } from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const questionSchema = z.object({
  question: requiredTrimmedString("Question is required."),
});

export const createChatRouter = (services) => {
  const router = Router();
  const {
    agentBudget,
    agentRunService,
    arxivImportService,
    buildChatResponse,
    capabilityRegistry,
    executionPlannerAdapter,
    intentPlannerAdapter,
    ragService,
    skillRegistry,
    webChatService,
  } = services;

  const handleChatRequest = async (req, res) => {
    const payload = req.method === "GET" ? req.query : req.body;
    const parsed = parseOrRespond(questionSchema, payload, res);
    if (!parsed) return;
    const { question } = parsed;
    const docIds = parseDocIds(payload.docIds, payload.docId);
    const sessionId = payload.sessionId?.trim() || null;
    const accessScope = getRequestAccessScope(req);
    const userId = accessScope.userId || payload.userId?.trim() || null;

    try {
      const response = await buildChatResponse({
        agentBudget,
        agentRunService,
        arxivImportService,
        capabilityRegistry,
        ragService,
        webChatService,
        question,
        docIds,
        sessionId,
        userId,
        accessScope,
        executionPlannerAdapter,
        intentPlannerAdapter,
        skillRegistry,
      });

      return res.status(response.status).json(response.body);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to answer the question."),
      });
    }
  };

  router.get("/chat", handleChatRequest);
  router.post("/chat", handleChatRequest);

  return router;
};
