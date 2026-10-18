import { getModelGatewayQuotaLimits } from "../config.js";
import { createWorkspaceModelQuotas, getQuotaTenantKey } from "../model-quotas.js";
import { getSharedRedisClient } from "../shared-state.js";

// Per-workspace quotas at the model gateway: requests per minute, tokens per
// minute, and tokens per UTC day (MODEL_GATEWAY_QUOTA_*), each off at 0, the
// default. The engine -- fixed windows, local counters, the Redis Lua scripts
// with RAG_SHARED_STATE=redis, the per-process fallback -- is rag/model-quotas.js,
// which the in-process enforcer (rag/model-call-quota.js, MODEL_QUOTA_ENABLED)
// shares. The gateway admits every request it serves (app.js `serve`) and
// charges every answered model attempt's tokens (its call `meter`).

export { getQuotaTenantKey };

export const createModelGatewayQuotas = ({
  limits = getModelGatewayQuotaLimits(),
  now = Date.now,
  redis = getSharedRedisClient(),
} = {}) => createWorkspaceModelQuotas({ limits, now, redis });
