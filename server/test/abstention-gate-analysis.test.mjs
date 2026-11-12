import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDenseRescueGrid,
  computeAuc,
  COVERAGE_GRID,
  DEFAULT_GATE,
  DENSE_RESCUE_CATCH_TOLERANCE,
  DENSE_RESCUE_FLOORS,
  DENSE_RESCUE_MIN_GAIN,
  denseRescueGainsEnough,
  describeDenseSignals,
  exactGateCost,
  formatRerankGateMarkdown,
  gateCost,
  pairGateDecisions,
  parseDenseRescueOption,
  PARTIAL_BAND_GATE,
  pickDenseRescue,
  pickRerankGate,
  pickRerankThreshold,
  RERANK_COST_TOLERANCE,
  quantileOf,
  RELEVANCE_GRID,
  summarizeGateSetting,
  withGateEnv,
} from "../evaluation/run-abstention-gate-analysis.mjs";
import {
  DEFAULT_MIN_QA_QUERY_TERM_COVERAGE,
  DEFAULT_QA_PARTIAL_COVERAGE_FLOOR,
  getMinQueryTermCoverage,
  getMinRelevanceScore,
} from "../rag/config.js";

test("AUC is 1 for a perfect separator, 0.5 for no information, and counts ties as half", () => {
  assert.equal(computeAuc([0.9, 0.8], [0.1, 0.2]), 1);
  assert.equal(computeAuc([0.5, 0.5], [0.5, 0.5]), 0.5);
  assert.equal(computeAuc([0.2], [0.8]), 0);
  assert.equal(computeAuc([], [0.1]), null);
});

test("a gate setting is summarized per class, so sampling one class does not bias it", () => {
  const summary = summarizeGateSetting([
    { confident: true, evidenceAdmitted: true, shouldAbstain: false },
    { confident: true, evidenceAdmitted: false, shouldAbstain: false },
    { confident: false, evidenceAdmitted: false, shouldAbstain: false },
    { confident: false, evidenceAdmitted: false, shouldAbstain: true },
  ]);

  assert.deepEqual(summary, {
    answerableEvidencePass: 0.3333,
    answerablePass: 0.6667,
    counts: { answerable: 3, answerablePassed: 2, unanswerable: 1, unanswerableCaught: 1 },
    unanswerableCatch: 1,
    youdenJ: 0.6667,
  });
});

test("the analysis grid contains the pre-tuning gate and the tuned QA floor", () => {
  assert.equal(DEFAULT_GATE.minRelevanceScore, getMinRelevanceScore());
  assert.equal(DEFAULT_GATE.minQueryTermCoverage, getMinQueryTermCoverage());
  assert.ok(RELEVANCE_GRID.includes(DEFAULT_GATE.minRelevanceScore));
  assert.ok(COVERAGE_GRID.includes(DEFAULT_GATE.minQueryTermCoverage));
  assert.ok(COVERAGE_GRID.includes(DEFAULT_MIN_QA_QUERY_TERM_COVERAGE));
  // The grid measures the floor alone; the second row is the verdict's band.
  assert.equal(DEFAULT_GATE.partialCoverageFloor, 1);
  assert.equal(PARTIAL_BAND_GATE.partialCoverageFloor, DEFAULT_QA_PARTIAL_COVERAGE_FLOOR);
});

test("the reranker threshold follows the lexical floor's cost rule, most conservative within 0.01", () => {
  // p = 0.115, a wrong answer costs three refusals.
  assert.equal(gateCost({ answerablePass: 1, unanswerableCatch: 1 }), 0);
  assert.equal(gateCost({ answerablePass: 0.5, unanswerableCatch: 0.5 }), 0.615);
  assert.deepEqual(
    pickRerankThreshold([
      { cost: 0.4, minRerankProbability: 0.1 },
      { cost: 0.409, minRerankProbability: 0.3 },
      { cost: 0.42, minRerankProbability: 0.5 },
    ]),
    { cost: 0.409, minRerankProbability: 0.3 }
  );
});

test("a question's dense signals are its best cosine and how far it stands above the dense candidates' mean", () => {
  const signals = describeDenseSignals([
    { vectorScore: 0.8 },
    { vectorScore: 0.6 },
    { vectorScore: 0 },
    { keywordScore: 1 },
  ]);

  assert.equal(signals.absolute, 0.8);
  assert.ok(Math.abs(signals.margin - 0.1) < 1e-9);
  assert.deepEqual(describeDenseSignals([{ vectorScore: 0.7 }]), { absolute: 0.7, margin: 0 });
  assert.deepEqual(describeDenseSignals([{ keywordScore: 0.5 }]), { absolute: 0, margin: 0 });
});

test("the rescue grid is the deciles of each signal over the run's questions, with each coverage floor", () => {
  assert.equal(quantileOf([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(quantileOf([1, 2, 3, 4, 5], 0.1), 1);
  assert.equal(quantileOf([1, 2, 3, 4, 5], 0.9), 5);
  assert.equal(quantileOf([], 0.5), null);

  const signals = Array.from({ length: 11 }, (_, index) => ({ absolute: 0.5 + index / 100, margin: index / 100 }));
  const grid = buildDenseRescueGrid(signals);
  const absolute = grid.filter((entry) => entry.mode === "absolute");
  const margin = grid.filter((entry) => entry.mode === "margin");

  assert.deepEqual(
    [...new Set(absolute.map((entry) => entry.threshold))],
    [0.51, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.59]
  );
  assert.deepEqual([...new Set(margin.map((entry) => entry.threshold))], [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09]);
  assert.equal(grid.length, 18 * DENSE_RESCUE_FLOORS.length);
  // A threshold of 0 would rescue every chunk; it is left out, and repeats collapse.
  assert.deepEqual(
    buildDenseRescueGrid(Array.from({ length: 5 }, () => ({ absolute: 0.7, margin: 0 }))).map((entry) => entry.threshold),
    DENSE_RESCUE_FLOORS.map(() => 0.7)
  );
});

test("the rescue pick passes the most answerable questions among those catching nearly as many unanswerable ones", () => {
  const counts = (answerablePassed, unanswerableCaught) => ({
    answerable: 100,
    answerablePassed,
    unanswerable: 100,
    unanswerableCaught,
  });
  const baseline = { counts: counts(50, 50) };
  const row = (mode, threshold, floor, answerablePassed, unanswerableCaught) => ({
    counts: counts(answerablePassed, unanswerableCaught),
    floor,
    mode,
    threshold,
  });
  const rows = [
    row("absolute", 0.7, 0, 62, 47), // catches too few
    row("margin", 0.05, 0, 58, 49),
    row("absolute", 0.75, 0.3, 58, 49),
    row("absolute", 0.75, 0, 58, 49),
    row("absolute", 0.8, 0, 58, 48), // exactly at the tolerance: qualifies
  ];

  assert.equal(DENSE_RESCUE_CATCH_TOLERANCE, 0.02);
  // Ties on pass go to the higher catch, then absolute, then the higher floor.
  assert.deepEqual(pickDenseRescue(rows, baseline), rows[2]);
  assert.deepEqual(pickDenseRescue([rows[0], rows[4]], baseline), rows[4]);
  assert.equal(pickDenseRescue([rows[0]], baseline), null);
  assert.equal(DENSE_RESCUE_MIN_GAIN, 0.03);
  assert.equal(denseRescueGainsEnough(rows[2], baseline), true);
  assert.equal(denseRescueGainsEnough(row("absolute", 0.75, 0.3, 53, 49), baseline), true);
  assert.equal(denseRescueGainsEnough(row("absolute", 0.75, 0.3, 52, 49), baseline), false);
  assert.equal(denseRescueGainsEnough(null, baseline), false);
});

test("the rescue rules count questions, so rates rounded to 4 decimals cannot misjudge the minimum gain", () => {
  // 5 and 29 of 800 report as 0.0063 and 0.0362: the rounded rates differ by
  // 0.0299, while 24 more questions of 800 is exactly the required 0.03.
  const baseline = summarizeGateSetting(
    Array.from({ length: 800 }, (_, index) => ({ confident: index < 5, evidenceAdmitted: false, shouldAbstain: false }))
  );
  const pick = {
    ...summarizeGateSetting(
      Array.from({ length: 800 }, (_, index) => ({ confident: index < 29, evidenceAdmitted: false, shouldAbstain: false }))
    ),
    floor: 0,
    mode: "absolute",
    threshold: 0.8,
  };

  assert.equal(baseline.answerablePass, 0.0063);
  assert.equal(pick.answerablePass, 0.0362);
  assert.ok(pick.answerablePass - baseline.answerablePass < DENSE_RESCUE_MIN_GAIN - 1e-9);
  assert.equal(denseRescueGainsEnough(pick, baseline), true);
});

test("a rescue is paired with the default gate question by question, with intervals by paper", () => {
  const decision = (paperId, shouldAbstain, confident, evidenceAdmitted = confident) => ({
    confident,
    evidenceAdmitted,
    paperId,
    shouldAbstain,
  });
  const baseline = [
    decision("a", false, false),
    decision("a", false, true),
    decision("b", false, false),
    decision("b", true, false),
    decision("c", true, false),
  ];
  const rescued = [
    decision("a", false, true),
    decision("a", false, true),
    decision("b", false, true, false),
    decision("b", true, true),
    decision("c", true, false),
  ];
  const paired = pairGateDecisions(rescued, baseline, { iterations: 200, seed: 3 });

  assert.equal(paired.answerablePass.delta, 0.6667);
  assert.deepEqual(paired.answerablePass.flips, { lost: 0, won: 2 });
  assert.equal(paired.answerablePass.questions, 3);
  assert.equal(paired.answerablePass.papers, 2);
  assert.equal(paired.answerableEvidencePass.delta, 0.3333);
  assert.equal(paired.unanswerableCatch.delta, -0.5);
  assert.deepEqual(paired.unanswerableCatch.flips, { lost: 1, won: 0 });
  assert.equal(paired.answerablePass.ci95ByPaper.length, 2);
  assert.ok(paired.answerablePass.ci95ByPaper[0] <= paired.answerablePass.ci95ByPaper[1]);
});

test("--dense-rescue names one configuration, and the gate environment never leaks a rescue", () => {
  assert.deepEqual(parseDenseRescueOption("margin:0.05:0.3"), { floor: 0.3, mode: "margin", threshold: 0.05 });
  assert.deepEqual(parseDenseRescueOption("absolute:0.71"), { floor: 0, mode: "absolute", threshold: 0.71 });

  for (const value of ["dense:0.5:0", "absolute:0:0", "absolute:1.2:0", "margin:0.1:2", "margin"]) {
    assert.throws(() => parseDenseRescueOption(value), /--dense-rescue takes/);
  }

  const previous = process.env.RAG_QA_DENSE_RESCUE;

  process.env.RAG_QA_DENSE_RESCUE = "margin";

  try {
    assert.equal(
      withGateEnv(DEFAULT_GATE, () => process.env.RAG_QA_DENSE_RESCUE),
      "off"
    );
    assert.deepEqual(
      withGateEnv({ ...DEFAULT_GATE, denseRescue: { floor: 0.3, mode: "absolute", threshold: 0.7 } }, () => [
        process.env.RAG_QA_DENSE_RESCUE,
        process.env.RAG_QA_DENSE_RESCUE_THRESHOLD,
        process.env.RAG_QA_DENSE_RESCUE_FLOOR,
      ]),
      ["absolute", "0.7", "0.3"]
    );
    assert.equal(process.env.RAG_QA_DENSE_RESCUE, "margin");
  } finally {
    if (previous === undefined) {
      delete process.env.RAG_QA_DENSE_RESCUE;
    } else {
      process.env.RAG_QA_DENSE_RESCUE = previous;
    }
  }
});

test("the reranker re-measure picks among the probability thresholds and the lexical gate on whole counts", () => {
  const counts = (answerablePassed, unanswerableCaught) => ({
    answerable: 800,
    answerablePassed,
    unanswerable: 272,
    unanswerableCaught,
  });
  const entry = (minRerankProbability, answerablePassed, unanswerableCaught) => {
    const rowCounts = counts(answerablePassed, unanswerableCaught);

    return { cost: Number(exactGateCost(rowCounts).toFixed(4)), counts: rowCounts, minRerankProbability };
  };
  const { minRerankProbability: _none, ...lexical } = entry(undefined, 480, 130);

  // 0.885 x refused answerable + 0.345 x answered unanswerable, from counts.
  assert.ok(Math.abs(exactGateCost(counts(400, 136)) - (0.885 * 0.5 + 0.345 * 0.5)) < 1e-12);
  assert.equal(RERANK_COST_TOLERANCE, 0.01);

  // Costs: 0.01 -> 0.3463, 0.02 -> 0.3605, 0.05 -> 0.3794, 0.2 -> 0.4329,
  // lexical -> 0.5341. Within 0.01 of the lowest only 0.01 qualifies.
  const rows = [entry(0.01, 730, 60), entry(0.02, 700, 75), entry(0.05, 660, 95), entry(0.2, 560, 140)];

  assert.equal(pickRerankGate(rows, lexical).minRerankProbability, 0.01);
  assert.equal(pickRerankGate(rows, lexical).gate, "rerank");

  // 0.01 -> 0.3463 and 0.02 -> 0.3498 are within 0.01: the one catching more wins.
  assert.equal(pickRerankGate([entry(0.01, 730, 60), entry(0.02, 720, 66)], lexical).minRerankProbability, 0.02);
  // An exact tie goes to the higher threshold.
  assert.equal(pickRerankGate([entry(0.01, 730, 60), entry(0.02, 730, 60)], lexical).minRerankProbability, 0.02);

  // The lexical gate competes, and wins when no threshold comes within 0.01 of it.
  const pick = pickRerankGate([entry(0.01, 500, 100), entry(0.5, 420, 140)], lexical);

  assert.equal(pick.gate, "lexical");
  assert.equal(pick.minRerankProbability, null);
});

test("the reranker re-measure's rule: each key in order, the tolerance inclusive, whole counts only", () => {
  // With 885 answerable and 345 unanswerable questions the cost is exactly
  // 1.23 - (passed + caught) / 1000, so differences are whole thousandths.
  const row = (minRerankProbability, answerablePassed, unanswerableCaught, cost = 0) => ({
    cost, // a rounded rate's cost the pick must not read
    counts: { answerable: 885, answerablePassed, unanswerable: 345, unanswerableCaught },
    minRerankProbability,
  });
  const lexical = { cost: 0, counts: { answerable: 885, answerablePassed: 400, unanswerable: 345, unanswerableCaught: 300 } };
  const threshold = (rows) => pickRerankGate(rows, lexical)?.minRerankProbability;

  // Exactly 0.01 above the lowest (0.230 against 0.240) still qualifies, and catches more.
  assert.equal(threshold([row(0.01, 800, 200), row(0.02, 780, 210)]), 0.02);
  // 0.011 above does not.
  assert.equal(threshold([row(0.01, 800, 200), row(0.02, 779, 210)]), 0.01);
  // Equal catch: the lower cost wins before the higher threshold.
  assert.equal(threshold([row(0.01, 800, 200), row(0.02, 795, 200)]), 0.01);
  // The `cost` field is ignored: a row that only looks cheap is not picked.
  assert.equal(threshold([row(0.01, 800, 200), row(0.5, 500, 210, -1)]), 0.01);
  // A run without one of the classes has no pick instead of a crash.
  const empty = { counts: { answerable: 10, answerablePassed: 5, unanswerable: 0, unanswerableCaught: 0 } };

  assert.equal(exactGateCost(empty.counts), null);
  assert.equal(pickRerankGate([{ ...empty, minRerankProbability: 0.02 }], empty), null);
});

test("the reranker re-measure prints its pick, its costs and every threshold against the lexical gate", () => {
  const cell = { ci95ByPaper: [0.01, 0.03], delta: 0.02, flips: { lost: 1, won: 9 } };
  const lines = formatRerankGateMarkdown({
    candidates: [
      { exactCost: 0.31, gate: "rerank", minRerankProbability: 0.02 },
      { exactCost: 0.45, gate: "lexical", minRerankProbability: null },
    ],
    costTolerance: 0.01,
    paired: [{ answerableEvidencePass: cell, answerablePass: cell, minRerankProbability: 0.02, unanswerableCatch: cell }],
    pick: { answerablePass: 0.8, exactCost: 0.3100004, gate: "rerank", minRerankProbability: 0.02, unanswerableCatch: 0.4 },
  }).join("\n");

  assert.match(lines, /threshold\): min probability 0\.02; answerable pass 0\.8, unanswerable caught 0\.4, cost from counts 0\.31\./);
  assert.match(lines, /Costs from counts, which the pick compares: 0\.02 0\.31, lexical 0\.45\./);
  assert.match(lines, /\| 0\.02 \| 0\.02 \[0\.01, 0\.03\] \(\+9 \/ -1\) \|/);
  assert.match(
    formatRerankGateMarkdown({ costTolerance: 0.01, paired: [], pick: null }).join("\n"),
    /No pick: the run has no answerable or no unanswerable questions\./
  );
});
