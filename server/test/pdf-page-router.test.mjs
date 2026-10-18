import test from "node:test";
import assert from "node:assert/strict";

import {
  getDoclingMaxConcurrency,
  getDoclingPageBatchSize,
  getPdfAutoGarbledRatio,
  getPdfAutoImageCoverage,
  getPdfAutoMinTextChars,
  getPdfAutoRoutes,
  getPdfAutoTableMinRows,
  getPdfParser,
} from "../rag/config.js";
import {
  classifyPdfPage,
  GARBLED_MIN_CHARS,
  planDoclingBatches,
  resolvePdfAutoRoutingConfig,
} from "../rag/pdf-page-router.js";

// PDF_PARSER=auto's router is a pure function of a page's pdf.js signals and
// the PDF_AUTO_* thresholds; these pin every rule, their order, what a
// disabled route leaves in the reasons, and the batch plan.

const SETTINGS = [
  "DOCLING_MAX_CONCURRENCY",
  "DOCLING_PAGE_BATCH_SIZE",
  "PDF_AUTO_GARBLED_RATIO",
  "PDF_AUTO_IMAGE_COVERAGE",
  "PDF_AUTO_MIN_TEXT_CHARS",
  "PDF_AUTO_ROUTES",
  "PDF_AUTO_TABLE_MIN_ROWS",
  "PDF_PARSER",
];

const withEnv = (overrides, callback) => {
  const saved = new Map(SETTINGS.map((name) => [name, process.env[name]]));

  for (const name of SETTINGS) {
    delete process.env[name];
  }

  Object.assign(process.env, overrides);

  try {
    return callback();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

const THRESHOLDS = Object.freeze({
  garbledRatio: 0.3,
  imageCoverage: 0.3,
  minTextChars: 200,
  routes: ["layout", "ocr"],
  tableMinRows: 4,
});

const page = (overrides = {}) => ({
  charCount: 1500,
  garbledCharRatio: 0,
  imageCount: 0,
  imageCoverage: 0,
  itemCount: 40,
  lineCount: 40,
  tableCaption: false,
  tabularLineCount: 0,
  ...overrides,
});

const only = (routes) => ({ ...THRESHOLDS, routes });

test("a plain text page keeps its pdf.js text", () => {
  assert.deepEqual(classifyPdfPage(page(), THRESHOLDS), { reasons: ["plain_text"], route: "text" });
  assert.deepEqual(classifyPdfPage({}, THRESHOLDS), { reasons: ["plain_text"], route: "text" }, "missing signals count as 0");
  assert.deepEqual(classifyPdfPage(undefined, THRESHOLDS), { reasons: ["plain_text"], route: "text" });
});

test("rule a: a garbled text layer goes to OCR, from GARBLED_MIN_CHARS characters on", () => {
  assert.equal(GARBLED_MIN_CHARS, 20);
  assert.deepEqual(classifyPdfPage(page({ garbledCharRatio: 0.3 }), THRESHOLDS), {
    reasons: ["garbled_text"],
    route: "ocr",
  });
  assert.equal(classifyPdfPage(page({ garbledCharRatio: 0.29 }), THRESHOLDS).route, "text");
  assert.equal(classifyPdfPage(page({ charCount: 20, garbledCharRatio: 1 }), THRESHOLDS).route, "ocr");
  assert.equal(
    classifyPdfPage(page({ charCount: 19, garbledCharRatio: 1 }), THRESHOLDS).route,
    "text",
    "a lone symbol-font glyph or page number says nothing"
  );
});

test("rule b: little text on a page mostly covered by images goes to OCR", () => {
  assert.deepEqual(classifyPdfPage(page({ charCount: 0, imageCount: 1, imageCoverage: 0.95 }), THRESHOLDS), {
    reasons: ["image_without_text"],
    route: "ocr",
  });
  assert.equal(classifyPdfPage(page({ charCount: 199, imageCoverage: 0.3 }), THRESHOLDS).route, "ocr");
  assert.equal(classifyPdfPage(page({ charCount: 200, imageCoverage: 1 }), THRESHOLDS).route, "text", "enough text");
  assert.equal(classifyPdfPage(page({ charCount: 0, imageCoverage: 0.29 }), THRESHOLDS).route, "text", "too little image");
  assert.equal(
    classifyPdfPage(page({ charCount: 0, imageCoverage: 0 }), THRESHOLDS).route,
    "text",
    "an empty page is no scan"
  );
});

test("rule c: tabular lines, or a table caption with two of them, go to layout", () => {
  assert.deepEqual(classifyPdfPage(page({ tabularLineCount: 4 }), THRESHOLDS), {
    reasons: ["table_rows"],
    route: "layout",
  });
  assert.equal(classifyPdfPage(page({ tabularLineCount: 3 }), THRESHOLDS).route, "text");
  assert.deepEqual(classifyPdfPage(page({ tableCaption: true, tabularLineCount: 2 }), THRESHOLDS), {
    reasons: ["table_caption"],
    route: "layout",
  });
  assert.equal(classifyPdfPage(page({ tableCaption: true, tabularLineCount: 1 }), THRESHOLDS).route, "text");
  assert.equal(classifyPdfPage(page({ tableCaption: "yes", tabularLineCount: 2 }), THRESHOLDS).route, "text");
  assert.deepEqual(
    classifyPdfPage(page({ tableCaption: true, tabularLineCount: 9 }), THRESHOLDS).reasons,
    ["table_rows"],
    "rows are checked before the caption"
  );
});

test("the first matching rule wins: garbled, then image, then table", () => {
  const everything = page({ charCount: 100, garbledCharRatio: 0.9, imageCoverage: 0.9, tabularLineCount: 10 });

  assert.deepEqual(classifyPdfPage(everything, THRESHOLDS).reasons, ["garbled_text"]);
  assert.deepEqual(
    classifyPdfPage({ ...everything, garbledCharRatio: 0 }, THRESHOLDS).reasons,
    ["image_without_text"]
  );
  assert.deepEqual(
    classifyPdfPage({ ...everything, garbledCharRatio: 0, imageCoverage: 0 }, THRESHOLDS).reasons,
    ["table_rows"]
  );
});

test("a disabled route never matches; the page falls through and its reasons say what was disabled", () => {
  const garbledTable = page({ garbledCharRatio: 0.9, tabularLineCount: 10 });
  const scan = page({ charCount: 0, imageCoverage: 1 });
  const table = page({ tabularLineCount: 10 });

  assert.deepEqual(classifyPdfPage(garbledTable, only(["layout"])), { reasons: ["table_rows"], route: "layout" });
  assert.deepEqual(classifyPdfPage(scan, only(["layout"])), {
    reasons: ["plain_text", "ocr_route_disabled"],
    route: "text",
  });
  assert.deepEqual(classifyPdfPage(table, only(["ocr"])), {
    reasons: ["plain_text", "layout_route_disabled"],
    route: "text",
  });
  assert.deepEqual(classifyPdfPage(garbledTable, only([])), {
    reasons: ["plain_text", "ocr_route_disabled", "layout_route_disabled"],
    route: "text",
  });
  assert.deepEqual(classifyPdfPage(page(), only([])), { reasons: ["plain_text"], route: "text" });
});

test("thresholds come from PDF_AUTO_*; unset and empty mean the defaults", () => {
  withEnv({}, () => {
    assert.deepEqual(resolvePdfAutoRoutingConfig(), THRESHOLDS);
    assert.equal(getDoclingMaxConcurrency(), 2);
    assert.equal(getDoclingPageBatchSize(), 0);
  });

  for (const blank of ["", "  ", "\t"]) {
    withEnv(Object.fromEntries(SETTINGS.filter((name) => name.startsWith("PDF_AUTO") || name.startsWith("DOCLING")).map((name) => [name, blank])), () => {
      assert.deepEqual(resolvePdfAutoRoutingConfig(), THRESHOLDS);
      assert.equal(getDoclingMaxConcurrency(), 2);
      assert.equal(getDoclingPageBatchSize(), 0);
    });
  }

  withEnv(
    {
      DOCLING_MAX_CONCURRENCY: "6",
      DOCLING_PAGE_BATCH_SIZE: "8",
      PDF_AUTO_GARBLED_RATIO: "0.5",
      PDF_AUTO_IMAGE_COVERAGE: "1",
      PDF_AUTO_MIN_TEXT_CHARS: "0",
      PDF_AUTO_ROUTES: " OCR , layout ",
      PDF_AUTO_TABLE_MIN_ROWS: "6",
    },
    () => {
      assert.deepEqual(resolvePdfAutoRoutingConfig(), {
        garbledRatio: 0.5,
        imageCoverage: 1,
        minTextChars: 0,
        routes: ["layout", "ocr"],
        tableMinRows: 6,
      });
      assert.equal(getDoclingMaxConcurrency(), 6);
      assert.equal(getDoclingPageBatchSize(), 8);
      assert.equal(
        classifyPdfPage(page({ tabularLineCount: 5 })).route,
        "text",
        "the default thresholds are read from the environment"
      );
    }
  );

  withEnv({ PDF_AUTO_ROUTES: "layout" }, () => assert.deepEqual(getPdfAutoRoutes(), ["layout"]));
  withEnv({ PDF_AUTO_ROUTES: "ocr," }, () => assert.deepEqual(getPdfAutoRoutes(), ["ocr"]));
  withEnv({ PDF_AUTO_ROUTES: "None" }, () => assert.deepEqual(getPdfAutoRoutes(), []));
  // A concurrency below 1 means 1, never "no request at all".
  withEnv({ DOCLING_MAX_CONCURRENCY: "0.5" }, () => assert.equal(getDoclingMaxConcurrency(), 1));
  withEnv({ DOCLING_MAX_CONCURRENCY: "0" }, () => assert.equal(getDoclingMaxConcurrency(), 2));
  withEnv({ DOCLING_PAGE_BATCH_SIZE: "-3" }, () => assert.equal(getDoclingPageBatchSize(), 0));
});

test("an invalid route or threshold throws and names its variable", () => {
  const cases = [
    ["PDF_AUTO_ROUTES", "tables", getPdfAutoRoutes, /PDF_AUTO_ROUTES must be a comma list of layout, ocr, or none; got "tables"/],
    ["PDF_AUTO_ROUTES", "none,ocr", getPdfAutoRoutes, /PDF_AUTO_ROUTES/],
    ["PDF_AUTO_ROUTES", ",", getPdfAutoRoutes, /PDF_AUTO_ROUTES/],
    ["PDF_AUTO_TABLE_MIN_ROWS", "0", getPdfAutoTableMinRows, /PDF_AUTO_TABLE_MIN_ROWS must be a positive integer; got "0"/],
    ["PDF_AUTO_TABLE_MIN_ROWS", "2.5", getPdfAutoTableMinRows, /PDF_AUTO_TABLE_MIN_ROWS/],
    ["PDF_AUTO_MIN_TEXT_CHARS", "-1", getPdfAutoMinTextChars, /PDF_AUTO_MIN_TEXT_CHARS must be a non-negative integer/],
    ["PDF_AUTO_MIN_TEXT_CHARS", "many", getPdfAutoMinTextChars, /PDF_AUTO_MIN_TEXT_CHARS/],
    ["PDF_AUTO_IMAGE_COVERAGE", "0", getPdfAutoImageCoverage, /PDF_AUTO_IMAGE_COVERAGE must be a number in \(0, 1\]/],
    ["PDF_AUTO_IMAGE_COVERAGE", "1.5", getPdfAutoImageCoverage, /PDF_AUTO_IMAGE_COVERAGE/],
    ["PDF_AUTO_GARBLED_RATIO", "30%", getPdfAutoGarbledRatio, /PDF_AUTO_GARBLED_RATIO must be a number in \(0, 1\]/],
  ];

  for (const [name, value, read, pattern] of cases) {
    withEnv({ [name]: value }, () => {
      assert.throws(read, pattern, `${name}=${value}`);
      assert.throws(resolvePdfAutoRoutingConfig, pattern, `${name}=${value} through the resolver`);
    });
  }
});

test("PDF_PARSER accepts auto and lists it among the parsers", () => {
  withEnv({ PDF_PARSER: " Auto " }, () => assert.equal(getPdfParser(), "auto"));
  withEnv({ PDF_PARSER: "pdfminer" }, () =>
    assert.throws(getPdfParser, /PDF_PARSER must be one of pdfjs, docling, auto; got "pdfminer"/)
  );
});

const routesOf = (spec) => [...spec].map((code, index) => ({
  pageNumber: index + 1,
  route: { L: "layout", O: "ocr", T: "text" }[code],
}));

test("batches are contiguous runs of one Docling route; text pages make none", () => {
  assert.deepEqual(planDoclingBatches(routesOf("TLLTOOLT")), [
    { firstPage: 2, lastPage: 3, route: "layout" },
    { firstPage: 5, lastPage: 6, route: "ocr" },
    { firstPage: 7, lastPage: 7, route: "layout" },
  ]);
  assert.deepEqual(planDoclingBatches(routesOf("TTT")), []);
  assert.deepEqual(planDoclingBatches([]), []);
  assert.deepEqual(planDoclingBatches(), []);
  assert.deepEqual(planDoclingBatches(routesOf("LO")), [
    { firstPage: 1, lastPage: 1, route: "layout" },
    { firstPage: 2, lastPage: 2, route: "ocr" },
  ]);
  // Page order is what makes a run, not array order; a gap ends a run.
  assert.deepEqual(
    planDoclingBatches([
      { pageNumber: 3, route: "layout" },
      { pageNumber: 1, route: "layout" },
      { pageNumber: 2, route: "layout" },
      { pageNumber: 5, route: "layout" },
    ]),
    [
      { firstPage: 1, lastPage: 3, route: "layout" },
      { firstPage: 5, lastPage: 5, route: "layout" },
    ]
  );
});

test("a run is split at maxPagesPerRequest; 0 leaves it whole", () => {
  assert.deepEqual(planDoclingBatches(routesOf("LLLLLTOOO"), { maxPagesPerRequest: 2 }), [
    { firstPage: 1, lastPage: 2, route: "layout" },
    { firstPage: 3, lastPage: 4, route: "layout" },
    { firstPage: 5, lastPage: 5, route: "layout" },
    { firstPage: 7, lastPage: 8, route: "ocr" },
    { firstPage: 9, lastPage: 9, route: "ocr" },
  ]);
  assert.deepEqual(planDoclingBatches(routesOf("LLLLL"), { maxPagesPerRequest: 0 }), [
    { firstPage: 1, lastPage: 5, route: "layout" },
  ]);
  assert.deepEqual(planDoclingBatches(routesOf("LLL"), { maxPagesPerRequest: 1 }), [
    { firstPage: 1, lastPage: 1, route: "layout" },
    { firstPage: 2, lastPage: 2, route: "layout" },
    { firstPage: 3, lastPage: 3, route: "layout" },
  ]);
  assert.deepEqual(planDoclingBatches(routesOf("LLL"), { maxPagesPerRequest: 10 }), [
    { firstPage: 1, lastPage: 3, route: "layout" },
  ]);
});

test("mergeGapPages joins same-route runs separated only by that many text pages; requests start and end on routed pages", () => {
  assert.deepEqual(planDoclingBatches(routesOf("LTLTTLTTTL"), { mergeGapPages: 2 }), [
    { firstPage: 1, lastPage: 6, route: "layout" },
    { firstPage: 10, lastPage: 10, route: "layout" },
  ]);
  assert.deepEqual(planDoclingBatches(routesOf("LTLTTLTTTL"), { mergeGapPages: 3 }), [
    { firstPage: 1, lastPage: 10, route: "layout" },
  ]);
  // A page on the other Docling route ends the run, whatever the gap.
  assert.deepEqual(planDoclingBatches(routesOf("LOL"), { mergeGapPages: 5 }), [
    { firstPage: 1, lastPage: 1, route: "layout" },
    { firstPage: 2, lastPage: 2, route: "ocr" },
    { firstPage: 3, lastPage: 3, route: "layout" },
  ]);
  assert.deepEqual(planDoclingBatches(routesOf("OTO"), { mergeGapPages: 1 }), [
    { firstPage: 1, lastPage: 3, route: "ocr" },
  ]);
  // The page limit counts the gap pages too, and a split never leaves a
  // request that starts or ends on a gap page.
  assert.deepEqual(planDoclingBatches(routesOf("LTTLLTL"), { maxPagesPerRequest: 3, mergeGapPages: 2 }), [
    { firstPage: 1, lastPage: 1, route: "layout" },
    { firstPage: 4, lastPage: 5, route: "layout" },
    { firstPage: 7, lastPage: 7, route: "layout" },
  ]);
  // A page missing from the routes is no gap to merge over.
  assert.deepEqual(
    planDoclingBatches(
      [
        { pageNumber: 1, route: "layout" },
        { pageNumber: 3, route: "layout" },
      ],
      { mergeGapPages: 2 }
    ),
    [
      { firstPage: 1, lastPage: 1, route: "layout" },
      { firstPage: 3, lastPage: 3, route: "layout" },
    ]
  );
  // 0, negative or non-integer values merge nothing.
  for (const mergeGapPages of [0, -1, 1.5, undefined]) {
    assert.deepEqual(planDoclingBatches(routesOf("LTL"), { mergeGapPages }), [
      { firstPage: 1, lastPage: 1, route: "layout" },
      { firstPage: 3, lastPage: 3, route: "layout" },
    ]);
  }
});
