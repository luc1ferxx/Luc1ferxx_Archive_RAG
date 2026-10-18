// PDF_PARSER=auto end to end: loadPdfPages over a generated PDF (test/pdf-
// fixture-builder.mjs) with the real pdf.js pass and its real page signals,
// the real router and limiter, and a docling-serve stand-in in place of
// globalThis.fetch. The PDF holds a prose page, a table page, a page that is
// one full-page image without text, and a closing prose page: only the
// table page (layout, no OCR) and the image page (OCR forced) may reach
// docling-serve, each as its own page_range request, and Docling's text may
// replace those pages only. The worker pool (PDF_PARSE_WORKERS) must not
// change a byte of it, and a failed request under DOCLING_FALLBACK=pdfjs
// keeps the pdf.js text.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";

import { resetDoclingRequestLimiter } from "../rag/docling-parser.js";
import { loadPdfPagesWithRouting } from "../rag/pdf-auto-parser.js";
import { loadPdfPages } from "../rag/pdf-loader.js";
import { getPdfParsePoolSnapshot, resetPdfParsePool } from "../rag/pdf-parse-pool.js";
import { buildPdf, GREY_IMAGE, textLines } from "./pdf-fixture-builder.mjs";

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
  "PDF_PARAGRAPH_DETECTION",
  "PDF_PARSE_PAGES_PER_TASK",
  "PDF_PARSE_TIMEOUT_MS",
  "PDF_PARSE_WORKER_MAX_OLD_GENERATION_MB",
  "PDF_PARSE_WORKERS",
  "PDF_PARSER",
  "TENANT_ENCRYPTION",
];
const DOCLING_URL = "http://docling.test:5010";
const savedSettings = new Map(SETTINGS.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

// What the stand-in's Docling "reads" on the routed pages.
const DOCLING_TEXT = Object.freeze({
  2: "Region | Revenue | Growth; Region: North; Revenue: 12.1; Growth: 3",
  3: "Text recognised on the scanned page.",
});

// pdf.js text of the two prose pages (paragraph detection on, the default).
const PROSE_TEXT = Object.freeze({
  1: "Remote work policy\nEmployees may work remotely two days a week when their manager approves the schedule in writing.",
  4: "The last page closes the policy.",
});

let directory;
let pdfPath;
let pdfBytes;
let warnings;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "pdf-auto-e2e-"));
  pdfPath = path.join(directory, "policy.pdf");
  await writeFile(
    pdfPath,
    buildPdf({
      pages: [
        textLines([
          "Remote work policy",
          "Employees may work remotely two days a week when",
          "their manager approves the schedule in writing.",
        ]),
        textLines([
          [[72, "Region"], [250, "Revenue"], [400, "Growth"]],
          [[72, "North"], [250, "12.1"], [400, "3"]],
          [[72, "South"], [250, "18.4"], [400, "7"]],
          [[72, "East"], [250, "9.9"], [400, "2"]],
          [[72, "West"], [250, "15.0"], [400, "5"]],
        ]),
        "q 612 0 0 792 0 0 cm /Im1 Do Q",
        textLines(["The last page closes the policy."]),
      ],
      xobjects: { Im1: GREY_IMAGE },
    })
  );
  pdfBytes = await readFile(pdfPath);
});

after(async () => {
  await rm(directory, { force: true, recursive: true });
});

beforeEach(async () => {
  for (const name of SETTINGS) {
    delete process.env[name];
  }

  process.env.DOCLING_SERVE_URL = DOCLING_URL;
  process.env.PDF_PARSER = "auto";
  resetDoclingRequestLimiter();
  await resetPdfParsePool();
  warnings = [];
  console.warn = (message) => warnings.push(String(message));
});

afterEach(async () => {
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
  await resetPdfParsePool();

  for (const [name, value] of savedSettings) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const pagesBetween = (first, last) => Array.from({ length: last - first + 1 }, (_value, index) => first + index);

const doclingResponse = (pageNumbers) => ({
  json: async () => ({
    document: {
      json_content: {
        body: { children: pageNumbers.map((_page, index) => ({ $ref: `#/texts/${index}` })) },
        pages: Object.fromEntries(pageNumbers.map((page) => [page, {}])),
        texts: pageNumbers.map((page, index) => ({
          content_layer: "body",
          label: "text",
          prov: [{ page_no: page }],
          self_ref: `#/texts/${index}`,
          text: DOCLING_TEXT[page] ?? "",
        })),
      },
    },
    status: "success",
  }),
  ok: true,
  status: 200,
});

/**
 * docling-serve in place of globalThis.fetch: records every request's form
 * and answers each requested page with DOCLING_TEXT, unless `respond(call)`
 * answers (or throws) instead.
 */
const installDoclingServe = ({ respond } = {}) => {
  const calls = [];

  globalThis.fetch = async (url, { body, method, signal } = {}) => {
    const file = body.get("files");
    const call = {
      bytes: Buffer.from(await file.arrayBuffer()),
      doOcr: body.get("do_ocr"),
      fileName: file.name,
      forceOcr: body.get("force_ocr"),
      imageExportMode: body.get("image_export_mode"),
      method,
      pageRange: body.getAll("page_range"),
      toFormats: body.get("to_formats"),
      url,
    };

    assert.ok(signal instanceof AbortSignal, "every request carries a signal");
    calls.push(call);

    if (respond) {
      return respond(call);
    }

    const [first, last] = call.pageRange.map(Number);

    return doclingResponse(pagesBetween(first, last));
  };

  return calls;
};

const byFirstPage = (calls) => [...calls].sort((left, right) => Number(left.pageRange[0]) - Number(right.pageRange[0]));

const describeCall = ({ bytes, ...call }) => {
  assert.ok(bytes.equals(pdfBytes), "every request sends the whole file");
  return call;
};

const EXPECTED_REQUESTS = Object.freeze([
  {
    doOcr: "false",
    fileName: "policy.pdf",
    forceOcr: null,
    imageExportMode: "placeholder",
    method: "POST",
    pageRange: ["2", "2"],
    toFormats: "json",
    url: `${DOCLING_URL}/v1/convert/file`,
  },
  {
    doOcr: "true",
    fileName: "policy.pdf",
    forceOcr: "true",
    imageExportMode: "placeholder",
    method: "POST",
    pageRange: ["3", "3"],
    toFormats: "json",
    url: `${DOCLING_URL}/v1/convert/file`,
  },
]);

const EXPECTED_ROUTES = Object.freeze([
  { pageNumber: 1, route: "text", reasons: ["plain_text"], parser: "pdfjs" },
  { pageNumber: 2, route: "layout", reasons: ["table_rows"], parser: "docling" },
  { pageNumber: 3, route: "ocr", reasons: ["image_without_text"], parser: "docling" },
  { pageNumber: 4, route: "text", reasons: ["plain_text"], parser: "pdfjs" },
]);

// The document under PDF_PARSER=pdfjs, which never calls docling-serve.
const loadPdfjsPages = async () => {
  const calls = installDoclingServe();
  const previous = process.env.PDF_PARSER;

  process.env.PDF_PARSER = "pdfjs";

  try {
    const pages = await loadPdfPages(pdfPath);

    assert.deepEqual(calls, []);
    return pages;
  } finally {
    process.env.PDF_PARSER = previous;
  }
};

const withoutDurations = (routing) => ({
  ...routing,
  batches: routing.batches.map(({ durationMs, ...batch }) => {
    assert.ok(Number.isInteger(durationMs) && durationMs >= 0);
    return batch;
  }),
});

test("PDF_PARSER=auto: the table page goes without OCR, the image page with OCR forced, and only their text is Docling's", async () => {
  const pdfjsPages = await loadPdfjsPages();

  assert.deepEqual(pdfjsPages.map((page) => page.pageNumber), [1, 2, 3, 4]);
  assert.equal(pdfjsPages[0].text, PROSE_TEXT[1]);
  assert.equal(pdfjsPages[2].text, "", "pdf.js finds no text on the image page");
  assert.equal(pdfjsPages[3].text, PROSE_TEXT[4]);

  const calls = installDoclingServe();
  const pages = await loadPdfPages(pdfPath);

  assert.deepEqual(byFirstPage(calls).map(describeCall), EXPECTED_REQUESTS);
  assert.deepEqual(pages, [
    pdfjsPages[0],
    { pageNumber: 2, text: DOCLING_TEXT[2] },
    { pageNumber: 3, text: DOCLING_TEXT[3] },
    pdfjsPages[3],
  ]);
  assert.deepEqual(warnings, []);

  const { pages: routedPages, routing } = await loadPdfPagesWithRouting(pdfPath);

  assert.deepEqual(routedPages, pages);
  assert.deepEqual(withoutDurations(routing), {
    parser: "auto",
    pageCount: 4,
    routes: EXPECTED_ROUTES,
    batches: [
      { route: "layout", firstPage: 2, lastPage: 2, outcome: "ok" },
      { route: "ocr", firstPage: 3, lastPage: 3, outcome: "ok" },
    ],
  });
});

test("PDF_PARSE_WORKERS=2 with one page per task: the same requests and pages, parsed on the worker pool", async () => {
  const inProcessCalls = installDoclingServe();
  const inProcess = await loadPdfPagesWithRouting(pdfPath);

  assert.equal(getPdfParsePoolSnapshot().completedTasks, 0, "workers 0 parses in this thread");

  process.env.PDF_PARSE_WORKERS = "2";
  process.env.PDF_PARSE_PAGES_PER_TASK = "1";

  const pooledCalls = installDoclingServe();
  const pooled = await loadPdfPagesWithRouting(pdfPath);
  const pooledPages = await loadPdfPages(pdfPath);
  const snapshot = getPdfParsePoolSnapshot();

  assert.equal(snapshot.size, 2);
  assert.equal(snapshot.completedTasks, 8, "two documents of four one-page tasks each");
  assert.equal(snapshot.failedTasks, 0);
  assert.deepEqual(pooled.pages, inProcess.pages);
  assert.deepEqual(pooledPages, inProcess.pages);
  assert.deepEqual(withoutDurations(pooled.routing), withoutDurations(inProcess.routing));
  assert.deepEqual(withoutDurations(pooled.routing).routes, EXPECTED_ROUTES);
  assert.deepEqual(byFirstPage(inProcessCalls).map(describeCall), EXPECTED_REQUESTS);
  assert.deepEqual(byFirstPage(pooledCalls).map(describeCall), byFirstPage([...EXPECTED_REQUESTS, ...EXPECTED_REQUESTS]));
  assert.deepEqual(warnings, []);
});

test("DOCLING_FALLBACK=pdfjs: a failed request keeps its pages' pdf.js text, the others take Docling's", async () => {
  const pdfjsPages = await loadPdfjsPages();

  process.env.DOCLING_FALLBACK = "pdfjs";

  const failedConversion = {
    json: async () => ({ errors: [{ error_message: "table model crashed" }], status: "failure" }),
    ok: false,
    status: 500,
  };
  const calls = installDoclingServe({
    respond: (call) => (call.pageRange[0] === "2" ? failedConversion : doclingResponse([3])),
  });
  const { pages, routing } = await loadPdfPagesWithRouting(pdfPath);

  assert.equal(calls.length, 2);
  assert.deepEqual(pages, [pdfjsPages[0], pdfjsPages[1], { pageNumber: 3, text: DOCLING_TEXT[3] }, pdfjsPages[3]]);
  assert.match(pdfjsPages[1].text, /^Region Revenue Growth\nNorth 12\.1 3\n/, "the table page keeps the pdf.js table text");
  assert.deepEqual(
    routing.routes.map(({ fallback, parser, route }) => [route, parser, fallback ?? null]),
    [
      ["text", "pdfjs", null],
      ["layout", "pdfjs", "docling_failed"],
      ["ocr", "docling", null],
      ["text", "pdfjs", null],
    ]
  );
  assert.deepEqual(
    routing.batches.map(({ outcome, route }) => [route, outcome]),
    [
      ["layout", "error"],
      ["ocr", "ok"],
    ]
  );
  assert.deepEqual(warnings, [
    "docling-serve could not convert pages 2 (DOCLING_CONVERSION_FAILED, HTTP 500) of policy.pdf; those pages keep their pdf.js text (DOCLING_FALLBACK=pdfjs).",
  ]);

  // docling-serve unreachable: every page keeps its pdf.js text, through
  // loadPdfPages as an upload would read it.
  warnings.length = 0;
  installDoclingServe({
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });

  assert.deepEqual(await loadPdfPages(pdfPath), pdfjsPages);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^docling-serve could not convert pages 2 \(DOCLING_UNREACHABLE\), 3 \(DOCLING_UNREACHABLE\) of policy\.pdf;/);

  for (const text of [PROSE_TEXT[1], "Region", "North"]) {
    assert.equal(warnings[0].includes(text), false, "a warning names pages and codes, never page text");
  }
});

test("DOCLING_FALLBACK=none: a failed request fails the document", async () => {
  process.env.DOCLING_FALLBACK = "none";
  installDoclingServe({
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(loadPdfPages(pdfPath), { code: "DOCLING_UNREACHABLE", name: "DoclingParseError", status: 502 });
  assert.deepEqual(warnings, []);
});
