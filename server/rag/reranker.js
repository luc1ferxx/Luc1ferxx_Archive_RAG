import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  getCrossEncoderEndpoint,
  getCrossEncoderModel,
  getCrossEncoderScoreScale,
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
import { getModelGatewayCall } from "./model-gateway/call-context.js";
import { admitModelCallQuota, recordModelMetricEventWithQuota } from "./model-call-quota.js";
import { requestModelGatewayRerank } from "./model-gateway/client.js";
import { MODEL_GATEWAY_MIRROR_ANNOTATION } from "./model-gateway/protocol.js";
import { observeRerank, recordRerankDegradation } from "./metrics-retrieval.js";
import { getActiveDatabaseTenant, getDatabaseTenantContext } from "./postgres-tenant.js";
import { withRequestSignal } from "./request-deadline.js";
import { getModelGatewayUrls, isModelGatewayEnabled } from "./service-topology.js";
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

// Cross-encoder scores this process already has, so each passage is scored
// once per question: a step's queries and the agent's follow-up step meet the
// question's candidates again. Keyed by a sha256 of the tenant the call acts
// for (the bound database tenant, else the non-tenant context), where the
// request goes, the model it names, the score scale, the query text and the
// exact passage text sent (rerankResultsWithCrossEncoder). A hit skips the
// model call and its quota, so it shows: shared across tenants, it would tell
// a tenant that another one recently asked the same question about the same
// text (AGENTS.md "Cross-tenant cache timing"). Only successful scores are
// stored; the oldest entry goes first. A score lives ten minutes: long enough
// for one question's steps, short enough that a reranker restarted on another
// model behind the same address and model name is not answered from the old
// model's scores for long.
export const CROSS_ENCODER_SCORE_CACHE_MAX_ENTRIES = 20_000;
export const CROSS_ENCODER_SCORE_CACHE_TTL_MS = 10 * 60 * 1000;
const crossEncoderScoreCache = new Map();

const recallCrossEncoderScore = (key) => {
  const entry = crossEncoderScoreCache.get(key);

  return entry && Date.now() - entry.storedAt < CROSS_ENCODER_SCORE_CACHE_TTL_MS ? entry.score : undefined;
};

const rememberCrossEncoderScore = (key, score) => {
  // Deleted first, so an expired entry stored again counts as the newest.
  crossEncoderScoreCache.delete(key);
  crossEncoderScoreCache.set(key, { score, storedAt: Date.now() });

  if (crossEncoderScoreCache.size > CROSS_ENCODER_SCORE_CACHE_MAX_ENTRIES) {
    crossEncoderScoreCache.delete(crossEncoderScoreCache.keys().next().value);
  }
};

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
  crossEncoderScoreCache.clear();
};

export const resetCrossEncoderProvider = () => {
  crossEncoderProvider = null;
  crossEncoderScoreCache.clear();
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
  }, { recorder: recordModelMetricEventWithQuota });
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
        // The service's own score, before the min-max above over this one
        // rerank call: the only one comparable across calls, which the QA
        // gate needs (getQaMinRerankProbability in config.js).
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

// TEI's default --max-client-batch-size: a longer rerank goes out in several
// requests. A multiple of the bundled endpoint's batch size (8), so that
// endpoint pads, and scores, each passage as in one long request.
// shortcut: fixed at 32, make it a setting when a service caps lower.
const CROSS_ENCODER_MAX_TEXTS_PER_REQUEST = 32;

/**
 * One rerank at a cross-encoder service ({ query, texts } -> { scores }), sent
 * at once as requests of at most CROSS_ENCODER_MAX_TEXTS_PER_REQUEST texts
 * that share one timeout. Resolves the scores in the order of `texts`, or none
 * of them. An HTTP failure carries `status` and `upstreamStatus`; a timeout
 * carries code ETIMEDOUT. `signal` (the model gateway's, when its caller
 * leaves or its deadline passes) cancels the rerank and rejects with its
 * reason, which is not a timeout.
 */
export const requestCrossEncoderScores = async ({ endpoint, model = "", queryText, signal: callerSignal, texts }) => {
  const timeoutMs = getCrossEncoderTimeoutMs();
  // A cancelled agent request (request-deadline.js) aborts the call too.
  const signal = withRequestSignal(callerSignal);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const siblings = new AbortController();
  const requestSignal = AbortSignal.any([timeoutSignal, siblings.signal, ...(signal ? [signal] : [])]);
  const batches = [];

  for (let start = 0; start < texts.length; start += CROSS_ENCODER_MAX_TEXTS_PER_REQUEST) {
    batches.push(texts.slice(start, start + CROSS_ENCODER_MAX_TEXTS_PER_REQUEST));
  }

  // At once, so they queue next to each other, much as one request did: in
  // turn, each would queue again behind every other rerank, and overlapping
  // reranks would time out together.
  const scores = await Promise.all(
    batches.map(async (batch) => {
      let response;
      let payload;

      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: queryText,
            texts: batch,
            ...(model ? { model } : {}),
          }),
          signal: requestSignal,
        });
        // Read in here: the timeout or the caller can end the body as well.
        payload = response.ok ? await response.json() : null;
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

      return parseCrossEncoderScores(payload, batch.length);
    })
  ).catch((error) => {
    // None of this rerank's scores can be used now: close its other requests.
    siblings.abort();
    throw error;
  });

  return scores.flat();
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
 * the whole rerank, and records one LLMOps rerank event for the call. Resolves
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

// Where a cross-encoder request goes (`address`: the endpoint or the gateway's
// URLs) and the model it names.
const resolveCrossEncoderTarget = () => {
  if (crossEncoderProvider?.score) {
    return {
      address: "",
      routeSelection: {
        llmOpsContext: buildEmptyLlmOpsRouteContext(),
        model: "",
        modelRoute: buildCustomCrossEncoderModelRoute(),
      },
      transport: "custom-provider",
      viaGateway: false,
    };
  }

  const viaGateway = routesRerankThroughModelGateway();

  return {
    address: viaGateway ? getModelGatewayUrls().join(" ") : getCrossEncoderEndpoint().trim(),
    routeSelection: resolveCrossEncoderModelRoute(),
    transport: viaGateway ? "model-gateway" : "http",
    viaGateway,
  };
};

const scoreWithCrossEncoder = async ({ queryText, results, target: { routeSelection, transport, viaGateway } }) => {
  const pairs = buildCrossEncoderPairs(results);
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
  // In-process per-workspace quota (model-call-quota.js), before the call is
  // sent; the gateway admits a call routed to it. A refusal degrades the query
  // to the fused order like any rerank failure (rerankResultsOrKeepOrder).
  const admission = viaGateway ? null : admitModelCallQuota();

  if (admission) {
    await admission;
  }

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

  const target = resolveCrossEncoderTarget();
  const keyPrefix = [
    getActiveDatabaseTenant() ?? getDatabaseTenantContext(),
    target.transport,
    target.address,
    target.routeSelection.model,
    getCrossEncoderScoreScale(),
    queryText,
  ];
  const keys = safeResults.map((result) =>
    createHash("sha256").update(JSON.stringify([...keyPrefix, buildSearchableText(result)])).digest("hex")
  );
  // Read before storing, so storing cannot evict this call's own hits.
  const scores = keys.map(recallCrossEncoderScore);
  const missing = scores.flatMap((score, index) => (score === undefined ? [index] : []));

  if (missing.length > 0) {
    const fresh = await scoreWithCrossEncoder({
      queryText,
      results: missing.map((index) => safeResults[index]),
      target,
    });

    if (!Array.isArray(fresh) || fresh.length !== missing.length) {
      throw new Error(
        `Cross-encoder returned ${fresh?.length ?? 0} score(s) for ${missing.length} candidate(s).`
      );
    }

    missing.forEach((resultIndex, freshIndex) => {
      scores[resultIndex] = fresh[freshIndex];
      rememberCrossEncoderScore(keys[resultIndex], fresh[freshIndex]);
    });
  }

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
// logged once per distinct message. `keptOrder` is that order for `results`
// merged from several queries' candidates: each query's own fused top-K
// (document-rag-execution.js rerankRetrievalStep).
const reportedRerankFallbacks = new Set();

export const rerankResultsOrKeepOrder = async ({ queryText = "", results = [], topK, keptOrder } = {}) => {
  try {
    return await observeRerank(() => rerankResultsWithProvider({ queryText, results, topK }));
  } catch (error) {
    recordRerankDegradation();
    const message = error?.message ?? String(error);

    if (!reportedRerankFallbacks.has(message)) {
      reportedRerankFallbacks.add(message);
      console.warn(`Rerank failed (${message}); keeping the retrieval order for this query.`);
    }

    const safeResults = Array.isArray(results) ? results : [];

    return keptOrder ?? safeResults.slice(0, normalizeTopK(topK, safeResults.length));
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
