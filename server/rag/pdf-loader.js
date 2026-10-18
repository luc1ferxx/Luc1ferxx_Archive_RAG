import path from "node:path";
// pdfjs is imported by pdf-page-extraction.js (through pdfjs-document.js),
// which imports this shim right above it: the shim installs globals pdfjs
// reads while evaluating its own module body, and sibling static imports run
// in source order. It stays first here as well, so no import added below can
// reach pdfjs ahead of it. Moving or sorting these lines breaks single-file
// executable builds. See the file itself for why pdfjs needs the help.
import "./pdf-runtime-shim.js";
import { getDoclingFallback, getPdfParser } from "./config.js";
import { loadPdfPagesWithDocling } from "./docling-parser.js";
import { recordPdfPages, recordPdfParseFallback } from "./metrics-pdf.js";
import { loadPdfPagesAuto } from "./pdf-auto-parser.js";
import { parsePdfBytesWithPdfjs } from "./pdfjs-document.js";
import { readWorkingFile } from "./working-files.js";

// { pages, pageCount, renderedPageCount, pdfVersion, info, signals? }: options
// as parsePdfBytesWithPdfjs (maxPages, includeMetadata, paragraphDetection,
// collectSignals, workers), in this thread unless PDF_PARSE_WORKERS > 0.
export const loadPdfDocument = async (filePath, options = {}) => {
  // A working file (rag/working-files.js): encrypted with TENANT_ENCRYPTION=on.
  const dataBuffer = await readWorkingFile(filePath);

  return parsePdfBytesWithPdfjs(dataBuffer, options);
};

// PDF_PARSER=pdfjs and docling route nothing: their pages count as `unrouted`.
const countUnroutedPages = (pages, parser) => {
  recordPdfPages({ count: pages.length, parser, route: "unrouted" });
  return pages;
};

// Every ingest path reads pages through here, so PDF_PARSER applies to
// uploads, archive ingest and vector:reindex alike.
export const loadPdfPages = async (filePath) => {
  const parser = getPdfParser();

  if (parser === "auto") {
    return loadPdfPagesAuto(filePath);
  }

  if (parser !== "docling") {
    return countUnroutedPages((await loadPdfDocument(filePath)).pages, "pdfjs");
  }

  try {
    return countUnroutedPages(await loadPdfPagesWithDocling(filePath), "docling");
  } catch (error) {
    if (getDoclingFallback() === "none") {
      throw error;
    }

    console.warn(`${error.message} Parsing ${path.basename(filePath)} with pdf.js instead (DOCLING_FALLBACK=pdfjs).`);

    const { pages } = await loadPdfDocument(filePath);

    recordPdfParseFallback("docling_document", pages.length);
    return countUnroutedPages(pages, "pdfjs");
  }
};
