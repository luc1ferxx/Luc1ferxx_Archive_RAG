import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
import {
  getAdminStatusReadPermission,
  requireAdminPermission,
} from "../rag/admin-authorization.js";
import { getVectorStoreProviderConfigStatus } from "../rag/config.js";
import {
  loadDocumentsIngestedElsewhere,
  refreshDocumentsIngestedElsewhere,
} from "../rag/ingest-worker.js";
import { describeIndexVersions } from "../rag/vector-store-pgvector-versions.js";

import { sendBufferedFile, serializeError } from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const docIdSchema = z.object({
  docId: requiredTrimmedString("docId is required."),
});

// `?version=N`: the content version a citation's link names (chunks of a
// replaced document link to their own version).
const fileVersionQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
});

export const createDocumentsRouter = (services) => {
  const router = Router();
  const { ragService } = services;

  router.get("/documents/:docId/file", async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);
    if (!parsed) return;
    const query = parseOrRespond(fileVersionQuerySchema, req.query ?? {}, res);
    if (!query) return;
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

      // Only the current content's bytes are kept: a link to a replaced
      // version gets no other version's PDF in its place.
      const currentVersion = Number(storedFile.document?.version ?? 1) || 1;

      if (query.version !== undefined && query.version !== currentVersion) {
        return res.status(409).json({
          currentVersion,
          error: `This link is to version ${query.version} of the document, which has been replaced by version ${currentVersion}; its PDF is no longer stored.`,
          requestedVersion: query.version,
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

  router.get("/documents", async (req, res) => {
    const accessScope = getRequestAccessScope(req);

    // With a PostgreSQL registry other API instances and ingest workers write
    // it too (either ingest mode), so this tenant's rows are re-read first.
    await refreshDocumentsIngestedElsewhere(ragService, accessScope);
    return res.json(ragService.listDocuments(accessScope));
  });

  router.delete("/documents/:docId", async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);
    if (!parsed) return;
    const { docId } = parsed;

    try {
      // With a PostgreSQL registry: picks up a document another process
      // registered and drops one it already deleted, so the latter is a 404
      // (the delete itself also answers null when the store had no row left).
      await loadDocumentsIngestedElsewhere(ragService, [docId]);
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

  // The pgvector index versions (npm run vector:index): which version serves,
  // what is building and how far it got, drift. Read-only and admin-only;
  // building, activating, rolling back and retiring stay with the CLI, where an
  // operator watches them. `services.describeIndexVersions` is a test seam.
  router.get(
    "/admin/index-versions",
    requireAdminPermission(getAdminStatusReadPermission(), {
      auditService: services.adminAuditService,
    }),
    async (req, res) => {
      const provider = getVectorStoreProviderConfigStatus();

      if (!provider.valid || provider.provider !== "pgvector") {
        return res.status(409).json({
          error:
            "Index versions exist only for VECTOR_STORE_PROVIDER=pgvector; the local and Qdrant providers keep one index that vector:reindex rewrites in place.",
          provider: provider.valid ? provider.provider : null,
        });
      }

      try {
        return res.json(await (services.describeIndexVersions ?? describeIndexVersions)());
      } catch (error) {
        return res.status(error.status ?? 500).json({
          error: serializeError(error, "Failed to read the index versions."),
        });
      }
    }
  );

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
