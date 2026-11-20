import assert from "node:assert/strict";
import test from "node:test";
import {
  computeAuc,
  COVERAGE_GRID,
  DEFAULT_GATE,
  exactGateCost,
  formatRerankGateMarkdown,
  gateCost,
  pairGateDecisions,
  PARTIAL_BAND_GATE,
  pickRerankGate,
  pickRerankThreshold,
  RERANK_COST_TOLERANCE,
  RELEVANCE_GRID,
  summarizeGateSetting,
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

test("a gate setting is paired with the default gate question by question, with intervals by paper", () => {
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
  const other = [
    decision("a", false, true),
    decision("a", false, true),
    decision("b", false, true, false),
    decision("b", true, true),
    decision("c", true, false),
  ];
  const paired = pairGateDecisions(other, baseline, { iterations: 200, seed: 3 });

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
