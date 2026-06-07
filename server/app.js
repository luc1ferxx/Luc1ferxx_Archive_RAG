import express from "express";
import cors from "cors";
import { mkdir, rm } from "fs/promises";
import multer from "multer";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { getRequestAccessScope, requireApiAuth } from "./auth.js";
import chat, {
  clearDocuments,
  clearLongMemories,
  clearSessionMemory,
  deleteLongMemory,
  deleteDocument,
  getDocument,
  getDocumentFile,
  ingestDocument,
  initializeDocumentRegistry,
  initializeLongMemory,
  initializeSessionMemory,
  listDocuments,
  listLongMemories,
  rememberLongMemory,
} from "./chat.js";
import chatMCP from "./chat-mcp.js";
import {
  readLatestQualityReport,
  readQualityHistory,
  runSyntheticQualityEvaluation,
} from "./evaluation/quality-report.js";
import {
  buildFeedbackRecord,
  listFeedback,
  recordFeedback,
} from "./feedback.js";
import { buildHealthReport, runStartupHealthChecks } from "./health.js";
import { runAgentRag } from "./rag/agent.js";
import {
  clearUploadSession,
  configureUploadSessionDirectory,
  ensureUploadStorage,
  finalizeUploadSession,
  getUploadSessionStatus,
  initializeUploadSession,
  removeMergedUpload,
  storeUploadChunk,
} from "./upload-session-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultUploadsDirectory = path.join(__dirname, "uploads");

const DEFAULT_UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_DIRECT_UPLOAD_SIZE = 50 * 1024 * 1024;
const MAX_CHUNK_UPLOAD_SIZE = 5 * 1024 * 1024;

const parseDocIds = (rawDocIds, fallbackDocId) => {
  if (Array.isArray(rawDocIds)) {
    return [...new Set(rawDocIds.map((docId) => docId?.trim()).filter(Boolean))];
  }

  if (typeof rawDocIds === "string" && rawDocIds.trim()) {
    return [
      ...new Set(
        rawDocIds
          .split(",")
          .map((docId) => docId.trim())
          .filter(Boolean)
      ),
    ];
  }

  if (typeof fallbackDocId === "string" && fallbackDocId.trim()) {
    return [fallbackDocId.trim()];
  }

  return [];
};

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

const cleanupUploadedFile = async (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    await rm(filePath, { force: true });
  } catch (cleanupError) {
    console.error(`Failed to remove uploaded file at ${filePath}.`, cleanupError);
  }
};

const createStoredFileName = (originalFileName) => {
  const extension = path.extname(originalFileName);
  const baseName = path.basename(originalFileName, extension);
  return `${baseName}-${randomUUID()}${extension}`;
};

const isPdfFile = (file) => {
  const extension = path.extname(file.originalname ?? "").toLowerCase();
  const mimeType = String(file.mimetype ?? "").toLowerCase();

  return extension === ".pdf" || mimeType === "application/pdf";
};

const buildContentDisposition = (fileName = "document.pdf") =>
  `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;

const sendBufferedFile = ({ req, res, fileBuffer, fileName, mimeType }) => {
  const totalSize = fileBuffer.byteLength;
  const rangeHeader = req.headers.range?.trim();

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mimeType || "application/pdf");
  res.setHeader("Content-Disposition", buildContentDisposition(fileName));
  res.setHeader("Cache-Control", "private, max-age=300");

  if (!rangeHeader) {
    res.setHeader("Content-Length", String(totalSize));
    res.status(200).end(fileBuffer);
    return;
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);

  if (!match) {
    res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
    return;
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalSize
  ) {
    res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
    return;
  }

  const safeEnd = Math.min(end, totalSize - 1);
  const chunk = fileBuffer.subarray(start, safeEnd + 1);

  res.status(206);
  res.setHeader("Content-Length", String(chunk.byteLength));
  res.setHeader("Content-Range", `bytes ${start}-${safeEnd}/${totalSize}`);
  res.end(chunk);
};

const resolveScopedUserId = (req, rawUserId) =>
  getRequestAccessScope(req).userId || rawUserId?.trim() || "";

const buildChatResponse = async ({
  agentBudget,
  ragService,
  webChatService,
  question,
  docIds,
  sessionId,
  userId,
  accessScope,
}) => {
  const missingDocIds = docIds.filter(
    (docId) => !ragService.getDocument(docId, accessScope)
  );

  if (missingDocIds.length > 0) {
    const error = new Error(
      `Document not found for docId(s): ${missingDocIds.join(
        ", "
      )}. Upload the PDF again and use the latest docId.`
    );
    error.status = 404;
    throw error;
  }

  return runAgentRag({
    agentBudget,
    ragService,
    webChatService,
    question,
    docIds,
    sessionId,
    userId,
    accessScope,
  });
};

export const createApp = async (options = {}) => {
  const uploadsDirectory = options.uploadsDirectory
    ? path.resolve(options.uploadsDirectory)
    : defaultUploadsDirectory;

  if (options.uploadSessionDirectory) {
    configureUploadSessionDirectory(options.uploadSessionDirectory);
  }

  const ragService = {
    chat,
    clearDocuments,
    clearLongMemories,
    clearSessionMemory,
    deleteLongMemory,
    deleteDocument,
    getDocument,
    getDocumentFile,
    ingestDocument,
    initializeDocumentRegistry,
    initializeLongMemory,
    initializeSessionMemory,
    listDocuments,
    listLongMemories,
    rememberLongMemory,
    ...(options.ragService ?? {}),
  };
  const webChatService = options.chatMcp ?? chatMCP;
  const uploadStore = options.uploadStore ?? {
    clearUploadSession,
    ensureUploadStorage,
    finalizeUploadSession,
    getUploadSessionStatus,
    initializeUploadSession,
    removeMergedUpload,
    storeUploadChunk,
  };
  const healthService = options.healthService ?? {
    buildHealthReport,
    runStartupHealthChecks,
  };
  const qualityService = options.qualityService ?? {
    readLatestQualityReport,
    readQualityHistory,
    runSyntheticQualityEvaluation,
  };
  const feedbackService = options.feedbackService ?? {
    listFeedback,
    recordFeedback,
  };
  const agentBudget = options.agentBudget ?? {};

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

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

  await mkdir(uploadsDirectory, { recursive: true });
  await uploadStore.ensureUploadStorage();
  await ragService.initializeDocumentRegistry?.();
  await ragService.initializeLongMemory?.();
  await ragService.initializeSessionMemory?.();
  await healthService.runStartupHealthChecks?.();

  app.get("/health", async (req, res) => {
    try {
      const report = await healthService.buildHealthReport();
      return res.json(report);
    } catch (error) {
      return res.status(500).json({
        status: "error",
        error: serializeError(error, "Failed to collect health status."),
      });
    }
  });

  app.get("/ready", async (req, res) => {
    try {
      const report = await healthService.buildHealthReport();

      return res.status(report.status === "ok" ? 200 : 503).json(report);
    } catch (error) {
      return res.status(503).json({
        status: "error",
        error: serializeError(error, "Readiness check failed."),
      });
    }
  });

  app.use(requireApiAuth);
  app.use("/uploads", express.static(uploadsDirectory));

  app.get("/documents/:docId/file", async (req, res) => {
    const docId = req.params.docId?.trim();

    if (!docId) {
      return res.status(400).json({
        error: "docId is required.",
      });
    }

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

  app.get("/documents", (req, res) => {
    return res.json(ragService.listDocuments(getRequestAccessScope(req)));
  });

  app.delete("/documents/:docId", async (req, res) => {
    const docId = req.params.docId?.trim();

    if (!docId) {
      return res.status(400).json({
        error: "docId is required.",
      });
    }

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

  app.post("/documents/clear", async (req, res) => {
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

  app.delete("/sessions/:sessionId", async (req, res) => {
    const sessionId = req.params.sessionId?.trim();

    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId is required.",
      });
    }

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

  app.get("/memory", async (req, res) => {
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

  app.post("/memory", async (req, res) => {
    const userId = resolveScopedUserId(req, req.body.userId);
    const text = req.body.text?.trim();

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    if (!text) {
      return res.status(400).json({
        error: "text is required.",
      });
    }

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

  app.delete("/memory/:memoryId", async (req, res) => {
    const userId = resolveScopedUserId(req, req.query.userId);
    const memoryId = req.params.memoryId?.trim();

    if (!userId) {
      return res.status(400).json({
        error: "userId is required.",
      });
    }

    if (!memoryId) {
      return res.status(400).json({
        error: "memoryId is required.",
      });
    }

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

  app.delete("/memory", async (req, res) => {
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

  app.get("/quality/latest", async (req, res) => {
    try {
      return res.json(await qualityService.readLatestQualityReport());
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load the latest quality report."),
      });
    }
  });

  app.post("/quality/synthetic", async (req, res) => {
    try {
      return res.json(
        await qualityService.runSyntheticQualityEvaluation({
          corpusPath: req.body.corpusPath,
        })
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to run synthetic evaluation."),
      });
    }
  });

  app.get("/quality/history", async (req, res) => {
    try {
      return res.json(await qualityService.readQualityHistory());
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load quality history."),
      });
    }
  });

  app.get("/feedback", async (req, res) => {
    const limit = Number.parseInt(req.query.limit ?? "25", 10);

    try {
      const feedback = await feedbackService.listFeedback({
        accessScope: getRequestAccessScope(req),
        limit,
      });

      return res.json({
        feedback,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to load answer feedback."),
      });
    }
  });

  app.post("/feedback", async (req, res) => {
    try {
      const feedback = buildFeedbackRecord({
        payload: req.body,
        accessScope: getRequestAccessScope(req),
      });
      const storedFeedback = await feedbackService.recordFeedback(feedback);

      return res.status(201).json({
        feedback: storedFeedback,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to store answer feedback."),
      });
    }
  });

  app.post("/upload/init", async (req, res) => {
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

  app.get("/upload/status", async (req, res) => {
    const fileId = req.query.fileId?.trim();

    if (!fileId) {
      return res.status(400).json({
        error: "fileId is required.",
      });
    }

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

  app.post("/upload/chunk", chunkUpload.single("chunk"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "No chunk uploaded.",
      });
    }

    try {
      const chunkIndex = Number.parseInt(req.body.chunkIndex, 10);
      const totalChunks = Number.parseInt(req.body.totalChunks, 10);
      const fileId = req.body.fileId?.trim();

      if (!fileId) {
        return res.status(400).json({
          error: "fileId is required.",
        });
      }

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

  app.post("/upload/complete", async (req, res) => {
    const fileId = req.body.fileId?.trim();

    if (!fileId) {
      return res.status(400).json({
        error: "fileId is required.",
      });
    }

    let mergedFilePath = null;

    try {
      const session = await uploadStore.getUploadSessionStatus(fileId);

      if (!session) {
        return res.status(404).json({
          error: "Upload session not found.",
        });
      }

      const storedFileName = createStoredFileName(session.fileName);
      mergedFilePath = path.join(uploadsDirectory, storedFileName);
      const accessScope = getRequestAccessScope(req);

      await uploadStore.finalizeUploadSession({
        fileId,
        destinationPath: mergedFilePath,
      });

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

  app.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "A PDF file is required.",
      });
    }

    try {
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

  const handleChatRequest = async (req, res) => {
    const payload = req.method === "GET" ? req.query : req.body;
    const question = payload.question?.trim();
    const docIds = parseDocIds(payload.docIds, payload.docId);
    const sessionId = payload.sessionId?.trim() || null;
    const accessScope = getRequestAccessScope(req);
    const userId = accessScope.userId || payload.userId?.trim() || null;

    if (!question) {
      return res.status(400).json({
        error: "Question is required.",
      });
    }

    try {
      const response = await buildChatResponse({
        agentBudget,
        ragService,
        webChatService,
        question,
        docIds,
        sessionId,
        userId,
        accessScope,
      });

      return res.status(response.status).json(response.body);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to answer the question."),
      });
    }
  };

  app.get("/chat", handleChatRequest);
  app.post("/chat", handleChatRequest);

  return app;
};
