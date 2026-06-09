export const PARAM_SWEEP_PROFILES = {
  quick: [
    {
      id: "baseline",
      label: "Baseline",
      description: "Current documented defaults.",
      env: {},
    },
    {
      id: "broad_topk",
      label: "Broad topK",
      description: "Retrieve more evidence for document and compare flows.",
      env: {
        RAG_RETRIEVAL_TOP_K: "8",
        RAG_COMPARE_TOP_K_PER_DOC: "4",
      },
    },
    {
      id: "wide_overlap",
      label: "Wide chunk overlap",
      description: "Increase structured chunk overlap for boundary-sensitive evidence.",
      env: {
        RAG_CHUNK_OVERLAP: "240",
      },
    },
    {
      id: "heuristic_rerank",
      label: "Heuristic rerank",
      description: "Enable heuristic rerank with a larger candidate pool.",
      env: {
        RAG_RERANK_ENABLED: "true",
        RAG_RERANK_PROVIDER: "heuristic",
        RAG_RERANK_CANDIDATE_MULTIPLIER: "3",
        RAG_RERANK_WEIGHT: "0.7",
      },
    },
    {
      id: "hybrid_weighted",
      label: "Hybrid weighted",
      description: "Enable dense and sparse retrieval with a stronger sparse contribution.",
      env: {
        RAG_HYBRID_ENABLED: "true",
        RAG_HYBRID_FUSION: "weighted",
        RAG_HYBRID_DENSE_WEIGHT: "0.55",
        RAG_HYBRID_SPARSE_WEIGHT: "0.45",
        RAG_SPARSE_TOP_K: "8",
      },
    },
  ],
};

PARAM_SWEEP_PROFILES.full = [
  ...PARAM_SWEEP_PROFILES.quick,
  {
    id: "narrow_topk",
    label: "Narrow topK",
    description: "Reduce retrieved evidence to measure citation precision and latency.",
    env: {
      RAG_RETRIEVAL_TOP_K: "4",
      RAG_COMPARE_TOP_K_PER_DOC: "2",
    },
  },
  {
    id: "narrow_overlap",
    label: "Narrow chunk overlap",
    description: "Reduce chunk overlap to measure boundary recall sensitivity.",
    env: {
      RAG_CHUNK_OVERLAP: "120",
    },
  },
  {
    id: "hybrid_rrf",
    label: "Hybrid RRF",
    description: "Use Reciprocal Rank Fusion for dense and sparse retrieval.",
    env: {
      RAG_HYBRID_ENABLED: "true",
      RAG_HYBRID_FUSION: "rrf",
      RAG_RRF_K: "30",
      RAG_SPARSE_TOP_K: "8",
    },
  },
];

const toNumber = (value, fallbackValue = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallbackValue;

const normalizeMetric = (metrics = {}, key, fallbackValue = 0) =>
  toNumber(metrics[key], fallbackValue);

const renderPercent = (value) =>
  Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "N/A";

const renderNumber = (value) =>
  Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "N/A";

export const renderVariantEnv = (env = {}) => {
  const entries = Object.entries(env);

  return entries.length === 0
    ? "defaults"
    : entries.map(([key, value]) => `${key}=${value}`).join(", ");
};

export const getParamSweepVariants = ({ profile = "quick", variantIds = [] } = {}) => {
  const variants = PARAM_SWEEP_PROFILES[profile];

  if (!variants) {
    throw new Error(`Unknown param sweep profile: ${profile}`);
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

const calculateQualityScore = (metrics = {}) => {
  const overallPassRate = normalizeMetric(metrics, "overallPassRate");
  const qaPageHitRate = normalizeMetric(metrics, "qaPageHitRate", 1);
  const comparePageHitRate = normalizeMetric(metrics, "comparePageHitRate", 1);
  const answerContentHitRate = normalizeMetric(metrics, "answerContentHitRate", 1);
  const claimSupportHitRate = normalizeMetric(metrics, "claimSupportHitRate", 1);
  const uploadResumeSuccessRate = normalizeMetric(metrics, "uploadResumeSuccessRate", 1);

  return Number(
    (
      overallPassRate * 45 +
      qaPageHitRate * 12.5 +
      comparePageHitRate * 12.5 +
      answerContentHitRate * 10 +
      claimSupportHitRate * 15 +
      uploadResumeSuccessRate * 5
    ).toFixed(4)
  );
};

const normalizeResult = ({ result = {}, variant }) => {
  const summary = result.summary ?? {};
  const metrics = summary.metrics ?? {};
  const qualityScore = result.status === "completed"
    ? calculateQualityScore(metrics)
    : 0;

  return {
    variantId: variant.id,
    label: variant.label,
    description: variant.description,
    env: variant.env,
    status: result.status ?? "completed",
    error: result.error ?? null,
    runId: summary.runId ?? null,
    config: summary.config ?? {},
    metrics,
    qualityScore,
    averageResponseTimeMs: normalizeMetric(metrics, "averageResponseTimeMs", Number.POSITIVE_INFINITY),
    averageCitationCount: normalizeMetric(metrics, "averageCitationCount"),
  };
};

const compareResults = (left, right) => {
  if (right.qualityScore !== left.qualityScore) {
    return right.qualityScore - left.qualityScore;
  }

  if (left.averageResponseTimeMs !== right.averageResponseTimeMs) {
    return left.averageResponseTimeMs - right.averageResponseTimeMs;
  }

  if (right.averageCitationCount !== left.averageCitationCount) {
    return right.averageCitationCount - left.averageCitationCount;
  }

  return left.variantId.localeCompare(right.variantId);
};

export const buildParamSweepReport = ({
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

export const renderParamSweepMarkdown = (report = {}) => {
  const lines = [
    "# RAG Parameter Sweep",
    "",
    `- Run ID: \`${report.runId ?? "unknown"}\``,
    `- Created at: \`${report.createdAt ?? "unknown"}\``,
    `- Corpus: \`${report.corpusPath ?? "unknown"}\``,
    `- Profile: \`${report.profile ?? "unknown"}\``,
    `- Best variant: \`${report.bestVariantId ?? "none"}\``,
    "",
    "## Ranking",
    "",
    "| Rank | Variant | Status | Quality Score | Overall | QA Page | Compare Page | Claim Support | Avg Time (ms) | Avg Citations | Overrides |",
    "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const result of report.results ?? []) {
    lines.push(
      [
        `| ${result.rank}`,
        `\`${result.variantId}\``,
        result.status,
        renderNumber(result.qualityScore),
        renderPercent(result.metrics?.overallPassRate),
        renderPercent(result.metrics?.qaPageHitRate),
        renderPercent(result.metrics?.comparePageHitRate),
        renderPercent(result.metrics?.claimSupportHitRate),
        renderNumber(result.metrics?.averageResponseTimeMs),
        renderNumber(result.metrics?.averageCitationCount),
        `\`${renderVariantEnv(result.env)}\` |`,
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
