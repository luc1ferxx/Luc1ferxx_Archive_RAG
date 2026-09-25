import { createChatClient, createEmbeddingsClient } from "./openai-client.js";
import { CIRCUIT_OPEN_CODE, resetModelCallGuards } from "./model-call-guard.js";
import { normalizeText } from "../lib/normalize-text.js";
import { getLlmOpsPolicy, isStructuredOutputEnabled } from "./config.js";
import {
  MODEL_CAPABILITIES,
  MODEL_ROUTE_IDS,
  resolveModelRouteForRuntime,
} from "./model-providers/index.js";
import {
  LLMOPS_OPERATIONS,
  runWithLlmOpsMetric,
} from "./llmops-metrics.js";
import {
  buildLlmOpsRouteContext,
  buildLlmOpsUsageMetric,
} from "./llmops-usage.js";

let embeddingsInstances = new Map();
let chatModelInstances = new Map();
let customProvider = null;

const MAX_RETRIES = 3;
// Windows of 500, 1000, 2000 ms: three retries wait 2.6 s on average, the same
// span as the fixed 250/750/1500 ms schedule this replaced, now jittered.
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 4000;
// A server that asks for a longer pause is not coming back in time for an
// interactive request; stop and let failover or the caller decide.
const MAX_RETRY_AFTER_MS = 10000;
// One retry for an empty completion: the next sample usually has content, and a
// second empty one is more likely a real limit than noise.
const MAX_EMPTY_COMPLETION_RETRIES = 1;
const EMPTY_COMPLETION_CODE = "EMPTY_COMPLETION";

const getRuntimeLlmOpsPolicy = () => getLlmOpsPolicy();

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

// An open circuit is not retried on the same model -- that is the point of it --
// but it is exactly the case failover exists for.
const isFailoverEligible = (error) =>
  isRetriableError(error) || error?.code === CIRCUIT_OPEN_CODE;

const isRetriableError = (error) => {
  // Carries a 503 so callers see an unavailable model, but retrying it on the
  // same model would only wait out a backoff to be rejected again.
  if (error?.code === CIRCUIT_OPEN_CODE) {
    return false;
  }

  const status = Number(error?.status);
  const code = String(error?.code ?? error?.cause?.code ?? "").toUpperCase();

  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    EMPTY_COMPLETION_CODE,
  ].includes(code);
};

// Exponential backoff with equal jitter: half of each window is a guaranteed
// wait, half is random, so callers that failed together do not retry together.
// A server-supplied Retry-After is a floor, never shortened by the jitter, and is
// itself spread over half its length again: every client rate-limited in the
// same second gets the same Retry-After, and retrying on it exactly would bring
// them back together into the same limit.
export const computeRetryDelayMs = ({
  attempt,
  random = Math.random,
  retryAfterMs = null,
} = {}) => {
  const window = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jittered = window / 2 + random() * (window / 2);

  return Number.isFinite(retryAfterMs)
    ? Math.max(jittered, retryAfterMs * (1 + random() / 2))
    : jittered;
};

const withRetry = async (operation, failureMessage) => {
  let lastError = null;
  let emptyCompletionRetries = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryAfterMs = Number.isFinite(error?.retryAfterMs)
        ? error.retryAfterMs
        : null;
      const emptyCompletion = error?.code === EMPTY_COMPLETION_CODE;

      if (
        !isRetriableError(error) ||
        attempt === MAX_RETRIES ||
        (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) ||
        (emptyCompletion && emptyCompletionRetries >= MAX_EMPTY_COMPLETION_RETRIES)
      ) {
        break;
      }

      if (emptyCompletion) {
        emptyCompletionRetries += 1;
      }

      await sleep(computeRetryDelayMs({ attempt, retryAfterMs }));
    }
  }

  if (lastError instanceof Error && failureMessage) {
    lastError.message = `${failureMessage} ${lastError.message}`.trim();
  }

  throw lastError;
};

export const getOpenAIApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not configured.");
    error.status = 500;
    throw error;
  }

  return apiKey;
};

const buildCustomProviderRoute = (capability) => ({
  candidateModelIds: [],
  capability,
  fallbackModelIds: [],
  modelId: null,
  providerId: "custom_provider",
  rejectedModelIds: [],
  routeId: null,
  status: "custom_provider",
});

const assertSelectedModelRoute = ({ modelName, publicRoute }) => {
  if (modelName) {
    return;
  }

  const error = new Error(
    `Model route did not select a model: ${publicRoute?.routeId || publicRoute?.capability || "unknown"}.`
  );
  error.status = 500;
  throw error;
};

const getRouteCacheKey = ({ modelName, publicRoute }) =>
  [publicRoute?.providerId, publicRoute?.modelId, modelName]
    .filter(Boolean)
    .join(":");

const getTextCharacters = (value) => String(value ?? "").length;

const getTextListCharacters = (texts = []) =>
  (Array.isArray(texts) ? texts : []).reduce(
    (sum, text) => sum + getTextCharacters(text),
    0
  );

const getEmbeddingMetricBase = ({ stage, modelRoute, inputCharacters, itemCount }) => ({
  inputCharacters,
  itemCount,
  modelRoute,
  operation: LLMOPS_OPERATIONS.embedding,
  stage,
});

const buildRouteMetricContext = (route = {}) => {
  const routeContext = buildLlmOpsRouteContext(route.resolvedRoute);

  return {
    latencySloMs: routeContext.latencySloMs,
    pricing: routeContext.pricing,
  };
};

const buildCustomRouteMetricContext = () => ({
  latencySloMs: null,
  pricing: null,
});

const buildUsageMetricFields = ({
  inputCharacters,
  metricContext = {},
  outputCharacters = 0,
  response = null,
} = {}) => ({
  latencySloMs: metricContext.latencySloMs,
  ...buildLlmOpsUsageMetric({
    inputCharacters,
    outputCharacters,
    pricing: metricContext.pricing,
    response,
  }),
});

const getEmbeddingsInstance = (options = {}) => {
  if (customProvider?.getEmbeddings) {
    return {
      instance: customProvider.getEmbeddings(),
      metricContext: buildCustomRouteMetricContext(),
      modelRoute: buildCustomProviderRoute(MODEL_CAPABILITIES.embedding),
    };
  }

  const route = resolveModelRouteForRuntime({
    capability: MODEL_CAPABILITIES.embedding,
    routeId: MODEL_ROUTE_IDS.embeddingDefault,
    workspacePolicy: options.workspacePolicy,
  });

  assertSelectedModelRoute(route);

  const cacheKey = getRouteCacheKey(route);
  const cachedInstance = embeddingsInstances.get(cacheKey);

  if (cachedInstance) {
    return {
      instance: cachedInstance,
      metricContext: buildRouteMetricContext(route),
      modelRoute: route.publicRoute,
    };
  }

  const embeddingsInstance = createEmbeddingsClient({
    apiKey: getOpenAIApiKey(),
    model: route.modelName,
  });

  embeddingsInstances.set(cacheKey, embeddingsInstance);
  return {
    instance: embeddingsInstance,
    metricContext: buildRouteMetricContext(route),
    modelRoute: route.publicRoute,
  };
};

export const getEmbeddings = (options = {}) => {
  const { instance } = getEmbeddingsInstance(options);

  return instance;
};

const getChatModelInstance = (options = {}) => {
  if (customProvider?.getChatModel) {
    return {
      failovers: [],
      instance: customProvider.getChatModel(),
      metricContext: buildCustomRouteMetricContext(),
      modelRoute: buildCustomProviderRoute(
        options.capability ?? MODEL_CAPABILITIES.chat
      ),
    };
  }

  const route = resolveModelRouteForRuntime({
    capability: options.capability ?? MODEL_CAPABILITIES.chat,
    routeId: options.routeId ?? MODEL_ROUTE_IDS.chatDefault,
    workspacePolicy: options.workspacePolicy,
  });

  assertSelectedModelRoute(route);

  const getChatClient = (cacheKey, modelName) => {
    if (!chatModelInstances.has(cacheKey)) {
      chatModelInstances.set(
        cacheKey,
        createChatClient({ model: modelName, apiKey: getOpenAIApiKey() })
      );
    }

    return chatModelInstances.get(cacheKey);
  };

  // Each failover target is served and metered as its own model: the route it
  // reports names the model that actually answered.
  const failovers = (route.resolvedRoute.failoverModels ?? [])
    .filter((model) => normalizeText(model?.modelName))
    .map((model) => {
      const failoverRoute = {
        ...route,
        modelName: model.modelName,
        publicRoute: { ...route.publicRoute, modelId: model.id, status: "failover" },
        resolvedRoute: { ...route.resolvedRoute, selectedModel: model },
      };

      return {
        instance: getChatClient(getRouteCacheKey(failoverRoute), model.modelName),
        metricContext: buildRouteMetricContext(failoverRoute),
        modelRoute: failoverRoute.publicRoute,
      };
    });

  return {
    failovers,
    instance: getChatClient(getRouteCacheKey(route), route.modelName),
    metricContext: buildRouteMetricContext(route),
    modelRoute: route.publicRoute,
  };
};

const normalizeContent = (content) => {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (typeof part?.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
};

const getPromptMessageType = (message) => {
  if (typeof message?.getType === "function") {
    return message.getType();
  }

  if (typeof message?._getType === "function") {
    return message._getType();
  }

  if (typeof message?.type === "string") {
    return message.type;
  }

  if (typeof message?.role === "string") {
    return message.role;
  }

  return "message";
};

const renderPromptMessages = (messages) =>
  messages
    .map((message) => {
      const role = getPromptMessageType(message).toUpperCase();
      const content = normalizeContent(message?.content);

      return content ? `${role}:\n${content}` : role;
    })
    .join("\n\n");

const renderPromptInput = (prompt) => {
  if (typeof prompt === "string") {
    return prompt;
  }

  if (Array.isArray(prompt)) {
    return renderPromptMessages(prompt);
  }

  if (typeof prompt?.toChatMessages === "function") {
    return renderPromptMessages(prompt.toChatMessages());
  }

  if (Array.isArray(prompt?.messages)) {
    return renderPromptMessages(prompt.messages);
  }

  return normalizeContent(prompt?.content ?? prompt);
};

export const configureOpenAIProvider = (provider) => {
  customProvider = provider ?? null;
  embeddingsInstances = new Map();
  chatModelInstances = new Map();
  resetModelCallGuards();
};

export const resetOpenAIProvider = () => {
  configureOpenAIProvider(null);
};

export const embedTexts = async (texts) => {
  const safeTexts = Array.isArray(texts) ? texts : [];

  if (customProvider?.embedTexts) {
    const modelRoute = buildCustomProviderRoute(MODEL_CAPABILITIES.embedding);
    const metricContext = buildCustomRouteMetricContext();
    const inputCharacters = getTextListCharacters(safeTexts);

    return runWithLlmOpsMetric({
      action: () => customProvider.embedTexts(texts),
      metric: getEmbeddingMetricBase({
        ...buildUsageMetricFields({
          inputCharacters,
          metricContext,
        }),
        inputCharacters,
        itemCount: safeTexts.length,
        modelRoute,
        stage: "embed_documents",
      }),
      policy: getRuntimeLlmOpsPolicy(),
    });
  }

  const { instance, metricContext, modelRoute } = getEmbeddingsInstance();
  const inputCharacters = getTextListCharacters(safeTexts);

  return runWithLlmOpsMetric({
    action: () =>
      withRetry(
        async () => instance.embedDocuments(texts),
        "Embedding request failed."
      ),
    metric: getEmbeddingMetricBase({
      ...buildUsageMetricFields({
        inputCharacters,
        metricContext,
      }),
      inputCharacters,
      itemCount: safeTexts.length,
      modelRoute,
      stage: "embed_documents",
    }),
    policy: getRuntimeLlmOpsPolicy(),
  });
};

export const embedQuery = async (query) => {
  if (customProvider?.embedQuery) {
    const modelRoute = buildCustomProviderRoute(MODEL_CAPABILITIES.embedding);
    const metricContext = buildCustomRouteMetricContext();
    const inputCharacters = getTextCharacters(query);

    return runWithLlmOpsMetric({
      action: () => customProvider.embedQuery(query),
      metric: getEmbeddingMetricBase({
        ...buildUsageMetricFields({
          inputCharacters,
          metricContext,
        }),
        inputCharacters,
        itemCount: 1,
        modelRoute,
        stage: "embed_query",
      }),
      policy: getRuntimeLlmOpsPolicy(),
    });
  }

  const { instance, metricContext, modelRoute } = getEmbeddingsInstance();
  const inputCharacters = getTextCharacters(query);

  return runWithLlmOpsMetric({
    action: () =>
      withRetry(
        async () => instance.embedQuery(query),
        "Query embedding request failed."
      ),
    metric: getEmbeddingMetricBase({
      ...buildUsageMetricFields({
        inputCharacters,
        metricContext,
      }),
      inputCharacters,
      itemCount: 1,
      modelRoute,
      stage: "embed_query",
    }),
    policy: getRuntimeLlmOpsPolicy(),
  });
};

export const completeText = async (prompt) => {
  const completion = await completeTextWithMetadata(prompt);

  return completion.text;
};

export const completeTextWithMetadata = async (prompt, options = {}) => {
  const inputText = renderPromptInput(prompt);
  const capability = options.capability ?? MODEL_CAPABILITIES.chat;
  const responseFormat = isStructuredOutputEnabled()
    ? options.responseFormat ?? null
    : null;

  if (customProvider?.completeText) {
    const modelRoute = buildCustomProviderRoute(capability);
    const metricContext = buildCustomRouteMetricContext();
    const text = await runWithLlmOpsMetric({
      action: () => customProvider.completeText(inputText, { responseFormat }),
      metric: {
        ...buildUsageMetricFields({
          inputCharacters: inputText.length,
          metricContext,
        }),
        inputCharacters: inputText.length,
        itemCount: 1,
        modelRoute,
        operation: LLMOPS_OPERATIONS.completion,
        stage: "complete_text",
      },
      successMetric: (result) => ({
        ...buildUsageMetricFields({
          inputCharacters: inputText.length,
          outputCharacters: getTextCharacters(result),
          metricContext,
          response: result,
        }),
        outputCharacters: getTextCharacters(result),
      }),
      policy: getRuntimeLlmOpsPolicy(),
    });

    return {
      modelRoute,
      text,
    };
  }

  const primary = getChatModelInstance(options);
  // An empty completion is retried once, then returned as it always was: callers
  // already treat empty text as "no answer". A length-truncated one is not
  // retried, because the same budget would truncate it again.
  const invokeOnce = async (instance) => {
    const result = await instance.invoke(prompt, { responseFormat });

    if (!normalizeContent(result?.content) && result?.finishReason !== "length") {
      const error = new Error("Chat completion returned empty content.");
      error.code = EMPTY_COMPLETION_CODE;
      error.response = result;
      throw error;
    }

    return result;
  };
  const completeOn = ({ instance, metricContext, modelRoute }) =>
    runWithLlmOpsMetric({
      action: () =>
        withRetry(() => invokeOnce(instance), "Chat completion failed.").catch(
          (error) => {
            if (error?.code === EMPTY_COMPLETION_CODE) {
              return error.response;
            }

            throw error;
          }
        ),
      metric: {
        ...buildUsageMetricFields({
          inputCharacters: inputText.length,
          metricContext,
        }),
        inputCharacters: inputText.length,
        itemCount: 1,
        modelRoute,
        operation: LLMOPS_OPERATIONS.completion,
        stage: "complete_text",
      },
      successMetric: (result) => ({
        ...buildUsageMetricFields({
          inputCharacters: inputText.length,
          outputCharacters: getTextCharacters(normalizeContent(result?.content)),
          metricContext,
          response: result,
        }),
        outputCharacters: getTextCharacters(normalizeContent(result?.content)),
      }),
      policy: getRuntimeLlmOpsPolicy(),
    }).then((response) => ({
      modelRoute,
      text: normalizeContent(response.content),
    }));

  try {
    return await completeOn(primary);
  } catch (primaryError) {
    // Only a transient failure or an open circuit fails over. A 400/401, a
    // policy block, or a budget block would fail the same way on any model.
    if (!isFailoverEligible(primaryError) || primary.failovers.length === 0) {
      throw primaryError;
    }

    let lastError = primaryError;

    for (const failover of primary.failovers) {
      try {
        return await completeOn(failover);
      } catch (failoverError) {
        lastError = failoverError;

        if (!isFailoverEligible(failoverError)) {
          break;
        }
      }
    }

    throw lastError;
  }
};
