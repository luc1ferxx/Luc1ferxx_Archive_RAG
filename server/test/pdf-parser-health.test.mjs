import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { checkPdfParserHealth } from "../health.js";

// checks.pdfParser: pdf.js needs nothing; docling depends on docling-serve for
// every PDF, auto only for the pages it routes there and only with a route
// enabled. docling-serve is a fetch stub here, never a server.

const SETTINGS = [
  "DOCLING_FALLBACK",
  "DOCLING_MAX_CONCURRENCY",
  "DOCLING_PAGE_BATCH_SIZE",
  "DOCLING_SERVE_URL",
  "PDF_AUTO_GARBLED_RATIO",
  "PDF_AUTO_IMAGE_COVERAGE",
  "PDF_AUTO_MIN_TEXT_CHARS",
  "PDF_AUTO_ROUTES",
  "PDF_AUTO_TABLE_MIN_ROWS",
  "PDF_PARSER",
];
const saved = new Map(SETTINGS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of SETTINGS) {
    delete process.env[name];
  }

  process.env.DOCLING_SERVE_URL = "http://docling.test:5010";
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const probes = () => {
  const urls = [];

  return {
    down: async (url) => {
      urls.push(url);
      throw new Error("connect ECONNREFUSED");
    },
    unexpected: async (url) => {
      urls.push(url);
      throw new Error("docling-serve must not be probed");
    },
    up: async (url) => {
      urls.push(url);
      return { ok: true };
    },
    urls,
  };
};

test("pdf.js needs no probe", async () => {
  const probe = probes();

  assert.deepEqual(await checkPdfParserHealth({ fetchImpl: probe.unexpected }), {
    message: "PDFs are parsed in-process with pdf.js.",
    parser: "pdfjs",
    status: "ok",
  });
  assert.deepEqual(probe.urls, []);
});

test("docling reports docling-serve's reachability with the request settings", async () => {
  process.env.PDF_PARSER = "docling";
  process.env.DOCLING_PAGE_BATCH_SIZE = "16";

  const probe = probes();

  assert.deepEqual(await checkPdfParserHealth({ fetchImpl: probe.up }), {
    doclingMaxConcurrency: 2,
    doclingPageBatchSize: 16,
    message: "docling-serve is reachable.",
    parser: "docling",
    status: "ok",
    url: "http://docling.test:5010",
  });
  assert.deepEqual(probe.urls, ["http://docling.test:5010/health"]);

  const down = await checkPdfParserHealth({ fetchImpl: probe.down });

  assert.equal(down.status, "error");
  assert.equal(down.fallback, "pdfjs");
  assert.equal(
    down.message,
    "docling-serve at http://docling.test:5010 is unreachable (connect ECONNREFUSED); uploads fall back to pdf.js."
  );

  process.env.DOCLING_FALLBACK = "none";
  assert.match((await checkPdfParserHealth({ fetchImpl: probe.down })).message, /; uploads will fail\.$/);
});

test("auto reports its routes and probes docling-serve when a route is enabled", async () => {
  process.env.PDF_PARSER = "auto";
  process.env.DOCLING_MAX_CONCURRENCY = "4";

  const probe = probes();

  assert.deepEqual(await checkPdfParserHealth({ fetchImpl: probe.up }), {
    doclingMaxConcurrency: 4,
    doclingPageBatchSize: 0,
    message: "docling-serve is reachable.",
    parser: "auto",
    routes: ["layout", "ocr"],
    status: "ok",
    url: "http://docling.test:5010",
  });

  const down = await checkPdfParserHealth({ fetchImpl: probe.down });

  assert.equal(down.status, "error");
  assert.deepEqual(down.routes, ["layout", "ocr"]);
  assert.equal(down.fallback, "pdfjs");
  assert.equal(
    down.message,
    "docling-serve at http://docling.test:5010 is unreachable (connect ECONNREFUSED); pages routed to layout or ocr fall back to their pdf.js text."
  );

  process.env.DOCLING_FALLBACK = "none";
  process.env.PDF_AUTO_ROUTES = "ocr";

  const strict = await checkPdfParserHealth({ fetchImpl: probe.down });

  assert.deepEqual(strict.routes, ["ocr"]);
  assert.match(strict.message, /; pages routed to ocr make their uploads fail\.$/);
});

test("auto with PDF_AUTO_ROUTES=none is ok without a probe", async () => {
  process.env.PDF_PARSER = "auto";
  process.env.PDF_AUTO_ROUTES = "none";

  const probe = probes();

  assert.deepEqual(await checkPdfParserHealth({ fetchImpl: probe.unexpected }), {
    doclingMaxConcurrency: 2,
    doclingPageBatchSize: 0,
    message: "PDF_AUTO_ROUTES=none: every page keeps its pdf.js text; docling-serve is not used.",
    parser: "auto",
    routes: [],
    status: "ok",
  });
  assert.deepEqual(probe.urls, []);
});

test("an invalid auto setting or parser is an error entry that names the variable", async () => {
  const probe = probes();

  process.env.PDF_PARSER = "auto";

  for (const [name, value] of [
    ["PDF_AUTO_ROUTES", "tables"],
    ["PDF_AUTO_TABLE_MIN_ROWS", "0"],
    ["PDF_AUTO_MIN_TEXT_CHARS", "-5"],
    ["PDF_AUTO_IMAGE_COVERAGE", "2"],
    ["PDF_AUTO_GARBLED_RATIO", "none"],
  ]) {
    process.env[name] = value;

    const entry = await checkPdfParserHealth({ fetchImpl: probe.unexpected });

    assert.equal(entry.status, "error", name);
    assert.equal(entry.parser, "auto");
    assert.match(entry.message, new RegExp(`^${name} must be`), name);
    delete process.env[name];
  }

  process.env.PDF_PARSER = "pdfminer";

  const invalid = await checkPdfParserHealth({ fetchImpl: probe.unexpected });

  assert.equal(invalid.status, "error");
  assert.match(invalid.message, /PDF_PARSER must be one of pdfjs, docling, auto/);
  assert.deepEqual(probe.urls, []);
});
