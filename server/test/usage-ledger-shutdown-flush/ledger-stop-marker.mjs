// Preload (node --import) for test/usage-ledger-shutdown-flush.test.mjs: makes
// the process's tenant usage ledger a recorder that prints LEDGER_STOPPED when
// it is stopped, so the test can see that a command wrote its usage before it
// ended. It loads before the command's own modules, so they share this module
// instance of rag/tenant-usage.js.
import { configureTenantUsageLedger } from "../../rag/tenant-usage.js";

configureTenantUsageLedger({
  countPending: () => 0,
  erasePending: async () => 0,
  flush: async () => ({ rows: 0 }),
  record: () => false,
  snapshot: () => ({ active: false }),
  stop: async () => {
    process.stdout.write("LEDGER_STOPPED\n");
  },
});
