import crypto from "node:crypto";

import { context, propagation } from "@opentelemetry/api";

import {
  SERVICE_DEADLINE_HEADER,
  SERVICE_HEADER_PREFIX,
  SERVICE_REQUEST_ID_HEADER,
  SERVICE_TOKEN_HEADER,
  signServiceToken,
} from "./service-identity.js";
import {
  getServiceRole,
  getServiceUrls,
  normalizeServiceUrl,
  SERVICE_TIERS,
} from "./service-topology.js";

// HTTP client for calls between the tiers of a split deployment
// (service-topology.js). One client per target tier balances over its
// replicas:
//   - choice: the replica with the fewest requests in flight; ties rotate.
//   - health: a connection failure or a 502/503/504 answer marks the replica
//     unhealthy for a short cooldown. Unhealthy replicas are only passed over
//     while a healthy one exists, so a single replica is never locked out.
//   - failover: each replica is tried at most once per call. A request whose
//     connection was never established moves on to the next replica whether
//     or not it is idempotent (nothing was sent). After bytes were sent, only
//     an idempotent request moves on; a non-idempotent one fails at once, so a
//     /chat or a task is never run twice by the client.
// Every attempt carries a freshly signed identity (service-identity.js), the
// remaining budget in SERVICE_DEADLINE_HEADER, one request id shared by all
// attempts, and the W3C trace context of the active span. Timeouts and
// connection failures surface as ServiceUnavailableError; any other answer,
// including a 4xx or 500 JSON error, is returned to the caller unchanged.
//
// Error messages name the service and a stable code only, never a replica URL,
// the token, or the request body, so they are safe to pass across a service
// boundary.

export const DEFAULT_SERVICE_TIMEOUT_MS = 60_000;
export const DEFAULT_SERVICE_COOLDOWN_MS = 5_000;
export const DEFAULT_UNAVAILABLE_STATUSES = Object.freeze([502, 503, 504]);

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Connection-phase failures: the request never reached the replica.
const CONNECT_PHASE_CODES = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
// Statuses a Response cannot carry a body with.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export const SERVICE_CLIENT_ERROR_CODES = Object.freeze({
  notConfigured: "SERVICE_NOT_CONFIGURED",
  timeout: "SERVICE_TIMEOUT",
  unavailable: "SERVICE_UNAVAILABLE",
  unreachable: "SERVICE_UNREACHABLE",
});

const toPositiveInteger = (rawValue, fallbackValue) => {
  const parsed = Number(rawValue);

  return String(rawValue ?? "").trim() && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallbackValue;
};

export const getServiceTimeoutMs = (env = process.env) =>
  toPositiveInteger(env.INTERNAL_SERVICE_TIMEOUT_MS, DEFAULT_SERVICE_TIMEOUT_MS);

export const getServiceCooldownMs = (env = process.env) =>
  toPositiveInteger(env.INTERNAL_SERVICE_UNHEALTHY_COOLDOWN_MS, DEFAULT_SERVICE_COOLDOWN_MS);

/**
 * A tier could not answer: no replica configured (SERVICE_NOT_CONFIGURED),
 * none reachable (SERVICE_UNREACHABLE), or every replica tried answered
 * 502/503/504 (SERVICE_UNAVAILABLE, with remoteStatus and remoteBody of the
 * last answer). status is 503. toResponseBody() is safe to send to a client.
 */
export class ServiceUnavailableError extends Error {
  constructor(
    message,
    {
      attempts = 0,
      causeCode = null,
      code = SERVICE_CLIENT_ERROR_CODES.unavailable,
      remoteBody = null,
      remoteStatus = null,
      service,
      status = 503,
    } = {}
  ) {
    super(message);
    this.name = "ServiceUnavailableError";
    this.attempts = attempts;
    this.causeCode = causeCode;
    this.code = code;
    this.remoteBody = remoteBody;
    this.remoteStatus = remoteStatus;
    this.service = service;
    this.status = status;
  }

  toResponseBody() {
    return { code: this.code, error: this.message, service: this.service };
  }
}

/**
 * The call's budget ran out (status 504, SERVICE_TIMEOUT). A timeout does not
 * mark the replica unhealthy: the budget is the caller's, not a verdict on the
 * replica.
 */
export class ServiceTimeoutError extends ServiceUnavailableError {
  constructor(message, options = {}) {
    super(message, { ...options, code: SERVICE_CLIENT_ERROR_CODES.timeout, status: 504 });
    this.name = "ServiceTimeoutError";
  }
}

const findErrorCode = (error) => {
  let current = error;

  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current.code === "string" && current.code) {
      return current.code;
    }

    current = current.cause ?? current.errors?.[0];
  }

  return null;
};

const toHeaderObject = (headers) => Object.fromEntries(headers?.entries?.() ?? []);

const parseJson = (text) => {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const normalizePath = (path) => {
  const text = String(path ?? "");

  if (!text.startsWith("/") || text.startsWith("//") || /[\s\\]/u.test(text)) {
    throw new TypeError("Service request path must be an absolute path such as /chat.");
  }

  return text;
};

const buildBody = (body, headers) => {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return body;
  }

  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  return JSON.stringify(body);
};

// Caller headers minus hop-by-hop headers and anything in the internal
// namespace: the client alone sets identity, deadline, and request id.
const copyCallerHeaders = (headers = {}) => {
  const copied = {};

  for (const [name, value] of Object.entries(headers ?? {})) {
    const lowerName = name.toLowerCase();

    if (
      value === undefined ||
      value === null ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName.startsWith(SERVICE_HEADER_PREFIX)
    ) {
      continue;
    }

    copied[lowerName] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  return copied;
};

const createTimeoutReason = () =>
  new DOMException("The internal service call ran out of time.", "TimeoutError");

// One attempt's signal: the caller's signal plus a timer this module owns, so
// a stream can drop the header timer once headers arrive.
const createAttemptSignal = (callerSignal) => {
  const controller = new AbortController();
  const timers = [];
  let timedOut = false;
  const onCallerAbort = () => controller.abort(callerSignal.reason);

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener?.("abort", onCallerAbort, { once: true });
  }

  return {
    arm(timeoutMs) {
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(createTimeoutReason());
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      timers.push(timer);

      return timer;
    },
    clear(timer) {
      clearTimeout(timer);
    },
    dispose() {
      timers.forEach((timer) => clearTimeout(timer));
      callerSignal?.removeEventListener?.("abort", onCallerAbort);
    },
    get signal() {
      return controller.signal;
    },
    get timedOut() {
      return timedOut;
    },
  };
};

/**
 * Wraps a streamed body so `onDone` runs once when it ends, errors, or is
 * cancelled; the replica counts as busy until then. Callers must read or
 * cancel the body.
 */
const trackStreamBody = (response, onDone) => {
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      onDone();
    }
  };

  if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
    finish();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          finish();
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
  });

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

/**
 * Creates a client for one tier.
 *   audience   the tier's name (SERVICE_TIERS value); the token audience.
 *   urls       replica base URLs (validated like the *_SERVICE_URL lists).
 *   timeoutMs  default budget per call (INTERNAL_SERVICE_TIMEOUT_MS).
 *   issuer     this process's role, the token issuer (ARCHIVE_RAG_ROLE).
 *   cooldownMs how long a failed replica is passed over
 *              (INTERNAL_SERVICE_UNHEALTHY_COOLDOWN_MS).
 *   unavailableStatuses  answers that mean "replica unavailable" (default
 *              502/503/504); a tier whose own 503 carries meaning can narrow it.
 *   fetch, now, env      injectable for tests.
 */
export const createServiceClient = ({
  audience,
  cooldownMs,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  issuer,
  now = Date.now,
  service,
  timeoutMs,
  unavailableStatuses = DEFAULT_UNAVAILABLE_STATUSES,
  urls = [],
} = {}) => {
  const tokenAudience = String(audience ?? "").trim();

  if (!tokenAudience) {
    throw new TypeError("createServiceClient needs the target service audience.");
  }

  const serviceName = String(service ?? tokenAudience);
  const tokenIssuer = String(issuer ?? getServiceRole(env)).trim();
  const defaultTimeoutMs = toPositiveInteger(timeoutMs, getServiceTimeoutMs(env));
  const replicaCooldownMs = toPositiveInteger(cooldownMs, getServiceCooldownMs(env));
  const unavailable = new Set(unavailableStatuses);
  const replicas = [...new Set((urls ?? []).map((url) => normalizeServiceUrl(url)))].map(
    (url, index) => ({
      failures: 0,
      index,
      lastFailureAt: null,
      lastFailureCode: null,
      outstanding: 0,
      requests: 0,
      unhealthyUntil: 0,
      url,
    })
  );
  let rotation = 0;

  const pickReplica = (tried) => {
    const candidates = replicas.filter((replica) => !tried.has(replica));

    if (candidates.length === 0) {
      return null;
    }

    const nowMs = now();
    const healthy = candidates.filter((replica) => replica.unhealthyUntil <= nowMs);
    const pool = healthy.length > 0 ? healthy : candidates;
    const fewest = Math.min(...pool.map((replica) => replica.outstanding));
    const tied = pool.filter((replica) => replica.outstanding === fewest);
    const chosen =
      tied.find((replica) => replica.index >= rotation) ?? tied[0];
    rotation = (chosen.index + 1) % replicas.length;

    return chosen;
  };

  const markFailure = (replica, code) => {
    const nowMs = now();
    replica.failures += 1;
    replica.lastFailureAt = nowMs;
    replica.lastFailureCode = code;
    replica.unhealthyUntil = nowMs + replicaCooldownMs;
  };

  const markSuccess = (replica) => {
    replica.unhealthyUntil = 0;
  };

  const notConfigured = () =>
    new ServiceUnavailableError(`No ${serviceName} service replica is configured.`, {
      code: SERVICE_CLIENT_ERROR_CODES.notConfigured,
      service: serviceName,
    });

  const timeoutError = (attempts, budgetMs) =>
    new ServiceTimeoutError(
      `The ${serviceName} service did not answer within ${budgetMs} ms.`,
      { attempts, service: serviceName }
    );

  const buildHeaders = ({ accessScope, claims, deadlineMs, headers, requestId, system }) => {
    const outbound = copyCallerHeaders(headers);
    const carrier = {};

    propagation.inject(context.active(), carrier);
    Object.assign(outbound, carrier);
    outbound[SERVICE_TOKEN_HEADER] = signServiceToken({
      accessScope: system ? undefined : accessScope,
      audience: tokenAudience,
      claims,
      env,
      issuer: tokenIssuer,
      system,
    });
    outbound[SERVICE_REQUEST_ID_HEADER] = requestId;

    if (deadlineMs !== null) {
      outbound[SERVICE_DEADLINE_HEADER] = String(Math.max(0, Math.floor(deadlineMs)));
    }

    return outbound;
  };

  // Runs attempts until a replica gives a usable answer, then hands the
  // Response to `onResponse` with a `release` that settles the replica's
  // in-flight count. `streaming` keeps the replica busy until the body ends
  // and limits `waitMs` to the wait for headers; `deadlineMs` (streams only)
  // bounds the whole stream.
  const execute = async ({
    accessScope,
    body,
    callerHeaders,
    claims,
    deadlineMs,
    idempotent,
    method,
    onResponse,
    path,
    requestId,
    signal,
    streaming,
    system,
    waitMs,
  }) => {
    if (replicas.length === 0) {
      throw notConfigured();
    }

    const startedAt = now();
    const tried = new Set();
    let lastFailure = null;
    const elapsed = () => now() - startedAt;

    for (;;) {
      const replica = pickReplica(tried);

      if (!replica) {
        break;
      }

      const budgetMs = waitMs - elapsed();

      if (budgetMs <= 0) {
        throw timeoutError(tried.size, waitMs);
      }

      // Built before the replica is marked busy: a signing or body error is
      // the caller's, never the replica's.
      const headers = buildHeaders({
        accessScope,
        claims,
        deadlineMs: streaming ? (deadlineMs === null ? null : deadlineMs - elapsed()) : budgetMs,
        headers: callerHeaders,
        requestId,
        system,
      });
      const outboundBody = buildBody(body, headers);
      const attempt = createAttemptSignal(signal);
      const waitTimer = attempt.arm(budgetMs);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          replica.outstanding -= 1;
          attempt.dispose();
        }
      };

      if (streaming && deadlineMs !== null) {
        attempt.arm(deadlineMs - elapsed());
      }

      tried.add(replica);
      replica.outstanding += 1;
      replica.requests += 1;

      let response;

      try {
        response = await fetchImpl(`${replica.url}${path}`, {
          body: outboundBody,
          headers,
          method,
          redirect: "manual",
          signal: attempt.signal,
        });
      } catch (error) {
        release();

        if (attempt.timedOut) {
          throw timeoutError(tried.size, waitMs);
        }

        if (signal?.aborted) {
          throw signal.reason;
        }

        // fetch reports network failures as TypeError("fetch failed") with a
        // cause; a TypeError without one is a bad request built by the caller.
        if (error instanceof TypeError && error.cause === undefined) {
          throw error;
        }

        const code = findErrorCode(error) ?? "FETCH_FAILED";
        markFailure(replica, code);
        lastFailure = { causeCode: code };

        if (CONNECT_PHASE_CODES.has(code) || idempotent) {
          continue;
        }

        break;
      }

      if (unavailable.has(response.status)) {
        let remoteText = "";

        try {
          remoteText = await response.text();
        } catch {
          remoteText = "";
        }

        release();
        markFailure(replica, `HTTP_${response.status}`);
        lastFailure = { remoteBody: parseJson(remoteText), remoteStatus: response.status };

        if (idempotent) {
          continue;
        }

        break;
      }

      markSuccess(replica);

      if (streaming) {
        attempt.clear(waitTimer);
      }

      try {
        return await onResponse(response, release);
      } catch (error) {
        release();

        if (attempt.timedOut) {
          throw timeoutError(tried.size, waitMs);
        }

        throw error;
      }
    }

    if (lastFailure?.remoteStatus) {
      throw new ServiceUnavailableError(`The ${serviceName} service is unavailable.`, {
        attempts: tried.size,
        remoteBody: lastFailure.remoteBody,
        remoteStatus: lastFailure.remoteStatus,
        service: serviceName,
      });
    }

    throw new ServiceUnavailableError(`The ${serviceName} service is unreachable.`, {
      attempts: tried.size,
      causeCode: lastFailure?.causeCode ?? null,
      code: SERVICE_CLIENT_ERROR_CODES.unreachable,
      service: serviceName,
    });
  };

  const prepare = ({
    accessScope,
    body,
    claims,
    headers,
    idempotent,
    method = "GET",
    path,
    requestId,
    signal,
    system = false,
  }) => {
    const normalizedMethod = String(method).toUpperCase();

    return {
      accessScope,
      body,
      callerHeaders: headers,
      claims,
      idempotent: idempotent ?? IDEMPOTENT_METHODS.has(normalizedMethod),
      method: normalizedMethod,
      path: normalizePath(path),
      requestId: String(requestId ?? "").trim() || crypto.randomUUID(),
      signal,
      system: system === true,
    };
  };

  /**
   * Sends one call and reads the whole answer. Resolves
   * { status, headers, json, text } for every answer the tier gave (json is
   * null when the body is not JSON), including 4xx and 500; rejects with
   * ServiceUnavailableError / ServiceTimeoutError when no replica answered, or
   * with the caller's abort reason. `timeoutMs` bounds the whole call,
   * failovers and body included, and is sent as the remaining budget.
   */
  const request = async (options = {}) => {
    const budgetMs = toPositiveInteger(options.timeoutMs, defaultTimeoutMs);
    const readBody = async (response, release) => {
      try {
        const text = await response.text();

        return {
          headers: toHeaderObject(response.headers),
          json: parseJson(text),
          status: response.status,
          text,
        };
      } finally {
        release();
      }
    };

    return execute({
      ...prepare(options),
      deadlineMs: null,
      onResponse: readBody,
      streaming: false,
      waitMs: budgetMs,
    });
  };

  /**
   * Sends one call and resolves with the tier's Response as soon as its
   * headers arrive, for SSE or chunked pass-through. `timeoutMs` bounds the
   * wait for headers only; `deadlineMs`, when given, bounds the whole stream
   * and is sent as the remaining budget (without it no deadline header is
   * sent). The replica counts as busy until the body is read to the end or
   * cancelled, so callers must do one or the other. A 502/503/504 answer is
   * handled as in request().
   */
  const stream = async (options = {}) => {
    const budgetMs = toPositiveInteger(options.timeoutMs, defaultTimeoutMs);
    const deadlineMs = toPositiveInteger(options.deadlineMs, null);
    return execute({
      ...prepare(options),
      deadlineMs,
      onResponse: async (response, release) => trackStreamBody(response, release),
      streaming: true,
      waitMs: deadlineMs === null ? budgetMs : Math.min(budgetMs, deadlineMs),
    });
  };

  /**
   * Per-replica state for health output: { service, replicas: [{ url,
   * outstanding, healthy, lastFailureAgeMs, lastFailureCode, requests,
   * failures }] }. URLs carry no credentials (refused at creation).
   */
  const snapshot = () => {
    const nowMs = now();

    return {
      replicas: replicas.map((replica) => ({
        failures: replica.failures,
        healthy: replica.unhealthyUntil <= nowMs,
        lastFailureAgeMs:
          replica.lastFailureAt === null ? null : Math.max(0, nowMs - replica.lastFailureAt),
        lastFailureCode: replica.lastFailureCode,
        outstanding: replica.outstanding,
        requests: replica.requests,
        url: replica.url,
      })),
      service: serviceName,
    };
  };

  return { audience: tokenAudience, request, snapshot, stream };
};

/**
 * Receiving side of the trace context: runs the rest of the request inside the
 * context the calling tier injected, so this tier's spans join the caller's
 * trace. Mount after requireServiceIdentity; a no-op until a tracing SDK is
 * registered.
 */
export const bindServiceTraceContext = (req, res, next) =>
  context.with(propagation.extract(context.active(), req.headers ?? {}), next);

const registeredClients = new Map();

/**
 * The process-wide client for a tier (SERVICE_TIERS value), built from its
 * *_SERVICE_URL list, ARCHIVE_RAG_ROLE as issuer, and the INTERNAL_SERVICE_*
 * settings. Rebuilt when the URL list changes. A tier without URLs still gets
 * a client, whose calls fail with SERVICE_NOT_CONFIGURED.
 */
export const getServiceClient = (tier, { env = process.env } = {}) => {
  if (!Object.values(SERVICE_TIERS).includes(tier)) {
    throw new TypeError(`Unknown service tier "${tier}".`);
  }

  const urls = getServiceUrls(tier, env);
  const key = urls.join(",");
  const existing = registeredClients.get(tier);

  if (existing?.key === key) {
    return existing.client;
  }

  const client = createServiceClient({ audience: tier, env, urls });
  registeredClients.set(tier, { client, key });

  return client;
};

/** Snapshots of the clients this process has created, keyed by tier. */
export const describeServiceClients = () =>
  Object.fromEntries(
    [...registeredClients.entries()].map(([tier, { client }]) => [tier, client.snapshot()])
  );

export const resetServiceClients = () => {
  registeredClients.clear();
};
