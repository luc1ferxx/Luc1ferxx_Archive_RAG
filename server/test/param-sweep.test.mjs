import test from "node:test";
import assert from "node:assert/strict";
import {
  buildParamSweepReport,
  getParamSweepVariants,
  renderParamSweepMarkdown,
} from "../evaluation/param-sweep.js";

test("param sweep default variants cover topK, overlap, rerank, and hybrid settings", () => {
  const variants = getParamSweepVariants({
    profile: "quick",
  });
  const variantIds = variants.map((variant) => variant.id);
  const serializedVariants = JSON.stringify(variants);

  assert.deepEqual(new Set(variantIds).size, variantIds.length);
  assert.ok(variantIds.includes("baseline"));
  assert.match(serializedVariants, /RAG_RETRIEVAL_TOP_K/);
  assert.match(serializedVariants, /RAG_CHUNK_OVERLAP/);
  assert.match(serializedVariants, /RAG_RERANK_ENABLED/);
  assert.match(serializedVariants, /RAG_HYBRID_ENABLED/);
  assert.match(serializedVariants, /RAG_HYBRID_DENSE_WEIGHT/);
  assert.match(serializedVariants, /RAG_HYBRID_SPARSE_WEIGHT/);
});

test("param sweep report ranks completed variants by quality and latency", () => {
  const variants = [
    {
      id: "baseline",
      label: "Baseline",
      env: {},
    },
    {
      id: "broad_topk",
      label: "Broad topK",
      env: {
        RAG_RETRIEVAL_TOP_K: "8",
      },
    },
  ];
  const report = buildParamSweepReport({
    runId: "param-sweep-test",
    createdAt: "2026-06-09T00:00:00.000Z",
    corpusPath: "evaluation/synthetic-corpus.json",
    profile: "quick",
    variants,
    results: [
      {
        variantId: "baseline",
        status: "completed",
        summary: {
          metrics: {
            overallPassRate: 1,
            qaPageHitRate: 1,
            comparePageHitRate: 1,
            claimSupportHitRate: 1,
            averageResponseTimeMs: 200,
            averageCitationCount: 2,
          },
        },
      },
      {
        variantId: "broad_topk",
        status: "completed",
        summary: {
          metrics: {
            overallPassRate: 1,
            qaPageHitRate: 1,
            comparePageHitRate: 1,
            claimSupportHitRate: 1,
            averageResponseTimeMs: 100,
            averageCitationCount: 3,
          },
        },
      },
    ],
  });

  assert.equal(report.bestVariantId, "broad_topk");
  assert.deepEqual(
    report.results.map((result) => result.rank),
    [1, 2]
  );
  assert.deepEqual(
    report.results.map((result) => result.variantId),
    ["broad_topk", "baseline"]
  );

  const markdown = renderParamSweepMarkdown(report);

  assert.match(markdown, /# RAG Parameter Sweep/);
  assert.match(markdown, /broad_topk/);
  assert.match(markdown, /RAG_RETRIEVAL_TOP_K=8/);
  assert.match(markdown, /Best variant: `broad_topk`/);
});
