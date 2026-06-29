import { createDefaultModelProviderRegistry } from "./registry.js";
import { MODEL_CAPABILITIES, MODEL_ROUTE_IDS } from "./schema.js";

let configuredModelProviderRegistry = null;

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const cloneJson = (value, fallback = null) =>
  JSON.parse(JSON.stringify(value ?? fallback));

const resolveRegistry = () =>
  configuredModelProviderRegistry ?? createDefaultModelProviderRegistry();

export const configureModelProviderRegistry = (registry) => {
  configuredModelProviderRegistry = registry ?? null;
};

export const resetModelProviderRegistry = () => {
  configureModelProviderRegistry(null);
};

export const getConfiguredModelProviderRegistry = () =>
  configuredModelProviderRegistry;

export const buildPublicModelRoute = (resolvedRoute = {}) => ({
  candidateModelIds: toArray(resolvedRoute.candidateModelIds).map(normalizeText),
  capability: normalizeText(resolvedRoute.capability),
  fallbackModelIds: toArray(resolvedRoute.fallbackModelIds).map(normalizeText),
  modelId: normalizeText(resolvedRoute.selectedModel?.id) || null,
  providerId: normalizeText(resolvedRoute.selectedProvider?.id) || null,
  rejectedModelIds: toArray(resolvedRoute.rejectedModelIds).map(normalizeText),
  routeId: normalizeText(resolvedRoute.route?.id) || null,
  status: normalizeText(resolvedRoute.status) || "unknown",
});

const defaultRouteIdForCapability = (capability = "") => {
  switch (capability) {
    case MODEL_CAPABILITIES.embedding:
      return MODEL_ROUTE_IDS.embeddingDefault;
    case MODEL_CAPABILITIES.executionPlanner:
      return MODEL_ROUTE_IDS.executionPlannerDefault;
    case MODEL_CAPABILITIES.intentPlanner:
      return MODEL_ROUTE_IDS.intentPlannerDefault;
    case MODEL_CAPABILITIES.rerank:
      return MODEL_ROUTE_IDS.rerankCrossEncoderDefault;
    case MODEL_CAPABILITIES.chat:
    default:
      return MODEL_ROUTE_IDS.chatDefault;
  }
};

export const resolveModelRouteForRuntime = ({
  capability = MODEL_CAPABILITIES.chat,
  registry = resolveRegistry(),
  routeId = "",
  workspacePolicy = {},
} = {}) => {
  const normalizedCapability = normalizeText(capability) || MODEL_CAPABILITIES.chat;
  const resolvedRoute = registry.resolveRoute({
    capability: normalizedCapability,
    routeId: normalizeText(routeId) || defaultRouteIdForCapability(normalizedCapability),
    workspacePolicy,
  });
  const modelName = normalizeText(resolvedRoute.selectedModel?.modelName);

  return {
    modelName,
    publicRoute: buildPublicModelRoute(resolvedRoute),
    resolvedRoute: cloneJson(resolvedRoute, {}),
  };
};
