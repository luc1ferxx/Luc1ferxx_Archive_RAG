import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRerankSweepReport,
  getRerankSweepVariants,
  renderRerankSweepMarkdown,
} from "../evaluation/rerank-sweep.js";

const buildCompletedResult = ({
  variantId,
  ndcgAtK,
  recallAtK,
  mrr,
  precisionAtK = 0.2,
  noiseRateAtK = 0.8,
  averageResponseTimeMs = 10,
}) => ({
  variantId,
  status: "completed",
  summary: {
    runId: `${variantId}-run`,
    config: {
      embeddingProvider: "deterministic",
      rerankProvider: "heuristic",
    },
    metrics: {
      reranked: {
        ndcgAtK,
        precisionAtK,
        recallAtK,
        mrr,
        noiseRateAtK,
      },
      averageResponseTimeMs,
    },
  },
});

test("rerank sweep variants keep external providers opt-in", () => {
  const quickVariants = getRerankSweepVariants({ profile: "quick" });
  const fullVariants = getRerankSweepVariants({ profile: "full" });
  const externalVariants = getRerankSweepVariants({
    profile: "quick",
    includeOpenAI: true,
    includeCrossEncoder: true,
  });

  assert.ok(quickVariants.some((variant) => variant.id === "default_heuristic"));
  assert.ok(fullVariants.some((variant) => variant.id === "large_final_window"));
  assert.ok(!quickVariants.some((variant) => variant.embeddingProvider === "openai"));
  assert.ok(!fullVariants.some((variant) => variant.embeddingProvider === "openai"));
  assert.ok(externalVariants.some((variant) => variant.id === "openai_default"));
  assert.ok(externalVariants.some((variant) => variant.id === "cross_encoder_default"));
});

test("rerank sweep report ranks by reranked ranking quality", () => {
  const variants = getRerankSweepVariants({
    profile: "quick",
    variantIds: ["default_heuristic", "broad_topk"],
  });
  const report = buildRerankSweepReport({
    runId: "run-1",
    corpusPath: "evaluation/generated/arxiv-corpus.json",
    profile: "quick",
    variants,
    results: [
      buildCompletedResult({
        variantId: "default_heuristic",
        ndcgAtK: 0.5,
        recallAtK: 0.5,
        mrr: 0.5,
      }),
      buildCompletedResult({
        variantId: "broad_topk",
        ndcgAtK: 0.7,
        recallAtK: 0.6,
        mrr: 0.6,
      }),
    ],
  });

  assert.equal(report.bestVariantId, "broad_topk");
  assert.equal(report.results[0].variantId, "broad_topk");
  assert.ok(report.results[0].rankingScore > report.results[1].rankingScore);
});

test("rerank sweep markdown includes ranking metrics and failed variants", () => {
  const variants = getRerankSweepVariants({
    profile: "quick",
    variantIds: ["default_heuristic", "wide_candidates"],
  });
  const report = buildRerankSweepReport({
    runId: "run-2",
    corpusPath: "evaluation/generated/arxiv-corpus.json",
    profile: "quick",
    variants,
    results: [
      buildCompletedResult({
        variantId: "default_heuristic",
        ndcgAtK: 0.5,
        recallAtK: 0.5,
        mrr: 0.5,
      }),
      {
        variantId: "wide_candidates",
        status: "failed",
        error: "RAG_CROSS_ENCODER_ENDPOINT is required.",
      },
    ],
  });
  const markdown = renderRerankSweepMarkdown(report);

  assert.match(markdown, /# Rerank Ranking Sweep/);
  assert.match(markdown, /NDCG/);
  assert.match(markdown, /Recall/);
  assert.match(markdown, /default_heuristic/);
  assert.match(markdown, /Failed Variants/);
  assert.match(markdown, /RAG_CROSS_ENCODER_ENDPOINT is required/);
});
