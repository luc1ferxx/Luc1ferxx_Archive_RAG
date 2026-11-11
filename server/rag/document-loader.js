// The one place a stored or uploaded document becomes pages, whatever its
// format: the bytes decide (rag/document-formats.js), never the file name.
//
//   PDF   loadPdfPages(filePath), exactly as every caller called it before
//         Office formats: PDF_PARSER, page routing, the worker pool and the PDF
//         metrics apply unchanged. `parse` is { paragraphDetection, pdfParser }
//         read the way the staged ingest's parse stage reads it
//         (describePdfParseSettings, just before the parse).
//   DOCX  mammoth (rag/office/docx-loader.js), pages per section.
//   XLSX  SheetJS (rag/office/xlsx-loader.js), pages per visible worksheet,
//         read from a workbook rebuilt out of the parts the guard verified.
//   PPTX  the PPTX reader (rag/office/pptx-loader.js), pages per slide, given
//         the package's ppt/**/*.xml and ppt/**/*.rels parts, _rels/.rels
//         and [Content_Types].xml exactly as the archive guard inflated
//         them, and the presentation part the guard classified.
//   Office `parse` is { format, extractor, extractorVersion }.
//
// Every Office file goes through the archive guard first (rag/office/
// zip-guard.js), once: the scan that decides the format also keeps the PPTX
// parts, and RAG_OFFICE_MAX_XML_BYTES and RAG_OFFICE_MAX_TEXT_CHARS bound what
// each parser reads and writes.
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
import {
  DOCUMENT_FORMATS,
  getDocumentFormats,
  getOfficeMaxTextChars,
  getOfficeMaxXmlBytes,
  getXlsxMaxCells,
} from "./config.js";
import { createUnsupportedDocumentError, isDocumentFormatError } from "./document-format-errors.js";
import {
  DOCUMENT_MIME_TYPES,
  detectDocumentFormat,
  enablesOfficeFormats,
  inspectDocumentBytes,
  normalizeDocumentFormats,
  readDocumentBytesForDetection,
} from "./document-formats.js";
import { loadPdfPages } from "./pdf-loader.js";

export const PPTX_EXTRACTOR = "ooxml-pptx";

/**
 * The parts the PPTX reader is handed: ppt/**\/*.xml, ppt/**\/*.rels,
 * [Content_Types].xml and _rels/.rels (it names the presentation part).
 */
export const isPptxReaderPart = (name) => {
  const lower = name.toLowerCase();

  return (
    lower === "[content_types].xml" || lower === "_rels/.rels" || (/^ppt\//i.test(name) && /\.(?:xml|rels)$/i.test(name))
  );
};

// The Office readers are imported when a file of their format arrives, so a
// process that only ever reads PDFs never loads mammoth or SheetJS (about
// 30 ms of start-up together, measured).
const importPptxReaderModule = () => import("./office/pptx-loader.js");

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

// The page contract every Office loader keeps (feedback records and workspace
// artifacts store page numbers): a loader that breaks it is a bug, never a
// page to index.
const assertOfficePages = (pages, format) => {
  const valid =
    Array.isArray(pages) &&
    pages.every(
      (page) =>
        page &&
        Number.isSafeInteger(page.pageNumber) &&
        page.pageNumber > 0 &&
        typeof page.text === "string" &&
        (page.locationUnit === undefined || typeof page.locationUnit === "string") &&
        (page.locationLabel === undefined || typeof page.locationLabel === "string")
    );

  if (!valid) {
    throw new Error(`The ${format} reader returned pages outside the page contract.`);
  }

  return pages;
};

const loadOfficePages = async ({ archive, buffer, format, importPptxReader }) => {
  const maxTextChars = getOfficeMaxTextChars();

  if (format === "docx") {
    const { DOCX_EXTRACTOR, extractDocxPages, getMammothVersion } = await import("./office/docx-loader.js");

    return {
      pages: await extractDocxPages(buffer, { maxTextChars }),
      parse: { format, extractor: DOCX_EXTRACTOR, extractorVersion: getMammothVersion() },
    };
  }

  if (format === "xlsx") {
    const { XLSX_EXTRACTOR, extractXlsxPagesFromArchive, getSheetjsVersion } = await import("./office/xlsx-loader.js");

    return {
      pages: await extractXlsxPagesFromArchive(archive, {
        maxCells: getXlsxMaxCells(),
        maxTextChars,
        maxXmlBytes: getOfficeMaxXmlBytes(),
      }),
      parse: { format, extractor: XLSX_EXTRACTOR, extractorVersion: getSheetjsVersion() },
    };
  }

  const reader = await importPptxReader();
  const parts = new Map([...archive.parts].filter(([name]) => isPptxReaderPart(name)));

  return {
    pages: await reader.extractPptxPages(parts, { maxTextChars, presentationPart: archive.package.mainPart.name }),
    parse: { format, extractor: PPTX_EXTRACTOR, extractorVersion: reader.PPTX_EXTRACTOR_VERSION },
  };
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
 *   importPptxReader  () => the PPTX reader module (tests stand one in)
 * Office refusals: the archive guard's 413/400, 413
 * DOCUMENT_SPREADSHEET_TOO_LARGE, 400 DOCUMENT_ARCHIVE_INVALID for a file the
 * Office parser cannot read. Pages without text are left to the chunk stage
 * (its 422).
 */
export const loadDocumentPages = async (
  filePath,
  { formats = DOCUMENT_FORMATS, importPptxReader = importPptxReaderModule } = {}
) => {
  const enabled = normalizeDocumentFormats(formats);

  if (!enablesOfficeFormats(enabled)) {
    return loadPdf(filePath);
  }

  const { bytes } = await readDocumentBytesForDetection(filePath, { formats: enabled });

  if (bytes === null) {
    // An encrypted working file another process wrote.
    throw createUnsupportedDocumentError();
  }

  const { archive, format, mimeType } = await inspectDocumentBytes(bytes, {
    formats: enabled,
    keep: isPptxReaderPart,
  });

  if (format === "pdf") {
    return loadPdf(filePath);
  }

  // An Office file begins with a ZIP header, which detection read whole.
  const { pages, parse } = await loadOfficePages({
    archive,
    buffer: bytes,
    format,
    importPptxReader,
  });

  return { format, mimeType, pages: assertOfficePages(pages, format), parse };
};
