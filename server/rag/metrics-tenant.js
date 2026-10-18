import { getMetricsRegistry, isMetricsEnabled, pickLabel } from "./metrics.js";
import { TENANT_REFUSAL_REASON_SET } from "./tenant-refusal-reasons.js";

// Per-tenant refusals (rag/tenant-refusals.js recordTenantRefusal): every
// request or call a per-tenant limit, quota or registry check refused, by
// its stable code. `reason` is the only label: a series never names a tenant
// (the registry refuses such labels), so which tenant was refused is in the
// usage ledger's refusal counts (GET /admin/usage?metric=refusals), not here.
// A code outside rag/tenant-refusal-reasons.js counts as "other".

const registry = getMetricsRegistry();

const refusals = registry.counter({
  help: "Requests and calls refused by a per-tenant limit, quota or registry check, by stable reason code; which tenant is in GET /admin/usage?metric=refusals.",
  labelNames: ["reason"],
  name: "archive_rag_tenant_refusals_total",
});

/** One refusal with `reason` (a TENANT_REFUSAL_REASONS code). */
export const recordTenantRefusalMetric = (reason) => {
  if (!isMetricsEnabled()) {
    return;
  }

  refusals.inc({ reason: pickLabel(reason, TENANT_REFUSAL_REASON_SET) });
};
