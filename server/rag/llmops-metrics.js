import { performance } from "node:perf_hooks";
import { recordRagTrace } from "./observability.js";

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

const normalizeErrorFields = ({ error, errorName, errorMessage } = {}) => ({
  errorMessage:
    normalizeText(errorMessage ?? error?.message, MAX_TEXT_LENGTH) || null,
  errorName: normalizeText(errorName ?? error?.name, 160) || null,
});

export const normalizeLlmOpsMetricEvent = (metric = {}) => {
  const errorFields = normalizeErrorFields(metric);

  return {
    traceType: LLMOPS_TRACE_TYPE,
    eventType: LLMOPS_METRIC_EVENT_TYPE,
    version: LLMOPS_METRIC_VERSION,
    timestamp: normalizeText(metric.timestamp, 80) || null,
    operation: normalizeText(metric.operation, 120) || "unknown",
    stage: normalizeText(metric.stage, 120) || "unknown",
    status: normalizeMetricStatus(metric.status),
    latencyMs: roundMetricNumber(metric.latencyMs),
    modelRoute: normalizeLlmOpsModelRoute(metric.modelRoute),
    inputCharacters: normalizeOptionalNonNegativeInteger(metric.inputCharacters),
    outputCharacters: normalizeOptionalNonNegativeInteger(metric.outputCharacters),
    itemCount: normalizeOptionalNonNegativeInteger(metric.itemCount),
    ...errorFields,
  };
};

export const recordLlmOpsMetric = async (
  metric = {},
  {
    now = () => new Date().toISOString(),
    recorder = recordRagTrace,
  } = {}
) => {
  const event = normalizeLlmOpsMetricEvent({
    ...metric,
    timestamp: metric.timestamp ?? now(),
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
  recorder,
  successMetric = () => ({}),
} = {}) => {
  if (typeof action !== "function") {
    throw new TypeError("LLMOps metric action must be a function.");
  }

  const startedAt = performance.now();

  try {
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
        status: "error",
      },
      {
        now,
        recorder,
      }
    );

    throw error;
  }
};
