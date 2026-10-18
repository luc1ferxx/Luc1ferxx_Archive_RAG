// npm run pdf:route (server/pdf-route.mjs) as an operator runs it: a child
// process over generated PDFs (test/pdf-fixture-builder.mjs), its tables and
// --json output, the routing thresholds it applies, its exit codes, and that
// no page text ever reaches its output.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { buildPdf, GREY_IMAGE, textLines } from "./pdf-fixture-builder.mjs";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(serverDirectory, "pdf-route.mjs");

// Words that occur only in the pages' text: none of them may be printed.
const PAGE_WORDS = Object.freeze(["Quokka", "Marmalade", "Tuesday", "Zephyr", "Saffron", "Juniper", "Lantern"]);

// Page 1 prose (text), page 2 a five-row table (layout), page 3 a full-page
// image without text (ocr), page 4 prose again (text).
const buildRoutedPdf = () =>
  buildPdf({
    pages: [
      textLines([
        "Quokka orchard ledger",
        "Marmalade shipments arrive every Tuesday at the north",
        "gate and are counted twice by the night shift.",
      ]),
      textLines([
        [[72, "Zephyr"], [250, "417"], [400, "88"]],
        [[72, "Saffron"], [250, "512"], [400, "19"]],
        [[72, "Juniper"], [250, "73"], [400, "41"]],
        [[72, "Lantern"], [250, "260"], [400, "7"]],
        [[72, "Quokka"], [250, "905"], [400, "63"]],
      ]),
      "q 612 0 0 792 0 0 cm /Im1 Do Q",
      textLines(["The Juniper ledger closes on the last page."]),
    ],
    xobjects: { Im1: GREY_IMAGE },
  });

const EXPECTED_PAGES = Object.freeze([
  { pageNumber: 1, route: "text", reasons: ["plain_text"] },
  { pageNumber: 2, route: "layout", reasons: ["table_rows"] },
  { pageNumber: 3, route: "ocr", reasons: ["image_without_text"] },
  { pageNumber: 4, route: "text", reasons: ["plain_text"] },
]);

const SIGNAL_FIELDS = [
  "charCount",
  "itemCount",
  "lineCount",
  "tabularLineCount",
  "tableCaption",
  "imageCount",
  "imageCoverage",
  "garbledCharRatio",
];

let root;
let emptyEnvFile;
let pdfDirectory;
let routedPdf;
let forbiddenFetchPreload;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pdf-route-cli-"));
  emptyEnvFile = path.join(root, "empty.env");
  pdfDirectory = path.join(root, "archive");
  routedPdf = path.join(pdfDirectory, "a-routed.pdf");
  forbiddenFetchPreload = path.join(root, "fetch-forbidden.mjs");

  await writeFile(emptyEnvFile, "");
  await mkdir(path.join(pdfDirectory, "nested"), { recursive: true });
  await writeFile(routedPdf, buildRoutedPdf());
  await writeFile(path.join(pdfDirectory, "b-broken.pdf"), "this is not a PDF");
  await writeFile(path.join(pdfDirectory, "c-notes.txt"), "not a PDF either");
  await writeFile(path.join(pdfDirectory, "nested", "deeper.pdf"), buildRoutedPdf());
  // Any network call fails loudly: the command must never reach docling-serve.
  await writeFile(
    forbiddenFetchPreload,
    'globalThis.fetch = async () => { process.stderr.write("FETCH_CALLED\\n"); throw new Error("fetch is forbidden"); };\n'
  );
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

// The child's environment: no PDF_*/DOCLING_* setting of this process, and
// an empty environment file instead of server/.env.
const childEnvironment = (overrides = {}) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(PDF_|DOCLING_)/.test(name))
  );

  return { ...env, DOTENV_CONFIG_PATH: emptyEnvFile, ...overrides };
};

const runCli = (args, { env = {}, nodeOptions = [] } = {}) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [...nodeOptions, cliPath, ...args],
      { cwd: serverDirectory, env: childEnvironment(env), maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        assert.notEqual(error?.killed, true, "the command exits on its own");
        resolve({ code: error ? error.code : 0, stderr, stdout });
      }
    );
  });

const assertNoPageText = (...outputs) => {
  for (const output of outputs) {
    for (const word of PAGE_WORDS) {
      assert.equal(output.includes(word), false, `"${word}" from a page's text is printed`);
    }
  }
};

const routesOf = (document) => document.pages.map(({ pageNumber, reasons, route }) => ({ pageNumber, route, reasons }));

test("--json: one object with the thresholds, per page route, reasons and signals, and never page text", async () => {
  const { code, stderr, stdout } = await runCli([routedPdf, "--json"], {
    nodeOptions: ["--import", forbiddenFetchPreload],
  });

  assert.equal(code, 0, stderr);
  assert.equal(stderr.includes("FETCH_CALLED"), false, "docling-serve is never called");

  const report = JSON.parse(stdout);

  assert.deepEqual(Object.keys(report), ["reportType", "thresholds", "documents", "failures", "totals"]);
  assert.equal(report.reportType, "pdf-route");
  assert.deepEqual(report.thresholds, {
    source: "defaults",
    tableMinRows: 4,
    minTextChars: 200,
    imageCoverage: 0.3,
    garbledRatio: 0.3,
    routes: ["layout", "ocr"],
  });
  assert.equal(report.documents.length, 1);

  const [document] = report.documents;

  assert.deepEqual(Object.keys(document), ["file", "pageCount", "pagesByRoute", "doclingPages", "pages"]);
  assert.equal(document.file, routedPdf);
  assert.equal(document.pageCount, 4);
  assert.deepEqual(document.pagesByRoute, { text: 2, layout: 1, ocr: 1 });
  assert.equal(document.doclingPages, 2);
  assert.deepEqual(routesOf(document), EXPECTED_PAGES);

  for (const page of document.pages) {
    assert.deepEqual(Object.keys(page), ["pageNumber", "route", "reasons", "signals"]);
    assert.deepEqual(Object.keys(page.signals), SIGNAL_FIELDS);
  }

  assert.equal(document.pages[1].signals.tabularLineCount, 5);
  assert.equal(document.pages[2].signals.charCount, 0);
  assert.equal(document.pages[2].signals.imageCount, 1);
  assert.equal(document.pages[2].signals.imageCoverage, 1);
  assert.ok(document.pages[0].signals.charCount > 50);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.totals, {
    documents: 1,
    failed: 0,
    pages: 4,
    pagesByRoute: { text: 2, layout: 1, ocr: 1 },
    doclingPages: 2,
  });
  assertNoPageText(stdout, stderr);
});

test("a directory: its PDFs by name, the tables, a file that cannot be parsed reported after the others, exit 1", async () => {
  const { code, stderr, stdout } = await runCli([pdfDirectory]);

  assert.equal(code, 1);
  assert.match(stdout, /^Routing thresholds \(defaults\): tableMinRows 4, minTextChars 200, imageCoverage 0\.3, garbledRatio 0\.3, routes layout,ocr\n/);
  assert.ok(
    stdout.includes(`${routedPdf}: 4 pages (text 2, layout 1, ocr 1; Docling pages 2)`),
    "the document line gives its pages per route"
  );

  const rows = stdout
    .split("\n")
    .filter((line) => /^\s+\d+\s+(text|layout|ocr)\s/.test(line))
    .map((line) => line.trim().split(/\s+/));

  assert.deepEqual(
    rows.map((cells) => [Number(cells[0]), cells[1], cells.at(-1)]),
    [
      [1, "text", "plain_text"],
      [2, "layout", "table_rows"],
      [3, "ocr", "image_without_text"],
      [4, "text", "plain_text"],
    ]
  );
  // Columns: page, route, chars, items, lines, tabular, caption, images,
  // coverage, garbled, reasons.
  assert.deepEqual(rows[1].slice(4, 10), ["5", "5", "no", "0", "0.000", "0.000"]);
  assert.deepEqual(rows[2].slice(2, 10), ["0", "0", "0", "0", "no", "1", "1.000", "0.000"]);
  assert.match(stdout, /\n1 document, 4 pages \(text 2, layout 1, ocr 1; Docling pages 2\); 1 could not be parsed\n$/);
  assert.match(stderr, /^Could not parse .*b-broken\.pdf: InvalidPDFException: /m);
  assert.equal(stdout.includes("c-notes.txt") || stderr.includes("c-notes.txt"), false, "only *.pdf files are read");
  assert.equal(stdout.includes("deeper.pdf"), false, "subdirectories are not walked");
  assertNoPageText(stdout, stderr);
});

test("--json with a file that cannot be parsed lists it under failures and exits 1", async () => {
  const brokenPdf = path.join(pdfDirectory, "b-broken.pdf");
  const { code, stderr, stdout } = await runCli([brokenPdf, routedPdf, "--json"]);
  const report = JSON.parse(stdout);

  assert.equal(code, 1);
  assert.equal(stderr, "");
  assert.deepEqual(report.documents.map((document) => document.file), [routedPdf]);
  assert.deepEqual(report.failures.map(({ error, file }) => [file, error.name]), [[brokenPdf, "InvalidPDFException"]]);
  assert.equal(report.totals.failed, 1);
});

test("routing thresholds are the defaults unless --thresholds-from-env, which reads them as the server does", async () => {
  const env = { PDF_AUTO_ROUTES: "layout" };
  const defaults = JSON.parse((await runCli([routedPdf, "--json"], { env })).stdout);
  const fromEnv = await runCli([routedPdf, "--json", "--thresholds-from-env"], { env });
  const routed = JSON.parse(fromEnv.stdout);

  assert.equal(defaults.thresholds.source, "defaults");
  assert.deepEqual(routesOf(defaults.documents[0]), EXPECTED_PAGES, "PDF_AUTO_* are ignored without the flag");
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.equal(routed.thresholds.source, "environment");
  assert.deepEqual(routed.thresholds.routes, ["layout"]);
  assert.deepEqual(routed.documents[0].pages[2].route, "text");
  assert.deepEqual(routed.documents[0].pages[2].reasons, ["plain_text", "ocr_route_disabled"]);
  assert.deepEqual(routed.documents[0].pagesByRoute, { text: 3, layout: 1, ocr: 0 });

  // The environment file the command loads is DOTENV_CONFIG_PATH's.
  const envFile = path.join(root, "routing.env");

  await writeFile(envFile, "PDF_AUTO_TABLE_MIN_ROWS=6\n");

  const fromFile = JSON.parse(
    (await runCli([routedPdf, "--json", "--thresholds-from-env"], { env: { DOTENV_CONFIG_PATH: envFile } })).stdout
  );

  assert.equal(fromFile.thresholds.tableMinRows, 6);
  assert.equal(fromFile.documents[0].pages[1].route, "text", "five tabular lines are under the file's bar");

  const invalid = await runCli([routedPdf, "--thresholds-from-env"], { env: { PDF_AUTO_TABLE_MIN_ROWS: "many" } });

  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /PDF_AUTO_TABLE_MIN_ROWS must be a positive integer/);

  // An empty value is unset: the default applies.
  const empty = JSON.parse(
    (await runCli([routedPdf, "--json", "--thresholds-from-env"], { env: { PDF_AUTO_TABLE_MIN_ROWS: "" } })).stdout
  );

  assert.equal(empty.thresholds.tableMinRows, 4);
});

test("PDF_PARSE_WORKERS: the same report from the worker pool, and the command still exits", async () => {
  const inProcess = await runCli([routedPdf, "--json"]);
  const pooled = await runCli([routedPdf, "--json"], { env: { PDF_PARSE_PAGES_PER_TASK: "1", PDF_PARSE_WORKERS: "2" } });

  assert.equal(pooled.code, 0, pooled.stderr);
  assert.deepEqual(JSON.parse(pooled.stdout), JSON.parse(inProcess.stdout));
});

test("bad arguments exit 2 with the usage and print no report", async () => {
  const cases = [
    [[], /Name a PDF file or a directory/],
    [["--bogus", routedPdf], /Unknown option --bogus/],
    [[path.join(root, "missing.pdf")], /missing\.pdf does not exist/],
    [[path.join(pdfDirectory, "nested", "..", "..")], /holds no PDF files/],
  ];

  for (const [args, message] of cases) {
    const { code, stderr, stdout } = await runCli(args);

    assert.equal(code, 2, `${args.join(" ")}: ${stderr}`);
    assert.equal(stdout, "");
    assert.match(stderr, message);
    assert.match(stderr, /Usage: node pdf-route\.mjs/);
  }

  const help = await runCli(["--help"]);

  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: node pdf-route\.mjs/);
});
