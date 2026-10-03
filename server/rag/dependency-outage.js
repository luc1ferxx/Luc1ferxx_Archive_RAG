import {
  getRequestCancellation,
  isRequestCancelledError,
} from "./request-deadline.js";

// When an agent request cannot be answered because something it depends on is
// down, the answer says so: 503 (504 when the dependency timed out) with a
// stable code and Retry-After, and the run fails with retryable: true. It is
// never dressed up as an evidence gap -- before this, a failed primary
// document step fell through to the Web stage and the user was asked to
// approve a Web search instead.
//
// A dependency outage is, after retries and failover have had their turn:
//   - a tier of a split deployment that did not answer (service-client.js
//     SERVICE_UNREACHABLE, SERVICE_UNAVAILABLE, SERVICE_TIMEOUT);
//   - the model gateway unavailable or out of time (MODEL_GATEWAY_UNAVAILABLE,
//     MODEL_GATEWAY_TIMEOUT), or a model it reports unavailable
//     (MODEL_UPSTREAM_UNAVAILABLE, MODEL_UPSTREAM_TIMEOUT, CIRCUIT_OPEN);
//   - the retrieval tier reporting its own dependency down (the 424 that
//     remote-retrieval.js restores to that dependency's 502/503/504);
//   - a model backend called directly that answered 5xx or 408, or could not
//     be reached (connection refused/reset, DNS, timeout), or whose circuit is
//     open (model-call-guard.js);
//   - PostgreSQL unavailable (SQLSTATE class 08, 57P01-57P03, 53300, or the
//     pool's connection errors).
// Anything else -- a 4xx, a 429, a protocol error, a bug -- is not an outage
// and keeps the answer it had. Ordinary evidence gaps are not errors at all
// and keep their clarification.
//
// Classification reads codes, statuses and names only. The error it builds
// carries the dependency kind and the cause's stable code, never the cause's
// message, so it is safe to answer with and to store on the run.

export const DEPENDENCY_OUTAGE_CODES = Object.freeze({
  timeout: "AGENT_DEPENDENCY_TIMEOUT",
  unavailable: "AGENT_DEPENDENCY_UNAVAILABLE",
});

export const DEPENDENCY_OUTAGE_REASON = "dependency_unavailable";

export const DEPENDENCY_KINDS = Object.freeze({
  database: "database",
  model: "model",
  retrieval: "retrieval",
  service: "service",
  unknown: "dependency",
});

// Retry-After when the cause did not say: long enough for a replica cooldown
// (INTERNAL_SERVICE_UNHEALTHY_COOLDOWN_MS, 5 s by default) to pass.
export const DEFAULT_OUTAGE_RETRY_AFTER_SECONDS = 5;

const SERVICE_CLIENT_OUTAGE_CODES = new Set([
  "SERVICE_TIMEOUT",
  "SERVICE_UNAVAILABLE",
  "SERVICE_UNREACHABLE",
]);
const MODEL_OUTAGE_CODES = new Set([
  "CIRCUIT_OPEN",
  "MODEL_GATEWAY_TIMEOUT",
  "MODEL_GATEWAY_UNAVAILABLE",
  "MODEL_UPSTREAM_TIMEOUT",
  "MODEL_UPSTREAM_UNAVAILABLE",
]);
const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "MODEL_GATEWAY_TIMEOUT",
  "MODEL_UPSTREAM_TIMEOUT",
  "SERVICE_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
// 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now,
// 53300 too_many_connections; class 08 is connection_exception.
const POSTGRES_UNAVAILABLE_SQLSTATES = new Set(["53300", "57P01", "57P02", "57P03"]);
// node-postgres raises these without a code when the server goes away or the
// pool cannot hand out a connection in time.
const POSTGRES_UNAVAILABLE_MESSAGES = [
  /^Connection terminated/u,
  /^timeout exceeded when trying to connect$/u,
];
const RETRIEVAL_NON_OUTAGE_CODES = new Set(["RETRIEVAL_RESPONSE_INVALID"]);
// Stable codes, SQLSTATEs (57P01) included.
const STABLE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_]{0,63}$/u;
const MAX_CAUSE_DEPTH = 5;

const readCode = (error) => (typeof error?.code === "string" ? error.code.trim() : "");

const toStableCode = (code) => (STABLE_CODE_PATTERN.test(code) ? code : null);

const isRetrievalServiceError = (error) =>
  error?.name === "RetrievalServiceError" && error?.service === "retrieval";

const isPostgresError = (error) => {
  const code = readCode(error);

  return (
    /^08[0-9A-Z]{3}$/u.test(code) ||
    POSTGRES_UNAVAILABLE_SQLSTATES.has(code) ||
    (!code && POSTGRES_UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(String(error?.message ?? ""))))
  );
};

// One error, without its causes: { causeCode, dependency, timedOut } or null.
const classifyOne = (error) => {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = readCode(error);
  const upperCode = code.toUpperCase();
  const status = Number(error.status);

  if (isRetrievalServiceError(error)) {
    return [502, 503, 504].includes(status) && !RETRIEVAL_NON_OUTAGE_CODES.has(code)
      ? { causeCode: toStableCode(code), dependency: DEPENDENCY_KINDS.retrieval, timedOut: status === 504 }
      : null;
  }

  if (SERVICE_CLIENT_OUTAGE_CODES.has(code)) {
    const service = typeof error.service === "string" ? error.service : "";

    return {
      causeCode: code,
      dependency:
        service === "retrieval"
          ? DEPENDENCY_KINDS.retrieval
          : service === "model-gateway"
            ? DEPENDENCY_KINDS.model
            : DEPENDENCY_KINDS.service,
      timedOut: TIMEOUT_CODES.has(code),
    };
  }

  if (MODEL_OUTAGE_CODES.has(code)) {
    return { causeCode: code, dependency: DEPENDENCY_KINDS.model, timedOut: TIMEOUT_CODES.has(code) };
  }

  if (isPostgresError(error)) {
    return { causeCode: toStableCode(code), dependency: DEPENDENCY_KINDS.database, timedOut: false };
  }

  // A model backend's own HTTP answer (openai-client.js, reranker.js).
  const upstreamStatus = Number(error.upstreamStatus);

  if (Number.isInteger(upstreamStatus) && (upstreamStatus >= 500 || upstreamStatus === 408)) {
    return {
      causeCode: `HTTP_${upstreamStatus}`,
      dependency: DEPENDENCY_KINDS.model,
      timedOut: upstreamStatus === 408 || upstreamStatus === 504,
    };
  }

  if (NETWORK_ERROR_CODES.has(upperCode)) {
    return { causeCode: upperCode, dependency: DEPENDENCY_KINDS.unknown, timedOut: TIMEOUT_CODES.has(upperCode) };
  }

  // A status alone (an Error with status 503 and no code) says nothing about
  // which dependency failed or whether one did.
  return null;
};

// The first Retry-After (ms) one of `errors` states. openai-client.js sets
// retryAfterMs to null when the backend sent no Retry-After, and Number(null)
// is 0: only an actual number counts, or that would answer Retry-After: 1.
const readRetryAfterMs = (...errors) => {
  for (const candidate of errors) {
    const value = candidate?.retryAfterMs;

    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  return null;
};

/**
 * Whether `error` (or one of its causes) is a dependency outage, as
 * { causeCode, dependency, timedOut, retryAfterMs }; null otherwise.
 */
export const classifyDependencyOutage = (error) => {
  let current = error;

  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (isRequestCancelledError(current) || current instanceof DependencyOutageError) {
      return null;
    }

    const classified = classifyOne(current);

    if (classified) {
      return { ...classified, retryAfterMs: readRetryAfterMs(current, error) };
    }

    current = current.cause;
  }

  return null;
};

const toRetryAfterSeconds = (retryAfterMs) =>
  Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.max(1, Math.ceil(retryAfterMs / 1000))
    : DEFAULT_OUTAGE_RETRY_AFTER_SECONDS;

/**
 * A dependency outage, answered 503 AGENT_DEPENDENCY_UNAVAILABLE or 504
 * AGENT_DEPENDENCY_TIMEOUT. `dependency` names the kind (retrieval, model,
 * database, service, dependency), `causeCode` the cause's stable code when it
 * has one. `runFailure` is what the run records with its failed status.
 */
export class DependencyOutageError extends Error {
  constructor({ causeCode = null, dependency = DEPENDENCY_KINDS.unknown, retryAfterMs = null, timedOut = false } = {}, { cause } = {}) {
    super(
      `A service this answer depends on is ${timedOut ? "not answering in time" : "unavailable"}${
        causeCode ? ` (${causeCode})` : ""
      }. Try again shortly.`,
      cause === undefined ? undefined : { cause }
    );
    this.name = "DependencyOutageError";
    this.code = timedOut ? DEPENDENCY_OUTAGE_CODES.timeout : DEPENDENCY_OUTAGE_CODES.unavailable;
    this.status = timedOut ? 504 : 503;
    this.dependency = dependency;
    this.causeCode = causeCode;
    this.retryable = true;
    this.retryAfterSeconds = toRetryAfterSeconds(retryAfterMs);
    this.runFailure = {
      causeCode,
      code: this.code,
      dependency,
      reason: DEPENDENCY_OUTAGE_REASON,
      retryable: true,
    };
  }
}

export const isDependencyOutageError = (error) => error instanceof DependencyOutageError;

/** `error` as a DependencyOutageError when it is an outage, else null. */
export const toDependencyOutageError = (error) => {
  if (isDependencyOutageError(error)) {
    return error;
  }

  const classified = classifyDependencyOutage(error);

  return classified ? new DependencyOutageError(classified, { cause: error }) : null;
};

/**
 * Why an agent run must end now, as the error to end it with: the bound
 * request's cancellation (its deadline passed or its client left -- this wins
 * whatever error surfaced, since a call cut by the deadline fails in many
 * shapes), else a dependency outage; null for any other error.
 */
export const resolveAgentRunTermination = (error) => {
  if (isRequestCancelledError(error)) {
    return error;
  }

  return getRequestCancellation({ cause: error }) ?? toDependencyOutageError(error);
};

/**
 * The HTTP answer for an agent request that ended in a cancellation or an
 * outage: { status, headers, body }, or null for any other error (the route
 * keeps its own answer). The body carries the stable code, retryable, and the
 * run id when a run was recorded; never the cause's message.
 */
export const describeAgentRequestFailure = (error) => {
  const runId = typeof error?.agentRunId === "string" && error.agentRunId ? error.agentRunId : null;

  if (isRequestCancelledError(error)) {
    return {
      body: {
        ...(runId ? { agentRunId: runId } : {}),
        code: error.code,
        error: error.message,
        reason: error.reason,
        retryable: error.retryable,
      },
      headers: {},
      status: error.status,
    };
  }

  const outage = toDependencyOutageError(error);

  if (!outage) {
    return null;
  }

  return {
    body: {
      ...(runId ? { agentRunId: runId } : {}),
      ...(outage.causeCode ? { causeCode: outage.causeCode } : {}),
      code: outage.code,
      dependency: outage.dependency,
      error: outage.message,
      ...(outage.retryable === false ? {} : { retryAfterSeconds: outage.retryAfterSeconds }),
      retryable: outage.retryable !== false,
    },
    // No Retry-After once the run committed a write a retry would repeat.
    headers: outage.retryable === false ? {} : { "Retry-After": String(outage.retryAfterSeconds) },
    status: outage.status,
  };
};
