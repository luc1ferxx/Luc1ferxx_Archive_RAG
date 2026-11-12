// Two candidate files of the same questions (eval:abstention-gate --dump),
// compared question by question: where the annotated evidence sits in the
// candidates (among them, at rank 1, in the top 3), what the single-document
// QA gate decides on them, and whether the evidence reaches the answer model's
// context (the gate passes and the context executeQaRag builds with
// selectQaContext holds an evidence page). Paired differences come with 95%
// intervals that resample papers with all their questions.
//
//   npm run compare:gate-dumps -- <base dump> <arm dump> [--iterations 10000] [--seed 12345] [--json]
//
// The gate is replayed as the current environment sets it, which must be how
// both dumps' runs set it: the command refuses when a gate setting the dumps
// recorded (config.retrieval) differs from the current one. Run it with an
// allowlisted environment (env -i) for the defaults. The context holds at most
// the run's own top-K (config.retrieval.topK) chunks. It never reads
// server/.env.
//
// The two runs must differ in nothing but the query expansion
// (retrieval.qaQueryExpansion*): same checkout (git sha, a clean tree),
// chunking, retrieval settings, embedding model, query adapter, corpus and
// sample. Otherwise it refuses and names the differences; --allow-differences
// compares anyway and prints them. The output names each run's commit and
// expansion mode.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describeRunConfigDifferences } from "./eval-run-config.js";
import { bootstrapClusterMeanInterval, createSeededRandom } from "./paired-bootstrap.js";

export const GATE_DUMP_REPORT_TYPE = "abstention-gate-candidates";

// The settings the replayed gate and context read (eval-run-config.js names).
export const GATE_SETTING_FIELDS = Object.freeze([
  "crossEncoderScores",
  "minQaQueryTermCoverage",
  "minRelevanceScore",
  "qaAnswerVerdict",
  "qaDenseRescue",
  "qaDenseRescueFloor",
  "qaDenseRescueThreshold",
  "qaGateInflection",
  "qaMinRerankProbability",
  "qaPartialCoverageFloor",
]);

// Same fallbacks as citations.js and eval:abstention-gate read a page number with.
const pageOf = (result) => {
  const metadata = result?.document?.metadata ?? {};

  return Number(metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page);
};
const expectedPagesOf = (testCase) => new Set(testCase?.expectedEvidence?.[0]?.pages ?? []);
const round = (value) => Number(value.toFixed(4));

const assertGateDump = (dump, label) => {
  if (dump?.reportType !== GATE_DUMP_REPORT_TYPE || !Array.isArray(dump.cases)) {
    throw new Error(`${label} is not a candidates file written by eval:abstention-gate --dump.`);
  }
};

// Run settings outside config.retrieval and config.chunking that change the
// candidates.
const RUN_FIELDS = Object.freeze(["answerable", "corpus", "embeddingModel", "queryAdapter", "seed"]);

/**
 * Where the two runs differ apart from the query expansion: the fields
 * describeRunConfigDifferences lists (chunking, retrieval settings, the
 * checkout) without retrieval.qaQueryExpansion*, plus RUN_FIELDS.
 */
export const describeGateDumpConfigDifferences = (baseConfig = {}, armConfig = {}) => [
  ...describeRunConfigDifferences(baseConfig, armConfig).filter(
    ({ field }) => !field.startsWith("retrieval.qaQueryExpansion")
  ),
  ...RUN_FIELDS.filter((field) => !Object.is(baseConfig?.[field] ?? null, armConfig?.[field] ?? null)).map((field) => ({
    current: baseConfig?.[field] ?? null,
    field,
    other: armConfig?.[field] ?? null,
  })),
];

/** A run's commit, whether its tree was clean, and its expansion mode, for the output. */
export const describeGateDumpProvenance = (dump) => ({
  dirty: dump.config?.git?.dirty ?? null,
  generatedAt: dump.generatedAt ?? null,
  queryExpansion: dump.config?.retrieval?.qaQueryExpansion ?? "off",
  sha: dump.config?.git?.sha ?? null,
});

/**
 * Throws unless both dumps hold the same questions in the same order,
 * recorded the gate settings `currentRetrieval` (describeRetrievalConfig) has,
 * and differ in nothing but the query expansion (describeGateDumpConfigDifferences;
 * `allowDifferences` lets them through). Returns those differences.
 */
export const assertComparableGateDumps = (base, arm, currentRetrieval, { allowDifferences = false } = {}) => {
  assertGateDump(base, "the base");
  assertGateDump(arm, "the arm");

  if (
    base.cases.length !== arm.cases.length ||
    base.cases.some((entry, index) => entry.testCase?.id !== arm.cases[index].testCase?.id)
  ) {
    throw new Error("The two candidate files do not hold the same questions in the same order.");
  }

  for (const [label, dump] of [
    ["base", base],
    ["arm", arm],
  ]) {
    const recorded = dump.config?.retrieval;

    if (!recorded) {
      throw new Error(`The ${label} candidate file recorded no retrieval settings; its gate cannot be replayed as run.`);
    }

    for (const field of GATE_SETTING_FIELDS) {
      if (!Object.is(recorded[field] ?? null, currentRetrieval[field] ?? null)) {
        throw new Error(
          `The ${label} run's ${field} was ${JSON.stringify(recorded[field] ?? null)}; the current environment sets ${JSON.stringify(currentRetrieval[field] ?? null)}. Replay with the run's settings.`
        );
      }
    }
  }

  const differences = describeGateDumpConfigDifferences(base.config, arm.config);

  if (differences.length > 0 && !allowDifferences) {
    throw new Error(
      `The two runs differ in more than the query expansion: ${differences
        .map(({ current, field, other }) => `${field} ${JSON.stringify(current)} / ${JSON.stringify(other)}`)
        .join("; ")}. Run both arms on one clean commit with one environment, or pass --allow-differences.`
    );
  }

  return differences;
};

/**
 * One row per question: evidence among the candidates, at rank 1, in the top
 * 3; the gate's decision; evidence among the chunks it admitted; evidence in
 * the context the answer model would read (none when the gate refuses).
 */
export const describeGateDumpRows = (dump, { assessQaConfidence, minContextCoverage, selectQaContext, topK }) =>
  dump.cases.map(({ evidenceRequirementCount, results = [], testCase }) => {
    const expected = expectedPagesOf(testCase);
    const hasEvidence = (items) => items.some((result) => expected.has(pageOf(result)));
    const confidence = assessQaConfidence({ evidenceRequirementCount, queryText: testCase.question, results });
    const context = confidence.confident
      ? selectQaContext({
          confidence,
          limit: topK,
          minCoverage: minContextCoverage,
          queryText: testCase.question,
          results,
        })
      : [];

    return {
      admitted: confidence.confident && hasEvidence(confidence.usableResults),
      candidates: hasEvidence(results),
      confident: confidence.confident,
      context: hasEvidence(context),
      paperId: testCase.docKeys?.[0] ?? testCase.id,
      rank1: hasEvidence(results.slice(0, 1)),
      shouldAbstain: Boolean(testCase.shouldAbstain),
      top3: hasEvidence(results.slice(0, 3)),
    };
  });

/** arm minus base over the rows `keep` selects, with the papers resampled. */
export const pairGateDumpRows = (baseRows, armRows, { iterations = 10000, keep, outcome, seed = 1 }) => {
  const byPaper = new Map();
  let won = 0;
  let lost = 0;
  let baseSum = 0;
  let armSum = 0;
  let total = 0;

  baseRows.forEach((row, index) => {
    if (!keep(row)) {
      return;
    }

    const before = Number(outcome(row));
    const after = Number(outcome(armRows[index]));

    baseSum += before;
    armSum += after;
    total += 1;
    won += after > before ? 1 : 0;
    lost += after < before ? 1 : 0;

    if (!byPaper.has(row.paperId)) {
      byPaper.set(row.paperId, []);
    }

    byPaper.get(row.paperId).push(after - before);
  });

  if (total === 0) {
    return null;
  }

  return {
    arm: round(armSum / total),
    base: round(baseSum / total),
    ci95ByPaper: bootstrapClusterMeanInterval([...byPaper.values()], {
      iterations,
      random: createSeededRandom(seed),
    }),
    delta: round((armSum - baseSum) / total),
    flips: { lost, won },
    papers: byPaper.size,
    questions: total,
  };
};

const percentile = (sortedValues, share) =>
  sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(share * sortedValues.length) - 1))];

/** The per-question retrieval milliseconds a dump recorded (nearest-rank percentiles), null without them. */
export const summarizeRetrievalMs = (dump) => {
  const values = dump.cases
    .map((entry) => Number(entry.retrievalMs))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  if (values.length === 0) {
    return null;
  }

  return {
    max: values.at(-1),
    mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    questions: values.length,
  };
};

const METRICS = Object.freeze([
  ["evidenceAmongCandidates", (row) => !row.shouldAbstain, (row) => row.candidates],
  ["evidenceAtRank1", (row) => !row.shouldAbstain, (row) => row.rank1],
  ["evidenceInTop3", (row) => !row.shouldAbstain, (row) => row.top3],
  ["evidenceInContext", (row) => !row.shouldAbstain, (row) => row.context],
  ["evidenceAdmitted", (row) => !row.shouldAbstain, (row) => row.admitted],
  ["gateAnswerablePass", (row) => !row.shouldAbstain, (row) => row.confident],
  ["gateUnanswerableCatch", (row) => row.shouldAbstain, (row) => !row.confident],
]);

/**
 * The comparison of two parsed candidate files. `gate` holds the replay's
 * functions (assessQaConfidence, selectQaContext, minContextCoverage, and the
 * fallback topK for a dump that recorded none).
 */
export const compareGateDumps = (base, arm, { configDifferences = [], gate, iterations = 10000, seed = 12345 }) => {
  const rowsOf = (dump) =>
    describeGateDumpRows(dump, { ...gate, topK: Number(dump.config?.retrieval?.topK) || gate.topK });
  const baseRows = rowsOf(base);
  const armRows = rowsOf(arm);

  return {
    configDifferences,
    metrics: Object.fromEntries(
      METRICS.map(([name, keep, outcome], index) => [
        name,
        pairGateDumpRows(baseRows, armRows, { iterations, keep, outcome, seed: seed + index }),
      ])
    ),
    provenance: { arm: describeGateDumpProvenance(arm), base: describeGateDumpProvenance(base) },
    questions: {
      answerable: baseRows.filter((row) => !row.shouldAbstain).length,
      unanswerable: baseRows.filter((row) => row.shouldAbstain).length,
    },
    retrievalMs: { arm: summarizeRetrievalMs(arm), base: summarizeRetrievalMs(base) },
  };
};

const formatMetric = (name, metric) =>
  metric
    ? `${name}: ${metric.base} -> ${metric.arm}, ${metric.delta >= 0 ? "+" : ""}${metric.delta} [${metric.ci95ByPaper[0]}, ${metric.ci95ByPaper[1]}] (+${metric.flips.won} / -${metric.flips.lost}; ${metric.questions} questions, ${metric.papers} papers)`
    : `${name}: no question`;

const describeRun = (provenance) =>
  provenance
    ? `commit ${provenance.sha ?? "unknown"}${provenance.dirty ? " (uncommitted changes)" : ""}, expansion ${provenance.queryExpansion}`
    : "unknown";

export const formatGateDumpComparison = (comparison, { armLabel, baseLabel }) =>
  [
    `Arm ${armLabel} minus base ${baseLabel}: ${comparison.questions.answerable} answerable and ${comparison.questions.unanswerable} unanswerable questions; 95% intervals resample papers.`,
    `base: ${describeRun(comparison.provenance?.base)}; arm: ${describeRun(comparison.provenance?.arm)}.`,
    ...(comparison.configDifferences?.length
      ? [
          `The runs also differ in: ${comparison.configDifferences
            .map(({ current, field, other }) => `${field} ${JSON.stringify(current)} / ${JSON.stringify(other)}`)
            .join("; ")}.`,
        ]
      : []),
    ...Object.entries(comparison.metrics).map(([name, metric]) => formatMetric(name, metric)),
    `retrieval ms, base: ${JSON.stringify(comparison.retrievalMs.base)}`,
    `retrieval ms, arm: ${JSON.stringify(comparison.retrievalMs.arm)}`,
    "",
  ].join("\n");

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);

    return index >= 0 ? args[index + 1] : fallback;
  };
  const VALUE_OPTIONS = ["--iterations", "--seed"];
  const positional = args.filter((value, index) => !value.startsWith("--") && !VALUE_OPTIONS.includes(args[index - 1]));

  if (positional.length !== 2) {
    process.stderr.write(
      "Usage: compare:gate-dumps -- <base dump> <arm dump> [--iterations 10000] [--seed 12345] [--json] [--allow-differences]\n"
    );
    process.exit(2);
  }

  const [basePath, armPath] = positional;
  const [base, arm] = await Promise.all(
    positional.map(async (file) => JSON.parse(await readFile(path.resolve(process.cwd(), file), "utf8")))
  );
  const [{ assessQaConfidence, selectQaContext }, { QA_CONTEXT_MIN_COVERAGE }, { getRetrievalTopK }, { describeRetrievalConfig }] =
    await Promise.all([
      import("../rag/confidence.js"),
      import("../rag/document-rag-execution.js"),
      import("../rag/config.js"),
      import("./eval-run-config.js"),
    ]);

  const configDifferences = assertComparableGateDumps(base, arm, await describeRetrievalConfig(), {
    allowDifferences: args.includes("--allow-differences"),
  });

  const comparison = compareGateDumps(base, arm, {
    configDifferences,
    gate: {
      assessQaConfidence,
      minContextCoverage: QA_CONTEXT_MIN_COVERAGE,
      selectQaContext,
      topK: getRetrievalTopK(),
    },
    iterations: Math.max(1, Number(option("--iterations", "10000")) || 10000),
    seed: Math.max(1, Number(option("--seed", "12345")) || 12345),
  });

  process.stdout.write(
    args.includes("--json")
      ? `${JSON.stringify({ arm: path.basename(armPath), base: path.basename(basePath), ...comparison }, null, 2)}\n`
      : formatGateDumpComparison(comparison, { armLabel: path.basename(armPath), baseLabel: path.basename(basePath) })
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
