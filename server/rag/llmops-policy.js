export class LlmOpsBudgetExceededError extends Error {
  constructor({ budget = null } = {}) {
    super("LLMOps budget exceeded.");
    this.name = "LlmOpsBudgetExceededError";
    this.status = 429;
    this.budget = budget;
  }
}

export const LLMOPS_ALERT_SEVERITIES = Object.freeze({
  error: "error",
  info: "info",
  warn: "warn",
});

export const LLMOPS_BUDGET_STATUSES = Object.freeze({
  exceeded: "exceeded",
  ok: "ok",
  unavailable: "unavailable",
});

const MAX_TEXT_LENGTH = 160;
const VALID_ALERT_SEVERITIES = new Set(Object.values(LLMOPS_ALERT_SEVERITIES));
const VALID_BUDGET_STATUSES = new Set(Object.values(LLMOPS_BUDGET_STATUSES));
const VALID_ENFORCEMENT_MODES = new Set(["block", "record"]);

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

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

const normalizeKnownValue = ({ fallbackValue, validValues, value }) => {
  const normalizedValue = normalizeText(value).toLowerCase();

  return validValues.has(normalizedValue) ? normalizedValue : fallbackValue;
};

const normalizeSeverity = (value) =>
  normalizeKnownValue({
    fallbackValue: LLMOPS_ALERT_SEVERITIES.info,
    validValues: VALID_ALERT_SEVERITIES,
    value,
  });

const compactNumericSignal = (value) => {
  const normalizedValue = normalizeOptionalNonNegativeNumber(value);

  return normalizedValue === null ? null : Number(normalizedValue.toFixed(8));
};

export const normalizeLlmOpsAnnotation = (annotation = {}) => {
  const annotationRecord = normalizeRecord(annotation);
  const id = normalizeText(annotationRecord.id, 120);

  if (!id) {
    return null;
  }

  return {
    category: normalizeText(annotationRecord.category, 80) || "runtime",
    id,
    severity: normalizeSeverity(annotationRecord.severity),
    source: normalizeText(annotationRecord.source, 80) || "llmops_policy",
  };
};

export const normalizeLlmOpsAnnotations = (annotations = []) =>
  toArray(annotations).map(normalizeLlmOpsAnnotation).filter(Boolean);

export const normalizeLlmOpsAlert = (alert = {}) => {
  const alertRecord = normalizeRecord(alert);
  const id = normalizeText(alertRecord.id, 120);

  if (!id) {
    return null;
  }

  return {
    category: normalizeText(alertRecord.category, 80) || "runtime",
    id,
    observed: compactNumericSignal(alertRecord.observed),
    severity: normalizeSeverity(alertRecord.severity),
    threshold: compactNumericSignal(alertRecord.threshold),
  };
};

export const normalizeLlmOpsAlerts = (alerts = []) =>
  toArray(alerts).map(normalizeLlmOpsAlert).filter(Boolean);

export const normalizeLlmOpsBudget = (budget = {}) => {
  const budgetRecord = normalizeRecord(budget);
  const limits = normalizeRecord(budgetRecord.limits);
  const observed = normalizeRecord(budgetRecord.observed);
  const status = normalizeKnownValue({
    fallbackValue: LLMOPS_BUDGET_STATUSES.unavailable,
    validValues: VALID_BUDGET_STATUSES,
    value: budgetRecord.status,
  });

  return {
    exceededKeys: toArray(budgetRecord.exceededKeys)
      .map((key) => normalizeText(key, 120))
      .filter(Boolean),
    limits: {
      maxEstimatedCostUsdPerEvent: compactNumericSignal(
        limits.maxEstimatedCostUsdPerEvent
      ),
      maxTotalTokensPerEvent: normalizeOptionalNonNegativeInteger(
        limits.maxTotalTokensPerEvent
      ),
    },
    observed: {
      estimatedCostUsd: compactNumericSignal(observed.estimatedCostUsd),
      totalTokens: normalizeOptionalNonNegativeInteger(observed.totalTokens),
    },
    status,
  };
};

export const normalizeLlmOpsPolicy = (policy = {}) => {
  const policyRecord = normalizeRecord(policy);
  const budget = normalizeRecord(policyRecord.budget);
  const alerts = normalizeRecord(policyRecord.alerts);
  const enforcementMode = normalizeKnownValue({
    fallbackValue: "record",
    validValues: VALID_ENFORCEMENT_MODES,
    value: policyRecord.enforcementMode,
  });

  return {
    alerts: {
      budgetExceeded: alerts.budgetExceeded !== false,
      errorStatus: alerts.errorStatus !== false,
      estimatedUsage: alerts.estimatedUsage === true,
      latencySloBreach: alerts.latencySloBreach !== false,
      pricingUnavailable: alerts.pricingUnavailable === true,
    },
    budget: {
      maxEstimatedCostUsdPerEvent: normalizeOptionalNonNegativeNumber(
        budget.maxEstimatedCostUsdPerEvent
      ),
      maxTotalTokensPerEvent: normalizeOptionalNonNegativeInteger(
        budget.maxTotalTokensPerEvent
      ),
    },
    enabled: policyRecord.enabled !== false,
    enforcementMode,
  };
};

const createPolicyAnnotation = ({ category, id, severity }) => ({
  category,
  id,
  severity,
  source: "llmops_policy",
});

const createPolicyAlert = ({
  category,
  id,
  observed = null,
  severity,
  threshold = null,
}) => ({
  category,
  id,
  observed,
  severity,
  threshold,
});

const evaluateBudget = ({ metric = {}, policy = {} } = {}) => {
  const exceededKeys = [];
  const observedCost = normalizeOptionalNonNegativeNumber(metric.estimatedCostUsd);
  const observedTokens = normalizeOptionalNonNegativeInteger(metric.totalTokens);
  const maxCost = policy.budget.maxEstimatedCostUsdPerEvent;
  const maxTokens = policy.budget.maxTotalTokensPerEvent;

  if (maxCost !== null && observedCost !== null && observedCost > maxCost) {
    exceededKeys.push("estimated_cost_usd");
  }

  if (maxTokens !== null && observedTokens !== null && observedTokens > maxTokens) {
    exceededKeys.push("total_tokens");
  }

  const status =
    maxCost === null && maxTokens === null
      ? LLMOPS_BUDGET_STATUSES.unavailable
      : exceededKeys.length > 0
        ? LLMOPS_BUDGET_STATUSES.exceeded
        : LLMOPS_BUDGET_STATUSES.ok;

  return normalizeLlmOpsBudget({
    exceededKeys,
    limits: {
      maxEstimatedCostUsdPerEvent: maxCost,
      maxTotalTokensPerEvent: maxTokens,
    },
    observed: {
      estimatedCostUsd: observedCost,
      totalTokens: observedTokens,
    },
    status,
  });
};

export const evaluateLlmOpsPolicy = ({ metric = {}, policy = {} } = {}) => {
  const normalizedPolicy = normalizeLlmOpsPolicy(policy);

  if (!normalizedPolicy.enabled) {
    return {
      annotations: [],
      alerts: [],
      budget: normalizeLlmOpsBudget(),
    };
  }

  const annotations = [];
  const alerts = [];
  const budget = evaluateBudget({
    metric,
    policy: normalizedPolicy,
  });

  if (metric.status === "error") {
    annotations.push(
      createPolicyAnnotation({
        category: "status",
        id: "llmops_status_error",
        severity: LLMOPS_ALERT_SEVERITIES.error,
      })
    );

    if (normalizedPolicy.alerts.errorStatus) {
      alerts.push(
        createPolicyAlert({
          category: "status",
          id: "llmops_status_error",
          severity: LLMOPS_ALERT_SEVERITIES.error,
        })
      );
    }
  }

  if (metric.latencySloStatus === "breach") {
    annotations.push(
      createPolicyAnnotation({
        category: "latency",
        id: "llmops_latency_slo_breach",
        severity: LLMOPS_ALERT_SEVERITIES.warn,
      })
    );

    if (normalizedPolicy.alerts.latencySloBreach) {
      alerts.push(
        createPolicyAlert({
          category: "latency",
          id: "llmops_latency_slo_breach",
          observed: metric.latencyMs,
          severity: LLMOPS_ALERT_SEVERITIES.warn,
          threshold: metric.latencySloMs,
        })
      );
    }
  }

  if (metric.tokenSource === "estimated") {
    annotations.push(
      createPolicyAnnotation({
        category: "usage",
        id: "llmops_usage_estimated",
        severity: LLMOPS_ALERT_SEVERITIES.info,
      })
    );

    if (normalizedPolicy.alerts.estimatedUsage) {
      alerts.push(
        createPolicyAlert({
          category: "usage",
          id: "llmops_usage_estimated",
          severity: LLMOPS_ALERT_SEVERITIES.info,
        })
      );
    }
  }

  if (metric.pricingSource === "unavailable") {
    annotations.push(
      createPolicyAnnotation({
        category: "cost",
        id: "llmops_pricing_unavailable",
        severity: LLMOPS_ALERT_SEVERITIES.info,
      })
    );

    if (normalizedPolicy.alerts.pricingUnavailable) {
      alerts.push(
        createPolicyAlert({
          category: "cost",
          id: "llmops_pricing_unavailable",
          severity: LLMOPS_ALERT_SEVERITIES.info,
        })
      );
    }
  }

  if (budget.status === LLMOPS_BUDGET_STATUSES.exceeded) {
    annotations.push(
      createPolicyAnnotation({
        category: "budget",
        id: "llmops_budget_exceeded",
        severity:
          normalizedPolicy.enforcementMode === "block"
            ? LLMOPS_ALERT_SEVERITIES.error
            : LLMOPS_ALERT_SEVERITIES.warn,
      })
    );

    if (normalizedPolicy.alerts.budgetExceeded) {
      alerts.push(
        createPolicyAlert({
          category: "budget",
          id: "llmops_budget_exceeded",
          observed: budget.observed.estimatedCostUsd ?? budget.observed.totalTokens,
          severity:
            normalizedPolicy.enforcementMode === "block"
              ? LLMOPS_ALERT_SEVERITIES.error
              : LLMOPS_ALERT_SEVERITIES.warn,
          threshold:
            budget.limits.maxEstimatedCostUsdPerEvent ??
            budget.limits.maxTotalTokensPerEvent,
        })
      );
    }
  }

  return {
    annotations: normalizeLlmOpsAnnotations(annotations),
    alerts: normalizeLlmOpsAlerts(alerts),
    budget,
  };
};

export const assertLlmOpsBudgetAllowed = ({ budget, policy = {} } = {}) => {
  const normalizedPolicy = normalizeLlmOpsPolicy(policy);

  if (
    normalizedPolicy.enabled &&
    normalizedPolicy.enforcementMode === "block" &&
    budget?.status === LLMOPS_BUDGET_STATUSES.exceeded
  ) {
    throw new LlmOpsBudgetExceededError({
      budget,
    });
  }
};
