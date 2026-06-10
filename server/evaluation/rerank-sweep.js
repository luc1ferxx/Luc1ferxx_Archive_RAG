export const RERANK_SWEEP_BASE_VARIANTS = [
  {
    id: "default_heuristic",
    label: "Default heuristic",
    description: "Current deterministic embedding and heuristic rerank defaults.",
    embeddingProvider: "deterministic",
    topK: 6,
    topKPerDoc: 3,
    candidateMultiplier: 3,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.6",
    },
  },
  {
    id: "broad_topk",
    label: "Broad topK",
    description: "Keep more final evidence to improve recall.",
    embeddingProvider: "deterministic",
    topK: 10,
    topKPerDoc: 5,
    candidateMultiplier: 3,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.6",
    },
  },
  {
    id: "wide_candidates",
    label: "Wide candidates",
    description: "Keep the same final top-k but expand the rerank candidate pool.",
    embeddingProvider: "deterministic",
    topK: 6,
    topKPerDoc: 3,
    candidateMultiplier: 6,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.6",
    },
  },
  {
    id: "strong_rerank_weight",
    label: "Strong rerank weight",
    description: "Increase heuristic rerank influence over the original retrieval score.",
    embeddingProvider: "deterministic",
    topK: 6,
    topKPerDoc: 3,
    candidateMultiplier: 4,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.85",
    },
  },
  {
    id: "hybrid_weighted_sparse",
    label: "Hybrid weighted sparse",
    description: "Use weighted dense+sparse retrieval with a stronger sparse signal.",
    embeddingProvider: "deterministic",
    topK: 8,
    topKPerDoc: 4,
    candidateMultiplier: 4,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.65",
      RAG_HYBRID_ENABLED: "true",
      RAG_HYBRID_FUSION: "weighted",
      RAG_HYBRID_DENSE_WEIGHT: "0.45",
      RAG_HYBRID_SPARSE_WEIGHT: "0.55",
      RAG_SPARSE_TOP_K: "12",
    },
  },
  {
    id: "hybrid_rrf",
    label: "Hybrid RRF",
    description: "Use reciprocal rank fusion for dense+sparse retrieval.",
    embeddingProvider: "deterministic",
    topK: 8,
    topKPerDoc: 4,
    candidateMultiplier: 4,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.65",
      RAG_HYBRID_ENABLED: "true",
      RAG_HYBRID_FUSION: "rrf",
      RAG_RRF_K: "30",
      RAG_SPARSE_TOP_K: "12",
    },
  },
];

export const RERANK_SWEEP_OPENAI_VARIANTS = [
  {
    id: "openai_default",
    label: "OpenAI embedding default",
    description: "Use production OpenAI embeddings with heuristic rerank defaults.",
    embeddingProvider: "openai",
    topK: 6,
    topKPerDoc: 3,
    candidateMultiplier: 3,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.6",
    },
  },
  {
    id: "openai_hybrid_weighted",
    label: "OpenAI embedding hybrid",
    description: "Use OpenAI embeddings with weighted dense+sparse retrieval.",
    embeddingProvider: "openai",
    topK: 8,
    topKPerDoc: 4,
    candidateMultiplier: 4,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.65",
      RAG_HYBRID_ENABLED: "true",
      RAG_HYBRID_FUSION: "weighted",
      RAG_HYBRID_DENSE_WEIGHT: "0.55",
      RAG_HYBRID_SPARSE_WEIGHT: "0.45",
      RAG_SPARSE_TOP_K: "12",
    },
  },
];

export const RERANK_SWEEP_FULL_LOCAL_VARIANTS = [
  {
    id: "broad_topk_wide_candidates",
    label: "Broad topK wide candidates",
    description: "Increase both final evidence count and candidate pool.",
    embeddingProvider: "deterministic",
    topK: 10,
    topKPerDoc: 5,
    candidateMultiplier: 6,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.65",
    },
  },
  {
    id: "large_final_window",
    label: "Large final window",
    description: "Expose whether remaining misses are recall-window misses.",
    embeddingProvider: "deterministic",
    topK: 12,
    topKPerDoc: 6,
    candidateMultiplier: 4,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.6",
    },
  },
  {
    id: "hybrid_weighted_dense",
    label: "Hybrid weighted dense",
    description: "Use weighted dense+sparse retrieval with a stronger dense signal.",
    embeddingProvider: "deterministic",
    topK: 8,
    topKPerDoc: 4,
    candidateMultiplier: 4,
    env: {
      RAG_RERANK_PROVIDER: "heuristic",
      RAG_RERANK_WEIGHT: "0.65",
      RAG_HYBRID_ENABLED: "true",
      RAG_HYBRID_FUSION: "weighted",
      RAG_HYBRID_DENSE_WEIGHT: "0.65",
      RAG_HYBRID_SPARSE_WEIGHT: "0.35",
      RAG_SPARSE_TOP_K: "12",
    },
  },
];

export const RERANK_SWEEP_CROSS_ENCODER_VARIANTS = [
  {
    id: "cross_encoder_default",
    label: "Cross-encoder default",
    description: "Use deterministic embeddings with HTTP cross-encoder rerank.",
    embeddingProvider: "deterministic",
    topK: 6,
    topKPerDoc: 3,
    candidateMultiplier: 4,
    env: {
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_RERANK_WEIGHT: "0.75",
    },
  },
  {
    id: "openai_cross_encoder",
    label: "OpenAI + cross-encoder",
    description: "Use OpenAI embeddings plus HTTP cross-encoder rerank.",
    embeddingProvider: "openai",
    topK: 8,
    topKPerDoc: 4,
    candidateMultiplier: 4,
    env: {
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_RERANK_WEIGHT: "0.75",
      RAG_HYBRID_ENABLED: "true",
      RAG_HYBRID_FUSION: "weighted",
      RAG_HYBRID_DENSE_WEIGHT: "0.55",
      RAG_HYBRID_SPARSE_WEIGHT: "0.45",
      RAG_SPARSE_TOP_K: "12",
    },
  },
];

export const getRerankSweepVariants = ({
  profile = "quick",
  variantIds = [],
  includeOpenAI = false,
  includeCrossEncoder = false,
} = {}) => {
  const normalizedProfile = String(profile ?? "quick").trim().toLowerCase();
  const variants = [...RERANK_SWEEP_BASE_VARIANTS];

  if (!["quick", "full"].includes(normalizedProfile)) {
    throw new Error(`Unknown rerank sweep profile: ${profile}`);
  }

  if (normalizedProfile === "full") {
    variants.push(...RERANK_SWEEP_FULL_LOCAL_VARIANTS);
  }

  if (includeOpenAI) {
    variants.push(...RERANK_SWEEP_OPENAI_VARIANTS);
  }

  if (includeCrossEncoder) {
    variants.push(...RERANK_SWEEP_CROSS_ENCODER_VARIANTS);
  }

  const requestedIds = new Set(
    variantIds.map((variantId) => String(variantId ?? "").trim()).filter(Boolean)
  );

  return (requestedIds.size > 0
    ? variants.filter((variant) => requestedIds.has(variant.id))
    : variants
  ).map((variant) => ({
    ...variant,
    env: {
      ...variant.env,
    },
  }));
};

const toNumber = (value, fallbackValue = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallbackValue;

const renderNumber = (value) =>
  Number.isFinite(Number(value)) ? Number(value).toFixed(4) : "N/A";

const renderPercent = (value) =>
  Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "N/A";

export const renderRerankVariantEnv = (env = {}) => {
  const entries = Object.entries(env);

  return entries.length === 0
    ? "defaults"
    : entries.map(([key, value]) => `${key}=${value}`).join(", ");
};

const calculateRankingScore = (metrics = {}) => {
  const reranked = metrics.reranked ?? {};
  const noiseRate = toNumber(reranked.noiseRateAtK, 1);

  return Number(
    (
      toNumber(reranked.ndcgAtK) * 40 +
      toNumber(reranked.recallAtK) * 25 +
      toNumber(reranked.mrr) * 20 +
      toNumber(reranked.precisionAtK) * 10 +
      Math.max(0, 1 - noiseRate) * 5
    ).toFixed(4)
  );
};

const normalizeResult = ({ result = {}, variant }) => {
  const summary = result.summary ?? {};
  const metrics = summary.metrics ?? {};
  const rankingScore = result.status === "completed"
    ? calculateRankingScore(metrics)
    : 0;

  return {
    variantId: variant.id,
    label: variant.label,
    description: variant.description,
    env: variant.env,
    embeddingProvider: variant.embeddingProvider,
    topK: variant.topK,
    topKPerDoc: variant.topKPerDoc,
    candidateMultiplier: variant.candidateMultiplier,
    status: result.status ?? "completed",
    error: result.error ?? null,
    runId: summary.runId ?? null,
    config: summary.config ?? {},
    metrics,
    rankingScore,
    averageResponseTimeMs: toNumber(metrics.averageResponseTimeMs, Number.POSITIVE_INFINITY),
  };
};

const compareResults = (left, right) => {
  if (right.rankingScore !== left.rankingScore) {
    return right.rankingScore - left.rankingScore;
  }

  if (left.averageResponseTimeMs !== right.averageResponseTimeMs) {
    return left.averageResponseTimeMs - right.averageResponseTimeMs;
  }

  return left.variantId.localeCompare(right.variantId);
};

export const buildRerankSweepReport = ({
  runId,
  createdAt = new Date().toISOString(),
  corpusPath,
  profile,
  variants = [],
  results = [],
} = {}) => {
  const variantMap = new Map(variants.map((variant) => [variant.id, variant]));
  const normalizedResults = results
    .map((result) => {
      const variant = variantMap.get(result.variantId);

      if (!variant) {
        return null;
      }

      return normalizeResult({
        result,
        variant,
      });
    })
    .filter(Boolean)
    .sort(compareResults)
    .map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  const completedResults = normalizedResults.filter(
    (result) => result.status === "completed"
  );

  return {
    runId,
    createdAt,
    corpusPath,
    profile,
    bestVariantId: completedResults[0]?.variantId ?? null,
    variants,
    results: normalizedResults,
    summary: {
      variantCount: variants.length,
      completedCount: completedResults.length,
      failedCount: normalizedResults.filter((result) => result.status === "failed")
        .length,
    },
  };
};

export const renderRerankSweepMarkdown = (report = {}) => {
  const lines = [
    "# Rerank Ranking Sweep",
    "",
    `- Run ID: \`${report.runId ?? "unknown"}\``,
    `- Created at: \`${report.createdAt ?? "unknown"}\``,
    `- Corpus: \`${report.corpusPath ?? "unknown"}\``,
    `- Profile: \`${report.profile ?? "unknown"}\``,
    `- Best variant: \`${report.bestVariantId ?? "none"}\``,
    "",
    "## Ranking",
    "",
    "| Rank | Variant | Status | Score | Embedding | topK | Compare topK | Candidates | NDCG | Precision | Recall | MRR | Noise | Avg Time (ms) | Overrides |",
    "| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const result of report.results ?? []) {
    lines.push(
      [
        `| ${result.rank}`,
        `\`${result.variantId}\``,
        result.status,
        renderNumber(result.rankingScore),
        result.embeddingProvider,
        result.topK,
        result.topKPerDoc,
        result.candidateMultiplier,
        renderNumber(result.metrics?.reranked?.ndcgAtK),
        renderNumber(result.metrics?.reranked?.precisionAtK),
        renderNumber(result.metrics?.reranked?.recallAtK),
        renderNumber(result.metrics?.reranked?.mrr),
        renderPercent(result.metrics?.reranked?.noiseRateAtK),
        renderNumber(result.metrics?.averageResponseTimeMs),
        `\`${renderRerankVariantEnv(result.env)}\` |`,
      ].join(" | ")
    );
  }

  const failedResults = (report.results ?? []).filter(
    (result) => result.status === "failed"
  );

  if (failedResults.length > 0) {
    lines.push("", "## Failed Variants", "");

    for (const result of failedResults) {
      lines.push(`- \`${result.variantId}\`: ${result.error ?? "Unknown error"}`);
    }
  }

  return `${lines.join("\n")}\n`;
};
