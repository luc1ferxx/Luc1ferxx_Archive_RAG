// An Office file's bytes as pages: the archive guard's detection
// (rag/document-formats.js inspectDocumentBytes) and then the reader of the
// format it found. rag/document-loader.js runs this in the calling thread or,
// with RAG_OFFICE_PARSE_WORKERS > 0, on a worker of rag/office-parse-pool.js
// (rag/office-parse-worker.js runs the same function), so this module must
// never load pdf.js: a PDF is only recognized here and read by the caller.
//
//   DOCX  mammoth (docx-loader.js), pages per section.
//   XLSX  SheetJS (xlsx-loader.js), pages per visible worksheet, read from a
//         workbook rebuilt out of the parts the guard verified.
//   PPTX  the PPTX reader (pptx-loader.js), pages per slide, given the
//         package's ppt/**/*.xml and ppt/**/*.rels parts, _rels/.rels and
//         [Content_Types].xml exactly as the archive guard inflated them, and
//         the presentation part the guard classified.
//   `parse` is { format, extractor, extractorVersion }.
//
// The guard runs once here: the scan that decides the format also keeps the
// PPTX parts, and RAG_OFFICE_MAX_XML_BYTES and RAG_OFFICE_MAX_TEXT_CHARS bound
// what each parser reads and writes.
import { getOfficeMaxTextChars, getOfficeMaxXmlBytes, getXlsxMaxCells } from "../config.js";
import { inspectDocumentBytes } from "../document-formats.js";

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
export const importPptxReaderModule = () => import("./pptx-loader.js");

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
    const { DOCX_EXTRACTOR, assertDocxXmlNesting, extractDocxPages, getMammothVersion } = await import(
      "./docx-loader.js"
    );

    await assertDocxXmlNesting(archive);

    return {
      pages: await extractDocxPages(buffer, { maxTextChars }),
      parse: { format, extractor: DOCX_EXTRACTOR, extractorVersion: getMammothVersion() },
    };
  }

  if (format === "xlsx") {
    const { XLSX_EXTRACTOR, extractXlsxPagesFromArchive, getSheetjsVersion } = await import("./xlsx-loader.js");

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

/**
 * A document's plaintext bytes (a Buffer) of one of `formats` (which names an
 * Office format) as { format, mimeType, pages, parse }, or { format: "pdf",
 * mimeType } when the bytes are a PDF, which the caller reads with pdf.js.
 * Throws the refusals of inspectDocumentBytes and the Office loaders (rag/
 * document-format-errors.js). `importPptxReader` stands in for the PPTX
 * reader module (tests).
 */
export const parseDocumentBytes = async (bytes, { formats, importPptxReader = importPptxReaderModule } = {}) => {
  const { archive, format, mimeType } = await inspectDocumentBytes(bytes, { formats, keep: isPptxReaderPart });

  if (format === "pdf") {
    return { format, mimeType };
  }

  const { pages, parse } = await loadOfficePages({ archive, buffer: bytes, format, importPptxReader });

  return { format, mimeType, pages: assertOfficePages(pages, format), parse };
};
