#!/usr/bin/env node
// PDF_PARSER=auto and docling-serve page ranges against a real docling-serve
// (docs/evaluation.md "按页分流和并行解析"). No model. Everything here was
// covered only by fetch stubs before:
//
//   1. numbering: a request with page_range [2, 3] (the form field twice, as
//      convertPdfBytesWithDocling sends it), and which page numbers the raw
//      DoclingDocument comes back with (mapRangePages assumes the original
//      file's, shifting 1..N defensively);
//   2. timing (after one warm-up page per docling-serve worker), one document
//      after another, for each arm (docling or auto,
//      DOCLING_PAGE_BATCH_SIZE, DOCLING_MAX_CONCURRENCY);
//   3. agreement with the first docling arm (normally one whole-document
//      request per paper): pages whose text is identical, and a token Dice
//      score for the others. A batched docling arm is compared on every page,
//      auto on the pages whose Docling text it used;
//   4. optional OCR check: --ocr-pdf <image-only PDF> --ocr-reference <the
//      text PDF it was rendered from>: the route auto gives each page, and the
//      token recall of Docling's OCR text against pdf.js's text of the
//      reference page.
//
//   DOCLING_SERVE_URL=http://127.0.0.1:5010 node evaluation/run-docling-routing-check.mjs \
//     [--pdf-dir evaluation/generated/qasper-pdfs] [--papers 30] [--numbering-papers 3] \
//     [--arms docling:0:1,docling:4:2,auto:0:1:0,auto:0:1:2,auto:0:2:2] \
//     [--ocr-pdf <file> --ocr-reference <file>] [--latest-name latest-docling-routing]
//
// An arm is <parser>:<DOCLING_PAGE_BATCH_SIZE>:<DOCLING_MAX_CONCURRENCY>
// [:<DOCLING_MERGE_GAP_PAGES>, default 2; auto only]. The
// report holds paper ids, counts, timings and scores, never page text. It never
// reads server/.env and writes ignored evaluation/results/<latest-name>.{json,md}.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getDoclingServeUrl } from "../rag/config.js";
import {
  convertPdfBytesWithDocling,
  doclingDocumentToPages,
  loadPdfPagesWithDocling,
  resetDoclingRequestLimiter,
} from "../rag/docling-parser.js";
import { loadPdfPagesWithRouting } from "../rag/pdf-auto-parser.js";
import { stopPdfParsePool } from "../rag/pdf-parse-pool.js";
import { parsePdfBytesWithPdfjs } from "../rag/pdfjs-document.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARM_PARSERS = new Set(["auto", "docling"]);

export const parseDoclingRoutingCheckArguments = (argv) => {
  const options = {
    arms: "docling:0:1,docling:4:2,auto:0:1:0,auto:0:1:2,auto:0:2:2",
    latestName: "latest-docling-routing",
    numberingPapers: 3,
    ocrPdf: null,
    ocrReference: null,
    outputDir: path.join(SERVER_DIR, "evaluation/results"),
    papers: 30,
    pdfDir: path.join(SERVER_DIR, "evaluation/generated/qasper-pdfs"),
  };
  const flags = {
    "--arms": (value) => (options.arms = value),
    "--latest-name": (value) => (options.latestName = value),
    "--numbering-papers": (value) => (options.numberingPapers = Number(value)),
    "--ocr-pdf": (value) => (options.ocrPdf = path.resolve(value)),
    "--ocr-reference": (value) => (options.ocrReference = path.resolve(value)),
    "--output-dir": (value) => (options.outputDir = path.resolve(value)),
    "--papers": (value) => (options.papers = Number(value)),
    "--pdf-dir": (value) => (options.pdfDir = path.resolve(value)),
  };

  for (let index = 0; index < argv.length; index += 2) {
    const apply = flags[argv[index]];

    if (!apply || argv[index + 1] === undefined) {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }

    apply(argv[index + 1]);
  }

  options.arms = String(options.arms)
    .split(",")
    .map((entry) => {
      const [parser, batchSize, concurrency, mergeGapPages = "2"] = entry.trim().split(":");
      const arm = {
        batchSize: Number(batchSize),
        concurrency: Number(concurrency),
        mergeGapPages: Number(mergeGapPages),
        parser,
      };

      if (
        !ARM_PARSERS.has(parser) ||
        ![arm.batchSize, arm.mergeGapPages].every((value) => Number.isInteger(value) && value >= 0) ||
        !Number.isInteger(arm.concurrency) ||
        arm.concurrency < 1
      ) {
        throw new Error(
          `--arms entries are <docling|auto>:<batch size >= 0>:<concurrency >= 1>[:<merge gap pages >= 0, default 2>]; got "${entry}".`
        );
      }

      const gap = parser === "auto" ? ` gap=${arm.mergeGapPages}` : "";

      return { ...arm, label: `${parser} batch=${arm.batchSize} concurrency=${arm.concurrency}${gap}` };
    });

  for (const [name, value] of [["--papers", options.papers], ["--numbering-papers", options.numberingPapers]]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} takes a non-negative integer.`);
    }
  }

  if (Boolean(options.ocrPdf) !== Boolean(options.ocrReference)) {
    throw new Error("--ocr-pdf and --ocr-reference go together.");
  }

  return options;
};

const tokenize = (text) => String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const countTokens = (tokens) => {
  const counts = new Map();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
};

const overlap = (left, right) => {
  let shared = 0;

  for (const [token, count] of left) {
    shared += Math.min(count, right.get(token) ?? 0);
  }

  return shared;
};

/** Multiset token Dice of two texts: 1 for the same words in any order. */
export const tokenDice = (left, right) => {
  const a = tokenize(left);
  const b = tokenize(right);

  if (a.length + b.length === 0) {
    return 1;
  }

  return (2 * overlap(countTokens(a), countTokens(b))) / (a.length + b.length);
};

/** Share of the reference's tokens (with multiplicity) the candidate holds. */
export const tokenRecall = (candidate, reference) => {
  const expected = tokenize(reference);

  return expected.length === 0 ? 1 : overlap(countTokens(expected), countTokens(tokenize(candidate))) / expected.length;
};

const withEnvironment = async (values, run) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  Object.assign(process.env, values);
  resetDoclingRequestLimiter();

  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    resetDoclingRequestLimiter();
  }
};

const elapsed = (startedAt) => Math.round(performance.now() - startedAt);

// The raw DoclingDocument of a ranged request, posted the way
// convertPdfBytesWithDocling posts it.
const postRangeRequest = async (bytes, fileName, [firstPage, lastPage]) => {
  const form = new FormData();

  form.append("files", new Blob([bytes], { type: "application/pdf" }), fileName);
  form.append("to_formats", "json");
  form.append("image_export_mode", "placeholder");
  form.append("do_ocr", "false");
  form.append("page_range", String(firstPage));
  form.append("page_range", String(lastPage));

  const response = await fetch(`${getDoclingServeUrl()}/v1/convert/file`, { body: form, method: "POST" });
  const payload = await response.json().catch(() => null);

  return { document: payload?.document?.json_content ?? null, status: response.status };
};

export const checkRangeNumbering = async (papers) => {
  const results = [];

  for (const paper of papers) {
    const range = [2, 3];
    const { document, status } = await postRangeRequest(paper.bytes, paper.fileName, range);
    const pageKeys = Object.keys(document?.pages ?? {}).map(Number).sort((left, right) => left - right);
    const pagesWithText = document
      ? doclingDocumentToPages(document).filter((page) => page.text.trim()).map((page) => page.pageNumber)
      : [];
    const numbering =
      pageKeys.length === 2 && pageKeys[0] === 2 && pageKeys[1] === 3
        ? "original"
        : pageKeys.length === 2 && pageKeys[0] === 1 && pageKeys[1] === 2
          ? "relative"
          : "other";

    results.push({ numbering, pageKeys, pagesWithText, paper: paper.id, range, status });
  }

  return results;
};

const runArm = async (arm, papers) =>
  withEnvironment(
    {
      DOCLING_FALLBACK: "pdfjs",
      DOCLING_MAX_CONCURRENCY: String(arm.concurrency),
      DOCLING_MERGE_GAP_PAGES: String(arm.mergeGapPages),
      DOCLING_PAGE_BATCH_SIZE: String(arm.batchSize),
    },
    async () => {
      const documents = [];

      for (const paper of papers) {
        const startedAt = performance.now();

        try {
          if (arm.parser === "docling") {
            const pages = await loadPdfPagesWithDocling(paper.filePath);

            documents.push({ ms: elapsed(startedAt), pages, paper: paper.id });
          } else {
            const { pages, routing } = await loadPdfPagesWithRouting(paper.filePath);

            documents.push({ ms: elapsed(startedAt), pages, paper: paper.id, routing });
          }
        } catch (error) {
          documents.push({ error: error?.code ?? error?.name ?? "Error", ms: elapsed(startedAt), paper: paper.id });
        }
      }

      return documents;
    }
  );

const summarizeArm = (arm, documents, reference) => {
  const succeeded = documents.filter((document) => !document.error);
  const summary = {
    ...arm,
    documents: documents.length,
    errors: documents.filter((document) => document.error).map(({ error, paper }) => ({ error, paper })),
    pages: succeeded.reduce((sum, document) => sum + document.pages.length, 0),
    perDocumentMs: documents.map(({ ms, paper }) => ({ ms, paper })),
    totalMs: documents.reduce((sum, document) => sum + document.ms, 0),
  };

  if (arm.parser === "auto") {
    const routes = succeeded.flatMap((document) => document.routing.routes);
    const batches = succeeded.flatMap((document) => document.routing.batches);

    summary.routing = {
      batches: batches.length,
      doclingPages: routes.filter((route) => route.parser === "docling").length,
      failedBatches: batches.filter((batch) => batch.outcome !== "ok").length,
      fallbacks: Object.fromEntries(
        ["docling_empty", "docling_failed"].map((reason) => [reason, routes.filter((route) => route.fallback === reason).length])
      ),
      routedPages: routes.filter((route) => route.route !== "text").length,
    };
  }

  if (reference) {
    const byPaper = new Map(reference.filter((document) => !document.error).map((document) => [document.paper, document]));
    const compared = [];

    for (const document of succeeded) {
      const baseline = byPaper.get(document.paper);

      if (!baseline) {
        continue;
      }

      const usedDocling =
        arm.parser === "auto"
          ? new Set(document.routing.routes.filter((route) => route.parser === "docling").map((route) => route.pageNumber))
          : null;

      for (const page of document.pages) {
        const baselinePage = baseline.pages.find((entry) => entry.pageNumber === page.pageNumber);

        if (baselinePage && (!usedDocling || usedDocling.has(page.pageNumber))) {
          compared.push({ dice: page.text === baselinePage.text ? 1 : tokenDice(page.text, baselinePage.text), identical: page.text === baselinePage.text, page: page.pageNumber, paper: document.paper });
        }
      }
    }

    const differing = compared.filter((entry) => !entry.identical);

    summary.agreement = {
      comparedPages: compared.length,
      differingPages: differing.map(({ dice, page, paper }) => ({ dice: Number(dice.toFixed(3)), page, paper })),
      identicalPages: compared.length - differing.length,
      minDice: compared.length ? Number(Math.min(...compared.map((entry) => entry.dice)).toFixed(3)) : null,
    };
  }

  return summary;
};

export const checkOcrRoute = async ({ ocrPdf, ocrReference }) => {
  const reference = await parsePdfBytesWithPdfjs(await readFile(ocrReference), { workers: 0 });
  const { pages, routing } = await withEnvironment({ DOCLING_FALLBACK: "pdfjs", DOCLING_PAGE_BATCH_SIZE: "0" }, () =>
    loadPdfPagesWithRouting(ocrPdf)
  );

  return {
    batches: routing.batches.map(({ durationMs, firstPage, lastPage, outcome, route }) => ({ durationMs, firstPage, lastPage, outcome, route })),
    pages: routing.routes.map((route, index) => ({
      pageNumber: route.pageNumber,
      parser: route.parser,
      reasons: route.reasons,
      recall: reference.pages[index] ? Number(tokenRecall(pages[index].text, reference.pages[index].text).toFixed(3)) : null,
      referenceTokens: reference.pages[index] ? tokenize(reference.pages[index].text).length : 0,
      route: route.route,
    })),
  };
};

export const formatDoclingRoutingMarkdown = (report) => {
  const lines = [
    "# docling-serve routing check",
    "",
    `${report.papers} papers, docling-serve at ${report.doclingServe}.`,
    "",
    "## page_range numbering",
    "",
    ...report.numbering.map((row) => `- ${row.paper}: HTTP ${row.status}, page keys [${row.pageKeys.join(", ")}] -> ${row.numbering}`),
    "",
    "## Arms (one document after another)",
    "",
    "| Arm | Total s | Pages | Errors | Docling pages | Identical pages vs first arm | Min Dice |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.arms.map(
      (arm) =>
        `| ${arm.label} | ${(arm.totalMs / 1000).toFixed(1)} | ${arm.pages} | ${arm.errors.length} | ${arm.routing?.doclingPages ?? "all"} | ${
          arm.agreement ? `${arm.agreement.identicalPages}/${arm.agreement.comparedPages}` : "reference"
        } | ${arm.agreement?.minDice ?? ""} |`
    ),
    "",
  ];

  if (report.ocr) {
    lines.push(
      "## OCR route",
      "",
      ...report.ocr.pages.map((page) => `- page ${page.pageNumber}: route ${page.route} (${page.reasons.join(", ")}), parser ${page.parser}, token recall ${page.recall}`),
      ""
    );
  }

  return `${lines.join("\n")}\n`;
};

const loadPapers = async (pdfDir, count) => {
  const names = (await readdir(pdfDir)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort().slice(0, count);

  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(pdfDir, name);

      return { bytes: await readFile(filePath), fileName: name, filePath, id: name.replace(/\.pdf$/i, "") };
    })
  );
};

export const runDoclingRoutingCheck = async (options) => {
  const papers = await loadPapers(options.pdfDir, options.papers);
  const pageCounts = await Promise.all(papers.map(async (paper) => (await parsePdfBytesWithPdfjs(paper.bytes, { workers: 0 })).pageCount));
  // docling-serve loads its models on a worker's first conversion: one page
  // per worker (two by default) before anything is timed.
  await withEnvironment({ DOCLING_MAX_CONCURRENCY: "2" }, () =>
    Promise.all([0, 1].map(() => convertPdfBytesWithDocling(papers[0].bytes, papers[0].fileName, { pageRange: [1, 1] })))
  );

  const numbering = await checkRangeNumbering(papers.filter((_paper, index) => pageCounts[index] >= 4).slice(0, options.numberingPapers));
  const arms = [];
  let reference = null;

  for (const arm of options.arms) {
    const documents = await runArm(arm, papers);

    arms.push(summarizeArm(arm, documents, reference));
    reference ??= documents;
  }

  return {
    arms,
    doclingServe: getDoclingServeUrl(),
    numbering,
    ocr: options.ocrPdf ? await checkOcrRoute(options) : null,
    papers: papers.length,
  };
};

const main = async () => {
  let options;

  try {
    options = parseDoclingRoutingCheckArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  try {
    const report = await runDoclingRoutingCheck(options);

    await mkdir(options.outputDir, { recursive: true });
    await writeFile(path.join(options.outputDir, `${options.latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(options.outputDir, `${options.latestName}.md`), formatDoclingRoutingMarkdown(report));
    console.log(formatDoclingRoutingMarkdown(report));
  } finally {
    await stopPdfParsePool();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
