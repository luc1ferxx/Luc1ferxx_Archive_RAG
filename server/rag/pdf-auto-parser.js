// PDF_PARSER=auto: pdf.js for every page, docling-serve only for the pages
// that need it.
//
// Docling reads tables and scans far better than pdf.js but costs seconds per
// page; pdf.js reads a born-digital text page as well in milliseconds. So the
// document is parsed once with pdf.js, which also collects per-page signals
// (text amount, tabular lines, image coverage, garbled characters;
// pdf-page-extraction.js), pdf-page-router.js picks each page's route, and the
// routed pages go to docling-serve as page-range requests: a contiguous run of
// pages on one route is one request (split at DOCLING_PAGE_BATCH_SIZE), all
// sent at once and bounded by the per-process limiter in docling-parser.js.
// Docling's text then replaces pdf.js text for those pages:
//
//   - a page Docling returns empty while pdf.js had text keeps the pdf.js text
//     (`docling_empty`);
//   - a failed request: with DOCLING_FALLBACK=pdfjs (default) its pages keep
//     their pdf.js text (`docling_failed`) and one warning per document names
//     the page ranges and error codes; with `none` the document's other
//     requests are cancelled and the upload fails with the DoclingParseError.
//     Under `pdfjs` a request that timed out or found docling-serve
//     unreachable also drops the document's requests still waiting for a
//     slot (their pages keep pdf.js text too, outcome `aborted`); the ones
//     already sent finish. A stalled docling-serve then costs a document
//     about one DOCLING_TIMEOUT_MS, not one per DOCLING_MAX_CONCURRENCY of
//     its requests, and its queued requests stop holding up other PDFs.
//
// The routing report (loadPdfPagesWithRouting) holds codes and numbers only,
// never page text, file names or URLs.

import path from "node:path";
import { getDoclingFallback, getDoclingPageBatchSize, isDoclingOcrEnabled } from "./config.js";
import {
  convertPdfBytesWithDocling,
  createDoclingPdfBlob,
  DOCLING_ERROR_CODES,
  DoclingParseError,
} from "./docling-parser.js";
import { recordPdfPages, recordPdfParseFallback } from "./metrics-pdf.js";
import { classifyPdfPage, planDoclingBatches, resolvePdfAutoRoutingConfig } from "./pdf-page-router.js";
import { readWorkingFile } from "./working-files.js";

export const PDF_AUTO_FALLBACKS = Object.freeze({
  doclingEmpty: "docling_empty",
  doclingFailed: "docling_failed",
});

// pdfjs-document.js loads pdf.js (and its worker pool); imported on first use.
const parsePdfBytesLazily = async (bytes, options) => {
  const { parsePdfBytesWithPdfjs } = await import("./pdfjs-document.js");

  return parsePdfBytesWithPdfjs(bytes, options);
};

// `layout` keeps the document's own text layer next to Docling's layout and
// table models (OCR only when DOCLING_OCR says so); `ocr` replaces the text
// layer, which on those pages is missing or garbled.
const DOCLING_ROUTE_OPTIONS = Object.freeze({
  layout: () => ({ doOcr: isDoclingOcrEnabled(), forceOcr: false }),
  ocr: () => ({ doOcr: true, forceOcr: true }),
});

const BATCH_OUTCOME_BY_ERROR_CODE = Object.freeze({ [DOCLING_ERROR_CODES.aborted]: "aborted" });

// Failures that say docling-serve itself is not answering, so the
// document's requests still queued would only wait for the same outcome.
const SERVER_STALLED_CODES = new Set([DOCLING_ERROR_CODES.timeout, DOCLING_ERROR_CODES.unreachable]);

const elapsedMs = (startedAt) => Math.max(0, Math.round(performance.now() - startedAt));

const formatPageRange = ({ firstPage, lastPage }) =>
  firstPage === lastPage ? String(firstPage) : `${firstPage}-${lastPage}`;

const describeBatchError = (error) =>
  [error?.code ?? error?.name ?? "Error", error?.httpStatus ? `HTTP ${error.httpStatus}` : null]
    .filter(Boolean)
    .join(", ");

// Every batch at once; the limiter decides how many are in flight, and the
// requests share one copy of the PDF. Under DOCLING_FALLBACK=none the first
// failure cancels the others (queued or in flight); under pdfjs a timeout or
// an unreachable server cancels the ones still queued. Every batch has
// settled before this returns.
const convertBatches = async ({ batches, bytes, fallback, fetchImpl, fileName }) => {
  const controller = new AbortController();
  const queueController = new AbortController();
  const file = createDoclingPdfBlob(bytes);
  let firstError = null;
  // Both run before the failed request frees its slot, so no queued batch is
  // sent only to be cancelled.
  const cancelOthers = (error) => {
    if (!firstError) {
      firstError = error;
      controller.abort(error);
    }
  };
  const dropQueuedWhenStalled = (error) => {
    if (SERVER_STALLED_CODES.has(error?.code) && !queueController.signal.aborted) {
      queueController.abort(error);
    }
  };
  const settled = await Promise.all(
    batches.map(async (batch) => {
      const startedAt = performance.now();

      try {
        const pages = await convertPdfBytesWithDocling(file, fileName, {
          ...DOCLING_ROUTE_OPTIONS[batch.route](),
          fetchImpl,
          onFailure: fallback === "none" ? cancelOthers : dropQueuedWhenStalled,
          pageRange: [batch.firstPage, batch.lastPage],
          queueSignal: queueController.signal,
          route: batch.route,
          signal: controller.signal,
        });

        return { durationMs: elapsedMs(startedAt), outcome: "ok", pages };
      } catch (error) {
        if (fallback === "none") {
          cancelOthers(error);
        }

        return {
          durationMs: elapsedMs(startedAt),
          error,
          outcome: BATCH_OUTCOME_BY_ERROR_CODE[error?.code] ?? "error",
        };
      }
    })
  );

  if (firstError) {
    throw firstError instanceof DoclingParseError
      ? firstError
      : new DoclingParseError(`docling-serve could not convert ${fileName}.`, { cause: firstError });
  }

  return settled;
};

const recordPageMetrics = (routes) => {
  const counts = new Map();

  for (const { parser, route } of routes) {
    const key = `${route}\u0001${parser}`;

    counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, parser, route });
  }

  for (const entry of counts.values()) {
    recordPdfPages(entry);
  }

  for (const reason of Object.values(PDF_AUTO_FALLBACKS)) {
    recordPdfParseFallback(reason, routes.filter((entry) => entry.fallback === reason).length);
  }
};

/**
 * Parses a PDF with per-page routing. Returns `{ pages, routing }`: pages
 * 1..n as `{ pageNumber, text }`, and the routing report `{ parser: "auto",
 * pageCount, routes: [{ pageNumber, route, reasons, parser, fallback? }],
 * batches: [{ route, firstPage, lastPage, outcome, durationMs }] }`, where
 * `durationMs` runs from the moment the batch was issued (queueing for a
 * limiter slot included). `deps` (tests): `readFile`, `parseDocument`
 * (bytes, { collectSignals }) and `fetchImpl`.
 */
export const loadPdfPagesWithRouting = async (
  filePath,
  { fetchImpl = globalThis.fetch, parseDocument = parsePdfBytesLazily, readFile = readWorkingFile } = {}
) => {
  // Settings first: an invalid PDF_AUTO_* value fails before any parsing.
  const thresholds = resolvePdfAutoRoutingConfig();
  const fallback = getDoclingFallback();
  const maxPagesPerRequest = getDoclingPageBatchSize();
  const fileName = path.basename(filePath);
  const bytes = await readFile(filePath);
  const parsed = await parseDocument(bytes, { collectSignals: true });
  const signalsByPage = new Map((parsed.signals ?? []).map((entry) => [entry.pageNumber, entry]));
  const pages = parsed.pages.map(({ pageNumber, text }) => ({ pageNumber, text }));
  const pageIndex = new Map(pages.map((page, index) => [page.pageNumber, index]));
  const routes = pages.map(({ pageNumber }) => {
    const { reasons, route } = classifyPdfPage(signalsByPage.get(pageNumber), thresholds);

    return { pageNumber, route, reasons, parser: "pdfjs" };
  });
  const batches = planDoclingBatches(routes, { maxPagesPerRequest });
  const settled = batches.length === 0 ? [] : await convertBatches({ batches, bytes, fallback, fetchImpl, fileName });
  const failed = [];

  settled.forEach((result, batchIndex) => {
    const batch = batches[batchIndex];

    if (result.outcome !== "ok") {
      failed.push({ batch, error: result.error });

      for (let pageNumber = batch.firstPage; pageNumber <= batch.lastPage; pageNumber += 1) {
        routes[pageIndex.get(pageNumber)].fallback = PDF_AUTO_FALLBACKS.doclingFailed;
      }

      return;
    }

    for (const doclingPage of result.pages) {
      const index = pageIndex.get(doclingPage.pageNumber);

      if (index === undefined) {
        continue;
      }

      if (!String(doclingPage.text ?? "").trim() && String(pages[index].text ?? "").trim()) {
        routes[index].fallback = PDF_AUTO_FALLBACKS.doclingEmpty;
        continue;
      }

      pages[index].text = doclingPage.text;
      routes[index].parser = "docling";
    }
  });

  if (failed.length > 0) {
    const summary = failed.map(({ batch, error }) => `${formatPageRange(batch)} (${describeBatchError(error)})`).join(", ");

    console.warn(
      `docling-serve could not convert pages ${summary} of ${fileName}; those pages keep their pdf.js text (DOCLING_FALLBACK=pdfjs).`
    );
  }

  recordPageMetrics(routes);

  return {
    pages,
    routing: {
      parser: "auto",
      pageCount: parsed.pageCount,
      routes,
      batches: batches.map((batch, batchIndex) => ({
        route: batch.route,
        firstPage: batch.firstPage,
        lastPage: batch.lastPage,
        outcome: settled[batchIndex].outcome,
        durationMs: settled[batchIndex].durationMs,
      })),
    },
  };
};

/** PDF_PARSER=auto pages, `[{ pageNumber, text }]` (see loadPdfPagesWithRouting). */
export const loadPdfPagesAuto = async (filePath, deps) => (await loadPdfPagesWithRouting(filePath, deps)).pages;
