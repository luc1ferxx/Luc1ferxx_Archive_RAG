import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  convertPdfBytesWithDocling,
  getDoclingRequestLimiterSnapshot,
  loadPdfPagesWithDocling,
  resetDoclingRequestLimiter,
} from "../rag/docling-parser.js";
import { getMetricsRegistry, setMetricsEnabled } from "../rag/metrics.js";
import "../rag/metrics-pdf.js";
import { loadPdfPagesAuto, loadPdfPagesWithRouting } from "../rag/pdf-auto-parser.js";
import { loadPdfDocument, loadPdfPages } from "../rag/pdf-loader.js";
import { checkHistogram, parseExposition, sampleValue } from "./metrics-exposition.mjs";

// PDF_PARSER=auto end to end without docling-serve: an injected pdf.js pass
// hands the router chosen signals, and a fetch stub stands in for
// docling-serve, reading the multipart form each request carries. Requests
// that must stay in flight are held on deferred promises, never on timing.

const SETTINGS = [
  "DOCLING_FALLBACK",
  "DOCLING_MAX_CONCURRENCY",
  "DOCLING_OCR",
  "DOCLING_PAGE_BATCH_SIZE",
  "DOCLING_SERVE_URL",
  "DOCLING_TIMEOUT_MS",
  "PDF_AUTO_GARBLED_RATIO",
  "PDF_AUTO_IMAGE_COVERAGE",
  "PDF_AUTO_MIN_TEXT_CHARS",
  "PDF_AUTO_ROUTES",
  "PDF_AUTO_TABLE_MIN_ROWS",
  "PDF_PARSER",
];
const savedSettings = new Map(SETTINGS.map((name) => [name, process.env[name]]));
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;
let warnings = [];
let tempDirectory = null;

const setEnv = (overrides) => Object.assign(process.env, overrides);

beforeEach(() => {
  for (const name of SETTINGS) {
    delete process.env[name];
  }

  process.env.DOCLING_SERVE_URL = "http://docling.test:5010";
  resetDoclingRequestLimiter();
  warnings = [];
  console.warn = (message) => warnings.push(String(message));
});

afterEach(async () => {
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
  setMetricsEnabled(null);

  for (const [name, value] of savedSettings) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  if (tempDirectory) {
    await rm(tempDirectory, { force: true, recursive: true });
    tempDirectory = null;
  }
});

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

// A DoclingDocument with one body text per page; "" lists the page with
// nothing on it.
const doclingDocument = (textsByPage) => {
  const entries = Object.entries(textsByPage);

  return {
    body: { children: entries.map((_entry, index) => ({ $ref: `#/texts/${index}` })) },
    pages: Object.fromEntries(entries.map(([pageNumber]) => [pageNumber, {}])),
    texts: entries.map(([pageNumber, text], index) => ({
      content_layer: "body",
      label: "text",
      prov: [{ page_no: Number(pageNumber) }],
      self_ref: `#/texts/${index}`,
      text,
    })),
  };
};

const doclingResponse = (textsByPage) => ({
  json: async () => ({ document: { json_content: doclingDocument(textsByPage) }, status: "success" }),
  ok: true,
  status: 200,
});

const failedResponse = (status = 500) => ({
  json: async () => ({ errors: [{ error_message: "worker crashed" }], status: "failure" }),
  ok: false,
  status,
});

const pagesBetween = ([first, last]) => Array.from({ length: last - first + 1 }, (_value, index) => first + index);

// Docling's text for every page of the requested range (the whole document
// is pages 1..3 when no range is sent).
const answerRange = (call) =>
  doclingResponse(
    Object.fromEntries(pagesBetween(call.pageRange.length ? call.pageRange : [1, 3]).map((page) => [page, `docling text ${page}`]))
  );

/**
 * A docling-serve stand-in. Without `respond` every request is held until the
 * test settles `calls[i].deferred`; a request's signal rejects it on abort.
 */
const createDoclingServe = ({ respond } = {}) => {
  const calls = [];
  const waiters = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const notify = () => {
    for (const waiter of [...waiters]) {
      if (calls.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };

  const fetchImpl = (url, options) => {
    const call = {
      deferred: createDeferred(),
      form: options.body,
      method: options.method,
      pageRange: options.body.getAll("page_range").map(Number),
      signal: options.signal,
      url,
    };

    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    options.signal.addEventListener("abort", () => call.deferred.reject(options.signal.reason), { once: true });

    if (respond) {
      Promise.resolve()
        .then(() => respond(call))
        .then(call.deferred.resolve, call.deferred.reject);
    }

    notify();
    return call.deferred.promise.finally(() => {
      inFlight -= 1;
    });
  };

  return {
    calls,
    fetchImpl,
    get maxInFlight() {
      return maxInFlight;
    },
    waitForCalls: (count) => {
      const waiter = createDeferred();

      waiters.push({ count, resolve: waiter.resolve });
      notify();
      return waiter.promise;
    },
  };
};

const TEXT = Object.freeze({
  charCount: 1200,
  garbledCharRatio: 0,
  imageCount: 0,
  imageCoverage: 0,
  itemCount: 30,
  lineCount: 30,
  tableCaption: false,
  tabularLineCount: 0,
});
const SIGNALS = Object.freeze({
  G: { ...TEXT, garbledCharRatio: 0.8 },
  L: { ...TEXT, tabularLineCount: 8 },
  O: { ...TEXT, charCount: 0, imageCount: 1, imageCoverage: 0.98, itemCount: 0, lineCount: 0 },
  T: TEXT,
});

/**
 * A pdf.js pass over a document described page by page: T text, L table,
 * O scan, G garbled. Page N's pdf.js text is "pdf.js text N" unless `texts`
 * says otherwise.
 */
const pdfjsPass = (spec, { calls = [], texts = {} } = {}) => async (bytes, options) => {
  calls.push({ bytes, options });

  return {
    info: null,
    pageCount: spec.length,
    pages: [...spec].map((_code, index) => ({ pageNumber: index + 1, text: texts[index + 1] ?? `pdf.js text ${index + 1}` })),
    pdfVersion: "test",
    renderedPageCount: spec.length,
    signals: [...spec].map((code, index) => ({ pageNumber: index + 1, ...SIGNALS[code] })),
  };
};

const BYTES = Buffer.from("%PDF-1.4 stub");
const readFile = async () => BYTES;

const routeAuto = (spec, serve, options = {}) =>
  loadPdfPagesWithRouting("/uploads/paper.pdf", {
    fetchImpl: serve.fetchImpl,
    parseDocument: pdfjsPass(spec, options),
    readFile,
  });

const textsOf = (pages) => pages.map((page) => page.text);

test("routed pages go to docling-serve as page ranges; layout keeps the text layer, ocr forces OCR", async () => {
  const serve = createDoclingServe({ respond: answerRange });
  const parseCalls = [];
  const { pages, routing } = await routeAuto("TLLTOT", serve, { calls: parseCalls });

  assert.equal(parseCalls.length, 1, "one pdf.js pass");
  assert.equal(parseCalls[0].bytes, BYTES, "over the bytes read once");
  assert.deepEqual(parseCalls[0].options, { collectSignals: true });
  assert.deepEqual(
    serve.calls.map((call) => ({
      doOcr: call.form.get("do_ocr"),
      file: call.form.get("files").name,
      forceOcr: call.form.get("force_ocr"),
      formats: call.form.get("to_formats"),
      images: call.form.get("image_export_mode"),
      method: call.method,
      pageRange: call.form.getAll("page_range"),
      url: call.url,
    })),
    [
      {
        doOcr: "false",
        file: "paper.pdf",
        forceOcr: null,
        formats: "json",
        images: "placeholder",
        method: "POST",
        pageRange: ["2", "3"],
        url: "http://docling.test:5010/v1/convert/file",
      },
      {
        doOcr: "true",
        file: "paper.pdf",
        forceOcr: "true",
        formats: "json",
        images: "placeholder",
        method: "POST",
        pageRange: ["5", "5"],
        url: "http://docling.test:5010/v1/convert/file",
      },
    ]
  );
  assert.deepEqual(pages, [
    { pageNumber: 1, text: "pdf.js text 1" },
    { pageNumber: 2, text: "docling text 2" },
    { pageNumber: 3, text: "docling text 3" },
    { pageNumber: 4, text: "pdf.js text 4" },
    { pageNumber: 5, text: "docling text 5" },
    { pageNumber: 6, text: "pdf.js text 6" },
  ]);
  assert.deepEqual(routing.routes, [
    { pageNumber: 1, route: "text", reasons: ["plain_text"], parser: "pdfjs" },
    { pageNumber: 2, route: "layout", reasons: ["table_rows"], parser: "docling" },
    { pageNumber: 3, route: "layout", reasons: ["table_rows"], parser: "docling" },
    { pageNumber: 4, route: "text", reasons: ["plain_text"], parser: "pdfjs" },
    { pageNumber: 5, route: "ocr", reasons: ["image_without_text"], parser: "docling" },
    { pageNumber: 6, route: "text", reasons: ["plain_text"], parser: "pdfjs" },
  ]);
  assert.deepEqual(
    routing.batches.map(({ durationMs, ...batch }) => {
      assert.ok(Number.isInteger(durationMs) && durationMs >= 0);
      return batch;
    }),
    [
      { route: "layout", firstPage: 2, lastPage: 3, outcome: "ok" },
      { route: "ocr", firstPage: 5, lastPage: 5, outcome: "ok" },
    ]
  );
  assert.equal(routing.parser, "auto");
  assert.equal(routing.pageCount, 6);
  assert.deepEqual(warnings, []);
});

test("DOCLING_OCR applies to the layout route; a garbled page is OCRed over its text layer", async () => {
  setEnv({ DOCLING_OCR: "true" });

  const serve = createDoclingServe({ respond: answerRange });
  const { routing } = await routeAuto("LG", serve);

  assert.deepEqual(
    serve.calls.map((call) => [call.form.getAll("page_range"), call.form.get("do_ocr"), call.form.get("force_ocr")]),
    [
      [["1", "1"], "true", null],
      [["2", "2"], "true", "true"],
    ]
  );
  assert.deepEqual(routing.routes.map((route) => route.reasons), [["table_rows"], ["garbled_text"]]);
});

test("DOCLING_PAGE_BATCH_SIZE splits a run of routed pages into requests", async () => {
  setEnv({ DOCLING_PAGE_BATCH_SIZE: "2" });

  const serve = createDoclingServe({ respond: answerRange });
  const { pages, routing } = await routeAuto("LLLLLT", serve);

  assert.deepEqual(serve.calls.map((call) => call.pageRange), [[1, 2], [3, 4], [5, 5]]);
  assert.deepEqual(routing.batches.map((batch) => [batch.firstPage, batch.lastPage]), [[1, 2], [3, 4], [5, 5]]);
  assert.deepEqual(textsOf(pages), [1, 2, 3, 4, 5].map((page) => `docling text ${page}`).concat("pdf.js text 6"));
});

test("a document with no routed page sends no request at all", async () => {
  const serve = createDoclingServe({
    respond: () => {
      throw new Error("docling-serve must not be called");
    },
  });

  for (const [spec, routes] of [["TTT", undefined], ["LOG", "none"]]) {
    if (routes) {
      setEnv({ PDF_AUTO_ROUTES: routes });
    }

    const { pages, routing } = await routeAuto(spec, serve);

    assert.deepEqual(textsOf(pages), ["pdf.js text 1", "pdf.js text 2", "pdf.js text 3"]);
    assert.deepEqual(routing.batches, []);
  }

  assert.equal(serve.calls.length, 0);

  // PDF_AUTO_ROUTES=none still says what each page would have taken.
  const { routing } = await routeAuto("LOG", serve);

  assert.deepEqual(routing.routes.map((route) => route.reasons), [
    ["plain_text", "layout_route_disabled"],
    ["plain_text", "ocr_route_disabled"],
    ["plain_text", "ocr_route_disabled"],
  ]);
});

test("at most DOCLING_MAX_CONCURRENCY requests are in flight, and they start in FIFO order", async () => {
  setEnv({ DOCLING_MAX_CONCURRENCY: "2" });

  const serve = createDoclingServe();
  const result = routeAuto("LTLTLTLTL", serve);

  await serve.waitForCalls(2);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 2, limit: 2, queued: 3 });
  assert.deepEqual(serve.calls.map((call) => call.pageRange[0]), [1, 3]);

  // Finishing the second request frees its slot for the next batch in line.
  serve.calls[1].deferred.resolve(answerRange(serve.calls[1]));
  await serve.waitForCalls(3);
  assert.deepEqual(serve.calls.map((call) => call.pageRange[0]), [1, 3, 5]);

  serve.calls[0].deferred.resolve(answerRange(serve.calls[0]));
  await serve.waitForCalls(4);
  serve.calls[2].deferred.resolve(answerRange(serve.calls[2]));
  await serve.waitForCalls(5);
  serve.calls[4].deferred.resolve(answerRange(serve.calls[4]));
  serve.calls[3].deferred.resolve(answerRange(serve.calls[3]));

  const { pages, routing } = await result;

  assert.deepEqual(serve.calls.map((call) => call.pageRange[0]), [1, 3, 5, 7, 9]);
  assert.equal(serve.maxInFlight, 2);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 0, limit: 2, queued: 0 });
  assert.deepEqual(
    textsOf(pages),
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((page) => (page % 2 ? `docling text ${page}` : `pdf.js text ${page}`))
  );
  assert.ok(routing.batches.every((batch) => batch.outcome === "ok"));
});

test("Docling's text replaces pdf.js text, except an empty Docling page where pdf.js had text", async () => {
  const serve = createDoclingServe({ respond: () => doclingResponse({ 1: "docling table", 2: "", 3: "" }) });
  const { pages, routing } = await routeAuto("LLL", serve, { texts: { 3: "" } });

  assert.deepEqual(pages, [
    { pageNumber: 1, text: "docling table" },
    { pageNumber: 2, text: "pdf.js text 2" },
    { pageNumber: 3, text: "" },
  ]);
  assert.deepEqual(routing.routes, [
    { pageNumber: 1, route: "layout", reasons: ["table_rows"], parser: "docling" },
    { pageNumber: 2, route: "layout", reasons: ["table_rows"], parser: "pdfjs", fallback: "docling_empty" },
    { pageNumber: 3, route: "layout", reasons: ["table_rows"], parser: "docling" },
  ]);
  assert.deepEqual(routing.batches.map((batch) => batch.outcome), ["ok"]);
});

test("a failed batch keeps its pages' pdf.js text under DOCLING_FALLBACK=pdfjs, with one warning per document", async () => {
  const serve = createDoclingServe({
    respond: (call) => {
      if (call.pageRange[0] === 2) {
        return failedResponse(503);
      }

      if (call.pageRange[0] === 7) {
        throw new Error("connect ECONNREFUSED");
      }

      return answerRange(call);
    },
  });
  const { pages, routing } = await routeAuto("TLLTOTL", serve);

  assert.deepEqual(textsOf(pages), [
    "pdf.js text 1",
    "pdf.js text 2",
    "pdf.js text 3",
    "pdf.js text 4",
    "docling text 5",
    "pdf.js text 6",
    "pdf.js text 7",
  ]);
  assert.deepEqual(
    routing.routes.map(({ fallback, pageNumber, parser }) => ({ fallback, pageNumber, parser })),
    [
      { fallback: undefined, pageNumber: 1, parser: "pdfjs" },
      { fallback: "docling_failed", pageNumber: 2, parser: "pdfjs" },
      { fallback: "docling_failed", pageNumber: 3, parser: "pdfjs" },
      { fallback: undefined, pageNumber: 4, parser: "pdfjs" },
      { fallback: undefined, pageNumber: 5, parser: "docling" },
      { fallback: undefined, pageNumber: 6, parser: "pdfjs" },
      { fallback: "docling_failed", pageNumber: 7, parser: "pdfjs" },
    ]
  );
  assert.ok(!Object.hasOwn(routing.routes[0], "fallback"), "no fallback key on a page without one");
  assert.deepEqual(routing.batches.map((batch) => batch.outcome), ["error", "ok", "error"]);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^docling-serve could not convert pages 2-3 \(DOCLING_CONVERSION_FAILED, HTTP 503\), 7 \(DOCLING_UNREACHABLE\) of paper\.pdf; those pages keep their pdf\.js text \(DOCLING_FALLBACK=pdfjs\)\.$/
  );
  assert.doesNotMatch(warnings[0], /pdf\.js text \d|docling text|http:|worker crashed/);
});

test("under DOCLING_FALLBACK=none the first failure cancels the document's other requests and is thrown", async () => {
  setEnv({ DOCLING_FALLBACK: "none", DOCLING_MAX_CONCURRENCY: "2" });

  const serve = createDoclingServe();
  const result = routeAuto("LTLTL", serve);

  await serve.waitForCalls(2);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 2, limit: 2, queued: 1 });

  serve.calls[0].deferred.resolve(failedResponse(500));

  await assert.rejects(result, {
    code: "DOCLING_CONVERSION_FAILED",
    httpStatus: 500,
    message: /could not convert paper\.pdf \(HTTP 500: worker crashed\)/,
    name: "DoclingParseError",
  });
  assert.equal(serve.calls.length, 2, "the queued batch was never sent");
  assert.equal(serve.calls[1].signal.aborted, true, "the batch in flight was cancelled");
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 0, limit: 2, queued: 0 });
  assert.deepEqual(warnings, []);
});

test("a ranged conversion maps relative page numbers into the range and refuses pages outside it", async () => {
  const convert = (pageRange, textsByPage) =>
    convertPdfBytesWithDocling(BYTES, "paper.pdf", {
      fetchImpl: async () => doclingResponse(textsByPage),
      pageRange,
    });

  // As docling-serve numbers them: the original page numbers.
  assert.deepEqual(await convert([4, 5], { 4: "four", 5: "five" }), [
    { pageNumber: 4, text: "four" },
    { pageNumber: 5, text: "five" },
  ]);
  // Numbered from 1 instead: shifted into the range, also where 1..N overlaps it.
  assert.deepEqual(await convert([4, 5], { 1: "four", 2: "five" }), [
    { pageNumber: 4, text: "four" },
    { pageNumber: 5, text: "five" },
  ]);
  assert.deepEqual(await convert([2, 3], { 1: "two", 2: "three" }), [
    { pageNumber: 2, text: "two" },
    { pageNumber: 3, text: "three" },
  ]);
  // Pages beyond the range (the whole document listed) are dropped; a page
  // Docling skipped comes back empty.
  assert.deepEqual(await convert([2, 3], { 1: "", 2: "two", 4: "" }), [
    { pageNumber: 2, text: "two" },
    { pageNumber: 3, text: "" },
  ]);
  await assert.rejects(convert([4, 5], { 7: "seven", 8: "eight" }), {
    code: "DOCLING_PAGE_RANGE_MISMATCH",
    message: "docling-serve returned pages outside the requested range 4-5 of paper.pdf.",
    name: "DoclingParseError",
  });
  await assert.rejects(convert([4, 5], { 1: "one", 2: "two", 3: "three" }), { code: "DOCLING_PAGE_RANGE_MISMATCH" });
  await assert.rejects(convertPdfBytesWithDocling(BYTES, "paper.pdf", { pageRange: [3, 2] }), TypeError);
});

test("a mismatched page range in a batch is a failed batch, not text on the wrong pages", async () => {
  const serve = createDoclingServe({ respond: () => doclingResponse({ 9: "elsewhere" }) });
  const { pages, routing } = await routeAuto("TLL", serve);

  assert.deepEqual(textsOf(pages), ["pdf.js text 1", "pdf.js text 2", "pdf.js text 3"]);
  assert.deepEqual(routing.batches.map((batch) => batch.outcome), ["error"]);
  assert.match(warnings[0], /pages 2-3 \(DOCLING_PAGE_RANGE_MISMATCH\)/);
});

test("the routing report holds codes and numbers only", async () => {
  setEnv({ DOCLING_PAGE_BATCH_SIZE: "1" });

  const serve = createDoclingServe({
    respond: (call) => (call.pageRange[0] === 3 ? failedResponse(500) : answerRange(call)),
  });
  const { routing } = await routeAuto("TLOG", serve);
  const serialized = JSON.stringify(routing);

  assert.deepEqual(Object.keys(routing), ["parser", "pageCount", "routes", "batches"]);
  for (const route of routing.routes) {
    assert.deepEqual(Object.keys(route).slice(0, 4), ["pageNumber", "route", "reasons", "parser"]);
    assert.ok(Object.keys(route).length <= 5);
  }
  for (const batch of routing.batches) {
    assert.deepEqual(Object.keys(batch), ["route", "firstPage", "lastPage", "outcome", "durationMs"]);
  }
  assert.doesNotMatch(serialized, /pdf\.js text|docling text|paper|docling\.test|http|worker crashed/);
});

test("loadPdfPagesAuto returns the pages alone, read from the working file with the real pdf.js text", async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "pdf-auto-parser-"));
  const filePath = path.join(tempDirectory, "contract.pdf");
  const serve = createDoclingServe({ respond: () => doclingResponse({ 2: "Fee | Amount: 120" }) });

  await writeFile(filePath, buildPdf(["Remote work needs approval.", "Fee 120 Late 30"]));

  const pages = await loadPdfPagesAuto(filePath, {
    fetchImpl: serve.fetchImpl,
    parseDocument: async (bytes, options) => {
      assert.ok(Buffer.isBuffer(bytes) && bytes.subarray(0, 5).toString() === "%PDF-");
      assert.deepEqual(options, { collectSignals: true });

      const document = await loadPdfDocument(filePath);

      return { ...document, signals: [{ pageNumber: 1, ...SIGNALS.T }, { pageNumber: 2, ...SIGNALS.L }] };
    },
  });

  assert.deepEqual(pages, [
    { pageNumber: 1, text: "Remote work needs approval." },
    { pageNumber: 2, text: "Fee | Amount: 120" },
  ]);
  assert.deepEqual(serve.calls.map((call) => [call.form.get("files").name, call.pageRange]), [["contract.pdf", [2, 2]]]);
});

const writeStubPdf = async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "docling-batches-"));
  const filePath = path.join(tempDirectory, "paper.pdf");

  await writeFile(filePath, BYTES);
  return filePath;
};

test("PDF_PARSER=docling with batch size 0 sends exactly the whole-document fields it always sent", async () => {
  const filePath = await writeStubPdf();
  const serve = createDoclingServe({ respond: answerRange });
  let counted = 0;
  const pages = await loadPdfPagesWithDocling(filePath, {
    countPages: async () => {
      counted += 1;
      return 3;
    },
    fetchImpl: serve.fetchImpl,
  });

  assert.equal(counted, 0, "no page count without a batch size");
  assert.deepEqual(textsOf(pages), ["docling text 1", "docling text 2", "docling text 3"]);
  assert.equal(serve.calls.length, 1);
  assert.deepEqual(
    [...serve.calls[0].form.entries()].map(([name, value]) => [name, typeof value === "string" ? value : value.name]),
    [
      ["files", "paper.pdf"],
      ["to_formats", "json"],
      ["image_export_mode", "placeholder"],
      ["do_ocr", "false"],
    ]
  );
});

test("PDF_PARSER=docling with DOCLING_PAGE_BATCH_SIZE converts page ranges concurrently", async () => {
  setEnv({ DOCLING_PAGE_BATCH_SIZE: "2" });

  const filePath = await writeStubPdf();
  const serve = createDoclingServe({ respond: answerRange });
  const counted = [];
  const pages = await loadPdfPagesWithDocling(filePath, {
    countPages: async (bytes) => {
      counted.push(bytes);
      return 5;
    },
    fetchImpl: serve.fetchImpl,
  });

  assert.equal(counted.length, 1);
  assert.deepEqual(counted[0], BYTES);
  assert.deepEqual(serve.calls.map((call) => call.pageRange), [[1, 2], [3, 4], [5, 5]]);
  assert.ok(serve.calls.every((call) => call.form.get("do_ocr") === "false" && call.form.get("force_ocr") === null));
  assert.equal(serve.maxInFlight, 2, "within DOCLING_MAX_CONCURRENCY (2 by default)");
  assert.deepEqual(pages, [1, 2, 3, 4, 5].map((pageNumber) => ({ pageNumber, text: `docling text ${pageNumber}` })));

  // A document that fits in one batch goes whole, as before.
  serve.calls.length = 0;
  await loadPdfPagesWithDocling(filePath, { countPages: async () => 2, fetchImpl: serve.fetchImpl });
  assert.deepEqual(serve.calls.map((call) => call.form.getAll("page_range")), [[]]);
});

test("PDF_PARSER=docling page ranges: the first failure cancels the others and rejects", async () => {
  setEnv({ DOCLING_PAGE_BATCH_SIZE: "1" });

  const filePath = await writeStubPdf();
  const serve = createDoclingServe();
  const result = loadPdfPagesWithDocling(filePath, { countPages: async () => 3, fetchImpl: serve.fetchImpl });

  await serve.waitForCalls(2);
  serve.calls[0].deferred.reject(new Error("connect ECONNREFUSED"));

  await assert.rejects(result, {
    code: "DOCLING_UNREACHABLE",
    message: /unreachable: connect ECONNREFUSED/,
    name: "DoclingParseError",
  });
  assert.equal(serve.calls.length, 2);
  assert.equal(serve.calls[1].signal.aborted, true);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 0, limit: 2, queued: 0 });
});

test("PDF_PARSER=docling sends the document whole when its pages cannot be counted", async () => {
  setEnv({ DOCLING_PAGE_BATCH_SIZE: "1" });

  const filePath = await writeStubPdf();
  const serve = createDoclingServe({ respond: answerRange });
  const pages = await loadPdfPagesWithDocling(filePath, {
    countPages: async () => {
      throw Object.assign(new Error("Invalid PDF structure."), { name: "InvalidPDFException" });
    },
    fetchImpl: serve.fetchImpl,
  });

  assert.equal(pages.length, 3);
  assert.equal(serve.calls.length, 1);
  assert.deepEqual(serve.calls[0].form.getAll("page_range"), []);
  assert.deepEqual(warnings, [
    "Could not count the pages of paper.pdf (InvalidPDFException); sending it to docling-serve as one request.",
  ]);
});

test("DOCLING_TIMEOUT_MS starts when a request gets its slot: a queued request does not time out while it waits", async (t) => {
  setEnv({ DOCLING_MAX_CONCURRENCY: "1", DOCLING_TIMEOUT_MS: "1000" });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const serve = createDoclingServe();
  const first = convertPdfBytesWithDocling(BYTES, "a.pdf", { fetchImpl: serve.fetchImpl, pageRange: [1, 1] });
  const firstOutcome = first.then(
    () => null,
    (error) => error
  );
  const second = convertPdfBytesWithDocling(BYTES, "b.pdf", { fetchImpl: serve.fetchImpl, pageRange: [2, 2] });

  await serve.waitForCalls(1);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 1, limit: 1, queued: 1 });

  // Past the first request's timeout; the second has waited just as long.
  t.mock.timers.tick(1500);
  assert.equal((await firstOutcome)?.code, "DOCLING_TIMEOUT");

  await serve.waitForCalls(2);
  assert.equal(serve.calls[1].signal.aborted, false, "the wait for a slot did not count");
  t.mock.timers.tick(999);
  assert.equal(serve.calls[1].signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(serve.calls[1].signal.aborted, true, "a full timeout once it was sent");
  await assert.rejects(second, { code: "DOCLING_TIMEOUT", message: /aborted due to timeout/ });
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 0, limit: 1, queued: 0 });
});

// Counts the Blobs made while it is installed: each one is a copy of the PDF.
const countBlobCopies = (t) => {
  const OriginalBlob = globalThis.Blob;
  const copies = [];

  globalThis.Blob = class CountingBlob extends OriginalBlob {
    constructor(...args) {
      super(...args);
      copies.push(this.size);
    }
  };
  t.after(() => {
    globalThis.Blob = OriginalBlob;
  });

  return copies;
};

const sentBytes = async (call) => Buffer.from(await call.form.get("files").arrayBuffer());

test("a document's requests share one copy of the PDF, and a request waiting for a slot holds none", async (t) => {
  setEnv({ DOCLING_MAX_CONCURRENCY: "1" });

  const copies = countBlobCopies(t);

  // auto: five table runs behind one slot.
  const serve = createDoclingServe();
  const routed = routeAuto("LTLTLTLTL", serve);

  await serve.waitForCalls(1);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 1, limit: 1, queued: 4 });
  assert.deepEqual(copies, [BYTES.length], "one copy for the document's five requests");

  for (let index = 0; index < 5; index += 1) {
    await serve.waitForCalls(index + 1);
    serve.calls[index].deferred.resolve(answerRange(serve.calls[index]));
  }

  const { routing } = await routed;

  assert.ok(routing.batches.every((batch) => batch.outcome === "ok"));
  assert.deepEqual(copies, [BYTES.length]);
  for (const call of serve.calls) {
    assert.deepEqual(await sentBytes(call), BYTES);
  }

  // PDF_PARSER=docling page ranges: one copy too.
  setEnv({ DOCLING_PAGE_BATCH_SIZE: "1" });
  copies.length = 0;

  const filePath = await writeStubPdf();
  const ranged = createDoclingServe({ respond: answerRange });

  await loadPdfPagesWithDocling(filePath, { countPages: async () => 3, fetchImpl: ranged.fetchImpl });
  assert.equal(ranged.calls.length, 3);
  assert.deepEqual(copies, [BYTES.length]);

  // Two whole-document requests: the queued one makes its copy only once it
  // has the slot.
  copies.length = 0;

  const held = createDoclingServe();
  const first = convertPdfBytesWithDocling(BYTES, "a.pdf", { fetchImpl: held.fetchImpl });
  const second = convertPdfBytesWithDocling(BYTES, "b.pdf", { fetchImpl: held.fetchImpl });

  await held.waitForCalls(1);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 1, limit: 1, queued: 1 });
  assert.deepEqual(copies, [BYTES.length], "the queued request built no body");
  held.calls[0].deferred.resolve(answerRange(held.calls[0]));
  await first;
  await held.waitForCalls(2);
  assert.deepEqual(copies, [BYTES.length, BYTES.length]);
  held.calls[1].deferred.resolve(answerRange(held.calls[1]));
  await second;
});

test("under DOCLING_FALLBACK=pdfjs an unreachable docling-serve drops the document's queued requests; the one in flight finishes", async () => {
  setEnv({ DOCLING_MAX_CONCURRENCY: "2" });

  const serve = createDoclingServe();
  const result = routeAuto("LTLTLTL", serve);

  await serve.waitForCalls(2);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 2, limit: 2, queued: 2 });
  serve.calls[0].deferred.reject(new Error("connect ECONNREFUSED"));
  // The page-5 and page-7 requests left the queue without being sent.
  while (getDoclingRequestLimiterSnapshot().queued > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 1, limit: 2, queued: 0 });
  serve.calls[1].deferred.resolve(answerRange(serve.calls[1]));

  const { pages, routing } = await result;

  assert.equal(serve.calls.length, 2);
  assert.deepEqual(textsOf(pages), [
    "pdf.js text 1",
    "pdf.js text 2",
    "docling text 3",
    "pdf.js text 4",
    "pdf.js text 5",
    "pdf.js text 6",
    "pdf.js text 7",
  ]);
  assert.deepEqual(routing.batches.map((batch) => batch.outcome), ["error", "ok", "aborted", "aborted"]);
  assert.deepEqual(
    routing.routes.filter((route) => route.fallback).map((route) => route.pageNumber),
    [1, 5, 7]
  );
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /pages 1 \(DOCLING_UNREACHABLE\), 5 \(DOCLING_REQUEST_ABORTED\), 7 \(DOCLING_REQUEST_ABORTED\) of paper\.pdf/
  );
});

test("under DOCLING_FALLBACK=pdfjs a timed-out request ends the document's wait: one DOCLING_TIMEOUT_MS, not one per slot's worth of requests", async (t) => {
  setEnv({ DOCLING_MAX_CONCURRENCY: "1", DOCLING_TIMEOUT_MS: "1000" });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const serve = createDoclingServe();
  const result = routeAuto("LTLTLTL", serve);

  await serve.waitForCalls(1);
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 1, limit: 1, queued: 3 });
  t.mock.timers.tick(1000);

  const { pages, routing } = await result;

  assert.equal(serve.calls.length, 1, "no queued request was sent after the timeout");
  assert.deepEqual(getDoclingRequestLimiterSnapshot(), { active: 0, limit: 1, queued: 0 });
  assert.deepEqual(textsOf(pages), [1, 2, 3, 4, 5, 6, 7].map((page) => `pdf.js text ${page}`));
  assert.deepEqual(routing.batches.map((batch) => batch.outcome), ["error", "aborted", "aborted", "aborted"]);
  assert.match(warnings[0], /pages 1 \(DOCLING_TIMEOUT\), 3 \(DOCLING_REQUEST_ABORTED\)/);
});

const PDF_FAMILIES = [
  "archive_rag_pdf_docling_request_duration_seconds",
  "archive_rag_pdf_docling_requests_total",
  "archive_rag_pdf_pages_total",
  "archive_rag_pdf_parse_fallbacks_total",
];

const readPdfMetrics = () => parseExposition(getMetricsRegistry().render());

test("metrics count pages by route and parser, requests by outcome, and fallbacks, in every PDF_PARSER mode", async () => {
  setMetricsEnabled(true);
  for (const name of PDF_FAMILIES) {
    getMetricsRegistry().getFamily(name).clear();
  }

  // auto: a table run with an empty Docling page, a failed OCR page.
  const serve = createDoclingServe({
    respond: (call) => (call.pageRange[0] === 5 ? failedResponse(500) : doclingResponse({ 2: "docling 2", 3: "" })),
  });

  await routeAuto("TLLTO", serve);

  let families = readPdfMetrics();

  assert.equal(sampleValue(families, "archive_rag_pdf_pages_total", { parser: "pdfjs", route: "text" }), 2);
  assert.equal(sampleValue(families, "archive_rag_pdf_pages_total", { parser: "docling", route: "layout" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_pages_total", { parser: "pdfjs", route: "layout" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_pages_total", { parser: "pdfjs", route: "ocr" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_requests_total", { outcome: "ok", route: "layout" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_requests_total", { outcome: "error", route: "ocr" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_request_duration_seconds_count", { route: "layout" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_request_duration_seconds_count", { route: "ocr" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_parse_fallbacks_total", { reason: "docling_empty" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_parse_fallbacks_total", { reason: "docling_failed" }), 1);
  assert.equal(checkHistogram(families.get("archive_rag_pdf_docling_request_duration_seconds")).size, 2);

  // A cancelled batch: one aborted in flight, one aborted in the queue (not timed).
  setEnv({ DOCLING_FALLBACK: "none", DOCLING_MAX_CONCURRENCY: "2" });
  const held = createDoclingServe();
  const cancelled = routeAuto("LTLTL", held);

  await held.waitForCalls(2);
  held.calls[0].deferred.resolve(failedResponse(500));
  await assert.rejects(cancelled);
  families = readPdfMetrics();
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_requests_total", { outcome: "aborted", route: "layout" }), 2);
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_requests_total", { outcome: "error", route: "layout" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_request_duration_seconds_count", { route: "layout" }), 3);
  delete process.env.DOCLING_FALLBACK;

  // pdfjs and docling route nothing; docling's whole-document fallback counts its pages.
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "pdf-metrics-"));
  const filePath = path.join(tempDirectory, "two.pdf");

  await writeFile(filePath, buildPdf(["First page.", "Second page."]));
  warnings = [];
  setEnv({ PDF_PARSER: "pdfjs" });
  await loadPdfPages(filePath);

  setEnv({ PDF_PARSER: "docling" });
  globalThis.fetch = async () => doclingResponse({ 1: "one", 2: "two" });
  await loadPdfPages(filePath);

  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  await loadPdfPages(filePath);

  families = readPdfMetrics();
  assert.equal(sampleValue(families, "archive_rag_pdf_pages_total", { parser: "pdfjs", route: "unrouted" }), 4);
  assert.equal(sampleValue(families, "archive_rag_pdf_pages_total", { parser: "docling", route: "unrouted" }), 2);
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_requests_total", { outcome: "ok", route: "document" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_docling_requests_total", { outcome: "error", route: "document" }), 1);
  assert.equal(sampleValue(families, "archive_rag_pdf_parse_fallbacks_total", { reason: "docling_document" }), 2);
  assert.equal(warnings.length, 1, "the whole-document fallback's warning");

  // Off: nothing is recorded.
  setMetricsEnabled(false);
  for (const name of PDF_FAMILIES) {
    getMetricsRegistry().getFamily(name).clear();
  }
  await routeAuto("TLO", createDoclingServe({ respond: answerRange }));
  families = readPdfMetrics();
  for (const name of ["archive_rag_pdf_pages_total", "archive_rag_pdf_docling_requests_total"]) {
    assert.equal(sampleValue(families, name), 0, name);
  }
});

// A minimal PDF, one Helvetica line per page.
function buildPdf(pageTexts) {
  const escape = (text) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageTexts.map((_text, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  pageTexts.forEach((text, index) => {
    const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escape(text)}) Tj\nET`;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    );
  });

  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const offset = Buffer.byteLength(pdf);

    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xrefOffset = Buffer.byteLength(pdf);

  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf);
}
