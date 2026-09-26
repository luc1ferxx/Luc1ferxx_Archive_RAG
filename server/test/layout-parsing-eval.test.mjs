import assert from "node:assert/strict";
import test from "node:test";
import {
  containsGoldSpan,
  pairedDelta,
  selectTablePapers,
} from "../evaluation/run-layout-parsing-eval.mjs";

const qa = ({ evidence = [], unanswerable = false }) => ({
  answers: [{ answer: { evidence, extractive_spans: [], unanswerable } }],
  question: "q",
});

test("papers are ranked by answerable table-evidence questions, ties by id", () => {
  const table = qa({ evidence: ["FLOAT SELECTED: Table 2: Results."] });
  const qasper = {
    "1901.00002": { qas: [table, table] },
    "1901.00001": { qas: [table, table, qa({ evidence: ["a paragraph"] })] },
    "1901.00003": { qas: [table] },
    "1901.00004": { qas: [qa({ evidence: ["FLOAT SELECTED: Table 1"], unanswerable: true })] },
    "1901.00005": { qas: [qa({ evidence: ["FLOAT SELECTED: Figure 1: Loss."] })] },
  };

  assert.deepEqual(selectTablePapers(qasper, 5), ["1901.00001", "1901.00002", "1901.00003"]);
  assert.deepEqual(selectTablePapers(qasper, 1), ["1901.00001"]);
});

test("a gold span matches whole normalized tokens only", () => {
  const row = "Embeddings: GloVe; OurNepali Raw Test: 76.86";

  assert.equal(containsGoldSpan(row, ["76.86"]), true);
  assert.equal(containsGoldSpan(row, ["the GloVe"]), true, "articles and case are normalized away");
  assert.equal(containsGoldSpan(row, ["6.86"]), false, "no partial-token match");
  assert.equal(containsGoldSpan(row, ["", "fastText"]), false);
});

test("paired deltas use only questions both parsers scored", () => {
  const rows = [
    { docling: { f1: 1, inContext: true }, pdfjs: { f1: 0, inContext: false } },
    { docling: { f1: 0.5, inContext: null }, pdfjs: { f1: 0.5, inContext: null } },
  ];
  const f1 = pairedDelta(rows, "f1", { iterations: 200 });
  const inContext = pairedDelta(rows, "inContext", { iterations: 200 });

  assert.equal(f1.cases, 2);
  assert.equal(f1.delta, 0.5);
  assert.ok(f1.ci95[0] >= 0 && f1.ci95[1] <= 1);
  assert.deepEqual(inContext, { cases: 1, ci95: [1, 1], delta: 1 });
  assert.deepEqual(pairedDelta([], "f1"), { cases: 0, ci95: null, delta: null });
});
