import { createOpenAIModelProviderSpec } from "./built-ins/openai.js";
import {
  modelSupportsCapability,
  normalizeModelProviderSpec,
  validateModelProviderSpec,
} from "./schema.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const cloneJson = (value, fallback = {}) =>
  JSON.parse(JSON.stringify(value ?? fallback));

export const createBuiltInModelProviders = (options = {}) => [
  createOpenAIModelProviderSpec(options.openai),
];

const buildRegistryError = ({ errors = [], provider = {} } = {}) => {
  const error = new Error(
    `Invalid model provider ${provider.id || "unknown"}: ${errors.join(", ")}`
  );

  error.errors = errors;
  return error;
};

const normalizePolicySet = (value) => new Set(toArray(value).map(normalizeText));

const normalizeWorkspacePolicy = (policy = {}) => ({
  allowedModelIds: normalizePolicySet(policy.allowedModelIds),
  allowedProviderIds: normalizePolicySet(policy.allowedProviderIds),
  blockedModelIds: normalizePolicySet(policy.blockedModelIds),
  blockedProviderIds: normalizePolicySet(policy.blockedProviderIds),
  requiredPolicyTags: normalizePolicySet(policy.requiredPolicyTags),
});

const isModelAllowedByWorkspacePolicy = ({ model = {}, policy = {} } = {}) => {
  const normalizedPolicy = normalizeWorkspacePolicy(policy);
  const modelId = normalizeText(model.id);
  const providerId = normalizeText(model.providerId);

  if (normalizedPolicy.blockedModelIds.has(modelId)) {
    return false;
  }

  if (normalizedPolicy.blockedProviderIds.has(providerId)) {
    return false;
  }

  if (
    normalizedPolicy.allowedModelIds.size > 0 &&
    !normalizedPolicy.allowedModelIds.has(modelId)
  ) {
    return false;
  }

  if (
    normalizedPolicy.allowedProviderIds.size > 0 &&
    !normalizedPolicy.allowedProviderIds.has(providerId)
  ) {
    return false;
  }

  if (normalizedPolicy.requiredPolicyTags.size === 0) {
    return true;
  }

  const modelTags = new Set(toArray(model.policy?.workspacePolicyTags));

  return [...normalizedPolicy.requiredPolicyTags].every((tag) =>
    modelTags.has(tag)
  );
};

const compactProvider = (provider = {}) => ({
  id: provider.id,
  label: provider.label,
  transport: cloneJson(provider.transport),
  type: provider.type,
  version: provider.version,
});

const buildResolvedRoute = ({
  candidateModels = [],
  providerMap = new Map(),
  rejectedModelIds = [],
  route = {},
  selectedModel = null,
  status,
} = {}) => ({
  candidateModelIds: candidateModels.map((model) => model.id),
  capability: route.capability,
  fallbackModelIds: toArray(route.fallbackModelIds),
  primaryModelId: route.primaryModelId,
  rejectedModelIds,
  route: cloneJson(route, null),
  selectedModel: selectedModel ? cloneJson(selectedModel) : null,
  selectedProvider: selectedModel
    ? compactProvider(providerMap.get(selectedModel.providerId))
    : null,
  status,
});

export const createModelProviderRegistry = ({
  providers = createBuiltInModelProviders(),
} = {}) => {
  const providerMap = new Map();
  const modelMap = new Map();
  const routeMap = new Map();

  const register = (provider = {}) => {
    const validation = validateModelProviderSpec(provider);

    if (!validation.valid) {
      throw buildRegistryError({
        errors: validation.errors,
        provider: validation.spec,
      });
    }

    if (providerMap.has(validation.spec.id)) {
      throw new Error(`Duplicate model provider id: ${validation.spec.id}`);
    }

    for (const model of validation.spec.models) {
      if (modelMap.has(model.id)) {
        throw new Error(`Duplicate model id: ${model.id}`);
      }
    }

    for (const route of validation.spec.routes) {
      if (routeMap.has(route.id)) {
        throw new Error(`Duplicate model route id: ${route.id}`);
      }

      const candidateModelIds = [
        route.primaryModelId,
        ...route.fallbackModelIds,
      ];

      for (const modelId of candidateModelIds) {
        const model = validation.spec.models.find(
          (candidate) => candidate.id === modelId
        );

        if (!modelSupportsCapability(model, route.capability)) {
          throw new Error(
            `Model route ${route.id} requires ${route.capability}, but ${modelId} does not support it.`
          );
        }
      }
    }

    providerMap.set(validation.spec.id, validation.spec);

    for (const model of validation.spec.models) {
      modelMap.set(model.id, model);
    }

    for (const route of validation.spec.routes) {
      routeMap.set(route.id, route);
    }

    return cloneJson(validation.spec);
  };

  for (const provider of providers) {
    register(provider);
  }

  return {
    getModel(modelId) {
      const model = modelMap.get(normalizeText(modelId));

      return model ? cloneJson(model) : null;
    },

    getProvider(providerId) {
      const provider = providerMap.get(normalizeText(providerId));

      return provider ? cloneJson(provider) : null;
    },

    getRoute(routeId) {
      const route = routeMap.get(normalizeText(routeId));

      return route ? cloneJson(route) : null;
    },

    listModels({ capability = "", providerId = "" } = {}) {
      const normalizedCapability = normalizeText(capability);
      const normalizedProviderId = normalizeText(providerId);

      return [...modelMap.values()]
        .filter(
          (model) =>
            (!normalizedCapability ||
              modelSupportsCapability(model, normalizedCapability)) &&
            (!normalizedProviderId || model.providerId === normalizedProviderId)
        )
        .map((model) => cloneJson(model));
    },

    listProviders() {
      return [...providerMap.values()].map((provider) => cloneJson(provider));
    },

    listRoutes({ capability = "" } = {}) {
      const normalizedCapability = normalizeText(capability);

      return [...routeMap.values()]
        .filter(
          (route) => !normalizedCapability || route.capability === normalizedCapability
        )
        .map((route) => cloneJson(route));
    },

    register,

    resolveRoute({ capability = "", routeId = "", workspacePolicy = {} } = {}) {
      const normalizedRouteId = normalizeText(routeId);
      const normalizedCapability = normalizeText(capability);
      const route = normalizedRouteId
        ? routeMap.get(normalizedRouteId)
        : [...routeMap.values()].find(
            (candidate) => candidate.capability === normalizedCapability
          );

      if (!route) {
        return buildResolvedRoute({
          route: {
            capability: normalizedCapability,
            id: normalizedRouteId,
          },
          status: "route_not_found",
        });
      }

      const candidateModels = [
        route.primaryModelId,
        ...route.fallbackModelIds,
      ]
        .map((modelId) => modelMap.get(modelId))
        .filter(Boolean);
      const rejectedModelIds = [];
      const selectedModel =
        candidateModels.find((model) => {
          const allowed = isModelAllowedByWorkspacePolicy({
            model,
            policy: workspacePolicy,
          });

          if (!allowed) {
            rejectedModelIds.push(model.id);
          }

          return allowed;
        }) ?? null;

      return buildResolvedRoute({
        candidateModels,
        providerMap,
        rejectedModelIds,
        route,
        selectedModel,
        status: selectedModel ? "selected" : "blocked_by_workspace_policy",
      });
    },
  };
};

export const createDefaultModelProviderRegistry = () =>
  createModelProviderRegistry();

export {
  normalizeModelProviderSpec,
  validateModelProviderSpec,
} from "./schema.js";
