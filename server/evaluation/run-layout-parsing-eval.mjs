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
// Usage (docling-serve running, a real chat model and embeddings):
//   DOCLING_SERVE_URL=http://127.0.0.1:5010 OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
//   OPENAI_API_KEY=ollama OPENAI_CHAT_MODEL=qwen2.5:7b OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   RAG_EMBEDDING_DIMENSIONS=768 node evaluation/run-layout-parsing-eval.mjs
//     [--qasper evaluation/generated/qasper/qasper-dev-v0.3.json]
//     [--pdf-dir evaluation/generated/qasper-pdfs] [--papers 30]
//     [--latest-name latest-layout-parsing]
// PDFs are https://arxiv.org/pdf/<paper id>, downloaded beforehand.

import "dotenv/config";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeQasperAnswer } from "./import-qasper.mjs";
import { normalizeQasperAnswer, qasperAnswerF1, toQasperPrediction } from "./qasper-answer-metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");
const PARSERS = Object.freeze(["pdfjs", "docling"]);
const METRICS = Object.freeze(["f1", "inDocument", "inContext"]);

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

/** Paired bootstrap of docling minus pdfjs for one metric over rows that have both. */
export const pairedDelta = (rows, metric, { iterations = 4000, seed = 1 } = {}) => {
  const diffs = rows
    .filter((row) => typeof row.pdfjs?.[metric] !== "undefined" && row.pdfjs[metric] !== null && row.docling?.[metric] !== null)
    .map((row) => Number(row.docling[metric]) - Number(row.pdfjs[metric]));

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

const summarize = (rows) => {
  const mean = (values) =>
    values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));

  return Object.fromEntries(
    PARSERS.map((parser) => [
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

const formatMarkdown = (report) => {
  const section = (title, group) => [
    `## ${title} (${group.rows} questions)`,
    "",
    "| Metric | pdf.js | Docling | Docling - pdf.js [95% CI] |",
    "|---|---|---|---|",
    ...METRICS.map(
      (metric) =>
        `| ${metric} | ${group.summary.pdfjs[metric]} | ${group.summary.docling[metric]} | ${group.deltas[metric].delta} [${group.deltas[metric].ci95?.join(", ") ?? "n/a"}] (n=${group.deltas[metric].cases}) |`
    ),
    "",
  ];

  return [
    "# Layout parsing: pdf.js vs Docling on QASPER papers",
    "",
    `Generated ${report.generatedAt}; ${report.config.papers} papers (${report.config.failedPapers.length} failed to parse and were left out); chat model ${report.config.chatModel}; embedding ${report.config.embeddingModel}.`,
    `Parse time: pdf.js ${report.parseSeconds.pdfjs}s, Docling ${report.parseSeconds.docling}s in total.`,
    "",
    "inDocument / inContext: a gold extractive span occurs in the parsed text / in the retrieved chunks (questions with extractive answers only). f1: official QASPER answer F1.",
    "",
    ...section("Evidence in a table", report.table),
    ...section("Control: evidence in text", report.control),
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
  const qasper = JSON.parse(await readFile(qasperPath, "utf8"));
  const paperIds = selectTablePapers(qasper, paperCount);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "layout-parsing-"));

  process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");
  process.env.DOCCOMPARE_STANDALONE = "1";
  Object.assign(process.env, { RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false", RAG_LONG_MEMORY_ENABLED: "false" });

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();
  const rag = await import("../chat.js");
  const { loadPdfDocument } = await import("../rag/pdf-loader.js");
  const { loadPdfPagesWithDocling } = await import("../rag/docling-parser.js");
  const parseWith = {
    docling: (filePath) => loadPdfPagesWithDocling(filePath),
    pdfjs: async (filePath) => (await loadPdfDocument(filePath)).pages,
  };
  const parsedText = new Map();
  const parseSeconds = { docling: 0, pdfjs: 0 };
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

      try {
        for (const parser of PARSERS) {
          const started = Date.now();

          parsed[parser] = await parseWith[parser](filePath);
          parseSeconds[parser] += (Date.now() - started) / 1000;
        }
      } catch (error) {
        failedPapers.push({ paperId, reason: error.message });
        continue;
      }

      for (const parser of PARSERS) {
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

    for (const [index, { paperId, qa }] of questions.entries()) {
      const references = (qa.answers ?? []).map((entry) => describeQasperAnswer(entry.answer)?.text).filter(Boolean);
      const spans = (qa.answers ?? []).flatMap((entry) => entry.answer?.extractive_spans ?? []).filter(Boolean);
      const row = { group: isTableEvidence(qa) ? "table" : "control", paperId, question: qa.question, questionId: qa.question_id };

      for (const parser of PARSERS) {
        const docId = `${paperId}__${parser}`;
        const result = await rag.default([docId], qa.question, {
          accessScope,
          includeRetrievedContexts: true,
          sessionId: `layout-${qa.question_id}-${parser}`,
        });
        const context = (result?.retrievedContexts ?? []).map((entry) => entry.text ?? entry.pageContent ?? "").join("\n");

        row[parser] = {
          abstained: Boolean(result?.abstained),
          f1: Number(qasperAnswerF1(toQasperPrediction({ abstained: result?.abstained, text: result?.text }), references).toFixed(4)),
          inContext: spans.length > 0 ? containsGoldSpan(context, spans) : null,
          inDocument: spans.length > 0 ? containsGoldSpan(parsedText.get(docId), spans) : null,
        };
      }

      rows.push(row);
      console.log(
        `${String(index + 1).padStart(3)}/${questions.length} ${row.group.padEnd(7)} f1 ${row.pdfjs.f1.toFixed(2)} -> ${row.docling.f1.toFixed(2)}`
      );
    }
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }

  const group = (name) => {
    const groupRows = rows.filter((row) => row.group === name);

    return {
      deltas: Object.fromEntries(METRICS.map((metric) => [metric, pairedDelta(groupRows, metric)])),
      rows: groupRows.length,
      summary: summarize(groupRows),
    };
  };
  const report = {
    config: {
      chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
      doclingServeUrl: process.env.DOCLING_SERVE_URL ?? null,
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? null,
      failedPapers,
      paperIds,
      papers: paperIds.length,
    },
    control: group("control"),
    generatedAt: new Date().toISOString(),
    parseSeconds: Object.fromEntries(Object.entries(parseSeconds).map(([key, value]) => [key, Number(value.toFixed(1))])),
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
