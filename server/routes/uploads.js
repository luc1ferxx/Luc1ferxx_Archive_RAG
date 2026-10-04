import { Router } from "express";
import { readFile } from "fs/promises";
import multer from "multer";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { z } from "zod";

import { bindDatabaseTenant, getRequestAccessScope } from "../auth.js";
import { ADMIN_PERMISSION_IDS } from "../rag/admin-permissions.js";
import {
  getAdminStatusReadPermission,
  requireAdminPermission,
} from "../rag/admin-authorization.js";
import { isRagIngestAsync, isRagIngestDedupEnabled } from "../rag/config.js";
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
  MAX_UPLOAD_MULTIPART_FIELD_BYTES,
  MAX_UPLOAD_MULTIPART_FIELDS,
} from "../upload-policy.js";

import {
  cleanupUploadedFile,
  createStoredFileName,
  DEFAULT_UPLOAD_CHUNK_SIZE,
  hasPdfMagicBytes,
  isPdfFile,
  isPdfFileName,
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
  const ingestUpload = async ({ accessScope, docId, fileName, filePath, kind = INGEST_JOB_KINDS.create }) => {
    const fileBytes = await readFile(filePath);
    const contentSha256 = createHash("sha256").update(fileBytes).digest("hex");
    const deduplicate = kind === INGEST_JOB_KINDS.create && isRagIngestDedupEnabled();

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

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDirectory);
    },
    filename: (req, file, cb) => {
      cb(null, createStoredFileName());
    },
  });

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
    fileFilter: (req, file, cb) => {
      cb(null, isPdfFile(file));
    },
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
    if (req.body?.fileName != null && !isPdfFileName(req.body.fileName)) {
      return res.status(400).json({
        error: "Only PDF files are supported.",
      });
    }

    try {
      const accessScope = getRequestAccessScope(req);
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
      return res.status(error.status ?? 500).json({
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

      if (!isPdfFileName(session.fileName)) {
        await uploadStore.clearUploadSession({
          accessScope,
          fileId,
        });

        return res.status(400).json({
          error: "Only PDF files are supported.",
        });
      }

      const storedFileName = createStoredFileName();
      mergedFilePath = path.join(uploadsDirectory, storedFileName);

      await uploadStore.finalizeUploadSession({
        accessScope,
        fileId,
        claimToken: finalizationClaimToken,
        destinationPath: mergedFilePath,
      });

      if (!(await hasPdfMagicBytes(mergedFilePath))) {
        await uploadStore.removeMergedUpload(mergedFilePath);
        mergedFilePath = null;
        await uploadStore.clearUploadSession({
          accessScope,
          fileId,
        });

        return res.status(400).json({
          error: "The uploaded file is not a valid PDF.",
        });
      }

      // Once ingested (or queued) the session has served its purpose; a
      // queued job owns the bytes from here on, so the claim is not released.
      const ingestion = await ingestUpload({
        accessScope,
        docId: session.sessionId,
        fileName: session.fileName,
        filePath: mergedFilePath,
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
        error: serializeError(error, "Failed to finalize the uploaded PDF."),
      });
    }
  });

  router.post("/upload", upload.single("file"), bindDatabaseTenant, async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "A PDF file is required.",
      });
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

      if (!(await hasPdfMagicBytes(req.file.path))) {
        await cleanupUploadedFile(req.file.path);

        return res.status(400).json({
          error: "The uploaded file is not a valid PDF.",
        });
      }

      const ingestion = await ingestUpload({
        accessScope: getRequestAccessScope(req),
        docId: randomUUID(),
        fileName: req.file.originalname,
        filePath: req.file.path,
      });

      await cleanupUploadedFile(req.file.path);
      return res.status(ingestion.status).json(ingestion.body);
    } catch (error) {
      await cleanupUploadedFile(req.file.path);

      return res.status(error.status ?? 500).json({
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

    if (!req.file) {
      return res.status(400).json({
        error: "A PDF file is required.",
      });
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

      if (!(await hasPdfMagicBytes(req.file.path))) {
        await cleanupUploadedFile(req.file.path);

        return res.status(400).json({
          error: "The uploaded file is not a valid PDF.",
        });
      }

      if (!supportsDocumentReplacement()) {
        await cleanupUploadedFile(req.file.path);

        return res.status(409).json({
          error: REPLACEMENT_NEEDS_TRANSACTION_MESSAGE,
        });
      }

      const accessScope = getRequestAccessScope(req);

      // Another instance may have registered (or deleted) it.
      await loadDocumentsIngestedElsewhere(ragService, [parsed.docId]);

      if (!ragService.getDocument?.(parsed.docId, accessScope)) {
        await cleanupUploadedFile(req.file.path);

        return res.status(404).json({
          error: "Document not found.",
        });
      }

      const ingestion = await ingestUpload({
        accessScope,
        docId: parsed.docId,
        fileName: req.file.originalname,
        filePath: req.file.path,
        kind: INGEST_JOB_KINDS.replace,
      });

      await cleanupUploadedFile(req.file.path);
      return res.status(ingestion.status).json(ingestion.body);
    } catch (error) {
      await cleanupUploadedFile(req.file.path);

      return res.status(error.status ?? 500).json({
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
