import { randomUUID } from "crypto";
import { open, rm } from "fs/promises";
import path from "path";

import { getRequestAccessScope } from "../auth.js";

export const DEFAULT_UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
export const MAX_DIRECT_UPLOAD_SIZE = 50 * 1024 * 1024;
export const MAX_CHUNK_UPLOAD_SIZE = 5 * 1024 * 1024;

export const PDF_MAGIC = Buffer.from("%PDF");
// The PDF spec allows the %PDF header to appear within the first 1024 bytes.
export const PDF_MAGIC_SCAN_WINDOW = 1024;

export const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

export const parseDocIds = (rawDocIds, fallbackDocId) => {
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

export const normalizeBooleanQuery = (value) =>
  String(value ?? "").trim().toLowerCase() === "true";

export const buildTriggerDispatchRequest = (req) => {
  const payload = req.body ?? {};
  const request = {
    ...(payload.request && typeof payload.request === "object"
      ? payload.request
      : {}),
  };
  const idempotencyKey =
    request.id ??
    payload.idempotencyKey ??
    req.get("x-idempotency-key") ??
    req.get("x-request-id");

  if (idempotencyKey !== undefined) {
    request.id = String(idempotencyKey).trim();
  }

  return {
    event: payload.event,
    input: payload.input ?? payload.payload ?? payload,
    mode: payload.mode,
    payload: payload.payload,
    request,
  };
};

export const cleanupUploadedFile = async (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    await rm(filePath, { force: true });
  } catch (cleanupError) {
    console.error(`Failed to remove uploaded file at ${filePath}.`, cleanupError);
  }
};

export const createStoredFileName = (originalFileName) => {
  const extension = path.extname(originalFileName);
  const baseName = path.basename(originalFileName, extension);
  return `${baseName}-${randomUUID()}${extension}`;
};

export const isPdfFile = (file) => {
  const extension = path.extname(file.originalname ?? "").toLowerCase();
  const mimeType = String(file.mimetype ?? "").toLowerCase();

  return extension === ".pdf" || mimeType === "application/pdf";
};

export const isPdfFileName = (fileName) =>
  path.extname(String(fileName ?? "")).toLowerCase() === ".pdf";

export const hasPdfMagicBytes = async (filePath) => {
  const fileHandle = await open(filePath, "r");

  try {
    const headBuffer = Buffer.alloc(PDF_MAGIC_SCAN_WINDOW);
    const { bytesRead } = await fileHandle.read(
      headBuffer,
      0,
      PDF_MAGIC_SCAN_WINDOW,
      0
    );

    return headBuffer.subarray(0, bytesRead).includes(PDF_MAGIC);
  } finally {
    await fileHandle.close();
  }
};

export const buildContentDisposition = (
  fileName = "document.pdf",
  disposition = "inline"
) => `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`;

export const sendBufferedFile = ({
  req,
  res,
  fileBuffer,
  fileName,
  mimeType,
  disposition = "inline",
}) => {
  const totalSize = fileBuffer.byteLength;
  const rangeHeader = req.headers.range?.trim();

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mimeType || "application/pdf");
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(fileName, disposition)
  );
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

export const resolveScopedUserId = (req, rawUserId) =>
  getRequestAccessScope(req).userId || rawUserId?.trim() || "";
