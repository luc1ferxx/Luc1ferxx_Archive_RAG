#!/usr/bin/env node
// What PDF_PARSER=auto would do with a PDF, without docling-serve.
//
//   npm run pdf:route -- <file.pdf|directory> [...] [--json] [--thresholds-from-env]
//
// Each PDF is parsed once with pdf.js (parsePdfBytesWithPdfjs with
// collectSignals, in this thread or on the PDF_PARSE_WORKERS pool) and every
// page is classified by the same router ingestion uses (rag/pdf-page-router.js):
// text keeps the pdf.js text, layout and ocr would go to docling-serve. The
// report gives per document the page count and the pages per route, and per
// page the route, the reasons and the pdf.js signals. It never prints page
// text and never calls docling-serve.
//
// A directory means the *.pdf files directly inside it, by name. The files
// are read as they are on disk (the operator's own files, not working files).
//
// Routing thresholds: the shipped defaults, so a report says what the default
// configuration does whatever the environment holds; --thresholds-from-env
// applies the PDF_AUTO_* settings of the environment instead (server/.env, or
// DOTENV_CONFIG_PATH, included), which is what the server would use.
//
// Exit codes: 0 every file routed; 1 a file could not be read or parsed (the
// others are still reported); 2 bad arguments or an invalid PDF_AUTO_* value.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stopPdfParsePool } from "./rag/pdf-parse-pool.js";
import { classifyPdfPage, PDF_PAGE_ROUTES, resolvePdfAutoRoutingConfig } from "./rag/pdf-page-router.js";
import { parsePdfBytesWithPdfjs } from "./rag/pdfjs-document.js";

export const USAGE = `Usage: node pdf-route.mjs <file.pdf|directory> [...] [options]

Parses each PDF with pdf.js and prints the route PDF_PARSER=auto would give
every page (text, layout, ocr), the reasons and the pdf.js signals. Page text is
never printed and docling-serve is never called. A directory means the *.pdf
files directly inside it.

Options
  --json                  Print one JSON object instead of tables.
  --thresholds-from-env   Route with the PDF_AUTO_* settings of the environment
                          (default: the built-in defaults).
  -h, --help              Show this help.

Exit codes: 0 ok, 1 a file could not be parsed, 2 bad arguments or settings.
`;

const PDF_AUTO_SETTINGS = Object.freeze([
  "PDF_AUTO_GARBLED_RATIO",
  "PDF_AUTO_IMAGE_COVERAGE",
  "PDF_AUTO_MIN_TEXT_CHARS",
  "PDF_AUTO_ROUTES",
  "PDF_AUTO_TABLE_MIN_ROWS",
]);

// The signals in the order the tables print them.
const SIGNAL_FIELDS = Object.freeze([
  "charCount",
  "itemCount",
  "lineCount",
  "tabularLineCount",
  "tableCaption",
  "imageCount",
  "imageCoverage",
  "garbledCharRatio",
]);

const DOCLING_ROUTES = new Set(["layout", "ocr"]);

class UsageError extends Error {}

export const parsePdfRouteArguments = (argv) => {
  const options = { help: false, json: false, paths: [], thresholdsFromEnv: false };

  for (const argument of argv) {
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--thresholds-from-env") {
      options.thresholdsFromEnv = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument}.`);
    } else {
      options.paths.push(argument);
    }
  }

  if (!options.help && options.paths.length === 0) {
    throw new UsageError("Name a PDF file or a directory of PDF files.");
  }

  return options;
};

// The router's built-in thresholds: resolvePdfAutoRoutingConfig with every
// PDF_AUTO_* setting unset for the call.
const resolveDefaultRoutingConfig = () => {
  const saved = PDF_AUTO_SETTINGS.map((name) => [name, process.env[name]]);

  for (const name of PDF_AUTO_SETTINGS) {
    delete process.env[name];
  }

  try {
    return resolvePdfAutoRoutingConfig();
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
  }
};

export const resolveRoutingThresholds = ({ thresholdsFromEnv }) => {
  try {
    const thresholds = thresholdsFromEnv ? resolvePdfAutoRoutingConfig() : resolveDefaultRoutingConfig();

    return {
      source: thresholdsFromEnv ? "environment" : "defaults",
      tableMinRows: thresholds.tableMinRows,
      minTextChars: thresholds.minTextChars,
      imageCoverage: thresholds.imageCoverage,
      garbledRatio: thresholds.garbledRatio,
      routes: [...thresholds.routes],
    };
  } catch (error) {
    throw new UsageError(error.message);
  }
};

const isPdfFileName = (name) => path.extname(name).toLowerCase() === ".pdf";

// The files to route, in argument order; a directory's PDFs by name.
const listPdfFiles = async (paths) => {
  const files = [];

  for (const entry of paths) {
    const info = await stat(entry).catch(() => null);

    if (!info) {
      throw new UsageError(`${entry} does not exist.`);
    }

    if (info.isFile()) {
      files.push(entry);
      continue;
    }

    if (!info.isDirectory()) {
      throw new UsageError(`${entry} is neither a file nor a directory.`);
    }

    const names = (await readdir(entry)).filter(isPdfFileName).sort();
    const inside = [];

    for (const name of names) {
      const filePath = path.join(entry, name);

      if ((await stat(filePath).catch(() => null))?.isFile()) {
        inside.push(filePath);
      }
    }

    if (inside.length === 0) {
      throw new UsageError(`${entry} holds no PDF files.`);
    }

    files.push(...inside);
  }

  return files;
};

const countRoutes = (pages) => {
  const counts = Object.fromEntries(PDF_PAGE_ROUTES.map((route) => [route, 0]));

  for (const { route } of pages) {
    counts[route] += 1;
  }

  return counts;
};

const pickSignals = (signals = {}) => Object.fromEntries(SIGNAL_FIELDS.map((field) => [field, signals[field] ?? null]));

/** One document's routing: page count, pages per route, and per page route, reasons and signals (never text). */
export const routePdfBytes = async (bytes, thresholds) => {
  const parsed = await parsePdfBytesWithPdfjs(bytes, { collectSignals: true });
  const signalsByPage = new Map((parsed.signals ?? []).map((entry) => [entry.pageNumber, entry]));
  const pages = parsed.pages.map(({ pageNumber }) => {
    const signals = signalsByPage.get(pageNumber);
    const { reasons, route } = classifyPdfPage(signals, thresholds);

    return { pageNumber, route, reasons, signals: pickSignals(signals) };
  });
  const pagesByRoute = countRoutes(pages);

  return {
    pageCount: parsed.pageCount,
    pagesByRoute,
    doclingPages: pages.filter((page) => DOCLING_ROUTES.has(page.route)).length,
    pages,
  };
};

const describeError = (error) => ({
  name: error?.name ?? "Error",
  ...(error?.code !== undefined ? { code: error.code } : {}),
  message: error instanceof Error ? error.message : String(error),
});

const formatRatio = (value) => (Number.isFinite(value) ? value.toFixed(3) : "-");

const formatCounts = (counts) => PDF_PAGE_ROUTES.map((route) => `${route} ${counts[route]}`).join(", ");

const TABLE_COLUMNS = Object.freeze([
  ["page", 4, (page) => page.pageNumber],
  ["route", 6, (page) => page.route],
  ["chars", 6, (page) => page.signals.charCount],
  ["items", 5, (page) => page.signals.itemCount],
  ["lines", 5, (page) => page.signals.lineCount],
  ["tabular", 7, (page) => page.signals.tabularLineCount],
  ["caption", 7, (page) => (page.signals.tableCaption ? "yes" : "no")],
  ["images", 6, (page) => page.signals.imageCount],
  ["coverage", 8, (page) => formatRatio(page.signals.imageCoverage)],
  ["garbled", 7, (page) => formatRatio(page.signals.garbledCharRatio)],
]);

const formatRow = (cells) =>
  cells.map((cell, index) => {
    const [, width] = TABLE_COLUMNS[index];
    const text = String(cell ?? "-");

    return index === 1 || index === 6 ? text.padEnd(width) : text.padStart(width);
  });

const formatDocument = (document) => {
  const header = [...formatRow(TABLE_COLUMNS.map(([name]) => name)), "reasons"].join("  ");
  const rows = document.pages.map((page) =>
    [...formatRow(TABLE_COLUMNS.map(([, , read]) => read(page))), page.reasons.join(",")].join("  ")
  );

  return [
    `${document.file}: ${document.pageCount} page${document.pageCount === 1 ? "" : "s"} (${formatCounts(document.pagesByRoute)}; Docling pages ${document.doclingPages})`,
    `  ${header}`,
    ...rows.map((row) => `  ${row}`),
    "",
  ].join("\n");
};

const formatThresholds = (thresholds) =>
  `Routing thresholds (${thresholds.source}): tableMinRows ${thresholds.tableMinRows}, minTextChars ${thresholds.minTextChars}, ` +
  `imageCoverage ${thresholds.imageCoverage}, garbledRatio ${thresholds.garbledRatio}, routes ${thresholds.routes.join(",") || "none"}\n\n`;

/**
 * Runs the command over `argv` and resolves with its exit code. Output goes
 * through `write` (stdout) and `writeError` (stderr).
 */
export const runPdfRouteCommand = async (
  argv,
  { write = (text) => process.stdout.write(text), writeError = (text) => process.stderr.write(text) } = {}
) => {
  let options;
  let thresholds;
  let files;

  try {
    options = parsePdfRouteArguments(argv);

    if (options.help) {
      write(USAGE);
      return 0;
    }

    thresholds = resolveRoutingThresholds(options);
    files = await listPdfFiles(options.paths);
  } catch (error) {
    if (error instanceof UsageError) {
      writeError(`${error.message}\n\n${USAGE}`);
      return 2;
    }

    throw error;
  }

  const documents = [];
  const failures = [];

  if (!options.json) {
    write(formatThresholds(thresholds));
  }

  for (const file of files) {
    try {
      const document = { file, ...(await routePdfBytes(await readFile(file), thresholds)) };

      documents.push(document);

      if (!options.json) {
        write(formatDocument(document));
      }
    } catch (error) {
      const failure = { file, error: describeError(error) };

      failures.push(failure);

      if (!options.json) {
        writeError(`Could not parse ${file}: ${failure.error.name}: ${failure.error.message}\n`);
      }
    }
  }

  const totalPagesByRoute = Object.fromEntries(
    PDF_PAGE_ROUTES.map((route) => [route, documents.reduce((sum, document) => sum + document.pagesByRoute[route], 0)])
  );
  const totals = {
    documents: documents.length,
    failed: failures.length,
    pages: documents.reduce((sum, document) => sum + document.pages.length, 0),
    pagesByRoute: totalPagesByRoute,
    doclingPages: documents.reduce((sum, document) => sum + document.doclingPages, 0),
  };

  if (options.json) {
    write(`${JSON.stringify({ reportType: "pdf-route", thresholds, documents, failures, totals }, null, 2)}\n`);
  } else {
    write(
      `${totals.documents} document${totals.documents === 1 ? "" : "s"}, ${totals.pages} page${totals.pages === 1 ? "" : "s"} ` +
        `(${formatCounts(totals.pagesByRoute)}; Docling pages ${totals.doclingPages})` +
        `${totals.failed > 0 ? `; ${totals.failed} could not be parsed` : ""}\n`
    );
  }

  return failures.length > 0 ? 1 : 0;
};

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // The environment file is read only when this runs as a command (and
  // DOTENV_CONFIG_PATH picks another one), so a test that imports the module
  // never picks one up.
  await import("dotenv/config");

  runPdfRouteCommand(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    // PDF_PARSE_WORKERS > 0 parsed on the worker pool; its idle workers do
    // not hold the process, but stop them so nothing outlives the command.
    .finally(() => stopPdfParsePool());
}
