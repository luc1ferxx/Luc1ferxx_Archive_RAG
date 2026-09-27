import { randomUUID } from "node:crypto";
import { open, writeFile } from "node:fs/promises";

import {
  getDocumentsPostgresTable,
  getIngestJobsPostgresTable,
  getRagIngestJobMaxAttempts,
  getRagIngestMaxPendingBytesPerTenant,
  getRagIngestMaxPendingJobsPerTenant,
  isPostgresDatabaseConfigured,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { documentMatchesAccessScope, hasDocument } from "./doc-registry.js";
import {
  createDedicatedPostgresClient,
  queryPostgres as queryDefaultPostgres,
} from "./postgres.js";
import { createPostgresNotificationListener } from "./postgres-notification-listener.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";

// Jobs for RAG_INGEST_MODE=async (migration 015). The upload route enqueues a
// validated PDF; a worker (rag/ingest-worker.js) claims it, ingests it and
// records the outcome. Both stores below share one contract:
//
// - enqueue() refuses (429) a job that would take its tenant over the pending
//   job or byte cap (RAG_INGEST_MAX_PENDING_*_PER_TENANT).
// - claim() takes a job that is queued and due, or running with an expired
//   lease, preferring tenants with the fewest running jobs and then the oldest
//   job, marks it running for `workerId` and bumps attempt_count. The returned
//   job says whether its previous attempt died (`recoveredFromExpiredLease`).
//   A running job whose last allowed attempt let its lease expire is settled
//   instead of claimed again: succeeded when its document was committed (the
//   worker died between commit and recording success), failed otherwise.
// - copyJobFile() writes a claimed job's bytes to a file, fenced like the
//   writes below; the PostgreSQL claim does not return the bytes.
// - renew/succeed/fail/release are fenced on jobId + workerId + attemptCount:
//   a worker that lost its lease gets `false`/`null` back and changes nothing.
// - fail() requeues with a delay while attempts remain and the error is
//   retryable, otherwise marks the job failed. Terminal jobs drop their bytes.
// - pruneFinished() deletes succeeded and failed jobs older than a cutoff.
// - get() answers only for a job the access scope owns, by the same rule as
//   the documents the jobs become (documentMatchesAccessScope).
// - subscribeToEnqueues(listener) calls `listener` whenever a job may have
//   become claimable now (an enqueue or a release), so idle workers claim it
//   at once instead of at their next poll, and returns an async unsubscribe.
//   The in-memory store calls it directly. The PostgreSQL store calls it
//   directly for this process's own enqueues and, for every other process's,
//   through NOTIFY on a channel named after the jobs table, which one dedicated
//   LISTEN session per store receives while anything is subscribed. A wake-up
//   is only ever a hint: workers keep polling, and a claim decides.

export const INGEST_JOB_STATUSES = Object.freeze({
  failed: "failed",
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
});

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const FALLBACK_ERROR_MESSAGE = "Ingestion failed.";
// Bytes are read back in slices so a worker never holds a large upload (and
// its hex text form) in memory at once, as the synchronous path never did.
const FILE_READ_CHUNK_BYTES = 8 * 1024 * 1024;

export const SERVER_ERROR_MESSAGE = "Indexing failed on the server.";
export const PENDING_LIMIT_ERROR_MESSAGE =
  "Too many uploads from this account are still waiting to be indexed. Try again once some have finished.";
// Statuses the ingest path itself sets for a problem with the upload (422: no
// extractable text). Any other error may come from a dependency (a model
// provider's 401 names part of the key, a socket error names a host), so the
// job keeps a generic message and the worker log keeps the error.
const PUBLIC_ERROR_STATUSES = new Set([413, 415, 422]);

export const LEASE_EXHAUSTED_ERROR_MESSAGE =
  "The ingestion worker stopped responding during the last allowed attempt.";

const normalizeText = (value) => String(value ?? "").trim();

const toPositiveInteger = (value, fallbackValue) => {
  const parsedValue = Number.parseInt(value, 10);

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
};

/**
 * The message a user may see, bounded to its first line. A string is already a
 * public message (a stored last_error). An Error keeps its message only when
 * the ingest path raised it about the upload (a PUBLIC_ERROR_STATUSES status,
 * or `expose: true`); anything else becomes SERVER_ERROR_MESSAGE.
 */
export const toIngestJobErrorMessage = (error) => {
  let rawMessage = String(error ?? "");

  if (error instanceof Error) {
    rawMessage =
      error.expose === true || PUBLIC_ERROR_STATUSES.has(Number(error.status))
        ? error.message
        : SERVER_ERROR_MESSAGE;
  }

  const firstLine = rawMessage.split(/\r?\n/, 1)[0].trim();

  return (firstLine || FALLBACK_ERROR_MESSAGE).slice(0, MAX_ERROR_MESSAGE_LENGTH);
};

const createPendingLimitError = () =>
  Object.assign(new Error(PENDING_LIMIT_ERROR_MESSAGE), { expose: true, status: 429 });

export const ingestJobMatchesAccessScope = (job, accessScope = {}) =>
  Boolean(job) &&
  documentMatchesAccessScope(
    {
      ownerUserId: job.ownerUserId,
      workspaceId: job.workspaceId,
    },
    accessScope
  );

export const toPublicIngestJob = (job) =>
  job
    ? {
        jobId: job.jobId,
        docId: job.docId,
        fileName: job.fileName,
        status: job.status,
        attemptCount: job.attemptCount,
        error: job.lastError ? toIngestJobErrorMessage(job.lastError) : null,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      }
    : null;

const toNonNegativeInteger = (value, fallbackValue) => {
  const parsedValue = Number.parseInt(value, 10);

  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallbackValue;
};

const resolvePendingLimits = ({
  maxPendingBytes = getRagIngestMaxPendingBytesPerTenant(),
  maxPendingJobs = getRagIngestMaxPendingJobsPerTenant(),
} = {}) => ({
  maxPendingBytes: toNonNegativeInteger(maxPendingBytes, 0),
  maxPendingJobs: toNonNegativeInteger(maxPendingJobs, 0),
});

const normalizeEnqueueInput = ({
  docId,
  fileBytes,
  fileName,
  jobId = randomUUID(),
  maxAttempts = getRagIngestJobMaxAttempts(),
  ownerUserId = "",
  workspaceId = "",
} = {}) => {
  const normalizedDocId = normalizeText(docId);

  if (!normalizedDocId) {
    throw new Error("An ingest job requires a docId.");
  }

  if (!Buffer.isBuffer(fileBytes) && !(fileBytes instanceof Uint8Array)) {
    throw new Error("An ingest job requires the file bytes.");
  }

  return {
    docId: normalizedDocId,
    fileBytes: Buffer.from(fileBytes),
    fileName: normalizeText(fileName),
    jobId: normalizeText(jobId) || randomUUID(),
    maxAttempts: toPositiveInteger(maxAttempts, getRagIngestJobMaxAttempts()),
    ownerUserId: normalizeText(ownerUserId),
    workspaceId: normalizeText(workspaceId),
  };
};

const toIsoText = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const JOB_COLUMNS = `
  job_id, doc_id, owner_user_id, workspace_id, file_name, status, attempt_count,
  max_attempts, claimed_by, lease_expires_at, available_at, last_error,
  created_at, updated_at, started_at, finished_at
`;

const prefixColumns = (alias) =>
  JOB_COLUMNS.split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");

const mapRowToJob = (row = {}) => ({
  jobId: String(row.job_id),
  docId: String(row.doc_id),
  ownerUserId: normalizeText(row.owner_user_id),
  workspaceId: normalizeText(row.workspace_id),
  fileName: String(row.file_name ?? ""),
  // pg already hands bytea over as a Buffer; copying it again would double a
  // large upload in memory.
  fileBytes: Buffer.isBuffer(row.file_bytes)
    ? row.file_bytes
    : row.file_bytes
      ? Buffer.from(row.file_bytes)
      : null,
  recoveredFromExpiredLease: row.previous_status === "running",
  status: String(row.status),
  attemptCount: Number(row.attempt_count ?? 0),
  maxAttempts: Number(row.max_attempts ?? 0),
  claimedBy: row.claimed_by ?? null,
  leaseExpiresAt: toIsoText(row.lease_expires_at),
  availableAt: toIsoText(row.available_at),
  lastError: row.last_error ?? null,
  createdAt: toIsoText(row.created_at),
  updatedAt: toIsoText(row.updated_at),
  startedAt: toIsoText(row.started_at),
  finishedAt: toIsoText(row.finished_at),
});

// The fence every write after the claim carries.
const FENCE_SQL = `
  job_id = $1 AND claimed_by = $2 AND attempt_count = $3 AND status = 'running'
`;

const fenceValues = ({ attemptCount, jobId, workerId }) => [
  normalizeText(jobId),
  normalizeText(workerId),
  Number(attemptCount),
];

const ensureTableName = (name, variableName) => {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new Error(
      `${variableName} must be a simple PostgreSQL identifier. Received "${name}".`
    );
  }

  return name;
};

/**
 * The NOTIFY channel of a jobs table: its name, lowercased as PostgreSQL folds
 * the unquoted identifier, plus `_enqueued`, cut to the 63 bytes PostgreSQL
 * keeps. Two tables whose names only differ past that point share a channel,
 * which costs a spurious wake-up, nothing more.
 */
export const getIngestJobsNotifyChannel = (tableName) =>
  `${String(tableName).toLowerCase()}_enqueued`.slice(0, 63);

// Calls every subscriber; one that throws must neither stop the others nor
// fail the enqueue that announced the job.
const createEnqueueSubscribers = (logger) => {
  const listeners = new Set();

  return {
    add: (listener) => {
      if (typeof listener !== "function") {
        throw new Error("subscribeToEnqueues requires a listener function.");
      }

      listeners.add(listener);
    },
    delete: (listener) => listeners.delete(listener),
    get size() {
      return listeners.size;
    },
    wake: () => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          logger.error?.("[ingest-jobs] an enqueue subscriber failed.", error);
        }
      }
    },
  };
};

export const createPostgresIngestJobStore = ({
  createListenClient = createDedicatedPostgresClient,
  fileReadChunkBytes = FILE_READ_CHUNK_BYTES,
  getDocumentsTable = getDocumentsPostgresTable,
  getPendingLimits = resolvePendingLimits,
  getTable = getIngestJobsPostgresTable,
  listenRetryBaseMs,
  listenRetryMaxMs,
  logger = console,
  queryPostgres = queryDefaultPostgres,
  runMigrations = runPostgresMigrations,
} = {}) => {
  const tableName = () => ensureTableName(getTable(), "INGEST_JOBS_POSTGRES_TABLE");
  const documentsTableName = () =>
    ensureTableName(getDocumentsTable(), "DOCUMENTS_POSTGRES_TABLE");
  // Workers act for every tenant, so their writes run as the owner role. The
  // request-side enqueue and get deliberately do not: they run under the
  // request's tenant and row-level security checks them.
  const runAsSystem = (callback) => runAsDatabaseSystem(callback);
  // This process's subscribers are woken directly after its own enqueues, so
  // the NOTIFY those enqueues send carries this store's id and its LISTEN
  // session skips them instead of waking the same loops twice.
  const instanceId = randomUUID();
  const subscribers = createEnqueueSubscribers(logger);
  let notificationListener = null;

  const startListening = () => {
    const listener = createPostgresNotificationListener({
      channel: getIngestJobsNotifyChannel(tableName()),
      createClient: createListenClient,
      logger,
      // Jobs enqueued while no session listened were announced to nobody.
      onListening: () => subscribers.wake(),
      onNotification: (payload) => {
        if (payload !== instanceId) {
          subscribers.wake();
        }
      },
      retryBaseMs: listenRetryBaseMs,
      retryMaxMs: listenRetryMaxMs,
    });

    listener.start();
    return listener;
  };

  return {
    backend: "postgres",

    /**
     * Wake-up state for health output and tests: whether the LISTEN session is
     * open right now and how many subscribers it serves.
     */
    enqueueNotificationStatus() {
      return {
        channel: notificationListener?.channel ?? null,
        failures: notificationListener?.failures ?? 0,
        listening: notificationListener?.listening ?? false,
        subscribers: subscribers.size,
      };
    },

    // The first subscriber opens the LISTEN session (in the background: this
    // returns at once and never waits for the database), the last unsubscribe
    // closes it.
    subscribeToEnqueues(listener) {
      subscribers.add(listener);

      try {
        notificationListener ??= startListening();
      } catch (error) {
        subscribers.delete(listener);
        throw error;
      }

      let subscribed = true;

      return async () => {
        if (!subscribed) {
          return;
        }

        subscribed = false;
        subscribers.delete(listener);

        if (subscribers.size === 0 && notificationListener) {
          const stopping = notificationListener;

          notificationListener = null;
          await stopping.stop();
        }
      };
    },

    async initialize() {
      await runMigrations();
      return true;
    },

    // The caps are checked in the INSERT itself, over the tenant's queued and
    // running jobs. Two concurrent uploads can both pass the check, so a cap
    // may be exceeded by the number of uploads racing it; that bounds a
    // runaway client, which is what it is for.
    //
    // The NOTIFY is part of the same statement, so it is sent when the INSERT
    // commits and not at all when the cap refuses the job or the insert rolls
    // back. Its payload is this store's id and nothing about the job.
    async enqueue(input) {
      const job = normalizeEnqueueInput(input);
      const table = tableName();
      const { maxPendingBytes, maxPendingJobs } = getPendingLimits();
      const result = await queryPostgres(
        `
          WITH inserted AS (
            INSERT INTO ${table} (
              job_id, doc_id, owner_user_id, workspace_id, file_name, file_bytes, status, max_attempts
            )
            SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::bytea, 'queued', $7::integer
            FROM (
              SELECT COUNT(*) AS pending_jobs,
                     COALESCE(SUM(octet_length(file_bytes)), 0) AS pending_bytes
              FROM ${table}
              WHERE owner_user_id = $3::text
                AND workspace_id = $4::text
                AND status IN ('queued', 'running')
            ) AS pending
            WHERE ($8::integer = 0 OR pending.pending_jobs < $8::integer)
              AND ($9::bigint = 0 OR pending.pending_bytes + octet_length($6::bytea) <= $9::bigint)
            RETURNING ${JOB_COLUMNS}
          )
          SELECT inserted.*, pg_notify($10::text, $11::text) AS notified
          FROM inserted
        `,
        [
          job.jobId,
          job.docId,
          job.ownerUserId,
          job.workspaceId,
          job.fileName,
          job.fileBytes,
          job.maxAttempts,
          maxPendingJobs,
          maxPendingBytes,
          getIngestJobsNotifyChannel(table),
          instanceId,
        ]
      );

      if (!result.rows[0]) {
        throw createPendingLimitError();
      }

      subscribers.wake();
      return mapRowToJob(result.rows[0]);
    },

    async get(jobId, accessScope = {}) {
      const normalizedJobId = normalizeText(jobId);

      if (!normalizedJobId) {
        return null;
      }

      const result = await queryPostgres(
        `
          SELECT ${JOB_COLUMNS}
          FROM ${tableName()}
          WHERE job_id = $1
          LIMIT 1
        `,
        [normalizedJobId]
      );
      const job = result.rows[0] ? mapRowToJob(result.rows[0]) : null;

      return ingestJobMatchesAccessScope(job, accessScope) ? job : null;
    },

    async claim({ leaseMs, workerId }) {
      const table = tableName();
      const documentsTable = documentsTableName();

      return runAsSystem(async () => {
        // A job whose last allowed attempt died is settled, not claimed. If
        // its document row exists the attempt committed and died before
        // recording success (the row and its chunks commit together), so the
        // job succeeded; otherwise it failed.
        await queryPostgres(
          `
            UPDATE ${table} AS j
            SET status = CASE WHEN committed.doc_id IS NULL THEN 'failed' ELSE 'succeeded' END,
                last_error = CASE WHEN committed.doc_id IS NULL THEN $1 ELSE NULL END,
                file_bytes = NULL,
                lease_expires_at = NULL,
                finished_at = NOW(),
                updated_at = NOW()
            FROM ${table} AS expired
            LEFT JOIN ${documentsTable} AS committed ON committed.doc_id = expired.doc_id
            WHERE j.job_id = expired.job_id
              AND expired.status = 'running'
              AND expired.lease_expires_at < NOW()
              AND expired.attempt_count >= expired.max_attempts
          `,
          [LEASE_EXHAUSTED_ERROR_MESSAGE]
        );

        // Fair across tenants: among claimable jobs, those whose tenant has the
        // fewest live running jobs go first, then the oldest. One tenant's
        // backlog therefore delays another tenant's upload by at most the jobs
        // already running. previous_status tells the worker whether the last
        // attempt died holding the job.
        const result = await queryPostgres(
          `
            WITH candidate AS (
              SELECT c.job_id, c.status AS previous_status
              FROM ${table} AS c
              WHERE (c.status = 'queued' AND c.available_at <= NOW())
                 OR (
                   c.status = 'running'
                   AND c.lease_expires_at < NOW()
                   AND c.attempt_count < c.max_attempts
                 )
              ORDER BY (
                SELECT COUNT(*)
                FROM ${table} AS r
                WHERE r.status = 'running'
                  AND r.lease_expires_at >= NOW()
                  AND r.owner_user_id = c.owner_user_id
                  AND r.workspace_id = c.workspace_id
              ) ASC, c.created_at ASC
              LIMIT 1
              FOR UPDATE OF c SKIP LOCKED
            )
            UPDATE ${table} AS j
            SET status = 'running',
                claimed_by = $1,
                attempt_count = j.attempt_count + 1,
                lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
                started_at = NOW(),
                finished_at = NULL,
                updated_at = NOW()
            FROM candidate
            WHERE j.job_id = candidate.job_id
            RETURNING ${prefixColumns("j")}, candidate.previous_status
          `,
          [normalizeText(workerId), Math.max(1, Math.floor(Number(leaseMs)))]
        );

        return result.rows[0] ? mapRowToJob(result.rows[0]) : null;
      });
    },

    /**
     * Writes the claimed attempt's bytes to `filePath` in slices. Resolves to
     * false, writing nothing further, when the attempt no longer holds the job
     * or the job holds no bytes.
     */
    async copyJobFile({ filePath, ...fence }) {
      const table = tableName();

      return runAsSystem(async () => {
        const sizeResult = await queryPostgres(
          `
            SELECT octet_length(file_bytes) AS size
            FROM ${table}
            WHERE ${FENCE_SQL}
          `,
          fenceValues(fence)
        );
        const size = sizeResult.rows[0]?.size;

        if (size === null || size === undefined) {
          return false;
        }

        const handle = await open(filePath, "w");

        try {
          for (let offset = 0; offset < Number(size); offset += fileReadChunkBytes) {
            const slice = await queryPostgres(
              `
                SELECT substring(file_bytes FROM $4::integer FOR $5::integer) AS part
                FROM ${table}
                WHERE ${FENCE_SQL}
              `,
              [...fenceValues(fence), offset + 1, fileReadChunkBytes]
            );
            const part = slice.rows[0]?.part;

            if (!part) {
              return false;
            }

            await handle.write(part);
          }
        } finally {
          await handle.close();
        }

        return true;
      });
    },

    async pruneFinished({ olderThanMs }) {
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            DELETE FROM ${tableName()}
            WHERE status IN ('succeeded', 'failed')
              AND finished_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
          `,
          [Math.max(0, Math.floor(Number(olderThanMs) || 0))]
        )
      );

      return result.rowCount ?? 0;
    },

    async renew({ leaseMs, ...fence }) {
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            UPDATE ${tableName()}
            SET lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
                updated_at = NOW()
            WHERE ${FENCE_SQL}
            RETURNING job_id
          `,
          [...fenceValues(fence), Math.max(1, Math.floor(Number(leaseMs)))]
        )
      );

      return result.rows.length > 0;
    },

    async succeed(fence) {
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            UPDATE ${tableName()}
            SET status = 'succeeded',
                file_bytes = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                finished_at = NOW(),
                updated_at = NOW()
            WHERE ${FENCE_SQL}
            RETURNING job_id
          `,
          fenceValues(fence)
        )
      );

      return result.rows.length > 0;
    },

    async fail({ error, retryDelayMs = 0, retryable = true, ...fence }) {
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            UPDATE ${tableName()}
            SET status = CASE WHEN $4::boolean AND attempt_count < max_attempts
                           THEN 'queued' ELSE 'failed' END,
                available_at = CASE WHEN $4::boolean AND attempt_count < max_attempts
                                 THEN NOW() + ($5::bigint * INTERVAL '1 millisecond')
                                 ELSE available_at END,
                file_bytes = CASE WHEN $4::boolean AND attempt_count < max_attempts
                               THEN file_bytes ELSE NULL END,
                finished_at = CASE WHEN $4::boolean AND attempt_count < max_attempts
                                THEN NULL ELSE NOW() END,
                lease_expires_at = NULL,
                last_error = $6,
                updated_at = NOW()
            WHERE ${FENCE_SQL}
            RETURNING status
          `,
          [
            ...fenceValues(fence),
            Boolean(retryable),
            Math.max(0, Math.floor(Number(retryDelayMs) || 0)),
            toIngestJobErrorMessage(error),
          ]
        )
      );

      return result.rows[0]?.status ?? null;
    },

    // A stopping worker hands its job back without spending the attempt. The
    // cleared claimed_by keeps the fence unique: the next claim is a different
    // worker, so the stopping worker's late writes cannot match it. The job is
    // claimable at once, so it is announced like an enqueue.
    async release(fence) {
      const table = tableName();
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            WITH released AS (
              UPDATE ${table}
              SET status = 'queued',
                  available_at = NOW(),
                  attempt_count = GREATEST(attempt_count - 1, 0),
                  claimed_by = NULL,
                  lease_expires_at = NULL,
                  updated_at = NOW()
              WHERE ${FENCE_SQL}
              RETURNING job_id
            )
            SELECT released.job_id, pg_notify($4::text, $5::text) AS notified
            FROM released
          `,
          [...fenceValues(fence), getIngestJobsNotifyChannel(table), instanceId]
        )
      );

      if (result.rows.length === 0) {
        return false;
      }

      subscribers.wake();
      return true;
    },
  };
};

// ---------------------------------------------------------------------------
// In memory (standalone profile, tests)
// ---------------------------------------------------------------------------

/**
 * One process's queue: the worker must run in the same process as the routes.
 * JavaScript runs each method to its first await without interleaving, so the
 * claim is atomic without a lock. `now` is injectable so tests can expire a
 * lease without waiting for it. `isDocumentCommitted` settles an exhausted
 * job like the PostgreSQL sweep does; this process's registry map is the
 * record there, because without PostgreSQL the registry is written before the
 * map is.
 */
export const createInMemoryIngestJobStore = ({
  getPendingLimits = resolvePendingLimits,
  isDocumentCommitted = hasDocument,
  logger = console,
  now = () => Date.now(),
} = {}) => {
  const jobs = new Map();
  const subscribers = createEnqueueSubscribers(logger);

  const isPending = (job) =>
    job.status === INGEST_JOB_STATUSES.queued || job.status === INGEST_JOB_STATUSES.running;
  const tenantKey = (job) => `${job.ownerUserId}\u0000${job.workspaceId}`;

  const snapshot = (job, { includeBytes = false } = {}) => ({
    jobId: job.jobId,
    docId: job.docId,
    ownerUserId: job.ownerUserId,
    workspaceId: job.workspaceId,
    fileName: job.fileName,
    fileBytes: includeBytes && job.fileBytes ? Buffer.from(job.fileBytes) : null,
    recoveredFromExpiredLease: false,
    status: job.status,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    claimedBy: job.claimedBy,
    leaseExpiresAt: toIsoText(job.leaseExpiresAt),
    availableAt: toIsoText(job.availableAt),
    lastError: job.lastError,
    createdAt: toIsoText(job.createdAt),
    updatedAt: toIsoText(job.updatedAt),
    startedAt: toIsoText(job.startedAt),
    finishedAt: toIsoText(job.finishedAt),
  });

  const findFenced = ({ attemptCount, jobId, workerId }) => {
    const job = jobs.get(normalizeText(jobId));

    return job &&
      job.status === INGEST_JOB_STATUSES.running &&
      job.claimedBy === normalizeText(workerId) &&
      job.attemptCount === Number(attemptCount)
      ? job
      : null;
  };

  const finish = (job, status, currentTime) => {
    job.status = status;
    job.fileBytes = null;
    job.leaseExpiresAt = null;
    job.finishedAt = currentTime;
    job.updatedAt = currentTime;
  };

  return {
    backend: "memory",

    enqueueNotificationStatus() {
      return { channel: null, failures: 0, listening: false, subscribers: subscribers.size };
    },

    // The queue lives in this process, so every enqueue is local: subscribers
    // are called directly.
    subscribeToEnqueues(listener) {
      subscribers.add(listener);

      let subscribed = true;

      return async () => {
        if (subscribed) {
          subscribed = false;
          subscribers.delete(listener);
        }
      };
    },

    async initialize() {
      return true;
    },

    async enqueue(input) {
      const normalized = normalizeEnqueueInput(input);
      const currentTime = now();

      if (jobs.has(normalized.jobId)) {
        throw new Error(`Ingest job ${normalized.jobId} already exists.`);
      }

      const { maxPendingBytes, maxPendingJobs } = getPendingLimits();
      const pending = [...jobs.values()].filter(
        (job) => isPending(job) && tenantKey(job) === tenantKey(normalized)
      );
      const pendingBytes = pending.reduce((total, job) => total + (job.fileBytes?.length ?? 0), 0);

      if (
        (maxPendingJobs > 0 && pending.length >= maxPendingJobs) ||
        (maxPendingBytes > 0 && pendingBytes + normalized.fileBytes.length > maxPendingBytes)
      ) {
        throw createPendingLimitError();
      }

      const job = {
        ...normalized,
        status: INGEST_JOB_STATUSES.queued,
        attemptCount: 0,
        claimedBy: null,
        leaseExpiresAt: null,
        availableAt: currentTime,
        lastError: null,
        createdAt: currentTime,
        updatedAt: currentTime,
        startedAt: null,
        finishedAt: null,
      };

      jobs.set(job.jobId, job);
      subscribers.wake();
      return snapshot(job);
    },

    async get(jobId, accessScope = {}) {
      const job = jobs.get(normalizeText(jobId));

      return job && ingestJobMatchesAccessScope(job, accessScope) ? snapshot(job) : null;
    },

    async claim({ leaseMs, workerId }) {
      const currentTime = now();
      const runningByTenant = new Map();
      const candidates = [];

      // Map iteration is insertion order, which is creation order.
      for (const job of jobs.values()) {
        const leaseExpired =
          job.status === INGEST_JOB_STATUSES.running && job.leaseExpiresAt < currentTime;

        if (leaseExpired && job.attemptCount >= job.maxAttempts) {
          const committed = Boolean(isDocumentCommitted(job.docId));

          job.lastError = committed ? null : LEASE_EXHAUSTED_ERROR_MESSAGE;
          finish(
            job,
            committed ? INGEST_JOB_STATUSES.succeeded : INGEST_JOB_STATUSES.failed,
            currentTime
          );
          continue;
        }

        if (job.status === INGEST_JOB_STATUSES.running && !leaseExpired) {
          runningByTenant.set(tenantKey(job), (runningByTenant.get(tenantKey(job)) ?? 0) + 1);
        }

        if (
          (job.status === INGEST_JOB_STATUSES.queued && job.availableAt <= currentTime) ||
          leaseExpired
        ) {
          candidates.push(job);
        }
      }

      // The fewest running jobs for the tenant first, then the oldest (the
      // sort is stable, so ties keep creation order).
      const claimable =
        candidates.sort(
          (left, right) =>
            (runningByTenant.get(tenantKey(left)) ?? 0) -
            (runningByTenant.get(tenantKey(right)) ?? 0)
        )[0] ?? null;

      if (!claimable) {
        return null;
      }

      const recoveredFromExpiredLease = claimable.status === INGEST_JOB_STATUSES.running;

      claimable.status = INGEST_JOB_STATUSES.running;
      claimable.claimedBy = normalizeText(workerId);
      claimable.attemptCount += 1;
      claimable.leaseExpiresAt = currentTime + Math.max(1, Math.floor(Number(leaseMs)));
      claimable.startedAt = currentTime;
      claimable.finishedAt = null;
      claimable.updatedAt = currentTime;

      return {
        ...snapshot(claimable, { includeBytes: true }),
        recoveredFromExpiredLease,
      };
    },

    async copyJobFile({ filePath, ...fence }) {
      const job = findFenced(fence);

      if (!job?.fileBytes) {
        return false;
      }

      await writeFile(filePath, job.fileBytes);
      return true;
    },

    async pruneFinished({ olderThanMs }) {
      const cutoff = now() - Math.max(0, Math.floor(Number(olderThanMs) || 0));
      let removed = 0;

      for (const [jobId, job] of jobs) {
        if (!isPending(job) && job.finishedAt !== null && job.finishedAt < cutoff) {
          jobs.delete(jobId);
          removed += 1;
        }
      }

      return removed;
    },

    async renew({ leaseMs, ...fence }) {
      const job = findFenced(fence);

      if (!job) {
        return false;
      }

      job.leaseExpiresAt = now() + Math.max(1, Math.floor(Number(leaseMs)));
      job.updatedAt = now();
      return true;
    },

    async succeed(fence) {
      const job = findFenced(fence);

      if (!job) {
        return false;
      }

      job.lastError = null;
      finish(job, INGEST_JOB_STATUSES.succeeded, now());
      return true;
    },

    async fail({ error, retryDelayMs = 0, retryable = true, ...fence }) {
      const job = findFenced(fence);

      if (!job) {
        return null;
      }

      const currentTime = now();

      job.lastError = toIngestJobErrorMessage(error);

      if (retryable && job.attemptCount < job.maxAttempts) {
        job.status = INGEST_JOB_STATUSES.queued;
        job.availableAt = currentTime + Math.max(0, Math.floor(Number(retryDelayMs) || 0));
        job.leaseExpiresAt = null;
        job.updatedAt = currentTime;
      } else {
        finish(job, INGEST_JOB_STATUSES.failed, currentTime);
      }

      return job.status;
    },

    async release(fence) {
      const job = findFenced(fence);

      if (!job) {
        return false;
      }

      job.status = INGEST_JOB_STATUSES.queued;
      job.availableAt = now();
      job.attemptCount = Math.max(0, job.attemptCount - 1);
      job.claimedBy = null;
      job.leaseExpiresAt = null;
      job.updatedAt = now();
      subscribers.wake();
      return true;
    },

    async reset() {
      jobs.clear();
      return true;
    },
  };
};

/**
 * PostgreSQL whenever a database is configured; otherwise (the standalone
 * profile clears the URLs) the in-memory queue, whose worker must then run in
 * the API process.
 */
export const createDefaultIngestJobStore = ({
  postgresConfigured = isPostgresDatabaseConfigured(),
} = {}) =>
  postgresConfigured ? createPostgresIngestJobStore() : createInMemoryIngestJobStore();
