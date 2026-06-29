export const MODEL_PROVIDER_TYPE = "model_provider";
export const MODEL_PROVIDER_SPEC_VERSION = "1.0.0";

export const MODEL_CAPABILITIES = Object.freeze({
  chat: "chat",
  embedding: "embedding",
  executionPlanner: "execution_planner",
  intentPlanner: "intent_planner",
  rerank: "rerank",
});

export const MODEL_ROUTE_IDS = Object.freeze({
  chatDefault: "chat.default",
  embeddingDefault: "embedding.default",
  executionPlannerDefault: "planner.execution.default",
  intentPlannerDefault: "planner.intent.default",
  rerankCrossEncoderDefault: "rerank.cross_encoder.default",
});

const VALID_MODEL_CAPABILITIES = new Set(Object.values(MODEL_CAPABILITIES));
const MAX_TEXT_LENGTH = 320;

const normalizeBoundedText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const cloneJson = (value, fallback = {}) =>
  JSON.parse(JSON.stringify(value ?? fallback));

const normalizeTextList = (value, maxLength = MAX_TEXT_LENGTH) =>
  toArray(value).map((item) => normalizeBoundedText(item, maxLength)).filter(Boolean);

const normalizeOptionalNumber = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
};

const normalizePositiveInteger = (value) => {
  const parsedValue = normalizeOptionalNumber(value);

  return parsedValue === null ? null : Math.max(1, Math.trunc(parsedValue));
};

const normalizeNonNegativeNumber = (value) => {
  const parsedValue = normalizeOptionalNumber(value);

  return parsedValue === null ? null : Math.max(0, parsedValue);
};

const normalizeTransport = (transport = {}) => {
  const transportRecord = normalizeRecord(transport);

  return {
    auth: {
      mode: normalizeBoundedText(transportRecord.auth?.mode, 80) || "none",
      secretRef: normalizeBoundedText(transportRecord.auth?.secretRef, 120),
    },
    baseUrl: normalizeBoundedText(transportRecord.baseUrl, 500),
    type: normalizeBoundedText(transportRecord.type, 80),
  };
};

const normalizePricing = (pricing = {}) => {
  const pricingRecord = normalizeRecord(pricing);

  return {
    currency: normalizeBoundedText(pricingRecord.currency, 20) || "USD",
    inputPerMillionTokens: normalizeNonNegativeNumber(
      pricingRecord.inputPerMillionTokens
    ),
    outputPerMillionTokens: normalizeNonNegativeNumber(
      pricingRecord.outputPerMillionTokens
    ),
  };
};

const normalizeLatency = (latency = {}) => {
  const latencyRecord = normalizeRecord(latency);

  return {
    tier: normalizeBoundedText(latencyRecord.tier, 80),
    timeoutMs: normalizePositiveInteger(latencyRecord.timeoutMs),
  };
};

const normalizeModelPolicy = (policy = {}) => {
  const policyRecord = normalizeRecord(policy);

  return {
    allowExternalCall: policyRecord.allowExternalCall !== false,
    dataRetention: normalizeBoundedText(policyRecord.dataRetention, 120),
    workspacePolicyTags: normalizeTextList(policyRecord.workspacePolicyTags, 80),
  };
};

export const normalizeModelContract = (model = {}, provider = {}) => {
  const modelRecord = normalizeRecord(model);
  const providerRecord = normalizeRecord(provider);

  return {
    capabilities: normalizeTextList(modelRecord.capabilities, 80),
    contextWindowTokens: normalizePositiveInteger(
      modelRecord.contextWindowTokens
    ),
    dimensions: normalizePositiveInteger(modelRecord.dimensions),
    id: normalizeBoundedText(modelRecord.id, 160),
    label: normalizeBoundedText(modelRecord.label, 160),
    latency: normalizeLatency(modelRecord.latency),
    modelName: normalizeBoundedText(modelRecord.modelName, 160),
    policy: normalizeModelPolicy(modelRecord.policy),
    pricing: normalizePricing(modelRecord.pricing),
    providerId: normalizeBoundedText(providerRecord.id, 120),
    providerType: normalizeBoundedText(providerRecord.type, 80),
    version:
      normalizeBoundedText(modelRecord.version, 40) ||
      normalizeBoundedText(providerRecord.version, 40) ||
      MODEL_PROVIDER_SPEC_VERSION,
  };
};

const normalizeFallbackModelIds = ({ fallbackModelIds, primaryModelId }) => {
  const seenModelIds = new Set([primaryModelId]);

  return normalizeTextList(fallbackModelIds, 160).filter((modelId) => {
    if (seenModelIds.has(modelId)) {
      return false;
    }

    seenModelIds.add(modelId);
    return true;
  });
};

export const normalizeModelRoute = (route = {}) => {
  const routeRecord = normalizeRecord(route);
  const primaryModelId = normalizeBoundedText(routeRecord.primaryModelId, 160);

  return {
    budgetKey: normalizeBoundedText(routeRecord.budgetKey, 120),
    capability: normalizeBoundedText(routeRecord.capability, 80),
    fallbackModelIds: normalizeFallbackModelIds({
      fallbackModelIds: routeRecord.fallbackModelIds,
      primaryModelId,
    }),
    id: normalizeBoundedText(routeRecord.id, 160),
    label: normalizeBoundedText(routeRecord.label, 160),
    maxInputTokens: normalizePositiveInteger(routeRecord.maxInputTokens),
    maxOutputTokens: normalizePositiveInteger(routeRecord.maxOutputTokens),
    primaryModelId,
    workspacePolicyTags: normalizeTextList(routeRecord.workspacePolicyTags, 80),
  };
};

export const normalizeModelProviderSpec = (provider = {}) => {
  const providerRecord = normalizeRecord(provider);
  const normalizedProvider = {
    description: normalizeBoundedText(providerRecord.description, 500),
    id: normalizeBoundedText(providerRecord.id, 120),
    label: normalizeBoundedText(providerRecord.label, 160),
    metadata: cloneJson(providerRecord.metadata),
    transport: normalizeTransport(providerRecord.transport),
    type:
      normalizeBoundedText(providerRecord.type, 80) || MODEL_PROVIDER_TYPE,
    version:
      normalizeBoundedText(providerRecord.version, 40) ||
      MODEL_PROVIDER_SPEC_VERSION,
  };

  return {
    ...normalizedProvider,
    models: toArray(providerRecord.models).map((model) =>
      normalizeModelContract(model, normalizedProvider)
    ),
    routes: toArray(providerRecord.routes).map(normalizeModelRoute),
  };
};

const addDuplicateErrors = ({ errors, ids = [], label }) => {
  const seenIds = new Set();

  for (const id of ids) {
    if (!id) {
      continue;
    }

    if (seenIds.has(id)) {
      errors.push(`${label} id must be unique: ${id}`);
    }

    seenIds.add(id);
  }
};

const validateModelCapabilities = ({ errors, model = {} }) => {
  if (model.capabilities.length === 0) {
    errors.push(`Model ${model.id || "unknown"} requires at least one capability.`);
  }

  for (const capability of model.capabilities) {
    if (!VALID_MODEL_CAPABILITIES.has(capability)) {
      errors.push(
        `Model ${model.id || "unknown"} has unsupported capability: ${capability}`
      );
    }
  }
};

export const validateModelProviderSpec = (provider = {}) => {
  const spec = normalizeModelProviderSpec(provider);
  const errors = [];
  const modelIds = new Set(spec.models.map((model) => model.id));

  if (!spec.id) {
    errors.push("Model provider id is required.");
  }

  if (spec.type !== MODEL_PROVIDER_TYPE) {
    errors.push(`Model provider type must be ${MODEL_PROVIDER_TYPE}.`);
  }

  if (!spec.label) {
    errors.push("Model provider label is required.");
  }

  if (!spec.transport.type) {
    errors.push("Model provider transport.type is required.");
  }

  if (spec.models.length === 0) {
    errors.push("Model provider requires at least one model.");
  }

  addDuplicateErrors({
    errors,
    ids: spec.models.map((model) => model.id),
    label: "Model",
  });
  addDuplicateErrors({
    errors,
    ids: spec.routes.map((route) => route.id),
    label: "Model route",
  });

  for (const model of spec.models) {
    if (!model.id) {
      errors.push("Model id is required.");
    }

    if (!model.modelName) {
      errors.push(`Model ${model.id || "unknown"} modelName is required.`);
    }

    validateModelCapabilities({
      errors,
      model,
    });
  }

  for (const route of spec.routes) {
    if (!route.id) {
      errors.push("Model route id is required.");
    }

    if (!VALID_MODEL_CAPABILITIES.has(route.capability)) {
      errors.push(
        `Model route ${route.id || "unknown"} has unsupported capability.`
      );
    }

    if (!route.primaryModelId) {
      errors.push(
        `Model route ${route.id || "unknown"} primaryModelId is required.`
      );
    }

    if (route.primaryModelId && !modelIds.has(route.primaryModelId)) {
      errors.push(
        `Model route ${route.id || "unknown"} primary model is not registered: ${route.primaryModelId}`
      );
    }

    for (const fallbackModelId of route.fallbackModelIds) {
      if (!modelIds.has(fallbackModelId)) {
        errors.push(
          `Model route ${route.id || "unknown"} fallback model is not registered: ${fallbackModelId}`
        );
      }
    }
  }

  return {
    errors,
    spec,
    valid: errors.length === 0,
  };
};

export const modelSupportsCapability = (model = {}, capability = "") =>
  toArray(model.capabilities).includes(normalizeBoundedText(capability, 80));
