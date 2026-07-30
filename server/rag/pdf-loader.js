import { readFile } from "node:fs/promises";
import {
  getDocument,
  version as pdfJsVersion,
  VerbosityLevel,
} from "pdfjs-dist/legacy/build/pdf.mjs";

const normalizePageText = (text = "") =>
  String(text)
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const renderPdfPageText = async (pageData) => {
  const textContent = await pageData.getTextContent({
    disableNormalization: false,
  });
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
  } = {}
) => {
  const dataBuffer = await readFile(filePath);
  const pages = [];
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
        const text = await renderPdfPageText(pageData);
        pages.push({
          pageNumber,
          text: normalizePageText(text),
        });
      } finally {
        pageData.cleanup();
      }
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

export const loadPdfPages = async (filePath) =>
  (await loadPdfDocument(filePath)).pages;
