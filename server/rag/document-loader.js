// The one place a stored or uploaded document becomes pages, whatever its
// format: the bytes decide (rag/document-formats.js), never the file name.
//
//   PDF   loadPdfPages(filePath), exactly as every caller called it before
//         Office formats: PDF_PARSER, page routing, the worker pool and the PDF
//         metrics apply unchanged. `parse` is { paragraphDetection, pdfParser }
//         read the way the staged ingest's parse stage reads it
//         (describePdfParseSettings, just before the parse).
//   DOCX, XLSX, PPTX  rag/office/office-document-pages.js parseDocumentBytes:
//         the archive guard (rag/office/zip-guard.js), once, then mammoth,
//         SheetJS or the PPTX reader. `parse` is { format, extractor,
//         extractorVersion }.
//
// The file is read (and decrypted, for a TENANT_ENCRYPTION working file) in
// the calling thread. A file that begins with a ZIP header, which only an
// Office file can be when an Office format is enabled, is then parsed on a
// worker of rag/office-parse-pool.js (RAG_OFFICE_PARSE_WORKERS, 1 by default)
// running the same parseDocumentBytes, so a large document no longer holds the
// event loop and a parse that runs out of memory ends a worker, not the
// process. With RAG_OFFICE_PARSE_WORKERS=0, or a stand-in PPTX reader (tests),
// it runs in the calling thread as before.
//
// `formats` defaults to every supported format: the re-parse paths (index
// builds, vector:reindex, trash restore) read stored documents of any format
// whatever RAG_DOCUMENT_FORMATS says, and queued ingest jobs too, except that
// a PDF-only server reads every file its PDF check passes as a PDF
// (resolveQueuedDocumentFormats). With `formats` naming PDF alone there is no
// detection at all: the file goes to loadPdfPages as before
// (resolveStoredDocumentFormats gives that list for a stored PDF, so its
// re-parse is the old one whatever its first bytes).
import { describePdfParseSettings } from "./chunk-profile.js";
import { DOCUMENT_FORMATS, getDocumentFormats, getOfficeParseWorkers } from "./config.js";
import { createUnsupportedDocumentError, isDocumentFormatError } from "./document-format-errors.js";
import {
  DOCUMENT_MIME_TYPES,
  detectDocumentFormat,
  enablesOfficeFormats,
  normalizeDocumentFormats,
  readDocumentBytesForDetection,
} from "./document-formats.js";
import { runOfficeParseTask } from "./office-parse-pool.js";
import { parseDocumentBytes } from "./office/office-document-pages.js";
import { startsWithZipLocalHeader } from "./office/zip-guard.js";
import { loadPdfPages } from "./pdf-loader.js";

export { PPTX_EXTRACTOR, isPptxReaderPart } from "./office/office-document-pages.js";

const loadPdf = async (filePath) => {
  // The settings loadPdfPages parses with; an invalid PDF_PARSER makes both
  // throw, and the loader's error is the one that surfaces.
  let parse = null;

  try {
    parse = describePdfParseSettings();
  } catch {
    // loadPdfPages below throws the same setting's error.
  }

  const pages = await loadPdfPages(filePath);

  return { format: "pdf", mimeType: DOCUMENT_MIME_TYPES.pdf, pages, parse };
};

const PDF_ONLY = Object.freeze(["pdf"]);

/**
 * The formats a queued ingest job's file is read with (the staged parse
 * stage, the worker's one-step ingest). A job is read whatever format it is,
 * whatever RAG_DOCUMENT_FORMATS says now: its enqueue checked the bytes
 * against the setting of its time. One kind of file the bytes alone cannot
 * settle: one that begins with a ZIP or OLE2 header and holds '%PDF' in its
 * first 1024 bytes passes the check RAG_DOCUMENT_FORMATS=pdf runs, so a
 * PDF-only server queues it as a PDF, while with an Office format enabled it
 * is an Office file or refused. So while the setting is PDF alone, a file
 * that passes the PDF check is read as the PDF it was queued as, exactly as
 * before Office formats, and never reaches an Office parser; anything else
 * was queued while Office formats were enabled and is read as what it is.
 */
export const resolveQueuedDocumentFormats = async (filePath) => {
  if (enablesOfficeFormats(getDocumentFormats())) {
    return DOCUMENT_FORMATS;
  }

  const { bytes } = await readDocumentBytesForDetection(filePath, { formats: PDF_ONLY });

  if (bytes === null) {
    return DOCUMENT_FORMATS;
  }

  try {
    await detectDocumentFormat(bytes, { formats: PDF_ONLY });
    return PDF_ONLY;
  } catch (error) {
    if (isDocumentFormatError(error)) {
      return DOCUMENT_FORMATS;
    }

    throw error;
  }
};

/**
 * A document file's pages: { pages, format, mimeType, parse }.
 *   filePath  a working file (rag/working-files.js; decrypted here when
 *             TENANT_ENCRYPTION wrote it encrypted)
 *   formats   the formats this read accepts (default: every supported one);
 *             bytes of another format are refused with the coded errors of
 *             rag/document-format-errors.js
 *   fileName  the document's name: callers may pass it, but the bytes alone
 *             decide the format, so it changes nothing
 *   importPptxReader  () => the PPTX reader module (tests stand one in; the
 *             parse then stays in the calling thread)
 * Office refusals: the archive guard's 413/400, 413
 * DOCUMENT_SPREADSHEET_TOO_LARGE, 400 DOCUMENT_ARCHIVE_INVALID for a file the
 * Office parser cannot read, and 413 DOCUMENT_ARCHIVE_TOO_LARGE for one whose
 * parse ran its worker out of memory; OFFICE_PARSE_* (rag/office-parse-pool.js)
 * when a worker crashed (500), timed out (504) or was stopped (503). Pages
 * without text are left to the chunk stage (its 422).
 */
export const loadDocumentPages = async (filePath, { formats = DOCUMENT_FORMATS, importPptxReader } = {}) => {
  const enabled = normalizeDocumentFormats(formats);

  if (!enablesOfficeFormats(enabled)) {
    return loadPdf(filePath);
  }

  const { bytes } = await readDocumentBytesForDetection(filePath, { formats: enabled });

  if (bytes === null) {
    // An encrypted working file another process wrote.
    throw createUnsupportedDocumentError();
  }

  // An Office file begins with a ZIP header, which detection read whole.
  const workers = importPptxReader === undefined ? getOfficeParseWorkers() : 0;
  const parsed =
    workers > 0 && startsWithZipLocalHeader(bytes)
      ? await runOfficeParseTask(bytes, { formats: enabled }, { size: workers })
      : await parseDocumentBytes(bytes, { formats: enabled, importPptxReader });

  return parsed.format === "pdf" ? loadPdf(filePath) : parsed;
};
