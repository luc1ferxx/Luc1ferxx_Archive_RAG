import {
  CIRCUIT_OPEN_CODE,
  getModelCallGuardSnapshot,
  guardModelCall,
  isUnavailableError,
} from "../model-call-guard.js";
import { getLlmCircuitCooldownMs } from "../config.js";
import { normalizeServiceUrl } from "../service-topology.js";

// Upstream replicas of one model backend (chat, embeddings or rerank) behind
// the gateway, so inference scales by adding replicas.
//
// Every request to a replica passes the model-call guard under the replica's
// own key, `${url}|${model}` (the key the single-endpoint path has always
// used), so each replica has its own concurrency cap and circuit breaker, in
// Redis when shared state is on. The pool only chooses:
//   - replicas whose circuit rejected a request or that just failed with an
//     unavailable error are passed over for a short cooldown, while a healthy
//     one exists;
//   - among the rest, the one with the fewest requests in flight; ties rotate.
// A request that was never sent -- the replica's circuit is open, or the
// connection was refused -- moves to the next replica at once. Any other
// failure goes back to the caller's retry loop (openai.js withRetry), whose
// next attempt then lands on another replica; the pool never adds retries of
// its own.

const CONNECT_PHASE_CODES = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
// How long a replica that failed one request is passed over. Short: the
// breaker, not the pool, decides when a replica is down.
export const UPSTREAM_FAILURE_COOLDOWN_MS = 2000;

const findCode = (error) => {
  let current = error;

  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === "string" && current.code) {
      return current.code.toUpperCase();
    }

    current = current.cause;
  }

  return "";
};

/**
 * Parses a comma-separated replica list with the same rules as the service
 * URLs (http/https, no credentials, query or fragment; duplicates dropped).
 * Throws naming `variable`, never the value.
 */
export const parseUpstreamUrls = (rawValue, { variable = "upstream URL" } = {}) => {
  const urls = [];

  for (const entry of String(rawValue ?? "").split(",")) {
    if (!entry.trim()) {
      continue;
    }

    const url = normalizeServiceUrl(entry, { variable });

    if (!urls.includes(url)) {
      urls.push(url);
    }
  }

  return urls;
};

export const createUpstreamPool = ({
  cooldownMs = UPSTREAM_FAILURE_COOLDOWN_MS,
  kind,
  now = Date.now,
  urls = [],
} = {}) => {
  const replicas = urls.map((url, index) => ({
    failures: 0,
    index,
    lastFailureAt: null,
    lastFailureCode: null,
    models: new Set(),
    outstanding: 0,
    requests: 0,
    unhealthyUntil: 0,
    url,
  }));
  let rotation = 0;

  const pick = (tried) => {
    const candidates = replicas.filter((replica) => !tried.has(replica));

    if (candidates.length === 0) {
      return null;
    }

    const nowMs = now();
    const healthy = candidates.filter((replica) => replica.unhealthyUntil <= nowMs);
    const pool = healthy.length > 0 ? healthy : candidates;
    const fewest = Math.min(...pool.map((replica) => replica.outstanding));
    const tied = pool.filter((replica) => replica.outstanding === fewest);
    const chosen = tied.find((replica) => replica.index >= rotation) ?? tied[0];

    rotation = (chosen.index + 1) % replicas.length;

    return chosen;
  };

  const markFailure = (replica, code, forMs) => {
    const nowMs = now();

    replica.failures += 1;
    replica.lastFailureAt = nowMs;
    replica.lastFailureCode = code;
    replica.unhealthyUntil = nowMs + forMs;
  };

  /**
   * Sends one request: `send(baseUrl)` performs it against the chosen replica.
   * Resolves with its result or rejects with the last error.
   */
  const run = async ({ model = "", send }) => {
    if (replicas.length === 0) {
      const error = new Error(`No ${kind} backend is configured for the model gateway.`);

      error.code = "MODEL_GATEWAY_BACKEND_NOT_CONFIGURED";
      error.gatewayError = { code: error.code, status: 503 };
      throw error;
    }

    const tried = new Set();
    let lastError = null;

    for (;;) {
      const replica = pick(tried);

      if (!replica) {
        break;
      }

      tried.add(replica);
      replica.models.add(model);
      replica.outstanding += 1;
      replica.requests += 1;

      try {
        const result = await guardModelCall(`${replica.url}|${model}`, () => send(replica.url));

        replica.unhealthyUntil = 0;
        return result;
      } catch (error) {
        lastError = error;
        const code = findCode(error);

        if (code === CIRCUIT_OPEN_CODE) {
          // Nothing was sent; the circuit stays open for its cooldown.
          markFailure(replica, code, getLlmCircuitCooldownMs());
          continue;
        }

        if (isUnavailableError(error)) {
          markFailure(replica, code || `HTTP_${error?.status ?? "ERROR"}`, cooldownMs);

          if (CONNECT_PHASE_CODES.has(code)) {
            continue;
          }
        }

        throw error;
      } finally {
        replica.outstanding -= 1;
      }
    }

    throw lastError;
  };

  /** Secret-free replica state, with each replica's guard state per model. */
  const describe = () => {
    const nowMs = now();

    return {
      kind,
      replicas: replicas.map((replica) => ({
        failures: replica.failures,
        guards: Object.fromEntries(
          [...replica.models].map((model) => [
            model || "default",
            getModelCallGuardSnapshot(`${replica.url}|${model}`),
          ])
        ),
        healthy: replica.unhealthyUntil <= nowMs,
        lastFailureAgeMs:
          replica.lastFailureAt === null ? null : Math.max(0, nowMs - replica.lastFailureAt),
        lastFailureCode: replica.lastFailureCode,
        outstanding: replica.outstanding,
        requests: replica.requests,
        url: replica.url,
      })),
    };
  };

  return { describe, kind, run, size: replicas.length };
};
