import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getRagIngestJobLeaseMs,
  getRagIngestJobRetentionMs,
  getRagIngestStageRetryPolicy,
  getRagIngestWorkerConcurrency,
  getRagIngestWorkerPollMs,
  isRagIngestAsync,
} from "./config.js";
import { isDocumentRegistryShared } from "./doc-registry.js";
import { toIngestJobErrorMessage } from "./ingest-job-store.js";
import {
  INGEST_JOB_KINDS,
  INGEST_STAGE_OUTPUTS,
  INGEST_STAGES,
  getNextIngestStage,
  supportsStagedIngest,
} from "./ingest-stages.js";
import { runWithDatabaseTenant } from "./postgres-tenant.js";

// The worker side of RAG_INGEST_MODE=async. Each loop claims one job at a time
// from the store (as the owner role, because the queue holds every tenant's
// jobs), then ingests it under the job's own tenant with the same
// ragService.ingestDocument call the synchronous upload route makes. The store
// fences every write after the claim, so a worker that stalled past its lease
// can finish its work but cannot record it over the attempt that replaced it.
//
// An idle loop sleeps RAG_INGEST_WORKER_POLL_MS between claims, and the store
// wakes it early when a job is enqueued (store.subscribeToEnqueues: directly in
// this process, through PostgreSQL NOTIFY from other processes). The poll is
// the fallback that bounds a lost wake-up to one interval.
//
// With the real ragService (whose ingestDocument declares STAGED_INGEST) a job
// runs as the staged pipeline of rag/ingest-pipeline.js: parse, chunk, embed
// and index, each one's output stored (store.advanceStage) before the next
// starts, all within one claim while nothing fails. A failure is recorded
// against the stage it happened in, with that stage's own retry budget and
// backoff (RAG_INGEST_<STAGE>_*), so the next attempt resumes there; a stage
// out of attempts moves the job to dead_letter. The index stage records the
// job's success inside its own write transaction (store.completeInTransaction)
// where the provider has one. A ragService whose ingestDocument declares no
// stages (a test stub, a custom service) runs each job as one step, as before.

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

/**
 * The backoff after the `attemptCount`th failed attempt of `stage`: the
 * doubling delay, jittered down to half of it. Jobs that failed together (one
 * embeddings batch) thus come due apart and do not re-form the same batch.
 */
export const getIngestStageRetryDelayMs = (attemptCount, stage, random = Math.random) => {
  const { baseDelayMs, maxDelayMs } = getRagIngestStageRetryPolicy(stage);
  const delayMs = Math.min(baseDelayMs * 2 ** Math.max(0, Number(attemptCount) - 1), maxDelayMs);
  const draw = Math.min(1, Math.max(0, Number(random()) || 0));

  return Math.round(delayMs * (0.5 + draw / 2));
};

/**
 * What an operator reads about a dead-letter job: the stage, the attempt and
 * the error's status, code and class -- never its message, which may name
 * part of a key or a host (the public message says what the user may see).
 */
export const describeIngestStageFailure = ({ attempt, error, maxAttempts, stage }) => {
  const details = [
    Number.isInteger(Number(error?.status)) && error?.status !== undefined ? `status ${error.status}` : null,
    error?.code ? `code ${error.code}` : null,
    error?.name && error.name !== "Error" ? error.name : null,
  ].filter(Boolean);

  return `Stage ${stage} failed on attempt ${attempt} of ${maxAttempts}${
    details.length > 0 ? ` (${details.join(", ")})` : ""
  }: ${toIngestJobErrorMessage(error)}`;
};

const createLeaseLostError = (job) =>
  Object.assign(new Error(`Ingest job ${job.jobId} attempt ${job.attemptCount} lost its lease.`), {
    code: "INGEST_JOB_LEASE_LOST",
    retryable: true,
  });

// 4xx statuses that still say "try again later": the same set rag/openai.js
// retries (a timed-out request, a conflict, a rate limit), plus 425.
const TRANSIENT_CLIENT_STATUSES = new Set([408, 409, 425, 429]);

// The stages that read only the upload's own bytes.
const UPLOAD_STAGES = new Set(["parse", "chunk"]);

// At parse and chunk any other 4xx says the upload itself is the problem (no
// extractable text, an unreadable PDF, pages too large to store): another
// attempt would read the same bytes and fail the same way, so the job fails at
// once instead of spending its retries. At embed and index a 4xx comes from a
// provider or the configuration instead -- a rotated key (401), revoked model
// access (403), a model the endpoint does not serve (404), a version's width --
// or from a size the index versions being built decide: nothing is wrong with
// the upload, so the job spends the stage's retries and then waits in
// dead_letter with its bytes for an operator's requeue. An error that says
// `retryable: false` itself (the document it replaces is gone, the job lost
// its file) is final at any stage. A rate limit that outlasted the model
// client's own retries is exactly what the queue's backoff is for.
export const isRetryableIngestError = (error, stage = null) => {
  if (typeof error?.retryable === "boolean") {
    return error.retryable;
  }

  const status = Number(error?.status);

  if (TRANSIENT_CLIENT_STATUSES.has(status)) {
    return true;
  }

  if (stage && !UPLOAD_STAGES.has(stage)) {
    return true;
  }

  return !(Number.isInteger(status) && status >= 400 && status < 500);
};

// The backoff, but never shorter than a Retry-After the provider sent.
const resolveRetryDelayMs = (retryDelayMs, { attemptCount, stage }, error) => {
  const delayMs = Number(retryDelayMs(attemptCount, stage)) || 0;
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
  pipeline = null,
  pollIntervalMs = getRagIngestWorkerPollMs(),
  ragService,
  renewIntervalMs = null,
  retryDelayMs = getIngestStageRetryDelayMs,
  stageMaxAttempts = (stage) => getRagIngestStageRetryPolicy(stage).maxAttempts,
  settleRetryDelayMs = SETTLE_RETRY_DELAY_MS,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  store,
  tempDirectory = os.tmpdir(),
  workerId = createIngestWorkerId(),
  // Test seams: afterStage({ job, stage }) runs once a stage's output is stored.
  hooks = {},
} = {}) => {
  if (!store || typeof store.claim !== "function") {
    throw new Error("createIngestWorker requires an ingest job store.");
  }

  if (!pipeline && typeof ragService?.ingestDocument !== "function") {
    throw new Error("createIngestWorker requires ragService.ingestDocument.");
  }

  // The staged pipeline when one is given or the ragService's ingest declares
  // it; loaded lazily so a stub-driven worker never loads the RAG modules.
  let stagedPipeline = pipeline;
  const resolvePipeline = async () => {
    if (stagedPipeline || !supportsStagedIngest(ragService?.ingestDocument)) {
      return stagedPipeline;
    }

    const { getDefaultIngestPipeline } = await import("./ingest-pipeline.js");

    stagedPipeline = getDefaultIngestPipeline();
    return stagedPipeline;
  };

  const inFlight = new Map();
  const wakeSleepers = new Set();
  const attemptDirectory = path.join(tempDirectory, INGEST_TEMP_SUBDIRECTORY);
  const loopCount = Math.max(1, Math.floor(concurrency));
  let loops = [];
  let running = false;
  // Wake-ups no sleeping loop took; see wake().
  let pendingWakes = 0;
  let unsubscribeFromEnqueues = null;
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

  /**
   * A job may have become claimable: wakes one sleeping loop to claim now. If
   * no loop is asleep the wake-up is kept (up to one per loop), and the next
   * loop that finds the queue empty looks once more instead of sleeping,
   * because that job may have been enqueued after its claim read the queue.
   * Only a hint either way: a claim decides, and a lost wake-up costs one
   * poll interval.
   */
  const wake = () => {
    if (!running) {
      return;
    }

    const [sleeper] = wakeSleepers;

    if (sleeper) {
      sleeper();
      return;
    }

    pendingWakes = Math.min(pendingWakes + 1, loopCount);
  };

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

  // The one-step ingest of a ragService that declares no stages. It gets the
  // job's content hash, whether to deduplicate, and whether it replaces a
  // document, so such a service can honour them too; it resolves to
  // { outcome } for the success record.
  const ingestJob = async (job, fence, tempFilePath, holdsLease) => {
    const replacing = job.kind === INGEST_JOB_KINDS.replace;

    // A replacement's document always exists, so only a new document's row
    // says an earlier attempt committed.
    if (!replacing && (await findCommittedDocument(job))) {
      return { outcome: {} };
    }

    try {
      await mkdir(attemptDirectory, { recursive: true });

      if (!(await writeAttemptFile(job, fence, tempFilePath))) {
        const error = new Error("The ingest job no longer holds its file.");

        error.retryable = false;
        throw error;
      }

      // The ingest commits before any fenced write; an attempt that lost its
      // lease must not start it.
      if (!(await holdsLease())) {
        return { leaseLost: true };
      }

      const document = await ragService.ingestDocument({
        contentSha256: job.contentSha256 ?? null,
        deduplicate: job.deduplicate === true,
        docId: job.docId,
        filePath: tempFilePath,
        fileName: job.fileName,
        ownerUserId: job.ownerUserId,
        replace: replacing,
        requestedAt: job.createdAt ?? null,
        workspaceId: job.workspaceId,
      });

      return {
        outcome: {
          docId: document?.docId ?? null,
          documentVersion: document?.version ?? null,
          duplicate: document?.duplicate === true,
          superseded: document?.superseded === true,
        },
      };
    } finally {
      await rm(tempFilePath, { force: true }).catch(() => {});
    }
  };

  const writeOutputFile = async (fence, output, filePath) =>
    typeof store.copyOutputFile === "function"
      ? store.copyOutputFile({ ...fence, filePath, output })
      : false;

  const readStageInputs = async (fence, names) => {
    if (names.length === 0) {
      return {};
    }

    const inputs = await store.readOutputs({ ...fence, outputs: names });

    if (!inputs) {
      return null;
    }

    const missing = names.filter((name) => !inputs[name]);

    if (missing.length > 0) {
      // Stored before the stage advanced, so this is not a transient state:
      // requeueing cannot bring the output back.
      throw Object.assign(new Error(`The ingest job lost its ${missing.join(", ")} output.`), {
        retryable: false,
      });
    }

    return inputs;
  };

  // Runs the job's stages from its current one. `state` tracks the stage in
  // progress and its attempt number, for the failure record. Resolves to
  // { outcome, recorded } (recorded: success is already in the store),
  // or { leaseLost: true }.
  const runStagedJob = async (job, fence, stages, tempFilePath, state, holdsLease) => {
    const withAttemptDirectory = async (callback) => {
      await mkdir(attemptDirectory, { recursive: true });

      try {
        return await callback();
      } finally {
        await rm(tempFilePath, { force: true }).catch(() => {});
      }
    };

    // Bytes this tenant already stored need no stage at all.
    if (state.stage === INGEST_STAGES[0] && typeof stages.findDuplicate === "function") {
      const duplicate = await stages.findDuplicate({ job });

      if (duplicate) {
        return { outcome: { ...duplicate, duplicate: true }, recorded: false };
      }
    }

    for (;;) {
      const stage = state.stage;

      if (stage === "index") {
        const inputs = await readStageInputs(fence, [
          INGEST_STAGE_OUTPUTS.chunks,
          INGEST_STAGE_OUTPUTS.embeddings,
        ]);

        if (!inputs) {
          return { leaseLost: true };
        }

        let recorded = false;
        let fencedOut = false;
        const outcome = await withAttemptDirectory(async () => {
          if (!(await writeOutputFile(fence, INGEST_STAGE_OUTPUTS.documentFile, tempFilePath))) {
            throw Object.assign(new Error("The ingest job no longer holds its file."), {
              retryable: false,
            });
          }

          // Without a transaction the commit writes chunks and registry before
          // any fenced call: an attempt that lost its lease (or was handed
          // back on stop) must not start it beside the attempt that owns the
          // job now. On pgvector completeInTransaction fences the commit too.
          if (!(await holdsLease())) {
            fencedOut = true;
            return null;
          }

          return stages.index({
            documentFilePath: tempFilePath,
            inputs,
            job,
            onCommit: async ({ client, docId, documentVersion, duplicate, superseded }) => {
              if (!client || typeof store.completeInTransaction !== "function") {
                return;
              }

              if (
                !(await store.completeInTransaction({
                  ...fence,
                  client,
                  docId,
                  documentVersion,
                  duplicate,
                  superseded,
                }))
              ) {
                throw createLeaseLostError(job);
              }

              recorded = true;
            },
          });
        });

        return fencedOut ? { leaseLost: true } : { outcome, recorded };
      }

      let result;

      if (stage === INGEST_STAGES[0]) {
        result = await withAttemptDirectory(async () => {
          if (!(await writeAttemptFile(job, fence, tempFilePath))) {
            throw Object.assign(new Error("The ingest job no longer holds its file."), {
              retryable: false,
            });
          }

          return stages.parse({ filePath: tempFilePath, job });
        });
      } else {
        const inputs = await readStageInputs(fence, stage === "chunk" ? [INGEST_STAGE_OUTPUTS.pages] : [INGEST_STAGE_OUTPUTS.chunks]);

        if (!inputs) {
          return { leaseLost: true };
        }

        result = await stages[stage]({ inputs, job });
      }

      const nextStage = getNextIngestStage(stage);
      const advanced = await settleWithRetries(
        () =>
          store.advanceStage({
            ...fence,
            fromStage: stage,
            leaseMs,
            maxAttempts: stageMaxAttempts(nextStage),
            moveDocumentFile: stage === INGEST_STAGES[0],
            output: {
              name:
                stage === INGEST_STAGES[0]
                  ? INGEST_STAGE_OUTPUTS.pages
                  : stage === "chunk"
                    ? INGEST_STAGE_OUTPUTS.chunks
                    : INGEST_STAGE_OUTPUTS.embeddings,
              payload: result.output,
            },
            toStage: nextStage,
          }),
        { retryDelayMs: settleRetryDelayMs }
      );

      if (!advanced) {
        return { leaseLost: true };
      }

      await hooks.afterStage?.({ job, stage });
      state.stage = nextStage;
      state.attempt = 1;
      state.maxAttempts = stageMaxAttempts(nextStage);
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
    // A fenced renewal: false once another attempt owns the job.
    const holdsLease = async () => {
      if (leaseLost) {
        return false;
      }

      if (typeof store.renew !== "function") {
        return true;
      }

      try {
        return (await store.renew({ ...fence, leaseMs })) === true;
      } catch (error) {
        logger.error?.(`[ingest-worker] failed to renew the lease of job ${job.jobId} before its commit.`, error);
        return false;
      }
    };
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

    // The stage in progress and its attempt number, for the failure record.
    const state = {
      attempt: Number(job.stageAttempts ?? job.attemptCount) || 1,
      maxAttempts: Number(job.maxAttempts) || 1,
      stage: job.stage ?? INGEST_STAGES[0],
    };
    let ingestError = null;
    let staged = null;
    // Whether the job ran as the staged pipeline (state.stage is then the
    // stage that failed); a one-step ingest judges errors as before.
    let stagedRun = false;

    try {
      await Promise.allSettled(waitFor);

      const stages = await resolvePipeline();

      stagedRun = Boolean(stages);

      await runWithDatabaseTenant(
        {
          userId: job.ownerUserId,
          workspaceId: job.workspaceId,
        },
        async () => {
          staged = stages
            ? await runStagedJob(job, fence, stages, tempFilePath, state, holdsLease)
            : await ingestJob(job, fence, tempFilePath, holdsLease);
        }
      );
    } catch (error) {
      ingestError = error;
    } finally {
      clearInterval(renewTimer);
    }

    const settleOptions = { retryDelayMs: settleRetryDelayMs };

    if (!ingestError) {
      if (staged?.leaseLost) {
        return "lease_lost";
      }

      if (staged?.recorded) {
        await store.discardOutputs?.(job.jobId).catch?.((error) =>
          logger.error?.(`[ingest-worker] failed to drop the stage outputs of job ${job.jobId}.`, error)
        );
        return "succeeded";
      }

      const outcome = staged?.outcome ?? {};

      return (await settleWithRetries(
        () =>
          store.succeed(fence, {
            docId: outcome.docId ?? null,
            documentVersion: outcome.documentVersion ?? null,
            duplicate: outcome.duplicate === true,
            superseded: outcome.superseded === true,
          }),
        settleOptions
      ))
        ? "succeeded"
        : "lease_lost";
    }

    if (ingestError?.code === "INGEST_JOB_LEASE_LOST") {
      logger.warn?.(
        `[ingest-worker] job ${job.jobId} attempt ${job.attemptCount} lost its lease before its index write committed; the write was rolled back.`
      );
      return "lease_lost";
    }

    const status = await settleWithRetries(
      () =>
        store.fail({
          ...fence,
          deadLetterReason: describeIngestStageFailure({
            attempt: state.attempt,
            error: ingestError,
            maxAttempts: state.maxAttempts,
            stage: state.stage,
          }),
          error: toIngestJobErrorMessage(ingestError),
          retryDelayMs: resolveRetryDelayMs(
            retryDelayMs,
            { attemptCount: state.attempt, stage: state.stage },
            ingestError
          ),
          retryable: isRetryableIngestError(ingestError, stagedRun ? state.stage : null),
        }),
      settleOptions
    );

    logger.error?.(
      `[ingest-worker] job ${job.jobId} attempt ${job.attemptCount} failed at stage ${state.stage} (${status ?? "lease lost"}).`,
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

        if (pendingWakes > 0) {
          pendingWakes -= 1;
          continue;
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
    pendingWakes = 0;
    lastHousekeepingAt = Date.now();
    void runHousekeeping();

    // Never fails the start: without wake-ups the loops still poll.
    try {
      unsubscribeFromEnqueues = store.subscribeToEnqueues?.(wake) ?? null;
    } catch (error) {
      logger.error?.(
        `[ingest-worker] could not subscribe to enqueued jobs; polling every ${pollIntervalMs} ms instead.`,
        error
      );
    }

    loops = Array.from({ length: loopCount }, () => loop());
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

    // Closes the store's LISTEN session (when this was its last subscriber)
    // while the running jobs get their grace period.
    const unsubscribe = unsubscribeFromEnqueues;

    unsubscribeFromEnqueues = null;

    const unsubscribing = Promise.resolve()
      .then(() => unsubscribe?.())
      .catch((error) =>
        logger.error?.("[ingest-worker] failed to stop listening for enqueued jobs.", error)
      );

    for (const wakeSleeper of [...wakeSleepers]) {
      wakeSleeper();
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

    await unsubscribing;
    loops = [];
  };

  return {
    get running() {
      return running;
    },
    get inFlightCount() {
      return inFlight.size;
    },
    // Loops asleep until their next poll or a wake-up.
    get idleLoopCount() {
      return wakeSleepers.size;
    },
    pollIntervalMs,
    runHousekeeping,
    runOnce,
    start,
    stop,
    wake,
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

// Document visibility across processes. Each process keeps the document
// registry in a map filled at startup and updated by its own writes. When the
// registry is PostgreSQL, other processes write it too, in either ingest mode:
// another API instance's synchronous upload, a worker process's async job, a
// delete or clear made elsewhere. These read the store before a lookup or a
// listing answers from a stale map: /chat refreshes the tenant before its run
// (app-services.js buildChatResponse), GET /documents and the arXiv duplicate
// check refresh the tenant, and DELETE /documents/:docId and GET
// /ingest-jobs/:jobId read the named document. A file-backed or in-memory
// registry has one writer (this process), so they do nothing there.
//
// Whether the registry is shared comes from the ragService when it says so
// (the app's ragService does; a test stub can), otherwise from the registry
// this process configured.
const sharesDocumentRegistry = (ragService) =>
  typeof ragService?.isDocumentRegistryShared === "function"
    ? ragService.isDocumentRegistryShared() === true
    : isDocumentRegistryShared();

// The named documents only: adds the ones another process registered and
// drops the ones it deleted (doc-registry.js loadDocumentsFromStore).
export const loadDocumentsIngestedElsewhere = async (ragService, docIds) => {
  if (
    typeof ragService?.loadDocumentsFromStore !== "function" ||
    !sharesDocumentRegistry(ragService)
  ) {
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
  if (
    typeof ragService?.refreshDocumentRegistry !== "function" ||
    !sharesDocumentRegistry(ragService)
  ) {
    return;
  }

  try {
    await ragService.refreshDocumentRegistry(accessScope);
  } catch (error) {
    console.error("[ingest] Failed to refresh the document registry.", error);
  }
};
