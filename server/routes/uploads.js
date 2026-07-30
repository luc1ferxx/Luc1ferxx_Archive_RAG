import { Router } from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
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
  const { ragService, uploadStore, uploadsDirectory } = services;
  const runBestEffort = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      console.error(`[upload-cleanup] ${label}`, error);
    }
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
      fileSize: MAX_DIRECT_UPLOAD_SIZE + 1,
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
      // Busboy marks a file as truncated when it reaches its transport limit.
      // Keep that limit one byte above the public maximum; the store remains
      // authoritative for the declared and actual chunk geometry.
      fileSize: MAX_CHUNK_UPLOAD_SIZE + 1,
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

  router.post("/upload/chunk", chunkUpload.single("chunk"), async (req, res) => {
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

      const document = await ragService.ingestDocument({
        docId: session.sessionId,
        filePath: mergedFilePath,
        fileName: session.fileName,
        ownerUserId: accessScope.userId,
        workspaceId: accessScope.workspaceId,
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

      return res.status(201).json(document);
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

  router.post("/upload", upload.single("file"), async (req, res) => {
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

      const accessScope = getRequestAccessScope(req);
      const document = await ragService.ingestDocument({
        docId: randomUUID(),
        filePath: req.file.path,
        fileName: req.file.originalname,
        ownerUserId: accessScope.userId,
        workspaceId: accessScope.workspaceId,
      });

      await cleanupUploadedFile(req.file.path);
      return res.status(201).json(document);
    } catch (error) {
      await cleanupUploadedFile(req.file.path);

      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to ingest uploaded PDF."),
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
