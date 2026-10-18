// Layout-aware PDF parsing through a docling-serve instance (PDF_PARSER=docling).
//
// pdf.js returns a page's text items in content-stream order and joins them by
// y position: a two-column page interleaves its columns line by line, and a
// table comes out as numbers without the column they belong to. Docling runs a
// layout model and a table-structure model, so it returns the page in reading
// order and every table as a grid of cells. This module sends the PDF to the
// docling-serve HTTP API and flattens the DoclingDocument it returns into the
// same `[{ pageNumber, text }]` pages the chunker already consumes:
//
//   - body items in reading order, page headers/footers and other furniture
//     dropped;
//   - a table as its caption, then one line per row, each cell labelled with
//     its column header ("Model: BERT; F1: 84.2"), so a row split into another
//     chunk still says what every number is;
//   - figures as their captions only.
//
// A request covers the whole document, or a page range (DOCLING_PAGE_BATCH_SIZE
// under PDF_PARSER=docling, and the pages PDF_PARSER=auto routes here; see
// pdf-auto-parser.js). Every request waits for a slot of one per-process
// limiter (DOCLING_MAX_CONCURRENCY), and its DOCLING_TIMEOUT_MS starts there.

import path from "node:path";
import {
  getDoclingMaxConcurrency,
  getDoclingPageBatchSize,
  getDoclingServeUrl,
  getDoclingTimeoutMs,
  isDoclingOcrEnabled,
} from "./config.js";
import { secondsSince } from "./metrics.js";
import { recordDoclingRequest } from "./metrics-pdf.js";
import { readWorkingFile } from "./working-files.js";

const SKIPPED_TEXT_LABELS = new Set(["page_header", "page_footer"]);
const NUMERIC_CELL = /^[\s~<>≈±+\-−]*\d/;
const MAX_HEADER_ROWS = 3;

const resolveRef = (document, ref) => {
  const match = /^#\/(texts|tables|groups|pictures)\/(\d+)$/.exec(String(ref ?? ""));

  return match ? { collection: match[1], item: document[match[1]]?.[Number(match[2])] ?? null } : null;
};

const pageOf = (item) => Number(item?.prov?.[0]?.page_no) || null;

const cleanCell = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// The grid repeats a spanning cell in every position it covers; a row keeps
// it once.
const dedupeRowCells = (cells) =>
  cells.filter((cell, index) => index === 0 || cell.text !== cells[index - 1].text || !cell.text);

/**
 * One line per row. Header rows (every cell a column header) name the
 * columns; each later row labels its cells with those names.
 */
export const renderDoclingTable = (table) => {
  const grid = table?.data?.grid ?? [];

  if (grid.length === 0) {
    return [];
  }

  const isHeaderRow = (row) => row.length > 0 && row.every((cell) => cell.column_header || !cleanCell(cell.text));
  // Docling often flags only the first row of a stacked header ("Raw" /
  // "Lemmatized" over "Train" / "Test"); a following row with no number past
  // the first column is taken as header too while later rows hold numbers.
  const hasNumberPastFirstColumn = (row) => row.slice(1).some((cell) => NUMERIC_CELL.test(cleanCell(cell.text)));
  const laterRowsHoldNumbers = (index) => grid.slice(index + 1).some(hasNumberPastFirstColumn);
  let headerRowCount = 0;

  while (headerRowCount < grid.length - 1 && isHeaderRow(grid[headerRowCount])) {
    headerRowCount += 1;
  }

  while (
    headerRowCount > 0 &&
    headerRowCount < Math.min(MAX_HEADER_ROWS, grid.length - 1) &&
    !hasNumberPastFirstColumn(grid[headerRowCount]) &&
    laterRowsHoldNumbers(headerRowCount)
  ) {
    headerRowCount += 1;
  }

  const columnNames = (grid[0] ?? []).map((_cell, column) =>
    [...new Set(grid.slice(0, headerRowCount).map((row) => cleanCell(row[column]?.text)).filter(Boolean))].join(" ")
  );
  const lines = [];

  if (headerRowCount > 0) {
    lines.push(dedupeRowCells(columnNames.map((text) => ({ text }))).map((cell) => cell.text).filter(Boolean).join(" | "));
  }

  for (const row of grid.slice(headerRowCount)) {
    const cells = dedupeRowCells(
      row.map((cell, column) => ({ name: columnNames[column] ?? "", text: cleanCell(cell.text) }))
    ).filter((cell) => cell.text);

    if (cells.length > 0) {
      lines.push(cells.map((cell) => (cell.name && cell.name !== cell.text ? `${cell.name}: ${cell.text}` : cell.text)).join("; "));
    }
  }

  return lines;
};

/**
 * Flattens a DoclingDocument (docling-serve `json_content`) into pages of
 * text, 1..page count, in reading order.
 */
export const doclingDocumentToPages = (document) => {
  const pageCount = Math.max(
    0,
    ...Object.keys(document?.pages ?? {}).map(Number).filter(Number.isFinite)
  );
  const blocksByPage = new Map();
  const consumed = new Set();
  const emit = (page, text) => {
    const value = String(text ?? "").trim();

    if (!page || !value) {
      return;
    }

    if (!blocksByPage.has(page)) {
      blocksByPage.set(page, []);
    }

    blocksByPage.get(page).push(value);
  };
  const captionText = (item) =>
    (item?.captions ?? [])
      .map((ref) => {
        consumed.add(ref.$ref);
        return resolveRef(document, ref.$ref)?.item?.text ?? "";
      })
      .filter(Boolean)
      .join(" ");

  const visit = (ref) => {
    if (!ref || consumed.has(ref)) {
      return;
    }

    consumed.add(ref);
    const resolved = resolveRef(document, ref);
    const item = resolved?.item;

    if (!item || (item.content_layer && item.content_layer !== "body")) {
      return;
    }

    if (resolved.collection === "tables") {
      const page = pageOf(item);

      emit(page, captionText(item));
      for (const line of renderDoclingTable(item)) {
        emit(page, line);
      }
    } else if (resolved.collection === "pictures") {
      emit(pageOf(item), captionText(item));
    } else if (resolved.collection === "texts" && !SKIPPED_TEXT_LABELS.has(item.label)) {
      emit(pageOf(item), item.label === "list_item" ? `- ${item.text}` : item.text);
    }

    for (const child of item.children ?? []) {
      visit(child.$ref);
    }
  };

  for (const child of document?.body?.children ?? []) {
    visit(child.$ref);
  }

  const lastPage = Math.max(pageCount, ...blocksByPage.keys());

  return Array.from({ length: lastPage }, (_value, index) => ({
    pageNumber: index + 1,
    text: (blocksByPage.get(index + 1) ?? []).join("\n\n"),
  }));
};

export const DOCLING_ERROR_CODES = Object.freeze({
  aborted: "DOCLING_REQUEST_ABORTED",
  conversionFailed: "DOCLING_CONVERSION_FAILED",
  pageRangeMismatch: "DOCLING_PAGE_RANGE_MISMATCH",
  timeout: "DOCLING_TIMEOUT",
  unreachable: "DOCLING_UNREACHABLE",
});

export class DoclingParseError extends Error {
  // `code` is a DOCLING_ERROR_CODES value and `httpStatus` docling-serve's
  // answer when there was one. Messages name the server and the file, never
  // document text.
  constructor(message, { cause, code = DOCLING_ERROR_CODES.conversionFailed, httpStatus = null } = {}) {
    super(message, { cause });
    this.name = "DoclingParseError";
    this.status = 502;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// Every conversion this process sends waits here for one of
// DOCLING_MAX_CONCURRENCY slots, first come first served, so neither a long
// document split into page ranges nor several uploads at once queue more work
// inside docling-serve than it has workers for (and time out there while
// they wait). The limit is read on every grant, so a changed setting applies
// from the next request on.
const createRequestLimiter = () => {
  const waiters = [];
  let active = 0;

  const createRelease = () => {
    let released = false;

    return () => {
      if (!released) {
        released = true;
        active -= 1;
        grantWaiting();
      }
    };
  };

  const grantWaiting = () => {
    while (waiters.length > 0 && active < getDoclingMaxConcurrency()) {
      const waiter = waiters.shift();

      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      active += 1;
      waiter.resolve(createRelease());
    }
  };

  return {
    // Resolves with a release function once a slot is free; rejects with the
    // signal's reason when it aborts first (the request then never held one).
    acquire(signal) {
      if (signal?.aborted) {
        return Promise.reject(signal.reason);
      }

      return new Promise((resolve, reject) => {
        const waiter = { resolve, signal };

        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter);

          if (index !== -1) {
            waiters.splice(index, 1);
            reject(signal.reason);
          }
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        waiters.push(waiter);
        grantWaiting();
      });
    },
    snapshot: () => ({ active, limit: getDoclingMaxConcurrency(), queued: waiters.length }),
  };
};

let requestLimiter = createRequestLimiter();

/** Tests: a fresh limiter (requests holding a slot of the old one keep it there). */
export const resetDoclingRequestLimiter = () => {
  requestLimiter = createRequestLimiter();
};

/** `{ limit, active, queued }` of this process's docling-serve request limiter. */
export const getDoclingRequestLimiterSnapshot = () => requestLimiter.snapshot();

const normalizePageRange = (pageRange) => {
  if (pageRange === null || pageRange === undefined) {
    return null;
  }

  const [first, last] = pageRange;

  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
    throw new TypeError("pageRange must be [firstPage, lastPage] with 1 <= firstPage <= lastPage.");
  }

  return { first, last };
};

// What AbortSignal.timeout aborts with. The timeout is a timer of its own,
// started once the request has its slot and cleared as soon as it settles
// (and tests can drive it with mock timers).
const createTimeoutReason = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

// The page numbers a ranged conversion returned: the pages Docling lists plus
// any page a body item sits on.
const listReturnedPageNumbers = (document, pages) => [
  ...new Set([
    ...Object.keys(document?.pages ?? {})
      .map(Number)
      .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0),
    ...pages.filter((page) => page.text).map((page) => page.pageNumber),
  ]),
];

// docling-serve numbers a ranged conversion's pages as in the original file.
// Mapped defensively in case a version numbers them from 1: pages all inside
// the range are kept as they are; pages that are exactly 1..N for an N-page
// range are shifted into it; otherwise the pages inside the range are kept,
// and a result with none inside is an error rather than text on the wrong
// pages.
const mapRangePages = (document, { first, last }, fileName) => {
  const pages = doclingDocumentToPages(document);
  const returned = listReturnedPageNumbers(document, pages);
  const length = last - first + 1;
  const isInside = (pageNumber) => pageNumber >= first && pageNumber <= last;
  let offset = 0;

  if (!returned.every(isInside)) {
    if (returned.length === length && returned.every((pageNumber) => pageNumber <= length)) {
      offset = first - 1;
    } else if (!returned.some(isInside)) {
      throw new DoclingParseError(
        `docling-serve returned pages outside the requested range ${first}-${last} of ${fileName}.`,
        { code: DOCLING_ERROR_CODES.pageRangeMismatch }
      );
    }
  }

  const textByPage = new Map(pages.map((page) => [page.pageNumber + offset, page.text]));

  return Array.from({ length }, (_value, index) => ({
    pageNumber: first + index,
    text: textByPage.get(first + index) ?? "",
  }));
};

const classifyFailure = ({ signal, timeoutSignal }, fallbackCode) => {
  if (timeoutSignal.aborted) {
    return DOCLING_ERROR_CODES.timeout;
  }

  return signal?.aborted ? DOCLING_ERROR_CODES.aborted : fallbackCode;
};

const OUTCOME_BY_ERROR_CODE = Object.freeze({
  [DOCLING_ERROR_CODES.aborted]: "aborted",
  [DOCLING_ERROR_CODES.timeout]: "timeout",
});

/**
 * The PDF as the Blob a request uploads. Node's Blob copies the bytes, so a
 * caller that sends one document as several requests makes it once and
 * passes it to each (a form's File made from a Blob shares its storage).
 */
export const createDoclingPdfBlob = (bytes) =>
  bytes instanceof Blob ? bytes : new Blob([bytes], { type: "application/pdf" });

const waitSignalOf = (signal, queueSignal) =>
  signal && queueSignal ? AbortSignal.any([signal, queueSignal]) : signal ?? queueSignal;

/**
 * Converts PDF bytes (or a createDoclingPdfBlob Blob) through
 * docling-serve. Without `pageRange` the whole document, with exactly the
 * form fields PDF_PARSER=docling has always sent, and its pages 1..n; with
 * `pageRange` ([first, last]) only those pages, each one returned (empty when
 * Docling found nothing on it). `forceOcr` replaces a page's own text layer
 * with OCR. The request waits for a slot of this process's limiter, and
 * DOCLING_TIMEOUT_MS bounds it from the moment it has one; the request body
 * is built only then, so a queued request holds no copy of the PDF. `signal`
 * cancels it, queued or in flight; `queueSignal` only while it still waits
 * for a slot. `onFailure(error)` runs before a failed request gives up its
 * slot, so a caller that cancels the document's other requests does so
 * before a queued one could take the slot and be sent. `route` (document,
 * layout or ocr) only labels the metrics.
 */
export const convertPdfBytesWithDocling = async (
  bytes,
  fileName,
  {
    doOcr = isDoclingOcrEnabled(),
    fetchImpl = globalThis.fetch,
    forceOcr = false,
    onFailure,
    pageRange = null,
    queueSignal,
    route,
    signal,
  } = {}
) => {
  const range = normalizePageRange(pageRange);
  const metricRoute = route ?? (!range ? "document" : forceOcr ? "ocr" : "layout");
  const buildForm = () => {
    const form = new FormData();

    form.append("files", createDoclingPdfBlob(bytes), fileName);
    form.append("to_formats", "json");
    form.append("image_export_mode", "placeholder");
    form.append("do_ocr", String(doOcr));

    if (forceOcr) {
      form.append("force_ocr", "true");
    }

    if (range) {
      // docling-serve's page_range is a (start, end) tuple, which FastAPI
      // reads from a form field sent twice. The whole file still goes with
      // every request; docling-serve converts only the range.
      form.append("page_range", String(range.first));
      form.append("page_range", String(range.last));
    }

    return form;
  };

  let release;

  try {
    release = await requestLimiter.acquire(waitSignalOf(signal, queueSignal));
  } catch (error) {
    recordDoclingRequest({ outcome: "aborted", route: metricRoute });
    throw new DoclingParseError(`The docling-serve request for ${fileName} was cancelled before it was sent.`, {
      cause: error,
      code: DOCLING_ERROR_CODES.aborted,
    });
  }

  const startedAt = performance.now();
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(createTimeoutReason()), getDoclingTimeoutMs());
  const signals = { signal, timeoutSignal: timeoutController.signal };
  let outcome = "error";

  timer.unref?.();

  try {
    const body = buildForm();
    let response;

    try {
      response = await fetchImpl(`${getDoclingServeUrl()}/v1/convert/file`, {
        body,
        method: "POST",
        signal: signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal,
      });
    } catch (error) {
      const code = classifyFailure(signals, DOCLING_ERROR_CODES.unreachable);

      throw new DoclingParseError(
        code === DOCLING_ERROR_CODES.aborted
          ? `The docling-serve request for ${fileName} was cancelled.`
          : `docling-serve at ${getDoclingServeUrl()} is unreachable: ${error.message}`,
        { cause: error, code }
      );
    }

    const payload = await response.json().catch(() => null);
    const document = payload?.document?.json_content;

    if (!response.ok || payload?.status === "failure" || !document) {
      const detail = payload?.errors?.map((error) => error.error_message ?? JSON.stringify(error)).join("; ");

      throw new DoclingParseError(
        `docling-serve could not convert ${fileName} (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`,
        { code: classifyFailure(signals, DOCLING_ERROR_CODES.conversionFailed), httpStatus: response.status }
      );
    }

    const pages = range ? mapRangePages(document, range, fileName) : doclingDocumentToPages(document);

    outcome = "ok";
    return pages;
  } catch (error) {
    outcome = OUTCOME_BY_ERROR_CODE[error?.code] ?? "error";
    onFailure?.(error);
    throw error;
  } finally {
    clearTimeout(timer);
    release();
    recordDoclingRequest({ durationSeconds: secondsSince(startedAt), outcome, route: metricRoute });
  }
};

/**
 * Sends `ranges` ([{ firstPage, lastPage, ...convert options }]) of one
 * document at once (the limiter bounds how many run) and resolves with each
 * range's pages, in order. The first failure cancels the document's other
 * requests, queued or in flight, and is what this rejects with once they
 * have all settled.
 */
export const convertPdfPageRangesWithDocling = async (bytes, fileName, ranges, { fetchImpl = globalThis.fetch } = {}) => {
  const controller = new AbortController();
  let firstError = null;
  const cancelOthers = (error) => {
    if (!firstError) {
      firstError = error;
      controller.abort(error);
    }
  };
  const file = createDoclingPdfBlob(bytes);
  const results = await Promise.allSettled(
    ranges.map(({ firstPage, lastPage, ...options }) =>
      convertPdfBytesWithDocling(file, fileName, {
        ...options,
        fetchImpl,
        onFailure: cancelOthers,
        pageRange: [firstPage, lastPage],
        signal: controller.signal,
      })
    )
  );

  const failure = firstError ?? results.find((result) => result.status === "rejected")?.reason;

  if (failure) {
    throw failure instanceof DoclingParseError
      ? failure
      : new DoclingParseError(`docling-serve could not convert ${fileName}.`, { cause: failure });
  }

  return results.map((result) => result.value);
};

// pdf-page-extraction.js loads pdf.js; imported on first use, so a process
// that never splits a document does not load it here.
const countPdfPagesLazily = async (bytes) => {
  const { countPdfPages } = await import("./pdf-page-extraction.js");

  return countPdfPages(bytes);
};

/**
 * Converts one PDF through docling-serve and returns its pages. With
 * DOCLING_PAGE_BATCH_SIZE > 0 a document longer than that goes as page ranges
 * converted concurrently; one whose pages cannot be counted goes whole, as
 * every document did before.
 */
export const loadPdfPagesWithDocling = async (
  filePath,
  { countPages = countPdfPagesLazily, fetchImpl = globalThis.fetch } = {}
) => {
  const bytes = await readWorkingFile(filePath);
  const fileName = path.basename(filePath);
  const batchSize = getDoclingPageBatchSize();

  if (batchSize === 0) {
    return convertPdfBytesWithDocling(bytes, fileName, { fetchImpl });
  }

  let pageCount = null;

  try {
    pageCount = await countPages(bytes);
  } catch (error) {
    console.warn(
      `Could not count the pages of ${fileName} (${error?.code ?? error?.name ?? "Error"}); sending it to docling-serve as one request.`
    );
  }

  if (!Number.isInteger(pageCount) || pageCount <= batchSize) {
    return convertPdfBytesWithDocling(bytes, fileName, { fetchImpl });
  }

  const ranges = [];

  for (let firstPage = 1; firstPage <= pageCount; firstPage += batchSize) {
    ranges.push({ firstPage, lastPage: Math.min(pageCount, firstPage + batchSize - 1), route: "document" });
  }

  return (await convertPdfPageRangesWithDocling(bytes, fileName, ranges, { fetchImpl })).flat();
};

/** For the health report: is the configured docling-serve answering? */
export const probeDoclingServe = async ({ fetchImpl = globalThis.fetch } = {}) => {
  try {
    const response = await fetchImpl(`${getDoclingServeUrl()}/health`, { signal: AbortSignal.timeout(3000) });

    return { reachable: response.ok, url: getDoclingServeUrl() };
  } catch (error) {
    return { error: error.message, reachable: false, url: getDoclingServeUrl() };
  }
};
