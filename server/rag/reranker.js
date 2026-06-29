import { performance } from "node:perf_hooks";
import {
  getCrossEncoderEndpoint,
  getCrossEncoderModel,
  getRerankProvider,
  getRerankWeight,
  isRerankEnabled,
} from "./config.js";
import {
  MODEL_CAPABILITIES,
  MODEL_ROUTE_IDS,
  resolveModelRouteForRuntime,
} from "./model-providers/index.js";
import {
  LLMOPS_OPERATIONS,
  recordLlmOpsMetric,
} from "./llmops-metrics.js";
import {
  buildTermSet,
  extractAnchorGroups,
  extractMeaningfulTokens,
  normalizeSearchText,
} from "./text-utils.js";

const clamp01 = (value) => Math.max(0, Math.min(1, value));
let customRerankProvider = null;
let crossEncoderProvider = null;
let rerankMetricsCollector = null;

const toFiniteNumber = (value, fallbackValue = 0) => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
};

const normalizeTopK = (topK, fallbackValue) => {
  const parsedValue = Math.floor(Number(topK));
  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? parsedValue
    : fallbackValue;
};

const uniqueValues = (values) => [...new Set(values.filter(Boolean))];

const buildSearchableText = (result) =>
  [
    result?.document?.metadata?.fileName,
    result?.document?.metadata?.sectionHeading,
    result?.document?.pageContent,
  ]
    .filter(Boolean)
    .join("\n");

const buildFieldText = (result) =>
  [result?.document?.metadata?.fileName, result?.document?.metadata?.sectionHeading]
    .filter(Boolean)
    .join("\n");

const countTermOverlap = (queryTerms, termSet) => {
  if (queryTerms.length === 0) {
    return 0;
  }

  let overlapCount = 0;

  for (const term of queryTerms) {
    if (termSet.has(term)) {
      overlapCount += 1;
    }
  }

  return overlapCount / queryTerms.length;
};

const buildQuerySignals = (queryText) => {
  const queryTerms = uniqueValues(extractMeaningfulTokens(queryText));
  const anchors = extractAnchorGroups(queryText);
  const normalizedQuery = normalizeSearchText(queryText);
  const meaningfulPhrase = queryTerms.join(" ");
  const phrases = uniqueValues([
    ...anchors.map((anchor) => anchor.normalizedValue),
    meaningfulPhrase.split(" ").length >= 2 ? meaningfulPhrase : "",
    normalizedQuery.split(" ").length >= 2 ? normalizedQuery : "",
  ]);

  return {
    anchors,
    phrases,
    queryTerms,
  };
};

const getPhraseScore = ({ normalizedText, termSet, signals }) => {
  if (signals.phrases.some((phrase) => normalizedText.includes(phrase))) {
    return 1;
  }

  if (signals.anchors.length === 0) {
    return 0;
  }

  const matchedAnchorCount = signals.anchors.filter((anchor) => {
    if (normalizedText.includes(anchor.normalizedValue)) {
      return true;
    }

    return anchor.terms.length > 0 && anchor.terms.every((term) => termSet.has(term));
  }).length;

  return matchedAnchorCount / signals.anchors.length;
};

const getFieldScore = ({ result, signals }) => {
  const fieldText = buildFieldText(result);

  if (!fieldText) {
    return 0;
  }

  const normalizedFieldText = normalizeSearchText(fieldText);
  const fieldTermSet = buildTermSet(fieldText);
  const phraseScore = signals.phrases.some((phrase) =>
    normalizedFieldText.includes(phrase)
  )
    ? 1
    : 0;
  const overlapScore = countTermOverlap(signals.queryTerms, fieldTermSet);

  return Math.max(phraseScore, overlapScore);
};

const buildRawRerankScore = ({ result, normalizedOriginalScore, signals }) => {
  const searchableText = buildSearchableText(result);
  const normalizedText = normalizeSearchText(searchableText);
  const termSet = buildTermSet(searchableText);
  const overlapScore = countTermOverlap(signals.queryTerms, termSet);
  const phraseScore = getPhraseScore({
    normalizedText,
    termSet,
    signals,
  });
  const fieldScore = getFieldScore({
    result,
    signals,
  });

  return clamp01(
    overlapScore * 0.45 +
      phraseScore * 0.25 +
      fieldScore * 0.2 +
      normalizedOriginalScore * 0.1
  );
};

export const configureCustomRerankProvider = (provider) => {
  customRerankProvider = provider;
};

export const resetCustomRerankProvider = () => {
  customRerankProvider = null;
};

export const configureCrossEncoderProvider = (provider) => {
  crossEncoderProvider = provider;
};

export const resetCrossEncoderProvider = () => {
  crossEncoderProvider = null;
};

export const configureRerankMetricsCollector = (collector) => {
  rerankMetricsCollector = typeof collector === "function" ? collector : null;
};

export const resetRerankMetricsCollector = () => {
  rerankMetricsCollector = null;
};

const toMetricNumber = (value) =>
  Number.isFinite(value) ? Number(value.toFixed(3)) : null;

const emitRerankMetric = (metric) => {
  if (!rerankMetricsCollector) {
    return;
  }

  try {
    rerankMetricsCollector(metric);
  } catch (error) {
    console.error("Rerank metrics collector failed.", error);
  }
};

const buildCrossEncoderMetricBase = ({ queryText, pairs, transport }) => ({
  stage: "cross-encoder-score",
  provider: "cross-encoder",
  transport,
  candidateCount: pairs.length,
  queryCharacters: String(queryText ?? "").length,
  totalTextCharacters: pairs.reduce(
    (sum, pair) => sum + String(pair.text ?? "").length,
    0
  ),
});

const buildCustomCrossEncoderModelRoute = () => ({
  candidateModelIds: [],
  capability: MODEL_CAPABILITIES.rerank,
  fallbackModelIds: [],
  modelId: null,
  providerId: "custom_cross_encoder_provider",
  rejectedModelIds: [],
  routeId: null,
  status: "custom_provider",
});

const buildConfiguredCrossEncoderModelRoute = (configuredModel) => ({
  candidateModelIds: [configuredModel].filter(Boolean),
  capability: MODEL_CAPABILITIES.rerank,
  fallbackModelIds: [],
  modelId: configuredModel || null,
  providerId: "cross_encoder_http",
  rejectedModelIds: [],
  routeId: MODEL_ROUTE_IDS.rerankCrossEncoderDefault,
  status: "configured_model",
});

const resolveHttpCrossEncoderModelRoute = () => {
  const configuredModel = getCrossEncoderModel().trim();

  if (configuredModel) {
    return {
      model: configuredModel,
      modelRoute: buildConfiguredCrossEncoderModelRoute(configuredModel),
    };
  }

  const route = resolveModelRouteForRuntime({
    capability: MODEL_CAPABILITIES.rerank,
    routeId: MODEL_ROUTE_IDS.rerankCrossEncoderDefault,
  });

  return {
    model: route.modelName,
    modelRoute: route.publicRoute,
  };
};

const recordCrossEncoderLlmOpsMetric = async ({
  error = null,
  latencyMs,
  metricBase = {},
  modelRoute,
  status,
} = {}) =>
  recordLlmOpsMetric({
    error,
    inputCharacters:
      toFiniteNumber(metricBase.queryCharacters) +
      toFiniteNumber(metricBase.totalTextCharacters),
    itemCount: toFiniteNumber(metricBase.candidateCount),
    latencyMs,
    modelRoute,
    operation: LLMOPS_OPERATIONS.rerank,
    stage: "cross_encoder_score",
    status,
  });

const normalizeScores = (scores) => {
  const finiteScores = scores.map((score) => toFiniteNumber(score, 0));
  const minimumScore = Math.min(...finiteScores);
  const maximumScore = Math.max(...finiteScores);

  if (maximumScore > minimumScore) {
    return finiteScores.map((score) =>
      clamp01((score - minimumScore) / (maximumScore - minimumScore))
    );
  }

  return finiteScores.map((score) => clamp01(score));
};

const rerankResultsWithScores = ({ results = [], scores = [], topK }) => {
  const safeResults = Array.isArray(results) ? results : [];
  const safeTopK = normalizeTopK(topK, safeResults.length);
  const normalizedScores = normalizeScores(scores);
  const rerankWeight = getRerankWeight();

  if (normalizedScores.length !== safeResults.length) {
    throw new Error(
      `Cross-encoder returned ${normalizedScores.length} score(s) for ${safeResults.length} candidate(s).`
    );
  }

  return safeResults
    .map((result, index) => {
      const originalScore = toFiniteNumber(result?.score, 0);
      const rerankScore = normalizedScores[index];
      const mixedScore =
        originalScore * (1 - rerankWeight) + rerankScore * rerankWeight;

      return {
        ...result,
        originalScore,
        rerankScore,
        score: mixedScore,
        __rerankIndex: index,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.rerankScore - left.rerankScore ||
        right.originalScore - left.originalScore ||
        left.__rerankIndex - right.__rerankIndex
    )
    .slice(0, safeTopK)
    .map(({ __rerankIndex, ...result }) => result);
};

const buildCrossEncoderPairs = (results) =>
  results.map((result, index) => ({
    index,
    id: String(result?.document?.id ?? index),
    text: buildSearchableText(result),
    metadata: result?.document?.metadata ?? {},
  }));

const getScoreFromResponseEntry = (entry) => {
  if (typeof entry === "number") {
    return entry;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  return entry.score ?? entry.relevance_score ?? entry.relevanceScore ?? null;
};

const getIndexFromResponseEntry = (entry, fallbackIndex) => {
  if (!entry || typeof entry !== "object") {
    return fallbackIndex;
  }

  const parsedIndex = Number(entry.index ?? entry.document_index ?? entry.documentIndex);
  return Number.isInteger(parsedIndex) ? parsedIndex : fallbackIndex;
};

const parseCrossEncoderScores = (payload, expectedCount) => {
  const responseEntries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.scores)
      ? payload.scores
      : Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.data)
          ? payload.data
          : null;

  if (!responseEntries) {
    throw new Error("Cross-encoder response must include scores or results.");
  }

  const scores = new Array(expectedCount).fill(null);

  responseEntries.forEach((entry, fallbackIndex) => {
    const index = getIndexFromResponseEntry(entry, fallbackIndex);
    const score = getScoreFromResponseEntry(entry);

    if (index < 0 || index >= expectedCount || score === null) {
      return;
    }

    scores[index] = score;
  });

  if (scores.some((score) => score === null)) {
    throw new Error(
      `Cross-encoder response did not include scores for all ${expectedCount} candidate(s).`
    );
  }

  return scores;
};

const scoreWithHttpCrossEncoder = async ({ queryText, pairs, model = "" }) => {
  const endpoint = getCrossEncoderEndpoint().trim();

  if (!endpoint) {
    throw new Error(
      "RAG_CROSS_ENCODER_ENDPOINT is required when RAG_RERANK_PROVIDER=cross-encoder."
    );
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: queryText,
      texts: pairs.map((pair) => pair.text),
      ...(model ? { model } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Cross-encoder request failed with HTTP ${response.status}.`
    );
  }

  return parseCrossEncoderScores(await response.json(), pairs.length);
};

const scoreWithCrossEncoder = async ({ queryText, results }) => {
  const pairs = buildCrossEncoderPairs(results);
  const transport = crossEncoderProvider?.score ? "custom-provider" : "http";
  const routeSelection = crossEncoderProvider?.score
    ? {
        model: "",
        modelRoute: buildCustomCrossEncoderModelRoute(),
      }
    : resolveHttpCrossEncoderModelRoute();
  const metricBase = buildCrossEncoderMetricBase({
    queryText,
    pairs,
    transport,
  });
  const startedAt = performance.now();

  try {
    const scores = crossEncoderProvider?.score
      ? await crossEncoderProvider.score({
          queryText,
          pairs,
          results,
        })
      : await scoreWithHttpCrossEncoder({
          queryText,
          model: routeSelection.model,
          pairs,
        });
    const latencyMs = toMetricNumber(performance.now() - startedAt);

    emitRerankMetric({
      ...metricBase,
      status: "ok",
      latencyMs,
    });
    await recordCrossEncoderLlmOpsMetric({
      latencyMs,
      metricBase,
      modelRoute: routeSelection.modelRoute,
      status: "ok",
    });

    return scores;
  } catch (error) {
    const latencyMs = toMetricNumber(performance.now() - startedAt);

    emitRerankMetric({
      ...metricBase,
      status: "error",
      latencyMs,
      errorName: error?.name ?? "Error",
      errorMessage: error?.message ?? String(error),
    });
    await recordCrossEncoderLlmOpsMetric({
      error,
      latencyMs,
      metricBase,
      modelRoute: routeSelection.modelRoute,
      status: "error",
    });

    throw error;
  }
};

const rerankResultsWithCrossEncoder = async ({ queryText = "", results = [], topK } = {}) => {
  const safeResults = Array.isArray(results) ? results : [];
  const safeTopK = normalizeTopK(topK, safeResults.length);

  if (safeResults.length === 0 || safeTopK === 0) {
    return [];
  }

  const scores = await scoreWithCrossEncoder({
    queryText,
    results: safeResults,
  });

  return rerankResultsWithScores({
    results: safeResults,
    scores,
    topK: safeTopK,
  });
};

export const rerankResults = ({ queryText = "", results = [], topK } = {}) => {
  const safeResults = Array.isArray(results) ? results : [];
  const safeTopK = normalizeTopK(topK, safeResults.length);

  if (!isRerankEnabled()) {
    return safeResults.slice(0, safeTopK);
  }

  if (safeResults.length === 0 || safeTopK === 0) {
    return [];
  }

  const rerankWeight = getRerankWeight();
  const signals = buildQuerySignals(queryText);
  const originalScores = safeResults.map((result) =>
    toFiniteNumber(result?.score, 0)
  );
  const maximumOriginalScore = Math.max(0, ...originalScores);
  const scoredResults = safeResults.map((result, index) => {
    const originalScore = originalScores[index];
    const normalizedOriginalScore =
      maximumOriginalScore > 0 ? originalScore / maximumOriginalScore : 0;
    const rawRerankScore = buildRawRerankScore({
      result,
      normalizedOriginalScore: clamp01(normalizedOriginalScore),
      signals,
    });

    return {
      result,
      index,
      originalScore,
      rawRerankScore,
    };
  });
  const maximumRawRerankScore = Math.max(
    0,
    ...scoredResults.map((entry) => entry.rawRerankScore)
  );

  return scoredResults
    .map((entry) => {
      const rerankScore =
        maximumRawRerankScore > 0
          ? clamp01(entry.rawRerankScore / maximumRawRerankScore)
          : 0;
      const mixedScore =
        entry.originalScore * (1 - rerankWeight) + rerankScore * rerankWeight;

      return {
        ...entry.result,
        originalScore: entry.originalScore,
        rerankScore,
        score: mixedScore,
        __rerankIndex: entry.index,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.rerankScore - left.rerankScore ||
        right.originalScore - left.originalScore ||
        left.__rerankIndex - right.__rerankIndex
    )
    .slice(0, safeTopK)
    .map(({ __rerankIndex, ...result }) => result);
};

export const rerankResultsWithProvider = async ({
  queryText = "",
  results = [],
  topK,
} = {}) => {
  const safeResults = Array.isArray(results) ? results : [];
  const safeTopK = normalizeTopK(topK, safeResults.length);

  if (!isRerankEnabled()) {
    return safeResults.slice(0, safeTopK);
  }

  if (getRerankProvider() !== "custom") {
    if (getRerankProvider() === "cross-encoder") {
      return rerankResultsWithCrossEncoder({
        queryText,
        results: safeResults,
        topK: safeTopK,
      });
    }

    return rerankResults({
      queryText,
      results: safeResults,
      topK: safeTopK,
    });
  }

  if (!customRerankProvider?.rerank) {
    return rerankResults({
      queryText,
      results: safeResults,
      topK: safeTopK,
    });
  }

  const rerankedResults = await customRerankProvider.rerank({
    queryText,
    results: safeResults,
    topK: safeTopK,
  });

  return (Array.isArray(rerankedResults) ? rerankedResults : safeResults).slice(
    0,
    safeTopK
  );
};
