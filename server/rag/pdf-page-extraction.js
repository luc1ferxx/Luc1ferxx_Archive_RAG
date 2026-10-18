// What pdf.js reads from a range of pages, in the calling thread: the page
// text (legacy) or the visual lines pdf-paragraphs.js renders (paragraph
// detection), and, when asked, per-page signals a router can classify a page
// by (PDF_PARSER=auto). rag/pdfjs-document.js runs it in process or on the
// worker pool (rag/pdf-parse-pool.js), one page range per task, and renders
// the result with renderExtractedPages, so both paths share every line of the
// page logic.

// Must stay above the pdfjs import: it installs globals that pdfjs reads while
// evaluating its own module body, and sibling static imports run in source order.
// Moving or sorting this line breaks single-file executable builds. See the file
// itself for why pdfjs needs the help.
import "./pdf-runtime-shim.js";
import {
  AnnotationMode,
  getDocument,
  InvalidPDFException,
  OPS,
  PasswordException,
  ResponseException,
  version as pdfJsVersion,
  VerbosityLevel,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { isPdfParagraphDetectionEnabled } from "./config.js";
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

// The legacy page text: items on one baseline concatenated, a "\n" at every
// baseline change. Takes the text content already read, so the signals below
// reuse it instead of asking pdf.js twice.
const renderLegacyPageText = (textContent) => {
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

export const resolvePageLimit = ({ maxPages, pageCount }) => {
  if (maxPages === undefined || maxPages === null || maxPages === 0) {
    return pageCount;
  }

  if (!Number.isInteger(maxPages) || maxPages < 0) {
    throw new TypeError("maxPages must be a non-negative integer.");
  }

  return Math.min(maxPages, pageCount);
};

const assertPageNumber = (value, name) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
};

const openPdfDocument = (data) =>
  getDocument({
    // A copy: pdf.js may take ownership of the bytes it is handed (its
    // in-thread worker transfers them), and the caller's buffer must stay
    // as it was.
    data: new Uint8Array(data),
    isEvalSupported: false,
    verbosity: VerbosityLevel.ERRORS,
  });

// ---------------------------------------------------------------------------
// Page signals (collectSignals). Text signals come from the text content the
// page text is built from; image signals from the page's operator list, which
// costs pdf.js a pass over the content stream and the decoding of every
// image, so neither is computed unless asked for.

// The same sanitizing buildPdfTextLines (pdf-paragraphs.js) applies to an
// item's text before it counts a character.
const sanitizeItemText = (value = "") => String(value).replace(/\u0000/g, "").replace(/\r/g, "");

// A displayed equation set off from its number by a wide gap is not a table
// row: a line of exactly two runs of ink whose second is the number alone,
// "(3)", "(12)", "(4a)", or as report classes and appendices number them,
// "(2.1)", "(3-2)", "(A1)", "(A.3)". A table row is a run per cell, so one
// that ends in "212 (48)" or holds several numbers in parentheses still
// counts.
const EQUATION_NUMBER_PATTERN = /^\(\s*(?:[a-z]\.?)?\d+(?:[.\-\u2013]\d+)*[a-z]?\s*\)$/i;

const isNumberedEquationLine = (line) => line.cellCount === 2 && EQUATION_NUMBER_PATTERN.test(line.lastCellText ?? "");

const TABLE_CAPTION_PATTERNS = [
  /^(?:table|tab\.)\s*(?:\d+|[ivxlc]+)\b/i,
  /^表\s*[0-9一二三四五六七八九十]+/,
];

// A character a text layer without a usable ToUnicode map produces: the
// replacement character, a private-use code point (glyph ids passed through)
// or a C0/C1 control.
const isGarbledCodePoint = (codePoint) =>
  codePoint === 0xfffd ||
  (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
  (codePoint >= 0xf0000 && codePoint <= 0x10fffd) ||
  codePoint <= 0x1f ||
  (codePoint >= 0x7f && codePoint <= 0x9f);

const countCharacters = (text, counts) => {
  for (const character of text) {
    if (/\s/u.test(character)) {
      continue;
    }

    counts.charCount += 1;

    if (isGarbledCodePoint(character.codePointAt(0))) {
      counts.garbledCount += 1;
    }
  }

  return counts;
};

/** The share of `text`'s non-whitespace characters that are garbled (0 for none). */
export const measureGarbledCharRatio = (text = "") => {
  const { charCount, garbledCount } = countCharacters(String(text), { charCount: 0, garbledCount: 0 });

  return charCount > 0 ? garbledCount / charCount : 0;
};

export const isTableCaptionLine = (text = "") =>
  TABLE_CAPTION_PATTERNS.some((pattern) => pattern.test(String(text).trim()));

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);

// `matrix` applied after `local`, as pdf.js's Util.transform and a `cm`
// operator concatenate them.
const multiplyMatrices = (matrix, local) => [
  matrix[0] * local[0] + matrix[2] * local[1],
  matrix[1] * local[0] + matrix[3] * local[1],
  matrix[0] * local[2] + matrix[2] * local[3],
  matrix[1] * local[2] + matrix[3] * local[3],
  matrix[0] * local[4] + matrix[2] * local[5] + matrix[4],
  matrix[1] * local[4] + matrix[3] * local[5] + matrix[5],
];

const toMatrix = (values) => {
  const matrix = Array.from(values ?? [], Number);

  return matrix.length >= 6 && matrix.slice(0, 6).every(Number.isFinite) ? matrix.slice(0, 6) : null;
};

const normalizeBox = (box) => {
  const [x0, y0, x1, y1] = Array.from(box ?? [], Number);

  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
};

// An image is painted into the unit square of the matrix in force; its
// footprint is that square's axis-aligned bounding box, clipped to the page.
const clippedImageArea = (matrix, pageBox) => {
  const xs = [matrix[4], matrix[0] + matrix[4], matrix[2] + matrix[4], matrix[0] + matrix[2] + matrix[4]];
  const ys = [matrix[5], matrix[1] + matrix[5], matrix[3] + matrix[5], matrix[1] + matrix[3] + matrix[5]];
  const width = Math.min(Math.max(...xs), pageBox[2]) - Math.max(Math.min(...xs), pageBox[0]);
  const height = Math.min(Math.max(...ys), pageBox[3]) - Math.max(Math.min(...ys), pageBox[1]);

  return width > 0 && height > 0 ? width * height : 0;
};

/**
 * Image paints of an operator list ({ fnArray, argsArray }) on a page whose
 * box is `view` ([x0, y0, x1, y1], page.view). `imageCount` counts painted
 * images: the operator list merges runs of small images into one group or
 * repeat operator, and each image it paints counts once. `imageCoverage` sums
 * the clipped footprints over the page area, capped at 1; overlapping images
 * are summed, not unioned, so it is an approximation that can only err high.
 */
export const measurePageImages = ({ fnArray = [], argsArray = [] } = {}, view) => {
  const pageBox = normalizeBox(view);
  const pageArea = Math.max(0, pageBox[2] - pageBox[0]) * Math.max(0, pageBox[3] - pageBox[1]);
  const stack = [];
  let matrix = IDENTITY_MATRIX;
  let imageCount = 0;
  let paintedArea = 0;

  const paint = (local = null) => {
    imageCount += 1;
    paintedArea += clippedImageArea(local ? multiplyMatrices(matrix, local) : matrix, pageBox);
  };

  for (let index = 0; index < fnArray.length; index += 1) {
    const args = argsArray[index] ?? [];

    switch (fnArray[index]) {
      case OPS.save:
      // A transparency group's matrix is its form's own, which the
      // paintFormXObjectBegin right after it applies, so the group only
      // saves and restores (applying it here too would count it twice).
      case OPS.beginGroup:
        stack.push(matrix);
        break;
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
      case OPS.endGroup:
        matrix = stack.pop() ?? matrix;
        break;
      case OPS.transform: {
        const local = toMatrix(args);

        if (local) {
          matrix = multiplyMatrices(matrix, local);
        }
        break;
      }
      case OPS.paintFormXObjectBegin: {
        const local = toMatrix(args[0]);

        stack.push(matrix);

        if (local) {
          matrix = multiplyMatrices(matrix, local);
        }
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask:
        paint();
        break;
      case OPS.paintImageXObjectRepeat: {
        const [, scaleX, scaleY, positions = []] = args;

        for (let position = 0; position + 1 < positions.length; position += 2) {
          paint([scaleX, 0, 0, scaleY, positions[position], positions[position + 1]]);
        }
        break;
      }
      case OPS.paintImageMaskXObjectRepeat: {
        const [, scaleX, skewX = 0, skewY = 0, scaleY, positions = []] = args;

        for (let position = 0; position + 1 < positions.length; position += 2) {
          paint([scaleX, skewX, skewY, scaleY, positions[position], positions[position + 1]]);
        }
        break;
      }
      case OPS.paintImageMaskXObjectGroup:
        for (const image of args[0] ?? []) {
          paint(toMatrix(image?.transform) ?? IDENTITY_MATRIX);
        }
        break;
      case OPS.paintInlineImageXObjectGroup:
        for (const entry of args[1] ?? []) {
          paint(toMatrix(entry?.transform) ?? IDENTITY_MATRIX);
        }
        break;
      default:
        break;
    }
  }

  return {
    imageCount,
    imageCoverage: pageArea > 0 ? Math.min(1, paintedArea / pageArea) : 0,
  };
};

/** The text signals of one page: its text content items and their lines. */
export const measurePageText = (items = [], lines = buildPdfTextLines(items)) => {
  const counts = { charCount: 0, garbledCount: 0 };
  let itemCount = 0;

  for (const item of items) {
    if (!item?.str) {
      continue;
    }

    itemCount += 1;
    countCharacters(sanitizeItemText(item.str), counts);
  }

  return {
    charCount: counts.charCount,
    itemCount,
    lineCount: lines.length,
    tabularLineCount: lines.filter((line) => line.tabular && !isNumberedEquationLine(line)).length,
    tableCaption: lines.some((line) => isTableCaptionLine(line.text)),
    garbledCharRatio: counts.charCount > 0 ? counts.garbledCount / counts.charCount : 0,
  };
};

const collectPageSignals = async (pageData, textContent, lines) => {
  const text = measurePageText(textContent.items, lines);
  const operatorList = await pageData.getOperatorList({
    annotationMode: AnnotationMode.DISABLE,
  });
  const images = measurePageImages(operatorList, pageData.view);

  return {
    charCount: text.charCount,
    itemCount: text.itemCount,
    lineCount: text.lineCount,
    tabularLineCount: text.tabularLineCount,
    tableCaption: text.tableCaption,
    imageCount: images.imageCount,
    imageCoverage: images.imageCoverage,
    garbledCharRatio: text.garbledCharRatio,
  };
};

// ---------------------------------------------------------------------------

/**
 * Opens `data` (PDF bytes, never modified) with pdf.js and reads pages
 * firstPage..min(lastPage ?? pageCount, rendered), where rendered is
 * min(maxPages, pageCount) or every page without maxPages. Each page holds
 * `lines` (paragraph detection: buildPdfTextLines, rendered later over the
 * whole document by renderExtractedPages) or its legacy `text`, plus
 * `signals` with collectSignals.
 */
export const extractPdfPageRange = async (
  data,
  {
    firstPage = 1,
    lastPage = null,
    maxPages = 0,
    paragraphDetection = isPdfParagraphDetectionEnabled(),
    collectSignals = false,
    includeMetadata = false,
  } = {}
) => {
  assertPageNumber(firstPage, "firstPage");

  if (lastPage !== null && lastPage !== undefined) {
    assertPageNumber(lastPage, "lastPage");
  }

  const pages = [];
  let pageCount = 0;
  let info = null;
  const loadingTask = openPdfDocument(data);

  try {
    const document = await loadingTask.promise;
    pageCount = document.numPages;
    const renderedPageCount = resolvePageLimit({
      maxPages,
      pageCount,
    });
    const last = Math.min(lastPage ?? pageCount, renderedPageCount);

    for (let pageNumber = firstPage; pageNumber <= last; pageNumber += 1) {
      const pageData = await document.getPage(pageNumber);

      try {
        const textContent = await readPdfPageTextContent(pageData);
        const page = { pageNumber };
        let lines = null;

        if (paragraphDetection) {
          lines = buildPdfTextLines(textContent.items);
          page.lines = lines;
        } else {
          page.text = normalizePageText(renderLegacyPageText(textContent));
        }

        if (collectSignals) {
          page.signals = await collectPageSignals(
            pageData,
            textContent,
            lines ?? buildPdfTextLines(textContent.items)
          );
        }

        pages.push(page);
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
    pageCount,
    pdfVersion: pdfJsVersion,
    info,
    pages,
  };
};

const PDFJS_ERRORS = Object.freeze({
  InvalidPDFException: {
    Class: InvalidPDFException,
    create: ({ message }) => new InvalidPDFException(message),
  },
  PasswordException: {
    Class: PasswordException,
    create: ({ code, message }) => new PasswordException(message, code),
  },
  ResponseException: {
    Class: ResponseException,
    create: ({ message, status }) => new ResponseException(message, status),
  },
});

/**
 * The pdf.js exception an error from another thread stands for (same name,
 * message, and code or status), so a worker's InvalidPDFException is one
 * here too; any other error is returned as it is.
 */
export const restorePdfjsError = (error) => {
  const entry = Object.hasOwn(PDFJS_ERRORS, error?.name) ? PDFJS_ERRORS[error.name] : null;

  return entry && !(error instanceof entry.Class) ? entry.create(error) : error;
};

/** Opens `data` only to count its pages. */
export const countPdfPages = async (data) => {
  const loadingTask = openPdfDocument(data);

  try {
    return (await loadingTask.promise).numPages;
  } finally {
    await loadingTask.destroy();
  }
};

/**
 * [{ pageNumber, text }] for extracted pages. With paragraph detection the
 * pages are rendered from their lines, and a line-end hyphen is judged
 * against the spelling of every page given, so pass the whole document.
 */
export const renderExtractedPages = (
  pages = [],
  { paragraphDetection = isPdfParagraphDetectionEnabled() } = {}
) => {
  if (!paragraphDetection) {
    return pages.map(({ pageNumber, text }) => ({ pageNumber, text }));
  }

  const vocabulary = buildHyphenationVocabulary(pages.map((page) => page.lines ?? []));

  return pages.map(({ pageNumber, lines }) => ({
    pageNumber,
    text: renderPdfParagraphText(lines ?? [], { vocabulary }),
  }));
};
