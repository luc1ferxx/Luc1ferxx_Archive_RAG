import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import {
  MODEL_CAPABILITIES,
  MODEL_ROUTE_IDS,
  resolveModelRouteForRuntime,
} from "./model-providers/index.js";
import {
  LLMOPS_OPERATIONS,
  runWithLlmOpsMetric,
} from "./llmops-metrics.js";

let embeddingsInstances = new Map();
let chatModelInstances = new Map();
let customProvider = null;

const RETRY_DELAYS_MS = [250, 750, 1500];

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const isRetriableError = (error) => {
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
  ].includes(code);
};

const withRetry = async (operation, failureMessage) => {
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetriableError(error) || attempt === RETRY_DELAYS_MS.length) {
        break;
      }

      await sleep(RETRY_DELAYS_MS[attempt]);
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

const getEmbeddingsInstance = (options = {}) => {
  if (customProvider?.getEmbeddings) {
    return {
      instance: customProvider.getEmbeddings(),
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
      modelRoute: route.publicRoute,
    };
  }

  const embeddingsInstance = new OpenAIEmbeddings({
    apiKey: getOpenAIApiKey(),
    model: route.modelName,
  });

  embeddingsInstances.set(cacheKey, embeddingsInstance);
  return {
    instance: embeddingsInstance,
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
      instance: customProvider.getChatModel(),
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

  const cacheKey = getRouteCacheKey(route);
  const cachedInstance = chatModelInstances.get(cacheKey);

  if (cachedInstance) {
    return {
      instance: cachedInstance,
      modelRoute: route.publicRoute,
    };
  }

  const chatModelInstance = new ChatOpenAI({
    model: route.modelName,
    apiKey: getOpenAIApiKey(),
  });

  chatModelInstances.set(cacheKey, chatModelInstance);

  return {
    instance: chatModelInstance,
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
};

export const resetOpenAIProvider = () => {
  configureOpenAIProvider(null);
};

export const embedTexts = async (texts) => {
  const safeTexts = Array.isArray(texts) ? texts : [];

  if (customProvider?.embedTexts) {
    const modelRoute = buildCustomProviderRoute(MODEL_CAPABILITIES.embedding);

    return runWithLlmOpsMetric({
      action: () => customProvider.embedTexts(texts),
      metric: getEmbeddingMetricBase({
        inputCharacters: getTextListCharacters(safeTexts),
        itemCount: safeTexts.length,
        modelRoute,
        stage: "embed_documents",
      }),
    });
  }

  const { instance, modelRoute } = getEmbeddingsInstance();

  return runWithLlmOpsMetric({
    action: () =>
      withRetry(
        async () => instance.embedDocuments(texts),
        "Embedding request failed."
      ),
    metric: getEmbeddingMetricBase({
      inputCharacters: getTextListCharacters(safeTexts),
      itemCount: safeTexts.length,
      modelRoute,
      stage: "embed_documents",
    }),
  });
};

export const embedQuery = async (query) => {
  if (customProvider?.embedQuery) {
    const modelRoute = buildCustomProviderRoute(MODEL_CAPABILITIES.embedding);

    return runWithLlmOpsMetric({
      action: () => customProvider.embedQuery(query),
      metric: getEmbeddingMetricBase({
        inputCharacters: getTextCharacters(query),
        itemCount: 1,
        modelRoute,
        stage: "embed_query",
      }),
    });
  }

  const { instance, modelRoute } = getEmbeddingsInstance();

  return runWithLlmOpsMetric({
    action: () =>
      withRetry(
        async () => instance.embedQuery(query),
        "Query embedding request failed."
      ),
    metric: getEmbeddingMetricBase({
      inputCharacters: getTextCharacters(query),
      itemCount: 1,
      modelRoute,
      stage: "embed_query",
    }),
  });
};

export const completeText = async (prompt) => {
  const completion = await completeTextWithMetadata(prompt);

  return completion.text;
};

export const completeTextWithMetadata = async (prompt, options = {}) => {
  const inputText = renderPromptInput(prompt);
  const capability = options.capability ?? MODEL_CAPABILITIES.chat;

  if (customProvider?.completeText) {
    const modelRoute = buildCustomProviderRoute(capability);
    const text = await runWithLlmOpsMetric({
      action: () => customProvider.completeText(inputText),
      metric: {
        inputCharacters: inputText.length,
        itemCount: 1,
        modelRoute,
        operation: LLMOPS_OPERATIONS.completion,
        stage: "complete_text",
      },
      successMetric: (result) => ({
        outputCharacters: getTextCharacters(result),
      }),
    });

    return {
      modelRoute,
      text,
    };
  }

  const { instance, modelRoute } = getChatModelInstance(options);
  const response = await runWithLlmOpsMetric({
    action: () =>
      withRetry(
        async () => instance.invoke(prompt),
        "Chat completion failed."
      ),
    metric: {
      inputCharacters: inputText.length,
      itemCount: 1,
      modelRoute,
      operation: LLMOPS_OPERATIONS.completion,
      stage: "complete_text",
    },
    successMetric: (result) => ({
      outputCharacters: getTextCharacters(normalizeContent(result?.content)),
    }),
  });

  return {
    modelRoute,
    text: normalizeContent(response.content),
  };
};
