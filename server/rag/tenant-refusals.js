import { recordTenantRefusalMetric } from "./metrics-tenant.js";
import { toDatabaseTenant } from "./postgres-tenant.js";
import { getTenantUsageLedger } from "./tenant-usage.js";

export {
  isTenantRefusalReason,
  TENANT_REFUSAL_REASON_LIST,
  TENANT_REFUSAL_REASONS,
} from "./tenant-refusal-reasons.js";

// The one hook every per-tenant refusal calls, right where it refuses (the
// codes and their sites: rag/tenant-refusal-reasons.js). It feeds two places
// that answer different questions:
//
//   - archive_rag_tenant_refusals_total{reason} (rag/metrics-tenant.js): how
//     often each kind of refusal happens, for dashboards and the
//     ArchiveRagTenantRefusalsSustained alert. No tenant label, ever. With
//     METRICS_ENABLED off this part is one boolean check.
//   - the usage ledger (rag/tenant-usage.js): one refused_<reason> count per
//     tenant and hour, so an operator can see which tenant is being refused
//     (GET /admin/usage?metric=refusals). Inert without a database or with
//     TENANT_USAGE_LEDGER=off, like the rest of the ledger.
//
// `scope` is whom the refusal was decided for: an access scope or a
// { userId, workspaceId } tenant, read the way the database tenant binding
// reads it (toDatabaseTenant), so a refusal lands on the same ledger pair as
// that tenant's other usage; null or a scope naming neither is ('', ''). A
// refusal keyed by client IP (the per-tenant limits for a scope naming
// neither) is recorded there too: an address is not a tenant. Recording never
// throws, so it can never turn a refusal into a different error.
export const recordTenantRefusal = (reason, scope = null, { ledger = null } = {}) => {
  try {
    recordTenantRefusalMetric(reason);
  } catch {
    // A metric must not change the refusal.
  }

  try {
    (ledger ?? getTenantUsageLedger()).recordRefusal?.(toDatabaseTenant(scope ?? {}), reason);
  } catch {
    // Nor the ledger.
  }
};
