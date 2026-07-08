import { performance } from "node:perf_hooks";
import {
  assertLlmOpsBudgetAllowed,
  evaluateLlmOpsPolicy,
  LlmOpsBudgetExceededError,
  normalizeLlmOpsAlerts,
  normalizeLlmOpsAnnotations,
  normalizeLlmOpsBudget,
} from "./llmops-policy.js";
import { recordRagTrace } from "./observability.js";

export { LlmOpsBudgetExceededError } from "./llmops-policy.js";

export const LLMOPS_TRACE_TYPE = "llmops";
export const LLMOPS_METRIC_EVENT_TYPE = "llmops_metric";
export const LLMOPS_METRIC_VERSION = "1.0.0";

export const LLMOPS_OPERATIONS = Object.freeze({
  completion: "llm_completion",
  embedding: "embedding",
  rerank: "rerank",
});

const MAX_TEXT_LENGTH = 500;
const VALID_METRIC_STATUSES = new Set(["ok", "error", "skipped"]);
const VALID_TOKEN_SOURCES = new Set(["actual", "estimated", "unavailable"]);
const VALID_PRICING_SOURCES = new Set(["model_contract", "unavailable"]);
const VALID_LATENCY_SLO_STATUSES = new Set(["pass", "breach", "unavailable"]);

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeArray = (value) =>
  (Array.isArray(value) ? value : []).map((item) => normalizeText(item)).filter(Boolean);

const normalizeOptionalNonNegativeNumber = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : null;
};

const normalizeOptionalNonNegativeInteger = (value) => {
  const parsedValue = normalizeOptionalNonNegativeNumber(value);

  return parsedValue === null ? null : Math.floor(parsedValue);
};

const roundMetricNumber = (value) => {
  const parsedValue = normalizeOptionalNonNegativeNumber(value);

  return parsedValue === null ? null : Number(parsedValue.toFixed(3));
};

const roundCostNumber = (value) => {
  const parsedValue = normalizeOptionalNonNegativeNumber(value);

  return parsedValue === null ? null : Number(parsedValue.toFixed(8));
};

export const normalizeLlmOpsModelRoute = (modelRoute = {}) => {
  if (!modelRoute || typeof modelRoute !== "object" || Array.isArray(modelRoute)) {
    return null;
  }

  return {
    candidateModelIds: normalizeArray(modelRoute.candidateModelIds),
    capability: normalizeText(modelRoute.capability, 120),
    fallbackModelIds: normalizeArray(modelRoute.fallbackModelIds),
    modelId: normalizeText(modelRoute.modelId, 160) || null,
    providerId: normalizeText(modelRoute.providerId, 120) || null,
    rejectedModelIds: normalizeArray(modelRoute.rejectedModelIds),
    routeId: normalizeText(modelRoute.routeId, 160) || null,
    status: normalizeText(modelRoute.status, 80) || "unknown",
  };
};

const normalizeMetricStatus = (status) => {
  const normalizedStatus = normalizeText(status, 40).toLowerCase();

  return VALID_METRIC_STATUSES.has(normalizedStatus)
    ? normalizedStatus
    : "unknown";
};

const normalizeKnownValue = ({ fallbackValue, maxLength = 80, validValues, value }) => {
  const normalizedValue = normalizeText(value, maxLength).toLowerCase();

  return validValues.has(normalizedValue) ? normalizedValue : fallbackValue;
};

const normalizeCostCurrency = (value) =>
  normalizeText(value, 20).toUpperCase() || null;

const getLatencySloStatus = ({ latencyMs, latencySloMs, latencySloStatus }) => {
  const explicitStatus = normalizeKnownValue({
    fallbackValue: "",
    validValues: VALID_LATENCY_SLO_STATUSES,
    value: latencySloStatus,
  });

  if (explicitStatus) {
    return explicitStatus;
  }

  if (latencyMs === null || latencySloMs === null) {
    return "unavailable";
  }

  return latencyMs <= latencySloMs ? "pass" : "breach";
};

const normalizeErrorFields = ({ error, errorName, errorMessage } = {}) => ({
  errorMessage:
    normalizeText(errorMessage ?? error?.message, MAX_TEXT_LENGTH) || null,
  errorName: normalizeText(errorName ?? error?.name, 160) || null,
});

const mergeSignalList = (left = [], right = []) => {
  const seen = new Set();
  const merged = [];

  for (const signal of [...left, ...right]) {
    const key = [
      signal?.id,
      signal?.category,
      signal?.severity,
      signal?.source,
      signal?.threshold,
      signal?.observed,
    ].join(":");

    if (!signal?.id || seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(signal);
  }

  return merged;
};

export const normalizeLlmOpsMetricEvent = (metric = {}) => {
  const errorFields = normalizeErrorFields(metric);
  const latencyMs = roundMetricNumber(metric.latencyMs);
  const latencySloMs = normalizeOptionalNonNegativeInteger(metric.latencySloMs);

  return {
    traceType: LLMOPS_TRACE_TYPE,
    eventType: LLMOPS_METRIC_EVENT_TYPE,
    version: LLMOPS_METRIC_VERSION,
    timestamp: normalizeText(metric.timestamp, 80) || null,
    operation: normalizeText(metric.operation, 120) || "unknown",
    stage: normalizeText(metric.stage, 120) || "unknown",
    status: normalizeMetricStatus(metric.status),
    latencyMs,
    latencySloMs,
    latencySloStatus: getLatencySloStatus({
      latencyMs,
      latencySloMs,
      latencySloStatus: metric.latencySloStatus,
    }),
    modelRoute: normalizeLlmOpsModelRoute(metric.modelRoute),
    inputCharacters: normalizeOptionalNonNegativeInteger(metric.inputCharacters),
    outputCharacters: normalizeOptionalNonNegativeInteger(metric.outputCharacters),
    itemCount: normalizeOptionalNonNegativeInteger(metric.itemCount),
    inputTokens: normalizeOptionalNonNegativeInteger(metric.inputTokens),
    outputTokens: normalizeOptionalNonNegativeInteger(metric.outputTokens),
    totalTokens: normalizeOptionalNonNegativeInteger(metric.totalTokens),
    tokenSource: normalizeKnownValue({
      fallbackValue: "unavailable",
      validValues: VALID_TOKEN_SOURCES,
      value: metric.tokenSource,
    }),
    estimatedCostUsd: roundCostNumber(metric.estimatedCostUsd),
    pricingSource: normalizeKnownValue({
      fallbackValue: "unavailable",
      validValues: VALID_PRICING_SOURCES,
      value: metric.pricingSource,
    }),
    costCurrency: normalizeCostCurrency(metric.costCurrency),
    annotations: normalizeLlmOpsAnnotations(metric.annotations),
    alerts: normalizeLlmOpsAlerts(metric.alerts),
    budget: normalizeLlmOpsBudget(metric.budget),
    ...errorFields,
  };
};

export const recordLlmOpsMetric = async (
  metric = {},
  {
    now = () => new Date().toISOString(),
    policy = {},
    recorder = recordRagTrace,
  } = {}
) => {
  const baseEvent = normalizeLlmOpsMetricEvent({
    ...metric,
    timestamp: metric.timestamp ?? now(),
  });
  const policySignals = evaluateLlmOpsPolicy({
    metric: baseEvent,
    policy,
  });
  const event = normalizeLlmOpsMetricEvent({
    ...baseEvent,
    ...policySignals,
    alerts: mergeSignalList(baseEvent.alerts, policySignals.alerts),
    annotations: mergeSignalList(
      baseEvent.annotations,
      policySignals.annotations
    ),
  });

  try {
    await recorder(event);
  } catch (error) {
    console.error("Failed to write LLMOps metric event.", error);
  }

  return event;
};

export const runWithLlmOpsMetric = async ({
  action,
  metric = {},
  now,
  policy = {},
  recorder,
  successMetric = () => ({}),
} = {}) => {
  if (typeof action !== "function") {
    throw new TypeError("LLMOps metric action must be a function.");
  }

  const startedAt = performance.now();
  const preflightEvent = normalizeLlmOpsMetricEvent(metric);
  const preflightPolicySignals = evaluateLlmOpsPolicy({
    metric: preflightEvent,
    policy,
  });

  try {
    assertLlmOpsBudgetAllowed({
      budget: preflightPolicySignals.budget,
      policy,
    });

    const result = await action();
    await recordLlmOpsMetric(
      {
        ...metric,
        ...successMetric(result),
        latencyMs: performance.now() - startedAt,
        status: "ok",
      },
      {
        now,
        policy,
        recorder,
      }
    );

    return result;
  } catch (error) {
    await recordLlmOpsMetric(
      {
        ...metric,
        error,
        latencyMs: performance.now() - startedAt,
        status: error instanceof LlmOpsBudgetExceededError ? "skipped" : "error",
      },
      {
        now,
        policy,
        recorder,
      }
    );

    throw error;
  }
};
