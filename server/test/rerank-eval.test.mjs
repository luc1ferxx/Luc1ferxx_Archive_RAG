import test from "node:test";
import assert from "node:assert/strict";
import { calculateRankingMetrics } from "../evaluation/run-rerank-eval.mjs";

const buildResult = ({ docId, pageNumber, chunkIndex = pageNumber, score = 1 }) => ({
  document: {
    id: `${docId}:${chunkIndex}`,
    pageContent: `Page ${pageNumber}`,
    metadata: {
      docId,
      fileName: `${docId}.pdf`,
      pageNumber,
      chunkIndex,
    },
  },
  score,
});

test("rerank eval metrics reward relevant evidence near the top", () => {
  const docKeyByDocId = new Map([
    ["doc-a", "alpha"],
    ["doc-b", "beta"],
  ]);
  const expectedUnits = [
    {
      key: "alpha:2",
      docKey: "alpha",
      pageNumber: 2,
    },
    {
      key: "beta:1",
      docKey: "beta",
      pageNumber: 1,
    },
  ];
  const metrics = calculateRankingMetrics({
    ranking: [
      buildResult({ docId: "doc-a", pageNumber: 2 }),
      buildResult({ docId: "doc-a", pageNumber: 1 }),
      buildResult({ docId: "doc-b", pageNumber: 1 }),
    ],
    expectedUnits,
    docKeyByDocId,
    k: 3,
  });

  assert.equal(metrics.precisionAtK, 0.6667);
  assert.equal(metrics.recallAtK, 1);
  assert.equal(metrics.mrr, 1);
  assert.ok(metrics.ndcgAtK > 0.8);
  assert.equal(metrics.noiseRateAtK, 0.3333);
});

test("rerank eval metrics return zero MRR when no exact evidence is retrieved", () => {
  const metrics = calculateRankingMetrics({
    ranking: [buildResult({ docId: "doc-a", pageNumber: 1 })],
    expectedUnits: [
      {
        key: "alpha:2",
        docKey: "alpha",
        pageNumber: 2,
      },
    ],
    docKeyByDocId: new Map([["doc-a", "alpha"]]),
    k: 1,
  });

  assert.equal(metrics.precisionAtK, 0);
  assert.equal(metrics.recallAtK, 0);
  assert.equal(metrics.mrr, 0);
  assert.equal(metrics.noiseRateAtK, 1);
});
