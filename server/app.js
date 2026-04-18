import express from "express";
import cors from "cors";
import { mkdir, rm } from "fs/promises";
import multer from "multer";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import chat, {
  clearDocuments,
  clearSessionMemory,
  deleteDocument,
  getDocument,
  ingestDocument,
  listDocuments,
} from "./chat.js";
import chatMCP from "./chat-mcp.js";
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

const buildChatResponse = async ({ ragService, webChatService, question, docIds, sessionId }) => {
  const missingDocIds = docIds.filter((docId) => !ragService.getDocument(docId));

  if (missingDocIds.length > 0) {
    const error = new Error(
      `Document not found for docId(s): ${missingDocIds.join(
        ", "
      )}. Upload the PDF again and use the latest docId.`
    );
    error.status = 404;
    throw error;
  }

  const [ragResp, mcpResp] = await Promise.allSettled([
    ragService.chat(docIds, question, {
      sessionId,
    }),
    webChatService(question),
  ]);

  const response = {
    ragAnswer:
      ragResp.status === "fulfilled"
        ? ragResp.value.text
        : `RAG unavailable: ${serializeError(
            ragResp.reason,
            "Unable to answer from the document."
          )}`,
    ragSources:
      ragResp.status === "fulfilled" ? ragResp.value.citations ?? [] : [],
    ragResolvedQuestion:
      ragResp.status === "fulfilled"
        ? ragResp.value.resolvedQuery ?? question
        : question,
    ragMemoryApplied:
      ragResp.status === "fulfilled" ? Boolean(ragResp.value.memoryApplied) : false,
    mcpAnswer:
      mcpResp.status === "fulfilled"
        ? mcpResp.value.text
        : `Web search unavailable: ${serializeError(
            mcpResp.reason,
            "Unable to answer from web search."
          )}`,
    errors: {
      rag:
        ragResp.status === "rejected"
          ? serializeError(ragResp.reason, "Unable to answer from the document.")
          : null,
      mcp:
        mcpResp.status === "rejected"
          ? serializeError(mcpResp.reason, "Unable to answer from web search.")
          : null,
    },
  };

  return {
    status: ragResp.status === "rejected" && mcpResp.status === "rejected" ? 502 : 200,
    body: response,
  };
};

export const createApp = async (options = {}) => {
  const uploadsDirectory = options.uploadsDirectory
    ? path.resolve(options.uploadsDirectory)
    : defaultUploadsDirectory;

  if (options.uploadSessionDirectory) {
    configureUploadSessionDirectory(options.uploadSessionDirectory);
  }

  const ragService = options.ragService ?? {
    chat,
    clearDocuments,
    clearSessionMemory,
    deleteDocument,
    getDocument,
    ingestDocument,
    listDocuments,
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

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use("/uploads", express.static(uploadsDirectory));

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

  app.get("/documents", (req, res) => {
    return res.json(ragService.listDocuments());
  });

  app.delete("/documents/:docId", async (req, res) => {
    const docId = req.params.docId?.trim();

    if (!docId) {
      return res.status(400).json({
        error: "docId is required.",
      });
    }

    try {
      const document = await ragService.deleteDocument(docId);

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
      const documents = await ragService.clearDocuments();
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

  app.delete("/sessions/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId?.trim();

    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId is required.",
      });
    }

    return res.json({
      cleared: ragService.clearSessionMemory(sessionId),
    });
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

      await uploadStore.finalizeUploadSession({
        fileId,
        destinationPath: mergedFilePath,
      });

      const document = await ragService.ingestDocument({
        docId: randomUUID(),
        filePath: mergedFilePath,
        fileName: session.fileName,
      });

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
      const document = await ragService.ingestDocument({
        docId: randomUUID(),
        filePath: req.file.path,
        fileName: req.file.originalname,
      });

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

    if (!question) {
      return res.status(400).json({
        error: "Question is required.",
      });
    }

    if (docIds.length === 0) {
      return res.status(400).json({
        error: "At least one docId is required. Upload a PDF before asking a question.",
      });
    }

    try {
      const response = await buildChatResponse({
        ragService,
        webChatService,
        question,
        docIds,
        sessionId,
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
