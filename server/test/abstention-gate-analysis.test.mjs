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
  gateCost,
  pairGateDecisions,
  parseDenseRescueOption,
  PARTIAL_BAND_GATE,
  pickDenseRescue,
  pickRerankThreshold,
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
  const baseline = { answerablePass: 0.5, unanswerableCatch: 0.5 };
  const row = (mode, threshold, floor, answerablePass, unanswerableCatch) => ({
    answerablePass,
    floor,
    mode,
    threshold,
    unanswerableCatch,
  });
  const rows = [
    row("absolute", 0.7, 0, 0.62, 0.47), // catches too few
    row("margin", 0.05, 0, 0.58, 0.49),
    row("absolute", 0.75, 0.3, 0.58, 0.49),
    row("absolute", 0.75, 0, 0.58, 0.49),
    row("absolute", 0.8, 0, 0.58, 0.48),
  ];

  assert.equal(DENSE_RESCUE_CATCH_TOLERANCE, 0.02);
  // Ties on pass go to the higher catch, then absolute, then the higher floor.
  assert.deepEqual(pickDenseRescue(rows, baseline), rows[2]);
  assert.equal(pickDenseRescue([rows[0]], baseline), null);
  assert.equal(DENSE_RESCUE_MIN_GAIN, 0.03);
  assert.equal(denseRescueGainsEnough(rows[2], baseline), true);
  assert.equal(denseRescueGainsEnough({ ...rows[2], answerablePass: 0.52 }, baseline), false);
  assert.equal(denseRescueGainsEnough(null, baseline), false);
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
