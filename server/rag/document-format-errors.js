// The refusals of a document's bytes: the format check every entry point runs
// (rag/document-formats.js), the Office archive guard (rag/office/zip-guard.js)
// and the Office loaders. Each is a DocumentFormatError with an HTTP `status`,
// a stable `code` and a short message that never quotes the file: no part
// names, no text, only the setting a limit comes from. `expose: true`: the
// message is meant for the client that sent the file.
//
// One refusal has no code: with RAG_DOCUMENT_FORMATS=pdf the format check is
// the one every entry point ran before Office formats existed, and it answers
// with that check's message and nothing more.

export const DOCUMENT_FORMAT_ERROR_CODES = Object.freeze({
  // A ZIP entry that is encrypted, has an unsafe name or an unsupported
  // compression method, a directory that disagrees with itself or with the
  // local headers, a DTD in an XML part, a package without its main part, a
  // workbook number format longer than Excel allows or repeating its text
  // placeholder, or bytes the Office parser cannot read.
  archiveInvalid: "DOCUMENT_ARCHIVE_INVALID",
  // Too many entries, or more inflated bytes (declared or actual), a higher
  // compression ratio, more XML for one parser or more extracted text than
  // RAG_OFFICE_MAX_* allow, or a package part over the guard's fixed cap.
  archiveTooLarge: "DOCUMENT_ARCHIVE_TOO_LARGE",
  // A format the bytes are, which RAG_DOCUMENT_FORMATS leaves out.
  disabled: "DOCUMENT_FORMAT_DISABLED",
  // An OLE2 compound file: a .doc, .ppt or .xls, or any password-protected
  // Office file (encryption wraps the package in OLE2).
  legacyOffice: "DOCUMENT_FORMAT_LEGACY_OFFICE",
  // An Office package of another kind: macro-enabled, a template, a slide
  // show, or another Office format (Visio, add-ins, binary workbooks).
  officeVariant: "DOCUMENT_FORMAT_OFFICE_VARIANT",
  // More non-empty cells across the visible sheets than RAG_XLSX_MAX_CELLS
  // (or, before SheetJS parses them, more than twice that in cell elements).
  spreadsheetTooLarge: "DOCUMENT_SPREADSHEET_TOO_LARGE",
  // Bytes that are none of the enabled formats.
  unsupported: "DOCUMENT_FORMAT_UNSUPPORTED",
});

export class DocumentFormatError extends Error {
  constructor(message, { code = null, status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DocumentFormatError";
    this.status = status;
    this.expose = true;

    // No `code` key at all for the refusal that predates the codes.
    if (code) {
      this.code = code;
    }
  }
}

export const isDocumentFormatError = (error) => error instanceof DocumentFormatError;

// The message every entry point answered for a non-PDF before Office formats.
export const NOT_A_VALID_PDF_MESSAGE = "The uploaded file is not a valid PDF.";

export const UNSUPPORTED_DOCUMENT_MESSAGE =
  "The uploaded file is not a supported document (PDF, Word .docx, PowerPoint .pptx or Excel .xlsx).";

export const LEGACY_OFFICE_MESSAGE =
  "Legacy or password-protected Office files are not supported; save the file as .docx, .pptx or .xlsx without a password.";

export const OFFICE_VARIANT_MESSAGE =
  "Only Word .docx, PowerPoint .pptx and Excel .xlsx documents are supported: macro-enabled files, templates, slide shows and other Office file types are not; save the file as a .docx, .pptx or .xlsx document.";

export const createNotValidPdfError = () => new DocumentFormatError(NOT_A_VALID_PDF_MESSAGE, { status: 400 });

export const createUnsupportedDocumentError = () =>
  new DocumentFormatError(UNSUPPORTED_DOCUMENT_MESSAGE, {
    code: DOCUMENT_FORMAT_ERROR_CODES.unsupported,
    status: 400,
  });

export const createDisabledFormatError = (label) =>
  new DocumentFormatError(`${label} documents are not accepted by this server (RAG_DOCUMENT_FORMATS).`, {
    code: DOCUMENT_FORMAT_ERROR_CODES.disabled,
    status: 415,
  });

export const createLegacyOfficeError = () =>
  new DocumentFormatError(LEGACY_OFFICE_MESSAGE, {
    code: DOCUMENT_FORMAT_ERROR_CODES.legacyOffice,
    status: 415,
  });

export const createOfficeVariantError = () =>
  new DocumentFormatError(OFFICE_VARIANT_MESSAGE, {
    code: DOCUMENT_FORMAT_ERROR_CODES.officeVariant,
    status: 415,
  });

/** 413: `reason` says which limit, e.g. "it holds more than 10000 entries (RAG_OFFICE_MAX_ZIP_ENTRIES)". */
export const createArchiveTooLargeError = (reason) =>
  new DocumentFormatError(`The document is too large to read: ${reason}.`, {
    code: DOCUMENT_FORMAT_ERROR_CODES.archiveTooLarge,
    status: 413,
  });

/**
 * 400: `reason` says what is wrong without quoting the file, e.g. "an entry
 * is encrypted". `cause` keeps a library's own error (its message may quote
 * the file, so it never becomes this one's).
 */
export const createArchiveInvalidError = (reason, { cause } = {}) =>
  new DocumentFormatError(`The document cannot be read: ${reason}.`, {
    cause,
    code: DOCUMENT_FORMAT_ERROR_CODES.archiveInvalid,
    status: 400,
  });

export const createSpreadsheetTooLargeError = (maxCells) =>
  new DocumentFormatError(
    `The workbook is too large to read: its visible sheets hold more than ${maxCells} non-empty cells (RAG_XLSX_MAX_CELLS); split it into smaller workbooks.`,
    {
      code: DOCUMENT_FORMAT_ERROR_CODES.spreadsheetTooLarge,
      status: 413,
    }
  );

// The 422 an ingest answers when the pages hold no text (rag/index.js
// chunkDocumentPages): unchanged for PDF, "document" for every other format.
export const NO_EXTRACTABLE_TEXT_MESSAGES = Object.freeze({
  document: "No extractable text was found in the uploaded document.",
  pdf: "No extractable text was found in the uploaded PDF.",
});

/** The 422 for pages without text, worded for `format` (PDF unless an Office format is named). */
export const createNoExtractableTextError = (format = "pdf") => {
  // The PDF error is exactly the one rag/index.js throws today: a plain Error
  // with a status and nothing else.
  const error = new Error(
    format === "docx" || format === "pptx" || format === "xlsx"
      ? NO_EXTRACTABLE_TEXT_MESSAGES.document
      : NO_EXTRACTABLE_TEXT_MESSAGES.pdf
  );

  error.status = 422;
  return error;
};
