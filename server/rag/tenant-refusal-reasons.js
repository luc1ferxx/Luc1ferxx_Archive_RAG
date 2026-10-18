// The stable codes of every per-tenant refusal (rag/tenant-refusals.js counts
// them), in one module without imports so the metric family, the usage
// ledger and the call sites can all read it without an import cycle. Each
// code is the one its refusal already answers with; test/tenant-refusals
// .test.mjs pins every entry to the constant of the module that raises it.
//
//   TENANT_RATE_LIMITED, TENANT_CONCURRENCY_LIMITED   rag/tenant-limits.js
//   WORKSPACE_MEMBERSHIP_REQUIRED, WORKSPACE_SUSPENDED, WORKSPACE_DELETING,
//   WORKSPACE_NOT_REGISTERED, WORKSPACE_ROLES_LIMIT_EXCEEDED,
//   TENANT_REGISTRY_UNAVAILABLE      requireApiAuth under TENANT_MEMBERSHIP=
//                                    enforce (rag/tenant-registry.js)
//   TENANT_STORAGE_QUOTA_EXCEEDED    rag/tenant-storage-quota.js
//   MODEL_GATEWAY_QUOTA_EXCEEDED     rag/model-call-quota.js (in process) and
//                                    the model gateway (model-gateway/app.js)
//   MODEL_CALL_QUEUE_FULL            rag/model-call-guard.js
//   TENANT_TASK_LIMITED              rag/agent-tasks.js (rag/job-orchestrator.js)
//   UPLOAD_SESSION_LIMIT_EXCEEDED    upload-session-store.js
//   INGEST_PENDING_LIMIT_EXCEEDED,
//   INGEST_WORKSPACE_PENDING_LIMIT_EXCEEDED   rag/ingest-job-store.js
//
// A new per-tenant refusal adds its code here, or it is counted as "other".

export const TENANT_REFUSAL_REASONS = Object.freeze({
  concurrencyLimited: "TENANT_CONCURRENCY_LIMITED",
  ingestPendingLimit: "INGEST_PENDING_LIMIT_EXCEEDED",
  ingestWorkspacePendingLimit: "INGEST_WORKSPACE_PENDING_LIMIT_EXCEEDED",
  membershipRequired: "WORKSPACE_MEMBERSHIP_REQUIRED",
  modelCallQueueFull: "MODEL_CALL_QUEUE_FULL",
  modelQuotaExceeded: "MODEL_GATEWAY_QUOTA_EXCEEDED",
  rateLimited: "TENANT_RATE_LIMITED",
  registryUnavailable: "TENANT_REGISTRY_UNAVAILABLE",
  storageQuotaExceeded: "TENANT_STORAGE_QUOTA_EXCEEDED",
  taskLimited: "TENANT_TASK_LIMITED",
  uploadSessionLimit: "UPLOAD_SESSION_LIMIT_EXCEEDED",
  workspaceDeleting: "WORKSPACE_DELETING",
  workspaceNotRegistered: "WORKSPACE_NOT_REGISTERED",
  workspaceRolesLimit: "WORKSPACE_ROLES_LIMIT_EXCEEDED",
  workspaceSuspended: "WORKSPACE_SUSPENDED",
});

export const TENANT_REFUSAL_REASON_LIST = Object.freeze(
  [...new Set(Object.values(TENANT_REFUSAL_REASONS))].sort()
);

export const TENANT_REFUSAL_REASON_SET = new Set(TENANT_REFUSAL_REASON_LIST);

export const isTenantRefusalReason = (reason) => TENANT_REFUSAL_REASON_SET.has(String(reason ?? ""));

// The usage ledger (migration 037) keeps each reason as a metric of its own,
// `refused_<code in lower case>`, which its metric check
// (^[a-z][a-z0-9_]{0,63}$) admits.
const LEDGER_METRIC_PREFIX = "refused_";

const LEDGER_METRIC_BY_REASON = new Map(
  TENANT_REFUSAL_REASON_LIST.map((reason) => [reason, `${LEDGER_METRIC_PREFIX}${reason.toLowerCase()}`])
);
const REASON_BY_LEDGER_METRIC = new Map([...LEDGER_METRIC_BY_REASON].map(([reason, metric]) => [metric, reason]));

export const TENANT_REFUSAL_LEDGER_METRICS = Object.freeze([...LEDGER_METRIC_BY_REASON.values()]);

/** The ledger metric of a known reason, or null. */
export const toTenantRefusalLedgerMetric = (reason) => LEDGER_METRIC_BY_REASON.get(String(reason ?? "")) ?? null;

/** The reason a ledger metric counts, or null for any other metric. */
export const fromTenantRefusalLedgerMetric = (metric) => REASON_BY_LEDGER_METRIC.get(String(metric ?? "")) ?? null;
