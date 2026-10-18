import { getModelGatewayQuotaLimits, isModelQuotaEnabled } from "./config.js";
import { getModelGatewayCall, recordModelMetricEvent } from "./model-gateway/call-context.js";
import {
  MODEL_GATEWAY_ERROR_CODES,
  MODEL_GATEWAY_MIRROR_ANNOTATION,
  MODEL_GATEWAY_QUOTAS,
} from "./model-gateway/protocol.js";
import { createWorkspaceModelQuotas, getQuotaTenantKey } from "./model-quotas.js";
import { getActiveDatabaseTenant } from "./postgres-tenant.js";
import { getSharedRedisClient } from "./shared-state.js";
import { recordTenantRefusal } from "./tenant-refusals.js";
import { addActiveSpanEvent } from "./tracing.js";

// In-process per-workspace model quotas (MODEL_QUOTA_ENABLED=true, default
// off): the model gateway's quotas (MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE,
// _TOKENS_PER_MINUTE, _DAILY_TOKENS, and the same engine, rag/model-quotas.js)
// applied to the model calls this process sends itself -- a monolith, or a tier
// that calls models without MODEL_GATEWAY_URL.
//
// Admission: openai.js (completeTextWithMetadata, embedTexts, embedQuery) and
// reranker.js (the cross-encoder call) admit each call once, before it is sent
// and outside its retries and failover, as the gateway admits one request per
// gateway call. The ingest embedding batcher admits each job's embed request
// itself when it merges several tenants' texts into one model call.
//
// Charging: the tokens of every answered model call this process made are
// charged to the tenant it acted for, from the same LLMOps event run usage is
// charged from (recordModelMetricEventWithQuota is the recorder openai.js and
// reranker.js hand their metrics). A merged ingest batch is charged per job's
// tenant by the batcher.
//
// The tenant is the active database tenant (postgres-tenant.js): the request's
// authenticated scope, a background record's own scope, or the starter of a
// shared query-embedding flight (embedding-cache.js). A call without one
// (system, unscoped or unbound) is never limited.
//
// Never here: a call routed to the model gateway (the gateway admits and
// charges it; the caller only keeps a mirror event, which is not charged), and
// a call the gateway itself is serving (getModelGatewayCall): every model call
// is admitted exactly once.
//
// A refusal is the error the gateway client raises for the gateway's own
// quota answer -- status 429, code MODEL_GATEWAY_QUOTA_EXCEEDED, `quota` and
// `retryAfterMs` (the end of the window), `upstreamStatus: null` -- so every
// caller degrades the same way: never retried on the same model or failed over
// (the admission is outside both), not a dependency outage, a staged ingest job
// requeued no earlier than the window ends, a rerank keeping the fused order.

let state = null;
let injectedQuotas = null;

const getState = () => {
  if (injectedQuotas) {
    if (state?.quotas !== injectedQuotas) {
      state = { key: "injected", quotas: injectedQuotas, rejections: {} };
    }

    return state;
  }

  const limits = getModelGatewayQuotaLimits();
  const redis = getSharedRedisClient();
  const key = JSON.stringify([limits.requestsPerMinute, limits.tokensPerMinute, limits.dailyTokens]);

  // Rebuilt when a limit or the shared-state client changes (a test, a
  // reconfiguration); the counters of the old windows go with it.
  if (state?.key !== key || state.redis !== redis) {
    state = { key, quotas: createWorkspaceModelQuotas({ limits, redis }), redis, rejections: {} };
  }

  return state;
};

/** Whether this process enforces quotas for the call about to be made. */
export const isInProcessModelQuotaActive = () => isModelQuotaEnabled() && !getModelGatewayCall();

export const createModelQuotaExceededError = ({ quota, retryAfterMs }) => {
  const error = new Error("The workspace has used its model quota for now.");

  error.name = "ModelQuotaExceededError";
  error.code = MODEL_GATEWAY_ERROR_CODES.quotaExceeded;
  error.status = 429;
  error.quota = quota ?? null;
  error.retryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : null;
  error.upstreamStatus = null;
  error.quotaEnforcedBy = "process";

  return error;
};

const admit = async (tenant) => {
  const current = getState();
  const admission = await current.quotas.admit(tenant);

  if (admission.ok) {
    return;
  }

  current.rejections[admission.quota] = (current.rejections[admission.quota] ?? 0) + 1;
  // Counted for the tenant it acted for (rag/tenant-refusals.js); a call the
  // model gateway refuses is counted there, never here as well.
  recordTenantRefusal(MODEL_GATEWAY_ERROR_CODES.quotaExceeded, tenant);
  // Numbers only: no tenant on a span.
  addActiveSpanEvent("model.quota_rejected", {
    "archive_rag.quota": String(admission.quota),
    "archive_rag.quota.retry_after_ms": Math.round(Number(admission.retryAfterMs) || 0),
  });
  throw createModelQuotaExceededError(admission);
};

/**
 * Admits one model call for `tenant` (default: the active database tenant).
 * Returns null when nothing has to be awaited -- quotas off, inside a gateway
 * request, or no tenant -- so the call path keeps its timing; otherwise a
 * promise that resolves when the call may be sent or rejects with the quota
 * error. Callers skip it for a call routed to the model gateway.
 */
export const admitModelCallQuota = (tenant = getActiveDatabaseTenant()) => {
  if (!isInProcessModelQuotaActive() || !getQuotaTenantKey(tenant)) {
    return null;
  }

  return admit(tenant);
};

/** Charges `tokens` answered for `tenant` (no-op when inactive or without a tenant). */
export const chargeModelCallQuota = (tenant, tokens) => {
  if (!isInProcessModelQuotaActive() || !getQuotaTenantKey(tenant)) {
    return Promise.resolve();
  }

  return getState().quotas.chargeTokens(tenant, tokens);
};

const isMirrorEvent = (event) =>
  Array.isArray(event?.annotations) &&
  event.annotations.some((annotation) => annotation?.id === MODEL_GATEWAY_MIRROR_ANNOTATION.id);

/**
 * The LLMOps recorder of openai.js and reranker.js: charges an answered call's
 * tokens to the active tenant's in-process quota, then records the event
 * exactly as recordModelMetricEvent does (inside a gateway request, the
 * gateway's meter). A gateway mirror event is never charged here.
 */
export const recordModelMetricEventWithQuota = (event) => {
  if (event?.status === "ok" && !isMirrorEvent(event) && isInProcessModelQuotaActive()) {
    const tenant = getActiveDatabaseTenant();

    if (getQuotaTenantKey(tenant)) {
      void getState().quotas.chargeTokens(tenant, event.totalTokens);
    }
  }

  return recordModelMetricEvent(event);
};

/** Configuration and this process's refusals by quota kind; no tenant ids. */
export const describeInProcessModelQuotas = () => {
  const current = getState();

  return {
    ...current.quotas.describe(),
    enabled: isModelQuotaEnabled() && current.quotas.enabled,
    rejections: Object.fromEntries(
      Object.values(MODEL_GATEWAY_QUOTAS).map((quota) => [quota, current.rejections[quota] ?? 0])
    ),
  };
};

/** Tests: use `quotas` (createWorkspaceModelQuotas) instead of the configured one. */
export const configureInProcessModelQuotas = ({ quotas = null } = {}) => {
  injectedQuotas = quotas;
  state = null;
};

export const resetInProcessModelQuotas = () => configureInProcessModelQuotas();
