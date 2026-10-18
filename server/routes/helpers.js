import { randomUUID } from "crypto";
import { open, rm } from "fs/promises";
import path from "path";

import { resolveRequestUserId } from "../auth.js";
import { isWorkingFileEnvelope, readWorkingFile } from "../rag/working-files.js";
import { isSafeUploadFileName } from "../upload-policy.js";

export {
  DEFAULT_UPLOAD_CHUNK_SIZE,
  MAX_CHUNK_UPLOAD_SIZE,
  MAX_DIRECT_UPLOAD_SIZE,
} from "../upload-policy.js";

export const PDF_MAGIC = Buffer.from("%PDF");
// The PDF spec allows the %PDF header to appear within the first 1024 bytes.
export const PDF_MAGIC_SCAN_WINDOW = 1024;

export const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

// /chat checks docIds before this runs (routes/validation.js boundedIdList);
// /agent-tasks does not, so an entry that is not a string is dropped here
// instead of throwing.
export const parseDocIds = (rawDocIds, fallbackDocId) => {
  if (Array.isArray(rawDocIds)) {
    return [
      ...new Set(
        rawDocIds
          .map((docId) => (typeof docId === "string" ? docId.trim() : ""))
          .filter(Boolean)
      ),
    ];
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

export const createStoredFileName = () => `${randomUUID()}.pdf`;

export const isPdfFile = (file) => {
  const originalName = String(file.originalname ?? "");
  const extension = path.extname(originalName).toLowerCase();
  const mimeType = String(file.mimetype ?? "").toLowerCase();

  return (
    isSafeUploadFileName(originalName) &&
    (extension === ".pdf" || mimeType === "application/pdf")
  );
};

export const isPdfFileName = (fileName) =>
  isSafeUploadFileName(fileName) &&
  path.extname(String(fileName)).toLowerCase() === ".pdf";

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
    const head = headBuffer.subarray(0, bytesRead);

    // An encrypted working file (TENANT_ENCRYPTION=on): its plaintext decides.
    if (isWorkingFileEnvelope(head)) {
      return (await readWorkingFile(filePath)).subarray(0, PDF_MAGIC_SCAN_WINDOW).includes(PDF_MAGIC);
    }

    return head.includes(PDF_MAGIC);
  } finally {
    await fileHandle.close();
  }
};

// The request headers that select whose data a response carries: the
// credential (Authorization, x-api-key) and the workspace and user a request
// names (x-workspace-id; x-user-id where the principal may choose its user,
// and always with auth off).
export const TENANT_DATA_VARY_HEADERS = Object.freeze([
  "Authorization",
  "x-api-key",
  "x-workspace-id",
  "x-user-id",
]);

/**
 * Marks a response as one tenant's data. `no-store` keeps it out of every
 * cache, shared (a CDN or proxy in front of the API, which would otherwise
 * serve one tenant's document list or PDF to the next caller of the same URL)
 * and private (a browser profile whose user switches workspace or token);
 * `Vary` names the identity headers for any cache that ignores `no-store`.
 * Set before the handler answers, so errors carry it too.
 */
export const setTenantDataCacheHeaders = (res) => {
  res.setHeader("Cache-Control", "private, no-store");

  for (const header of TENANT_DATA_VARY_HEADERS) {
    res.vary(header);
  }

  return res;
};

export const noStoreTenantData = (req, res, next) => {
  setTenantDataCacheHeaders(res);
  next();
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
  // Every file this sends is one tenant's (a stored PDF, a workspace
  // artifact). It used to allow private caching for five minutes, which kept
  // the bytes in a browser cache keyed by URL alone.
  setTenantDataCacheHeaders(res);

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

// The user a route acts for. The decision lives in auth.js
// (resolveRequestUserId): an authenticated request acts for the user its
// credential resolved to and never for a body or query userId of its own.
export const resolveScopedUserId = (req, rawUserId) =>
  resolveRequestUserId(req, rawUserId);
