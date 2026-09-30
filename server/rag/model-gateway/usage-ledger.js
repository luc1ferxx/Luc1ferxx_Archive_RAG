// Per-tenant model usage totals since the gateway process started, for
// GET /usage. One entry per tenant ({ userId, workspaceId }), plus one for
// system calls. Built from the gateway's metered LLMOps events, so it counts
// every upstream attempt, retries and failover included; tokens and cost count
// answered calls only, as run-level usage does. Nothing here holds prompt or
// answer text.

const SYSTEM_KEY = "system";

const normalizeId = (value) => String(value ?? "").trim();

const toTenantKey = (tenant) =>
  tenant ? `${normalizeId(tenant.userId)}\u0000${normalizeId(tenant.workspaceId)}` : SYSTEM_KEY;

const roundCost = (value) => Math.round(value * 1e8) / 1e8;

const createTotals = () => ({
  estimatedCostUsd: 0,
  failedModelCalls: 0,
  inputTokens: 0,
  modelCalls: 0,
  outputTokens: 0,
  totalTokens: 0,
  unpricedModelCalls: 0,
});

const addEvent = (totals, event) => {
  totals.modelCalls += 1;

  if (event.status !== "ok") {
    totals.failedModelCalls += 1;
    return;
  }

  totals.inputTokens += Number.isFinite(event.inputTokens) ? event.inputTokens : 0;
  totals.outputTokens += Number.isFinite(event.outputTokens) ? event.outputTokens : 0;
  totals.totalTokens += Number.isFinite(event.totalTokens) ? event.totalTokens : 0;

  if (Number.isFinite(event.estimatedCostUsd)) {
    totals.estimatedCostUsd = roundCost(totals.estimatedCostUsd + event.estimatedCostUsd);
  } else {
    totals.unpricedModelCalls += 1;
  }
};

export const createModelUsageLedger = ({ now = Date.now } = {}) => {
  const startedAt = now();
  const tenants = new Map();

  const entryFor = (tenant) => {
    const key = toTenantKey(tenant);

    if (!tenants.has(key)) {
      tenants.set(key, {
        byOperation: {},
        rejectedRequests: {},
        requests: 0,
        system: key === SYSTEM_KEY,
        tenant: tenant
          ? { userId: normalizeId(tenant.userId), workspaceId: normalizeId(tenant.workspaceId) }
          : null,
        ...createTotals(),
      });
    }

    return tenants.get(key);
  };

  return {
    /** Counts one gateway request; `rejectedBy` names the quota that refused it. */
    recordRequest(tenant, { rejectedBy = null } = {}) {
      const entry = entryFor(tenant);

      entry.requests += 1;

      if (rejectedBy) {
        entry.rejectedRequests[rejectedBy] = (entry.rejectedRequests[rejectedBy] ?? 0) + 1;
      }
    },

    /** Counts one metered LLMOps event (one upstream model attempt). */
    recordEvent(tenant, event = {}) {
      const entry = entryFor(tenant);
      const operation = String(event.operation ?? "unknown");

      addEvent(entry, event);
      entry.byOperation[operation] ??= createTotals();
      addEvent(entry.byOperation[operation], event);
    },

    snapshot() {
      const entries = [...tenants.values()].map((entry) => ({
        ...entry,
        byOperation: Object.fromEntries(
          Object.entries(entry.byOperation).map(([operation, totals]) => [operation, { ...totals }])
        ),
        rejectedRequests: { ...entry.rejectedRequests },
        tenant: entry.tenant ? { ...entry.tenant } : null,
      }));
      const totals = createTotals();

      for (const entry of entries) {
        for (const field of Object.keys(totals)) {
          totals[field] += entry[field];
        }
      }

      totals.estimatedCostUsd = roundCost(totals.estimatedCostUsd);

      return {
        since: new Date(startedAt).toISOString(),
        tenants: entries,
        totals: { ...totals, requests: entries.reduce((sum, entry) => sum + entry.requests, 0) },
      };
    },
  };
};
