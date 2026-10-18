// Per-page routing for PDF_PARSER=auto (pdf-auto-parser.js).
//
// pdf.js reads a born-digital page well and fast, so most pages keep its
// text. Two kinds of page do not: a table, which pdf.js returns as numbers
// without the column they belong to, and a page whose text layer is missing
// or unusable (a scan, an image-only page, a font without a ToUnicode map that
// comes out as U+FFFD and private-use characters). The pdf.js pass collects a
// few signals per page (pdf-page-extraction.js) and this module, a pure
// function of those signals and the PDF_AUTO_* thresholds, picks one route:
//
//   text    keep the pdf.js text;
//   layout  docling-serve without OCR (table structure, reading order);
//   ocr     docling-serve with OCR forced over the page's own text layer.
//
// The rules, first match wins:
//   a. ocr, garbled text: at least GARBLED_MIN_CHARS characters, and the
//      garbled share at or above PDF_AUTO_GARBLED_RATIO;
//   b. ocr, image without text: fewer than PDF_AUTO_MIN_TEXT_CHARS characters
//      on a page at least PDF_AUTO_IMAGE_COVERAGE covered by images;
//   c. layout: PDF_AUTO_TABLE_MIN_ROWS tabular lines, or a table caption and
//      at least 2 tabular lines;
//   d. text.
// A rule whose route PDF_AUTO_ROUTES leaves out does not match; the page
// falls through and its reasons say which route was disabled, so the routing
// report shows what a route would have taken.

import {
  getPdfAutoGarbledRatio,
  getPdfAutoImageCoverage,
  getPdfAutoMinTextChars,
  getPdfAutoRoutes,
  getPdfAutoTableMinRows,
} from "./config.js";

export const PDF_PAGE_ROUTES = Object.freeze(["text", "layout", "ocr"]);

export const PDF_PAGE_ROUTE_REASONS = Object.freeze({
  garbledText: "garbled_text",
  imageWithoutText: "image_without_text",
  layoutRouteDisabled: "layout_route_disabled",
  ocrRouteDisabled: "ocr_route_disabled",
  plainText: "plain_text",
  tableCaption: "table_caption",
  tableRows: "table_rows",
});

// Below this a garbled share says little: a page number, a lone symbol font
// glyph or a stray bullet should not send a page to OCR.
export const GARBLED_MIN_CHARS = 20;

// With a caption naming a table, a couple of tabular lines suffice.
const CAPTIONED_TABLE_MIN_ROWS = 2;

const DOCLING_ROUTES = new Set(["layout", "ocr"]);

const toCount = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/** The PDF_AUTO_* settings as the thresholds classifyPdfPage reads (throws on an invalid one). */
export const resolvePdfAutoRoutingConfig = () => ({
  garbledRatio: getPdfAutoGarbledRatio(),
  imageCoverage: getPdfAutoImageCoverage(),
  minTextChars: getPdfAutoMinTextChars(),
  routes: getPdfAutoRoutes(),
  tableMinRows: getPdfAutoTableMinRows(),
});

/**
 * One page's route from its pdf.js signals: `{ route, reasons }`, reasons
 * being PDF_PAGE_ROUTE_REASONS codes. A missing signal counts as 0.
 */
export const classifyPdfPage = (signals = {}, thresholds = resolvePdfAutoRoutingConfig()) => {
  const routes = thresholds.routes ?? [];
  const ocrEnabled = routes.includes("ocr");
  const layoutEnabled = routes.includes("layout");
  const charCount = toCount(signals?.charCount);
  const tabularLineCount = toCount(signals?.tabularLineCount);
  const garbled = charCount >= GARBLED_MIN_CHARS && toCount(signals?.garbledCharRatio) >= thresholds.garbledRatio;
  const imageWithoutText = charCount < thresholds.minTextChars && toCount(signals?.imageCoverage) >= thresholds.imageCoverage;
  const tableReason =
    tabularLineCount >= thresholds.tableMinRows
      ? PDF_PAGE_ROUTE_REASONS.tableRows
      : signals?.tableCaption === true && tabularLineCount >= CAPTIONED_TABLE_MIN_ROWS
        ? PDF_PAGE_ROUTE_REASONS.tableCaption
        : null;

  if (ocrEnabled && garbled) {
    return { reasons: [PDF_PAGE_ROUTE_REASONS.garbledText], route: "ocr" };
  }

  if (ocrEnabled && imageWithoutText) {
    return { reasons: [PDF_PAGE_ROUTE_REASONS.imageWithoutText], route: "ocr" };
  }

  if (layoutEnabled && tableReason) {
    return { reasons: [tableReason], route: "layout" };
  }

  const reasons = [PDF_PAGE_ROUTE_REASONS.plainText];

  if (!ocrEnabled && (garbled || imageWithoutText)) {
    reasons.push(PDF_PAGE_ROUTE_REASONS.ocrRouteDisabled);
  }

  if (!layoutEnabled && tableReason) {
    reasons.push(PDF_PAGE_ROUTE_REASONS.layoutRouteDisabled);
  }

  return { reasons, route: "text" };
};

/**
 * The docling-serve requests for a document's routed pages. Pages on the same
 * Docling route (layout or ocr) form one run while at most `mergeGapPages`
 * text pages separate them (0 = contiguous pages only; a page on the other
 * Docling route always ends a run), and each run is split into requests of at
 * most `maxPagesPerRequest` pages (0 = unsplit), every request starting and
 * ending on a routed page. `routes` is `[{ pageNumber, route }]`; a request
 * covers `firstPage..lastPage`, gap pages included (they keep pdf.js text).
 */
export const planDoclingBatches = (routes = [], { maxPagesPerRequest = 0, mergeGapPages = 0 } = {}) => {
  const limit = Number.isInteger(maxPagesPerRequest) && maxPagesPerRequest > 0 ? maxPagesPerRequest : Infinity;
  const gap = Number.isInteger(mergeGapPages) && mergeGapPages > 0 ? mergeGapPages : 0;
  const routeByPage = new Map(routes.map(({ pageNumber, route }) => [pageNumber, route]));
  const routed = [...routes]
    .filter(({ route }) => DOCLING_ROUTES.has(route))
    .sort((left, right) => left.pageNumber - right.pageNumber);
  const onlyTextBetween = (from, to) => {
    for (let pageNumber = from + 1; pageNumber < to; pageNumber += 1) {
      if (routeByPage.get(pageNumber) !== "text") {
        return false;
      }
    }

    return true;
  };
  const runs = [];

  for (const { pageNumber, route } of routed) {
    const run = runs.at(-1);

    if (run && run.route === route && pageNumber - run.pages.at(-1) - 1 <= gap && onlyTextBetween(run.pages.at(-1), pageNumber)) {
      run.pages.push(pageNumber);
    } else {
      runs.push({ pages: [pageNumber], route });
    }
  }

  const batches = [];

  for (const { pages, route } of runs) {
    let current = null;

    for (const pageNumber of pages) {
      if (current && pageNumber - current.firstPage + 1 <= limit) {
        current.lastPage = pageNumber;
      } else {
        current = { firstPage: pageNumber, lastPage: pageNumber, route };
        batches.push(current);
      }
    }
  }

  return batches;
};
