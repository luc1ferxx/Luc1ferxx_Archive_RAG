import { randomUUID } from "node:crypto";
import { open, writeFile } from "node:fs/promises";

import {
  getDocumentsPostgresTable,
  getIngestJobOutputsPostgresTable,
  getIngestJobsPostgresTable,
  getRagIngestMaxPendingBytesPerTenant,
  getRagIngestMaxPendingJobsPerTenant,
  getRagIngestStageRetryPolicy,
  isPostgresDatabaseConfigured,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import {
  documentMatchesAccessScope,
  findDocumentByContentHash,
  hasDocument,
  normalizeContentSha256,
} from "./doc-registry.js";
import {
  INGEST_JOB_KINDS,
  INGEST_STAGE_OUTPUTS,
  INGEST_STAGES,
  isIngestStage,
} from "./ingest-stages.js";
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
//
// Staged jobs (migration 017, rag/ingest-pipeline.js). A job runs parse ->
// chunk -> embed -> index; `stage` is the stage its next attempt runs:
//
// - claim() also counts the attempt against the current stage
//   (stage_attempts); max_attempts is that stage's budget
//   (RAG_INGEST_<STAGE>_MAX_ATTEMPTS). Exhausting it moves the job to
//   dead_letter with the stage and a reason, never to failed: a dead-letter
//   job keeps its bytes and stage outputs, and requeue() resumes it at that
//   stage. failed stays for an upload a retry cannot fix (no extractable text).
// - advanceStage() stores the finished stage's output, moves the PDF out of
//   the job row into the `document_file` output when parse finishes, and
//   makes the next stage current with its own budget, fenced like every write.
// - readOutputs()/copyOutputFile() hand a claimed attempt the outputs it needs.
// - completeInTransaction() records success on the index stage's own write
//   transaction, so the document commit and the job's success are one COMMIT.
// - enqueue() with `deduplicate` and a content hash answers bytes the tenant
//   already stored with a job that is already succeeded (duplicate, resolved
//   to that document); the index stage checks again under a lock.
// - listDeadLetters()/requeue() are scoped to an access scope (the request's)
//   or an exact owner (the CLI); countByStatus() is for health.

export const INGEST_JOB_STATUSES = Object.freeze({
  deadLetter: "dead_letter",
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
export const LEASE_EXHAUSTED_DEAD_LETTER_REASON =
  "The worker's lease expired during the last allowed attempt of this stage (the worker stopped or was killed).";
const MAX_DEAD_LETTER_REASON_LENGTH = 500;

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

/**
 * What GET /ingest-jobs/:jobId answers. `docId` is the document the job
 * resolved to (an upload of bytes the tenant already stored resolves to that
 * document, `duplicate: true`). A dead-letter job reads as `failed`, the
 * terminal status clients already stop polling on, with `deadLetter` saying at
 * which stage it gave up; an operator can still requeue it.
 */
export const toPublicIngestJob = (job) =>
  job
    ? {
        jobId: job.jobId,
        docId: job.resolvedDocId || job.docId,
        fileName: job.fileName,
        status: job.status === INGEST_JOB_STATUSES.deadLetter ? INGEST_JOB_STATUSES.failed : job.status,
        attemptCount: job.attemptCount,
        error: job.lastError ? toIngestJobErrorMessage(job.lastError) : null,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        kind: job.kind ?? INGEST_JOB_KINDS.create,
        stage: job.stage ?? INGEST_STAGES[0],
        duplicate: job.duplicate === true,
        // A replacement whose bytes were discarded: a newer replacement of the
        // document was requested before it, and that content stays.
        superseded: job.superseded === true,
        documentVersion: job.documentVersion ?? null,
        deadLetter:
          job.status === INGEST_JOB_STATUSES.deadLetter
            ? { stage: job.deadLetterStage ?? job.stage ?? null, deadLetteredAt: job.deadLetteredAt ?? null }
            : null,
      }
    : null;

/** What the dead-letter listing (CLI, admin route) shows an operator. */
export const toDeadLetterIngestJob = (job) =>
  job
    ? {
        ...toPublicIngestJob(job),
        status: job.status,
        ownerUserId: job.ownerUserId,
        workspaceId: job.workspaceId,
        requestedDocId: job.docId,
        stageAttempts: job.stageAttempts,
        maxAttempts: job.maxAttempts,
        requeueCount: job.requeueCount ?? 0,
        deadLetter:
          job.status === INGEST_JOB_STATUSES.deadLetter
            ? {
                deadLetteredAt: job.deadLetteredAt ?? null,
                reason: job.deadLetterReason ?? null,
                stage: job.deadLetterStage ?? job.stage ?? null,
              }
            : null,
      }
    : null;

export const toDeadLetterReason = (reason) =>
  String(reason ?? "")
    .split(/\r?\n/, 1)[0]
    .trim()
    .slice(0, MAX_DEAD_LETTER_REASON_LENGTH) || null;

// Every stage's current budget, for a requeue that restarts the stage's count.
export const getIngestStageMaxAttempts = (policy = getRagIngestStageRetryPolicy) =>
  Object.fromEntries(INGEST_STAGES.map((stage) => [stage, policy(stage).maxAttempts]));

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

const getFirstStageMaxAttempts = () => getRagIngestStageRetryPolicy(INGEST_STAGES[0]).maxAttempts;

const normalizeEnqueueInput = ({
  contentSha256 = null,
  deduplicate = false,
  docId,
  fileBytes,
  fileName,
  jobId = randomUUID(),
  kind = INGEST_JOB_KINDS.create,
  maxAttempts = getFirstStageMaxAttempts(),
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

  if (!Object.values(INGEST_JOB_KINDS).includes(kind)) {
    throw new Error(`An ingest job's kind must be create or replace. Received "${kind}".`);
  }

  const hash = normalizeContentSha256(contentSha256);

  return {
    contentSha256: hash,
    // Only a new document is ever resolved to an existing one.
    deduplicate: kind === INGEST_JOB_KINDS.create && Boolean(deduplicate) && Boolean(hash),
    docId: normalizedDocId,
    fileBytes: Buffer.from(fileBytes),
    fileName: normalizeText(fileName),
    jobId: normalizeText(jobId) || randomUUID(),
    kind,
    maxAttempts: toPositiveInteger(maxAttempts, getFirstStageMaxAttempts()),
    ownerUserId: normalizeText(ownerUserId),
    workspaceId: normalizeText(workspaceId),
  };
};

const normalizeOutputName = (name) => {
  if (!Object.values(INGEST_STAGE_OUTPUTS).includes(name)) {
    throw new Error(`Unknown ingest stage output "${name}".`);
  }

  return name;
};

const normalizeStage = (stage) => {
  if (!isIngestStage(stage)) {
    throw new Error(`Unknown ingest stage "${stage}".`);
  }

  return stage;
};

const toResolvedDocId = (job, docId) => {
  const resolved = normalizeText(docId);

  return resolved && resolved !== job?.docId ? resolved : null;
};

const toDocumentVersion = (value) => {
  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
  created_at, updated_at, started_at, finished_at, kind, stage, stage_attempts,
  content_sha256, deduplicate, resolved_doc_id, duplicate, document_version,
  dead_letter_stage, dead_letter_reason, dead_lettered_at, requeue_count, superseded
`;

const prefixColumns = (alias) =>
  JOB_COLUMNS.split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");

const toOptionalNumber = (value) =>
  value === null || value === undefined ? null : Number(value);

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
  kind: row.kind ?? INGEST_JOB_KINDS.create,
  stage: row.stage ?? INGEST_STAGES[0],
  stageAttempts: Number(row.stage_attempts ?? row.attempt_count ?? 0),
  contentSha256: row.content_sha256 ?? null,
  deduplicate: row.deduplicate === true,
  resolvedDocId: row.resolved_doc_id ?? null,
  duplicate: row.duplicate === true,
  documentVersion: toOptionalNumber(row.document_version),
  deadLetterStage: row.dead_letter_stage ?? null,
  deadLetterReason: row.dead_letter_reason ?? null,
  deadLetteredAt: toIsoText(row.dead_lettered_at),
  requeueCount: Number(row.requeue_count ?? 0),
  superseded: row.superseded === true,
});

// The fence every write after the claim carries.
const FENCE_SQL = `
  job_id = $1 AND claimed_by = $2 AND attempt_count = $3 AND status = 'running'
`;

// The same fence on the jobs table aliased `j`, for statements that join it.
const JOINED_FENCE_SQL = `
  j.job_id = $1 AND j.claimed_by = $2 AND j.attempt_count = $3 AND j.status = 'running'
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

// The visibility rule of documentMatchesAccessScope (and of the row policy) in
// SQL, over the jobs table aliased `j`, for a scope starting at parameter
// $first; an empty scope sees every job. `owner` narrows to one exact owner.
const buildScopeSql = (first) => `
  (
    ($${first}::text = '' AND $${first + 1}::text = '')
    OR (
      (j.owner_user_id <> '' OR j.workspace_id <> '')
      AND (j.owner_user_id = '' OR j.owner_user_id = $${first}::text)
      AND (j.workspace_id = '' OR j.workspace_id = $${first + 1}::text)
    )
  )
  AND ($${first + 2}::boolean = FALSE OR (j.owner_user_id = $${first + 3}::text AND j.workspace_id = $${first + 4}::text))
`;

const scopeValues = ({ accessScope = {}, owner = null } = {}) => [
  normalizeText(accessScope?.userId),
  normalizeText(accessScope?.workspaceId),
  Boolean(owner),
  normalizeText(owner?.ownerUserId),
  normalizeText(owner?.workspaceId),
];

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

const resolveQueryFor = (queryPostgres, client) =>
  client && typeof client.query === "function"
    ? (sql, values = []) => client.query(sql, values)
    : queryPostgres;

export const createPostgresIngestJobStore = ({
  createListenClient = createDedicatedPostgresClient,
  fileReadChunkBytes = FILE_READ_CHUNK_BYTES,
  getDocumentsTable = getDocumentsPostgresTable,
  getOutputsTable = null,
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
  // `<jobs table>_outputs` unless a test names another (migration 017).
  const outputsTableName = () =>
    ensureTableName(
      getOutputsTable
        ? getOutputsTable()
        : getTable === getIngestJobsPostgresTable
          ? getIngestJobOutputsPostgresTable()
          : `${getTable()}_outputs`,
      "INGEST_JOBS_POSTGRES_TABLE"
    );
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

  // Reads one bytea value in slices, into `sink(part)`, so neither a large
  // PDF nor its hex text form is held at once. False when `sizeSql` finds no
  // value (the attempt lost the job, or nothing is stored).
  const readInSlices = async ({ partSql, sink, sizeSql, values }) => {
    const sizeResult = await queryPostgres(sizeSql, values);
    const size = sizeResult.rows[0]?.size;

    if (size === null || size === undefined) {
      return false;
    }

    for (let offset = 0; offset < Number(size); offset += fileReadChunkBytes) {
      const slice = await queryPostgres(partSql, [...values, offset + 1, fileReadChunkBytes]);
      const part = slice.rows[0]?.part;

      if (!part) {
        return false;
      }

      await sink(part);
    }

    return true;
  };

  const outputSizeSql = () => `
    SELECT octet_length(o.payload) AS size
    FROM ${outputsTableName()} AS o
    JOIN ${tableName()} AS j ON j.job_id = o.job_id
    WHERE ${JOINED_FENCE_SQL}
      AND o.output = $4
  `;

  const outputPartSql = () => `
    SELECT substring(o.payload FROM $5::integer FOR $6::integer) AS part
    FROM ${outputsTableName()} AS o
    JOIN ${tableName()} AS j ON j.job_id = o.job_id
    WHERE ${JOINED_FENCE_SQL}
      AND o.output = $4
  `;

  const findDuplicate = async (job) => {
    const result = await queryPostgres(
      `
        SELECT doc_id, content_version
        FROM ${documentsTableName()}
        WHERE owner_user_id = $1
          AND workspace_id = $2
          AND content_sha256 = $3
        ORDER BY uploaded_at ASC, doc_id ASC
        LIMIT 1
      `,
      [job.ownerUserId, job.workspaceId, job.contentSha256]
    );
    const row = result.rows[0];

    return row && String(row.doc_id) !== job.docId
      ? { docId: String(row.doc_id), documentVersion: toDocumentVersion(row.content_version) }
      : null;
  };

  // A job whose bytes the tenant already stored: recorded succeeded at once,
  // resolved to that document, without its bytes and without a NOTIFY.
  const insertResolvedDuplicate = async (job, duplicate) => {
    const result = await queryPostgres(
      `
        INSERT INTO ${tableName()} (
          job_id, doc_id, owner_user_id, workspace_id, file_name, file_bytes, status,
          max_attempts, kind, stage, content_sha256, deduplicate, resolved_doc_id,
          duplicate, document_version, finished_at
        )
        VALUES ($1, $2, $3, $4, $5, NULL, 'succeeded', $6, 'create', 'index', $7, TRUE, $8, TRUE, $9, NOW())
        RETURNING ${JOB_COLUMNS}
      `,
      [
        job.jobId,
        job.docId,
        job.ownerUserId,
        job.workspaceId,
        job.fileName,
        job.maxAttempts,
        job.contentSha256,
        duplicate.docId,
        duplicate.documentVersion,
      ]
    );

    return mapRowToJob(result.rows[0]);
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
    // running jobs, counting the bytes a job still holds in its row and in its
    // stage outputs. Two concurrent uploads can both pass the check, so a cap
    // may be exceeded by the number of uploads racing it; that bounds a
    // runaway client, which is what it is for.
    //
    // The NOTIFY is part of the same statement, so it is sent when the INSERT
    // commits and not at all when the cap refuses the job or the insert rolls
    // back. Its payload is this store's id and nothing about the job.
    async enqueue(input) {
      const job = normalizeEnqueueInput(input);
      const table = tableName();

      if (job.deduplicate) {
        const duplicate = await findDuplicate(job);

        if (duplicate) {
          return insertResolvedDuplicate(job, duplicate);
        }
      }

      const { maxPendingBytes, maxPendingJobs } = getPendingLimits();
      const result = await queryPostgres(
        `
          WITH inserted AS (
            INSERT INTO ${table} (
              job_id, doc_id, owner_user_id, workspace_id, file_name, file_bytes, status, max_attempts,
              kind, content_sha256, deduplicate
            )
            SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::bytea, 'queued', $7::integer,
                   $12::text, $13::text, $14::boolean
            FROM (
              SELECT COUNT(*) AS pending_jobs,
                     COALESCE(SUM(
                       COALESCE(octet_length(p.file_bytes), 0)
                       + COALESCE((SELECT SUM(o.byte_size) FROM ${outputsTableName()} AS o WHERE o.job_id = p.job_id), 0)
                     ), 0) AS pending_bytes
              FROM ${table} AS p
              WHERE p.owner_user_id = $3::text
                AND p.workspace_id = $4::text
                AND p.status IN ('queued', 'running')
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
          job.kind,
          job.contentSha256,
          job.deduplicate,
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
        // A job whose current stage's last allowed attempt died is settled,
        // not claimed. A new document whose row exists committed and died
        // before recording success (a one-step ingest; a staged index stage
        // records success in its own transaction), so that job succeeded.
        // Anything else goes to dead_letter at its stage, keeping its bytes
        // and outputs for a requeue.
        await queryPostgres(
          `
            WITH settled AS (
            UPDATE ${table} AS j
            SET status = CASE WHEN committed.doc_id IS NULL THEN 'dead_letter' ELSE 'succeeded' END,
                last_error = CASE WHEN committed.doc_id IS NULL THEN $1 ELSE NULL END,
                dead_letter_stage = CASE WHEN committed.doc_id IS NULL THEN expired.stage ELSE NULL END,
                dead_letter_reason = CASE WHEN committed.doc_id IS NULL THEN $2 ELSE NULL END,
                dead_lettered_at = CASE WHEN committed.doc_id IS NULL THEN NOW() ELSE NULL END,
                file_bytes = CASE WHEN committed.doc_id IS NULL THEN j.file_bytes ELSE NULL END,
                lease_expires_at = NULL,
                finished_at = NOW(),
                updated_at = NOW()
            FROM ${table} AS expired
            LEFT JOIN ${documentsTable} AS committed
              ON committed.doc_id = expired.doc_id AND expired.kind = 'create'
            WHERE j.job_id = expired.job_id
              AND expired.status = 'running'
              AND expired.lease_expires_at < NOW()
              AND expired.stage_attempts >= expired.max_attempts
            RETURNING j.job_id, j.status
            )
            -- A job settled as succeeded holds nothing an operator needs: its
            -- stage outputs go with its bytes, as on any other success.
            DELETE FROM ${outputsTableName()} AS o
            USING settled
            WHERE o.job_id = settled.job_id AND settled.status = 'succeeded'
          `,
          [LEASE_EXHAUSTED_ERROR_MESSAGE, LEASE_EXHAUSTED_DEAD_LETTER_REASON]
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
                   AND c.stage_attempts < c.max_attempts
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
                stage_attempts = j.stage_attempts + 1,
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
     * or the job holds no bytes (they moved to the `document_file` output when
     * parse finished).
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

    /** Writes one stage output of the claimed attempt's job to `filePath`. */
    async copyOutputFile({ filePath, output, ...fence }) {
      const name = normalizeOutputName(output);

      return runAsSystem(async () => {
        const handle = await open(filePath, "w");

        try {
          return await readInSlices({
            partSql: outputPartSql(),
            sink: (part) => handle.write(part),
            sizeSql: outputSizeSql(),
            values: [...fenceValues(fence), name],
          });
        } finally {
          await handle.close();
        }
      });
    },

    /**
     * The named stage outputs of the claimed attempt's job, as Buffers keyed
     * by name (a missing one is absent). Null when the attempt lost the job.
     */
    async readOutputs({ outputs = [], ...fence }) {
      const names = [...new Set(outputs.map(normalizeOutputName))];

      return runAsSystem(async () => {
        const holds = await queryPostgres(
          `SELECT job_id FROM ${tableName()} WHERE ${FENCE_SQL}`,
          fenceValues(fence)
        );

        if (!holds.rows[0]) {
          return null;
        }

        const read = {};

        for (const name of names) {
          const parts = [];
          const found = await readInSlices({
            partSql: outputPartSql(),
            sink: (part) => {
              parts.push(Buffer.from(part));
            },
            sizeSql: outputSizeSql(),
            values: [...fenceValues(fence), name],
          });

          if (found) {
            read[name] = Buffer.concat(parts);
          }
        }

        return read;
      });
    },

    /**
     * Stores the finished stage's `output` ({ name, payload }) and makes
     * `toStage` current, with a fresh count against `maxAttempts` (its
     * budget) and a renewed lease, in one statement fenced on the attempt and
     * on `fromStage`. `moveDocumentFile` (when parse finishes) moves the PDF
     * from the job row into the `document_file` output inside the database.
     */
    async advanceStage({
      fromStage,
      leaseMs,
      maxAttempts,
      moveDocumentFile = false,
      output = null,
      toStage,
      ...fence
    }) {
      const outputName = output ? normalizeOutputName(output.name) : null;
      const payload = output ? Buffer.from(output.payload ?? []) : null;
      const table = tableName();
      const outputsTable = outputsTableName();
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            WITH job AS (
              SELECT job_id, owner_user_id, workspace_id, file_bytes
              FROM ${table}
              WHERE ${FENCE_SQL}
                AND stage = $4
              FOR UPDATE
            ),
            moved AS (
              INSERT INTO ${outputsTable} (job_id, output, payload, byte_size, owner_user_id, workspace_id)
              SELECT job_id, 'document_file', file_bytes, octet_length(file_bytes), owner_user_id, workspace_id
              FROM job
              WHERE $6::boolean AND file_bytes IS NOT NULL
              ON CONFLICT (job_id, output) DO UPDATE
                SET payload = EXCLUDED.payload, byte_size = EXCLUDED.byte_size, created_at = NOW()
              RETURNING job_id
            ),
            written AS (
              INSERT INTO ${outputsTable} (job_id, output, payload, byte_size, owner_user_id, workspace_id)
              SELECT job_id, $7::text, $8::bytea, octet_length($8::bytea), owner_user_id, workspace_id
              FROM job
              WHERE $7::text IS NOT NULL
              ON CONFLICT (job_id, output) DO UPDATE
                SET payload = EXCLUDED.payload, byte_size = EXCLUDED.byte_size, created_at = NOW()
              RETURNING job_id
            )
            UPDATE ${table} AS t
            SET stage = $5,
                stage_attempts = 1,
                max_attempts = $9::integer,
                file_bytes = CASE WHEN $6::boolean THEN NULL ELSE t.file_bytes END,
                lease_expires_at = NOW() + ($10::bigint * INTERVAL '1 millisecond'),
                updated_at = NOW()
            FROM job
            WHERE t.job_id = job.job_id
            RETURNING t.stage
          `,
          [
            ...fenceValues(fence),
            normalizeStage(fromStage),
            normalizeStage(toStage),
            Boolean(moveDocumentFile),
            outputName,
            payload,
            toPositiveInteger(maxAttempts, 1),
            Math.max(1, Math.floor(Number(leaseMs) || 1)),
          ]
        )
      );

      if (result.rows.length > 0) {
        return true;
      }

      // Nothing matched: either the attempt lost the job, or this is a retry
      // of a call whose COMMIT went through and whose answer was lost. Only
      // this claim can have moved the job to `toStage` under this fence (a
      // claim is the only other writer of the stage, and it changes the fence),
      // and the output was stored in that same statement: done, not lost.
      const advanced = await runAsSystem(() =>
        queryPostgres(
          `
            SELECT 1
            FROM ${table}
            WHERE ${FENCE_SQL}
              AND stage = $4
              AND stage_attempts = 1
              AND ($5::text IS NULL OR EXISTS (
                SELECT 1 FROM ${outputsTable} AS o WHERE o.job_id = $1 AND o.output = $5::text
              ))
          `,
          [...fenceValues(fence), normalizeStage(toStage), outputName]
        )
      );

      return advanced.rows.length > 0;
    },

    /**
     * Records the job succeeded on `client`, the index stage's own write
     * transaction (under the job's tenant), so the document and the job's
     * outcome commit together. False when the attempt no longer holds the
     * job; the caller must then roll the write back.
     */
    async completeInTransaction({
      client,
      docId = null,
      documentVersion = null,
      duplicate = false,
      superseded = false,
      ...fence
    }) {
      const result = await resolveQueryFor(queryPostgres, client)(
        `
          UPDATE ${tableName()}
          SET status = 'succeeded',
              file_bytes = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              resolved_doc_id = CASE WHEN $4::text IS NOT NULL AND $4::text <> doc_id THEN $4::text ELSE NULL END,
              duplicate = $5::boolean,
              document_version = $6::integer,
              superseded = $7::boolean,
              finished_at = NOW(),
              updated_at = NOW()
          WHERE ${FENCE_SQL}
          RETURNING job_id
        `,
        [
          ...fenceValues(fence),
          normalizeText(docId) || null,
          Boolean(duplicate),
          toDocumentVersion(documentVersion),
          Boolean(superseded),
        ]
      );

      return result.rows.length > 0;
    },

    /** Drops the stage outputs of a job that has finished (succeeded or failed). */
    async discardOutputs(jobId) {
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            DELETE FROM ${outputsTableName()} AS o
            USING ${tableName()} AS j
            WHERE o.job_id = j.job_id
              AND j.job_id = $1
              AND j.status IN ('succeeded', 'failed')
          `,
          [normalizeText(jobId)]
        )
      );

      return result.rowCount ?? 0;
    },

    async pruneFinished({ olderThanMs }) {
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            DELETE FROM ${tableName()}
            WHERE status IN ('succeeded', 'failed', 'dead_letter')
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

    // Success recorded after the write (a one-step ingest, a provider without
    // transactions, or a job resolved before any stage ran). `result` names
    // the document the job resolved to.
    async succeed(fence, { docId = null, documentVersion = null, duplicate = false, superseded = false } = {}) {
      const table = tableName();
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            WITH succeeded AS (
              UPDATE ${table}
              SET status = 'succeeded',
                  file_bytes = NULL,
                  lease_expires_at = NULL,
                  last_error = NULL,
                  resolved_doc_id = CASE WHEN $4::text IS NOT NULL AND $4::text <> doc_id THEN $4::text ELSE NULL END,
                  duplicate = $5::boolean,
                  document_version = COALESCE($6::integer, document_version),
                  superseded = $7::boolean,
                  finished_at = NOW(),
                  updated_at = NOW()
              WHERE ${FENCE_SQL}
              RETURNING job_id
            ),
            dropped AS (
              DELETE FROM ${outputsTableName()} AS o
              USING succeeded
              WHERE o.job_id = succeeded.job_id
            )
            SELECT job_id FROM succeeded
          `,
          [
            ...fenceValues(fence),
            normalizeText(docId) || null,
            Boolean(duplicate),
            toDocumentVersion(documentVersion),
            Boolean(superseded),
          ]
        )
      );

      return result.rows.length > 0;
    },

    // A retryable failure requeues the job at its current stage after the
    // delay while the stage has attempts left, and moves it to dead_letter
    // (keeping its bytes and outputs, with the stage and `deadLetterReason`)
    // once it has none. A failure the upload itself caused (not retryable)
    // fails the job and drops what it holds.
    async fail({ deadLetterReason = null, error, retryDelayMs = 0, retryable = true, ...fence }) {
      const table = tableName();
      const result = await runAsSystem(() =>
        queryPostgres(
          `
            WITH settled AS (
              UPDATE ${table}
              SET status = CASE WHEN NOT $4::boolean THEN 'failed'
                                WHEN stage_attempts < max_attempts THEN 'queued'
                                ELSE 'dead_letter' END,
                  available_at = CASE WHEN $4::boolean AND stage_attempts < max_attempts
                                   THEN NOW() + ($5::bigint * INTERVAL '1 millisecond')
                                   ELSE available_at END,
                  file_bytes = CASE WHEN $4::boolean THEN file_bytes ELSE NULL END,
                  finished_at = CASE WHEN $4::boolean AND stage_attempts < max_attempts
                                  THEN NULL ELSE NOW() END,
                  dead_letter_stage = CASE WHEN $4::boolean AND stage_attempts >= max_attempts
                                        THEN stage ELSE NULL END,
                  dead_letter_reason = CASE WHEN $4::boolean AND stage_attempts >= max_attempts
                                         THEN $7::text ELSE NULL END,
                  dead_lettered_at = CASE WHEN $4::boolean AND stage_attempts >= max_attempts
                                       THEN NOW() ELSE NULL END,
                  lease_expires_at = NULL,
                  last_error = $6,
                  updated_at = NOW()
              WHERE ${FENCE_SQL}
              RETURNING job_id, status
            ),
            dropped AS (
              DELETE FROM ${outputsTableName()} AS o
              USING settled
              WHERE o.job_id = settled.job_id AND settled.status = 'failed'
            )
            SELECT status FROM settled
          `,
          [
            ...fenceValues(fence),
            Boolean(retryable),
            Math.max(0, Math.floor(Number(retryDelayMs) || 0)),
            toIngestJobErrorMessage(error),
            toDeadLetterReason(deadLetterReason) ?? toIngestJobErrorMessage(error),
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
                  stage_attempts = GREATEST(stage_attempts - 1, 0),
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

    /**
     * Dead-letter jobs `accessScope` can see (by the documents' visibility
     * rule; under a request's tenant the row policy applies too), or exactly
     * `owner`'s ({ ownerUserId, workspaceId }), newest first.
     */
    async listDeadLetters({ accessScope = {}, limit = 50, owner = null } = {}) {
      const result = await queryPostgres(
        `
          SELECT ${prefixColumns("j")}
          FROM ${tableName()} AS j
          WHERE j.status = 'dead_letter'
            AND ${buildScopeSql(1)}
          ORDER BY j.dead_lettered_at DESC NULLS LAST, j.job_id ASC
          LIMIT $6
        `,
        [...scopeValues({ accessScope, owner }), Math.min(500, toPositiveInteger(limit, 50))]
      );

      return result.rows.map(mapRowToJob);
    },

    /**
     * Puts a dead-letter job back in the queue at the stage it died in, with
     * that stage's full budget (`maxAttemptsByStage`, the current settings),
     * and wakes the workers. Null when the scope cannot see such a job.
     */
    async requeue({
      accessScope = {},
      jobId,
      maxAttemptsByStage = getIngestStageMaxAttempts(),
      owner = null,
    }) {
      const table = tableName();
      const result = await queryPostgres(
        `
          WITH requeued AS (
            UPDATE ${table} AS j
            SET status = 'queued',
                available_at = NOW(),
                stage_attempts = 0,
                max_attempts = CASE j.stage
                                 WHEN 'parse' THEN $6::integer
                                 WHEN 'chunk' THEN $7::integer
                                 WHEN 'embed' THEN $8::integer
                                 ELSE $9::integer END,
                claimed_by = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                dead_letter_stage = NULL,
                dead_letter_reason = NULL,
                dead_lettered_at = NULL,
                finished_at = NULL,
                requeue_count = j.requeue_count + 1,
                updated_at = NOW()
            WHERE j.job_id = $10
              AND j.status = 'dead_letter'
              AND ${buildScopeSql(1)}
            RETURNING ${prefixColumns("j")}
          )
          SELECT requeued.*, pg_notify($11::text, $12::text) AS notified
          FROM requeued
        `,
        [
          ...scopeValues({ accessScope, owner }),
          ...INGEST_STAGES.map((stage) => toPositiveInteger(maxAttemptsByStage?.[stage], 1)),
          normalizeText(jobId),
          getIngestJobsNotifyChannel(table),
          instanceId,
        ]
      );

      if (!result.rows[0]) {
        return null;
      }

      subscribers.wake();
      return mapRowToJob(result.rows[0]);
    },

    /** Jobs per status, over every tenant (health). */
    async countByStatus() {
      const result = await runAsSystem(() =>
        queryPostgres(`SELECT status, COUNT(*)::int AS count FROM ${tableName()} GROUP BY status`)
      );
      const counts = Object.fromEntries(Object.values(INGEST_JOB_STATUSES).map((status) => [status, 0]));

      for (const row of result.rows) {
        counts[String(row.status)] = Number(row.count) || 0;
      }

      return counts;
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
 * one-step job like the PostgreSQL sweep does; this process's registry map is
 * the record there, because without PostgreSQL the registry is written before
 * the map is. `findDuplicateDocument` resolves an enqueue with `deduplicate`
 * (by default from the registry, which this process alone writes here).
 */
const findDuplicateInRegistry = async ({ contentSha256, ownerUserId, workspaceId }) => {
  const document = await findDocumentByContentHash(contentSha256, { ownerUserId, workspaceId });

  return document ? { docId: document.docId, documentVersion: document.version ?? null } : null;
};

export const createInMemoryIngestJobStore = ({
  findDuplicateDocument = findDuplicateInRegistry,
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
  const outputBytes = (job) =>
    [...job.outputs.values()].reduce((total, payload) => total + payload.length, 0);

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
    kind: job.kind,
    stage: job.stage,
    stageAttempts: job.stageAttempts,
    contentSha256: job.contentSha256,
    deduplicate: job.deduplicate,
    resolvedDocId: job.resolvedDocId,
    duplicate: job.duplicate,
    documentVersion: job.documentVersion,
    superseded: job.superseded === true,
    deadLetterStage: job.deadLetterStage,
    deadLetterReason: job.deadLetterReason,
    deadLetteredAt: toIsoText(job.deadLetteredAt),
    requeueCount: job.requeueCount,
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

  const finish = (job, status, currentTime, { keepHoldings = false } = {}) => {
    job.status = status;

    if (!keepHoldings) {
      job.fileBytes = null;
      job.outputs.clear();
    }

    job.leaseExpiresAt = null;
    job.finishedAt = currentTime;
    job.updatedAt = currentTime;
  };

  const deadLetter = (job, currentTime, reason) => {
    job.deadLetterStage = job.stage;
    job.deadLetterReason = toDeadLetterReason(reason);
    job.deadLetteredAt = currentTime;
    finish(job, INGEST_JOB_STATUSES.deadLetter, currentTime, { keepHoldings: true });
  };

  const recordSuccess = (job, { docId = null, documentVersion = null, duplicate = false, superseded = false } = {}) => {
    job.lastError = null;
    job.resolvedDocId = toResolvedDocId(job, docId);
    job.duplicate = Boolean(duplicate);
    job.superseded = Boolean(superseded);
    job.documentVersion = toDocumentVersion(documentVersion) ?? job.documentVersion;
    finish(job, INGEST_JOB_STATUSES.succeeded, now());
  };

  const matchesScope = (job, { accessScope = {}, owner = null } = {}) =>
    ingestJobMatchesAccessScope(job, accessScope) &&
    (!owner ||
      (job.ownerUserId === normalizeText(owner.ownerUserId) &&
        job.workspaceId === normalizeText(owner.workspaceId)));

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

      const base = {
        ...normalized,
        attemptCount: 0,
        claimedBy: null,
        createdAt: currentTime,
        deadLetterReason: null,
        deadLetterStage: null,
        deadLetteredAt: null,
        documentVersion: null,
        duplicate: false,
        finishedAt: null,
        lastError: null,
        leaseExpiresAt: null,
        availableAt: currentTime,
        outputs: new Map(),
        requeueCount: 0,
        resolvedDocId: null,
        stage: INGEST_STAGES[0],
        stageAttempts: 0,
        startedAt: null,
        updatedAt: currentTime,
      };

      if (normalized.deduplicate) {
        let duplicate = null;

        // Only a shortcut: the index stage checks again under its lock, so a
        // lookup that fails queues the job instead of failing the upload.
        try {
          duplicate = await findDuplicateDocument(normalized);
        } catch (error) {
          logger.warn?.("[ingest-jobs] the duplicate lookup failed; queueing the upload.", error);
        }

        if (duplicate && duplicate.docId !== normalized.docId) {
          const job = {
            ...base,
            documentVersion: toDocumentVersion(duplicate.documentVersion),
            duplicate: true,
            fileBytes: null,
            finishedAt: currentTime,
            resolvedDocId: duplicate.docId,
            stage: "index",
            status: INGEST_JOB_STATUSES.succeeded,
          };

          jobs.set(job.jobId, job);
          return snapshot(job);
        }
      }

      const { maxPendingBytes, maxPendingJobs } = getPendingLimits();
      const pending = [...jobs.values()].filter(
        (job) => isPending(job) && tenantKey(job) === tenantKey(normalized)
      );
      const pendingBytes = pending.reduce(
        (total, job) => total + (job.fileBytes?.length ?? 0) + outputBytes(job),
        0
      );

      if (
        (maxPendingJobs > 0 && pending.length >= maxPendingJobs) ||
        (maxPendingBytes > 0 && pendingBytes + normalized.fileBytes.length > maxPendingBytes)
      ) {
        throw createPendingLimitError();
      }

      const job = { ...base, status: INGEST_JOB_STATUSES.queued };

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

        if (leaseExpired && job.stageAttempts >= job.maxAttempts) {
          const committed =
            job.kind === INGEST_JOB_KINDS.create && Boolean(isDocumentCommitted(job.docId));

          if (committed) {
            job.lastError = null;
            finish(job, INGEST_JOB_STATUSES.succeeded, currentTime);
          } else {
            job.lastError = LEASE_EXHAUSTED_ERROR_MESSAGE;
            deadLetter(job, currentTime, LEASE_EXHAUSTED_DEAD_LETTER_REASON);
          }

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
      claimable.stageAttempts += 1;
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

    async copyOutputFile({ filePath, output, ...fence }) {
      const payload = findFenced(fence)?.outputs.get(normalizeOutputName(output));

      if (!payload) {
        return false;
      }

      await writeFile(filePath, payload);
      return true;
    },

    async readOutputs({ outputs = [], ...fence }) {
      const job = findFenced(fence);

      if (!job) {
        return null;
      }

      const read = {};

      for (const name of outputs.map(normalizeOutputName)) {
        if (job.outputs.has(name)) {
          read[name] = Buffer.from(job.outputs.get(name));
        }
      }

      return read;
    },

    async advanceStage({
      fromStage,
      leaseMs,
      maxAttempts,
      moveDocumentFile = false,
      output = null,
      toStage,
      ...fence
    }) {
      const job = findFenced(fence);
      const from = normalizeStage(fromStage);
      const to = normalizeStage(toStage);

      // A retry of a call that already advanced (same fence, the next stage's
      // first attempt, its output stored) succeeded, like the PostgreSQL store's.
      if (
        job &&
        job.stage === to &&
        job.stageAttempts === 1 &&
        (!output || job.outputs.has(normalizeOutputName(output.name)))
      ) {
        return true;
      }

      if (!job || job.stage !== from) {
        return false;
      }

      if (moveDocumentFile && job.fileBytes) {
        job.outputs.set(INGEST_STAGE_OUTPUTS.documentFile, Buffer.from(job.fileBytes));
        job.fileBytes = null;
      }

      if (output) {
        job.outputs.set(normalizeOutputName(output.name), Buffer.from(output.payload ?? []));
      }

      job.stage = to;
      job.stageAttempts = 1;
      job.maxAttempts = toPositiveInteger(maxAttempts, 1);
      job.leaseExpiresAt = now() + Math.max(1, Math.floor(Number(leaseMs) || 1));
      job.updatedAt = now();
      return true;
    },

    async discardOutputs(jobId) {
      const job = jobs.get(normalizeText(jobId));

      if (!job || ![INGEST_JOB_STATUSES.succeeded, INGEST_JOB_STATUSES.failed].includes(job.status)) {
        return 0;
      }

      const removed = job.outputs.size;

      job.outputs.clear();
      return removed;
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

    async succeed(fence, result = {}) {
      const job = findFenced(fence);

      if (!job) {
        return false;
      }

      recordSuccess(job, result);
      return true;
    },

    async fail({ deadLetterReason = null, error, retryDelayMs = 0, retryable = true, ...fence }) {
      const job = findFenced(fence);

      if (!job) {
        return null;
      }

      const currentTime = now();

      job.lastError = toIngestJobErrorMessage(error);

      if (!retryable) {
        finish(job, INGEST_JOB_STATUSES.failed, currentTime);
      } else if (job.stageAttempts < job.maxAttempts) {
        job.status = INGEST_JOB_STATUSES.queued;
        job.availableAt = currentTime + Math.max(0, Math.floor(Number(retryDelayMs) || 0));
        job.leaseExpiresAt = null;
        job.updatedAt = currentTime;
      } else {
        deadLetter(job, currentTime, deadLetterReason ?? job.lastError);
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
      job.stageAttempts = Math.max(0, job.stageAttempts - 1);
      job.claimedBy = null;
      job.leaseExpiresAt = null;
      job.updatedAt = now();
      subscribers.wake();
      return true;
    },

    async listDeadLetters({ accessScope = {}, limit = 50, owner = null } = {}) {
      return [...jobs.values()]
        .filter((job) => job.status === INGEST_JOB_STATUSES.deadLetter && matchesScope(job, { accessScope, owner }))
        .sort((left, right) => (right.deadLetteredAt ?? 0) - (left.deadLetteredAt ?? 0))
        .slice(0, Math.min(500, toPositiveInteger(limit, 50)))
        .map((job) => snapshot(job));
    },

    async requeue({ accessScope = {}, jobId, maxAttemptsByStage = getIngestStageMaxAttempts(), owner = null }) {
      const job = jobs.get(normalizeText(jobId));

      if (
        !job ||
        job.status !== INGEST_JOB_STATUSES.deadLetter ||
        !matchesScope(job, { accessScope, owner })
      ) {
        return null;
      }

      const currentTime = now();

      job.status = INGEST_JOB_STATUSES.queued;
      job.availableAt = currentTime;
      job.stageAttempts = 0;
      job.maxAttempts = toPositiveInteger(maxAttemptsByStage?.[job.stage], 1);
      job.claimedBy = null;
      job.leaseExpiresAt = null;
      job.lastError = null;
      job.deadLetterStage = null;
      job.deadLetterReason = null;
      job.deadLetteredAt = null;
      job.finishedAt = null;
      job.requeueCount += 1;
      job.updatedAt = currentTime;
      subscribers.wake();
      return snapshot(job);
    },

    async countByStatus() {
      const counts = Object.fromEntries(Object.values(INGEST_JOB_STATUSES).map((status) => [status, 0]));

      for (const job of jobs.values()) {
        counts[job.status] = (counts[job.status] ?? 0) + 1;
      }

      return counts;
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
