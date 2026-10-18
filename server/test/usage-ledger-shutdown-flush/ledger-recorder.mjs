// Preload (node --import) for test/usage-ledger-shutdown-flush.test.mjs: makes
// the process's tenant usage ledger a real ledger (rag/tenant-usage.js) as if
// a database were configured, whose writes print LEDGER_ROWS <rows> to stderr
// instead of reaching PostgreSQL, and books one model call's tokens, as an
// archive_ask would (rag/llmops-metrics.js). The flush timer never fires, so
// the rows appear only if the process stops the ledger on its way out. It
// loads before the entry point's own modules, so they share this module
// instance.
import {
  configureTenantUsageLedger,
  createTenantUsageLedger,
  recordTenantUsage,
  TENANT_USAGE_METRICS,
} from "../../rag/tenant-usage.js";

configureTenantUsageLedger(
  createTenantUsageLedger({
    isDatabaseConfigured: () => true,
    isEnabled: () => true,
    query: async (text, values) => {
      const rows = values[0].map((workspaceId, index) => ({
        metric: values[2][index],
        userId: values[1][index],
        value: Number(values[4][index]),
        workspaceId,
      }));

      process.stderr.write(`LEDGER_ROWS ${JSON.stringify(rows)}\n`);
      return { rows: [] };
    },
    runAsSystem: (callback) => callback(),
    setTimer: () => null,
  })
);

recordTenantUsage({ userId: "alice", workspaceId: "ws-a" }, { [TENANT_USAGE_METRICS.modelTokens]: 42 });
