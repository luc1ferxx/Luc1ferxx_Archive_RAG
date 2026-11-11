import { Router } from "express";
import multer from "multer";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { z } from "zod";

import { bindDatabaseTenant, getRequestAccessScope } from "../auth.js";
import { DATA_ACCESS_ACTION_IDS } from "../rag/admin-audit.js";
import { ADMIN_PERMISSION_IDS } from "../rag/admin-permissions.js";
import {
  getAdminStatusReadPermission,
  requireAdminPermission,
} from "../rag/admin-authorization.js";
import { isRagIngestAsync, isRagIngestDedupEnabled } from "../rag/config.js";
import { createDataAccessAudit } from "../rag/data-access-audit.js";
import {
  REPLACEMENT_NEEDS_TRANSACTION_MESSAGE,
  replaceDocument as replaceDocumentInProcess,
  supportsDocumentReplacement as supportsDocumentReplacementInProcess,
} from "../rag/index.js";
import {
  toDeadLetterIngestJob,
  toPublicIngestJob,
} from "../rag/ingest-job-store.js";
import { INGEST_JOB_KINDS } from "../rag/ingest-stages.js";
import { loadDocumentsIngestedElsewhere } from "../rag/ingest-worker.js";
import {
  assertTenantStorageQuotaAllows,
  describeTenantStorageQuotaError,
} from "../rag/tenant-storage-quota.js";
import {
  MAX_UPLOAD_MULTIPART_FIELD_BYTES,
  MAX_UPLOAD_MULTIPART_FIELDS,
} from "../upload-policy.js";
import { UPLOAD_SESSION_LIMIT_EXCEEDED } from "../upload-session-store.js";
import { readWorkingFile } from "../rag/working-files.js";
import { createWorkingFileDiskStorage } from "./working-file-storage.js";

import {
  checkUploadedDocument,
  cleanupUploadedFile,
  createStoredFileName,
  DEFAULT_UPLOAD_CHUNK_SIZE,
  describeDocumentFormatErrorCode,
  describeDocumentRefusal,
  describeMissingUploadFile,
  describeRefusedUploadFileName,
  filterUploadFile,
  getUploadDocumentFormats,
  isAcceptedUploadFileName,
  isDocumentFormatSettingError,
  MAX_CHUNK_UPLOAD_SIZE,
  MAX_DIRECT_UPLOAD_SIZE,
  serializeError,
} from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const fileIdQuerySchema = z.object({
  fileId: requiredTrimmedString("fileId is required."),
});

const fileIdBodySchema = z.object({
  fileId: requiredTrimmedString("fileId is required."),
});

const ingestJobIdSchema = z.object({
  jobId: requiredTrimmedString("jobId is required."),
});

const docIdSchema = z.object({
  docId: requiredTrimmedString("docId is required."),
});

const deadLetterQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const uploadChunkBodySchema = z
  .object({
    fileId: requiredTrimmedString("fileId is required."),
    chunkIndex: requiredTrimmedString("chunkIndex is required."),
    totalChunks: requiredTrimmedString("totalChunks is required."),
    chunkSha256: z.string().trim().optional(),
  })
  .strict();

export const createUploadsRouter = (services) => {
  const router = Router();
  const { ingestJobStore, ragService, uploadStore, uploadsDirectory } = services;
  // ADMIN_AUDIT_DATA_EVENTS: a document replace (ids only).
  const dataAudit = createDataAccessAudit({ auditService: services.adminAuditService });
  const runBestEffort = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      console.error(`[upload-cleanup] ${label}`, error);
    }
  };

  // PUT /documents/:docId in sync mode. The app's ragService may bring its
  // own (a test seam); otherwise this process ingests the replacement, which
  // only a transactional provider (pgvector) supports.
  const replaceDocument = ragService.replaceDocument ?? replaceDocumentInProcess;
  const supportsDocumentReplacement =
    ragService.supportsDocumentReplacement ??
    (ragService.replaceDocument ? () => true : supportsDocumentReplacementInProcess);

  // Every upload route validates first and then hands the file here. Sync mode
  // ingests inside the request and answers 201 with the document (200 with the
  // existing document and `duplicate: true` when the tenant already stored
  // these bytes, 200 for a replacement); async mode stores the validated bytes
  // in an ingest job and answers 202, and a worker runs the same ingest as a
  // staged pipeline (rag/ingest-worker.js). The content hash rides along so
  // either mode can resolve a duplicate (RAG_INGEST_DEDUP) and every document
  // records it.
  //
  // `format` is what the byte check found. A synchronous ingest of a Word,
  // PowerPoint or Excel file is told to read it as that format (rag/index.js
  // ingestDocument `formats`); a PDF's ingest is handed exactly what it always
  // was. A queued job needs nothing: its parse stage reads any format.
  const ingestUpload = async ({
    accessScope,
    docId,
    fileName,
    filePath,
    format = "pdf",
    kind = INGEST_JOB_KINDS.create,
  }) => {
    const readAs = format && format !== "pdf" ? { formats: [format] } : {};
    // The upload is a working file (encrypted with TENANT_ENCRYPTION=on); the
    // hash, the quota and the queued job all see its plaintext.
    const fileBytes = await readWorkingFile(filePath);
    const contentSha256 = createHash("sha256").update(fileBytes).digest("hex");
    const deduplicate = kind === INGEST_JOB_KINDS.create && isRagIngestDedupEnabled();
    const replacing = kind === INGEST_JOB_KINDS.replace;

    // Storage quotas (TENANT_MAX_DOCUMENTS / TENANT_MAX_DOCUMENT_BYTES, off by
    // default): refused here before the PDF is parsed, embedded or queued;
    // the commit checks again under its locks (rag/index.js commitDocument).
    await assertTenantStorageQuotaAllows({
      addedBytes: replacing
        ? fileBytes.length - (Number(ragService.getDocument?.(docId, accessScope)?.fileSize) || 0)
        : fileBytes.length,
      addedDocuments: replacing ? 0 : 1,
      duplicateOfSha256: deduplicate ? contentSha256 : null,
      ownerUserId: accessScope.userId,
      workspaceId: accessScope.workspaceId,
    });

    if (!isRagIngestAsync()) {
      if (kind === INGEST_JOB_KINDS.replace) {
        // No request time from this host's clock: the registry orders the
        // replacement by the database's (rag/index.js commitDocument).
        const replaced = await replaceDocument({
          contentSha256,
          docId,
          filePath,
          fileName,
          ownerUserId: accessScope.userId,
          workspaceId: accessScope.workspaceId,
          ...readAs,
        });

        // A replacement requested before the document's current content was
        // discarded: the caller's bytes are not the document.
        return { body: replaced, status: replaced?.superseded === true ? 409 : 200 };
      }

      const document = await ragService.ingestDocument({
        contentSha256,
        deduplicate,
        docId,
        filePath,
        fileName,
        ownerUserId: accessScope.userId,
        workspaceId: accessScope.workspaceId,
        ...readAs,
      });

      return {
        body: document,
        status: document?.duplicate === true ? 200 : 201,
      };
    }

    const job = await ingestJobStore.enqueue({
      contentSha256,
      deduplicate,
      docId,
      fileBytes,
      fileName,
      kind,
      ownerUserId: accessScope.userId,
      workspaceId: accessScope.workspaceId,
    });

    // The 202 body of a plain upload is unchanged; a duplicate says so and a
    // replacement names its kind.
    return {
      body: {
        jobId: job.jobId,
        docId: job.resolvedDocId || job.docId,
        fileName: job.fileName,
        status: job.status,
        ...(job.duplicate === true ? { duplicate: true } : {}),
        ...(kind === INGEST_JOB_KINDS.replace ? { kind } : {}),
      },
      status: 202,
    };
  };

  const storage = createWorkingFileDiskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDirectory);
    },
    filename: (req, file, cb) => {
      // "<uuid>.pdf" with PDF alone; otherwise the original name's extension.
      let storedFileName;

      try {
        storedFileName = createStoredFileName({ fileName: file.originalname, mimeType: file.mimetype });
      } catch (error) {
        cb(error);
        return;
      }

      cb(null, storedFileName);
    },
  });

  // RAG_DOCUMENT_FORMATS for one request, or null once the route answered
  // 500 with its coded error (a value changed to an invalid one after the
  // start, which createAppServices would have refused).
  const readFormatsOrRespond = (res) => {
    try {
      return getUploadDocumentFormats();
    } catch (error) {
      res.status(500).json({
        ...describeDocumentFormatErrorCode(error),
        error: serializeError(error, "The accepted document formats are misconfigured."),
      });
      return null;
    }
  };

  const upload = multer({
    storage,
    limits: {
      // multer 2 rejects a file only when it exceeds fileSize (1.x did so at
      // fileSize), so the limit is the public maximum itself.
      fileSize: MAX_DIRECT_UPLOAD_SIZE,
      files: 1,
      fields: 0,
      parts: 2,
      fieldSize: MAX_UPLOAD_MULTIPART_FIELD_BYTES,
    },
    // A name or client MIME type of a format this server reads gets through
    // (helpers.js isAcceptedUploadFile); the byte check decides.
    fileFilter: filterUploadFile,
  });
  const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      // multer 2 rejects a file only when it exceeds fileSize, so the limit is
      // the public maximum itself; the store remains authoritative for the
      // declared and actual chunk geometry.
      fileSize: MAX_CHUNK_UPLOAD_SIZE,
      files: 1,
      fields: MAX_UPLOAD_MULTIPART_FIELDS,
      parts: MAX_UPLOAD_MULTIPART_FIELDS + 2,
      fieldSize: MAX_UPLOAD_MULTIPART_FIELD_BYTES,
    },
  });

  router.post("/upload/init", async (req, res) => {
    const formats = readFormatsOrRespond(res);
    if (!formats) return;

    if (req.body?.fileName != null && !isAcceptedUploadFileName(req.body.fileName, formats)) {
      return res.status(400).json(describeRefusedUploadFileName(formats));
    }

    try {
      const accessScope = getRequestAccessScope(req);

      // An upload the storage quota would refuse at commit is refused before
      // any chunk is sent (declared size; off by default).
      await assertTenantStorageQuotaAllows({
        addedBytes: Number(req.body?.fileSize) || 0,
        addedDocuments: 1,
        ownerUserId: accessScope.userId,
        workspaceId: accessScope.workspaceId,
      });

      const session = await uploadStore.initializeUploadSession({
        accessScope,
        fileId: req.body.fileId,
        fileName: req.body.fileName,
        fileSize: req.body.fileSize,
        lastModified: req.body.lastModified,
        totalChunks: req.body.totalChunks,
        chunkSize: req.body.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE,
        fileSha256: req.body.fileSha256,
      });

      return res.status(201).json(session);
    } catch (error) {
      // A per-tenant session cap (UPLOAD_SESSION_MAX_PER_TENANT,
      // UPLOAD_SESSION_MAX_BYTES_PER_TENANT) answers 429 with its stable code
      // and which cap it hit; no other error's code is exposed.
      const limitExceeded =
        error?.status === 429 && error?.code === UPLOAD_SESSION_LIMIT_EXCEEDED;

      return res.status(error.status ?? 500).json({
        ...(limitExceeded ? { code: error.code, limit: error.limit } : {}),
        ...describeTenantStorageQuotaError(error),
        error: serializeError(error, "Failed to initialize the upload session."),
      });
    }
  });

  router.get("/upload/status", async (req, res) => {
    const parsed = parseOrRespond(fileIdQuerySchema, req.query, res);
    if (!parsed) return;
    const { fileId } = parsed;

    try {
      const accessScope = getRequestAccessScope(req);
      const session = await uploadStore.getUploadSessionStatus({
        accessScope,
        fileId,
      });

      if (!session) {
        return res.status(404).json({
          error: "Upload session not found.",
        });
      }

      return res.json(session);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to read the upload session status."),
      });
    }
  });

  // multer's memory storage resumes the chain from a stream callback that has
  // lost the request's async context, and with it the database tenant. Both
  // upload routes re-bind it after multer rather than depend on which storage
  // engine happens to keep the context.
  router.post("/upload/chunk", chunkUpload.single("chunk"), bindDatabaseTenant, async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "No chunk uploaded.",
      });
    }

    try {
      const parsed = parseOrRespond(uploadChunkBodySchema, req.body ?? {}, res);
      if (!parsed) return;
      const { fileId, chunkIndex, totalChunks, chunkSha256 } = parsed;
      const accessScope = getRequestAccessScope(req);

      const result = await uploadStore.storeUploadChunk({
        accessScope,
        fileId,
        chunkIndex,
        totalChunks,
        chunkBuffer: req.file.buffer,
        chunkSha256,
      });

      return res.status(201).json(result);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to store the uploaded chunk."),
      });
    }
  });

  router.post("/upload/complete", async (req, res) => {
    const parsed = parseOrRespond(fileIdBodySchema, req.body ?? {}, res);
    if (!parsed) return;
    const { fileId } = parsed;
    const formats = readFormatsOrRespond(res);
    if (!formats) return;

    let mergedFilePath = null;
    let accessScope = null;
    let finalizationClaimToken = null;
    let ingestionSucceeded = false;

    try {
      accessScope = getRequestAccessScope(req);
      const finalizationClaim =
        await uploadStore.claimUploadSessionFinalization({
          accessScope,
          fileId,
        });
      finalizationClaimToken = finalizationClaim.claimToken;
      const session = finalizationClaim.session;

      if (!session) {
        const missingSessionError = new Error("Upload session not found.");
        missingSessionError.status = 404;
        throw missingSessionError;
      }

      if (!isAcceptedUploadFileName(session.fileName, formats)) {
        await uploadStore.clearUploadSession({
          accessScope,
          fileId,
        });

        return res.status(400).json(describeRefusedUploadFileName(formats));
      }

      const storedFileName = createStoredFileName({ fileName: session.fileName, formats });
      mergedFilePath = path.join(uploadsDirectory, storedFileName);

      await uploadStore.finalizeUploadSession({
        accessScope,
        fileId,
        claimToken: finalizationClaimToken,
        destinationPath: mergedFilePath,
      });

      // The bytes decide (with PDF alone: the %PDF check and its 400).
      const checked = await checkUploadedDocument(mergedFilePath, formats);

      if (checked.refusal) {
        await uploadStore.removeMergedUpload(mergedFilePath);
        mergedFilePath = null;
        await uploadStore.clearUploadSession({
          accessScope,
          fileId,
        });

        return res.status(checked.refusal.status).json(describeDocumentRefusal(checked.refusal));
      }

      // Once ingested (or queued) the session has served its purpose; a
      // queued job owns the bytes from here on, so the claim is not released.
      const ingestion = await ingestUpload({
        accessScope,
        docId: session.sessionId,
        fileName: session.fileName,
        filePath: mergedFilePath,
        format: checked.format,
      });
      ingestionSucceeded = true;

      await cleanupUploadedFile(mergedFilePath);
      mergedFilePath = null;
      await runBestEffort("failed to clear an ingested upload session", () =>
        uploadStore.clearUploadSession({
          accessScope,
          fileId,
        })
      );

      return res.status(ingestion.status).json(ingestion.body);
    } catch (error) {
      await runBestEffort("failed to remove a merged upload", () =>
        uploadStore.removeMergedUpload(mergedFilePath)
      );

      if (finalizationClaimToken && !ingestionSucceeded) {
        await runBestEffort("failed to release a finalization claim", () =>
          uploadStore.releaseUploadSessionFinalization({
            accessScope,
            fileId,
            claimToken: finalizationClaimToken,
          })
        );
      }

      return res.status(error.status ?? 500).json({
        ...describeTenantStorageQuotaError(error),
        ...describeDocumentFormatErrorCode(error),
        error: serializeError(error, "Failed to finalize the uploaded PDF."),
      });
    }
  });

  router.post("/upload", upload.single("file"), bindDatabaseTenant, async (req, res) => {
    const formats = readFormatsOrRespond(res);

    if (!formats) {
      await cleanupUploadedFile(req.file?.path);
      return;
    }

    if (!req.file) {
      return res.status(400).json(describeMissingUploadFile(req, formats));
    }

    try {
      if (Object.keys(req.body ?? {}).length > 0) {
        await cleanupUploadedFile(req.file.path);

        return res.status(400).json({
          error: "Unexpected multipart fields.",
        });
      }

      if (req.file.size > MAX_DIRECT_UPLOAD_SIZE) {
        await cleanupUploadedFile(req.file.path);

        return res.status(413).json({
          error: "Uploaded file exceeds the allowed size limit.",
        });
      }

      // The bytes decide (with PDF alone: the %PDF check and its 400).
      const checked = await checkUploadedDocument(req.file.path, formats);

      if (checked.refusal) {
        await cleanupUploadedFile(req.file.path);

        return res.status(checked.refusal.status).json(describeDocumentRefusal(checked.refusal));
      }

      const ingestion = await ingestUpload({
        accessScope: getRequestAccessScope(req),
        docId: randomUUID(),
        fileName: req.file.originalname,
        filePath: req.file.path,
        format: checked.format,
      });

      await cleanupUploadedFile(req.file.path);
      return res.status(ingestion.status).json(ingestion.body);
    } catch (error) {
      await cleanupUploadedFile(req.file.path);

      return res.status(error.status ?? 500).json({
        ...describeTenantStorageQuotaError(error),
        ...describeDocumentFormatErrorCode(error),
        error: serializeError(error, "Failed to ingest uploaded PDF."),
      });
    }
  });

  // Replaces a document's content under its docId (same validation and tenant
  // scope as an upload); the document's `version` grows by one. On pgvector the
  // new chunks become visible and the old ones go in one transaction. The
  // local and Qdrant providers have no transaction to do that in, so they
  // refuse a replacement (409) rather than leave a document without chunks
  // when the write fails halfway. Sync mode answers 200 with the document
  // (409 with `superseded: true` when a newer replacement was requested
  // first), async mode 202 with a job, like an upload.
  router.put("/documents/:docId", upload.single("file"), bindDatabaseTenant, async (req, res) => {
    const parsed = parseOrRespond(docIdSchema, req.params, res);

    if (!parsed) {
      await cleanupUploadedFile(req.file?.path);
      return;
    }

    const formats = readFormatsOrRespond(res);

    if (!formats) {
      await cleanupUploadedFile(req.file?.path);
      return;
    }

    if (!req.file) {
      return res.status(400).json(describeMissingUploadFile(req, formats));
    }

    try {
      if (Object.keys(req.body ?? {}).length > 0) {
        await cleanupUploadedFile(req.file.path);

        return res.status(400).json({
          error: "Unexpected multipart fields.",
        });
      }

      if (req.file.size > MAX_DIRECT_UPLOAD_SIZE) {
        await cleanupUploadedFile(req.file.path);

        return res.status(413).json({
          error: "Uploaded file exceeds the allowed size limit.",
        });
      }

      // The bytes decide (with PDF alone: the %PDF check and its 400).
      const checked = await checkUploadedDocument(req.file.path, formats);

      if (checked.refusal) {
        await cleanupUploadedFile(req.file.path);

        return res.status(checked.refusal.status).json(describeDocumentRefusal(checked.refusal));
      }

      if (!supportsDocumentReplacement()) {
        await cleanupUploadedFile(req.file.path);

        return res.status(409).json({
          error: REPLACEMENT_NEEDS_TRANSACTION_MESSAGE,
        });
      }

      const accessScope = getRequestAccessScope(req);
      const recordReplace = (status) =>
        dataAudit.recordOutcome(req, {
          accessScope,
          actionId: DATA_ACCESS_ACTION_IDS.documentReplace,
          resourceIds: [parsed.docId],
          status,
        });

      // Another instance may have registered (or deleted) it.
      await loadDocumentsIngestedElsewhere(ragService, [parsed.docId]);

      if (!ragService.getDocument?.(parsed.docId, accessScope)) {
        await cleanupUploadedFile(req.file.path);
        await recordReplace(404);

        return res.status(404).json({
          error: "Document not found.",
        });
      }

      let ingestion;

      try {
        ingestion = await ingestUpload({
          accessScope,
          docId: parsed.docId,
          fileName: req.file.originalname,
          filePath: req.file.path,
          format: checked.format,
          kind: INGEST_JOB_KINDS.replace,
        });
      } catch (error) {
        await recordReplace(error.status ?? 500);
        throw error;
      }

      await cleanupUploadedFile(req.file.path);
      await recordReplace(ingestion.status);
      return res.status(ingestion.status).json(ingestion.body);
    } catch (error) {
      await cleanupUploadedFile(req.file.path);

      return res.status(error.status ?? 500).json({
        ...describeTenantStorageQuotaError(error),
        ...describeDocumentFormatErrorCode(error),
        error: serializeError(error, "Failed to replace the document."),
      });
    }
  });

  // Dead-letter ingest jobs: jobs whose stage ran out of attempts. Scoped to
  // the requester's tenant (another tenant's job is a 404) like every job
  // route. Listing needs admin.status.read; a requeue resumes the job at the
  // stage it died in and needs the recovery permission the task recovery
  // action uses (admin.actions.recover_tasks).
  router.get(
    "/admin/ingest-jobs/dead-letter",
    requireAdminPermission(getAdminStatusReadPermission(), {
      auditService: services.adminAuditService,
    }),
    async (req, res) => {
      const parsed = parseOrRespond(deadLetterQuerySchema, req.query ?? {}, res);
      if (!parsed) return;

      if (typeof ingestJobStore?.listDeadLetters !== "function") {
        return res.status(501).json({ error: "This ingest job store keeps no dead-letter jobs." });
      }

      try {
        const jobs = await ingestJobStore.listDeadLetters({
          accessScope: getRequestAccessScope(req),
          limit: parsed.limit ?? 50,
        });

        return res.json({ count: jobs.length, jobs: jobs.map(toDeadLetterIngestJob) });
      } catch (error) {
        return res.status(error.status ?? 500).json({
          error: serializeError(error, "Failed to list dead-letter ingest jobs."),
        });
      }
    }
  );

  router.post(
    "/admin/ingest-jobs/:jobId/requeue",
    requireAdminPermission(ADMIN_PERMISSION_IDS.adminActionRecoverTasks, {
      auditService: services.adminAuditService,
    }),
    async (req, res) => {
      const parsed = parseOrRespond(ingestJobIdSchema, req.params, res);
      if (!parsed) return;

      if (typeof ingestJobStore?.requeue !== "function") {
        return res.status(501).json({ error: "This ingest job store keeps no dead-letter jobs." });
      }

      try {
        const job = await ingestJobStore.requeue({
          accessScope: getRequestAccessScope(req),
          jobId: parsed.jobId,
        });

        if (!job) {
          return res.status(404).json({
            error: "Dead-letter ingest job not found.",
          });
        }

        return res.json({ requeued: true, job: toDeadLetterIngestJob(job) });
      } catch (error) {
        return res.status(error.status ?? 500).json({
          error: serializeError(error, "Failed to requeue the ingest job."),
        });
      }
    }
  );

  // Scoped like the document routes: another tenant's job is a 404, not a 403.
  router.get("/ingest-jobs/:jobId", async (req, res) => {
    const parsed = parseOrRespond(ingestJobIdSchema, req.params, res);
    if (!parsed) return;

    try {
      const accessScope = getRequestAccessScope(req);
      const job = await ingestJobStore.get(parsed.jobId, accessScope);

      if (!job) {
        return res.status(404).json({
          error: "Ingest job not found.",
        });
      }

      const body = toPublicIngestJob(job);

      // The worker that finished the job may run in another process, so the
      // document is read into this one before the client is told it exists.
      // body.docId is the document the job resolved to (a duplicate upload's
      // is the tenant's existing document).
      if (job.status === "succeeded") {
        await loadDocumentsIngestedElsewhere(ragService, [body.docId]);
        body.document = ragService.getDocument?.(body.docId, accessScope) ?? null;
      }

      return res.json(body);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to read the ingest job."),
      });
    }
  });

  router.use((error, req, res, next) => {
    // The upload filter or the stored file's name read an invalid
    // RAG_DOCUMENT_FORMATS (helpers.js filterUploadFile): its coded 500.
    if (isDocumentFormatSettingError(error)) {
      res.status(500).json({
        ...describeDocumentFormatErrorCode(error),
        error: serializeError(error, "The accepted document formats are misconfigured."),
      });
      return;
    }

    if (!(error instanceof multer.MulterError)) {
      next(error);
      return;
    }

    if (error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: "Uploaded file exceeds the allowed size limit.",
      });
      return;
    }

    res.status(400).json({
      error: "Failed to process uploaded file.",
    });
  });

  return router;
};
