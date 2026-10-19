import assert from "node:assert/strict";
import test from "node:test";
import { describeRunConfigDifferences } from "../evaluation/eval-run-config.js";
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

test("admitted context size is averaged, and compared only where both runs measured it", () => {
  const sized = (id, hits, admittedChars) => ({ ...row(id, hits), admittedChars });
  const after = [sized("a", ["all"], 1200), sized("b", [], 800), sized("c", ["all"], 0)];

  assert.equal(summarizeRecallRows(after).admittedCharsMean, 666.7);
  assert.equal("admittedCharsMean" in summarizeRecallRows([row("a", [])]), false, "a report before sizes were recorded");

  // Against a report written before sizes were recorded: recall is still
  // paired, sizes are not compared at all.
  const old = [row("a", []), row("b", []), row("c", ["all"])];
  const againstOld = pairedRecallDeltas(after, old, { iterations: 200 });

  assert.equal(againstOld.cases, 3);
  assert.equal(againstOld.hitAtAll.delta, 0.3333);
  assert.equal("admittedChars" in againstOld, false);

  const before = [sized("a", ["all"], 900), sized("b", [], 900), row("c", ["all"])];
  const deltas = pairedRecallDeltas(after, before, { iterations: 200 });

  assert.deepEqual({ cases: deltas.admittedChars.cases, delta: deltas.admittedChars.delta }, { cases: 2, delta: 100 });
  assert.ok(deltas.admittedChars.ci95[0] <= 100 && deltas.admittedChars.ci95[1] >= 100);
  // Sizes draw their samples after the recall metrics, so those intervals
  // are what they were before sizes were compared.
  assert.deepEqual(
    deltas.hitAtAll,
    pairedRecallDeltas(
      after.map(({ admittedChars, ...rest }) => rest),
      before.map(({ admittedChars, ...rest }) => rest),
      { iterations: 200 }
    ).hitAtAll
  );
});

test("a comparison lists where the two runs' chunking or commit differ; an older report counts as unknown", () => {
  const chunking = { chunkerVersion: 2, overlap: 180, size: 900, strategy: "structured" };
  const config = { chunking, git: { changedPaths: 0, dirty: false, sha: "a".repeat(40) } };

  assert.deepEqual(describeRunConfigDifferences(config, structuredClone(config)), []);
  assert.deepEqual(
    describeRunConfigDifferences(config, { chunking: { ...chunking, chunkerVersion: 1 }, git: { sha: "b".repeat(40) } }),
    [
      { current: 2, field: "chunking.chunkerVersion", other: 1 },
      { current: "a".repeat(40), field: "git.sha", other: "b".repeat(40) },
    ]
  );
  // A report from before these fields, or a run where git could not say.
  assert.deepEqual(
    describeRunConfigDifferences(config, { corpus: "qasper-dev.json" }).map(({ field, other }) => [field, other]),
    [
      ["chunking.strategy", null],
      ["chunking.size", null],
      ["chunking.overlap", null],
      ["chunking.chunkerVersion", null],
      ["git.sha", null],
    ]
  );
  // Git could not say on either side: still unknown, so listed.
  assert.deepEqual(describeRunConfigDifferences({ chunking, git: null }, { chunking, git: null }), [
    { current: null, field: "git.sha", other: null },
  ]);

  // Uncommitted changes: the commit does not say which code ran, on either
  // side, whatever the counts.
  const dirty = (changedPaths) => ({ chunking, git: { changedPaths, dirty: true, sha: "a".repeat(40) } });

  assert.deepEqual(describeRunConfigDifferences(dirty(3), dirty(3)), [
    { current: 3, field: "git.changedPaths", other: 3 },
  ]);
  assert.deepEqual(describeRunConfigDifferences(config, dirty(5)), [
    { current: 0, field: "git.changedPaths", other: 5 },
  ]);
  assert.deepEqual(
    describeRunConfigDifferences(dirty(2), { chunking, git: { sha: "b".repeat(40) } }).map(({ field }) => field),
    ["git.sha", "git.changedPaths"]
  );
});
