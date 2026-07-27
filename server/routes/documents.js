import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";

import { sendBufferedFile, serializeError } from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const docIdSchema = z.object({
  docId: requiredTrimmedString("docId is required."),
});

export const createDocumentsRouter = (services) => {
  const router = Router();
  const { ragService } = services;

  router.get("/documents/:docId/file", async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);
    if (!parsed) return;
    const { docId } = parsed;

    try {
      const storedFile = await ragService.getDocumentFile?.(
        docId,
        getRequestAccessScope(req)
      );

      if (!storedFile) {
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      sendBufferedFile({
        req,
        res,
        fileBuffer: storedFile.fileBuffer,
        fileName: storedFile.fileName,
        mimeType: storedFile.mimeType,
      });
      return;
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to stream the document."),
      });
    }
  });

  router.get("/documents", (req, res) => {
    return res.json(ragService.listDocuments(getRequestAccessScope(req)));
  });

  router.delete("/documents/:docId", async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);
    if (!parsed) return;
    const { docId } = parsed;

    try {
      const document = await ragService.deleteDocument(docId, {
        accessScope: getRequestAccessScope(req),
      });

      if (!document) {
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      return res.json({
        deleted: true,
        document,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to delete the document."),
      });
    }
  });

  router.post("/documents/clear", async (req, res) => {
    try {
      const documents = await ragService.clearDocuments({
        accessScope: getRequestAccessScope(req),
      });
      return res.json({
        deletedCount: documents.length,
        documents,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to clear documents."),
      });
    }
  });

  return router;
};
