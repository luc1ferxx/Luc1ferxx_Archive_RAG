// run-abstention-gate-analysis.mjs
//
// Offline analysis of the single-document QA confidence gate
// (rag/confidence.js) on a QASPER corpus. For each question it retrieves the
// candidates once, exactly as the QA route does (retrieveQaCandidates), then
// replays the real assessQaConfidence under a grid of the two thresholds it
// reads -- RAG_MIN_RELEVANCE_SCORE and RAG_MIN_QA_QUERY_TERM_COVERAGE -- without
// calling a chat model. For every setting it reports:
//
//   answerablePass          answerable questions the gate lets through
//   answerableEvidencePass  ... whose admitted sources include an annotated
//                           evidence paragraph (the answer can be right)
//   unanswerableCatch       unanswerable questions the gate stops
//   youdenJ                 answerablePass + unanswerableCatch - 1
//
// plus how well each raw signal separates answerable from unanswerable
// questions at all (AUC over the best candidate's value). Unanswerable
// questions are all kept and answerable ones are sampled; both rates are per
// class, so the stratification does not bias them.
//
// Usage (real embeddings, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768 \
//   node evaluation/run-abstention-gate-analysis.mjs
//     [--corpus evaluation/generated/qasper-train.json] [--answerable 800]
//     [--seed 1] [--latest-name latest-abstention-gate-train]
//     [--dump <candidates.json>] [--replay <candidates.json>]
//     [--dense-rescue <mode>:<threshold>:<floor>]...
//
// The dense rescue section (RAG_QA_DENSE_RESCUE) tries the decile grid of
// buildDenseRescueGrid, or only the configurations given with --dense-rescue
// (a dev confirmation runs the one train picked), and pairs the pick (or each
// given configuration) with the default gate, question by question, with
// intervals by paper. --dump writes every question's candidates after
// retrieval; --replay reads such a file instead of ingesting and retrieving,
// so a rerun needs no embedding model.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeChunkingConfig, describeEvaluationCheckout, describeRetrievalConfig } from "./eval-run-config.js";
import { bootstrapClusterMeanInterval, createSeededRandom } from "./paired-bootstrap.js";
import { sampleQasperCases } from "./run-qasper-answer-eval.mjs";
import { useEvaluationDataDirectory } from "./eval-data-directory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

export const RELEVANCE_GRID = Object.freeze([0.2, 0.24, 0.28, 0.32, 0.36, 0.4, 0.44, 0.48, 0.52, 0.56, 0.6]);
// 0.01 means "at least one query term"; the setting cannot be 0.
export const COVERAGE_GRID = Object.freeze([0.01, 0.1, 0.2, 0.3, 0.4, 0.51, 0.6]);
// The gate before tuning: the report's first row. The tuned QA floor is
// DEFAULT_MIN_QA_QUERY_TERM_COVERAGE in rag/config.js. The grid measures the
// coverage floor alone (partial coverage band off, partialCoverageFloor 1);
// the second row adds the band RAG_QA_ANSWER_VERDICT opens, before the answer
// model's own verdict, which this analysis does not call.
export const DEFAULT_GATE = Object.freeze({
  minQueryTermCoverage: 0.51,
  minRelevanceScore: 0.32,
  partialCoverageFloor: 1,
});
export const PARTIAL_BAND_GATE = Object.freeze({ ...DEFAULT_GATE, partialCoverageFloor: 0.3 });
// With --rerank-gate (candidates reranked by a cross-encoder): thresholds on
// the reranker's relevance probability (RAG_QA_MIN_RERANK_PROBABILITY).
export const RERANK_PROBABILITY_GRID = Object.freeze([0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
// The selection rule the lexical floor was tuned with (docs/evaluation.md):
// a wrong answer costs three refusals, p is the unanswerable share of QASPER
// train, and within 0.01 of the lowest cost the most conservative setting wins.
export const WRONG_ANSWER_COST = 3;
export const UNANSWERABLE_PRIOR = 0.115;

export const gateCost = ({ answerablePass, unanswerableCatch }) =>
  round((1 - UNANSWERABLE_PRIOR) * (1 - answerablePass) + WRONG_ANSWER_COST * UNANSWERABLE_PRIOR * (1 - unanswerableCatch));

// Dense rescue (RAG_QA_DENSE_RESCUE, docs/evaluation.md "门控换信号"). The
// threshold grid is the deciles of the question-level value over this run's
// questions, both classes together, so it is fixed before any label is read;
// each threshold is tried with each coverage floor. The rescue only ever adds
// admissions, so it can only raise the answerable pass and lower the
// unanswerable catch: a configuration qualifies when it catches no more than
// DENSE_RESCUE_CATCH_TOLERANCE fewer unanswerable questions than the default
// gate, and the pick is the qualifying one that passes the most answerable
// questions (then the higher catch, absolute before margin, the higher floor,
// the higher threshold). The rescue is worth a dev run only when the pick
// passes at least DENSE_RESCUE_MIN_GAIN more answerable questions.
export const DENSE_RESCUE_MODES = Object.freeze(["absolute", "margin"]);
export const DENSE_RESCUE_FLOORS = Object.freeze([0, 0.3]);
export const DENSE_RESCUE_QUANTILES = Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
export const DENSE_RESCUE_CATCH_TOLERANCE = 0.02;
export const DENSE_RESCUE_MIN_GAIN = 0.03;

const isDenseCosine = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * A question's dense signals over its QA candidates: the best cosine
 * (`absolute`) and how far it stands above the dense candidates' mean
 * (`margin`; 0 with fewer than two dense candidates), the two quantities the
 * rescue modes compare a chunk with.
 */
export const describeDenseSignals = (results) => {
  const cosines = results.map((result) => result?.vectorScore).filter(isDenseCosine);

  if (cosines.length === 0) {
    return { absolute: 0, margin: 0 };
  }

  const best = Math.max(...cosines);
  const mean = cosines.reduce((sum, value) => sum + value, 0) / cosines.length;

  return { absolute: best, margin: cosines.length < 2 ? 0 : best - mean };
};

/** The value at quantile `q` (nearest rank on the sorted values), 4 decimals. */
export const quantileOf = (values, q) => {
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);

  if (sorted.length === 0) {
    return null;
  }

  return round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]);
};

/** Every (mode, threshold, floor) the dense rescue grid tries, from the run's own signal values. */
export const buildDenseRescueGrid = (signals) =>
  DENSE_RESCUE_MODES.flatMap((mode) => {
    const thresholds = [
      ...new Set(
        DENSE_RESCUE_QUANTILES.map((q) => quantileOf(signals.map((signal) => signal[mode]), q)).filter(
          (value) => value !== null && value > 0
        )
      ),
    ];

    return thresholds.flatMap((threshold) => DENSE_RESCUE_FLOORS.map((floor) => ({ floor, mode, threshold })));
  });

const MODE_ORDER = new Map(DENSE_RESCUE_MODES.map((mode, index) => [mode, index]));

// The rules compare whole questions (`counts` from summarizeGateSetting), not
// the reported rates: those are rounded to 4 decimals, and the difference of
// two rounded rates can miss a gain of exactly the minimum by 0.0001.
const catchShortfall = (row, baseline) =>
  (baseline.counts.unanswerableCaught - row.counts.unanswerableCaught) / baseline.counts.unanswerable;

/** The qualifying rescue that passes the most answerable questions (see DENSE_RESCUE_CATCH_TOLERANCE), or null. */
export const pickDenseRescue = (rows, baseline) =>
  [...rows]
    .filter((row) => catchShortfall(row, baseline) <= DENSE_RESCUE_CATCH_TOLERANCE + 1e-9)
    .sort(
      (left, right) =>
        right.counts.answerablePassed - left.counts.answerablePassed ||
        right.counts.unanswerableCaught - left.counts.unanswerableCaught ||
        MODE_ORDER.get(left.mode) - MODE_ORDER.get(right.mode) ||
        right.floor - left.floor ||
        right.threshold - left.threshold
    )[0] ?? null;

/** Whether the pick passes enough more answerable questions than the default gate to go on to dev. */
export const denseRescueGainsEnough = (pick, baseline) =>
  pick !== null &&
  (pick.counts.answerablePassed - baseline.counts.answerablePassed) / baseline.counts.answerable >=
    DENSE_RESCUE_MIN_GAIN - 1e-9;

/**
 * One gate setting against another on the same questions: per class, the
 * mean paired difference of a 0/1 outcome, its 95% interval resampling
 * papers with all their questions, and the questions that moved each way.
 * `decisions` and `baseline` are parallel arrays of
 * { confident, evidenceAdmitted, paperId, shouldAbstain }.
 */
export const pairGateDecisions = (decisions, baseline, { iterations = 10000, seed = 1 } = {}) => {
  const compare = (keep, outcome, seedOffset) => {
    const byPaper = new Map();
    let won = 0;
    let lost = 0;
    let total = 0;
    let sum = 0;

    decisions.forEach((decision, index) => {
      if (!keep(decision)) {
        return;
      }

      const difference = Number(outcome(decision)) - Number(outcome(baseline[index]));

      won += difference > 0 ? 1 : 0;
      lost += difference < 0 ? 1 : 0;
      total += 1;
      sum += difference;

      if (!byPaper.has(decision.paperId)) {
        byPaper.set(decision.paperId, []);
      }

      byPaper.get(decision.paperId).push(difference);
    });

    return {
      ci95ByPaper: bootstrapClusterMeanInterval([...byPaper.values()], {
        iterations,
        random: createSeededRandom(seed + seedOffset),
      }),
      delta: total > 0 ? round(sum / total) : null,
      flips: { lost, won },
      papers: byPaper.size,
      questions: total,
    };
  };

  return {
    answerableEvidencePass: compare(
      (decision) => !decision.shouldAbstain,
      (decision) => decision.confident && decision.evidenceAdmitted,
      1
    ),
    answerablePass: compare((decision) => !decision.shouldAbstain, (decision) => decision.confident, 0),
    unanswerableCatch: compare((decision) => decision.shouldAbstain, (decision) => !decision.confident, 2),
  };
};

/** Lowest cost within 0.01, then the highest threshold (the most refusals). */
export const pickRerankThreshold = (rows) => {
  const lowest = Math.min(...rows.map((row) => row.cost));

  return [...rows]
    .filter((row) => row.cost <= lowest + 0.01)
    .sort((left, right) => right.minRerankProbability - left.minRerankProbability)[0];
};

// The reranker re-measure at top-K 10 (docs/evaluation.md "重排在 top-K 10
// 下重测"): the lexical gate on the same reranked candidates competes with
// every probability threshold under the same cost; within RERANK_COST_TOLERANCE
// of the lowest cost the setting that catches the most unanswerable questions
// wins, then the lower cost. Costs come from whole counts, not rounded rates.
export const RERANK_COST_TOLERANCE = 0.01;

/** The cost from whole counts, or null when a class has no questions. */
export const exactGateCost = ({ answerable, answerablePassed, unanswerable, unanswerableCaught }) =>
  answerable > 0 && unanswerable > 0
    ? (1 - UNANSWERABLE_PRIOR) * (1 - answerablePassed / answerable) +
      WRONG_ANSWER_COST * UNANSWERABLE_PRIOR * (1 - unanswerableCaught / unanswerable)
    : null;

/**
 * Every candidate of the reranker re-measure with its exact cost: the
 * probability thresholds, then the lexical gate (`gate: "lexical"`, no threshold).
 */
export const describeRerankGateCandidates = (rerankRows, lexicalRow) =>
  [...rerankRows.map((row) => ({ ...row, gate: "rerank" })), { ...lexicalRow, gate: "lexical", minRerankProbability: null }].map(
    (candidate) => ({ ...candidate, exactCost: exactGateCost(candidate.counts) })
  );

/** The pick among the probability thresholds and the lexical gate, or null when a class has no questions. */
export const pickRerankGate = (rerankRows, lexicalRow) => {
  const candidates = describeRerankGateCandidates(rerankRows, lexicalRow);

  if (candidates.some((candidate) => candidate.exactCost === null)) {
    return null;
  }

  const lowest = Math.min(...candidates.map((candidate) => candidate.exactCost));

  return (
    candidates
      .filter((candidate) => candidate.exactCost <= lowest + RERANK_COST_TOLERANCE + 1e-9)
      .sort(
        (left, right) =>
          right.counts.unanswerableCaught - left.counts.unanswerableCaught ||
          left.exactCost - right.exactCost ||
          // An exact tie goes to the higher threshold, as in pickRerankThreshold.
          (right.minRerankProbability ?? -1) - (left.minRerankProbability ?? -1)
      )[0] ?? null
  );
};

const round = (value) => (value === null ? null : Number(value.toFixed(4)));
const rate = (count, total) => (total > 0 ? round(count / total) : null);

// Probability that a random positive outranks a random negative (ties count
// half): 0.5 means the signal carries no information about the label.
export const computeAuc = (positives, negatives) => {
  if (positives.length === 0 || negatives.length === 0) {
    return null;
  }

  let wins = 0;

  for (const positive of positives) {
    for (const negative of negatives) {
      wins += positive > negative ? 1 : positive === negative ? 0.5 : 0;
    }
  }

  return round(wins / (positives.length * negatives.length));
};

export const summarizeGateSetting = (decisions) => {
  const answerable = decisions.filter((decision) => !decision.shouldAbstain);
  const unanswerable = decisions.filter((decision) => decision.shouldAbstain);
  const answerablePassed = answerable.filter((decision) => decision.confident).length;
  const unanswerableCaught = unanswerable.filter((decision) => !decision.confident).length;
  const answerablePass = rate(answerablePassed, answerable.length);
  const unanswerableCatch = rate(unanswerableCaught, unanswerable.length);

  return {
    answerableEvidencePass: rate(
      answerable.filter((decision) => decision.confident && decision.evidenceAdmitted).length,
      answerable.length
    ),
    answerablePass,
    counts: {
      answerable: answerable.length,
      answerablePassed,
      unanswerable: unanswerable.length,
      unanswerableCaught,
    },
    unanswerableCatch,
    youdenJ:
      answerablePass === null || unanswerableCatch === null ? null : round(answerablePass + unanswerableCatch - 1),
  };
};

export const withGateEnv = (setting, callback) => {
  const previous = {
    coverage: process.env.RAG_MIN_QA_QUERY_TERM_COVERAGE,
    denseRescue: process.env.RAG_QA_DENSE_RESCUE,
    denseRescueFloor: process.env.RAG_QA_DENSE_RESCUE_FLOOR,
    denseRescueThreshold: process.env.RAG_QA_DENSE_RESCUE_THRESHOLD,
    partial: process.env.RAG_QA_PARTIAL_COVERAGE_FLOOR,
    rerank: process.env.RAG_QA_MIN_RERANK_PROBABILITY,
    verdict: process.env.RAG_QA_ANSWER_VERDICT,
    relevance: process.env.RAG_MIN_RELEVANCE_SCORE,
  };

  process.env.RAG_MIN_QA_QUERY_TERM_COVERAGE = String(setting.minQueryTermCoverage);
  process.env.RAG_QA_PARTIAL_COVERAGE_FLOOR = String(setting.partialCoverageFloor ?? 1);
  process.env.RAG_QA_ANSWER_VERDICT = String((setting.partialCoverageFloor ?? 1) < 1);
  process.env.RAG_QA_MIN_RERANK_PROBABILITY = String(setting.minRerankProbability ?? "off");
  process.env.RAG_MIN_RELEVANCE_SCORE = String(setting.minRelevanceScore);
  // Every setting names its rescue (or none), so an ambient value never leaks in.
  process.env.RAG_QA_DENSE_RESCUE = setting.denseRescue?.mode ?? "off";
  process.env.RAG_QA_DENSE_RESCUE_THRESHOLD = setting.denseRescue ? String(setting.denseRescue.threshold) : "";
  process.env.RAG_QA_DENSE_RESCUE_FLOOR = setting.denseRescue ? String(setting.denseRescue.floor) : "";

  try {
    return callback();
  } finally {
    for (const [key, name] of [
      ["coverage", "RAG_MIN_QA_QUERY_TERM_COVERAGE"],
      ["denseRescue", "RAG_QA_DENSE_RESCUE"],
      ["denseRescueFloor", "RAG_QA_DENSE_RESCUE_FLOOR"],
      ["denseRescueThreshold", "RAG_QA_DENSE_RESCUE_THRESHOLD"],
      ["partial", "RAG_QA_PARTIAL_COVERAGE_FLOOR"],
      ["rerank", "RAG_QA_MIN_RERANK_PROBABILITY"],
      ["verdict", "RAG_QA_ANSWER_VERDICT"],
      ["relevance", "RAG_MIN_RELEVANCE_SCORE"],
    ]) {
      if (previous[key] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[key];
      }
    }
  }
};

const formatMarkdown = (report) => {
  const top = [...report.grid].sort((left, right) => right.youdenJ - left.youdenJ).slice(0, 8);
  const row = (entry) =>
    `| ${entry.minRelevanceScore} | ${entry.minQueryTermCoverage} | ${entry.answerablePass} | ${entry.answerableEvidencePass} | ${entry.unanswerableCatch} | ${entry.youdenJ} |`;

  return [
    "# Abstention gate analysis",
    "",
    `Generated ${report.generatedAt}; corpus \`${report.config.corpus}\`; ${report.counts.answerable} answerable (sampled) + ${report.counts.unanswerable} unanswerable questions; embedding ${report.config.embeddingModel}.`,
    "",
    `Signal AUC (answerable vs unanswerable, best candidate): admission ${report.auc.admission}, query-term coverage ${report.auc.coverage}, dense similarity ${report.auc.vector}${report.auc.rerank === null ? "" : `, reranker probability ${report.auc.rerank}`}.`,
    `Annotated evidence among the retrieved candidates (answerable, before the gate): ${report.evidenceRetrieved}.`,
    "",
    "| minRelevanceScore | minQueryTermCoverage | answerable pass | ... with evidence admitted | unanswerable caught | Youden J |",
    "|---|---|---|---|---|---|",
    row({ ...report.default, label: "default" }),
    row({ ...report.partialBand, minQueryTermCoverage: `${report.partialBand.minQueryTermCoverage} (band ${report.partialBand.partialCoverageFloor})` }),
    ...top.map(row),
    "",
    "First row: the coverage floor alone at 0.51 (the default). Second: with RAG_QA_ANSWER_VERDICT on, which also admits single-part questions' chunks in the partial coverage band unless a query word was replaced by a rival; the answer model's verdict comes after this gate and is not simulated. Then the eight floor-only settings with the highest Youden J.",
    "",
    ...(report.rerankGrid.length === 0
      ? []
      : [
          `Reranker gate (RAG_QA_MIN_RERANK_PROBABILITY), cost = ${1 - UNANSWERABLE_PRIOR} x refused answerable + ${WRONG_ANSWER_COST} x ${UNANSWERABLE_PRIOR} x answered unanswerable; the lexical default costs ${report.default.cost}.`,
          "",
          "| min probability | answerable pass | ... with evidence admitted | unanswerable caught | Youden J | cost |",
          "|---|---|---|---|---|---|",
          ...report.rerankGrid.map(
            (entry) =>
              `| ${entry.minRerankProbability}${entry === report.rerankPick ? " (earlier rule's pick)" : ""} | ${entry.answerablePass} | ${entry.answerableEvidencePass} | ${entry.unanswerableCatch} | ${entry.youdenJ} | ${entry.cost} |`
          ),
          "",
          ...(report.rerankGate ? formatRerankGateMarkdown(report.rerankGate) : []),
        ]),
    ...(report.denseRescue ? formatDenseRescueMarkdown(report.denseRescue) : []),
    ...(report.queryExpansion ? formatQueryExpansionMarkdown(report.queryExpansion) : []),
  ].join("\n");
};

const percentile = (sortedValues, share) =>
  sortedValues.length === 0
    ? null
    : sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(share * sortedValues.length) - 1))];

/**
 * What RAG_QA_QUERY_EXPANSION did over a run (the cases' `queryExpansion`,
 * retrieveQaCandidates): how many questions it applied to, why the others got
 * none (skipped: never asked; fallback: asked, nothing usable), how many
 * replies the output limit cut, and the milliseconds the expansion step took
 * before retrieval (nearest-rank percentiles over the questions it ran on).
 * Null when no case carries it (the setting was off).
 */
export const summarizeQueryExpansion = (cases = []) => {
  const entries = cases.map((entry) => entry?.queryExpansion).filter(Boolean);

  if (entries.length === 0) {
    return null;
  }

  const countBy = (read) =>
    entries.reduce((counts, entry) => {
      const key = read(entry);

      return key ? { ...counts, [key]: (counts[key] ?? 0) + 1 } : counts;
    }, {});
  const durations = entries
    .filter((entry) => !entry.skipped)
    .map((entry) => Number(entry.durationMs))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  return {
    applied: entries.filter((entry) => entry.applied === true).length,
    durationMs:
      durations.length === 0
        ? null
        : {
            max: durations.at(-1),
            mean: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
            p50: percentile(durations, 0.5),
            p95: percentile(durations, 0.95),
          },
    errorCodes: countBy((entry) => entry.errorCode),
    fallbacks: countBy((entry) => entry.fallback),
    mode: entries[0].mode,
    questions: entries.length,
    skipped: countBy((entry) => entry.skipped),
    truncated: entries.filter((entry) => entry.truncated === true).length,
  };
};

const formatQueryExpansionMarkdown = (section) => [
  "",
  `Query expansion (RAG_QA_QUERY_EXPANSION=${section.mode}): applied to ${section.applied} of ${section.questions} questions; skipped ${JSON.stringify(section.skipped)}, fell back ${JSON.stringify(section.fallbacks)}, cut by the output limit ${section.truncated}.`,
  section.durationMs
    ? `Expansion before retrieval: mean ${section.durationMs.mean} ms, p50 ${section.durationMs.p50}, p95 ${section.durationMs.p95}, max ${section.durationMs.max}.`
    : "Expansion before retrieval: no timed question.",
];

/** `--dense-rescue margin:0.05:0.3` (mode, threshold, coverage floor) as a rescue configuration. */
export const parseDenseRescueOption = (value) => {
  const [mode, rawThreshold, rawFloor = "0"] = String(value ?? "").split(":");
  const threshold = Number(rawThreshold);
  const floor = Number(rawFloor);

  if (!DENSE_RESCUE_MODES.includes(mode) || !(threshold > 0 && threshold <= 1) || !(floor >= 0 && floor <= 1)) {
    throw new Error(
      `--dense-rescue takes <absolute|margin>:<threshold above 0 up to 1>:<floor from 0 to 1>. Received "${value}".`
    );
  }

  return { floor, mode, threshold };
};

const describeRescue = ({ floor, mode, threshold }) => `${mode}:${threshold}:${floor}`;

const formatPairedDelta = (label, delta) =>
  `| ${label} | ${delta.delta} | [${delta.ci95ByPaper?.join(", ") ?? "n/a"}] | +${delta.flips.won} / -${delta.flips.lost} | ${delta.questions} | ${delta.papers} |`;

const formatPairedCell = ({ ci95ByPaper, delta, flips }) =>
  `${delta} [${ci95ByPaper?.[0] ?? "n/a"}, ${ci95ByPaper?.[1] ?? "n/a"}] (+${flips.won} / -${flips.lost})`;

const roundCost = (value) => (value === null ? null : Number(value.toFixed(6)));

export const formatRerankGateMarkdown = ({ candidates = [], costTolerance, paired, pick }) => [
  pick
    ? `Pick (the lexical gate on these candidates competes; within ${costTolerance} of the lowest cost, the most unanswerable questions caught, then the lower cost, then the higher threshold): ${pick.gate === "lexical" ? "the lexical gate" : `min probability ${pick.minRerankProbability}`}; answerable pass ${pick.answerablePass}, unanswerable caught ${pick.unanswerableCatch}, cost from counts ${roundCost(pick.exactCost)}.`
    : "No pick: the run has no answerable or no unanswerable questions.",
  ...(candidates.length > 0
    ? [
        "",
        `Costs from counts, which the pick compares: ${candidates
          .map(
            (candidate) =>
              `${candidate.gate === "lexical" ? "lexical" : candidate.minRerankProbability} ${roundCost(candidate.exactCost)}`
          )
          .join(", ")}.`,
      ]
    : []),
  "",
  "Each threshold against the lexical gate on the same candidates, question by question (95% interval resampling papers):",
  "",
  "| min probability | answerable pass | ... with evidence admitted | unanswerable caught |",
  "|---|---|---|---|",
  ...paired.map(
    (row) =>
      `| ${row.minRerankProbability} | ${formatPairedCell(row.answerablePass)} | ${formatPairedCell(row.answerableEvidencePass)} | ${formatPairedCell(row.unanswerableCatch)} |`
  ),
  "",
];

const formatDenseRescueMarkdown = (section) => [
  "## Dense rescue (RAG_QA_DENSE_RESCUE)",
  "",
  `Signal AUC (answerable vs unanswerable): best dense cosine ${section.auc.absolute}, best cosine above the dense candidates' mean ${section.auc.margin}.`,
  section.explicit
    ? `Configurations given on the command line: ${section.explicit.map(describeRescue).join(", ")}.`
    : `Grid: the deciles of each signal over this run's questions, with coverage floors ${DENSE_RESCUE_FLOORS.join(" and ")}. A configuration qualifies when it catches at most ${DENSE_RESCUE_CATCH_TOLERANCE} fewer unanswerable questions than the default gate; the pick passes the most answerable questions.`,
  "",
  "| mode | threshold | floor | answerable pass | ... with evidence admitted | unanswerable caught | Youden J | cost |",
  "|---|---|---|---|---|---|---|---|",
  ...section.grid.map(
    (row) =>
      `| ${row.mode}${section.pick && describeRescue(row) === describeRescue(section.pick) ? " (picked)" : ""} | ${row.threshold} | ${row.floor} | ${row.answerablePass} | ${row.answerableEvidencePass} | ${row.unanswerableCatch} | ${row.youdenJ} | ${row.cost} |`
  ),
  "",
  ...(section.explicit
    ? []
    : [
        section.pick
          ? `Pick: ${describeRescue(section.pick)}; answerable pass ${section.pick.answerablePass} against ${section.baseline.answerablePass} for the default gate (${section.gainsEnough ? "at least" : "less than"} the required +${DENSE_RESCUE_MIN_GAIN}).`
          : "No configuration qualifies.",
        "",
      ]),
  ...section.paired.flatMap((entry) => [
    `Paired with the default gate, question by question (${describeRescue(entry)}; 95% interval resampling papers):`,
    "",
    "| outcome | delta | CI by paper | +/- | questions | papers |",
    "|---|---|---|---|---|---|",
    formatPairedDelta("answerable pass", entry.answerablePass),
    formatPairedDelta("answerable pass with evidence admitted", entry.answerableEvidencePass),
    formatPairedDelta("unanswerable caught", entry.unanswerableCatch),
    "",
  ]),
];

const DUMP_REPORT_TYPE = "abstention-gate-candidates";

const main = async () => {
  // Loaded here, not at import time, so tests importing the pure parts never
  // read server/.env.
  await import("dotenv/config");
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const optionValues = (name) => args.flatMap((value, index) => (value === name ? [args[index + 1]] : []));
  const latestName = option("--latest-name", "latest-abstention-gate-train");
  const dumpPath = option("--dump", null);
  const replayPath = option("--replay", null);
  const explicitRescues = optionValues("--dense-rescue").map(parseDenseRescueOption);
  // The checkout, before the run.
  const git = await describeEvaluationCheckout();
  let candidatesByCase = [];
  let runConfig;

  if (replayPath) {
    const dump = JSON.parse(await readFile(path.resolve(process.cwd(), replayPath), "utf8"));

    if (dump?.reportType !== DUMP_REPORT_TYPE || !Array.isArray(dump.cases)) {
      throw new Error(`${replayPath} is not a candidates file written by --dump.`);
    }

    candidatesByCase = dump.cases;
    // The retrieval run's settings and checkout; analysisGit is the code that
    // replays the gate now.
    runConfig = { ...dump.config, analysisGit: git, replayOf: { file: path.basename(replayPath), generatedAt: dump.generatedAt } };
  } else {
    const corpusPath = path.resolve(
      process.cwd(),
      option("--corpus", path.join(__dirname, "generated", "qasper-train.json"))
    );
    const answerableCount = Math.max(1, Number(option("--answerable", "800")) || 800);
    const seed = Math.max(1, Number(option("--seed", "1")) || 1);
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    const cases = [
      ...corpus.cases.filter((testCase) => testCase.shouldAbstain),
      ...sampleQasperCases(
        corpus.cases.filter((testCase) => !testCase.shouldAbstain),
        answerableCount,
        seed
      ),
    ];
    const docKeys = new Set(cases.flatMap((testCase) => testCase.docKeys));
    const documents = corpus.documents.filter((doc) => docKeys.has(doc.key));
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "abstention-gate-"));

    useEvaluationDataDirectory(path.join(tempRoot, "rag-data"));
    process.env.DOCCOMPARE_STANDALONE = "1";

    const { applyStandaloneProfile } = await import("../standalone-profile.js");
    applyStandaloneProfile();
    const rag = await import("../chat.js");
    const { retrieveQaCandidates } = await import("../rag/document-rag-execution.js");
    const { getQueryAdapterReportFingerprint } = await import("../rag/query-adapter.js");

    try {
      await rag.initializeDocumentRegistry();
      await mkdir(path.join(tempRoot, "sources"), { recursive: true });
      console.log(`Ingesting ${documents.length} papers for ${cases.length} questions...`);

      for (const doc of documents) {
        const filePath = path.join(tempRoot, "sources", `${doc.key}.txt`);

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

      for (const [index, testCase] of cases.entries()) {
        const startedAt = performance.now();
        const { evidenceRequirementCount, queryExpansion, results } = await retrieveQaCandidates({
          docIds: [testCase.docKeys[0]],
          resolvedQuery: testCase.question,
        });

        candidatesByCase.push({
          evidenceRequirementCount,
          // Only with RAG_QA_QUERY_EXPANSION on (summarizeQueryExpansion).
          ...(queryExpansion ? { queryExpansion } : {}),
          results,
          // The whole retrieval of this question, expansion included.
          retrievalMs: Math.round(performance.now() - startedAt),
          testCase: {
            docKeys: testCase.docKeys,
            expectedEvidence: testCase.expectedEvidence,
            id: testCase.id,
            question: testCase.question,
            shouldAbstain: Boolean(testCase.shouldAbstain),
          },
        });

        if ((index + 1) % 100 === 0) {
          console.log(`retrieved ${index + 1}/${cases.length}`);
        }
      }
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }

    runConfig = {
      answerable: answerableCount,
      chunking: await describeChunkingConfig(),
      corpus: path.basename(corpusPath),
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? null,
      git,
      // RAG_EMBEDDING_QUERY_ADAPTER reorders the QA route's dense candidates.
      queryAdapter: getQueryAdapterReportFingerprint(),
      // The retrieval settings the candidates were fetched with (top-K, pools, fusion, ...).
      retrieval: await describeRetrievalConfig(),
      seed,
    };

    if (dumpPath) {
      await writeFile(
        path.resolve(process.cwd(), dumpPath),
        `${JSON.stringify({ cases: candidatesByCase, config: runConfig, generatedAt: new Date().toISOString(), reportType: DUMP_REPORT_TYPE })}\n`
      );
      console.log(`candidates written to ${dumpPath}`);
    }
  }

  const { assessQaConfidence, toRerankProbability } = await import("../rag/confidence.js");
  const { getAdmissionScore } = await import("../rag/citations.js");
  const seed = runConfig.seed ?? 1;

  // Same fallbacks as citations.js reads a page number with.
  const pageOf = (result) => {
    const metadata = result?.document?.metadata ?? {};

    return Number(metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page);
  };
  const expectedPagesOf = (testCase) => new Set(testCase.expectedEvidence?.[0]?.pages ?? []);
  const best = (results, read) =>
    results.reduce((max, result) => Math.max(max, Number(read(result)) || 0), 0);
  const signals = candidatesByCase.map(({ results, testCase }) => ({
    admission: best(results, getAdmissionScore),
    coverage: best(results, (result) => result.keywordScore),
    ...Object.fromEntries(
      Object.entries(describeDenseSignals(results)).map(([key, value]) => [`dense_${key}`, value])
    ),
    rerank: best(results, (result) =>
      typeof result.crossEncoderScore === "number" ? toRerankProbability(result.crossEncoderScore) : 0
    ),
    shouldAbstain: Boolean(testCase.shouldAbstain),
    vector: best(results, (result) => result.vectorScore),
  }));
  const auc = (key) =>
    computeAuc(
      signals.filter((signal) => !signal.shouldAbstain).map((signal) => signal[key]),
      signals.filter((signal) => signal.shouldAbstain).map((signal) => signal[key])
    );
  const decide = (setting) =>
    withGateEnv(setting, () =>
      candidatesByCase.map(({ evidenceRequirementCount, results, testCase }) => {
        const confidence = assessQaConfidence({
          evidenceRequirementCount,
          queryText: testCase.question,
          results,
        });
        const expected = expectedPagesOf(testCase);

        return {
          confident: confidence.confident,
          evidenceAdmitted: confidence.usableResults.some((result) => expected.has(pageOf(result))),
          paperId: testCase.docKeys[0],
          shouldAbstain: Boolean(testCase.shouldAbstain),
        };
      })
    );
  const evaluateSetting = (setting) => summarizeGateSetting(decide(setting));
  const grid = RELEVANCE_GRID.flatMap((minRelevanceScore) =>
    COVERAGE_GRID.map((minQueryTermCoverage) => ({
      minQueryTermCoverage,
      minRelevanceScore,
      ...evaluateSetting({ minQueryTermCoverage, minRelevanceScore }),
    }))
  );
  const reranked = candidatesByCase.some(({ results }) =>
    results.some((result) => typeof result.crossEncoderScore === "number")
  );
  const withCost = (entry) => ({ ...entry, cost: gateCost(entry) });
  const rerankRows = reranked
    ? RERANK_PROBABILITY_GRID.map((minRerankProbability) => {
        const decisions = decide({ ...DEFAULT_GATE, minRerankProbability });

        return { minRerankProbability, ...withCost(summarizeGateSetting(decisions)), decisions };
      })
    : [];
  const rerankGrid = rerankRows.map(({ decisions: _decisions, ...row }) => row);
  const defaultDecisions = decide(DEFAULT_GATE);
  const defaultSummary = withCost({ ...DEFAULT_GATE, ...summarizeGateSetting(defaultDecisions) });
  // Every threshold paired with the lexical gate on the same reranked candidates.
  const rerankGate = reranked
    ? {
        candidates: describeRerankGateCandidates(rerankGrid, defaultSummary).map((candidate) => ({
          exactCost: candidate.exactCost === null ? null : Number(candidate.exactCost.toFixed(6)),
          gate: candidate.gate,
          minRerankProbability: candidate.minRerankProbability,
        })),
        costTolerance: RERANK_COST_TOLERANCE,
        paired: rerankRows.map((row) => ({
          minRerankProbability: row.minRerankProbability,
          ...pairGateDecisions(row.decisions, defaultDecisions, { iterations: 10000, seed }),
        })),
        pick: pickRerankGate(rerankGrid, defaultSummary),
      }
    : null;
  // The dense rescue section. The reranker gate replaces the lexical one, and
  // the rescue never applies there, so it is measured on the lexical gate.
  const denseSignals = signals.map((signal) => ({ absolute: signal.dense_absolute, margin: signal.dense_margin }));
  const rescueConfigs = explicitRescues.length > 0 ? explicitRescues : buildDenseRescueGrid(denseSignals);
  const rescueRows = rescueConfigs.map((denseRescue) => {
    const decisions = decide({ ...DEFAULT_GATE, denseRescue });

    return { ...denseRescue, ...withCost(summarizeGateSetting(decisions)), decisions };
  });
  const stripDecisions = ({ decisions: _decisions, ...row }) => row;
  const pick = explicitRescues.length > 0 ? null : pickDenseRescue(rescueRows, defaultSummary);
  const pairedRows = explicitRescues.length > 0 ? rescueRows : pick ? [pick] : [];
  const answerableCases = candidatesByCase.filter(({ testCase }) => !testCase.shouldAbstain);
  const report = {
    auc: {
      admission: auc("admission"),
      coverage: auc("coverage"),
      rerank: reranked ? auc("rerank") : null,
      vector: auc("vector"),
    },
    config: runConfig,
    counts: {
      answerable: answerableCases.length,
      unanswerable: candidatesByCase.length - answerableCases.length,
    },
    default: defaultSummary,
    denseRescue: {
      auc: { absolute: auc("dense_absolute"), margin: auc("dense_margin") },
      baseline: { answerablePass: defaultSummary.answerablePass, unanswerableCatch: defaultSummary.unanswerableCatch },
      catchTolerance: DENSE_RESCUE_CATCH_TOLERANCE,
      explicit: explicitRescues.length > 0 ? explicitRescues : null,
      gainsEnough: explicitRescues.length > 0 ? null : denseRescueGainsEnough(pick, defaultSummary),
      grid: rescueRows.map(stripDecisions),
      minGain: DENSE_RESCUE_MIN_GAIN,
      paired: pairedRows.map((row) => ({
        floor: row.floor,
        mode: row.mode,
        threshold: row.threshold,
        ...pairGateDecisions(row.decisions, defaultDecisions, { iterations: 10000, seed }),
      })),
      pick: pick ? stripDecisions(pick) : null,
    },
    queryExpansion: summarizeQueryExpansion(candidatesByCase),
    rerankGate,
    rerankGrid,
    rerankPick: reranked ? pickRerankThreshold(rerankGrid) : null,
    partialBand: { ...PARTIAL_BAND_GATE, ...evaluateSetting(PARTIAL_BAND_GATE) },
    evidenceRetrieved: rate(
      answerableCases.filter(({ results, testCase }) =>
        results.some((result) => expectedPagesOf(testCase).has(pageOf(result)))
      ).length,
      answerableCases.length
    ),
    generatedAt: new Date().toISOString(),
    grid,
    reportType: "abstention-gate-analysis",
  };

  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDirectory, `${latestName}.md`), formatMarkdown(report));
  process.stdout.write(formatMarkdown(report));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
