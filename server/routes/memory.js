import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";

import { resolveScopedUserId, serializeError } from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const sessionIdSchema = z.object({
  sessionId: requiredTrimmedString("sessionId is required."),
});

const memoryIdSchema = z.object({
  memoryId: requiredTrimmedString("memoryId is required."),
});

const textBodySchema = z.object({
  text: requiredTrimmedString("text is required."),
});

export const createMemoryRouter = (services) => {
  const router = Router();
  const { ragService } = services;

  router.delete("/sessions/:sessionId", async (req, res) => {
    const parsed = parseOrRespond(sessionIdSchema, req.params, res);
    if (!parsed) return;
    const { sessionId } = parsed;

    try {
      return res.json({
        cleared: await ragService.clearSessionMemory(sessionId),
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to clear session memory."),
      });
    }
  });

  router.get("/memory", async (req, res) => {
    const userId = resolveScopedUserId(req, req.query.userId);
    const limit = Number.parseInt(req.query.limit ?? "50", 10);

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    try {
      const memories = await ragService.listLongMemories({
        userId,
        limit,
      });

      return res.json({
        memories,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load long-term memories."),
      });
    }
  });

  router.post("/memory", async (req, res) => {
    const userId = resolveScopedUserId(req, req.body.userId);

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    const parsed = parseOrRespond(textBodySchema, req.body ?? {}, res);
    if (!parsed) return;
    const { text } = parsed;

    try {
      const memory = await ragService.rememberLongMemory({
        userId,
        category: req.body.category,
        memoryKey: req.body.memoryKey,
        memoryValue: req.body.memoryValue,
        text,
        source: req.body.source,
        confidence: req.body.confidence,
      });

      return res.status(201).json({
        memory,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to store long-term memory."),
      });
    }
  });

  router.delete("/memory/:memoryId", async (req, res) => {
    const userId = resolveScopedUserId(req, req.query.userId);

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    const parsed = parseOrRespond(memoryIdSchema, req.params, res);
    if (!parsed) return;
    const { memoryId } = parsed;

    try {
      const memory = await ragService.deleteLongMemory({
        userId,
        memoryId,
      });

      if (!memory) {
        return res.status(404).json({
          error: "Memory not found.",
        });
      }

      return res.json({
        deleted: true,
        memory,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to delete long-term memory."),
      });
    }
  });

  router.delete("/memory", async (req, res) => {
    const userId = resolveScopedUserId(req, req.query.userId);

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    try {
      const deletedCount = await ragService.clearLongMemories({
        userId,
      });

      return res.json({
        deletedCount,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to clear long-term memories."),
      });
    }
  });

  return router;
};
