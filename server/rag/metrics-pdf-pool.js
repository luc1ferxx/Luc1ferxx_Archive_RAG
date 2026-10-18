import { getMetricsRegistry } from "./metrics.js";
import { getPdfParsePoolSnapshot } from "./pdf-parse-pool.js";

// The pdf.js worker pool (PDF_PARSE_WORKERS > 0, rag/pdf-parse-pool.js), read
// from its snapshot on scrape: workers busy and idle, page-range tasks waiting
// for a worker, and the process's totals of tasks by outcome (`failed`
// includes a PDF that does not parse) and of workers lost to a crash, an exit
// or PDF_PARSE_TIMEOUT_MS. A process that never parses with workers reports
// size 0 and zeros; reading the snapshot never starts the pool.

const registry = getMetricsRegistry();

const poolSize = registry.gauge({
  help: "Configured size of the pdf.js worker pool (0 until the first task with PDF_PARSE_WORKERS > 0).",
  name: "archive_rag_pdf_parse_pool_size",
});
const workers = registry.gauge({
  help: "pdf.js parse workers by state: busy (running a page range) or idle.",
  labelNames: ["state"],
  name: "archive_rag_pdf_parse_workers",
});
const queued = registry.gauge({
  help: "Page-range parse tasks waiting for a pdf.js worker.",
  name: "archive_rag_pdf_parse_queued_tasks",
});
const tasks = registry.counter({
  help: "Page-range parse tasks the pdf.js workers finished, by outcome (failed includes a PDF that does not parse).",
  labelNames: ["outcome"],
  name: "archive_rag_pdf_parse_tasks_total",
});
const restarts = registry.counter({
  help: "pdf.js parse workers lost to a crash, an exit or PDF_PARSE_TIMEOUT_MS and replaced on the next task.",
  name: "archive_rag_pdf_parse_worker_restarts_total",
});

export const collectPdfParsePool = () => {
  const snapshot = getPdfParsePoolSnapshot();

  poolSize.set(snapshot.size);
  workers.set({ state: "busy" }, snapshot.busy);
  workers.set({ state: "idle" }, snapshot.idle);
  queued.set(snapshot.queued);
  tasks.setTotal({ outcome: "ok" }, snapshot.completedTasks);
  tasks.setTotal({ outcome: "failed" }, snapshot.failedTasks);
  restarts.setTotal(snapshot.restartedWorkers);
};

registry.addCollector("pdf_parse_pool", collectPdfParsePool);
