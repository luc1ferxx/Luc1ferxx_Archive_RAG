import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import {
  containsGoldSpan,
  createLayoutParsers,
  describeLayoutPdfConfig,
  formatMarkdown,
  pairedDelta,
  parseParserPair,
  selectTablePapers,
  summarizeAutoRouting,
} from "../evaluation/run-layout-parsing-eval.mjs";
import { loadPdfPagesWithDocling, resetDoclingRequestLimiter } from "../rag/docling-parser.js";
import { loadPdfPagesWithRouting } from "../rag/pdf-auto-parser.js";
import { loadPdfDocument } from "../rag/pdf-loader.js";
import { buildPdf, GREY_IMAGE, textLines } from "./pdf-fixture-builder.mjs";

const qa = ({ evidence = [], unanswerable = false }) => ({
  answers: [{ answer: { evidence, extractive_spans: [], unanswerable } }],
  question: "q",
});

test("papers are ranked by answerable table-evidence questions, ties by id", () => {
  const table = qa({ evidence: ["FLOAT SELECTED: Table 2: Results."] });
  const qasper = {
    "1901.00002": { qas: [table, table] },
    "1901.00001": { qas: [table, table, qa({ evidence: ["a paragraph"] })] },
    "1901.00003": { qas: [table] },
    "1901.00004": { qas: [qa({ evidence: ["FLOAT SELECTED: Table 1"], unanswerable: true })] },
    "1901.00005": { qas: [qa({ evidence: ["FLOAT SELECTED: Figure 1: Loss."] })] },
  };

  assert.deepEqual(selectTablePapers(qasper, 5), ["1901.00001", "1901.00002", "1901.00003"]);
  assert.deepEqual(selectTablePapers(qasper, 1), ["1901.00001"]);
});

test("a gold span matches whole normalized tokens only", () => {
  const row = "Embeddings: GloVe; OurNepali Raw Test: 76.86";

  assert.equal(containsGoldSpan(row, ["76.86"]), true);
  assert.equal(containsGoldSpan(row, ["the GloVe"]), true, "articles and case are normalized away");
  assert.equal(containsGoldSpan(row, ["6.86"]), false, "no partial-token match");
  assert.equal(containsGoldSpan(row, ["", "fastText"]), false);
});

test("paired deltas use only questions both parsers scored", () => {
  const rows = [
    { docling: { f1: 1, inContext: true }, pdfjs: { f1: 0, inContext: false } },
    { docling: { f1: 0.5, inContext: null }, pdfjs: { f1: 0.5, inContext: null } },
  ];
  const f1 = pairedDelta(rows, "f1", { iterations: 200 });
  const inContext = pairedDelta(rows, "inContext", { iterations: 200 });

  assert.equal(f1.cases, 2);
  assert.equal(f1.delta, 0.5);
  assert.ok(f1.ci95[0] >= 0 && f1.ci95[1] <= 1);
  assert.deepEqual(inContext, { cases: 1, ci95: [1, 1], delta: 1 });
  assert.deepEqual(pairedDelta([], "f1"), { cases: 0, ci95: null, delta: null });
});

test("--parsers picks two distinct known parsers, base first; pdf.js vs Docling by default", () => {
  assert.deepEqual(parseParserPair(undefined), ["pdfjs", "docling"]);
  assert.deepEqual(parseParserPair("pdfjs, pdfjs-paragraphs"), ["pdfjs", "pdfjs-paragraphs"]);
  assert.deepEqual(parseParserPair("pdfjs-paragraphs,auto"), ["pdfjs-paragraphs", "auto"]);
  assert.throws(() => parseParserPair("auto,auto"), /out of pdfjs, docling, pdfjs-paragraphs, auto, base first/);
  assert.throws(() => parseParserPair("pdfjs"), /two distinct parsers/);
  assert.throws(() => parseParserPair("pdfjs,pdfjs"), /two distinct parsers/);
  assert.throws(() => parseParserPair("pdfjs,tika"), /two distinct parsers/);
});

test("config.pdf records the configured PDF settings and what each arm parses with", () => {
  assert.deepEqual(
    describeLayoutPdfConfig(["pdfjs-paragraphs", "auto"], { paragraphDetection: false, parser: "pdfjs" }),
    {
      arms: {
        auto: { paragraphDetection: false, parser: "auto" },
        "pdfjs-paragraphs": { paragraphDetection: true, parser: "pdfjs" },
      },
      paragraphDetection: false,
      parser: "pdfjs",
    }
  );
  assert.deepEqual(describeLayoutPdfConfig(["pdfjs", "docling"], { paragraphDetection: true, parser: "auto" }).arms, {
    docling: { paragraphDetection: null, parser: "docling" },
    pdfjs: { paragraphDetection: false, parser: "pdfjs" },
  });
});

test("paired deltas follow the chosen pair: variant minus base", () => {
  const rows = [
    { pdfjs: { f1: 0.25 }, "pdfjs-paragraphs": { f1: 0.75 } },
    { pdfjs: { f1: 0.5 }, "pdfjs-paragraphs": { f1: null } },
    { pdfjs: { f1: 0.5 } },
  ];

  assert.deepEqual(pairedDelta(rows, "f1", { base: "pdfjs", iterations: 50, variant: "pdfjs-paragraphs" }), {
    cases: 1,
    ci95: [0.5, 0.5],
    delta: 0.5,
  });
});

// ---------------------------------------------------------------------------
// The parser arms over a generated PDF, with a fetch stub for docling-serve:
// page 1 prose (text), page 2 a five-row table (layout), page 3 a full-page
// image (ocr).

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
  "PDF_PARSE_WORKERS",
  "PDF_PARSER",
];
const savedSettings = new Map(SETTINGS.map((name) => [name, process.env[name]]));
let tempDirectory;
let pdfPath;

before(async () => {
  for (const name of SETTINGS) {
    delete process.env[name];
  }

  process.env.DOCLING_SERVE_URL = "http://docling.test:5010";
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "layout-parsing-eval-"));
  pdfPath = path.join(tempDirectory, "1901.00001.pdf");
  await writeFile(
    pdfPath,
    buildPdf({
      pages: [
        textLines(["Results are reported per region and", "summarized in the table on the next page."]),
        textLines([
          [[72, "Region"], [250, "Revenue"], [400, "Growth"]],
          [[72, "North"], [250, "12.1"], [400, "3"]],
          [[72, "South"], [250, "18.4"], [400, "7"]],
          [[72, "East"], [250, "9.9"], [400, "2"]],
          [[72, "West"], [250, "15.0"], [400, "5"]],
        ]),
        "q 612 0 0 792 0 0 cm /Im1 Do Q",
      ],
      xobjects: { Im1: GREY_IMAGE },
    })
  );
});

after(async () => {
  for (const [name, value] of savedSettings) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(tempDirectory, { force: true, recursive: true });
});

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
          text: `Docling page ${page}`,
        })),
      },
    },
    status: "success",
  }),
  ok: true,
  status: 200,
});

// Answers every requested page (pages 1..3 for a whole-document request).
const createDoclingStub = () => {
  const calls = [];
  const fetchImpl = async (url, { body }) => {
    const pageRange = body.getAll("page_range").map(Number);
    const [first, last] = pageRange.length ? pageRange : [1, 3];

    calls.push({ forceOcr: body.get("force_ocr"), pageRange, url });
    return doclingResponse(Array.from({ length: last - first + 1 }, (_value, index) => first + index));
  };

  return { calls, fetchImpl };
};

const createArms = (fetchImpl) =>
  createLayoutParsers({ fetchImpl, loadPdfDocument, loadPdfPagesWithDocling, loadPdfPagesWithRouting });

test("the auto arm parses as PDF_PARSER=auto and returns its routing report; the other arms are unchanged", async () => {
  resetDoclingRequestLimiter();
  const stub = createDoclingStub();
  const arms = createArms(stub.fetchImpl);
  const legacy = (await loadPdfDocument(pdfPath, { paragraphDetection: false })).pages;
  const paragraphs = (await loadPdfDocument(pdfPath, { paragraphDetection: true })).pages;

  assert.deepEqual(Object.keys(arms).sort(), ["auto", "docling", "pdfjs", "pdfjs-paragraphs"]);
  assert.deepEqual(await arms.pdfjs(pdfPath), { pages: legacy, routing: null });
  assert.deepEqual(await arms["pdfjs-paragraphs"](pdfPath), { pages: paragraphs, routing: null });
  assert.deepEqual(stub.calls, [], "the pdf.js arms never call docling-serve");

  const auto = await arms.auto(pdfPath);

  assert.deepEqual(auto.pages, [
    paragraphs[0],
    { pageNumber: 2, text: "Docling page 2" },
    { pageNumber: 3, text: "Docling page 3" },
  ]);
  assert.deepEqual(
    auto.routing.routes.map(({ parser, route }) => [route, parser]),
    [
      ["text", "pdfjs"],
      ["layout", "docling"],
      ["ocr", "docling"],
    ]
  );
  assert.deepEqual(
    [...stub.calls].sort((left, right) => left.pageRange[0] - right.pageRange[0]),
    [
      { forceOcr: null, pageRange: [2, 2], url: "http://docling.test:5010/v1/convert/file" },
      { forceOcr: "true", pageRange: [3, 3], url: "http://docling.test:5010/v1/convert/file" },
    ]
  );

  stub.calls.length = 0;

  const docling = await arms.docling(pdfPath);

  assert.deepEqual(docling.routing, null);
  assert.deepEqual(docling.pages.map((page) => page.text), ["Docling page 1", "Docling page 2", "Docling page 3"]);
  assert.deepEqual(stub.calls.map((call) => call.pageRange), [[]], "the Docling arm sends the whole document");

  const summary = summarizeAutoRouting([{ paperId: "1901.00001", routing: auto.routing }]);

  assert.deepEqual(summary, {
    documents: 1,
    pages: 3,
    pagesByRoute: { text: 1, layout: 1, ocr: 1 },
    doclingPages: 2,
    fallbackPages: { docling_empty: 0, docling_failed: 0 },
    doclingRequests: 2,
    failedRequests: 0,
    papers: [
      {
        paperId: "1901.00001",
        pageCount: 3,
        pagesByRoute: { text: 1, layout: 1, ocr: 1 },
        doclingPages: 2,
        fallbackPages: { docling_empty: 0, docling_failed: 0 },
        doclingRequests: 2,
        failedRequests: 0,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(summary), /Docling page|Region|Revenue|docling\.test/, "codes and counts only");
});

test("auto routing sums fallbacks and failed requests over papers, and the report shows it only for the auto arm", async () => {
  resetDoclingRequestLimiter();
  process.env.DOCLING_FALLBACK = "pdfjs";

  const originalWarn = console.warn;
  const failing = async () => ({ json: async () => ({ status: "failure" }), ok: false, status: 500 });

  console.warn = () => {};

  let failed;

  try {
    failed = await createArms(failing).auto(pdfPath);
  } finally {
    console.warn = originalWarn;
    delete process.env.DOCLING_FALLBACK;
  }

  const paragraphs = (await loadPdfDocument(pdfPath, { paragraphDetection: true })).pages;

  assert.deepEqual(failed.pages, paragraphs, "DOCLING_FALLBACK=pdfjs keeps the pdf.js text");

  const summary = summarizeAutoRouting([
    { paperId: "1901.00001", routing: failed.routing },
    {
      paperId: "1901.00002",
      routing: {
        pageCount: 2,
        routes: [
          { pageNumber: 1, route: "layout", reasons: ["table_rows"], parser: "docling" },
          { pageNumber: 2, route: "ocr", reasons: ["image_without_text"], parser: "pdfjs", fallback: "docling_empty" },
        ],
        batches: [
          { route: "layout", firstPage: 1, lastPage: 1, outcome: "ok", durationMs: 5 },
          { route: "ocr", firstPage: 2, lastPage: 2, outcome: "ok", durationMs: 7 },
        ],
      },
    },
  ]);

  assert.deepEqual(
    { ...summary, papers: undefined },
    {
      documents: 2,
      pages: 5,
      pagesByRoute: { text: 1, layout: 2, ocr: 2 },
      doclingPages: 1,
      fallbackPages: { docling_empty: 1, docling_failed: 2 },
      doclingRequests: 4,
      failedRequests: 2,
      papers: undefined,
    }
  );

  const metrics = (value) => ({ f1: value, inContext: value, inDocument: value });
  const group = {
    deltas: metrics({ cases: 0, ci95: null, delta: null }),
    rows: 0,
    summary: Object.fromEntries(["pdfjs-paragraphs", "auto", "pdfjs", "docling"].map((parser) => [parser, metrics(null)])),
  };
  const report = (parsers, extra = {}) => ({
    config: { chatModel: "m", embeddingModel: "e", failedPapers: [], papers: 2, parsers },
    control: group,
    generatedAt: "2026-10-18T00:00:00.000Z",
    parseSeconds: Object.fromEntries(parsers.map((parser) => [parser, 1])),
    table: group,
    ...extra,
  });
  const withAuto = formatMarkdown(report(["pdfjs-paragraphs", "auto"], { routing: { auto: summary } }));
  const withoutAuto = formatMarkdown(report(["pdfjs", "docling"]));

  assert.match(withAuto, /^# Layout parsing: pdf\.js \+ paragraphs vs auto \(pdf\.js \+ Docling pages\) on QASPER papers/);
  assert.match(
    withAuto,
    /\nAuto routing: 5 pages of 2 papers, text 1, layout 2, ocr 2; Docling pages 1 \(docling_empty 1, docling_failed 2\); docling-serve requests 4, 2 failed\.\n/
  );
  assert.doesNotMatch(withoutAuto, /Auto routing/);
});
