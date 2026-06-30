export const LLMOPS_TOKEN_SOURCES = Object.freeze({
  actual: "actual",
  estimated: "estimated",
  unavailable: "unavailable",
});

export const LLMOPS_PRICING_SOURCES = Object.freeze({
  modelContract: "model_contract",
  unavailable: "unavailable",
});

const CHARACTERS_PER_TOKEN_ESTIMATE = 4;

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const normalizeText = (value, fallback = "") =>
  String(value ?? fallback).replace(/\s+/g, " ").trim();

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

const roundCost = (value) =>
  Number.isFinite(value) ? Number(value.toFixed(8)) : null;

const getFirstNumber = (record = {}, keys = []) => {
  for (const key of keys) {
    const parsedValue = normalizeOptionalNonNegativeInteger(record[key]);

    if (parsedValue !== null) {
      return parsedValue;
    }
  }

  return null;
};

export const estimateTokenCountFromCharacters = (characters) => {
  const normalizedCharacters = normalizeOptionalNonNegativeInteger(characters);

  if (normalizedCharacters === null) {
    return null;
  }

  return normalizedCharacters === 0
    ? 0
    : Math.max(1, Math.ceil(normalizedCharacters / CHARACTERS_PER_TOKEN_ESTIMATE));
};

export const normalizeLlmOpsTokenUsage = ({
  inputTokens = null,
  outputTokens = null,
  tokenSource = LLMOPS_TOKEN_SOURCES.unavailable,
  totalTokens = null,
} = {}) => {
  const normalizedInputTokens = normalizeOptionalNonNegativeInteger(inputTokens);
  const normalizedOutputTokens = normalizeOptionalNonNegativeInteger(outputTokens);
  const normalizedTotalTokens =
    normalizeOptionalNonNegativeInteger(totalTokens) ??
    (normalizedInputTokens !== null || normalizedOutputTokens !== null
      ? (normalizedInputTokens ?? 0) + (normalizedOutputTokens ?? 0)
      : null);
  const normalizedTokenSource = normalizeText(tokenSource).toLowerCase();

  return {
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    tokenSource: Object.values(LLMOPS_TOKEN_SOURCES).includes(normalizedTokenSource)
      ? normalizedTokenSource
      : LLMOPS_TOKEN_SOURCES.unavailable,
    totalTokens: normalizedTotalTokens,
  };
};

const normalizeUsageCandidate = ({
  candidate = {},
  tokenSource = LLMOPS_TOKEN_SOURCES.actual,
} = {}) => {
  const usageRecord = normalizeRecord(candidate);
  const inputTokens = getFirstNumber(usageRecord, [
    "input_tokens",
    "prompt_tokens",
    "promptTokens",
    "inputTokens",
  ]);
  const outputTokens = getFirstNumber(usageRecord, [
    "output_tokens",
    "completion_tokens",
    "completionTokens",
    "outputTokens",
  ]);
  const totalTokens = getFirstNumber(usageRecord, [
    "total_tokens",
    "totalTokens",
  ]);

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return null;
  }

  return normalizeLlmOpsTokenUsage({
    inputTokens,
    outputTokens,
    tokenSource,
    totalTokens,
  });
};

export const extractLlmOpsTokenUsageFromResponse = (response = {}) => {
  const responseRecord = normalizeRecord(response, null);

  if (!responseRecord) {
    return null;
  }

  const candidates = [
    {
      candidate: responseRecord.usage_metadata,
      tokenSource: LLMOPS_TOKEN_SOURCES.actual,
    },
    {
      candidate: responseRecord.usageMetadata,
      tokenSource: LLMOPS_TOKEN_SOURCES.actual,
    },
    {
      candidate: responseRecord.response_metadata?.usage,
      tokenSource: LLMOPS_TOKEN_SOURCES.actual,
    },
    {
      candidate: responseRecord.response_metadata?.tokenUsage,
      tokenSource: LLMOPS_TOKEN_SOURCES.actual,
    },
    {
      candidate: responseRecord.responseMetadata?.usage,
      tokenSource: LLMOPS_TOKEN_SOURCES.actual,
    },
    {
      candidate: responseRecord.responseMetadata?.tokenUsage,
      tokenSource: LLMOPS_TOKEN_SOURCES.actual,
    },
    {
      candidate: responseRecord.llmOutput?.tokenUsage,
      tokenSource: LLMOPS_TOKEN_SOURCES.actual,
    },
    {
      candidate: responseRecord.llmOutput?.estimatedTokenUsage,
      tokenSource: LLMOPS_TOKEN_SOURCES.estimated,
    },
    {
      candidate: responseRecord.usage,
      tokenSource: LLMOPS_TOKEN_SOURCES.actual,
    },
  ];

  for (const candidate of candidates) {
    const usage = normalizeUsageCandidate(candidate);

    if (usage) {
      return usage;
    }
  }

  return null;
};

export const buildEstimatedLlmOpsTokenUsage = ({
  inputCharacters = 0,
  outputCharacters = 0,
} = {}) =>
  normalizeLlmOpsTokenUsage({
    inputTokens: estimateTokenCountFromCharacters(inputCharacters),
    outputTokens: estimateTokenCountFromCharacters(outputCharacters),
    tokenSource: LLMOPS_TOKEN_SOURCES.estimated,
  });

export const normalizeLlmOpsPricing = (pricing = {}) => {
  const pricingRecord = normalizeRecord(pricing);

  return {
    currency: normalizeText(pricingRecord.currency, "USD").toUpperCase() || "USD",
    inputPerMillionTokens: normalizeOptionalNonNegativeNumber(
      pricingRecord.inputPerMillionTokens
    ),
    outputPerMillionTokens: normalizeOptionalNonNegativeNumber(
      pricingRecord.outputPerMillionTokens
    ),
  };
};

export const estimateLlmOpsCost = ({ pricing = {}, usage = {} } = {}) => {
  const normalizedPricing = normalizeLlmOpsPricing(pricing);
  const normalizedUsage = normalizeLlmOpsTokenUsage(usage);

  if (
    normalizedPricing.currency !== "USD" ||
    normalizedPricing.inputPerMillionTokens === null ||
    normalizedPricing.outputPerMillionTokens === null ||
    normalizedUsage.inputTokens === null ||
    normalizedUsage.outputTokens === null
  ) {
    return {
      costCurrency: normalizedPricing.currency,
      estimatedCostUsd: null,
      pricingSource: LLMOPS_PRICING_SOURCES.unavailable,
    };
  }

  return {
    costCurrency: "USD",
    estimatedCostUsd: roundCost(
      (normalizedUsage.inputTokens / 1_000_000) *
        normalizedPricing.inputPerMillionTokens +
        (normalizedUsage.outputTokens / 1_000_000) *
          normalizedPricing.outputPerMillionTokens
    ),
    pricingSource: LLMOPS_PRICING_SOURCES.modelContract,
  };
};

export const buildLlmOpsUsageMetric = ({
  inputCharacters = 0,
  outputCharacters = 0,
  pricing = {},
  response = null,
} = {}) => {
  const usage =
    extractLlmOpsTokenUsageFromResponse(response) ??
    buildEstimatedLlmOpsTokenUsage({
      inputCharacters,
      outputCharacters,
    });
  const cost = estimateLlmOpsCost({
    pricing,
    usage,
  });

  return {
    ...usage,
    ...cost,
  };
};

export const buildLlmOpsRouteContext = (resolvedRoute = {}) => {
  const routeRecord = normalizeRecord(resolvedRoute);
  const selectedModel = normalizeRecord(routeRecord.selectedModel, null);

  if (!selectedModel) {
    return {
      latencySloMs: null,
      pricing: normalizeLlmOpsPricing(),
    };
  }

  return {
    latencySloMs: normalizeOptionalNonNegativeInteger(
      selectedModel.latency?.timeoutMs
    ),
    pricing: normalizeLlmOpsPricing(selectedModel.pricing),
  };
};
