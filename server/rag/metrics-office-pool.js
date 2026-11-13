import { getMetricsRegistry } from "./metrics.js";
import { getOfficeParsePoolSnapshot } from "./office-parse-pool.js";

// The Office parse worker pool (RAG_OFFICE_PARSE_WORKERS, rag/office-parse-
// pool.js), read from its snapshot on scrape: workers busy and idle, documents
// waiting for a worker, and the process's totals of tasks by outcome (`failed`
// includes a refused document) and of workers lost to a crash, an exit,
// running out of memory or RAG_OFFICE_PARSE_TIMEOUT_MS. A process that never
// parsed an Office file on a worker reports size 0 and zeros; reading the
// snapshot never starts the pool.

const registry = getMetricsRegistry();

const poolSize = registry.gauge({
  help: "Configured size of the Office parse worker pool (0 until the first Office file parsed on a worker).",
  name: "archive_rag_office_parse_pool_size",
});
const workers = registry.gauge({
  help: "Office parse workers by state: busy (parsing a document) or idle.",
  labelNames: ["state"],
  name: "archive_rag_office_parse_workers",
});
const queued = registry.gauge({
  help: "Office documents waiting for a parse worker.",
  name: "archive_rag_office_parse_queued_tasks",
});
const tasks = registry.counter({
  help: "Office documents the parse workers finished, by outcome (failed includes a refused document).",
  labelNames: ["outcome"],
  name: "archive_rag_office_parse_tasks_total",
});
const restarts = registry.counter({
  help: "Office parse workers lost to a crash, an exit, running out of memory or RAG_OFFICE_PARSE_TIMEOUT_MS, replaced on the next task.",
  name: "archive_rag_office_parse_worker_restarts_total",
});

export const collectOfficeParsePool = () => {
  const snapshot = getOfficeParsePoolSnapshot();

  poolSize.set(snapshot.size);
  workers.set({ state: "busy" }, snapshot.busy);
  workers.set({ state: "idle" }, snapshot.idle);
  queued.set(snapshot.queued);
  tasks.setTotal({ outcome: "ok" }, snapshot.completedTasks);
  tasks.setTotal({ outcome: "failed" }, snapshot.failedTasks);
  restarts.setTotal(snapshot.restartedWorkers);
};

registry.addCollector("office_parse_pool", collectOfficeParsePool);
