import { getModelGatewayTimeoutMs } from "../config.js";
import { getActiveDatabaseTenant } from "../postgres-tenant.js";
import {
  getRequestBudgetMs,
  isRequestCancelledError,
  REQUEST_CANCELLATION_REASONS,
  withRequestSignal,
} from "../request-deadline.js";
import {
  createServiceClient,
  ServiceTimeoutError,
  ServiceUnavailableError,
} from "../service-client.js";
import { getModelGatewayUrls, SERVICE_TIERS } from "../service-topology.js";
import {
  createModelGatewayCallError,
  MODEL_GATEWAY_ERROR_CODES,
  MODEL_GATEWAY_EXTENSION_FIELD,
  MODEL_GATEWAY_PATHS,
} from "./protocol.js";

// Calling side of the model gateway: what openai.js and reranker.js use when
// MODEL_GATEWAY_URL is set (isModelGatewayEnabled).
//
// Each call is signed with the caller's tenant -- the database tenant of the
// current async context, which the request middleware and background work set
// (postgres-tenant.js) -- or with the system identity when there is none. The
// prompt template descriptor travels as metadata in the `archive_rag` field.
//
// This side runs no retry, backoff, failover or model-call guard of its own:
// the gateway does, once. The only thing repeated here is a request no gateway
// replica received -- a refused connection moves to the next replica, as the
// service client does for every tier -- and, for embeddings and rerank (which
// are safe to repeat), a connection lost mid-request. A gateway that cannot be
// reached is a 503 with code MODEL_GATEWAY_UNAVAILABLE (504
// MODEL_GATEWAY_TIMEOUT when the budget ran out, 502
// MODEL_GATEWAY_PROTOCOL_ERROR for an answer that is not the gateway's), never
// a URL or a body.
//
// A call made for a request with a deadline (request-deadline.js: an agent
// request, or a retrieval-tier operation under its caller's deadline) spends
// at most what is left of it, so the gateway receives the shrunken deadline in
// its header and abandons the backend request when it passes; the request's
// signal aborts the call when the request is cancelled. A call the deadline
// cut fails as MODEL_GATEWAY_TIMEOUT, whichever timer fired first.

let cachedClient = null;

const getGatewayClient = () => {
  const urls = getModelGatewayUrls();
  const timeoutMs = getModelGatewayTimeoutMs();
  const key = `${urls.join(",")}|${timeoutMs}`;

  if (cachedClient?.key !== key) {
    cachedClient = {
      client: createServiceClient({
        audience: SERVICE_TIERS.modelGateway,
        timeoutMs,
        // Every answer is the gateway's: a 503 about an unavailable model is
        // not a sign that the gateway replica is unhealthy, and must not send
        // the call to another replica that would retry the model again.
        unavailableStatuses: [],
        urls,
      }),
      key,
      timeoutMs,
    };
  }

  return cachedClient;
};

/** Replica state of this process's gateway client, for health output (null before first use). */
export const describeModelGatewayClient = () => cachedClient?.client.snapshot() ?? null;

export const resetModelGatewayClient = () => {
  cachedClient = null;
};

const resolveCallerIdentity = () => {
  const tenant = getActiveDatabaseTenant();

  return tenant
    ? {
        accessScope: {
          authenticated: false,
          userId: tenant.userId,
          workspaceId: tenant.workspaceId,
        },
      }
    : { system: true };
};

const createGatewayError = ({ causeCode = null, code, message, serviceCode = null, status }) => {
  const error = new Error(`Model gateway: ${message}`);

  error.name = "ModelGatewayError";
  error.code = code;
  error.status = status;
  error.serviceCode = serviceCode;
  error.causeCode = causeCode;
  error.modelGateway = true;

  return error;
};

const createProtocolError = (message) =>
  createGatewayError({ code: MODEL_GATEWAY_ERROR_CODES.protocol, message, status: 502 });

const findCauseCode = (error) => {
  const code = error?.cause?.code ?? error?.code;

  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null;
};

// Every way a call can fail on the way to or from the gateway becomes a
// ModelGatewayError with a stable code: no replica answered (503), the budget
// ran out (504), the connection broke while the answer was being read (503),
// or the answer could not be read (502). The caller's own abort, and errors
// raised before anything was sent (a bad scope, keys that are missing), are
// passed on as they are.
const toTransportError = (error, signal) => {
  if (isRequestCancelledError(error) && error.reason === REQUEST_CANCELLATION_REASONS.deadlineExceeded) {
    return createGatewayError({
      code: MODEL_GATEWAY_ERROR_CODES.timeout,
      message: "no answer before the request's deadline.",
      status: 504,
    });
  }

  if (error?.modelGateway || (signal?.aborted && error === signal.reason)) {
    return error;
  }

  if (error instanceof ServiceUnavailableError) {
    const timedOut = error instanceof ServiceTimeoutError;

    return createGatewayError({
      causeCode: error.causeCode ?? null,
      code: timedOut ? MODEL_GATEWAY_ERROR_CODES.timeout : MODEL_GATEWAY_ERROR_CODES.unavailable,
      message: timedOut ? "no answer within the call's budget." : "the gateway is unavailable.",
      serviceCode: error.code,
      status: timedOut ? 504 : 503,
    });
  }

  if (error?.name === "TimeoutError") {
    return createGatewayError({
      code: MODEL_GATEWAY_ERROR_CODES.timeout,
      message: "no answer within the call's budget.",
      status: 504,
    });
  }

  if (error instanceof SyntaxError) {
    return createProtocolError("unexpected answer from the gateway.");
  }

  // fetch reports a connection lost mid-body as a TypeError with a cause.
  if (error instanceof TypeError && error.cause !== undefined) {
    return createGatewayError({
      causeCode: findCauseCode(error),
      code: MODEL_GATEWAY_ERROR_CODES.unavailable,
      message: "the connection to the gateway was lost.",
      status: 503,
    });
  }

  return error;
};

// The call's budget: its own (or the client's default) capped by the bound
// request's deadline. Without a deadline it is exactly what was asked for.
const resolveCallBudget = (timeoutMs, clientTimeoutMs) =>
  getRequestBudgetMs(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : clientTimeoutMs);

const createDeadlinePassedError = () =>
  createGatewayError({
    code: MODEL_GATEWAY_ERROR_CODES.timeout,
    message: "no time left before the request's deadline.",
    status: 504,
  });

const post = async ({ body, idempotent, path, signal: callerSignal, timeoutMs }) => {
  const { client, timeoutMs: clientTimeoutMs } = getGatewayClient();
  const budgetMs = resolveCallBudget(timeoutMs, clientTimeoutMs);
  const signal = withRequestSignal(callerSignal);

  if (budgetMs <= 0) {
    throw createDeadlinePassedError();
  }

  try {
    return await client.request({
      ...resolveCallerIdentity(),
      body,
      idempotent,
      method: "POST",
      path,
      signal,
      timeoutMs: budgetMs,
    });
  } catch (error) {
    throw toTransportError(error, signal);
  }
};

const readExtension = (json) => json?.[MODEL_GATEWAY_EXTENSION_FIELD] ?? {};

const assertOk = (answer) => {
  if (answer.status !== 200 || !answer.json) {
    throw createModelGatewayCallError(answer);
  }

  return answer.json;
};

const toResult = (extension) => ({
  latencySloMs: Number.isFinite(extension.latencySloMs) ? extension.latencySloMs : null,
  meteredUsage: extension.usage ?? null,
  modelCalls: Number.isFinite(extension.modelCalls) ? extension.modelCalls : null,
  modelRoute: extension.modelRoute ?? null,
});

const buildChatBody = ({
  capability,
  messages,
  promptTemplate,
  responseFormat,
  routeId,
  stream,
  workspacePolicy,
}) => ({
  messages,
  ...(responseFormat ? { response_format: responseFormat } : {}),
  ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  [MODEL_GATEWAY_EXTENSION_FIELD]: {
    capability,
    promptTemplate: promptTemplate ?? null,
    routeId: routeId ?? null,
    ...(workspacePolicy ? { workspacePolicy } : {}),
  },
});

// Reads the gateway's SSE answer: content deltas go to onTextDelta, an attempt
// marker to onAttemptStart, and the final chunk carries the route and usage.
// An error after the stream started arrives as an `error` chunk; a stream that
// breaks, runs out of budget or cannot be parsed fails like any gateway call
// (toTransportError), never with the raw fetch or JSON error.
const readChatStream = async (response, { onAttemptStart, onTextDelta, signal }) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason = null;
  let extension = {};
  let done = false;

  const handleLine = (line) => {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) {
      return;
    }

    const payload = trimmed.slice(5).trim();

    if (!payload) {
      return;
    }

    if (payload === "[DONE]") {
      done = true;
      return;
    }

    const chunk = JSON.parse(payload);

    if (chunk.error) {
      throw createModelGatewayCallError({ json: chunk, status: 503 });
    }

    const chunkExtension = readExtension(chunk);

    if (Number.isInteger(chunkExtension.attempt)) {
      // A new attempt starts over: the answer is the last attempt's text.
      text = "";
      finishReason = null;
      onAttemptStart?.();
    }

    if (chunkExtension.modelRoute || chunkExtension.usage) {
      extension = { ...extension, ...chunkExtension };
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;

    if (typeof delta === "string" && delta.length > 0) {
      text += delta;
      onTextDelta?.(delta);
    }

    finishReason = choice?.finish_reason ?? finishReason;
  };

  try {
    for (;;) {
      const { done: ended, value } = await reader.read();

      if (ended) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      lines.forEach(handleLine);
    }

    handleLine(buffer + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw toTransportError(error, signal);
  }

  if (!done) {
    const error = new Error("Model gateway: the answer stream ended early.");

    error.name = "ModelGatewayError";
    error.code = MODEL_GATEWAY_ERROR_CODES.unavailable;
    error.status = 503;
    error.modelGateway = true;
    throw error;
  }

  return { ...toResult(extension), finishReason, text };
};

const streamCompletion = async (body, { onAttemptStart, onTextDelta, signal: callerSignal }) => {
  const { client, timeoutMs: clientTimeoutMs } = getGatewayClient();
  const timeoutMs = resolveCallBudget(null, clientTimeoutMs);
  const signal = withRequestSignal(callerSignal);
  let response;

  if (timeoutMs <= 0) {
    throw createDeadlinePassedError();
  }

  try {
    // The gateway sends its headers with the first token (or its error), so
    // the wait for headers gets the whole budget, like the stream itself.
    response = await client.stream({
      ...resolveCallerIdentity(),
      body,
      deadlineMs: timeoutMs,
      idempotent: false,
      method: "POST",
      path: MODEL_GATEWAY_PATHS.chatCompletions,
      signal,
      timeoutMs,
    });
  } catch (error) {
    throw toTransportError(error, signal);
  }

  if (response.status !== 200) {
    const text = await response.text().catch(() => "");
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    throw createModelGatewayCallError({
      headers: Object.fromEntries(response.headers.entries()),
      json,
      status: response.status,
    });
  }

  return readChatStream(response, { onAttemptStart, onTextDelta, signal });
};

/**
 * One chat completion through the gateway. Streams when `onTextDelta` is a
 * function. Resolves { text, finishReason, modelRoute, meteredUsage,
 * modelCalls, latencySloMs }; rejects with the gateway's status and code.
 */
export const requestModelGatewayCompletion = async ({
  capability,
  messages,
  onAttemptStart,
  onTextDelta,
  promptTemplate,
  responseFormat,
  routeId,
  signal,
  workspacePolicy,
}) => {
  const stream = typeof onTextDelta === "function";
  const body = buildChatBody({
    capability,
    messages,
    promptTemplate,
    responseFormat,
    routeId,
    stream,
    workspacePolicy,
  });

  if (stream) {
    return streamCompletion(body, { onAttemptStart, onTextDelta, signal });
  }

  onAttemptStart?.();
  const json = assertOk(
    await post({ body, idempotent: false, path: MODEL_GATEWAY_PATHS.chatCompletions, signal })
  );
  const choice = json.choices?.[0];

  return {
    ...toResult(readExtension(json)),
    finishReason: choice?.finish_reason ?? null,
    text: typeof choice?.message?.content === "string" ? choice.message.content : "",
  };
};

// Texts per embeddings request to the gateway: the batch the direct client
// sends upstream (openai-client.js), so a document of any size embeds in the
// same number of upstream requests and no request nears the gateway's input
// or body limits.
export const MODEL_GATEWAY_EMBEDDING_BATCH_SIZE = 512;

const readVectors = (json, expectedCount) => {
  const data = Array.isArray(json?.data) ? json.data : null;

  if (
    !data ||
    data.length !== expectedCount ||
    !data.every((item) => Array.isArray(item?.embedding) && Number.isInteger(item?.index))
  ) {
    throw createProtocolError("the embeddings answer does not match the request.");
  }

  return [...data].sort((left, right) => left.index - right.index).map((item) => item.embedding);
};

const sumCounts = (left, right) =>
  Number.isFinite(left) || Number.isFinite(right)
    ? (Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0)
    : null;

// The metered usage of several gateway requests that make up one call.
const addMeteredUsage = (total, usage) => {
  if (!usage) {
    return total;
  }

  if (!total) {
    return { ...usage };
  }

  return {
    costCurrency: total.costCurrency ?? usage.costCurrency ?? null,
    estimatedCostUsd: sumCounts(total.estimatedCostUsd, usage.estimatedCostUsd),
    inputTokens: sumCounts(total.inputTokens, usage.inputTokens),
    outputTokens: sumCounts(total.outputTokens, usage.outputTokens),
    pricingSource: total.pricingSource === usage.pricingSource ? total.pricingSource : "unavailable",
    tokenSource: total.tokenSource === usage.tokenSource ? total.tokenSource : "estimated",
    totalTokens: sumCounts(total.totalTokens, usage.totalTokens),
  };
};

/**
 * Embeddings through the gateway: `input` is one string (a query) or a list
 * (documents), already prefixed. A list goes out in requests of at most
 * MODEL_GATEWAY_EMBEDDING_BATCH_SIZE texts, one after another, and their
 * metered usage is added up. Resolves { vectors, modelRoute, meteredUsage }.
 */
export const requestModelGatewayEmbeddings = async ({ input, model, signal }) => {
  if (Array.isArray(input) && input.length === 0) {
    return { meteredUsage: null, modelCalls: 0, modelRoute: null, vectors: [] };
  }

  const batches = [];

  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += MODEL_GATEWAY_EMBEDDING_BATCH_SIZE) {
      batches.push(input.slice(index, index + MODEL_GATEWAY_EMBEDDING_BATCH_SIZE));
    }
  } else {
    batches.push(input);
  }

  const vectors = [];
  let result = null;

  for (const batch of batches) {
    const json = assertOk(
      await post({
        body: { input: batch, ...(model ? { model } : {}) },
        idempotent: true,
        path: MODEL_GATEWAY_PATHS.embeddings,
        signal,
      })
    );
    const answer = toResult(readExtension(json));

    vectors.push(...readVectors(json, Array.isArray(batch) ? batch.length : 1));
    result = result
      ? {
          ...answer,
          meteredUsage: addMeteredUsage(result.meteredUsage, answer.meteredUsage),
          modelCalls: sumCounts(result.modelCalls, answer.modelCalls),
          modelRoute: answer.modelRoute ?? result.modelRoute,
        }
      : answer;
  }

  return { ...result, vectors };
};

/**
 * Cross-encoder scores through the gateway, in the order of `texts`.
 * `timeoutMs` is the whole call's budget (the reranker passes its own request
 * timeout, so a slow gateway degrades a query as a slow cross-encoder would).
 * Resolves { scores, modelRoute, meteredUsage }.
 */
export const requestModelGatewayRerank = async ({ model, query, signal, texts, timeoutMs }) => {
  const json = assertOk(
    await post({
      body: { query, texts, ...(model ? { model } : {}) },
      idempotent: true,
      path: MODEL_GATEWAY_PATHS.rerank,
      signal,
      timeoutMs,
    })
  );

  return { ...toResult(readExtension(json)), scores: json.scores };
};
