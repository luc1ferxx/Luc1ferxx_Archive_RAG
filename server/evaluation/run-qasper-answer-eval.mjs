// run-qasper-answer-eval.mjs
//
// Answer quality on QASPER (questions about NLP papers, answered by
// annotators), scored with the official QASPER answer F1 and without any LLM
// judge: token F1 against every annotator's answer, keeping the best, with an
// abstention scored as "Unanswerable". Also reports how often the system
// abstains on answerable questions, how many unanswerable ones it catches, and
// where the annotated evidence paragraph was: among the pages the answer cites
// ([Source N] labels resolved to citations; cited evidence recall, citation
// precision, no-citation rate), and, as a separate context figure, among the
// pages the model was shown (contextEvidenceRecall, what reports before the
// split called evidenceRecall). The QA path returns every context chunk as a
// citation, so only the label-resolved pages say what the answer cites.
//
// Cases come from a corpus built by import-qasper.mjs (--granularity
// paragraph). A seeded sample is ingested into a throwaway standalone archive
// with the real embedding model, and each question is asked about its own
// paper through one of two surfaces:
//   rag    chat() from chat.js, the document RAG answer MCP archive_ask returns;
//   agent  runAgentRag with the deterministic planners, as /chat runs it.
//
// Token F1 rewards short answers: an answer that restates the question and
// cites its source scores lower than the bare span. Compare runs of this
// system with each other, not with leaderboard numbers of span extractors.
//
// Usage (OpenAI-compatible endpoint, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_CHAT_MODEL=qwen2.5:7b OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   RAG_EMBEDDING_DIMENSIONS=768 node evaluation/run-qasper-answer-eval.mjs
//     [--corpus evaluation/generated/qasper-dev.json] [--cases 200] [--seed 1]
//     [--surface rag|agent] [--latest-name latest-qasper-answers]

import "dotenv/config";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  citedSourcePages,
  qasperAnswerF1,
  scoreQasperEvidence,
  summarizeQasperRuns,
  toQasperPrediction,
} from "./qasper-answer-metrics.js";
import {
  classifyAgentAnswer,
  describeAgentFollowUp,
  isAgentVerdictOverridden,
  summarizeAgentOutcomes,
} from "./agent-answer-outcome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

// mulberry32, so a seed samples the same questions on every run.
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

export const sampleQasperCases = (cases, count, seed) => {
  const random = createSeededRandom(seed);
  const shuffled = [...cases].sort((left, right) => left.id.localeCompare(right.id));

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }

  return shuffled.slice(0, count);
};

// The answer-rate flags this run used (rag/config.js); null on a checkout
// that predates them.
const describeAnswerRateFlags = async () => {
  try {
    const config = await import("../rag/config.js");

    return config.describeAnswerRateFlags?.() ?? null;
  } catch {
    return null;
  }
};

const describePromptTemplates = async () => {
  try {
    const { describeActivePromptTemplates } = await import("../rag/prompt-catalog.js");

    return describeActivePromptTemplates();
  } catch {
    return null;
  }
};

// The rag surface's answer as this eval scores it. contextPages are the pages
// the model was shown (a gate abstention still carries them); citedPages are
// the pages its [Source N] labels name, empty for an abstention.
export const describeRagSurfaceAnswer = (result) => {
  const abstained = Boolean(result?.abstained);

  return {
    abstained,
    // "answer_model" when the model said the evidence does not answer;
    // otherwise an abstention is the confidence gate's.
    abstainSource: abstained ? result.abstainSource ?? "gate" : null,
    citedPages: citedSourcePages({ abstained, citations: result?.citations ?? [], text: result?.text }),
    contextPages: (result?.retrievedContexts ?? []).map((context) => Number(context.pageNumber)),
    text: result?.text,
    verdictOverridden: result?.verdictOverridden === true,
  };
};

// RAG_QA_VERDICT_OVERRIDE: answers given although the answer model opened with
// NOT_IN_EVIDENCE:, split by whether the question was answerable.
const summarizeVerdictOverrides = (rows) => {
  const answered = rows.filter((row) => row.verdictOverridden && !row.abstained);

  return {
    answeredAnswerable: answered.filter((row) => !row.shouldAbstain).length,
    answeredUnanswerable: answered.filter((row) => row.shouldAbstain).length,
  };
};

const formatMarkdown = (report) => {
  const summary = report.summary;

  return [
    "# QASPER answers",
    "",
    `Generated ${report.generatedAt}; surface \`${report.config.surface}\`; chat model ${report.config.chatModel}; ${summary.cases} questions (${summary.unanswerableCases} unanswerable), seed ${report.config.seed}; query adapter ${report.config.queryAdapter ?? "none"}.`,
    "",
    `- Answer F1 (official QASPER, best over annotators): ${summary.answerF1}`,
    `- Cited evidence recall (an evidence paragraph among the pages the answer's [Source N] labels cite; answerable, an abstention cites none): ${summary.citedEvidenceRecall}; among answers actually given: ${summary.citedEvidenceRecallWhenAnswered}`,
    `- Citation precision (share of cited pages holding annotated evidence; answered answerable questions citing a page, n=${summary.citationPrecisionCases}): ${summary.citationPrecision}`,
    `- Answers citing no page (all answered questions): ${summary.noCitationRateWhenAnswered}`,
    `- Context evidence recall (${report.config.surface === "agent" ? "an evidence paragraph among the response's ragSources, cited or not, none for an abstention" : "an evidence paragraph among the pages the model was shown, cited or not; a gate abstention keeps them"}; earlier reports' evidenceRecall): ${summary.contextEvidenceRecall}; among answers actually given: ${summary.contextEvidenceRecallWhenAnswered}`,
    `- Answer F1 on answerable questions it did answer: ${summary.f1WhenAnswered}`,
    `- Abstained on answerable questions: ${summary.answerableAbstainRate}`,
    `- Unanswerable questions caught (abstain recall): ${summary.abstainRecall}; abstentions that were right (precision): ${summary.abstainPrecision}`,
    "",
    ...(summary.agentOutcomes
      ? [
          `- Agent answered (not a clarification or grounded abstention): ${summary.agentOutcomes.answered}/${summary.agentOutcomes.cases}; abstentions by source: ${Object.entries(summary.agentOutcomes.abstainSources).map(([source, n]) => `${source} ${n}`).join(", ") || "none"}; follow-ups run / resolved: ${summary.agentOutcomes.followUpRuns} / ${summary.agentOutcomes.followUpResolved}`,
        ]
      : []),
    `- Answers through the verdict override (RAG_QA_VERDICT_OVERRIDE): answerable ${summary.verdictOverrides?.answeredAnswerable ?? 0}, unanswerable ${summary.verdictOverrides?.answeredUnanswerable ?? 0}`,
    `- Answer-rate flags: ${JSON.stringify(report.config.answerRateFlags ?? null)}; claim judge: ${report.config.claimJudge ?? "off"}`,
    "",
    "| Answer type | Cases | F1 |",
    "|---|---|---|",
    ...Object.entries(summary.answerF1ByType).map(([type, entry]) => `| ${type} | ${entry.cases} | ${entry.f1} |`),
    "",
  ].join("\n");
};

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const corpusPath = path.resolve(process.cwd(), option("--corpus", path.join(__dirname, "generated", "qasper-dev.json")));
  const caseCount = Math.max(1, Number(option("--cases", "200")) || 200);
  const seed = Math.max(1, Number(option("--seed", "1")) || 1);
  const surface = option("--surface", "rag");
  const latestName = option("--latest-name", `latest-qasper-answers${surface === "rag" ? "" : `-${surface}`}`);

  if (!["rag", "agent"].includes(surface)) {
    throw new Error("--surface must be rag or agent.");
  }

  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

  if (corpus.metadata?.granularity !== "paragraph") {
    throw new Error("Build the corpus with import-qasper.mjs --granularity paragraph so evidence is paragraph-level.");
  }

  const cases = sampleQasperCases(corpus.cases, caseCount, seed);
  const docKeys = new Set(cases.flatMap((testCase) => testCase.docKeys));
  const documents = corpus.documents.filter((doc) => docKeys.has(doc.key));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qasper-answer-eval-"));

  // Storage reads RAG_DATA_DIRECTORY at first import (as in the other evals).
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
  const rows = [];

  try {
    await rag.initializeDocumentRegistry();

    const sourceDirectory = path.join(tempRoot, "sources");
    await mkdir(sourceDirectory, { recursive: true });
    console.log(`Ingesting ${documents.length} papers for ${cases.length} questions...`);

    for (const doc of documents) {
      const filePath = path.join(sourceDirectory, `${doc.key}.txt`);

      await writeFile(filePath, doc.pages.join("\n\n"), "utf8");
      await rag.ingestDocumentPages({
        docId: doc.key,
        filePath,
        fileName: doc.fileName,
        pages: doc.pages.map((text, index) => ({ pageNumber: index + 1, text })),
      });
    }

    const accessScope = { authenticated: false, userId: "", workspaceId: "" };
    const ragService = { chat: rag.default, getDocument: rag.getDocument, listDocuments: rag.listDocuments };

    for (const [index, testCase] of cases.entries()) {
      const docId = testCase.docKeys[0];
      let answer;

      if (surface === "rag") {
        const result = await rag.default([docId], testCase.question, {
          accessScope,
          includeRetrievedContexts: true,
          sessionId: `qasper-${testCase.id}`,
        });

        answer = describeRagSurfaceAnswer(result);
      } else {
        const response = await runAgentRag({
          accessScope,
          docIds: [docId],
          question: testCase.question,
          ragService,
          sessionId: `qasper-agent-${testCase.id}`,
          userId: "",
          webChatService: async () => ({ text: "" }),
        });
        const body = response.body ?? {};
        // A clarification and the grounded abstention sentence are both
        // abstentions (agent-answer-outcome.js).
        const outcome = classifyAgentAnswer(body);
        // The finalizer projects ragSources and rebases the answer's labels to
        // them, so the labels resolve against ragSources as on the rag surface.
        const sources = body.ragSources ?? body.citations ?? [];

        answer = {
          abstained: !outcome.answered,
          abstainSource: outcome.abstainSource,
          agent: { ...outcome, ...describeAgentFollowUp(body) },
          // The agent body carries its cited sources as ragSources; it has no
          // citations field, so reading that gave every agent row no pages.
          // An abstention counts as returning no sources. contextPages keeps
          // the figure earlier agent reports called evidenceRecall.
          citedPages: citedSourcePages({ abstained: !outcome.answered, citations: sources, text: body.agentAnswer }),
          contextPages: outcome.answered ? sources.map((citation) => Number(citation.pageNumber)) : [],
          text: body.agentAnswer,
          verdictOverridden: isAgentVerdictOverridden(body),
        };
      }

      const prediction = toQasperPrediction(answer);
      const evidence = scoreQasperEvidence({
        abstained: answer.abstained,
        citedPages: answer.citedPages,
        contextPages: answer.contextPages,
        expectedPages: testCase.expectedEvidence?.[0]?.pages ?? [],
        shouldAbstain: testCase.shouldAbstain,
      });
      const row = {
        abstained: answer.abstained,
        abstainSource: answer.abstainSource ?? null,
        ...(answer.agent ?? {}),
        answerType: testCase.answerType,
        citationPrecision: evidence.citationPrecision,
        citedEvidenceHit: evidence.citedEvidenceHit,
        citedPages: answer.citedPages,
        contextEvidenceHit: evidence.contextEvidenceHit,
        f1: Number(qasperAnswerF1(prediction, testCase.referenceAnswers ?? []).toFixed(4)),
        id: testCase.id,
        prediction: prediction.slice(0, 400),
        references: testCase.referenceAnswers,
        shouldAbstain: Boolean(testCase.shouldAbstain),
        verdictOverridden: answer.verdictOverridden === true,
      };

      rows.push(row);
      console.log(
        `${String(index + 1).padStart(3)}/${cases.length} ${row.answerType?.padEnd(11)} f1=${row.f1.toFixed(2)} abstained=${row.abstained} cited=${row.citedEvidenceHit} context=${row.contextEvidenceHit}`
      );
    }
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }

  const { getQueryAdapterReportFingerprint } = await import("../rag/query-adapter.js");
  const report = {
    config: {
      answerRateFlags: await describeAnswerRateFlags(),
      cases: caseCount,
      chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
      claimJudge: process.env.RAG_CLAIM_JUDGE || "off",
      corpus: path.basename(corpusPath),
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? null,
      promptTemplates: await describePromptTemplates(),
      // RAG_EMBEDDING_QUERY_ADAPTER reorders the QA route's dense candidates.
      queryAdapter: getQueryAdapterReportFingerprint(),
      seed,
      surface,
    },
    generatedAt: new Date().toISOString(),
    reportType: "qasper-answers",
    rows,
    summary: {
      ...summarizeQasperRuns(rows),
      ...(surface === "agent" ? { agentOutcomes: summarizeAgentOutcomes(rows) } : {}),
      verdictOverrides: summarizeVerdictOverrides(rows),
    },
  };

  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDirectory, `${latestName}.md`), formatMarkdown(report));
  process.stdout.write(formatMarkdown(report));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
