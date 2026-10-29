// compare-qasper-answer-reports.mjs
//
// Two qasper-answers reports (run-qasper-answer-eval.mjs) over the same
// questions, compared question by question with a paired bootstrap: this
// report minus the other, over the questions both reports hold. The
// intervals the evaluation notes used to compute with one-off scripts come
// from here now, and `--compare` of the answer runner writes the same block
// into its report. Only ids, flags and scores are read, never a prediction.
//
// Usage:
//   node evaluation/compare-qasper-answer-reports.mjs <this report.json> <other report.json>
//     [--iterations 10000] [--seed 12345]

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getArgValue } from "./eval-cli.js";
import { describeRunConfigDifferences } from "./eval-run-config.js";
import { pairedDeltaOfDiffs } from "./paired-bootstrap.js";
import { readContextEvidenceHit, readF1Direct } from "./qasper-answer-metrics.js";

export const DEFAULT_COMPARE_ITERATIONS = 10000;
export const DEFAULT_COMPARE_SEED = 12345;

// Whether a row answered: the agent surface says so (classifyAgentAnswer: a
// clarification or the grounded abstention is no answer); the rag surface
// answered unless it abstained.
export const readAnswered = (row) =>
  typeof row?.answered === "boolean" ? row.answered : !row?.abstained;

// The config fields two answer runs are compared on, each with its reader: the
// scalar settings, the answer-rate flags and the prompt set (a prompt version
// is this project's usual A/B, and RAG_QA_ANSWER_VERDICT shows only there).
const COMPARED_CONFIG_FIELDS = Object.freeze([
  ...["surface", "corpus", "chatModel", "embeddingModel", "queryAdapter", "claimJudge", "cases", "seed", "answerRateFlags"].map(
    (field) => [field, (config) => config?.[field]]
  ),
  ["promptTemplates.setHash", (config) => config?.promptTemplates?.setHash],
]);

/**
 * The config fields two answer runs differ in, or cannot be shown to match
 * (a missing value counts as different): the fields above, then the chunking
 * and commit fields describeRunConfigDifferences compares for the retrieval
 * eval (a report without them counts as unknown).
 */
export const describeAnswerRunDifferences = (config = {}, otherConfig = {}) => [
  ...COMPARED_CONFIG_FIELDS.flatMap(([field, read]) => {
    const current = read(config) ?? null;
    const other = read(otherConfig) ?? null;

    return JSON.stringify(current) === JSON.stringify(other) ? [] : [{ current, field, other }];
  }),
  ...describeRunConfigDifferences(config ?? {}, otherConfig ?? {}),
];

/**
 * Refuses rows the comparison cannot pair honestly: every row needs an id
 * that is unique within its report and a finite f1. The runner always writes
 * both; a hand-made report may not.
 */
export const assertComparableRows = (rows, label) => {
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.id !== "string" || row.id.length === 0) {
      throw new Error(`${label}: every row needs a string id.`);
    }

    if (seen.has(row.id)) {
      throw new Error(`${label}: row id ${row.id} appears more than once.`);
    }

    seen.add(row.id);

    if (!Number.isFinite(Number(row.f1))) {
      throw new Error(`${label}: row ${row.id} has no finite f1.`);
    }
  }
};

/**
 * This report minus the other, paired by question id. Each metric draws its
 * own interval from the same seed. The evidence metrics are over the
 * answerable questions where both reports recorded them (an older report's
 * evidenceHit is read as the context figure, never as the cited one).
 */
export const compareQasperAnswerReports = (
  report,
  other,
  { against = null, iterations = DEFAULT_COMPARE_ITERATIONS, seed = DEFAULT_COMPARE_SEED } = {}
) => {
  assertComparableRows(report?.rows, "this report");
  assertComparableRows(other?.rows, "the other report");

  const otherRows = new Map((other?.rows ?? []).map((row) => [row.id, row]));
  const pairs = (report?.rows ?? [])
    .filter((row) => otherRows.has(row.id))
    .map((row) => [row, otherRows.get(row.id)]);
  const answerable = pairs.filter(([row]) => !row.shouldAbstain);
  const unanswerable = pairs.filter(([row]) => row.shouldAbstain);
  const delta = (subset, value) =>
    pairedDeltaOfDiffs(
      subset.map(([left, right]) => value(left) - value(right)),
      { iterations, seed }
    );
  const f1 = (row) => Number(row.f1) || 0;
  // The official score of an abstention is its F1 as "Unanswerable", which
  // is 1 when one annotator found the question unanswerable; on the
  // answerable subset an abstention counts as 0 instead, as the evaluation
  // notes' F1(abstain=0).
  const f1AbstainZero = (row) => (readAnswered(row) ? f1(row) : 0);
  // The short-answer score (f1Direct, reports since 2026-10-22), same rule.
  const f1Direct = (row) => readF1Direct(row) ?? 0;
  const f1DirectAbstainZero = (row) => (readAnswered(row) ? f1Direct(row) : 0);
  const answered = (row) => (readAnswered(row) ? 1 : 0);
  // The pairs whose both rows recorded a value (an older report may not have).
  const whereBoth = (subset, read, holds) =>
    subset.filter(([left, right]) => holds(read(left)) && holds(read(right)));
  const isBoolean = (value) => typeof value === "boolean";
  const isScore = (value) => Number.isFinite(value);
  const readCited = (row) => row.citedEvidenceHit;
  // The answerable questions both runs answered: the model's score on the
  // same questions, free of the composition change an answer-rate shift
  // brings to the figures above; and the characters of context it read
  // there (what a retrieval setting costs per answer, paired).
  const bothAnswered = answerable.filter(([left, right]) => readAnswered(left) && readAnswered(right));
  const readContextChars = (row) => (Number.isFinite(row?.contextChars) ? row.contextChars : undefined);

  return {
    // What this run was paired against and how, for the report and its Markdown.
    against,
    iterations,
    seed,
    cases: pairs.length,
    // How many rows each report had, so a small intersection shows.
    rows: (report?.rows ?? []).length,
    otherRows: (other?.rows ?? []).length,
    answerableCases: answerable.length,
    unanswerableCases: unanswerable.length,
    // Official F1 over every paired question (an abstention is scored as
    // "Unanswerable", so it scores on an unanswerable question).
    answerF1: delta(pairs, f1),
    // Over the answerable questions only, where an abstention scores 0.
    answerableF1: delta(answerable, f1AbstainZero),
    // The short-answer scores, over the questions both reports scored that way.
    answerF1Direct: delta(whereBoth(pairs, readF1Direct, isScore), f1Direct),
    answerableF1Direct: delta(whereBoth(answerable, readF1Direct, isScore), f1DirectAbstainZero),
    answerRate: delta(answerable, answered),
    unanswerableAnswered: delta(unanswerable, answered),
    answeredBothF1: delta(bothAnswered, f1),
    contextCharsBothAnswered: delta(whereBoth(bothAnswered, readContextChars, isScore), readContextChars),
    citedEvidenceHit: delta(whereBoth(answerable, readCited, isBoolean), (row) => (readCited(row) ? 1 : 0)),
    contextEvidenceHit: delta(whereBoth(answerable, readContextEvidenceHit, isBoolean), (row) =>
      readContextEvidenceHit(row) ? 1 : 0
    ),
    // Answerable questions this run answered and the other did not, and the
    // reverse.
    answerableFlips: {
      answered: answerable.filter(([left, right]) => readAnswered(left) && !readAnswered(right)).length,
      abstained: answerable.filter(([left, right]) => !readAnswered(left) && readAnswered(right)).length,
    },
    configDifferences: describeAnswerRunDifferences(report?.config, other?.config),
  };
};

const METRIC_LABELS = Object.freeze({
  answerF1: "Answer F1 (official, all questions)",
  answerableF1: "Answer F1 on answerable questions (abstention = 0)",
  answerF1Direct: "Short-answer F1 (directAnswer, else first sentence; all questions)",
  answerableF1Direct: "Short-answer F1 on answerable questions (abstention = 0)",
  answerRate: "Answer rate (answerable questions)",
  unanswerableAnswered: "Unanswerable questions answered",
  answeredBothF1: "Answer F1 on answerable questions both runs answered",
  contextCharsBothAnswered: "Context characters on answerable questions both runs answered",
  citedEvidenceHit: "Cited evidence recall (answerable, both runs recorded it)",
  contextEvidenceHit: "Context evidence recall (answerable, both runs recorded it)",
});

const formatInterval = (entry) =>
  entry?.ci95 ? `[${entry.ci95[0]}, ${entry.ci95[1]}]` : "–";

const formatDelta = (entry) =>
  entry?.delta === null || entry?.delta === undefined
    ? "–"
    : `${entry.delta > 0 ? "+" : ""}${entry.delta}`;

/** The comparison as Markdown, for the report and the command line. */
export const formatComparisonMarkdown = (comparison) => [
  `Paired against \`${comparison.against}\` (${comparison.cases} questions, ${comparison.answerableCases} answerable${
    comparison.cases < Math.max(comparison.rows ?? 0, comparison.otherRows ?? 0)
      ? `, out of ${comparison.rows} rows here and ${comparison.otherRows} there`
      : ""
  }; this run minus that one, bootstrap 95% CI, ${comparison.iterations} iterations, seed ${comparison.seed}):`,
  "",
  "| Metric | Questions | Delta | 95% CI |",
  "|---|---|---|---|",
  ...Object.entries(METRIC_LABELS).map(
    ([metric, label]) =>
      `| ${label} | ${comparison[metric]?.cases ?? 0} | ${formatDelta(comparison[metric])} | ${formatInterval(comparison[metric])} |`
  ),
  "",
  `Answerable questions that flipped: +${comparison.answerableFlips.answered} answered / −${comparison.answerableFlips.abstained} abstained.`,
  ...(comparison.configDifferences.length > 0
    ? [
        "",
        `The two runs differ, or cannot be shown to match, in ${comparison.configDifferences
          .map((entry) => `${entry.field} (${JSON.stringify(entry.current)} vs ${JSON.stringify(entry.other)})`)
          .join(", ")}.`,
      ]
    : []),
  "",
];

/** A qasper-answers report read from disk; a parse error names the file. */
export const readQasperAnswerReport = async (file) => {
  const resolved = path.resolve(process.cwd(), file);
  let parsed;

  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }

  if (parsed?.reportType !== "qasper-answers" || !Array.isArray(parsed.rows)) {
    throw new Error(`${file} is not a qasper-answers report.`);
  }

  return parsed;
};

// A non-negative integer option, refused rather than replaced when it is not
// one (the seed is folded to 32 bits by the RNG, so a fraction would silently
// repeat another seed's draws).
const parseIntegerOption = (name, value, { min = 0 } = {}) => {
  if (!/^\d+$/.test(String(value)) || Number(value) < min) {
    throw new Error(`${name} must be an integer of at least ${min}; got ${JSON.stringify(value)}.`);
  }

  return Number(value);
};

const main = async () => {
  const args = process.argv.slice(2);
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));

  if (positional.length !== 2) {
    throw new Error("Usage: compare-qasper-answer-reports.mjs <this report.json> <other report.json> [--iterations N] [--seed N]");
  }

  const iterations = parseIntegerOption("--iterations", getArgValue("--iterations") ?? DEFAULT_COMPARE_ITERATIONS, { min: 1 });
  const seed = parseIntegerOption("--seed", getArgValue("--seed") ?? DEFAULT_COMPARE_SEED);
  const report = await readQasperAnswerReport(positional[0]);
  const other = await readQasperAnswerReport(positional[1]);
  const comparison = compareQasperAnswerReports(report, other, {
    against: path.basename(positional[1]),
    iterations,
    seed,
  });

  if (comparison.cases === 0) {
    throw new Error(
      `${positional[0]} and ${positional[1]} share no question id (${comparison.rows} and ${comparison.otherRows} rows); a paired comparison needs the same sample.`
    );
  }

  process.stdout.write(formatComparisonMarkdown(comparison).join("\n"));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
