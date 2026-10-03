import { getMetricsRegistry, isMetricsEnabled, pickLabel, secondsSince } from "./metrics.js";

// Asynchronous ingestion (RAG_INGEST_MODE=async):
//   - queue depth by status and the dead-letter count, read on scrape from the
//     job store's countByStatus() (one GROUP BY over the jobs table, every
//     tenant). The answer is cached for QUEUE_CACHE_MS and concurrent scrapes
//     share one read, so a process costs the database at most one such query
//     per 15 s however often it is scraped. Every API process that hosts the
//     queue reports the same totals: aggregate with max(), not sum().
//   - per stage (parse, chunk, embed, index): duration and outcome of each run
//     (the worker wraps its pipeline with instrumentIngestStages).
//   - job attempts by outcome, and failed attempts by the stage they failed in
//     and what became of the job: `retry` (queued again with backoff),
//     `failed`, `dead_letter`, or `lease_lost`.

export const QUEUE_CACHE_MS = 15_000;
export const INGEST_STAGE_NAMES = Object.freeze(["chunk", "embed", "index", "parse"]);
export const INGEST_STAGE_DURATION_BUCKETS = Object.freeze([
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
]);

const JOB_STATUSES = ["dead_letter", "failed", "queued", "running", "succeeded"];
const ATTEMPT_OUTCOMES = new Set(["failed", "lease_lost", "queued", "succeeded", "dead_letter"]);
const STAGE_SET = new Set(INGEST_STAGE_NAMES);
const FAILURE_RESULT_BY_STATUS = Object.freeze({
  dead_letter: "dead_letter",
  failed: "failed",
  queued: "retry",
});

const registry = getMetricsRegistry();

const jobs = registry.gauge({
  help: "Ingest jobs by status over every tenant (cached up to 15 s; every queue host reports the same totals, so aggregate with max).",
  labelNames: ["status"],
  name: "archive_rag_ingest_jobs",
});
const deadLetters = registry.gauge({
  help: "Ingest jobs waiting in dead_letter for an operator's requeue (cached up to 15 s).",
  name: "archive_rag_ingest_dead_letter_jobs",
});
const stageDuration = registry.histogram({
  buckets: INGEST_STAGE_DURATION_BUCKETS,
  help: "Duration of one run of an ingest stage, in seconds.",
  labelNames: ["outcome", "stage"],
  name: "archive_rag_ingest_stage_duration_seconds",
});
const attempts = registry.counter({
  help: "Ingest job attempts this process's worker finished, by outcome.",
  labelNames: ["outcome"],
  name: "archive_rag_ingest_job_attempts_total",
});
const stageFailures = registry.counter({
  help: "Failed ingest attempts by the stage they failed in and what became of the job (retry, failed, dead_letter, lease_lost).",
  labelNames: ["result", "stage"],
  name: "archive_rag_ingest_stage_failures_total",
});

const timeStage = (stage, run) => async (...args) => {
  if (!isMetricsEnabled()) {
    return run(...args);
  }

  const startedAt = performance.now();

  try {
    const result = await run(...args);

    stageDuration.observe({ outcome: "ok", stage }, secondsSince(startedAt));
    return result;
  } catch (error) {
    stageDuration.observe({ outcome: "error", stage }, secondsSince(startedAt));
    throw error;
  }
};

const instrumented = new WeakMap();

/**
 * The staged pipeline with every stage timed (the same object while metrics
 * are off, or for a null pipeline). Wrapped once per pipeline object.
 */
export const instrumentIngestStages = (stages) => {
  if (!isMetricsEnabled() || !stages || typeof stages !== "object") {
    return stages;
  }

  const cached = instrumented.get(stages);

  if (cached) {
    return cached;
  }

  const wrapped = { ...stages };

  for (const stage of INGEST_STAGE_NAMES) {
    if (typeof stages[stage] === "function") {
      wrapped[stage] = timeStage(stage, stages[stage]);
    }
  }

  instrumented.set(stages, wrapped);
  return wrapped;
};

/** Counts the outcome processJob returned for one attempt, and returns it. */
export const recordIngestAttemptOutcome = (outcome) => {
  if (isMetricsEnabled()) {
    attempts.inc({ outcome: pickLabel(outcome, ATTEMPT_OUTCOMES) });
  }

  return outcome;
};

/** A failed attempt: the stage it failed in and the status store.fail() left. */
export const recordIngestStageFailure = (stage, status) => {
  if (!isMetricsEnabled()) {
    return;
  }

  stageFailures.inc({
    result: Object.hasOwn(FAILURE_RESULT_BY_STATUS, String(status)) ? FAILURE_RESULT_BY_STATUS[status] : "lease_lost",
    stage: STAGE_SET.has(stage) ? stage : "other",
  });
};

/**
 * A scrape-time reader of `store.countByStatus()`, at most once per
 * `cacheMs`. Errors keep the previous values (and count as a collector error).
 */
export const createIngestQueueCollector = ({ cacheMs = QUEUE_CACHE_MS, now = Date.now, store }) => {
  let readAt = -Infinity;
  let pending = null;

  const read = async () => {
    const counts = await store.countByStatus();

    for (const status of JOB_STATUSES) {
      jobs.set({ status }, Number(counts?.[status]) || 0);
    }

    deadLetters.set(Number(counts?.dead_letter) || 0);
  };

  return async () => {
    if (now() - readAt < cacheMs) {
      return;
    }

    // A failed read waits out the window too, so a database in trouble gets
    // no more of these queries than a healthy one.
    pending ??= read().finally(() => {
      readAt = now();
      pending = null;
    });

    await pending;
  };
};

/** Reports `store`'s queue on this process's /metrics. */
export const registerIngestQueueMetrics = (store, options = {}) => {
  if (typeof store?.countByStatus !== "function") {
    return false;
  }

  registry.addCollector("ingest_queue", createIngestQueueCollector({ ...options, store }));
  return true;
};
