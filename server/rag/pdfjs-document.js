// A PDF's pages as pdf.js reads them, in this thread or on the worker pool.
//
// With workers 0 (PDF_PARSE_WORKERS, the default) this is the in-process
// parse pdf-loader.js has always done, with the same pdf.js calls in the same
// order. With workers > 0 the document goes to the pool (pdf-parse-pool.js)
// in page ranges of PDF_PARSE_PAGES_PER_TASK pages: the first range also
// learns the page count, then the other ranges follow in page order, at most
// one per worker in the pool at a time (the next one is queued when one of
// the document's own ranges finishes). The pool serves one FIFO queue for
// every document, so a document that arrives while a long one is parsing
// waits behind at most one range per worker of it, never behind the whole
// rest of it. Ranges come back as extractPdfPageRange
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

  // `workers` lanes, each taking the next range in page order once its last
  // one has settled, so the document never holds more than `workers` tasks
  // in the pool. After a failure no further range is queued, the ones still
  // waiting for a worker are dropped, the ones running finish, and the error
  // thrown is the failed range that comes first in page order, as the
  // in-process parse would have stopped there.
  const controller = new AbortController();
  const settled = new Array(ranges.length);
  let nextRange = 0;
  const runLane = async () => {
    while (nextRange < ranges.length && !controller.signal.aborted) {
      const index = nextRange;

      nextRange += 1;

      try {
        settled[index] = {
          status: "fulfilled",
          value: await runPdfParseTask(data, { ...rangeOptions, ...ranges[index], includeMetadata: false }, {
            signal: controller.signal,
            size: workers,
          }),
        };
      } catch (error) {
        settled[index] = { reason: error, status: "rejected" };
        controller.abort();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, ranges.length) }, runLane));

  const outcomes = settled.filter(Boolean);
  const failure =
    outcomes.find((outcome) => outcome.status === "rejected" && outcome.reason?.code !== PDF_PARSE_TASK_CANCELLED) ??
    outcomes.find((outcome) => outcome.status === "rejected");

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
