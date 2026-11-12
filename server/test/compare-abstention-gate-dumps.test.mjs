import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  GATE_SETTING_FIELDS,
  assertComparableGateDumps,
  compareGateDumps,
  describeGateDumpRows,
  pairGateDumpRows,
  summarizeRetrievalMs,
} from "../evaluation/compare-abstention-gate-dumps.mjs";
import { describeRetrievalConfig } from "../evaluation/eval-run-config.js";
import { assessQaConfidence, selectQaContext } from "../rag/confidence.js";
import { QA_CONTEXT_MIN_COVERAGE } from "../rag/document-rag-execution.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = Object.freeze({
  assessQaConfidence,
  minContextCoverage: QA_CONTEXT_MIN_COVERAGE,
  selectQaContext,
  topK: 10,
});

// A candidate on `page` whose stored query-term coverage is `coverage`.
const candidate = (paper, page, coverage, vectorScore = 0.6) => ({
  document: {
    metadata: { chunkIndex: page, docId: paper, fileName: `${paper}.pdf`, pageNumber: page },
    pageContent: `Paragraph ${page} of ${paper}.`,
  },
  keywordScore: coverage,
  score: 0.5,
  vectorScore,
});
const testCase = (id, paper, { pages = [], shouldAbstain = false } = {}) => ({
  docKeys: [paper],
  expectedEvidence: shouldAbstain ? [] : [{ pages }],
  id,
  question: "Which datasets do they evaluate on?",
  shouldAbstain,
});
const dumpOf = (cases, retrieval) => ({
  cases,
  config: { retrieval },
  generatedAt: "2026-11-12T00:00:00.000Z",
  reportType: "abstention-gate-candidates",
});

test("rows: evidence among the candidates, at rank 1, in the top 3, admitted, and in the model's context", () => {
  const [row, refused] = describeGateDumpRows(
    dumpOf([
      {
        evidenceRequirementCount: 1,
        // Page 2 clears the coverage floor and opens the gate; the evidence
        // (page 5) does not, so it is not admitted, but the context selection
        // lets it in as a further candidate.
        results: [candidate("p1", 2, 0.6), candidate("p1", 3, 0.1), candidate("p1", 5, 0.1)],
        testCase: testCase("q1", "p1", { pages: [5] }),
      },
      {
        evidenceRequirementCount: 1,
        results: [candidate("p2", 1, 0.1), candidate("p2", 4, 0)],
        testCase: testCase("q2", "p2", { pages: [4] }),
      },
    ]),
    GATE
  );

  assert.deepEqual(row, {
    admitted: false,
    candidates: true,
    confident: true,
    context: true,
    paperId: "p1",
    rank1: false,
    shouldAbstain: false,
    top3: true,
  });
  // The gate refuses: the evidence is among the candidates but reaches no context.
  assert.equal(refused.confident, false);
  assert.equal(refused.candidates, true);
  assert.equal(refused.context, false);
  assert.equal(refused.admitted, false);
});

test("pairs: arm minus base over the selected rows, flips counted, papers resampled", () => {
  const base = [
    { paperId: "a", value: 0 },
    { paperId: "a", value: 1 },
    { paperId: "b", value: 0 },
    { paperId: "c", value: 1, skip: true },
  ];
  const arm = [
    { paperId: "a", value: 1 },
    { paperId: "a", value: 1 },
    { paperId: "b", value: 0 },
    { paperId: "c", value: 0, skip: true },
  ];
  const paired = pairGateDumpRows(base, arm, { iterations: 200, keep: (row) => !row.skip, outcome: (row) => row.value });

  assert.equal(paired.base, 0.3333);
  assert.equal(paired.arm, 0.6667);
  assert.equal(paired.delta, 0.3333);
  assert.deepEqual(paired.flips, { lost: 0, won: 1 });
  assert.equal(paired.papers, 2);
  assert.equal(paired.questions, 3);
  assert.equal(paired.ci95ByPaper.length, 2);
  assert.equal(pairGateDumpRows(base, arm, { keep: () => false, outcome: (row) => row.value }), null);
});

test("two files are compared only over the same questions and the gate settings they ran with", async () => {
  const retrieval = await describeRetrievalConfig();
  const cases = [{ evidenceRequirementCount: 1, results: [], testCase: testCase("q1", "p1", { pages: [1] }) }];
  const same = dumpOf(cases, retrieval);

  assert.doesNotThrow(() => assertComparableGateDumps(same, dumpOf(cases, { ...retrieval, qaQueryExpansion: "hyde" }), retrieval));
  assert.throws(
    () => assertComparableGateDumps(same, dumpOf([{ ...cases[0], testCase: testCase("q2", "p1") }], retrieval), retrieval),
    /same questions in the same order/
  );
  assert.throws(() => assertComparableGateDumps(same, { ...same, reportType: "other" }, retrieval), /not a candidates file/);
  assert.throws(() => assertComparableGateDumps(same, { ...same, config: {} }, retrieval), /recorded no retrieval settings/);

  for (const field of GATE_SETTING_FIELDS) {
    assert.throws(
      () => assertComparableGateDumps(same, dumpOf(cases, { ...retrieval, [field]: "changed" }), retrieval),
      new RegExp(field),
      field
    );
  }
});

test("the comparison: every metric, the retrieval time of each file", () => {
  const cases = (evidencePage) => [
    {
      evidenceRequirementCount: 1,
      results: [candidate("p1", 2, 0.6), candidate("p1", evidencePage, 0.1)],
      retrievalMs: evidencePage === 5 ? 1200 : 10,
      testCase: testCase("q1", "p1", { pages: [5] }),
    },
    {
      evidenceRequirementCount: 1,
      results: [candidate("p2", 1, 0.1)],
      retrievalMs: evidencePage === 5 ? 800 : 12,
      testCase: testCase("q2", "p2", { shouldAbstain: true }),
    },
  ];
  const comparison = compareGateDumps(dumpOf(cases(7), { topK: 10 }), dumpOf(cases(5), { topK: 10 }), {
    gate: GATE,
    iterations: 100,
  });

  assert.deepEqual(comparison.questions, { answerable: 1, unanswerable: 1 });
  assert.equal(comparison.metrics.evidenceAmongCandidates.delta, 1);
  assert.equal(comparison.metrics.evidenceInContext.delta, 1);
  assert.equal(comparison.metrics.evidenceInTop3.delta, 1);
  assert.equal(comparison.metrics.evidenceAtRank1.delta, 0);
  assert.equal(comparison.metrics.gateAnswerablePass.delta, 0);
  assert.equal(comparison.metrics.gateUnanswerableCatch.base, 1);
  assert.deepEqual(comparison.retrievalMs.arm, { max: 1200, mean: 1000, p50: 800, p95: 1200, questions: 2 });
  assert.equal(summarizeRetrievalMs(dumpOf([{ results: [] }], {})), null);
});

test("the command reads two files and prints the comparison without reading server/.env", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "compare-gate-dumps-"));

  try {
    const retrieval = await describeRetrievalConfig();
    const cases = [
      {
        evidenceRequirementCount: 1,
        results: [candidate("p1", 2, 0.6), candidate("p1", 5, 0.1)],
        retrievalMs: 5,
        testCase: testCase("q1", "p1", { pages: [5] }),
      },
    ];
    const basePath = path.join(tempRoot, "base.json");
    const armPath = path.join(tempRoot, "arm.json");

    writeFileSync(basePath, JSON.stringify(dumpOf(cases, retrieval)));
    writeFileSync(armPath, JSON.stringify(dumpOf(cases, retrieval)));

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["evaluation/compare-abstention-gate-dumps.mjs", basePath, armPath, "--iterations", "50", "--json"],
      { cwd: SERVER, env: { ...process.env, DOTENV_CONFIG_PATH: path.join(tempRoot, "missing.env") } }
    );
    const printed = JSON.parse(stdout);

    assert.equal(printed.base, "base.json");
    assert.equal(printed.metrics.evidenceInContext.delta, 0);
    assert.equal(printed.metrics.evidenceInContext.arm, 1);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
