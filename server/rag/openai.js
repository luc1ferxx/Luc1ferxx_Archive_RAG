import { createChatClient, createEmbeddingsClient, toChatMessages } from "./openai-client.js";
import { CIRCUIT_OPEN_CODE, resetModelCallGuards } from "./model-call-guard.js";
import { getModelGatewayCall, recordModelMetricEvent } from "./model-gateway/call-context.js";
import {
  requestModelGatewayCompletion,
  requestModelGatewayEmbeddings,
} from "./model-gateway/client.js";
import { MODEL_GATEWAY_MIRROR_ANNOTATION } from "./model-gateway/protocol.js";
import { isModelGatewayEnabled } from "./service-topology.js";
import { addActiveSpanEvent } from "./tracing.js";
import { normalizePromptDescriptor } from "./prompt-registry.js";
import { withRequestSignal } from "./request-deadline.js";
import { markModelQueryVector } from "./query-adapter.js";
import { normalizeText } from "../lib/normalize-text.js";
import {
  getEmbeddingDocumentPrefix,
  getEmbeddingModel,
  getEmbeddingQueryPrefix,
  getLlmOpsPolicy,
  isStructuredOutputEnabled,
} from "./config.js";
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

// A backoff ends early when `signal` aborts: a cancelled request does not wait
// out a retry it will never send (withRetry checks the signal next).
const sleep = (durationMs, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    };
    const timer = setTimeout(done, durationMs);

    signal?.addEventListener?.("abort", done, { once: true });
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

// A caller that has gone away (the model gateway's signal) stops the retries:
// nobody is waiting for the answer.
const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    throw signal.reason;
  }
};

const withRetry = async (operation, failureMessage, { signal } = {}) => {
  let lastError = null;
  let emptyCompletionRetries = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      throwIfAborted(signal);
      return await operation();
    } catch (error) {
      lastError = error;
      const retryAfterMs = Number.isFinite(error?.retryAfterMs)
        ? error.retryAfterMs
        : null;
      const emptyCompletion = error?.code === EMPTY_COMPLETION_CODE;

      if (
        signal?.aborted ||
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

      const delayMs = computeRetryDelayMs({ attempt, retryAfterMs });
      // Lands on the model call's span, so a slow call shows why it was slow.
      addActiveSpanEvent("model.retry", {
        "error.type": String(error?.status ?? error?.code ?? "error"),
        "retry.attempt": attempt + 1,
        "retry.delay_ms": Math.round(delayMs),
      });
      await sleep(delayMs, signal);
    }
  }

  if (lastError instanceof Error && failureMessage && lastError !== signal?.reason) {
    lastError.message = `${failureMessage} ${lastError.message}`.trim();
  }

  throw lastError;
};

// With MODEL_GATEWAY_URL set (and this process not the gateway itself), every
// chat, embedding and rerank call goes to the model gateway, which runs the
// retry, failover and guard below. A configured stand-in provider stays in
// process, and so does a call the gateway is serving.
const routesThroughModelGateway = () =>
  !customProvider && !getModelGatewayCall() && isModelGatewayEnabled();

// The route a gateway call reports before the gateway has said which model
// answered; the event's route is replaced by the gateway's on success.
const buildModelGatewayPendingRoute = (capability, routeId = null) => ({
  candidateModelIds: [],
  capability,
  fallbackModelIds: [],
  modelId: null,
  providerId: "model_gateway",
  rejectedModelIds: [],
  routeId: routeId || null,
  status: "model_gateway",
});

// The usage the gateway metered for the call, in place of this process's
// estimate, so run-level ceilings charge what the gateway billed.
const buildModelGatewayUsageMetric = (result, estimate) => {
  const usage = result?.meteredUsage;

  return usage && Number.isFinite(usage.totalTokens)
    ? {
        costCurrency: usage.costCurrency ?? null,
        estimatedCostUsd: usage.estimatedCostUsd ?? null,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        pricingSource: usage.pricingSource ?? "unavailable",
        tokenSource: usage.tokenSource ?? "unavailable",
        totalTokens: usage.totalTokens,
        ...(Number.isFinite(result?.latencySloMs) ? { latencySloMs: result.latencySloMs } : {}),
      }
    : buildUsageMetricFields(estimate);
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

// Keeps the usage estimate the callers spread in: destructuring only the named
// fields used to drop it, so embedding calls reported no tokens or cost.
const getEmbeddingMetricBase = ({ stage, modelRoute, inputCharacters, itemCount, ...usage }) => ({
  ...usage,
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

  // An index version may pin another embedding model than the configured one
  // (rag/vector-store-pgvector-versions.js). It goes through the same route --
  // provider, endpoint, workspace policy -- with only the model name replaced.
  const modelName = String(options.modelName ?? "").trim() || route.modelName;
  const cacheKey = getRouteCacheKey({ ...route, modelName });
  const cachedInstance = embeddingsInstances.get(cacheKey);

  if (cachedInstance) {
    return {
      instance: cachedInstance,
      metricContext: buildRouteMetricContext(route),
      modelName,
      modelRoute: route.publicRoute,
    };
  }

  const embeddingsInstance = createEmbeddingsClient({
    apiKey: getOpenAIApiKey(),
    model: modelName,
  });

  embeddingsInstances.set(cacheKey, embeddingsInstance);
  return {
    instance: embeddingsInstance,
    metricContext: buildRouteMetricContext(route),
    modelName,
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
        modelName: model.modelName,
        modelRoute: failoverRoute.publicRoute,
      };
    });

  return {
    failovers,
    instance: getChatClient(getRouteCacheKey(route), route.modelName),
    metricContext: buildRouteMetricContext(route),
    modelName: route.modelName,
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

const withEmbeddingPrefix = (texts, prefix) =>
  prefix ? texts.map((text) => `${prefix}${text}`) : texts;

// `embeddingSpace` ({ model, documentPrefix, queryPrefix, dimensions }) is set
// only by the pgvector index-version code, for a version pinned to another
// model or task prefix than the configured one. Without it both functions
// behave exactly as before. A configured stand-in provider receives the space
// as a second argument and never gets a prefix, like the configured path.
const normalizeEmbeddingSpace = (embeddingSpace) =>
  embeddingSpace && typeof embeddingSpace === "object" ? embeddingSpace : null;

const callCustomEmbedding = (method, input, embeddingSpace) =>
  embeddingSpace
    ? customProvider[method](input, { embeddingSpace })
    : customProvider[method](input);

export const embedTexts = async (texts, options = {}) => {
  const safeTexts = Array.isArray(texts) ? texts : [];
  const embeddingSpace = normalizeEmbeddingSpace(options?.embeddingSpace);
  // The caller's signal plus the bound request's (request-deadline.js), so a
  // cancelled agent request aborts its in-flight embedding call.
  const signal = withRequestSignal(options?.signal);

  if (customProvider?.embedTexts) {
    const modelRoute = buildCustomProviderRoute(MODEL_CAPABILITIES.embedding);
    const metricContext = buildCustomRouteMetricContext();
    const inputCharacters = getTextListCharacters(safeTexts);

    return runWithLlmOpsMetric({
      action: () => callCustomEmbedding("embedTexts", texts, embeddingSpace),
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
      recorder: recordModelMetricEvent,
    });
  }

  const documentPrefix = embeddingSpace
    ? String(embeddingSpace.documentPrefix ?? "")
    : getEmbeddingDocumentPrefix();

  if (routesThroughModelGateway()) {
    return embedThroughModelGateway({
      input: withEmbeddingPrefix(safeTexts, documentPrefix),
      inputCharacters: getTextListCharacters(safeTexts),
      itemCount: safeTexts.length,
      modelName: resolveEmbeddingModelName(embeddingSpace),
      signal,
      stage: "embed_documents",
    }).then(({ vectors }) => vectors);
  }

  const { instance, metricContext, modelName, modelRoute } = getEmbeddingsInstance({
    modelName: embeddingSpace?.model,
  });
  const inputCharacters = getTextListCharacters(safeTexts);

  return runWithLlmOpsMetric({
    action: () =>
      withRetry(
        async () =>
          instance.embedDocuments(withEmbeddingPrefix(texts, documentPrefix), {
            signal,
          }),
        "Embedding request failed.",
        { signal }
      ),
    metric: getEmbeddingMetricBase({
      ...buildUsageMetricFields({
        inputCharacters,
        metricContext,
      }),
      inputCharacters,
      itemCount: safeTexts.length,
      modelName,
      modelRoute,
      stage: "embed_documents",
    }),
    policy: getRuntimeLlmOpsPolicy(),
    recorder: recordModelMetricEvent,
  });
};

// The model the configured path would embed with: the space's pinned model, or
// the embedding route's. Sent to the gateway explicitly, because the vectors
// must be in this process's embedding space, not whatever the gateway has
// configured.
const resolveEmbeddingModelName = (embeddingSpace) =>
  String(embeddingSpace?.model ?? "").trim() ||
  resolveModelRouteForRuntime({
    capability: MODEL_CAPABILITIES.embedding,
    routeId: MODEL_ROUTE_IDS.embeddingDefault,
  }).modelName;

// Texts arrive with this process's task prefixes already applied; the gateway
// embeds them as given. One mirror LLMOps event per call carries the usage the
// gateway metered (protocol.js explains which side is authoritative).
const embedThroughModelGateway = ({ input, inputCharacters, itemCount, modelName, signal, stage }) => {
  const modelRoute = buildModelGatewayPendingRoute(MODEL_CAPABILITIES.embedding);
  const estimate = { inputCharacters, metricContext: buildCustomRouteMetricContext() };

  return runWithLlmOpsMetric({
    action: () => requestModelGatewayEmbeddings({ input, model: modelName, signal }),
    metric: getEmbeddingMetricBase({
      ...buildUsageMetricFields(estimate),
      annotations: [MODEL_GATEWAY_MIRROR_ANNOTATION],
      inputCharacters,
      itemCount,
      modelName,
      modelRoute,
      stage,
    }),
    policy: getRuntimeLlmOpsPolicy(),
    recorder: recordModelMetricEvent,
    successMetric: (result) => ({
      ...buildModelGatewayUsageMetric(result, estimate),
      modelRoute: result.modelRoute ?? modelRoute,
    }),
  });
};

// The query-side adapter (rag/query-adapter.js) never changes what this
// returns. It adapts a query vector at the retrieval seam, and only a vector
// marked here as the embedding model's own, in the space it was embedded in.
// A configured stand-in provider's vectors (embedQuery or getEmbeddings) are
// not the model's, so they are never marked unless the provider opts in with
// `allowQueryAdapter: true` (unit tests do).
const servesQueryEmbeddingsFromStandIn = () =>
  Boolean(customProvider?.embedQuery || customProvider?.getEmbeddings) && customProvider?.allowQueryAdapter !== true;

const describeQuerySpace = (embeddingSpace, modelName, vector) => ({
  dimensions: Array.isArray(vector) || ArrayBuffer.isView(vector) ? vector.length : 0,
  documentPrefix: embeddingSpace ? String(embeddingSpace.documentPrefix ?? "") : getEmbeddingDocumentPrefix(),
  model: String(embeddingSpace?.model ?? modelName ?? getEmbeddingModel()),
  queryPrefix: embeddingSpace ? String(embeddingSpace.queryPrefix ?? "") : getEmbeddingQueryPrefix(),
});

export const embedQuery = async (query, options = {}) => {
  const embeddingSpace = normalizeEmbeddingSpace(options?.embeddingSpace);
  const { modelName, vector } = await embedQueryWithModel(
    query,
    embeddingSpace,
    withRequestSignal(options?.signal)
  );

  return servesQueryEmbeddingsFromStandIn()
    ? vector
    : markModelQueryVector(vector, describeQuerySpace(embeddingSpace, modelName, vector));
};

const embedQueryWithModel = async (query, embeddingSpace, signal) => {
  if (customProvider?.embedQuery) {
    const modelRoute = buildCustomProviderRoute(MODEL_CAPABILITIES.embedding);
    const metricContext = buildCustomRouteMetricContext();
    const inputCharacters = getTextCharacters(query);
    const vector = await runWithLlmOpsMetric({
      action: () => callCustomEmbedding("embedQuery", query, embeddingSpace),
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
      recorder: recordModelMetricEvent,
    });

    return { modelName: null, vector };
  }

  const queryPrefix = embeddingSpace
    ? String(embeddingSpace.queryPrefix ?? "")
    : getEmbeddingQueryPrefix();

  if (routesThroughModelGateway()) {
    const gatewayModelName = resolveEmbeddingModelName(embeddingSpace);
    const { vectors } = await embedThroughModelGateway({
      input: `${queryPrefix}${query}`,
      inputCharacters: getTextCharacters(query),
      itemCount: 1,
      modelName: gatewayModelName,
      signal,
      stage: "embed_query",
    });

    return { modelName: gatewayModelName, vector: vectors[0] };
  }

  const { instance, metricContext, modelName, modelRoute } = getEmbeddingsInstance({
    modelName: embeddingSpace?.model,
  });
  const inputCharacters = getTextCharacters(query);
  const vector = await runWithLlmOpsMetric({
    action: () =>
      withRetry(
        async () => instance.embedQuery(`${queryPrefix}${query}`, { signal }),
        "Query embedding request failed.",
        { signal }
      ),
    metric: getEmbeddingMetricBase({
      ...buildUsageMetricFields({
        inputCharacters,
        metricContext,
      }),
      inputCharacters,
      itemCount: 1,
      modelName,
      modelRoute,
      stage: "embed_query",
    }),
    policy: getRuntimeLlmOpsPolicy(),
    recorder: recordModelMetricEvent,
  });

  return { modelName, vector };
};

export const completeText = async (prompt, options = {}) => {
  const completion = await completeTextWithMetadata(prompt, options);

  return completion.text;
};

export const completeTextWithMetadata = async (prompt, options = {}) => {
  const inputText = renderPromptInput(prompt);
  const capability = options.capability ?? MODEL_CAPABILITIES.chat;
  // Which template produced this call (rag/prompt-registry.js). It is metadata
  // only: it goes on the metric and the span, never into the request.
  const promptTemplate = normalizePromptDescriptor(options.promptTemplate);
  const responseFormat = isStructuredOutputEnabled()
    ? options.responseFormat ?? null
    : null;
  // Sent only when the caller sets a finite one (the claim judge with
  // RAG_CLAIM_JUDGE_TEMPERATURE); otherwise the request carries none.
  const temperatureOption =
    typeof options.temperature === "number" && Number.isFinite(options.temperature)
      ? { temperature: options.temperature }
      : {};
  // The caller's signal plus the bound request's (request-deadline.js): a
  // cancelled agent request aborts the call and stops its retries and failover.
  const signal = withRequestSignal(options.signal);

  if (customProvider?.completeText) {
    const modelRoute = buildCustomProviderRoute(capability);
    const metricContext = buildCustomRouteMetricContext();
    const text = await runWithLlmOpsMetric({
      action: () => {
        options.onAttemptStart?.();
        return customProvider.completeText(inputText, {
          onTextDelta: options.onTextDelta,
          responseFormat,
          ...temperatureOption,
          ...(signal ? { signal } : {}),
        });
      },
      metric: {
        ...buildUsageMetricFields({
          inputCharacters: inputText.length,
          metricContext,
        }),
        inputCharacters: inputText.length,
        itemCount: 1,
        modelRoute,
        operation: LLMOPS_OPERATIONS.completion,
        promptTemplate,
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
      recorder: recordModelMetricEvent,
    });

    return {
      modelRoute,
      text,
    };
  }

  if (routesThroughModelGateway()) {
    return completeThroughModelGateway({
      capability,
      inputText,
      options: { ...options, signal },
      prompt,
      promptTemplate,
      responseFormat,
      temperatureOption,
    });
  }

  const primary = getChatModelInstance(options);
  // An empty completion is retried once, then returned as it always was: callers
  // already treat empty text as "no answer". A length-truncated one is not
  // retried, because the same budget would truncate it again.
  // `onTextDelta` streams the completion as it is generated. Every attempt --
  // a retry or a failover model -- starts with `onAttemptStart`, so a consumer
  // can drop what a failed attempt already streamed. The returned text is
  // always the whole completion, streamed or not.
  const invokeOnce = async (instance) => {
    options.onAttemptStart?.();
    const result =
      typeof options.onTextDelta === "function" && typeof instance.invokeStream === "function"
        ? await instance.invokeStream(prompt, {
            onDelta: options.onTextDelta,
            responseFormat,
            signal,
            ...temperatureOption,
          })
        : await instance.invoke(prompt, { responseFormat, signal, ...temperatureOption });

    if (!normalizeContent(result?.content) && result?.finishReason !== "length") {
      const error = new Error("Chat completion returned empty content.");
      error.code = EMPTY_COMPLETION_CODE;
      error.response = result;
      throw error;
    }

    return result;
  };
  const completeOn = ({ instance, metricContext, modelName, modelRoute }) =>
    runWithLlmOpsMetric({
      action: () =>
        withRetry(() => invokeOnce(instance), "Chat completion failed.", { signal }).catch(
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
        modelName,
        modelRoute,
        operation: LLMOPS_OPERATIONS.completion,
        promptTemplate,
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
      recorder: recordModelMetricEvent,
    }).then((response) => {
      // The gateway answers with the provider's model name and finish reason,
      // which the returned shape does not carry.
      getModelGatewayCall()?.noteCompletion?.({
        finishReason: response?.finishReason ?? null,
        modelName,
      });

      return {
        modelRoute,
        text: normalizeContent(response.content),
      };
    });

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
      if (signal?.aborted) {
        break;
      }

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

// The prompt is converted to messages exactly as the direct client would send
// it, so the backend sees the same request either way. `onAttemptStart` runs
// once per model attempt the gateway makes (it streams a marker for each), so
// answer drafts are still reset by a gateway-side retry or failover. One mirror
// LLMOps event per call carries the gateway's metered usage and the route of
// the model that answered.
const completeThroughModelGateway = ({
  capability,
  inputText,
  options,
  prompt,
  promptTemplate,
  responseFormat,
  temperatureOption = {},
}) => {
  const modelRoute = buildModelGatewayPendingRoute(capability, options.routeId);
  const estimate = {
    inputCharacters: inputText.length,
    metricContext: buildCustomRouteMetricContext(),
  };

  return runWithLlmOpsMetric({
    action: () =>
      requestModelGatewayCompletion({
        capability,
        messages: toChatMessages(prompt),
        onAttemptStart: options.onAttemptStart,
        onTextDelta: options.onTextDelta,
        promptTemplate,
        responseFormat,
        routeId: options.routeId ?? null,
        signal: options.signal,
        workspacePolicy: options.workspacePolicy,
        ...temperatureOption,
      }),
    metric: {
      ...buildUsageMetricFields(estimate),
      annotations: [MODEL_GATEWAY_MIRROR_ANNOTATION],
      inputCharacters: inputText.length,
      itemCount: 1,
      modelRoute,
      operation: LLMOPS_OPERATIONS.completion,
      promptTemplate,
      stage: "complete_text",
    },
    policy: getRuntimeLlmOpsPolicy(),
    recorder: recordModelMetricEvent,
    successMetric: (result) => ({
      ...buildModelGatewayUsageMetric(result, {
        ...estimate,
        outputCharacters: getTextCharacters(result?.text),
      }),
      modelRoute: result.modelRoute ?? modelRoute,
      outputCharacters: getTextCharacters(result?.text),
    }),
  }).then((result) => ({
    modelRoute: result.modelRoute ?? modelRoute,
    text: normalizeContent(result.text),
  }));
};
