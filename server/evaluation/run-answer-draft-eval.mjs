// run-answer-draft-eval.mjs
//
// Measures verified answer drafts (rag/answer-drafts.js) with a real model:
// how much sooner a streaming client sees its first verified sentence than the
// final answer, and how often the drafts it saw survive into that answer.
//
// Two case sets, ingested into a throwaway standalone archive (real embeddings,
// local index, no database) and run through runAgentRag with a streaming sink
// attached, exactly as /chat/stream does:
//
// - fixtures: the verify:quality contracts and policy, whose facts are stated
//   verbatim, so a correct answer can pass the lexical claim check. This is
//   where drafts can show their latency benefit.
// - arxiv: single-document QA on eight real papers. The lexical check rejects
//   most paraphrased answers here, so this set shows how often a user would
//   see any draft at all.
//
// Planners are the deterministic ones, so timings cover retrieval and
// answering, not LLM planning.
//
// A draft is retained when its text, labels and punctuation aside, appears in
// the final answer. A run retracts when any draft it showed is missing from
// the final answer; the report says why (clarification, follow-up answer, or a
// finalizer rewrite).
//
// Usage (OpenAI-compatible endpoint, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_CHAT_MODEL=qwen2.5:7b OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   RAG_EMBEDDING_DIMENSIONS=768 node evaluation/run-answer-draft-eval.mjs
//     [--set fixtures|arxiv|all] [--cases 12]   (--cases limits the arxiv set)

import "dotenv/config";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DOCCOMPARE_FIXTURES } from "./build-doccompare-fixtures.mjs";

// The prompt templates this run used; null when the code under test predates
// the prompt registry (these scripts also run against older checkouts).
const describePromptTemplates = async () => {
  try {
    const { describeActivePromptTemplates } = await import("../rag/prompt-catalog.js");

    return describeActivePromptTemplates();
  } catch {
    return null;
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");
const CORPUS_PATH = path.join(__dirname, "corpora", "arxiv-computer-science-rerank-v1.json");
const SOURCE_LABEL_PATTERN = /\[(?:source|来源)\s*\d+\]/gi;

export const normalizeDraftText = (value) =>
  String(value ?? "")
    .replace(SOURCE_LABEL_PATTERN, " ")
    .replace(/^[-*]\s+/gm, "")
    .replace(/[.!?。！？]+(\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Scores one streamed run: which drafts survived, and why the others did not.
 */
export const scoreDraftRun = ({ drafts = [], finalAnswer = "", agentMode, followUp, finalizerChanged }) => {
  const finalText = normalizeDraftText(finalAnswer);
  const retained = drafts.filter((draft) => finalText.includes(normalizeDraftText(draft)));
  const retracted = drafts.length - retained.length;

  return {
    draftCount: drafts.length,
    retainedCount: retained.length,
    retracted: retracted > 0,
    retractionCause:
      retracted === 0
        ? null
        : agentMode === "clarification"
          ? "clarification"
          : followUp
            ? "follow_up_answer"
            : finalizerChanged
              ? "finalizer_rewrite"
              : "other",
  };
};

const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]);
};

// [document, question, value the answer must state, value it must not]
const FIXTURE_QUESTIONS = [
  ["vendorA", "What is the limitation of liability?", /\b(?:twelve|12)\b/i, /\b(?:six|6)\b/i],
  ["vendorA", "How much notice is required to terminate the agreement?", /\b(?:thirty|30)\b/i, /\b(?:ninety|90)\b/i],
  ["vendorA", "Which state's law governs the agreement?", /Delaware/i, /New York/i],
  ["vendorB", "What is the limitation of liability?", /\b(?:six|6)\b/i, /\b(?:twelve|12)\b/i],
  ["vendorB", "How much notice is required to terminate the agreement?", /\b(?:ninety|90)\b/i, /\b(?:thirty|30)\b/i],
  ["vendorB", "Which state's law governs the agreement?", /New York/i, /Delaware/i],
  ["twinLeft", "How many days per week may employees work remotely?", /\b(?:two|2)\b/i, /\b(?:three|3)\b/i],
];

const buildFixtureSet = () => {
  const used = [...new Set(FIXTURE_QUESTIONS.map(([key]) => key))];

  return {
    cases: FIXTURE_QUESTIONS.map(([key, question, expected, forbidden], index) => ({
      docId: DOCCOMPARE_FIXTURES[key].docId,
      expected,
      forbidden,
      id: `fixture_${key}_${index + 1}`,
      question,
    })),
    documents: used.map((key) => ({
      docId: DOCCOMPARE_FIXTURES[key].docId,
      fileName: DOCCOMPARE_FIXTURES[key].fileName,
      pages: DOCCOMPARE_FIXTURES[key].pages.map((lines) => lines.join("\n")),
    })),
    name: "fixtures",
  };
};

// Round-robin over documents so a small sample still covers every paper.
const pickCases = (corpus, count) => {
  const byDoc = new Map();

  for (const testCase of corpus.cases) {
    if (testCase.type !== "qa" || testCase.docKeys?.length !== 1) continue;
    const key = testCase.docKeys[0];
    byDoc.set(key, [...(byDoc.get(key) ?? []), testCase]);
  }

  const picked = [];
  for (let round = 0; picked.length < count; round += 1) {
    const before = picked.length;
    for (const cases of byDoc.values()) {
      if (cases[round] && picked.length < count) picked.push(cases[round]);
    }
    if (picked.length === before) break;
  }
  return picked;
};

const renderSetMarkdown = ({ name, runs, summary }) =>
  [
    `## ${name}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Runs with at least one draft | ${summary.runsWithDrafts}/${summary.cases} |`,
    `| Time to first draft, p50 / p95 | ${summary.firstDraftMs.p50} / ${summary.firstDraftMs.p95} ms |`,
    `| Time to final answer, p50 / p95 | ${summary.finalMs.p50} / ${summary.finalMs.p95} ms |`,
    `| First draft ahead of final, p50 | ${summary.leadMs.p50} ms |`,
    `| Drafts retained in the final answer | ${summary.retainedDrafts}/${summary.drafts} (${summary.retentionRate}%) |`,
    `| Runs that retracted a draft | ${summary.retractedRuns}/${summary.runsWithDrafts} |`,
    `| Retraction causes | ${Object.entries(summary.retractionCauses).map(([cause, n]) => `${cause}: ${n}`).join(", ") || "none"} |`,
    `| Draft resets (retried model calls) | ${summary.resets} |`,
    `| Final answers that were a clarification | ${summary.clarifications}/${summary.cases} |`,
    `| Answers checked correct / wrong (fixtures only) | ${summary.correctAnswers} / ${summary.wrongAnswers} |`,
    "",
    "| Case | Mode | Drafts | Retained | First draft ms | Final ms | Retraction |",
    "|---|---|---|---|---|---|---|",
    ...runs.map(
      (run) =>
        `| ${run.id} | ${run.agentMode} | ${run.draftCount} | ${run.retainedCount} | ${run.firstDraftMs ?? "-"} | ${run.finalMs} | ${run.retractionCause ?? "-"} |`
    ),
    "",
  ].join("\n");

const renderMarkdown = (report) =>
  [
    "# Verified answer drafts (real model)",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Chat model: ${report.config.chatModel}; embedding model: ${report.config.embeddingModel}`,
    "- Single-document QA through runAgentRag with a streaming sink; deterministic planners",
    "",
    ...report.sets.map(renderSetMarkdown),
  ].join("\n");

const summarizeRuns = (runs) => {
  const withDrafts = runs.filter((run) => run.draftCount > 0);
  const drafts = runs.reduce((sum, run) => sum + run.draftCount, 0);
  const retainedDrafts = runs.reduce((sum, run) => sum + run.retainedCount, 0);

  return {
    cases: runs.length,
    clarifications: runs.filter((run) => run.agentMode === "clarification").length,
    correctAnswers: runs.filter((run) => run.correct === true).length,
    wrongAnswers: runs.filter((run) => run.correct === false).length,
    drafts,
    finalMs: { p50: percentile(runs.map((r) => r.finalMs), 50), p95: percentile(runs.map((r) => r.finalMs), 95) },
    firstDraftMs: {
      p50: percentile(withDrafts.map((r) => r.firstDraftMs), 50),
      p95: percentile(withDrafts.map((r) => r.firstDraftMs), 95),
    },
    leadMs: { p50: percentile(withDrafts.map((r) => r.finalMs - r.firstDraftMs), 50) },
    resets: runs.reduce((sum, run) => sum + run.resets, 0),
    retainedDrafts,
    retentionRate: drafts > 0 ? Number(((retainedDrafts / drafts) * 100).toFixed(1)) : null,
    retractedRuns: runs.filter((run) => run.retracted).length,
    retractionCauses: runs.reduce((counts, run) => {
      if (run.retractionCause) counts[run.retractionCause] = (counts[run.retractionCause] ?? 0) + 1;
      return counts;
    }, {}),
    runsWithDrafts: withDrafts.length,
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const arxivCaseCount = Number(option("--cases", "12"));
  const setChoice = option("--set", "all");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "answer-draft-eval-"));

  // As in run-doccompare-verification: storage reads RAG_DATA_DIRECTORY at first
  // import, so it is set before any RAG module loads.
  process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");
  process.env.DOCCOMPARE_STANDALONE = "1";
  Object.assign(process.env, {
    AGENT_SKILL_GRAPH_ROLLOUT: "guarded",
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_LONG_MEMORY_ENABLED: "false",
  });

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();
  const rag = await import("../chat.js");
  const { runAgentRag } = await import("../rag/agent.js");
  const { runWithAgentEventSink } = await import("../rag/agent-event-stream.js");
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
  const arxivCases = pickCases(corpus, arxivCaseCount);
  const sets = [
    ...(setChoice === "arxiv" ? [] : [buildFixtureSet()]),
    ...(setChoice === "fixtures"
      ? []
      : [
          {
            cases: arxivCases.map((testCase) => ({
              docId: testCase.docKeys[0],
              id: testCase.id,
              question: testCase.question,
            })),
            documents: corpus.documents
              .filter((doc) => arxivCases.some((testCase) => testCase.docKeys[0] === doc.key))
              .map((doc) => ({ docId: doc.key, fileName: doc.fileName, pages: doc.pages })),
            name: "arxiv",
          },
        ]),
  ];

  try {
    await rag.initializeDocumentRegistry();
    // The registry keeps a source file per document; the page text stands in
    // for the PDF, as in run-rerank-eval.
    const sourceDirectory = path.join(tempRoot, "sources");
    await mkdir(sourceDirectory, { recursive: true });

    for (const set of sets) {
      console.log(`Ingesting ${set.documents.length} ${set.name} documents with the real embedding model...`);
      for (const doc of set.documents) {
        const filePath = path.join(sourceDirectory, `${doc.docId}.txt`);
        await writeFile(filePath, doc.pages.join("\n\n"), "utf8");
        await rag.ingestDocumentPages({
          docId: doc.docId,
          filePath,
          fileName: doc.fileName,
          pages: doc.pages.map((text, index) => ({ pageNumber: index + 1, text })),
        });
      }
    }

    const ragService = {
      chat: rag.default,
      getDocument: rag.getDocument,
      listDocuments: rag.listDocuments,
    };
    const accessScope = { authenticated: false, userId: "", workspaceId: "" };
    const reportSets = [];

    for (const set of sets) {
      const runs = [];

      for (const testCase of set.cases) {
        const events = [];
        const started = performance.now();
        const response = await runWithAgentEventSink(
          (event) => events.push({ ...event, atMs: performance.now() - started }),
          () =>
            runAgentRag({
              accessScope,
              docIds: [testCase.docId],
              question: testCase.question,
              ragService,
              sessionId: `draft-eval-${testCase.id}`,
              userId: "",
              webChatService: async () => ({ text: "" }),
            })
        );
        const finalMs = Math.round(performance.now() - started);
        const body = response.body ?? {};
        const drafts = [];
        let resets = 0;

        for (const event of events) {
          if (event.type === "answer_draft_reset") {
            drafts.length = 0;
            resets += 1;
          } else if (event.type === "answer_draft") {
            drafts.push(event.draft.text);
          }
        }

        const trace = body.agentTrace ?? [];
        const firstDraft = events.find((event) => event.type === "answer_draft");
        const run = {
          agentMode: body.agentMode,
          finalMs,
          firstDraftMs: firstDraft ? Math.round(firstDraft.atMs) : null,
          id: testCase.id,
          // Only fixture cases know their answer. An answer that states the
          // wrong vendor's value is wrong even if it also states the right one.
          correct:
            testCase.expected && body.agentMode !== "clarification"
              ? testCase.expected.test(body.agentAnswer ?? "") &&
                !testCase.forbidden.test(body.agentAnswer ?? "")
              : null,
          resets,
          ...scoreDraftRun({
            agentMode: body.agentMode,
            drafts,
            finalAnswer: body.agentAnswer,
            finalizerChanged: trace.some(
              (step) => step.type === "answer_finalizer" && step.detail?.changed === true
            ),
            followUp: trace.some((step) => step.type === "follow_up_retrieval"),
          }),
        };
        runs.push(run);
        console.log(
          `${run.id.padEnd(48)} ${String(run.agentMode).padEnd(14)} drafts ${run.draftCount} kept ${run.retainedCount}  first ${run.firstDraftMs ?? "-"}ms  final ${finalMs}ms  ${run.retractionCause ?? ""}`
        );
      }

      reportSets.push({ name: set.name, runs, summary: summarizeRuns(runs) });
    }

    const report = {
      config: {
        chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
        claimJudge: process.env.RAG_CLAIM_JUDGE || "off",
        embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? null,
        promptTemplates: await describePromptTemplates(),
      },
      generatedAt: new Date().toISOString(),
      reportType: "answer-drafts",
      sets: reportSets,
    };

    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, "latest-answer-drafts.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(resultsDirectory, "latest-answer-drafts.md"), renderMarkdown(report));
    console.log(`\n${renderMarkdown(report)}`);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
