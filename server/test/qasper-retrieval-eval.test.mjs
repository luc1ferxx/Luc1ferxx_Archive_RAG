import assert from "node:assert/strict";
import test from "node:test";
import { describeRunConfigDifferences } from "../evaluation/eval-run-config.js";
import * as bootstraps from "../evaluation/paired-bootstrap.js";
import {
  assertComparableSample,
  countSparseOnlyCandidates,
  describeEvidenceHit,
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

test("the first evidence hit records its position and the rank each route gave it", () => {
  const candidate = (pageNumber, ranks = {}) => ({ document: { metadata: { pageNumber } }, ...ranks });

  // Fused results: the first candidate on an evidence page, with the ranks
  // the dense and sparse routes gave it (null for a route that did not
  // return it).
  assert.deepEqual(
    describeEvidenceHit(
      [candidate(2, { denseRank: 1, sparseRank: 3 }), candidate(7, { denseRank: null, sparseRank: 1 }), candidate(7, { denseRank: 4, sparseRank: 2 })],
      [7, 9]
    ),
    { hitDenseRank: null, hitRank: 2, hitSparseRank: 1 }
  );
  assert.deepEqual(describeEvidenceHit([candidate(7, { denseRank: 9, sparseRank: 2 })], new Set([7])), {
    hitDenseRank: 9,
    hitRank: 1,
    hitSparseRank: 2,
  });
  // A dense-only route's results carry no ranks; a page read through loc.
  assert.deepEqual(describeEvidenceHit([{ document: { metadata: { loc: { pageNumber: 3 } } } }], [3]), {
    hitDenseRank: null,
    hitRank: 1,
    hitSparseRank: null,
  });
  // No evidence among the candidates, or no candidates at all.
  assert.deepEqual(describeEvidenceHit([candidate(1), candidate(2)], [5]), {
    hitDenseRank: null,
    hitRank: null,
    hitSparseRank: null,
  });
  assert.deepEqual(describeEvidenceHit([], [5]), { hitDenseRank: null, hitRank: null, hitSparseRank: null });
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
  assert.deepEqual(deltas.hitAtAll.flips, { down: 0, up: 1 });
  assert.deepEqual(deltas.hitAt1, { ci95: [0, 0], delta: 0, flips: { down: 0, up: 0 } });
  // Rows without a paper: no interval by paper, no paper count.
  assert.equal("ci95ByPaper" in deltas.hitAtAll, false);
  assert.equal("papers" in deltas, false);
});

test("when every row names its paper, each metric also gets the interval that resamples papers", () => {
  const paper = (id, docKey, hits) => ({ ...row(id, hits), docKey });
  // Two papers of three questions each: the questions of one paper move
  // together, so resampling papers must not treat them as independent.
  const after = [
    paper("a1", "p1", ["all"]), paper("a2", "p1", ["all"]), paper("a3", "p1", ["all"]),
    paper("b1", "p2", []), paper("b2", "p2", []), paper("b3", "p2", []),
  ];
  const before = after.map(({ docKey, ...rest }) => ({ ...rest, docKey, hitAtAll: false }));
  const deltas = pairedRecallDeltas(after, before, { iterations: 400 });

  assert.equal(deltas.cases, 6);
  assert.equal(deltas.papers, 2);
  assert.equal(deltas.hitAtAll.delta, 0.5);
  assert.deepEqual(deltas.hitAtAll.flips, { down: 0, up: 3 });
  // Over papers the mean is 0, 0.5 or 1 (which papers were drawn); over
  // questions it is a finer lattice.
  assert.ok(deltas.hitAtAll.ci95ByPaper.every((bound) => [0, 0.5, 1].includes(bound)), String(deltas.hitAtAll.ci95ByPaper));
  assert.deepEqual(deltas.hitAt1.ci95ByPaper, [0, 0]);
  // The question-level intervals are what they were before papers were
  // resampled (the paper draws come after).
  const unclustered = pairedRecallDeltas(
    after.map(({ docKey, ...rest }) => rest),
    before.map(({ docKey, ...rest }) => rest),
    { iterations: 400 }
  );

  assert.deepEqual(deltas.hitAtAll.ci95, unclustered.hitAtAll.ci95);
  // One row without a paper: nothing by paper.
  const partial = pairedRecallDeltas([...after.slice(0, 5), row("b3", [])], before, { iterations: 100 });

  assert.equal("ci95ByPaper" in partial.hitAtAll, false);
  assert.equal("papers" in partial, false);
});

test("the paper bootstrap equals the question bootstrap when every paper has one question", () => {
  const { bootstrapClusterMeanInterval, bootstrapMeanInterval, createSeededRandom } = bootstraps;
  const diffs = [1, 0, -1, 1, 1, 0, 0, 1, -1, 1];

  assert.deepEqual(
    bootstrapClusterMeanInterval(diffs.map((diff) => [diff]), { iterations: 300, random: createSeededRandom(7) }),
    bootstrapMeanInterval(diffs, { iterations: 300, random: createSeededRandom(7) })
  );
  // Constant clusters give a point interval; nothing to resample gives none.
  assert.deepEqual(bootstrapClusterMeanInterval([[1, 1], [1]], { iterations: 50 }), [1, 1]);
  assert.equal(bootstrapClusterMeanInterval([[], []], { iterations: 50 }), null);
});

test("a comparison refuses a report from another sample", () => {
  const config = { cases: 400, corpus: "qasper-train.json", seed: 11 };

  assert.doesNotThrow(() => assertComparableSample(config, structuredClone(config)));
  // A report from before these fields is not refused on them.
  assert.doesNotThrow(() => assertComparableSample(config, {}));
  assert.doesNotThrow(() => assertComparableSample(config, { corpus: "qasper-train.json" }));
  assert.throws(() => assertComparableSample(config, { ...config, seed: 1 }, { label: "B.json" }), /B\.json ran seed 1, this run 11/);
  assert.throws(() => assertComparableSample(config, { ...config, corpus: "qasper-dev.json" }), /corpus/);
  assert.throws(() => assertComparableSample(config, { ...config, cases: 200 }), /cases/);
});

test("sparse-only candidates are counted from the ranks the routes stamped, with the dense-only route's provenance as the fallback", () => {
  const fused = (denseRank, sparseRank) => ({ document: { metadata: { pageNumber: 1 } }, denseRank, sparseRank });
  const denseOnly = (rank, pageNumber) => ({
    document: { metadata: { pageNumber } },
    provenance: { routes: [{ rank, route: "dense", score: 0.5 }] },
  });

  assert.equal(countSparseOnlyCandidates([fused(1, 2), fused(2, null), fused(null, 1), fused(null, 3)]), 2);
  assert.equal(countSparseOnlyCandidates([denseOnly(1, 5), denseOnly(2, 2)]), 0);
  assert.equal(countSparseOnlyCandidates([]), 0);
  assert.deepEqual(describeEvidenceHit([denseOnly(1, 5), denseOnly(2, 2)], [2]), {
    hitDenseRank: 2,
    hitRank: 2,
    hitSparseRank: null,
  });
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

test("a comparison lists the retrieval settings that differ, and says when only one run recorded them", () => {
  const chunking = { chunkerVersion: 2, overlap: 180, size: 900, strategy: "structured" };
  const git = { changedPaths: 0, dirty: false, sha: "a".repeat(40) };
  const retrieval = {
    bm25B: 0.75,
    bm25K1: 1.2,
    denseWeight: 0.65,
    fusion: "rrf",
    hybridEnabled: true,
    maxQueryRequirements: 4,
    minQaQueryTermCoverage: 0.51,
    minRelevanceScore: 0.32,
    qaAnswerVerdict: false,
    qaGateInflection: false,
    qaMinRerankProbability: 0.02,
    queryDecomposition: true,
    rerankCandidateMultiplier: 3,
    rerankEnabled: false,
    rerankProvider: "heuristic",
    rerankWeight: 0.6,
    route: "hybrid",
    rrfK: 60,
    sparseTopK: 8,
    sparseWeight: 0.35,
    topK: 6,
  };
  const config = { chunking, git, retrieval };

  assert.deepEqual(describeRunConfigDifferences(config, structuredClone(config)), []);
  // Two arms of a sweep: only the settings that differ, in the route's order.
  assert.deepEqual(
    describeRunConfigDifferences(config, {
      ...config,
      retrieval: { ...retrieval, denseWeight: 0.5, rrfK: 5, sparseWeight: 0.5 },
    }),
    [
      { current: 60, field: "retrieval.rrfK", other: 5 },
      { current: 0.65, field: "retrieval.denseWeight", other: 0.5 },
      { current: 0.35, field: "retrieval.sparseWeight", other: 0.5 },
    ]
  );
  // A report from before the field: one entry, not twenty-one unknowns.
  assert.deepEqual(describeRunConfigDifferences(config, { chunking, git }), [
    { current: "recorded", field: "retrieval", other: null },
  ]);
  assert.deepEqual(describeRunConfigDifferences({ chunking, git }, config), [
    { current: null, field: "retrieval", other: "recorded" },
  ]);
  // Neither recorded it (answer reports): nothing to say.
  assert.deepEqual(describeRunConfigDifferences({ chunking, git }, { chunking, git }), []);
});
