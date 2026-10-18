import { getMetricsRegistry, isMetricsEnabled, pickLabel } from "./metrics.js";

// PDF parsing (rag/pdf-loader.js, docling-parser.js, pdf-auto-parser.js):
//   - pages parsed, by the route the auto router picked (`unrouted` under
//     PDF_PARSER=pdfjs and docling, which route nothing) and the parser whose
//     text the page kept;
//   - docling-serve requests by route (`document` for PDF_PARSER=docling,
//     whole or in page ranges; `layout` / `ocr` for routed pages) and outcome,
//     and their duration from the moment a request got its concurrency slot;
//   - pages that kept or fell back to pdf.js text instead of Docling's, by
//     reason: `docling_failed` (their request failed, DOCLING_FALLBACK=pdfjs),
//     `docling_empty` (Docling returned no text where pdf.js had some), and
//     `docling_document` (PDF_PARSER=docling fell back to pdf.js for the whole
//     document).
// Every label is a fixed vocabulary; nothing names a document or a URL.

export const PDF_DOCLING_REQUEST_DURATION_BUCKETS = Object.freeze([
  0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
]);

const PAGE_ROUTES = new Set(["layout", "ocr", "text", "unrouted"]);
const PAGE_PARSERS = new Set(["docling", "pdfjs"]);
const REQUEST_ROUTES = new Set(["document", "layout", "ocr"]);
const REQUEST_OUTCOMES = new Set(["aborted", "error", "ok", "timeout"]);
const FALLBACK_REASONS = new Set(["docling_document", "docling_empty", "docling_failed"]);

const registry = getMetricsRegistry();

const pages = registry.counter({
  help: "PDF pages parsed, by auto route (unrouted under PDF_PARSER=pdfjs and docling) and the parser whose text the page kept.",
  labelNames: ["parser", "route"],
  name: "archive_rag_pdf_pages_total",
});
const doclingRequests = registry.counter({
  help: "docling-serve conversion requests by route (document, layout, ocr) and outcome (ok, error, timeout, aborted).",
  labelNames: ["outcome", "route"],
  name: "archive_rag_pdf_docling_requests_total",
});
const doclingRequestDuration = registry.histogram({
  buckets: PDF_DOCLING_REQUEST_DURATION_BUCKETS,
  help: "Duration of one docling-serve conversion request from its concurrency slot to its answer, in seconds.",
  labelNames: ["route"],
  name: "archive_rag_pdf_docling_request_duration_seconds",
});
const fallbacks = registry.counter({
  help: "PDF pages that kept or fell back to pdf.js text instead of Docling's, by reason.",
  labelNames: ["reason"],
  name: "archive_rag_pdf_parse_fallbacks_total",
});

/** `count` pages parsed on `route`, kept from `parser`. */
export const recordPdfPages = ({ count = 1, parser, route }) => {
  if (!isMetricsEnabled() || !(count > 0)) {
    return;
  }

  pages.inc({ parser: pickLabel(parser, PAGE_PARSERS), route: pickLabel(route, PAGE_ROUTES) }, count);
};

/**
 * One settled docling-serve request. `durationSeconds` is null for a request
 * cancelled before it got a slot (counted, not timed).
 */
export const recordDoclingRequest = ({ durationSeconds = null, outcome, route }) => {
  if (!isMetricsEnabled()) {
    return;
  }

  const routeLabel = pickLabel(route, REQUEST_ROUTES);

  doclingRequests.inc({ outcome: pickLabel(outcome, REQUEST_OUTCOMES), route: routeLabel });

  if (Number.isFinite(durationSeconds)) {
    doclingRequestDuration.observe({ route: routeLabel }, durationSeconds);
  }
};

/** `count` pages that kept pdf.js text for `reason`. */
export const recordPdfParseFallback = (reason, count = 1) => {
  if (!isMetricsEnabled() || !(count > 0)) {
    return;
  }

  fallbacks.inc({ reason: pickLabel(reason, FALLBACK_REASONS) }, count);
};
