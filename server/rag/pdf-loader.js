import { readFile } from "node:fs/promises";
import path from "node:path";
// Must stay above the pdfjs import: it installs globals that pdfjs reads while
// evaluating its own module body, and sibling static imports run in source order.
// Moving or sorting this line breaks single-file executable builds. See the file
// itself for why pdfjs needs the help.
import "./pdf-runtime-shim.js";
import {
  getDocument,
  version as pdfJsVersion,
  VerbosityLevel,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  getDoclingFallback,
  getPdfParser,
  isPdfParagraphDetectionEnabled,
} from "./config.js";
import { loadPdfPagesWithDocling } from "./docling-parser.js";
import {
  buildHyphenationVocabulary,
  buildPdfTextLines,
  renderPdfParagraphText,
} from "./pdf-paragraphs.js";

const normalizePageText = (text = "") =>
  String(text)
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const readPdfPageTextContent = (pageData) =>
  pageData.getTextContent({
    disableNormalization: false,
  });

const renderPdfPageText = async (pageData) => {
  const textContent = await readPdfPageTextContent(pageData);
  let text = "";
  let lastY = null;

  for (const item of textContent.items) {
    const y = item.transform?.[5];
    const value = item.str ?? "";

    if (!value) {
      continue;
    }

    if (lastY === null || lastY === y) {
      text += value;
    } else {
      text += `\n${value}`;
    }

    lastY = y;
  }

  return text;
};

const resolvePageLimit = ({ maxPages, pageCount }) => {
  if (maxPages === undefined || maxPages === null || maxPages === 0) {
    return pageCount;
  }

  if (!Number.isInteger(maxPages) || maxPages < 0) {
    throw new TypeError("maxPages must be a non-negative integer.");
  }

  return Math.min(maxPages, pageCount);
};

export const loadPdfDocument = async (
  filePath,
  {
    maxPages = 0,
    includeMetadata = false,
    // PDF_PARAGRAPH_DETECTION: rebuild paragraphs from line geometry
    // (pdf-paragraphs.js). Off keeps the legacy one-line-per-"\n" text.
    paragraphDetection = isPdfParagraphDetectionEnabled(),
  } = {}
) => {
  const dataBuffer = await readFile(filePath);
  const pages = [];
  const pageLines = [];
  let pageCount = 0;
  let info = null;
  const loadingTask = getDocument({
    data: new Uint8Array(dataBuffer),
    isEvalSupported: false,
    verbosity: VerbosityLevel.ERRORS,
  });

  try {
    const document = await loadingTask.promise;
    pageCount = document.numPages;
    const renderedPageCount = resolvePageLimit({
      maxPages,
      pageCount,
    });

    for (
      let pageNumber = 1;
      pageNumber <= renderedPageCount;
      pageNumber += 1
    ) {
      const pageData = await document.getPage(pageNumber);

      try {
        if (paragraphDetection) {
          const textContent = await readPdfPageTextContent(pageData);
          pageLines.push(buildPdfTextLines(textContent.items));
          pages.push({ pageNumber, text: "" });
        } else {
          const text = await renderPdfPageText(pageData);
          pages.push({
            pageNumber,
            text: normalizePageText(text),
          });
        }
      } finally {
        pageData.cleanup();
      }
    }

    if (paragraphDetection) {
      // A line-end hyphen is judged against the whole document's spelling.
      const vocabulary = buildHyphenationVocabulary(pageLines);
      pages.forEach((page, index) => {
        page.text = renderPdfParagraphText(pageLines[index], { vocabulary });
      });
    }

    if (includeMetadata) {
      const metadata = await document.getMetadata();
      info = metadata.info ?? null;
    }
  } finally {
    await loadingTask.destroy();
  }

  return {
    pages,
    pageCount,
    renderedPageCount: pages.length,
    pdfVersion: pdfJsVersion,
    info,
  };
};

// Every ingest path reads pages through here, so PDF_PARSER applies to
// uploads, archive ingest and vector:reindex alike.
export const loadPdfPages = async (filePath) => {
  if (getPdfParser() !== "docling") {
    return (await loadPdfDocument(filePath)).pages;
  }

  try {
    return await loadPdfPagesWithDocling(filePath);
  } catch (error) {
    if (getDoclingFallback() === "none") {
      throw error;
    }

    console.warn(`${error.message} Parsing ${path.basename(filePath)} with pdf.js instead (DOCLING_FALLBACK=pdfjs).`);
    return (await loadPdfDocument(filePath)).pages;
  }
};
