import assert from "node:assert/strict";
import test from "node:test";
import {
  pairedRecallDeltas,
  summarizeRecallRows,
} from "../evaluation/run-qasper-retrieval-eval.mjs";

const row = (id, hits) => ({
  admitted: hits.includes("admitted"),
  hitAt1: hits.includes(1),
  hitAt3: hits.includes(3),
  hitAtAll: hits.includes("all"),
  id,
});

test("recall rates are per question", () => {
  assert.deepEqual(
    summarizeRecallRows([row("a", [1, 3, "all", "admitted"]), row("b", ["all"]), row("c", []), row("d", [3, "all"])]),
    { admitted: 0.25, hitAt1: 0.25, hitAt3: 0.5, hitAtAll: 0.75 }
  );
});

test("paired deltas compare the same questions only and bound the difference", () => {
  const after = [row("a", ["all"]), row("b", ["all"]), row("c", []), row("only-here", ["all"])];
  const before = [row("a", []), row("b", ["all"]), row("c", []), row("only-there", [])];
  const deltas = pairedRecallDeltas(after, before, { iterations: 500 });

  assert.equal(deltas.cases, 3);
  assert.equal(deltas.hitAtAll.delta, 0.3333);
  assert.ok(deltas.hitAtAll.ci95[0] >= 0 && deltas.hitAtAll.ci95[1] <= 1);
  assert.deepEqual(deltas.hitAt1, { ci95: [0, 0], delta: 0 });
});
