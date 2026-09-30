import { performance } from "node:perf_hooks";
import {
  getCrossEncoderEndpoint,
  getCrossEncoderModel,
  getCrossEncoderTimeoutMs,
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
import { getModelGatewayCall, recordModelMetricEvent } from "./model-gateway/call-context.js";
import { requestModelGatewayRerank } from "./model-gateway/client.js";
import { MODEL_GATEWAY_MIRROR_ANNOTATION } from "./model-gateway/protocol.js";
import { isModelGatewayEnabled } from "./service-topology.js";
import {
  buildLlmOpsRouteContext,
  buildLlmOpsUsageMetric,
} from "./llmops-usage.js";
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

const buildEmptyLlmOpsRouteContext = () => ({
  latencySloMs: null,
  pricing: null,
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

// `requestedModel` is a model a caller named (the model gateway serving a
// caller's rerank); otherwise the configured model or the rerank route decides.
export const resolveCrossEncoderModelRoute = (requestedModel = "") => {
  const configuredModel = String(requestedModel ?? "").trim() || getCrossEncoderModel().trim();

  if (configuredModel) {
    return {
      llmOpsContext: buildEmptyLlmOpsRouteContext(),
      model: configuredModel,
      modelRoute: buildConfiguredCrossEncoderModelRoute(configuredModel),
    };
  }

  const route = resolveModelRouteForRuntime({
    capability: MODEL_CAPABILITIES.rerank,
    routeId: MODEL_ROUTE_IDS.rerankCrossEncoderDefault,
  });

  return {
    llmOpsContext: buildLlmOpsRouteContext(route.resolvedRoute),
    model: route.modelName,
    modelRoute: route.publicRoute,
  };
};

const getCrossEncoderInputCharacters = (metricBase = {}) =>
  toFiniteNumber(metricBase.queryCharacters) +
  toFiniteNumber(metricBase.totalTextCharacters);

// `usage` replaces the local estimate with the usage the model gateway metered;
// `annotations` marks such an event as the caller's mirror of the gateway's.
const recordCrossEncoderLlmOpsMetric = async ({
  annotations = [],
  error = null,
  latencyMs,
  metricBase = {},
  metricContext = {},
  modelRoute,
  status,
  usage = null,
} = {}) => {
  const inputCharacters = getCrossEncoderInputCharacters(metricBase);

  return recordLlmOpsMetric({
    annotations,
    error,
    latencySloMs: metricContext.latencySloMs,
    ...buildLlmOpsUsageMetric({
      inputCharacters,
      pricing: metricContext.pricing,
    }),
    ...(usage && Number.isFinite(usage.totalTokens) ? usage : {}),
    inputCharacters,
    itemCount: toFiniteNumber(metricBase.candidateCount),
    latencyMs,
    modelRoute,
    operation: LLMOPS_OPERATIONS.rerank,
    stage: "cross_encoder_score",
    status,
  }, { recorder: recordModelMetricEvent });
};

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
        // The service's own score, before the per-query min-max above: the
        // only one comparable across queries, which the QA gate needs
        // (getQaMinRerankProbability in config.js).
        crossEncoderScore: toFiniteNumber(scores[index], 0),
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

/**
 * One request to a cross-encoder service ({ query, texts } -> { scores }).
 * Resolves the scores in the order of `texts`. An HTTP failure carries
 * `status` and `upstreamStatus`; a timeout carries code ETIMEDOUT. `signal`
 * (the model gateway's, when its caller leaves or its deadline passes) cancels
 * the request and rejects with its reason, which is not a timeout.
 */
export const requestCrossEncoderScores = async ({ endpoint, model = "", queryText, signal, texts }) => {
  const timeoutMs = getCrossEncoderTimeoutMs();
  let response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: queryText,
        texts,
        ...(model ? { model } : {}),
      }),
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
        : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }

    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      const timeoutError = new Error(
        `Cross-encoder request timed out after ${timeoutMs}ms.`
      );

      timeoutError.code = "ETIMEDOUT";
      throw timeoutError;
    }

    throw error;
  }

  if (!response.ok) {
    const httpError = new Error(
      `Cross-encoder request failed with HTTP ${response.status}.`
    );

    httpError.status = response.status;
    httpError.upstreamStatus = response.status;
    throw httpError;
  }

  return parseCrossEncoderScores(await response.json(), texts.length);
};

const scoreWithHttpCrossEncoder = async ({ queryText, pairs, model = "" }) => {
  const endpoint = getCrossEncoderEndpoint().trim();

  if (!endpoint) {
    throw new Error(
      "RAG_CROSS_ENCODER_ENDPOINT is required when RAG_RERANK_PROVIDER=cross-encoder."
    );
  }

  return requestCrossEncoderScores({
    endpoint,
    model,
    queryText,
    texts: pairs.map((pair) => pair.text),
  });
};

// With MODEL_GATEWAY_URL set, cross-encoder scores come from the gateway, which
// owns the rerank backends; a configured stand-in stays in process, and so does
// a call the gateway itself is serving.
const routesRerankThroughModelGateway = () =>
  !getModelGatewayCall() && isModelGatewayEnabled();

/**
 * The model gateway's rerank: scores `texts` for `queryText` on a backend
 * chosen by `dispatch({ model, request })`, where `request(endpoint)` sends
 * one request, and records one LLMOps rerank event for the call. Resolves
 * { scores, modelRoute }.
 */
export const scoreTextsWithCrossEncoderBackend = async ({
  dispatch,
  model = "",
  queryText = "",
  signal,
  texts = [],
}) => {
  const routeSelection = resolveCrossEncoderModelRoute(model);
  const metricBase = {
    candidateCount: texts.length,
    queryCharacters: String(queryText ?? "").length,
    totalTextCharacters: texts.reduce((sum, text) => sum + String(text ?? "").length, 0),
  };
  const startedAt = performance.now();
  const record = (status, error = null) =>
    recordCrossEncoderLlmOpsMetric({
      error,
      latencyMs: toMetricNumber(performance.now() - startedAt),
      metricBase,
      metricContext: routeSelection.llmOpsContext,
      modelRoute: routeSelection.modelRoute,
      status,
    });

  try {
    const scores = await dispatch({
      model: routeSelection.model,
      request: (endpoint) =>
        requestCrossEncoderScores({ endpoint, model: routeSelection.model, queryText, signal, texts }),
    });

    await record("ok");

    return { modelRoute: routeSelection.modelRoute, scores };
  } catch (error) {
    await record("error", error);
    throw error;
  }
};

const scoreWithCrossEncoder = async ({ queryText, results }) => {
  const pairs = buildCrossEncoderPairs(results);
  const viaGateway = !crossEncoderProvider?.score && routesRerankThroughModelGateway();
  const transport = crossEncoderProvider?.score
    ? "custom-provider"
    : viaGateway
      ? "model-gateway"
      : "http";
  const routeSelection = crossEncoderProvider?.score
    ? {
        llmOpsContext: buildEmptyLlmOpsRouteContext(),
        model: "",
        modelRoute: buildCustomCrossEncoderModelRoute(),
      }
    : resolveCrossEncoderModelRoute();
  const metricBase = buildCrossEncoderMetricBase({
    queryText,
    pairs,
    transport,
  });
  const startedAt = performance.now();
  // The gateway meters the call; this process keeps a mirror event with the
  // gateway's usage and route.
  const gatewayMetric = viaGateway
    ? { annotations: [MODEL_GATEWAY_MIRROR_ANNOTATION], modelRoute: routeSelection.modelRoute, usage: null }
    : { annotations: [], modelRoute: routeSelection.modelRoute, usage: null };

  try {
    let scores;

    if (crossEncoderProvider?.score) {
      scores = await crossEncoderProvider.score({
        queryText,
        pairs,
        results,
      });
    } else if (viaGateway) {
      // The same budget a direct cross-encoder request gets, so a slow or
      // hanging gateway degrades the query exactly as a slow service would.
      const answer = await requestModelGatewayRerank({
        model: routeSelection.model,
        query: queryText,
        texts: pairs.map((pair) => pair.text),
        timeoutMs: getCrossEncoderTimeoutMs(),
      });

      scores = parseCrossEncoderScores(answer, pairs.length);
      gatewayMetric.modelRoute = answer.modelRoute ?? gatewayMetric.modelRoute;
      gatewayMetric.usage = answer.meteredUsage ?? null;
    } else {
      scores = await scoreWithHttpCrossEncoder({
        queryText,
        model: routeSelection.model,
        pairs,
      });
    }

    const latencyMs = toMetricNumber(performance.now() - startedAt);

    emitRerankMetric({
      ...metricBase,
      status: "ok",
      latencyMs,
    });
    await recordCrossEncoderLlmOpsMetric({
      annotations: gatewayMetric.annotations,
      latencyMs,
      metricContext: routeSelection.llmOpsContext,
      metricBase,
      modelRoute: gatewayMetric.modelRoute,
      status: "ok",
      usage: gatewayMetric.usage,
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
      annotations: gatewayMetric.annotations,
      error,
      latencyMs,
      metricContext: routeSelection.llmOpsContext,
      metricBase,
      modelRoute: gatewayMetric.modelRoute,
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

export const rerankResultsWithConfig = ({
  queryText = "",
  results = [],
  topK,
  rerankEnabled = true,
  rerankWeight = 0,
} = {}) => {
  const safeResults = Array.isArray(results) ? results : [];
  const safeTopK = normalizeTopK(topK, safeResults.length);

  if (!rerankEnabled) {
    return safeResults.slice(0, safeTopK);
  }

  if (safeResults.length === 0 || safeTopK === 0) {
    return [];
  }

  const safeRerankWeight = clamp01(toFiniteNumber(rerankWeight, 0));
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
        entry.originalScore * (1 - safeRerankWeight) +
        rerankScore * safeRerankWeight;

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

export const rerankResults = ({ queryText = "", results = [], topK } = {}) =>
  rerankResultsWithConfig({
    queryText,
    results,
    topK,
    rerankEnabled: isRerankEnabled(),
    rerankWeight: getRerankWeight(),
  });

// Reranking refines an order retrieval already produced, so an unreachable or
// failing rerank service degrades a query to that order instead of failing it.
// The failure is still an error metric (scoreWithCrossEncoder) and a warning,
// logged once per distinct message.
const reportedRerankFallbacks = new Set();

export const rerankResultsOrKeepOrder = async ({ queryText = "", results = [], topK } = {}) => {
  try {
    return await rerankResultsWithProvider({ queryText, results, topK });
  } catch (error) {
    const message = error?.message ?? String(error);

    if (!reportedRerankFallbacks.has(message)) {
      reportedRerankFallbacks.add(message);
      console.warn(`Rerank failed (${message}); keeping the retrieval order for this query.`);
    }

    const safeResults = Array.isArray(results) ? results : [];

    return safeResults.slice(0, normalizeTopK(topK, safeResults.length));
  }
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
