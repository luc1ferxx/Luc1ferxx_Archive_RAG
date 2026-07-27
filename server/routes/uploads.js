import { Router } from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";

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

export const createUploadsRouter = (services) => {
  const router = Router();
  const { ragService, uploadStore, uploadsDirectory } = services;

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDirectory);
    },
    filename: (req, file, cb) => {
      cb(null, createStoredFileName(file.originalname));
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: MAX_DIRECT_UPLOAD_SIZE,
    },
    fileFilter: (req, file, cb) => {
      cb(null, isPdfFile(file));
    },
  });
  const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_CHUNK_UPLOAD_SIZE,
    },
  });

  router.post("/upload/init", async (req, res) => {
    if (req.body?.fileName != null && !isPdfFileName(req.body.fileName)) {
      return res.status(400).json({
        error: "Only PDF files are supported.",
      });
    }

    try {
      const session = await uploadStore.initializeUploadSession({
        fileId: req.body.fileId,
        fileName: req.body.fileName,
        fileSize: req.body.fileSize,
        lastModified: req.body.lastModified,
        totalChunks: req.body.totalChunks,
        chunkSize: req.body.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE,
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
      const session = await uploadStore.getUploadSessionStatus(fileId);

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
      const chunkIndex = Number.parseInt(req.body.chunkIndex, 10);
      const totalChunks = Number.parseInt(req.body.totalChunks, 10);
      const parsed = parseOrRespond(fileIdBodySchema, req.body ?? {}, res);
      if (!parsed) return;
      const { fileId } = parsed;

      const result = await uploadStore.storeUploadChunk({
        fileId,
        chunkIndex,
        totalChunks,
        chunkBuffer: req.file.buffer,
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

    try {
      const session = await uploadStore.getUploadSessionStatus(fileId);

      if (!session) {
        return res.status(404).json({
          error: "Upload session not found.",
        });
      }

      if (!isPdfFileName(session.fileName)) {
        await uploadStore.clearUploadSession(fileId);

        return res.status(400).json({
          error: "Only PDF files are supported.",
        });
      }

      const storedFileName = createStoredFileName(session.fileName);
      mergedFilePath = path.join(uploadsDirectory, storedFileName);
      const accessScope = getRequestAccessScope(req);

      await uploadStore.finalizeUploadSession({
        fileId,
        destinationPath: mergedFilePath,
      });

      if (!(await hasPdfMagicBytes(mergedFilePath))) {
        await uploadStore.removeMergedUpload(mergedFilePath);
        mergedFilePath = null;
        await uploadStore.clearUploadSession(fileId);

        return res.status(400).json({
          error: "The uploaded file is not a valid PDF.",
        });
      }

      const document = await ragService.ingestDocument({
        docId: randomUUID(),
        filePath: mergedFilePath,
        fileName: session.fileName,
        ownerUserId: accessScope.userId,
        workspaceId: accessScope.workspaceId,
      });

      await cleanupUploadedFile(mergedFilePath);
      mergedFilePath = null;
      await uploadStore.clearUploadSession(fileId);

      return res.status(201).json(document);
    } catch (error) {
      await uploadStore.removeMergedUpload(mergedFilePath);

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

  return router;
};
