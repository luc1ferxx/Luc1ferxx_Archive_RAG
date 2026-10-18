import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
import { DATA_ACCESS_ACTION_IDS } from "../rag/admin-audit.js";
import { createDataAccessAudit } from "../rag/data-access-audit.js";

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
  // ADMIN_AUDIT_DATA_EVENTS: ids and counts only, never memory text.
  const dataAudit = createDataAccessAudit({ auditService: services.adminAuditService });

  router.delete("/sessions/:sessionId", async (req, res) => {
    const parsed = parseOrRespond(sessionIdSchema, req.params, res);
    if (!parsed) return;
    const { sessionId } = parsed;
    const accessScope = getRequestAccessScope(req);
    const audited = {
      accessScope,
      actionId: DATA_ACCESS_ACTION_IDS.sessionDelete,
      resourceIds: [sessionId],
    };

    try {
      // The caller's scope is part of the session key, so a tenant can only
      // ever clear its own session of that id.
      const cleared = await ragService.clearSessionMemory(sessionId, accessScope);

      await dataAudit.recordOutcome(req, { ...audited, count: cleared ? 1 : 0, status: 200 });
      return res.json({
        cleared,
      });
    } catch (error) {
      await dataAudit.recordOutcome(req, { ...audited, status: error.status ?? 500 });
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
    const audited = {
      accessScope: getRequestAccessScope(req),
      actionId: DATA_ACCESS_ACTION_IDS.memoryDelete,
      resourceIds: [memoryId],
      target: { userId },
    };

    try {
      const memory = await ragService.deleteLongMemory({
        userId,
        memoryId,
      });

      if (!memory) {
        await dataAudit.recordOutcome(req, { ...audited, count: 0, status: 404 });
        return res.status(404).json({
          error: "Memory not found.",
        });
      }

      await dataAudit.recordOutcome(req, { ...audited, count: 1, status: 200 });
      return res.json({
        deleted: true,
        memory,
      });
    } catch (error) {
      await dataAudit.recordOutcome(req, { ...audited, status: error.status ?? 500 });
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

    const audited = {
      accessScope: getRequestAccessScope(req),
      actionId: DATA_ACCESS_ACTION_IDS.memoryClear,
      target: { userId },
    };

    try {
      const deletedCount = await ragService.clearLongMemories({
        userId,
      });

      await dataAudit.recordOutcome(req, { ...audited, count: deletedCount, status: 200 });
      return res.json({
        deletedCount,
      });
    } catch (error) {
      await dataAudit.recordOutcome(req, { ...audited, status: error.status ?? 500 });
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to clear long-term memories."),
      });
    }
  });

  return router;
};
