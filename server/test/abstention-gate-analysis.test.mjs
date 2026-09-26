import assert from "node:assert/strict";
import test from "node:test";
import {
  computeAuc,
  COVERAGE_GRID,
  DEFAULT_GATE,
  RELEVANCE_GRID,
  summarizeGateSetting,
} from "../evaluation/run-abstention-gate-analysis.mjs";
import {
  DEFAULT_MIN_QA_QUERY_TERM_COVERAGE,
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
});
