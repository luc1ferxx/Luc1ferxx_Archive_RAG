import { CIRCUIT_OPEN_CODE } from "../model-call-guard.js";

// Wire contract between the model gateway (ARCHIVE_RAG_ROLE=model-gateway) and
// the tiers that call it.
//
// The endpoints speak the OpenAI shapes (chat completions, embeddings) and the
// cross-encoder shape ({ query, texts } -> { scores }), so a generic
// OpenAI-compatible client can use them. Everything this system adds travels
// in one extension field, `archive_rag`, on requests and answers:
//   request   { capability, routeId, promptTemplate, workspacePolicy } (chat)
//   answer    { modelRoute, usage (the gateway's metered usage), modelCalls,
//               latencySloMs }
//   stream    { attempt } on a chunk with no choices, before every model
//             attempt, so a caller can drop what a failed attempt streamed
//   error     { status, code, retryAfterMs, upstreamStatus, quota }
// The tenant is never read from a body: it comes from the signed internal
// token (service-identity.js).
//
// Errors carry a stable code and a generic message. An upstream model's own
// error text is never forwarded: it can echo the request, and the request is a
// prompt.

export const MODEL_GATEWAY_EXTENSION_FIELD = "archive_rag";

export const MODEL_GATEWAY_PATHS = Object.freeze({
  chatCompletions: "/v1/chat/completions",
  embeddings: "/v1/embeddings",
  health: "/health",
  rerank: "/rerank",
  usage: "/usage",
});

export const MODEL_GATEWAY_ERROR_CODES = Object.freeze({
  // Gateway answers.
  aborted: "MODEL_CALL_ABORTED",
  backendNotConfigured: "MODEL_GATEWAY_BACKEND_NOT_CONFIGURED",
  badRequest: "MODEL_GATEWAY_BAD_REQUEST",
  budgetExceeded: "MODEL_LLMOPS_BUDGET_EXCEEDED",
  circuitOpen: CIRCUIT_OPEN_CODE,
  forbidden: "MODEL_GATEWAY_FORBIDDEN",
  internal: "MODEL_GATEWAY_INTERNAL",
  quotaExceeded: "MODEL_GATEWAY_QUOTA_EXCEEDED",
  upstreamAuth: "MODEL_UPSTREAM_AUTH_FAILED",
  upstreamRateLimited: "MODEL_UPSTREAM_RATE_LIMITED",
  upstreamRejected: "MODEL_UPSTREAM_REJECTED",
  upstreamTimeout: "MODEL_UPSTREAM_TIMEOUT",
  upstreamUnavailable: "MODEL_UPSTREAM_UNAVAILABLE",
  // Raised by the calling side only.
  protocol: "MODEL_GATEWAY_PROTOCOL_ERROR",
  timeout: "MODEL_GATEWAY_TIMEOUT",
  unavailable: "MODEL_GATEWAY_UNAVAILABLE",
});

export const MODEL_GATEWAY_QUOTAS = Object.freeze({
  dailyTokens: "daily_tokens",
  requestsPerMinute: "requests_per_minute",
  tokensPerMinute: "tokens_per_minute",
});

// Which side's LLMOps event is authoritative. The gateway meters every model
// attempt it makes (retries and failover included) and tags those events
// `model_gateway_metered` with the tenant; the caller keeps one event per
// gateway call, tagged `model_gateway_mirror`, only so run-level ceilings,
// spans and agentObservability see the call. Totals over a deployment count
// the metered events and skip the mirrors.
export const MODEL_GATEWAY_METERED_ANNOTATION = Object.freeze({
  category: "metering",
  id: "model_gateway_metered",
  severity: "info",
  source: "model_gateway",
});

export const MODEL_GATEWAY_MIRROR_ANNOTATION = Object.freeze({
  category: "metering",
  id: "model_gateway_mirror",
  severity: "info",
  source: "model_gateway",
});

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_ERROR_CODES = new Set(["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"]);

const MESSAGES = Object.freeze({
  [MODEL_GATEWAY_ERROR_CODES.aborted]: "The model call was abandoned before it finished.",
  [MODEL_GATEWAY_ERROR_CODES.backendNotConfigured]: "The model gateway has no backend for this request.",
  [MODEL_GATEWAY_ERROR_CODES.badRequest]: "The model gateway could not read this request.",
  [MODEL_GATEWAY_ERROR_CODES.budgetExceeded]: "LLMOps budget exceeded.",
  [MODEL_GATEWAY_ERROR_CODES.circuitOpen]:
    "The model is unavailable: recent requests to it failed and its circuit is open.",
  [MODEL_GATEWAY_ERROR_CODES.forbidden]: "This identity may not read gateway usage.",
  [MODEL_GATEWAY_ERROR_CODES.internal]: "The model gateway could not serve this request.",
  [MODEL_GATEWAY_ERROR_CODES.quotaExceeded]: "The workspace has used its model quota for now.",
  [MODEL_GATEWAY_ERROR_CODES.upstreamAuth]: "The model backend refused the gateway's credentials.",
  [MODEL_GATEWAY_ERROR_CODES.upstreamRateLimited]: "The model backend is rate limiting requests.",
  [MODEL_GATEWAY_ERROR_CODES.upstreamRejected]: "The model backend rejected the request.",
  [MODEL_GATEWAY_ERROR_CODES.upstreamTimeout]: "The model backend did not answer in time.",
  [MODEL_GATEWAY_ERROR_CODES.upstreamUnavailable]: "The model backend is unavailable.",
});

const findCode = (error) =>
  String(error?.code ?? error?.cause?.code ?? "").toUpperCase();

const toRetryAfterMs = (value) =>
  Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/**
 * Gateway side: what to answer for an error a model call raised, as
 * { status, code, message, retryAfterMs, upstreamStatus, quota }. Upstream
 * statuses keep their meaning for the caller: a 4xx stays that 4xx, a 429
 * stays a 429 with its Retry-After, and unavailability becomes a 503 (504 for a
 * timeout). An error that did not come from a backend is a 500 with no detail.
 */
export const describeModelGatewayError = (error) => {
  const code = findCode(error);
  const upstreamStatus = Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : null;
  const build = (status, gatewayCode, extra = {}) => ({
    code: gatewayCode,
    message: MESSAGES[gatewayCode] ?? MESSAGES[MODEL_GATEWAY_ERROR_CODES.internal],
    quota: null,
    retryAfterMs: null,
    status,
    upstreamStatus,
    ...extra,
  });

  if (error?.gatewayError) {
    return { ...build(error.gatewayError.status, error.gatewayError.code), ...error.gatewayError };
  }

  if (code === CIRCUIT_OPEN_CODE) {
    return build(503, MODEL_GATEWAY_ERROR_CODES.circuitOpen);
  }

  if (code === MODEL_GATEWAY_ERROR_CODES.aborted) {
    return build(504, MODEL_GATEWAY_ERROR_CODES.aborted);
  }

  if (error?.name === "LlmOpsBudgetExceededError") {
    return build(429, MODEL_GATEWAY_ERROR_CODES.budgetExceeded);
  }

  if (upstreamStatus !== null) {
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      return build(502, MODEL_GATEWAY_ERROR_CODES.upstreamAuth);
    }

    if (upstreamStatus === 429) {
      return build(429, MODEL_GATEWAY_ERROR_CODES.upstreamRateLimited, {
        retryAfterMs: toRetryAfterMs(error?.retryAfterMs),
      });
    }

    if (upstreamStatus === 408) {
      return build(504, MODEL_GATEWAY_ERROR_CODES.upstreamTimeout);
    }

    if (upstreamStatus >= 400 && upstreamStatus < 500) {
      return build(upstreamStatus, MODEL_GATEWAY_ERROR_CODES.upstreamRejected);
    }

    return build(503, MODEL_GATEWAY_ERROR_CODES.upstreamUnavailable);
  }

  if (TIMEOUT_ERROR_CODES.has(code)) {
    return build(504, MODEL_GATEWAY_ERROR_CODES.upstreamTimeout);
  }

  if (NETWORK_ERROR_CODES.has(code)) {
    return build(503, MODEL_GATEWAY_ERROR_CODES.upstreamUnavailable);
  }

  return build(500, MODEL_GATEWAY_ERROR_CODES.internal);
};

/** The JSON body of an error answer: OpenAI's `error` object plus the extension. */
export const buildModelGatewayErrorBody = (described) => ({
  error: {
    code: described.code,
    message: described.message,
    type: "archive_rag_model_gateway_error",
  },
  [MODEL_GATEWAY_EXTENSION_FIELD]: {
    error: {
      code: described.code,
      quota: described.quota ?? null,
      retryAfterMs: described.retryAfterMs ?? null,
      status: described.status,
      upstreamStatus: described.upstreamStatus ?? null,
    },
  },
});

/** Retry-After (whole seconds, rounded up) and retry-after-ms headers, or none. */
export const buildRetryAfterHeaders = (retryAfterMs) =>
  Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? {
        "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        "retry-after-ms": String(Math.round(retryAfterMs)),
      }
    : {};

/**
 * Caller side: the Error to throw for a gateway error answer. It keeps the
 * gateway's status and stable code (CIRCUIT_OPEN included), and Retry-After as
 * `retryAfterMs`. `json` is the parsed body or null. An answer that is not the
 * gateway's error is never passed on with its own status: a proxy's 5xx in
 * front of a gateway that is gone becomes 503 MODEL_GATEWAY_UNAVAILABLE, and
 * anything else -- a 200 that is not a completion, the gateway refusing this
 * tier's internal token (a key mismatch between tiers is this deployment's
 * fault, not the end user's 401) -- becomes 502 MODEL_GATEWAY_PROTOCOL_ERROR.
 * The service identity layer's stable code, when there is one, is kept as
 * `serviceCode`.
 */
export const createModelGatewayCallError = ({ headers = {}, json = null, status }) => {
  const extension = json?.[MODEL_GATEWAY_EXTENSION_FIELD]?.error;
  const known = extension && typeof extension.code === "string";
  const code = known
    ? extension.code
    : status >= 500
      ? MODEL_GATEWAY_ERROR_CODES.unavailable
      : MODEL_GATEWAY_ERROR_CODES.protocol;
  const headerRetryAfterMs = Number(headers["retry-after-ms"]);
  const error = new Error(
    `Model gateway: ${
      known
        ? MESSAGES[code] ?? "the model call failed."
        : status >= 500
          ? "the gateway is unavailable."
          : "unexpected answer from the gateway."
    }`
  );

  error.name = "ModelGatewayError";
  error.code = code;
  error.status = known && Number.isInteger(extension.status) ? extension.status : status >= 500 ? 503 : 502;

  if (!known && typeof json?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(json.code)) {
    error.serviceCode = json.code;
  }

  error.retryAfterMs = known && Number.isFinite(extension.retryAfterMs)
    ? extension.retryAfterMs
    : Number.isFinite(headerRetryAfterMs)
      ? headerRetryAfterMs
      : null;
  error.upstreamStatus = known ? extension.upstreamStatus ?? null : null;
  error.quota = known ? extension.quota ?? null : null;
  error.modelGateway = true;

  return error;
};

const toCount = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

/** The usage fields of a metered LLMOps event, as sent to the caller. */
export const pickMeteredUsage = (event = {}) => ({
  costCurrency: event.costCurrency ?? null,
  estimatedCostUsd: toCount(event.estimatedCostUsd),
  inputTokens: toCount(event.inputTokens),
  outputTokens: toCount(event.outputTokens),
  pricingSource: event.pricingSource ?? "unavailable",
  tokenSource: event.tokenSource ?? "unavailable",
  totalTokens: toCount(event.totalTokens),
});
