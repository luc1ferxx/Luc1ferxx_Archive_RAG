// run-layout-parsing-eval.mjs
//
// pdf.js against Docling (PDF_PARSER) on real two-column arXiv papers. QASPER
// questions whose annotated evidence is a table ("FLOAT SELECTED: Table ...")
// are the ones the corpus importer has to skip, because its text-only paper
// JSON has no table content; here each paper's PDF is parsed by both parsers,
// ingested side by side (docId <paper>__pdfjs / <paper>__docling) in one
// throwaway standalone archive, and every question is asked of both versions:
//
//   inDocument  a gold extractive span occurs in the parsed text at all
//   inContext   ... in the chunks retrieved for the model
//   f1          official QASPER answer F1 of the document RAG answer
//
// Questions of the same papers whose evidence is text only are a control:
// layout parsing must not cost ordinary paragraphs. Paired bootstrap 95% CIs
// are Docling minus pdf.js over the same questions.
//
// --parsers <base>,<variant> picks the two arms (default pdfjs,docling; the
// delta is variant minus base). pdfjs is the legacy pdf.js text with paragraph
// detection forced off; pdfjs-paragraphs is pdf.js with PDF_PARAGRAPH_DETECTION
// forced on (pdf-paragraphs.js), which needs no docling-serve; auto is what
// PDF_PARSER=auto ingests (pdf-auto-parser.js): pdf.js under the configured
// PDF_PARAGRAPH_DETECTION for every page, Docling's text for the pages the
// router sends to docling-serve under the PDF_AUTO_* and DOCLING_* settings.
// With auto in the pair the report adds `routing.auto`: pages per route,
// Docling pages and fallbacks, in total and per paper, from each document's
// routing report (codes and counts only).
//
// The report records the chunking settings and the commit it ran with
// (config.chunking, config.git; eval-run-config.js), the PDF settings as
// configured and as each arm parses (config.pdf), and per row and arm
// contextChars, the characters of the chunks retrieved for the model.
//
// Usage (docling-serve running, a real chat model and embeddings):
//   DOCLING_SERVE_URL=http://127.0.0.1:5010 OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
//   OPENAI_API_KEY=ollama OPENAI_CHAT_MODEL=qwen2.5:7b OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   RAG_EMBEDDING_DIMENSIONS=768 node evaluation/run-layout-parsing-eval.mjs
//     [--qasper evaluation/generated/qasper/qasper-dev-v0.3.json]
//     [--pdf-dir evaluation/generated/qasper-pdfs] [--papers 30]
//     [--parsers pdfjs,docling|pdfjs-paragraphs,auto|...] [--concurrency 1]
//     [--latest-name latest-layout-parsing]
// PDFs are https://arxiv.org/pdf/<paper id>, downloaded beforehand.

import "dotenv/config";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  describeChunkingConfig,
  describeEvaluationCheckout,
  describePdfConfig,
  sumTextChars,
} from "./eval-run-config.js";
import { describeQasperAnswer } from "./import-qasper.mjs";
import { normalizeQasperAnswer, qasperAnswerF1, toQasperPrediction } from "./qasper-answer-metrics.js";
import { useEvaluationDataDirectory } from "./eval-data-directory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");
const DEFAULT_PARSERS = Object.freeze(["pdfjs", "docling"]);
const KNOWN_PARSERS = Object.freeze(["pdfjs", "docling", "pdfjs-paragraphs", "auto"]);
const PARSER_LABELS = Object.freeze({
  auto: "auto (pdf.js + Docling pages)",
  docling: "Docling",
  pdfjs: "pdf.js",
  "pdfjs-paragraphs": "pdf.js + paragraphs",
});
const PAGE_ROUTES = Object.freeze(["text", "layout", "ocr"]);
const AUTO_FALLBACKS = Object.freeze(["docling_empty", "docling_failed"]);
const METRICS = Object.freeze(["f1", "inDocument", "inContext"]);

/** `--parsers base,variant`: exactly two distinct known parsers; the delta is variant minus base. */
export const parseParserPair = (value) => {
  if (value === undefined || value === null || value === "") {
    return [...DEFAULT_PARSERS];
  }

  const parsers = String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (parsers.length !== 2 || parsers[0] === parsers[1] || !parsers.every((parser) => KNOWN_PARSERS.includes(parser))) {
    throw new Error(`--parsers takes two distinct parsers out of ${KNOWN_PARSERS.join(", ")}, base first.`);
  }

  return parsers;
};

/**
 * Each arm as `filePath -> { pages, routing }`; routing is the auto arm's
 * routing report and null for the others. `deps` are the loaders (the eval
 * passes the real ones) and an optional `fetchImpl` for docling-serve.
 */
export const createLayoutParsers = ({ fetchImpl, loadPdfDocument, loadPdfPagesWithDocling, loadPdfPagesWithRouting }) => ({
  auto: async (filePath) => loadPdfPagesWithRouting(filePath, { fetchImpl }),
  docling: async (filePath) => ({ pages: await loadPdfPagesWithDocling(filePath, { fetchImpl }), routing: null }),
  pdfjs: async (filePath) => ({ pages: (await loadPdfDocument(filePath, { paragraphDetection: false })).pages, routing: null }),
  "pdfjs-paragraphs": async (filePath) => ({
    pages: (await loadPdfDocument(filePath, { paragraphDetection: true })).pages,
    routing: null,
  }),
});

/**
 * config.pdf: the PDF settings this process is configured with, and what
 * each arm parses with -- the pdf.js arms force paragraph detection off or
 * on whatever the setting says, auto keeps the configured one, and Docling's
 * text has no paragraph step (null).
 */
export const describeLayoutPdfConfig = (parsers, configured) => ({
  ...configured,
  arms: Object.fromEntries(
    parsers.map((parser) => [
      parser,
      {
        auto: { paragraphDetection: configured.paragraphDetection, parser: "auto" },
        docling: { paragraphDetection: null, parser: "docling" },
        pdfjs: { paragraphDetection: false, parser: "pdfjs" },
        "pdfjs-paragraphs": { paragraphDetection: true, parser: "pdfjs" },
      }[parser],
    ])
  ),
});

const countAutoRouting = (routing) => {
  const routes = routing?.routes ?? [];

  return {
    pageCount: routing?.pageCount ?? routes.length,
    pagesByRoute: Object.fromEntries(PAGE_ROUTES.map((route) => [route, routes.filter((entry) => entry.route === route).length])),
    doclingPages: routes.filter((entry) => entry.parser === "docling").length,
    fallbackPages: Object.fromEntries(
      AUTO_FALLBACKS.map((reason) => [reason, routes.filter((entry) => entry.fallback === reason).length])
    ),
    doclingRequests: routing?.batches?.length ?? 0,
    failedRequests: (routing?.batches ?? []).filter((batch) => batch.outcome !== "ok").length,
  };
};

/**
 * The auto arm's routing over the papers it parsed: `entries` are
 * `{ paperId, routing }` (loadPdfPagesWithRouting reports). Pages per route
 * (the router's choice), Docling pages (pages whose text is Docling's),
 * fallback pages, docling-serve requests and failed ones, in total and per
 * paper. Codes and counts only.
 */
export const summarizeAutoRouting = (entries) => {
  const papers = entries.map(({ paperId, routing }) => ({ paperId, ...countAutoRouting(routing) }));
  const sum = (read) => papers.reduce((total, paper) => total + read(paper), 0);

  return {
    documents: papers.length,
    pages: sum((paper) => paper.pageCount),
    pagesByRoute: Object.fromEntries(PAGE_ROUTES.map((route) => [route, sum((paper) => paper.pagesByRoute[route])])),
    doclingPages: sum((paper) => paper.doclingPages),
    fallbackPages: Object.fromEntries(AUTO_FALLBACKS.map((reason) => [reason, sum((paper) => paper.fallbackPages[reason])])),
    doclingRequests: sum((paper) => paper.doclingRequests),
    failedRequests: sum((paper) => paper.failedRequests),
    papers,
  };
};

const isTableEvidence = (qa) =>
  (qa.answers ?? []).some((entry) =>
    (entry.answer?.evidence ?? []).some((evidence) => String(evidence).startsWith("FLOAT SELECTED: Table"))
  );
const isAnswerable = (qa) => !(qa.answers ?? []).every((entry) => entry.answer?.unanswerable);

/** The papers with the most answerable table-evidence questions, ties by id. */
export const selectTablePapers = (qasper, count) =>
  Object.entries(qasper)
    .map(([paperId, paper]) => [paperId, (paper.qas ?? []).filter((qa) => isAnswerable(qa) && isTableEvidence(qa)).length])
    .filter(([, questions]) => questions > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, count)
    .map(([paperId]) => paperId);

/** Whether any gold extractive span occurs in `text`, after QASPER normalization. */
export const containsGoldSpan = (text, spans) => {
  const haystack = ` ${normalizeQasperAnswer(text)} `;

  return spans.some((span) => {
    const needle = normalizeQasperAnswer(span);

    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
};

const createSeededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Paired bootstrap of variant minus base (default docling minus pdfjs) for one metric over rows that have both. */
export const pairedDelta = (
  rows,
  metric,
  { base = "pdfjs", iterations = 4000, seed = 1, variant = "docling" } = {}
) => {
  const diffs = rows
    .filter(
      (row) =>
        typeof row[base]?.[metric] !== "undefined" &&
        row[base][metric] !== null &&
        typeof row[variant]?.[metric] !== "undefined" &&
        row[variant][metric] !== null
    )
    .map((row) => Number(row[variant][metric]) - Number(row[base][metric]));

  if (diffs.length === 0) {
    return { cases: 0, ci95: null, delta: null };
  }

  const random = createSeededRandom(seed);
  const samples = [];

  for (let index = 0; index < iterations; index += 1) {
    let sum = 0;

    for (let draw = 0; draw < diffs.length; draw += 1) {
      sum += diffs[Math.floor(random() * diffs.length)];
    }

    samples.push(sum / diffs.length);
  }

  samples.sort((left, right) => left - right);
  const round = (value) => Number(value.toFixed(4));

  return {
    cases: diffs.length,
    ci95: [round(samples[Math.floor(iterations * 0.025)]), round(samples[Math.floor(iterations * 0.975)])],
    delta: round(diffs.reduce((sum, value) => sum + value, 0) / diffs.length),
  };
};

const summarize = (rows, parsers = DEFAULT_PARSERS) => {
  const mean = (values) =>
    values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));

  return Object.fromEntries(
    parsers.map((parser) => [
      parser,
      Object.fromEntries(
        METRICS.map((metric) => [
          metric,
          mean(rows.map((row) => row[parser]?.[metric]).filter((value) => value !== null && value !== undefined).map(Number)),
        ])
      ),
    ])
  );
};

const formatAutoRouting = (auto) =>
  `Auto routing: ${auto.pages} pages of ${auto.documents} papers, ${PAGE_ROUTES.map((route) => `${route} ${auto.pagesByRoute[route]}`).join(", ")}; ` +
  `Docling pages ${auto.doclingPages} (${AUTO_FALLBACKS.map((reason) => `${reason} ${auto.fallbackPages[reason]}`).join(", ")}); ` +
  `docling-serve requests ${auto.doclingRequests}, ${auto.failedRequests} failed.`;

export const formatMarkdown = (report) => {
  const [base, variant] = report.config.parsers ?? DEFAULT_PARSERS;
  const label = (parser) => PARSER_LABELS[parser] ?? parser;
  const section = (title, group) => [
    `## ${title} (${group.rows} questions)`,
    "",
    `| Metric | ${label(base)} | ${label(variant)} | ${label(variant)} - ${label(base)} [95% CI] |`,
    "|---|---|---|---|",
    ...METRICS.map(
      (metric) =>
        `| ${metric} | ${group.summary[base][metric]} | ${group.summary[variant][metric]} | ${group.deltas[metric].delta} [${group.deltas[metric].ci95?.join(", ") ?? "n/a"}] (n=${group.deltas[metric].cases}) |`
    ),
    "",
  ];

  return [
    `# Layout parsing: ${label(base)} vs ${label(variant)} on QASPER papers`,
    "",
    `Generated ${report.generatedAt}; ${report.config.papers} papers (${report.config.failedPapers.length} failed to parse and were left out); chat model ${report.config.chatModel}; embedding ${report.config.embeddingModel}.`,
    `Parse time: ${label(base)} ${report.parseSeconds[base]}s, ${label(variant)} ${report.parseSeconds[variant]}s in total.`,
    ...(report.routing?.auto ? [formatAutoRouting(report.routing.auto)] : []),
    "",
    "inDocument / inContext: a gold extractive span occurs in the parsed text / in the retrieved chunks (questions with extractive answers only). f1: official QASPER answer F1.",
    "",
    ...section("Evidence in a table", report.table),
    ...section("Control: evidence in text", report.control),
    ...(report.all ? section("All questions", report.all) : []),
  ].join("\n");
};

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const qasperPath = path.resolve(
    process.cwd(),
    option("--qasper", path.join(__dirname, "generated", "qasper", "qasper-dev-v0.3.json"))
  );
  const pdfDirectory = path.resolve(process.cwd(), option("--pdf-dir", path.join(__dirname, "generated", "qasper-pdfs")));
  const paperCount = Math.max(1, Number(option("--papers", "30")) || 30);
  const latestName = option("--latest-name", "latest-layout-parsing");
  const parsers = parseParserPair(option("--parsers"));
  const [baseParser, variantParser] = parsers;
  const concurrency = Math.max(1, Number(option("--concurrency", "1")) || 1);
  const qasper = JSON.parse(await readFile(qasperPath, "utf8"));
  // The checkout, before the run writes anything.
  const git = await describeEvaluationCheckout();
  const paperIds = selectTablePapers(qasper, paperCount);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "layout-parsing-"));

  useEvaluationDataDirectory(path.join(tempRoot, "rag-data"));
  process.env.DOCCOMPARE_STANDALONE = "1";
  Object.assign(process.env, { RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false", RAG_LONG_MEMORY_ENABLED: "false" });

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();
  const rag = await import("../chat.js");
  const { loadPdfDocument } = await import("../rag/pdf-loader.js");
  const { isPdfParagraphDetectionEnabled } = await import("../rag/config.js");
  const { resolvePdfAutoRoutingConfig } = await import("../rag/pdf-page-router.js");
  const { loadPdfPagesWithDocling } = await import("../rag/docling-parser.js");
  const { loadPdfPagesWithRouting } = await import("../rag/pdf-auto-parser.js");
  const parseWith = createLayoutParsers({ loadPdfDocument, loadPdfPagesWithDocling, loadPdfPagesWithRouting });
  // Read before any paper is parsed, so an invalid PDF_AUTO_* value stops the
  // run here rather than failing every paper.
  const autoSettings = parsers.includes("auto")
    ? { paragraphDetection: isPdfParagraphDetectionEnabled(), thresholds: resolvePdfAutoRoutingConfig() }
    : null;
  const parsedText = new Map();
  const autoRouting = [];
  const parseSeconds = Object.fromEntries(parsers.map((parser) => [parser, 0]));
  const failedPapers = [];
  const rows = [];

  try {
    await rag.initializeDocumentRegistry();

    for (const paperId of paperIds) {
      const filePath = path.join(pdfDirectory, `${paperId}.pdf`);

      if (!(await stat(filePath).catch(() => null))) {
        failedPapers.push({ paperId, reason: "PDF not downloaded" });
        continue;
      }

      const parsed = {};
      const routing = {};

      try {
        for (const parser of parsers) {
          const started = Date.now();
          const outcome = await parseWith[parser](filePath);

          parsed[parser] = outcome.pages;
          routing[parser] = outcome.routing;
          parseSeconds[parser] += (Date.now() - started) / 1000;
        }
      } catch (error) {
        failedPapers.push({ paperId, reason: error.message });
        continue;
      }

      if (routing.auto) {
        autoRouting.push({ paperId, routing: routing.auto });
      }

      for (const parser of parsers) {
        const docId = `${paperId}__${parser}`;

        parsedText.set(docId, parsed[parser].map((page) => page.text).join("\n"));
        await rag.ingestDocumentPages({ docId, fileName: `${paperId}.pdf`, filePath, pages: parsed[parser] });
      }

      console.log(`parsed and ingested ${paperId}`);
    }

    const accessScope = { authenticated: false, userId: "", workspaceId: "" };
    const questions = paperIds
      .filter((paperId) => !failedPapers.some((failure) => failure.paperId === paperId))
      .flatMap((paperId) =>
        (qasper[paperId].qas ?? []).filter(isAnswerable).map((qa) => ({ paperId, qa }))
      );

    const askQuestion = async (index) => {
      const { paperId, qa } = questions[index];
      const references = (qa.answers ?? []).map((entry) => describeQasperAnswer(entry.answer)?.text).filter(Boolean);
      const spans = (qa.answers ?? []).flatMap((entry) => entry.answer?.extractive_spans ?? []).filter(Boolean);
      const row = { group: isTableEvidence(qa) ? "table" : "control", paperId, question: qa.question, questionId: qa.question_id };

      for (const parser of parsers) {
        const docId = `${paperId}__${parser}`;
        const result = await rag.default([docId], qa.question, {
          accessScope,
          includeRetrievedContexts: true,
          sessionId: `layout-${qa.question_id}-${parser}`,
        });
        const contexts = (result?.retrievedContexts ?? []).map((entry) => entry.text ?? entry.pageContent ?? "");
        const context = contexts.join("\n");

        row[parser] = {
          abstained: Boolean(result?.abstained),
          contextChars: sumTextChars(contexts),
          f1: Number(qasperAnswerF1(toQasperPrediction({ abstained: result?.abstained, text: result?.text }), references).toFixed(4)),
          inContext: spans.length > 0 ? containsGoldSpan(context, spans) : null,
          inDocument: spans.length > 0 ? containsGoldSpan(parsedText.get(docId), spans) : null,
        };
      }

      rowsByIndex[index] = row;
      completed += 1;
      console.log(
        `${String(completed).padStart(3)}/${questions.length} ${row.group.padEnd(7)} f1 ${row[baseParser].f1.toFixed(2)} -> ${row[variantParser].f1.toFixed(2)}`
      );
    };
    const rowsByIndex = new Array(questions.length);
    let completed = 0;
    let nextIndex = 0;

    // Questions in flight (--concurrency, default 1); rows keep question order.
    await Promise.all(
      Array.from({ length: Math.min(concurrency, questions.length) }, async () => {
        while (nextIndex < questions.length) {
          const index = nextIndex;

          nextIndex += 1;
          await askQuestion(index);
        }
      })
    );
    rows.push(...rowsByIndex);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }

  const group = (name) => {
    const groupRows = name === "all" ? rows : rows.filter((row) => row.group === name);

    return {
      deltas: Object.fromEntries(
        METRICS.map((metric) => [metric, pairedDelta(groupRows, metric, { base: baseParser, variant: variantParser })])
      ),
      rows: groupRows.length,
      summary: summarize(groupRows, parsers),
    };
  };
  const report = {
    config: {
      chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
      chunking: await describeChunkingConfig(),
      doclingServeUrl: process.env.DOCLING_SERVE_URL ?? null,
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? null,
      failedPapers,
      git,
      pdf: describeLayoutPdfConfig(parsers, await describePdfConfig()),
      paperIds,
      concurrency,
      papers: paperIds.length,
      parsers,
    },
    all: group("all"),
    control: group("control"),
    generatedAt: new Date().toISOString(),
    parseSeconds: Object.fromEntries(Object.entries(parseSeconds).map(([key, value]) => [key, Number(value.toFixed(1))])),
    ...(autoSettings ? { routing: { auto: { ...autoSettings, ...summarizeAutoRouting(autoRouting) } } } : {}),
    reportType: "layout-parsing",
    rows,
    table: group("table"),
  };

  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDirectory, `${latestName}.md`), `${formatMarkdown(report)}\n`);
  process.stdout.write(formatMarkdown(report));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
