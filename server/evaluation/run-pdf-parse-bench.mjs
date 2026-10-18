#!/usr/bin/env node
// The pdf.js side of PDF_PARSER=auto and PDF_PARSE_WORKERS on local PDFs
// (docs/evaluation.md "按页分流和并行解析"). No docling-serve, no model:
//
//   npm run bench:pdf-parse -- --pdf-dir <dir> [--pdf-dir <dir>] [--workers 2,4,8] [--repeat 3]
//
// 1. parity: every document parsed on the worker pool (several pool sizes and
//    page-range sizes, paragraph detection on and off, signals collected) must
//    deepStrictEqual the in-process parse; a difference fails the run (exit 1);
// 2. wall time over the whole set, one document after another and all at
//    once, text only and with signals, with the main thread's longest
//    event-loop stall (monitorEventLoopDelay) of each run;
// 3. routing: the pages per route and reason under the shipped thresholds.
//
// Documents are deduplicated by content hash. The runner never reads
// server/.env; the report holds file names, counts and timings, never page
// text. It writes ignored evaluation/results/<latest-name>.{json,md}.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stopPdfParsePool } from "../rag/pdf-parse-pool.js";
import { classifyPdfPage, PDF_PAGE_ROUTES, resolvePdfAutoRoutingConfig } from "../rag/pdf-page-router.js";
import { parsePdfBytesWithPdfjs } from "../rag/pdfjs-document.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// [workers, pages per task]: one whole-document task, small ranges on two and
// four workers (every document is split), and whole documents on four.
export const PARITY_CONFIGURATIONS = Object.freeze([
  [1, 32],
  [2, 3],
  [4, 2],
  [4, 32],
]);

export const parsePdfParseBenchArguments = (argv) => {
  const options = {
    latestName: "latest-pdf-parse-bench",
    outputDir: path.join(SERVER_DIR, "evaluation/results"),
    pdfDirs: [],
    repeat: 3,
    workers: [2, 4, 8],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === "--pdf-dir" && value) {
      options.pdfDirs.push(path.resolve(value));
    } else if (flag === "--workers" && value) {
      options.workers = value.split(",").map((entry) => Number(entry.trim()));
    } else if (flag === "--repeat" && value) {
      options.repeat = Number(value);
    } else if (flag === "--output-dir" && value) {
      options.outputDir = path.resolve(value);
    } else if (flag === "--latest-name" && value) {
      options.latestName = value;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }

    index += 1;
  }

  if (options.pdfDirs.length === 0) {
    throw new Error("Pass at least one --pdf-dir <directory of PDFs>.");
  }

  if (!options.workers.every((workers) => Number.isInteger(workers) && workers > 0)) {
    throw new Error("--workers takes a comma list of positive integers.");
  }

  if (!Number.isInteger(options.repeat) || options.repeat < 1) {
    throw new Error("--repeat takes a positive integer.");
  }

  return options;
};

export const loadBenchDocuments = async (pdfDirs) => {
  const documents = [];
  const seen = new Set();

  for (const directory of pdfDirs) {
    const names = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();

    for (const name of names) {
      const bytes = await readFile(path.join(directory, name));
      const digest = createHash("sha256").update(bytes).digest("hex");

      if (!seen.has(digest)) {
        seen.add(digest);
        documents.push({ bytes, name: `${path.basename(directory)}/${name}` });
      }
    }
  }

  return documents;
};

// PDF_PARSE_PAGES_PER_TASK is read when a document is parsed.
const withPagesPerTask = async (pagesPerTask, run) => {
  const saved = process.env.PDF_PARSE_PAGES_PER_TASK;

  process.env.PDF_PARSE_PAGES_PER_TASK = String(pagesPerTask);

  try {
    return await run();
  } finally {
    if (saved === undefined) {
      delete process.env.PDF_PARSE_PAGES_PER_TASK;
    } else {
      process.env.PDF_PARSE_PAGES_PER_TASK = saved;
    }
  }
};

const parseAll = (documents, options, { concurrent }) =>
  concurrent
    ? Promise.all(documents.map((document) => parsePdfBytesWithPdfjs(document.bytes, options)))
    : documents.reduce(
        async (previous, document) => [...(await previous), await parsePdfBytesWithPdfjs(document.bytes, options)],
        Promise.resolve([])
      );

const timeRun = async (run) => {
  const histogram = monitorEventLoopDelay({ resolution: 5 });

  histogram.enable();
  const startedAt = performance.now();

  await run();

  const ms = performance.now() - startedAt;

  histogram.disable();
  return {
    loopMaxMs: Math.round(histogram.max / 1e6),
    loopP99Ms: Math.round(histogram.percentile(99) / 1e6),
    ms: Math.round(ms),
  };
};

export const runParity = async (documents) => {
  const rows = [];

  for (const paragraphDetection of [true, false]) {
    const baseline = await parseAll(documents, { collectSignals: true, paragraphDetection, workers: 0 }, { concurrent: false });

    for (const [workers, pagesPerTask] of PARITY_CONFIGURATIONS) {
      const pooled = await withPagesPerTask(pagesPerTask, () =>
        parseAll(documents, { collectSignals: true, paragraphDetection, workers }, { concurrent: true })
      );
      const differing = documents
        .filter((_document, index) => {
          try {
            assert.deepStrictEqual(pooled[index], baseline[index]);
            return false;
          } catch {
            return true;
          }
        })
        .map((document) => document.name);

      rows.push({ differing, paragraphDetection, pagesPerTask, workers });
      await stopPdfParsePool();
    }
  }

  return rows;
};

export const runTiming = async (documents, { repeat, workers }) => {
  const scenarios = [
    { collectSignals: false, concurrent: false, label: "one after another, text only" },
    { collectSignals: false, concurrent: true, label: "all at once, text only" },
    { collectSignals: true, concurrent: true, label: "all at once, with signals" },
  ];
  const rows = [];

  for (const scenario of scenarios) {
    for (const size of [0, ...workers]) {
      const runs = [];

      for (let attempt = 0; attempt < repeat; attempt += 1) {
        runs.push(
          await timeRun(() =>
            parseAll(documents, { collectSignals: scenario.collectSignals, workers: size }, { concurrent: scenario.concurrent })
          )
        );
      }

      rows.push({ ...scenario, runs, workers: size });
      await stopPdfParsePool();
    }
  }

  return rows;
};

export const runRouting = async (documents) => {
  const thresholds = resolvePdfAutoRoutingConfig();
  const totals = Object.fromEntries(PDF_PAGE_ROUTES.map((route) => [route, 0]));
  const reasons = {};
  const perDocument = [];

  for (const document of documents) {
    const parsed = await parsePdfBytesWithPdfjs(document.bytes, { collectSignals: true, workers: 0 });
    const counts = Object.fromEntries(PDF_PAGE_ROUTES.map((route) => [route, 0]));

    for (const signals of parsed.signals) {
      const { reasons: pageReasons, route } = classifyPdfPage(signals, thresholds);

      counts[route] += 1;
      totals[route] += 1;
      for (const reason of pageReasons) {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
    }

    perDocument.push({ document: document.name, pages: parsed.pages.length, ...counts });
  }

  return { perDocument, reasons, thresholds, totals };
};

const describeRuns = (runs, field) => {
  const values = runs.map((run) => run[field]);

  return Math.min(...values) === Math.max(...values)
    ? String(values[0])
    : `${Math.min(...values)}–${Math.max(...values)}`;
};

export const formatPdfParseBenchMarkdown = (report) => {
  const lines = [
    "# pdf.js parse bench",
    "",
    `Node ${report.environment.node}, ${report.environment.cpus} CPUs, ${report.corpus.documents} documents, ${report.corpus.pages} pages.`,
    "",
    "## Parity (worker pool vs in-process)",
    "",
    "| Paragraph detection | Workers | Pages per task | Differing documents |",
    "| --- | --- | --- | --- |",
    ...report.parity.map(
      (row) => `| ${row.paragraphDetection ? "on" : "off"} | ${row.workers} | ${row.pagesPerTask} | ${row.differing.length} |`
    ),
    "",
    "## Wall time (ms over the whole set; longest event-loop stall in ms)",
    "",
    "| Scenario | Workers | Time | Longest stall |",
    "| --- | --- | --- | --- |",
    ...report.timing.map(
      (row) => `| ${row.label} | ${row.workers || "in-process"} | ${describeRuns(row.runs, "ms")} | ${describeRuns(row.runs, "loopMaxMs")} |`
    ),
    "",
    "## Routing (shipped thresholds)",
    "",
    `Pages per route: ${PDF_PAGE_ROUTES.map((route) => `${route} ${report.routing.totals[route]}`).join(", ")}.`,
    `Reasons: ${Object.entries(report.routing.reasons)
      .map(([reason, count]) => `${reason} ${count}`)
      .join(", ")}.`,
    "",
  ];

  return `${lines.join("\n")}\n`;
};

export const runPdfParseBench = async (options) => {
  const documents = await loadBenchDocuments(options.pdfDirs);

  if (documents.length === 0) {
    throw new Error("No PDF found in the given directories.");
  }

  try {
    const routing = await runRouting(documents);
    const parity = await runParity(documents);
    const timing = await runTiming(documents, options);

    return {
      corpus: {
        documents: documents.length,
        pages: routing.perDocument.reduce((sum, entry) => sum + entry.pages, 0),
      },
      environment: { cpus: os.cpus().length, node: process.versions.node },
      parity,
      routing,
      timing,
    };
  } finally {
    await stopPdfParsePool();
  }
};

const main = async () => {
  let options;

  try {
    options = parsePdfParseBenchArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  const report = await runPdfParseBench(options);
  const differing = report.parity.reduce((sum, row) => sum + row.differing.length, 0);

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, `${options.latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(options.outputDir, `${options.latestName}.md`), formatPdfParseBenchMarkdown(report));
  console.log(formatPdfParseBenchMarkdown(report));

  if (differing > 0) {
    console.error(`${differing} parity comparisons differ.`);
    process.exitCode = 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
