// A PDF's pages as pdf.js reads them, in this thread or on the worker pool.
//
// With workers 0 (PDF_PARSE_WORKERS, the default) this is the in-process
// parse pdf-loader.js has always done, with the same pdf.js calls in the same
// order. With workers > 0 the document goes to the pool (pdf-parse-pool.js)
// in page ranges of PDF_PARSE_PAGES_PER_TASK pages: the first range also
// learns the page count, then every other range is queued at once and the
// workers parse them in parallel. Ranges come back as extractPdfPageRange
// results and are rendered here, over the whole document, exactly as in
// process (a line-end hyphen is judged against the spelling of every page),
// so the page text is the same byte for byte whichever path ran.

import {
  getPdfParsePagesPerTask,
  getPdfParseWorkers,
  isPdfParagraphDetectionEnabled,
} from "./config.js";
import {
  extractPdfPageRange,
  renderExtractedPages,
  resolvePageLimit,
  restorePdfjsError,
} from "./pdf-page-extraction.js";
import {
  PDF_PARSE_TASK_CANCELLED,
  PDF_PARSE_WORKER_FAILED,
  PdfParsePoolError,
  runPdfParseTask,
} from "./pdf-parse-pool.js";

const assertContiguousPages = (pages, renderedPageCount) => {
  const complete =
    pages.length === renderedPageCount && pages.every((page, index) => page.pageNumber === index + 1);

  if (!complete) {
    throw new PdfParsePoolError("The PDF parse workers returned an incomplete set of pages.", {
      code: PDF_PARSE_WORKER_FAILED,
      status: 500,
    });
  }
};

const extractRangesWithWorkers = async (
  data,
  { collectSignals, includeMetadata, maxPages, paragraphDetection, workers }
) => {
  const pagesPerTask = getPdfParsePagesPerTask();
  const rangeOptions = { collectSignals, maxPages, paragraphDetection };
  const first = await runPdfParseTask(
    data,
    { ...rangeOptions, firstPage: 1, includeMetadata, lastPage: pagesPerTask },
    { size: workers }
  );
  const renderedPageCount = resolvePageLimit({ maxPages, pageCount: first.pageCount });
  const ranges = [];

  for (let firstPage = pagesPerTask + 1; firstPage <= renderedPageCount; firstPage += pagesPerTask) {
    ranges.push({ firstPage, lastPage: Math.min(firstPage + pagesPerTask - 1, renderedPageCount) });
  }

  // After a failure the ranges still waiting for a worker are dropped; the
  // ones running finish, and the error thrown is the failed range that comes
  // first in page order, as the in-process parse would have stopped there.
  const controller = new AbortController();
  const settled = await Promise.allSettled(
    ranges.map((range) =>
      runPdfParseTask(data, { ...rangeOptions, ...range, includeMetadata: false }, {
        signal: controller.signal,
        size: workers,
      }).catch((error) => {
        controller.abort();
        throw error;
      })
    )
  );
  const failure =
    settled.find((outcome) => outcome.status === "rejected" && outcome.reason?.code !== PDF_PARSE_TASK_CANCELLED) ??
    settled.find((outcome) => outcome.status === "rejected");

  if (failure) {
    throw failure.reason;
  }

  const pages = [...first.pages, ...settled.flatMap((outcome) => outcome.value.pages)];

  assertContiguousPages(pages, renderedPageCount);

  return { info: first.info, pageCount: first.pageCount, pages, pdfVersion: first.pdfVersion };
};

// A pdf.js exception crossed the thread boundary as a plain Error with its
// name; it is thrown as its own class again, as the in-process parse throws it.
const extractWithWorkers = async (data, options) => {
  try {
    return await extractRangesWithWorkers(data, options);
  } catch (error) {
    throw restorePdfjsError(error);
  }
};

/**
 * { pages: [{ pageNumber, text }], pageCount, renderedPageCount, pdfVersion,
 * info, signals? } for PDF bytes `data` (never modified). `signals`, only
 * with collectSignals, is aligned with pages: [{ pageNumber, ...signals }]
 * (pdf-page-extraction.js describes each field).
 */
export const parsePdfBytesWithPdfjs = async (
  data,
  {
    maxPages = 0,
    includeMetadata = false,
    // PDF_PARAGRAPH_DETECTION: rebuild paragraphs from line geometry
    // (pdf-paragraphs.js). Off keeps the legacy one-line-per-"\n" text.
    paragraphDetection = isPdfParagraphDetectionEnabled(),
    collectSignals = false,
    workers = getPdfParseWorkers(),
  } = {}
) => {
  const extracted =
    workers > 0
      ? await extractWithWorkers(data, { collectSignals, includeMetadata, maxPages, paragraphDetection, workers })
      : await extractPdfPageRange(data, { collectSignals, includeMetadata, maxPages, paragraphDetection });
  const pages = renderExtractedPages(extracted.pages, { paragraphDetection });
  const result = {
    pages,
    pageCount: extracted.pageCount,
    renderedPageCount: pages.length,
    pdfVersion: extracted.pdfVersion,
    info: extracted.info,
  };

  if (collectSignals) {
    result.signals = extracted.pages.map(({ pageNumber, signals }) => ({ pageNumber, ...signals }));
  }

  return result;
};
