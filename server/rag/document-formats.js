// The document formats an archive can hold -- PDF, Word .docx, PowerPoint
// .pptx and Excel .xlsx -- and the one check that decides which a file is,
// from its bytes alone: never from its name or a client's MIME type.
//
//   PDF   '%PDF' within the first 1024 bytes (the PDF spec's allowance), as
//         every entry point has checked since the first upload route. When
//         any Office format is enabled, a file that begins with a ZIP local
//         header or an OLE2 header is never a PDF, whatever follows.
//   OOXML a ZIP at offset 0 whose package names its main part (the
//         officeDocument relationship of _rels/.rels) with the .docx, .pptx or
//         .xlsx main content type of [Content_Types].xml. The archive guard
//         (rag/office/zip-guard.js) reads it first, so every refusal of a zip
//         bomb or an entity bomb happens here, at the upload check.
//   OLE2  a .doc/.ppt/.xls, or any password-protected Office file: refused.
//
// With RAG_DOCUMENT_FORMATS=pdf the check is exactly the old one (reserved
// prefixes refused, '%PDF' in the first 1024 bytes, "The uploaded file is not
// a valid PDF." with no code): no ZIP is opened, nothing else is refused.
import { open, readFile } from "node:fs/promises";

import { DOCUMENT_FORMATS, getDocumentFormats } from "./config.js";
import {
  createArchiveInvalidError,
  createDisabledFormatError,
  createLegacyOfficeError,
  createNotValidPdfError,
  createOfficeVariantError,
  createUnsupportedDocumentError,
} from "./document-format-errors.js";
import { TENANT_ENCRYPTION_ERROR_CODES } from "./kms/errors.js";
import { assertOfficeXmlWithinLimit, scanOfficeArchive, startsWithZipLocalHeader } from "./office/zip-guard.js";
import { isWorkingFileEnvelope, readWorkingFile, startsWithReservedFileMagic } from "./working-files.js";

export {
  DOCUMENT_FORMATS,
  DOCUMENT_FORMATS_INVALID_CODE,
  OFFICE_LIMIT_INVALID_CODE,
  assertDocumentFormatSettings,
  getDocumentFormats,
  getOfficeMaxCompressionRatio,
  getOfficeMaxTextChars,
  getOfficeMaxUncompressedBytes,
  getOfficeMaxXmlBytes,
  getOfficeMaxZipEntries,
  getXlsxMaxCells,
} from "./config.js";
export {
  DOCUMENT_FORMAT_ERROR_CODES,
  DocumentFormatError,
  NO_EXTRACTABLE_TEXT_MESSAGES,
  NOT_A_VALID_PDF_MESSAGE,
  UNSUPPORTED_DOCUMENT_MESSAGE,
  createNoExtractableTextError,
  isDocumentFormatError,
} from "./document-format-errors.js";

export const OFFICE_DOCUMENT_FORMATS = Object.freeze(["docx", "pptx", "xlsx"]);

export const DOCUMENT_MIME_TYPES = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

export const DOCUMENT_EXTENSIONS = Object.freeze({
  docx: ".docx",
  pdf: ".pdf",
  pptx: ".pptx",
  xlsx: ".xlsx",
});

export const DOCUMENT_FORMAT_LABELS = Object.freeze({
  docx: "Word (.docx)",
  pdf: "PDF",
  pptx: "PowerPoint (.pptx)",
  xlsx: "Excel (.xlsx)",
});

// The content type of each format's main part in [Content_Types].xml.
export const OOXML_MAIN_CONTENT_TYPES = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
});

export const OLE2_HEADER = Object.freeze([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export const PDF_MAGIC = Buffer.from("%PDF");
// The PDF spec allows the %PDF header to appear within the first 1024 bytes.
export const PDF_MAGIC_SCAN_WINDOW = 1024;

// MIME types compare without regard to case.
const FORMAT_BY_MAIN_CONTENT_TYPE = new Map(
  Object.entries(OOXML_MAIN_CONTENT_TYPES).map(([format, contentType]) => [contentType.toLowerCase(), format])
);

const FORMAT_BY_MIME_TYPE = new Map(Object.entries(DOCUMENT_MIME_TYPES).map(([format, mimeType]) => [mimeType, format]));

const startsWithBytes = (bytes, signature) =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

export const startsWithOle2Header = (bytes) =>
  (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) && startsWithBytes(bytes, OLE2_HEADER);

/**
 * The format ids of a list (RAG_DOCUMENT_FORMATS order, duplicates dropped).
 * A programming error, not a setting: anything but a non-empty list of known
 * ids throws a TypeError.
 */
export const normalizeDocumentFormats = (formats) => {
  const list = formats === undefined || formats === null ? null : [...formats];

  if (!list || list.length === 0 || list.some((format) => !DOCUMENT_FORMATS.includes(format))) {
    throw new TypeError(`Document formats must be a non-empty list of ${DOCUMENT_FORMATS.join(", ")}.`);
  }

  return Object.freeze(DOCUMENT_FORMATS.filter((format) => list.includes(format)));
};

/** Whether `formats` (normalized) enable any Office format: detection then reads more than the PDF rule. */
export const enablesOfficeFormats = (formats) => formats.some((format) => format !== "pdf");

/** The format a stored MIME type names, or null. */
export const getDocumentFormatForMimeType = (mimeType) =>
  FORMAT_BY_MIME_TYPE.get(String(mimeType ?? "").trim().toLowerCase()) ?? null;

/** The format a file name's extension names (any case), or null. Bytes still decide. */
export const getDocumentFormatForFileName = (fileName) => {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(fileName ?? ""));
  const extension = match ? `.${match[1].toLowerCase()}` : "";

  return Object.keys(DOCUMENT_EXTENSIONS).find((format) => DOCUMENT_EXTENSIONS[format] === extension) ?? null;
};

/**
 * The formats a stored document is re-parsed with: its own format for an
 * Office MIME type, and PDF alone for application/pdf, a missing MIME type
 * (every document stored before Office formats) or anything else. A stored
 * PDF then goes through exactly the old path (rag/document-loader.js does no
 * detection for PDF alone), whatever its first bytes.
 */
export const resolveStoredDocumentFormats = (mimeType) => {
  const format = getDocumentFormatForMimeType(mimeType);

  return Object.freeze([format && format !== "pdf" ? format : "pdf"]);
};

// The ZIP parts the format check itself needs: none beyond the two package
// parts the guard always keeps ([Content_Types].xml and _rels/.rels).
const noExtraParts = () => false;

const classifyPackage = (description, formats) => {
  if (!description.hasContentTypes) {
    throw createUnsupportedDocumentError();
  }

  const { mainPart } = description;

  if (!mainPart) {
    // An Office package that does not name its main part is broken; any
    // other ZIP with a content types part is something else.
    if (description.declaresMainContentType) {
      throw createArchiveInvalidError("the package does not name its main part");
    }

    throw createUnsupportedDocumentError();
  }

  const contentType = mainPart.contentType.toLowerCase();
  const format = FORMAT_BY_MAIN_CONTENT_TYPE.get(contentType);

  if (!format) {
    // A main-part type of another Office kind (macro-enabled, template, slide
    // show, Visio, an add-in, a binary workbook) is a variant; a main part
    // with no Office type at all is a broken package.
    if (contentType.includes(".main+xml") || contentType.endsWith(".main")) {
      throw createOfficeVariantError();
    }

    throw createArchiveInvalidError("the main document part has no Office content type");
  }

  if (!mainPart.exists) {
    throw createArchiveInvalidError("the main document part is missing");
  }

  if (!formats.includes(format)) {
    throw createDisabledFormatError(DOCUMENT_FORMAT_LABELS[format]);
  }

  return format;
};

const describeFormat = (format) => ({ format, mimeType: DOCUMENT_MIME_TYPES[format] });

/**
 * Detection with what it read: { format, mimeType, archive } where `archive`
 * is the guard's scan of an Office file (rag/office/zip-guard.js
 * scanOfficeArchive: parts kept, partSizes, readPart) and null for a PDF.
 * `keep` and `observe` go to the guard, so a loader gets its parts from the
 * same single inflation; `limits` override the guard's settings, and
 * maxXmlBytes RAG_OFFICE_MAX_XML_BYTES for a Word document or a deck
 * (assertOfficeXmlWithinLimit). Throws the refusals detectDocumentFormat
 * throws.
 */
export const inspectDocumentBytes = async (
  bytes,
  { formats = getDocumentFormats(), keep = noExtraParts, observe = null, limits } = {}
) => {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError("Document detection needs the file's bytes as a Buffer.");
  }

  const enabled = normalizeDocumentFormats(formats);
  const head = bytes.subarray(0, PDF_MAGIC_SCAN_WINDOW);

  if (!enablesOfficeFormats(enabled)) {
    // The check every entry point ran before Office formats, unchanged.
    if (!startsWithReservedFileMagic(head) && head.includes(PDF_MAGIC)) {
      return { ...describeFormat("pdf"), archive: null };
    }

    throw createNotValidPdfError();
  }

  // Plaintext that begins with an envelope's or a working file's magic would
  // be read as a damaged envelope by every later reader (rag/working-files.js).
  if (startsWithReservedFileMagic(head)) {
    throw createUnsupportedDocumentError();
  }

  if (startsWithZipLocalHeader(bytes)) {
    const archive = await scanOfficeArchive(bytes, { keep, limits, observe });
    const format = classifyPackage(archive.package, enabled);

    // At the upload check already, so a Word document or a deck its parser
    // could not hold in memory is refused before it is stored or queued.
    assertOfficeXmlWithinLimit(archive, format, limits);

    return { ...describeFormat(format), archive };
  }

  if (startsWithOle2Header(bytes)) {
    throw createLegacyOfficeError();
  }

  if (head.includes(PDF_MAGIC)) {
    if (!enabled.includes("pdf")) {
      throw createDisabledFormatError(DOCUMENT_FORMAT_LABELS.pdf);
    }

    return { ...describeFormat("pdf"), archive: null };
  }

  throw createUnsupportedDocumentError();
};

/**
 * The format of a file's plaintext bytes: { format, mimeType }, or one of the
 * coded refusals of rag/document-format-errors.js (400 unsupported -- with
 * RAG_DOCUMENT_FORMATS=pdf the old "not a valid PDF" without a code -- 415
 * disabled, legacy Office, Office variant; 413/400 from the archive guard).
 * `formats` defaults to the RAG_DOCUMENT_FORMATS setting.
 */
export const detectDocumentFormat = async (bytes, options = {}) => {
  const { format, mimeType } = await inspectDocumentBytes(bytes, options);

  return { format, mimeType };
};

const readHead = async (filePath) => {
  const handle = await open(filePath, "r");

  try {
    const head = Buffer.alloc(PDF_MAGIC_SCAN_WINDOW);
    const { bytesRead } = await handle.read(head, 0, PDF_MAGIC_SCAN_WINDOW, 0);

    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/**
 * A file's plaintext as detection needs it: { bytes, complete }. The first
 * 1024 bytes, except for an encrypted working file (TENANT_ENCRYPTION=on),
 * which is read and decrypted whole, and a ZIP when an Office format is
 * enabled, which is read whole for the archive guard. A working file this
 * process cannot decrypt is no supported document (as routes/helpers.js
 * hasPdfMagicBytes has it): `bytes` is null.
 */
export const readDocumentBytesForDetection = async (filePath, { formats = getDocumentFormats() } = {}) => {
  const enabled = normalizeDocumentFormats(formats);
  const head = await readHead(filePath);

  if (isWorkingFileEnvelope(head)) {
    try {
      return { bytes: await readWorkingFile(filePath), complete: true };
    } catch (error) {
      if (error?.code === TENANT_ENCRYPTION_ERROR_CODES.workingFileUnreadable) {
        return { bytes: null, complete: true };
      }

      throw error;
    }
  }

  if (enablesOfficeFormats(enabled) && startsWithZipLocalHeader(head)) {
    return { bytes: await readFile(filePath), complete: true };
  }

  return { bytes: head, complete: false };
};

/**
 * detectDocumentFormat for a file on disk (an upload's working file, an
 * archive-ingest source): { format, mimeType } or the coded refusals. Reads
 * the way routes/helpers.js hasPdfMagicBytes reads -- the first 1024 bytes,
 * the whole decrypted file for an encrypted working file -- plus the whole
 * file for a ZIP when an Office format is enabled. A working file this
 * process cannot decrypt is refused as no supported document.
 */
export const detectDocumentFormatAtPath = async (filePath, { formats = getDocumentFormats(), limits } = {}) => {
  const enabled = normalizeDocumentFormats(formats);
  const { bytes } = await readDocumentBytesForDetection(filePath, { formats: enabled });

  if (bytes === null) {
    throw enablesOfficeFormats(enabled) ? createUnsupportedDocumentError() : createNotValidPdfError();
  }

  return detectDocumentFormat(bytes, { formats: enabled, limits });
};
