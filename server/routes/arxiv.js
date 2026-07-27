import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
import { normalizeArxivMaxResults } from "../rag/arxiv-client.js";

import { serializeError } from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const topicQuerySchema = z.object({
  topic: requiredTrimmedString("topic is required."),
});

const topicBodySchema = z.object({
  topic: requiredTrimmedString("topic is required."),
});

const docIdSchema = z.object({
  docId: requiredTrimmedString("docId is required."),
});

export const createArxivRouter = (services) => {
  const router = Router();
  const { arxivEnrichmentService, arxivImportService, arxivService } = services;

  router.get("/arxiv/search", async (req, res) => {
    const parsed = parseOrRespond(topicQuerySchema, req.query, res);
    if (!parsed) return;
    const { topic } = parsed;

    try {
      const papers = await arxivService.search({
        topic,
        maxResults: normalizeArxivMaxResults(req.query.maxResults),
      });

      return res.json({
        topic,
        papers,
      });
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to search arXiv."),
      });
    }
  });

  router.post("/arxiv/import", async (req, res) => {
    const parsed = parseOrRespond(topicBodySchema, req.body ?? {}, res);
    if (!parsed) return;
    const { topic } = parsed;

    try {
      const result = await arxivImportService.importTopic({
        accessScope: getRequestAccessScope(req),
        topic,
        maxResults: normalizeArxivMaxResults(req.body.maxResults),
      });

      return res.status(201).json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to import arXiv papers."),
      });
    }
  });

  router.get("/documents/:docId/arxiv/suggestions", async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);
    if (!parsed) return;
    const { docId } = parsed;

    try {
      const result = await arxivEnrichmentService.suggestForDocument({
        accessScope: getRequestAccessScope(req),
        docId,
        maxResults: normalizeArxivMaxResults(req.query.maxResults),
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to find arXiv suggestions."),
      });
    }
  });

  router.get("/documents/arxiv/suggestions", async (req, res) => {
    try {
      const result = arxivEnrichmentService.listSavedSuggestions({
        accessScope: getRequestAccessScope(req),
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to list saved arXiv suggestions."),
      });
    }
  });

  router.get("/documents/:docId/arxiv/suggestions/saved", async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);
    if (!parsed) return;
    const { docId } = parsed;

    try {
      const result = arxivEnrichmentService.getSavedSuggestionForDocument({
        accessScope: getRequestAccessScope(req),
        docId,
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to load saved arXiv suggestions."),
      });
    }
  });

  router.post("/documents/:docId/arxiv/import", async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);
    if (!parsed) return;
    const { docId } = parsed;

    try {
      const result = await arxivEnrichmentService.importForDocument({
        accessScope: getRequestAccessScope(req),
        docId,
        selectedArxivIds: req.body.selectedArxivIds,
        selectionToken: req.body.selectionToken,
      });

      return res.status(201).json(result);
    } catch (error) {
      return res.status(error.status ?? 502).json({
        error: serializeError(error, "Failed to import arXiv suggestions."),
      });
    }
  });

  return router;
};
