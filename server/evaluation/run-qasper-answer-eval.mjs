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
//   agent  runAgentRag with the four planners /chat builds (app-services.js):
//          AGENT_PLANNER_ROLLOUT unset or llm plans with the model, falling
//          back to the rules, and deterministic with the rules alone. Reports
//          without config.plannerRollout ran the deterministic planners
//          whatever AGENT_PLANNER_ROLLOUT said.
//
// Token F1 rewards short answers: an answer that restates the question and
// cites its source scores lower than the bare span. Compare runs of this
// system with each other, not with leaderboard numbers of span extractors.
//
// The report records the chunking settings and the commit it ran with
// (config.chunking, config.git; eval-run-config.js), and on the rag surface
// each row's contextChars, the characters of chunk text the answer model was
// given (null on the agent surface, whose body carries no context text).
//
// On the agent surface each row also carries checks, one per self_check step
// of the trace (phase primary, follow_up or final): the answer text the check
// read, the claim judge's summary (null without the judge) and, for each claim
// it rejected, the check's own fields and the cited sources' text as the check
// compared it (describeAgentChecks in agent-answer-outcome.js). The .md report
// counts the checks by judge status, those claims by failure field and the
// failed checks by reason.
//
// The agent surface also records its planners: config.plannerRollout (null on
// the rag surface, which plans nothing) and, per row, planners: whether the
// intent, execution and custom-Skill graph (dag) planners fell back to the
// rules and why, and the graph's replans (describeAgentPlanners). The .md
// report gives each planner's fallback rate and the fallback reasons.
//
// Two runs over the same sample can be compared question by question:
// --compare <other report.json> adds a paired bootstrap block (this run minus
// that one; compare-qasper-answer-reports.mjs does the same for two saved
// reports). --exclude-report <report.json> takes that report's questions out
// of the corpus before sampling, so a confirmation sample shares no question
// with the sample a candidate was tuned on; the report records what was
// excluded. Given more than once, it takes out every listed report's
// questions. --list-cases prints the sample and exits before anything is
// ingested, so a sample can be checked without a model. Each row also carries
// f1DashNormalized, the official F1 after folding dash variants to a hyphen:
// a diagnostic, never a summary figure or a decision rule.
//
// Usage (OpenAI-compatible endpoint, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_CHAT_MODEL=qwen2.5:7b OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   RAG_EMBEDDING_DIMENSIONS=768 node evaluation/run-qasper-answer-eval.mjs
//     [--corpus evaluation/generated/qasper-dev.json] [--cases 200] [--seed 1]
//     [--surface rag|agent] [--latest-name latest-qasper-answers]
//     [--compare <report.json>] [--exclude-report <report.json>]... [--list-cases]

import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  citedSourcePages,
  qasperAnswerF1,
  qasperAnswerF1DashNormalized,
  scoreQasperEvidence,
  summarizeQasperRuns,
  toQasperDirectPrediction,
  toQasperPrediction,
} from "./qasper-answer-metrics.js";
import {
  classifyAgentAnswer,
  describeAgentChecks,
  describeAgentFollowUp,
  describeAgentPlanners,
  isAgentAnswerTruncated,
  summarizeAgentChecks,
  summarizeAgentOutcomes,
  summarizeAgentPlanners,
} from "./agent-answer-outcome.js";
import {
  compareQasperAnswerReports,
  formatComparisonMarkdown,
  readQasperAnswerReport,
} from "./compare-qasper-answer-reports.mjs";
import {
  describeChunkingConfig,
  describeEvaluationCheckout,
  describeRetrievalConfig,
  sumTextChars,
} from "./eval-run-config.js";
import { useEvaluationDataDirectory } from "./eval-data-directory.mjs";
import { createSeededRandom } from "./paired-bootstrap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

export const sampleQasperCases = (cases, count, seed) => {
  const random = createSeededRandom(seed);
  const shuffled = [...cases].sort((left, right) => left.id.localeCompare(right.id));

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }

  return shuffled.slice(0, count);
};

/**
 * The corpus cases without the questions another report ran, plus what the
 * report records about the exclusion: the report's name, when it was made,
 * the commit it ran on, how many corpus questions it removed and a digest of
 * their sorted ids, so a "clean" sample can be audited.
 */
export const excludeReportCases = (cases, report, { reportName }) => {
  const reportIds = new Set((report?.rows ?? []).map((row) => row.id));
  const removedIds = cases
    .map((testCase) => testCase.id)
    .filter((id) => reportIds.has(id))
    .sort();

  return {
    cases: cases.filter((testCase) => !reportIds.has(testCase.id)),
    excluded: {
      report: reportName,
      generatedAt: report?.generatedAt ?? null,
      gitSha: report?.config?.git?.sha ?? null,
      excludedIds: removedIds.length,
      excludedIdsDigest: createHash("sha256").update(removedIds.join("\n")).digest("hex"),
    },
  };
};

/**
 * The corpus cases without the questions of any of several reports. One report
 * is recorded as excludeReportCases records it; several are recorded each on
 * its own (what it alone would remove) under `reports`, with the count and
 * digest of the union actually removed beside them.
 */
export const excludeReportsCases = (cases, reports) => {
  if (reports.length === 1) {
    return excludeReportCases(cases, reports[0].report, { reportName: reports[0].reportName });
  }

  const reportIds = new Set(reports.flatMap(({ report }) => (report?.rows ?? []).map((row) => row.id)));
  const removedIds = cases
    .map((testCase) => testCase.id)
    .filter((id) => reportIds.has(id))
    .sort();

  return {
    cases: cases.filter((testCase) => !reportIds.has(testCase.id)),
    excluded: {
      reports: reports.map(({ report, reportName }) => excludeReportCases(cases, report, { reportName }).excluded),
      excludedIds: removedIds.length,
      excludedIdsDigest: createHash("sha256").update(removedIds.join("\n")).digest("hex"),
    },
  };
};

/** The excluded report's name, or each report's name with what it removed. */
export const describeExcludedReports = (excluded, quote = (name) => name) =>
  excluded.reports
    ? excluded.reports.map((entry) => `${quote(entry.report)} (${entry.excludedIds})`).join(", ")
    : quote(excluded.report);

/** What a sample holds, for --list-cases: counts, papers and the ids. */
export const describeSampledCases = (cases) => ({
  cases: cases.length,
  answerable: cases.filter((testCase) => !testCase.shouldAbstain).length,
  unanswerable: cases.filter((testCase) => Boolean(testCase.shouldAbstain)).length,
  papers: new Set(cases.flatMap((testCase) => testCase.docKeys ?? [])).size,
  ids: cases.map((testCase) => testCase.id),
});

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
// the model was shown (none for a gate abstention, which shows the model
// nothing); citedPages are
// the pages its [Source N] labels name, empty for an abstention; contextChars
// is the chunk text of those contexts, in characters.
export const describeRagSurfaceAnswer = (result) => {
  const abstained = Boolean(result?.abstained);

  return {
    abstained,
    // "output_limit" when an output limit cut the reply before it wrote
    // anything; otherwise an abstention is the confidence gate's.
    abstainSource: abstained ? result.abstainSource ?? "gate" : null,
    // An output limit (RAG_ANSWER_MAX_TOKENS, or the endpoint's own) cut the
    // answer model's reply off.
    answerTruncated: result?.answerTruncated === true,
    citedPages: citedSourcePages({ abstained, citations: result?.citations ?? [], text: result?.text }),
    contextChars: sumTextChars(result?.retrievedContexts, (context) => context?.text),
    contextPages: (result?.retrievedContexts ?? []).map((context) => Number(context.pageNumber)),
    text: result?.text,
  };
};

// The agent surface's answer as this eval scores it, from runAgentRag's body.
// ragReplies are the run's document RAG replies in call order, each
// { question, value }; the row's checks pair them with the trace's
// self-checks (describeAgentChecks). graphEvents are the payloads of the run's
// skill_graph_planned events, read for its planners (describeAgentPlanners).
export const describeAgentSurfaceAnswer = (body = {}, ragReplies = [], graphEvents = []) => {
  // A clarification and the grounded abstention sentence are both
  // abstentions (agent-answer-outcome.js).
  const outcome = classifyAgentAnswer(body);
  // The finalizer projects ragSources and rebases the answer's labels to
  // them, so the labels resolve against ragSources as on the rag surface.
  const sources = body.ragSources ?? body.citations ?? [];

  return {
    abstained: !outcome.answered,
    abstainSource: outcome.abstainSource,
    agent: {
      ...outcome,
      ...describeAgentFollowUp(body),
      checks: describeAgentChecks(body, ragReplies),
      planners: describeAgentPlanners(body, graphEvents),
    },
    answerTruncated: isAgentAnswerTruncated(body),
    // The agent body carries its cited sources as ragSources; it has no
    // citations field, so reading that gave every agent row no pages.
    // An abstention counts as returning no sources. contextPages keeps
    // the figure earlier agent reports called evidenceRecall.
    citedPages: citedSourcePages({ abstained: !outcome.answered, citations: sources, text: body.agentAnswer }),
    contextChars: null,
    contextPages: outcome.answered ? sources.map((citation) => Number(citation.pageNumber)) : [],
    text: body.agentAnswer,
  };
};

/**
 * The four planners /chat runs with, built as createAppServices builds them
 * for buildChatResponse (app-services.js): AGENT_PLANNER_ROLLOUT picks the
 * model (llm, the default) or the rules (deterministic, which has no
 * replanner); a removed value or a typo throws. Imported here, not at the top:
 * app-services.js loads chat.js, whose storage reads RAG_DATA_DIRECTORY at
 * first import.
 */
export const createAgentSurfacePlanners = async () => {
  const appServices = await import("../app-services.js");
  const dagPlannerAdapter = appServices.createDagPlannerAdapter();

  return {
    dagPlannerAdapter,
    executionPlannerAdapter: appServices.createExecutionPlannerAdapter(),
    intentPlannerAdapter: appServices.createIntentPlannerAdapter(),
    replanAdapter: appServices.createReplanAdapter(dagPlannerAdapter),
  };
};

/** One question on the agent surface: runAgentRag with `planners`, scored by describeAgentSurfaceAnswer. */
export const askAgentSurface = async ({ accessScope, docId, planners, question, ragService, runAgentRag, sessionId }) => {
  // Every reply the document RAG gave this run, in call order: the
  // self-check read its text, citations and retrieved chunks, which
  // neither the trace nor the body keeps.
  const ragReplies = [];
  // The graph planner's decision and the replans travel only in the run's
  // skill_graph_planned event. The run service records events alone: with no
  // createRun the run has no id, so nothing else is written.
  const graphEvents = [];
  const response = await runAgentRag({
    ...planners,
    accessScope,
    agentRunService: {
      appendRunEvent: ({ payload, type }) => {
        if (type === "skill_graph_planned") {
          graphEvents.push(payload);
        }
      },
    },
    docIds: [docId],
    question,
    ragService: {
      ...ragService,
      chat: async (...args) => {
        const reply = { question: args[1], value: null };

        ragReplies.push(reply);
        reply.value = await ragService.chat(...args);
        return reply.value;
      },
    },
    sessionId,
    userId: "",
    webChatService: async () => ({ text: "" }),
  });

  return describeAgentSurfaceAnswer(response.body ?? {}, ragReplies, graphEvents);
};

/**
 * Questions whose answer model reply an output limit cut off
 * (RAG_ANSWER_MAX_TOKENS, or the endpoint's own), split by whether the
 * question was answerable. A row from before the field counts as not cut.
 */
export const summarizeAnswerTruncations = (rows) => {
  const truncated = rows.filter((row) => row.answerTruncated === true);

  return {
    answerable: truncated.filter((row) => !row.shouldAbstain).length,
    unanswerable: truncated.filter((row) => row.shouldAbstain).length,
  };
};

// The output limit the run sent (RAG_ANSWER_MAX_TOKENS) and the field it
// travelled in (RAG_LLM_MAX_TOKENS_FIELD); both null when it sent none. Through
// a model gateway the gateway's own setting picks the field, which this
// process cannot read, so it is recorded as "model_gateway".
export const describeAnswerOutputLimit = (
  { getAnswerMaxTokens, getLlmMaxTokensField },
  { routedToGateway = false } = {}
) => {
  const maxTokens = getAnswerMaxTokens();

  return {
    answerMaxTokens: maxTokens,
    answerMaxTokensField: maxTokens === null ? null : routedToGateway ? "model_gateway" : getLlmMaxTokensField(),
  };
};

// The agent's self-checks (summarizeAgentChecks): why it rejected its answers.
const formatAgentChecks = (agentChecks) => [
  `Agent self-checks (every self_check step of every row; ${
    Object.entries(agentChecks.phases).map(([phase, n]) => `${phase} ${n}`).join(", ") || "none"
  }): ${agentChecks.failedChecks} of ${agentChecks.checks} failed, with ${agentChecks.unsupportedClaims} unsupported claims. A claim counts once under each failure field or code it carries. Checks by claim judge status: ${
    Object.entries(agentChecks.judgeStatuses).map(([status, n]) => `${status} ${n}`).join(", ") || "none"
  }.`,
  "",
  "| Unsupported claims by failure field: code | Claims | Rows |",
  "|---|---|---|",
  ...agentChecks.claimFailures.map(({ claims, failure, rows }) => `| ${failure} | ${claims} | ${rows} |`),
  "",
  "| Failed checks by reason | Checks | Rows |",
  "|---|---|---|",
  ...agentChecks.failedCheckReasons.map(({ checks, reason, rows }) => `| ${reason} | ${checks} | ${rows} |`),
  "",
];

const PLANNER_NAMES = ["intent", "execution", "dag"];

// The agent's planners (summarizeAgentPlanners): how often each fell back to
// the rules, and why. A reason is planner text, so a pipe in it is escaped.
export const formatAgentPlanners = (planners, plannerRollout) => [
  `Agent planners (AGENT_PLANNER_ROLLOUT ${plannerRollout}; a planner that fell back planned with the rules, and a custom-Skill graph rejected whole counts as fallen back; dag counts only the rows that planned a graph). Replans considered in ${planners.replans.considered} rows, applied in ${planners.replans.applied}; not applied by reason: ${
    planners.replans.notApplied.map(({ reason, rows }) => `${reason} ${rows}`).join(", ") || "none"
  }.`,
  "",
  "| Planner | Ran | Selected | Fell back | Fallback rate |",
  "|---|---|---|---|---|",
  ...PLANNER_NAMES.map((name) => {
    const { fallback, fallbackRate, ran, selected } = planners[name];

    return `| ${name} | ${ran} | ${selected} | ${fallback} | ${fallbackRate ?? "–"} |`;
  }),
  "",
  "| Planner | Fallback reason | Rows |",
  "|---|---|---|",
  ...PLANNER_NAMES.flatMap((name) =>
    planners[name].fallbackReasons.map(({ reason, rows }) => `| ${name} | ${reason.replaceAll("|", "\\|")} | ${rows} |`)
  ),
  "",
];

const formatMarkdown = (report) => {
  const summary = report.summary;

  return [
    "# QASPER answers",
    "",
    `Generated ${report.generatedAt}; surface \`${report.config.surface}\`; chat model ${report.config.chatModel}; ${summary.cases} questions (${summary.unanswerableCases} unanswerable), seed ${report.config.seed}; query adapter ${report.config.queryAdapter ?? "none"}.`,
    "",
    `- Answer F1 (official QASPER, best over annotators): ${summary.answerF1}`,
    `- Answer F1 of the short answer (the first sentence; not the official figure): ${summary.answerF1Direct}; among answerable questions it answered: ${summary.answerF1DirectWhenAnswered}`,
    `- Cited evidence recall (an evidence paragraph among the pages the answer's [Source N] labels cite; answerable, an abstention cites none): ${summary.citedEvidenceRecall}; among answers actually given: ${summary.citedEvidenceRecallWhenAnswered}`,
    `- Citation precision (share of cited pages holding annotated evidence; answered answerable questions citing a page, n=${summary.citationPrecisionCases}): ${summary.citationPrecision}`,
    `- Answers citing no page (all answered questions): ${summary.noCitationRateWhenAnswered}`,
    `- Context evidence recall (${report.config.surface === "agent" ? "an evidence paragraph among the response's ragSources, cited or not, none for an abstention" : "an evidence paragraph among the pages the model was shown, cited or not; a gate abstention shows none, so it counts as a miss"}; earlier reports' evidenceRecall): ${summary.contextEvidenceRecall}; among answers actually given: ${summary.contextEvidenceRecallWhenAnswered}`,
    `- Answer F1 on answerable questions it did answer: ${summary.f1WhenAnswered}`,
    `- Abstained on answerable questions: ${summary.answerableAbstainRate}`,
    `- Unanswerable questions caught (abstain recall): ${summary.abstainRecall}; abstentions that were right (precision): ${summary.abstainPrecision}`,
    "",
    ...(summary.agentOutcomes
      ? [
          `- Agent answered (not a clarification or grounded abstention): ${summary.agentOutcomes.answered}/${summary.agentOutcomes.cases}; abstentions by source: ${Object.entries(summary.agentOutcomes.abstainSources).map(([source, n]) => `${source} ${n}`).join(", ") || "none"}; follow-ups run / resolved: ${summary.agentOutcomes.followUpRuns} / ${summary.agentOutcomes.followUpResolved}`,
        ]
      : []),
    `- Answer replies cut off at an output limit: answerable ${summary.answerTruncations?.answerable ?? 0}, unanswerable ${summary.answerTruncations?.unanswerable ?? 0}`,
    `- Answer-rate flags: ${JSON.stringify(report.config.answerRateFlags ?? null)}; claim judge: ${report.config.claimJudge ?? "off"}; answer temperature: ${report.config.answerTemperature ?? "not sent (the endpoint's default)"}; answer output limit: ${
      report.config.answerMaxTokens ? `${report.config.answerMaxTokens} tokens (${report.config.answerMaxTokensField})` : "not sent (the endpoint's own)"
    }`,
    ...(report.config.excluded
      ? [
          `- Sampled after excluding the ${report.config.excluded.excludedIds} questions of ${describeExcludedReports(report.config.excluded, (name) => "`" + name + "`")} (ids digest ${report.config.excluded.excludedIdsDigest.slice(0, 12)})`,
        ]
      : []),
    "",
    "| Answer type | Cases | F1 |",
    "|---|---|---|",
    ...Object.entries(summary.answerF1ByType).map(([type, entry]) => `| ${type} | ${entry.cases} | ${entry.f1} |`),
    "",
    ...(summary.agentPlanners ? formatAgentPlanners(summary.agentPlanners, report.config.plannerRollout) : []),
    ...(summary.agentChecks ? formatAgentChecks(summary.agentChecks) : []),
    ...(report.comparison ? formatComparisonMarkdown(report.comparison) : []),
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
  const comparePath = option("--compare", null);
  // Repeatable; a path given twice counts once.
  const excludeReportPaths = [
    ...new Set(args.flatMap((arg, index) => (arg === "--exclude-report" ? [args[index + 1]] : []))),
  ];
  const listCases = args.includes("--list-cases");

  if (!["rag", "agent"].includes(surface)) {
    throw new Error("--surface must be rag or agent.");
  }

  if (excludeReportPaths.some((reportPath) => !reportPath || reportPath.startsWith("--"))) {
    throw new Error("--exclude-report needs a report path.");
  }

  // Every report is read before anything runs, so a wrong path fails fast.
  const other = comparePath ? await readQasperAnswerReport(comparePath) : null;
  const excludedReports = [];

  for (const reportPath of excludeReportPaths) {
    excludedReports.push({ report: await readQasperAnswerReport(reportPath), reportName: path.basename(reportPath) });
  }

  let corpus;

  try {
    corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  } catch (error) {
    throw new Error(`${corpusPath}: ${error.message}`);
  }

  // The checkout, before the run writes anything.
  const git = await describeEvaluationCheckout();

  if (corpus.metadata?.granularity !== "paragraph") {
    throw new Error("Build the corpus with import-qasper.mjs --granularity paragraph so evidence is paragraph-level.");
  }

  const { cases: candidateCases, excluded } =
    excludedReports.length > 0
      ? excludeReportsCases(corpus.cases, excludedReports)
      : { cases: corpus.cases, excluded: null };

  for (const entry of excluded ? (excluded.reports ?? [excluded]) : []) {
    if (entry.excludedIds === 0) {
      console.warn(`${entry.report} shares no question id with the corpus; is it the right report, or the right corpus?`);
    }
  }

  const cases = sampleQasperCases(candidateCases, caseCount, seed);

  if (cases.length === 0) {
    throw new Error(
      excluded
        ? `No question is left to sample after excluding the ${excluded.excludedIds} questions of ${describeExcludedReports(excluded)}.`
        : "The corpus has no cases."
    );
  }

  if (cases.length < caseCount) {
    console.warn(`Only ${cases.length} questions could be sampled, not ${caseCount}; the report's summary counts the ${cases.length}.`);
  }

  if (listCases) {
    const sample = describeSampledCases(cases);

    console.log(
      `${sample.cases} questions (${sample.answerable} answerable, ${sample.unanswerable} unanswerable) from ${sample.papers} papers; seed ${seed}${
        excluded ? `; excluding the ${excluded.excludedIds} questions of ${describeExcludedReports(excluded)}` : ""
      }`
    );
    console.log(sample.ids.join("\n"));
    return;
  }

  // A paired comparison needs the same sample; refuse before the model runs
  // when the other report shares no question with this one.
  if (other) {
    const otherIds = new Set(other.rows.map((row) => row.id));

    if (!cases.some((testCase) => otherIds.has(testCase.id))) {
      throw new Error(`${comparePath} shares no question id with this sample; --compare needs the same corpus, --cases and --seed.`);
    }
  }

  const docKeys = new Set(cases.flatMap((testCase) => testCase.docKeys));
  const documents = corpus.documents.filter((doc) => docKeys.has(doc.key));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qasper-answer-eval-"));

  // Storage reads RAG_DATA_DIRECTORY at first import (as in the other evals).
  useEvaluationDataDirectory(path.join(tempRoot, "rag-data"));
  process.env.DOCCOMPARE_STANDALONE = "1";
  Object.assign(process.env, {
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_LONG_MEMORY_ENABLED: "false",
  });

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();
  const rag = await import("../chat.js");
  const { runAgentRag } = await import("../rag/agent.js");
  const ragConfig = await import("../rag/config.js");
  const { isModelCallRoutedToGateway } = await import("../rag/openai.js");
  // Read once, before anything is ingested: a wrong value stops the run here
  // instead of failing every answer call (on the agent surface the run would
  // carry on to the end and only then fail to write its report).
  const answerGeneration = {
    ...describeAnswerOutputLimit(ragConfig, { routedToGateway: isModelCallRoutedToGateway() }),
    answerTemperature: ragConfig.getAnswerTemperature(),
  };
  // The planners /chat runs with, read before anything is ingested too: a
  // removed or mistyped AGENT_PLANNER_ROLLOUT stops the run here.
  const plannerRollout = surface === "agent" ? ragConfig.getAgentPlannerRollout() : null;
  const planners = plannerRollout ? await createAgentSurfacePlanners() : null;
  const rows = [];

  try {
    await rag.initializeDocumentRegistry();

    const sourceDirectory = path.join(tempRoot, "sources");
    await mkdir(sourceDirectory, { recursive: true });
    console.log(`Ingesting ${documents.length} papers for ${cases.length} questions...`);

    for (const doc of documents) {
      const filePath = path.join(sourceDirectory, `${doc.key}.txt`);

      await writeFile(filePath, doc.pages.join("\n\n"), "utf8");

      // A local embedding server can restart its runner mid-run and report
      // it as a 400; a long ingest should not be lost to one such blip.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await rag.ingestDocumentPages({
            docId: doc.key,
            filePath,
            fileName: doc.fileName,
            pages: doc.pages.map((text, index) => ({ pageNumber: index + 1, text })),
          });
          break;
        } catch (error) {
          if (attempt >= 3) {
            throw error;
          }

          console.warn(`ingest ${doc.key} failed (${error.message}); retrying`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
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
        answer = await askAgentSurface({
          accessScope,
          docId,
          planners,
          question: testCase.question,
          ragService,
          runAgentRag,
          sessionId: `qasper-agent-${testCase.id}`,
        });
      }

      const prediction = toQasperPrediction(answer);
      const evidence = scoreQasperEvidence({
        abstained: answer.abstained,
        citedPages: answer.citedPages,
        contextPages: answer.contextPages,
        expectedPages: testCase.expectedEvidence?.[0]?.pages ?? [],
        shouldAbstain: testCase.shouldAbstain,
      });
      const references = testCase.referenceAnswers ?? [];
      // The official F1 of a prediction string, best over the annotators.
      const score = (text) => Number(qasperAnswerF1(text, references).toFixed(4));
      const row = {
        abstained: answer.abstained,
        abstainSource: answer.abstainSource ?? null,
        ...(answer.agent ?? {}),
        answerTruncated: answer.answerTruncated === true,
        answerType: testCase.answerType,
        citationPrecision: evidence.citationPrecision,
        citedEvidenceHit: evidence.citedEvidenceHit,
        citedPages: answer.citedPages,
        contextChars: answer.contextChars ?? null,
        contextEvidenceHit: evidence.contextEvidenceHit,
        f1: score(prediction),
        f1DashNormalized: Number(qasperAnswerF1DashNormalized(prediction, references).toFixed(4)),
        // The short-answer score: the first sentence.
        f1Direct: score(toQasperDirectPrediction(answer)),
        id: testCase.id,
        // Whole since 2026-11-10 (cut at 400 characters before), so a person
        // can label what was scored (build-answer-labeling.mjs).
        prediction,
        references: testCase.referenceAnswers,
        shouldAbstain: Boolean(testCase.shouldAbstain),
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
  const { getEmbeddingModel } = ragConfig;
  const config = {
    // RAG_ANSWER_MAX_TOKENS and the field it went in (null: no limit sent), and
    // RAG_ANSWER_TEMPERATURE (null: none sent, the endpoint's default applied),
    // as read before the run.
    answerMaxTokens: answerGeneration.answerMaxTokens,
    answerMaxTokensField: answerGeneration.answerMaxTokensField,
    answerRateFlags: await describeAnswerRateFlags(),
    answerTemperature: answerGeneration.answerTemperature,
    cases: caseCount,
    chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
    chunking: await describeChunkingConfig(),
    claimJudge: ragConfig.getClaimJudgeMode(),
    corpus: path.basename(corpusPath),
    // The model the run embedded with (the default when the variable is unset), as
    // eval:qasper-retrieval records it, so the two kinds of report can be compared.
    embeddingModel: getEmbeddingModel(),
    ...(excluded ? { excluded } : {}),
    git,
    // AGENT_PLANNER_ROLLOUT as the agent surface's planners were built for it
    // (llm or deterministic); null on the rag surface, which plans nothing.
    plannerRollout,
    promptTemplates: await describePromptTemplates(),
    // RAG_EMBEDDING_QUERY_ADAPTER reorders the QA route's dense candidates.
    queryAdapter: getQueryAdapterReportFingerprint(),
    // Every retrieval setting of the QA route (top-K, pools, fusion, gate
    // floors, ...): two answer runs that differ there show it in --compare.
    retrieval: await describeRetrievalConfig(),
    seed,
    surface,
  };
  const report = {
    config,
    ...(other
      ? {
          comparison: compareQasperAnswerReports({ config, rows }, other, {
            against: path.basename(comparePath),
          }),
        }
      : {}),
    generatedAt: new Date().toISOString(),
    reportType: "qasper-answers",
    rows,
    summary: {
      ...summarizeQasperRuns(rows),
      ...(surface === "agent"
        ? {
            agentChecks: summarizeAgentChecks(rows),
            agentOutcomes: summarizeAgentOutcomes(rows),
            agentPlanners: summarizeAgentPlanners(rows),
          }
        : {}),
      answerTruncations: summarizeAnswerTruncations(rows),
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
