import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getRagIngestJobLeaseMs,
  getRagIngestJobRetentionMs,
  getRagIngestWorkerConcurrency,
  isRagIngestAsync,
} from "./config.js";
import { toIngestJobErrorMessage } from "./ingest-job-store.js";
import { runWithDatabaseTenant } from "./postgres-tenant.js";

// The worker side of RAG_INGEST_MODE=async. Each loop claims one job at a time
// from the store (as the owner role, because the queue holds every tenant's
// jobs), then ingests it under the job's own tenant with the same
// ragService.ingestDocument call the synchronous upload route makes. The store
// fences every write after the claim, so a worker that stalled past its lease
// can finish its work but cannot record it over the attempt that replaced it.

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;
const DEFAULT_HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 5000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
const SETTLE_ATTEMPTS = 3;
const SETTLE_RETRY_DELAY_MS = 250;

// Attempt files live in their own subdirectory of the temp directory (the
// uploads volume in the image), so a sweep can remove what crashed attempts
// left behind without touching anything else.
export const INGEST_TEMP_SUBDIRECTORY = "ingest-tmp";

export const getIngestRetryDelayMs = (attemptCount) =>
  Math.min(
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, Number(attemptCount) - 1),
    RETRY_MAX_DELAY_MS
  );

// 4xx statuses that still say "try again later": the same set rag/openai.js
// retries (a timed-out request, a conflict, a rate limit), plus 425.
const TRANSIENT_CLIENT_STATUSES = new Set([408, 409, 425, 429]);

// Any other 4xx says the upload itself is the problem (no extractable text, an
// unreadable PDF): another attempt would read the same bytes and fail the same
// way, so the job fails at once instead of spending its retries. A rate limit
// from the embedding provider that outlasted the model client's own retries is
// exactly what the queue's backoff is for.
export const isRetryableIngestError = (error) => {
  if (typeof error?.retryable === "boolean") {
    return error.retryable;
  }

  const status = Number(error?.status);

  if (TRANSIENT_CLIENT_STATUSES.has(status)) {
    return true;
  }

  return !(Number.isInteger(status) && status >= 400 && status < 500);
};

// The backoff, but never shorter than a Retry-After the provider sent.
const resolveRetryDelayMs = (retryDelayMs, job, error) => {
  const delayMs = Number(retryDelayMs(job.attemptCount)) || 0;
  const retryAfterMs = Number(error?.retryAfterMs);

  return Number.isFinite(retryAfterMs) && retryAfterMs > delayMs ? retryAfterMs : delayMs;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Recording an outcome is retried a few times: one database blip would
// otherwise leave the job to its lease and cost it an attempt.
const settleWithRetries = async (operation, { retryDelayMs = SETTLE_RETRY_DELAY_MS } = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= SETTLE_ATTEMPTS) {
        throw error;
      }

      await delay(retryDelayMs * attempt);
    }
  }
};

/**
 * Removes attempt files whose last touch is older than `olderThanMs`. A live
 * attempt touches its file at every lease renewal, so a file older than the
 * lease belongs to an attempt that lost its lease or to a process that died.
 */
export const sweepIngestTempFiles = async ({ directory, olderThanMs, now = Date.now() }) => {
  let entries;

  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }

    throw error;
  }

  let removed = 0;

  for (const entry of entries) {
    const filePath = path.join(directory, entry);

    try {
      const fileStat = await stat(filePath);

      if (fileStat.isFile() && now - fileStat.mtimeMs > olderThanMs) {
        await rm(filePath, { force: true });
        removed += 1;
      }
    } catch {
      // Removed by another worker in the meantime.
    }
  }

  return removed;
};

// Unique per worker instance, not per process: the fence relies on no two
// claims ever carrying the same (claimed_by, attempt_count).
export const createIngestWorkerId = () =>
  `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export const createIngestWorker = ({
  concurrency = getRagIngestWorkerConcurrency(),
  finishedJobRetentionMs = getRagIngestJobRetentionMs(),
  housekeepingIntervalMs = DEFAULT_HOUSEKEEPING_INTERVAL_MS,
  leaseMs = getRagIngestJobLeaseMs(),
  logger = console,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ragService,
  renewIntervalMs = null,
  retryDelayMs = getIngestRetryDelayMs,
  settleRetryDelayMs = SETTLE_RETRY_DELAY_MS,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  store,
  tempDirectory = os.tmpdir(),
  workerId = createIngestWorkerId(),
} = {}) => {
  if (!store || typeof store.claim !== "function") {
    throw new Error("createIngestWorker requires an ingest job store.");
  }

  if (typeof ragService?.ingestDocument !== "function") {
    throw new Error("createIngestWorker requires ragService.ingestDocument.");
  }

  const inFlight = new Map();
  const wakeSleepers = new Set();
  const attemptDirectory = path.join(tempDirectory, INGEST_TEMP_SUBDIRECTORY);
  let loops = [];
  let running = false;
  // A job whose previous attempt died holding it (its lease expired) may be
  // what killed that process. It runs alone: the loops claim nothing else
  // until it settles, and it starts once the jobs already running settled,
  // so a crash it causes costs no other job an attempt.
  let exclusiveRun = null;
  let lastHousekeepingAt = null;

  const sleep = (ms) =>
    new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakeSleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);

      wakeSleepers.add(wake);
    });

  // A retried attempt may follow one that committed the document and stopped
  // before recording success. The document row and its chunks commit together
  // (pgvector) or the row is written last (local index), so a stored row means
  // the earlier attempt finished; ingesting again would only pay for the
  // embeddings twice. Every job carries a fresh docId, so on a first attempt
  // this finds nothing. The answer comes from the store (resyncDocument), never
  // from this process's map alone: the map is written inside the ingest
  // transaction, so an attempt whose COMMIT failed while the database was
  // unreachable can leave an entry the database never received.
  const findCommittedDocument = async (job) => {
    const scope = {
      userId: job.ownerUserId,
      workspaceId: job.workspaceId,
    };

    if (typeof ragService.resyncDocument === "function") {
      await ragService.resyncDocument(job.docId);
    } else {
      await ragService.loadDocumentsFromStore?.([job.docId]);
    }

    return ragService.getDocument?.(job.docId, scope) ?? null;
  };

  const writeAttemptFile = async (job, fence, tempFilePath) => {
    if (typeof store.copyJobFile === "function") {
      return store.copyJobFile({ ...fence, filePath: tempFilePath });
    }

    if (!job.fileBytes) {
      return false;
    }

    await writeFile(tempFilePath, job.fileBytes);
    return true;
  };

  const ingestJob = async (job, fence, tempFilePath) => {
    if (await findCommittedDocument(job)) {
      return;
    }

    try {
      await mkdir(attemptDirectory, { recursive: true });

      if (!(await writeAttemptFile(job, fence, tempFilePath))) {
        const error = new Error("The ingest job no longer holds its file.");

        error.retryable = false;
        throw error;
      }

      await ragService.ingestDocument({
        docId: job.docId,
        filePath: tempFilePath,
        fileName: job.fileName,
        ownerUserId: job.ownerUserId,
        workspaceId: job.workspaceId,
      });
    } finally {
      await rm(tempFilePath, { force: true }).catch(() => {});
    }
  };

  const processJob = async (job, { waitFor = [] } = {}) => {
    const fence = {
      attemptCount: job.attemptCount,
      jobId: job.jobId,
      workerId,
    };
    const tempFilePath = path.join(
      attemptDirectory,
      `ingest-${job.jobId}-${job.attemptCount}-${randomUUID()}.pdf`
    );
    let leaseLost = false;
    const renewTimer = setInterval(() => {
      // The attempt file's mtime tracks the lease, for sweepIngestTempFiles.
      const touchedAt = new Date();

      utimes(tempFilePath, touchedAt, touchedAt).catch(() => {});
      store.renew({ ...fence, leaseMs }).then(
        (renewed) => {
          if (!renewed && !leaseLost) {
            leaseLost = true;
            logger.warn?.(
              `[ingest-worker] job ${job.jobId} attempt ${job.attemptCount} lost its lease; another attempt owns it now.`
            );
          }
        },
        (error) => logger.error?.(`[ingest-worker] failed to renew the lease of job ${job.jobId}.`, error)
      );
    }, renewIntervalMs ?? Math.max(250, Math.floor(leaseMs / 3)));

    renewTimer.unref?.();

    let ingestError = null;

    try {
      await Promise.allSettled(waitFor);
      await runWithDatabaseTenant(
        {
          userId: job.ownerUserId,
          workspaceId: job.workspaceId,
        },
        () => ingestJob(job, fence, tempFilePath)
      );
    } catch (error) {
      ingestError = error;
    } finally {
      clearInterval(renewTimer);
    }

    const settleOptions = { retryDelayMs: settleRetryDelayMs };

    if (!ingestError) {
      return (await settleWithRetries(() => store.succeed(fence), settleOptions))
        ? "succeeded"
        : "lease_lost";
    }

    const status = await settleWithRetries(
      () =>
        store.fail({
          ...fence,
          error: toIngestJobErrorMessage(ingestError),
          retryDelayMs: resolveRetryDelayMs(retryDelayMs, job, ingestError),
          retryable: isRetryableIngestError(ingestError),
        }),
      settleOptions
    );

    logger.error?.(
      `[ingest-worker] job ${job.jobId} attempt ${job.attemptCount} failed (${status ?? "lease lost"}).`,
      ingestError
    );
    return status ?? "lease_lost";
  };

  /**
   * Claims and processes at most one job. Resolves to null when nothing was
   * claimable, otherwise to { jobId, outcome } where outcome is succeeded,
   * queued (retry scheduled), failed, or lease_lost.
   */
  const runOnce = async () => {
    const job = await store.claim({ leaseMs, workerId });

    if (!job) {
      return null;
    }

    let promise;

    if (job.recoveredFromExpiredLease) {
      logger.warn?.(
        `[ingest-worker] job ${job.jobId} attempt ${job.attemptCount} follows an attempt that died holding it; running it alone.`
      );
      promise = processJob(job, {
        waitFor: [...inFlight.values()].map((entry) => entry.promise),
      });

      const run = promise.catch(() => {});

      exclusiveRun = run;
      run.then(() => {
        if (exclusiveRun === run) {
          exclusiveRun = null;
        }
      });
    } else {
      // Claimed by another loop while a suspect job was being claimed: it
      // waits for the suspect instead of running beside it.
      promise = processJob(job, { waitFor: exclusiveRun ? [exclusiveRun] : [] });
    }

    inFlight.set(job.jobId, { job, promise });

    try {
      return { jobId: job.jobId, outcome: await promise };
    } finally {
      inFlight.delete(job.jobId);
    }
  };

  /**
   * Deletes finished jobs past their retention and attempt files that no live
   * attempt touches. Runs when the worker starts and then at most once per
   * housekeepingIntervalMs, from a loop that found nothing to claim.
   */
  const runHousekeeping = async () => {
    lastHousekeepingAt = Date.now();

    try {
      if (finishedJobRetentionMs > 0 && typeof store.pruneFinished === "function") {
        await store.pruneFinished({ olderThanMs: finishedJobRetentionMs });
      }

      await sweepIngestTempFiles({ directory: attemptDirectory, olderThanMs: leaseMs * 2 });
    } catch (error) {
      logger.error?.("[ingest-worker] housekeeping failed.", error);
    }
  };

  const loop = async () => {
    while (running) {
      if (exclusiveRun) {
        await exclusiveRun;
        continue;
      }

      let result = null;

      try {
        result = await runOnce();
      } catch (error) {
        logger.error?.("[ingest-worker] claiming or recording a job failed.", error);
      }

      if (!result && running) {
        if (Date.now() - lastHousekeepingAt >= housekeepingIntervalMs) {
          await runHousekeeping();
        }

        await sleep(pollIntervalMs);
      }
    }
  };

  const start = () => {
    if (running) {
      return;
    }

    running = true;
    lastHousekeepingAt = Date.now();
    void runHousekeeping();
    loops = Array.from({ length: Math.max(1, Math.floor(concurrency)) }, () => loop());
  };

  /**
   * Stops claiming, waits up to shutdownGraceMs for running jobs, and hands
   * the ones still running back to the queue so another worker starts them at
   * once instead of waiting out the lease.
   */
  const stop = async () => {
    if (!running) {
      return;
    }

    running = false;

    for (const wake of [...wakeSleepers]) {
      wake();
    }

    let graceTimer = null;
    const finished = await Promise.race([
      Promise.allSettled(loops).then(() => true),
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(false), shutdownGraceMs);
      }),
    ]);

    clearTimeout(graceTimer);

    if (!finished) {
      await Promise.allSettled(
        [...inFlight.values()].map(({ job }) =>
          store.release({
            attemptCount: job.attemptCount,
            jobId: job.jobId,
            workerId,
          })
        )
      );
    }

    loops = [];
  };

  return {
    get running() {
      return running;
    },
    get inFlightCount() {
      return inFlight.size;
    },
    runHousekeeping,
    runOnce,
    start,
    stop,
    workerId,
  };
};

/**
 * Whether an API process runs the ingest worker loop, and what to log about
 * it. RAG_INGEST_WORKER_ENABLED=false hands the queue to dedicated
 * `npm run worker:ingest` processes, which only works when every process sees
 * the same queue and the same index: the in-memory queue (no PostgreSQL) and
 * the local vector index are per process, so with either one this process
 * keeps its worker and says why.
 */
export const resolveApiIngestWorkerPlan = ({
  asyncMode = isRagIngestAsync(),
  storeBackend,
  vectorStoreProvider,
  workerEnabled,
}) => {
  const plan = { errors: [], start: false, warnings: [] };

  if (!asyncMode) {
    return plan;
  }

  plan.start = true;

  if (storeBackend === "memory") {
    if (!workerEnabled) {
      plan.errors.push(
        "[ingest-worker] RAG_INGEST_WORKER_ENABLED=false is ignored: without PostgreSQL the ingest queue lives in this process's memory, where no other process can drain it, so this process runs its own worker."
      );
    }

    return plan;
  }

  if (vectorStoreProvider === "local") {
    if (!workerEnabled) {
      plan.errors.push(
        "[ingest-worker] RAG_INGEST_WORKER_ENABLED=false is ignored: VECTOR_STORE_PROVIDER=local keeps the index in each process's own files, so chunks a dedicated worker wrote would never be searched here (and `npm run worker:ingest` refuses to start). Use pgvector or qdrant to ingest in other processes."
      );
    }

    plan.warnings.push(
      "[ingest-worker] RAG_INGEST_MODE=async with VECTOR_STORE_PROVIDER=local supports a single API process only: a job claimed by another process would be indexed where this one never reads it."
    );
    return plan;
  }

  plan.start = Boolean(workerEnabled);
  return plan;
};

// Document visibility across processes. With RAG_INGEST_MODE=async the worker
// that registers a document may run in another process, whose registry map
// this process never sees; these read the store before a lookup answers from
// a stale map. In sync mode every document this process serves was registered
// by it or loaded at startup, as before, so they do nothing.

export const loadDocumentsIngestedElsewhere = async (ragService, docIds) => {
  if (!isRagIngestAsync() || typeof ragService?.loadDocumentsFromStore !== "function") {
    return;
  }

  try {
    await ragService.loadDocumentsFromStore(docIds);
  } catch (error) {
    console.error("[ingest] Failed to read documents registered by another process.", error);
  }
};

// Reads the requesting tenant's documents only (every document when auth is
// off, which is one tenant).
export const refreshDocumentsIngestedElsewhere = async (ragService, accessScope = {}) => {
  if (!isRagIngestAsync() || typeof ragService?.refreshDocumentRegistry !== "function") {
    return;
  }

  try {
    await ragService.refreshDocumentRegistry(accessScope);
  } catch (error) {
    console.error("[ingest] Failed to refresh the document registry.", error);
  }
};
