import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
import {
  getAdminStatusReadPermission,
  requireAdminPermission,
} from "../rag/admin-authorization.js";
import { DATA_ACCESS_ACTION_IDS } from "../rag/admin-audit.js";
import { getVectorStoreProviderConfigStatus } from "../rag/config.js";
import { createDataAccessAudit } from "../rag/data-access-audit.js";
import {
  loadDocumentsIngestedElsewhere,
  refreshDocumentsIngestedElsewhere,
} from "../rag/ingest-worker.js";
import { describeIndexVersions } from "../rag/vector-store-pgvector-versions.js";

import {
  noStoreTenantData,
  sendBufferedFile,
  serializeError,
} from "./helpers.js";
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
  // ADMIN_AUDIT_DATA_EVENTS: ids and counts only (rag/data-access-audit.js).
  const dataAudit = createDataAccessAudit({ auditService: services.adminAuditService });

  // Both reads answer with the caller's own documents, selected by the
  // identity headers: never cacheable (helpers.js setTenantDataCacheHeaders).
  router.get("/documents/:docId/file", noStoreTenantData, async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);
    if (!parsed) return;
    const query = parseOrRespond(fileVersionQuerySchema, req.query ?? {}, res);
    if (!query) return;
    const { docId } = parsed;
    const accessScope = getRequestAccessScope(req);
    const recordDownload = (status) =>
      dataAudit.recordOutcome(req, {
        accessScope,
        actionId: DATA_ACCESS_ACTION_IDS.documentFileDownload,
        resourceIds: [docId],
        status,
      });

    try {
      const storedFile = await ragService.getDocumentFile?.(docId, accessScope);

      if (!storedFile) {
        await recordDownload(404);
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      // Only the current content's bytes are kept: a link to a replaced
      // version gets no other version's PDF in its place.
      const currentVersion = Number(storedFile.document?.version ?? 1) || 1;

      if (query.version !== undefined && query.version !== currentVersion) {
        await recordDownload(409);
        return res.status(409).json({
          currentVersion,
          error: `This link is to version ${query.version} of the document, which has been replaced by version ${currentVersion}; its PDF is no longer stored.`,
          requestedVersion: query.version,
        });
      }

      // Recorded before the bytes go out: the response cannot wait on it
      // afterwards, and a failed record never withholds the file.
      await recordDownload(200);
      sendBufferedFile({
        req,
        res,
        fileBuffer: storedFile.fileBuffer,
        fileName: storedFile.fileName,
        mimeType: storedFile.mimeType,
      });
      return;
    } catch (error) {
      await recordDownload(error.status ?? 500);
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to stream the document."),
      });
    }
  });

  router.get("/documents", noStoreTenantData, async (req, res) => {
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
    const accessScope = getRequestAccessScope(req);
    const audited = { accessScope, actionId: DATA_ACCESS_ACTION_IDS.documentDelete, resourceIds: [docId] };

    // Destructive: nothing is deleted unless its audit record is written.
    if (!(await dataAudit.recordIntent(req, res, audited))) return;

    try {
      // With a PostgreSQL registry: picks up a document another process
      // registered and drops one it already deleted, so the latter is a 404
      // (the delete itself also answers null when the store had no row left).
      await loadDocumentsIngestedElsewhere(ragService, [docId]);
      const document = await ragService.deleteDocument(docId, {
        accessScope,
      });

      if (!document) {
        await dataAudit.recordOutcome(req, { ...audited, count: 0, status: 404 });
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      await dataAudit.recordOutcome(req, { ...audited, count: 1, status: 200 });
      return res.json({
        deleted: true,
        document,
      });
    } catch (error) {
      await dataAudit.recordOutcome(req, { ...audited, status: error.status ?? 500 });
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
    const accessScope = getRequestAccessScope(req);
    const audited = { accessScope, actionId: DATA_ACCESS_ACTION_IDS.documentsClear };

    // Destructive: nothing is cleared unless its audit record is written.
    if (!(await dataAudit.recordIntent(req, res, audited))) return;

    try {
      const documents = await ragService.clearDocuments({
        accessScope,
      });

      await dataAudit.recordOutcome(req, {
        ...audited,
        count: documents.length,
        resourceIds: documents.map((document) => document?.docId),
        status: 200,
      });
      return res.json({
        deletedCount: documents.length,
        documents,
      });
    } catch (error) {
      await dataAudit.recordOutcome(req, { ...audited, status: error.status ?? 500 });
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to clear documents."),
      });
    }
  });

  return router;
};
