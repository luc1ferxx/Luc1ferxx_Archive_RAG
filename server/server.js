import "dotenv/config";
import express from "express";
import cors from "cors";
import { mkdir, rm } from "fs/promises";
import multer from "multer";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import chat, { getDocument, ingestDocument } from "./chat.js";
import chatMCP from "./chat-mcp.js";
import {
  clearUploadSession,
  ensureUploadStorage,
  finalizeUploadSession,
  getUploadSessionStatus,
  initializeUploadSession,
  removeMergedUpload,
  storeUploadChunk,
} from "./upload-session-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDirectory = path.join(__dirname, "uploads");
const DEFAULT_UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;

const app = express();
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(uploadsDirectory));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDirectory);
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, extension);
    cb(null, `${baseName}-${randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
});
const chunkUpload = multer({
  storage: multer.memoryStorage(),
});

const PORT = 5001;

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

await mkdir(uploadsDirectory, { recursive: true });
await ensureUploadStorage();

app.post("/upload/init", async (req, res) => {
  try {
    const session = await initializeUploadSession({
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
    const session = await getUploadSessionStatus(fileId);

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

    const result = await storeUploadChunk({
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
    const session = await getUploadSessionStatus(fileId);

    if (!session) {
      return res.status(404).json({
        error: "Upload session not found.",
      });
    }

    const storedFileName = createStoredFileName(session.fileName);
    mergedFilePath = path.join(uploadsDirectory, storedFileName);

    await finalizeUploadSession({
      fileId,
      destinationPath: mergedFilePath,
    });

    const document = await ingestDocument({
      docId: randomUUID(),
      filePath: mergedFilePath,
      fileName: session.fileName,
    });

    await clearUploadSession(fileId);

    return res.status(201).json(document);
  } catch (error) {
    await removeMergedUpload(mergedFilePath);

    return res.status(error.status ?? 500).json({
      error: serializeError(error, "Failed to finalize the uploaded PDF."),
    });
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "No file uploaded.",
    });
  }

  try {
    const document = await ingestDocument({
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

app.get("/chat", async (req, res) => {
  const question = req.query.question?.trim();
  const docIds = parseDocIds(req.query.docIds, req.query.docId);

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

  const missingDocIds = docIds.filter((docId) => !getDocument(docId));

  if (missingDocIds.length > 0) {
    return res.status(404).json({
      error: `Document not found for docId(s): ${missingDocIds.join(
        ", "
      )}. Upload the PDF again and use the latest docId.`,
    });
  }

  const [ragResp, mcpResp] = await Promise.allSettled([
    chat(docIds, question),
    chatMCP(question),
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
          ? serializeError(
              ragResp.reason,
              "Unable to answer from the document."
            )
          : null,
      mcp:
        mcpResp.status === "rejected"
          ? serializeError(mcpResp.reason, "Unable to answer from web search.")
          : null,
    },
  };

  if (ragResp.status === "rejected" && mcpResp.status === "rejected") {
    return res.status(502).json(response);
  }

  return res.json(response);
});

app.listen(PORT, () => {
  console.log("server is running on port " + PORT);
});
