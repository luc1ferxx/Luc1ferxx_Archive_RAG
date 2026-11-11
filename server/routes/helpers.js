import { randomUUID } from "crypto";
import { open, rm } from "fs/promises";
import path from "path";

import { resolveRequestUserId } from "../auth.js";
import {
  DOCUMENT_FORMATS_INVALID_CODE,
  OFFICE_LIMIT_INVALID_CODE,
} from "../rag/config.js";
import {
  DOCUMENT_FORMAT_ERROR_CODES,
  UNSUPPORTED_DOCUMENT_MESSAGE,
  isDocumentFormatError,
} from "../rag/document-format-errors.js";
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MIME_TYPES,
  detectDocumentFormatAtPath,
  enablesOfficeFormats,
  getDocumentFormatForMimeType,
  getDocumentFormats,
  normalizeDocumentFormats,
} from "../rag/document-formats.js";
import { TENANT_ENCRYPTION_ERROR_CODES } from "../rag/kms/errors.js";
import {
  isWorkingFileEnvelope,
  readWorkingFile,
  startsWithReservedFileMagic,
} from "../rag/working-files.js";
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

// ---------------------------------------------------------------------------
// The document formats an upload may be (RAG_DOCUMENT_FORMATS)
//
// Every entry point that takes new bytes -- POST /upload, the chunked upload,
// PUT /documents/:docId, the async enqueue behind them, archive-ingest --
// checks them the same way: the name or the client's MIME type is a first
// filter, the bytes decide (rag/document-formats.js). With
// RAG_DOCUMENT_FORMATS=pdf every check, message and stored file name below is
// exactly the one each entry point had before Office formats (isPdfFile,
// isPdfFileName, hasPdfMagicBytes, "<uuid>.pdf").
// ---------------------------------------------------------------------------

/**
 * The formats new bytes may be: RAG_DOCUMENT_FORMATS. Throws its coded error
 * (RAG_DOCUMENT_FORMATS_INVALID) for a value changed to an invalid one after
 * the start; createAppServices refuses one at the start.
 */
export const getUploadDocumentFormats = () => getDocumentFormats();

/** Whether `error` is an invalid RAG_DOCUMENT_FORMATS or RAG_OFFICE_* / RAG_XLSX_MAX_CELLS value. */
export const isDocumentFormatSettingError = (error) =>
  error?.code === DOCUMENT_FORMATS_INVALID_CODE || error?.code === OFFICE_LIMIT_INVALID_CODE;

// The supported format a file name's extension names (any case; the extension
// as path.extname reads it, as isPdfFileName does), or null.
const getFormatOfFileExtension = (fileName) => {
  const extension = path.extname(String(fileName ?? "")).toLowerCase();

  return Object.keys(DOCUMENT_EXTENSIONS).find((format) => DOCUMENT_EXTENSIONS[format] === extension) ?? null;
};

/**
 * The stored (working) file name of an upload: "<uuid>.pdf" with PDF alone,
 * as it always was; otherwise "<uuid>" and the extension of the format the
 * original name names (else the client's MIME type, else .pdf). The bytes
 * still decide what the file is.
 */
export const createStoredFileName = ({ fileName = null, mimeType = null, formats = null } = {}) => {
  const enabled = normalizeDocumentFormats(formats ?? getUploadDocumentFormats());

  if (!enablesOfficeFormats(enabled)) {
    return `${randomUUID()}.pdf`;
  }

  const format = getFormatOfFileExtension(fileName) ?? getDocumentFormatForMimeType(mimeType) ?? "pdf";

  return `${randomUUID()}${DOCUMENT_EXTENSIONS[format]}`;
};

/**
 * The upload filter (multer's fileFilter, filterUploadFile below): with PDF
 * alone exactly isPdfFile; with an Office format enabled a safe name
 * whose extension, or a client MIME type, names any supported format. Every
 * supported one, not only the enabled ones: the byte check then answers a
 * format the setting disables with 415 DOCUMENT_FORMAT_DISABLED, which says
 * more than a refusal of the name would.
 */
export const isAcceptedUploadFile = (file, formats = getUploadDocumentFormats()) => {
  const enabled = normalizeDocumentFormats(formats);

  if (!enablesOfficeFormats(enabled)) {
    return isPdfFile(file);
  }

  const originalName = String(file.originalname ?? "");

  return (
    isSafeUploadFileName(originalName) &&
    (getFormatOfFileExtension(originalName) !== null || getDocumentFormatForMimeType(file.mimetype) !== null)
  );
};

/**
 * The name check of the chunked upload and archive-ingest: isPdfFileName with
 * PDF alone, else a safe name with any supported extension (the bytes decide,
 * as for the upload filter).
 */
export const isAcceptedUploadFileName = (fileName, formats = getUploadDocumentFormats()) => {
  const enabled = normalizeDocumentFormats(formats);

  if (!enablesOfficeFormats(enabled)) {
    return isPdfFileName(fileName);
  }

  return isSafeUploadFileName(fileName) && getFormatOfFileExtension(fileName) !== null;
};

// Set on a request whose file the upload filter dropped, so the route can
// tell a refused file from a missing one.
const UPLOAD_FILE_REFUSED = Symbol("uploadFileRefused");

/**
 * multer's fileFilter over isAcceptedUploadFile. An invalid setting fails the
 * request with its coded error (the uploads router's error handler answers
 * it) instead of accepting or dropping the file under some other set.
 */
export const filterUploadFile = (req, file, cb) => {
  let accepted;

  try {
    accepted = isAcceptedUploadFile(file);
  } catch (error) {
    cb(error);
    return;
  }

  if (!accepted) {
    req[UPLOAD_FILE_REFUSED] = true;
  }

  cb(null, accepted);
};

/**
 * The 400 body of an upload without a file: with PDF alone the one it always
 * was; otherwise the refusal of a file the filter dropped (its name and MIME
 * type name no supported format), or a plain "no file".
 */
export const describeMissingUploadFile = (req, formats = getUploadDocumentFormats()) => {
  if (!enablesOfficeFormats(normalizeDocumentFormats(formats))) {
    return { error: "A PDF file is required." };
  }

  return req?.[UPLOAD_FILE_REFUSED] === true
    ? { code: DOCUMENT_FORMAT_ERROR_CODES.unsupported, error: UNSUPPORTED_DOCUMENT_MESSAGE }
    : { error: "A document file is required." };
};

/** The 400 body of a chunked upload whose file name isAcceptedUploadFileName refuses. */
export const describeRefusedUploadFileName = (formats = getUploadDocumentFormats()) =>
  enablesOfficeFormats(normalizeDocumentFormats(formats))
    ? { code: DOCUMENT_FORMAT_ERROR_CODES.unsupported, error: UNSUPPORTED_DOCUMENT_MESSAGE }
    : { error: "Only PDF files are supported." };

/**
 * The byte check of an upload (rag/document-formats.js
 * detectDocumentFormatAtPath): { format, mimeType }, or { refusal } -- the
 * DocumentFormatError a route answers with its status and
 * describeDocumentRefusal's body. With PDF alone it is exactly
 * hasPdfMagicBytes and its 400 "not a valid PDF" without a code. Anything
 * else (a read error, an invalid setting) is thrown.
 */
export const checkUploadedDocument = async (filePath, formats = getUploadDocumentFormats()) => {
  try {
    return await detectDocumentFormatAtPath(filePath, { formats });
  } catch (error) {
    if (isDocumentFormatError(error)) {
      return { refusal: error };
    }

    throw error;
  }
};

/** A refusal's JSON body: its message, and its code when it has one. */
export const describeDocumentRefusal = (error) => ({
  ...(typeof error?.code === "string" && error.code ? { code: error.code } : {}),
  error: error.message,
});

/**
 * The `code` an upload route's error body adds for a coded document refusal
 * thrown past the byte check (an Office loader's 413 or 400 during a
 * synchronous ingest) or an invalid format setting; nothing for any other
 * error, so every other body stays as it was.
 */
export const describeDocumentFormatErrorCode = (error) =>
  (isDocumentFormatError(error) || isDocumentFormatSettingError(error)) &&
  typeof error.code === "string" &&
  error.code
    ? { code: error.code }
    : {};

/**
 * How GET /documents/:docId/file serves a stored document: a PDF (or a
 * document without a MIME type, as every PDF was stored) inline, as it always
 * was; anything else -- a Word, PowerPoint or Excel document -- as a
 * download, since a browser shows none of them inline.
 */
export const resolveDocumentFileDisposition = (mimeType) => {
  const normalized = String(mimeType ?? "").trim().toLowerCase();

  return !normalized || normalized === DOCUMENT_MIME_TYPES.pdf ? "inline" : "attachment";
};

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
    let head = headBuffer.subarray(0, bytesRead);

    // An encrypted working file (TENANT_ENCRYPTION=on): its plaintext decides.
    // One this process cannot decrypt is plaintext that merely begins with
    // the working-file magic (an upload with TENANT_ENCRYPTION=off): no PDF.
    if (isWorkingFileEnvelope(head)) {
      try {
        head = (await readWorkingFile(filePath)).subarray(0, PDF_MAGIC_SCAN_WINDOW);
      } catch (error) {
        if (error?.code === TENANT_ENCRYPTION_ERROR_CODES.workingFileUnreadable) {
          return false;
        }

        throw error;
      }
    }

    // Plaintext that begins with an envelope's or a working file's magic is
    // refused like any other non-PDF (rag/working-files.js).
    return !startsWithReservedFileMagic(head) && head.includes(PDF_MAGIC);
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
