import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getIngestJobsPostgresTable,
  getRagIngestJobLeaseMs,
  getRagIngestJobMaxAttempts,
  getRagIngestJobRetentionMs,
  getRagIngestMaxPendingBytesPerTenant,
  getRagIngestMaxPendingJobsPerTenant,
  getRagIngestMode,
  getRagIngestWorkerConcurrency,
  getRagIngestWorkerPollMs,
  isRagIngestAsync,
  isRagIngestWorkerEnabled,
} from "../rag/config.js";
import { renderMigrationSql } from "../rag/db-migrations.js";
import {
  clearDocuments,
  configureDocumentRegistryStore,
  createDocumentRegistryStore,
  deleteDocument,
  getDocument,
  initializeDocumentRegistry,
  isDocumentRegistryShared,
  listDocuments,
  loadDocumentsFromStore,
  refreshDocumentRegistry,
  registerDocument,
  resetDocumentRegistryStore,
  resyncDocument,
  trackDocumentWrite,
} from "../rag/doc-registry.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import {
  createDefaultIngestJobStore,
  createInMemoryIngestJobStore,
  createPostgresIngestJobStore,
  getIngestJobsNotifyChannel,
  INGEST_JOB_STATUSES,
  LEASE_EXHAUSTED_DEAD_LETTER_REASON,
  LEASE_EXHAUSTED_ERROR_MESSAGE,
  PENDING_LIMIT_ERROR_MESSAGE,
  SERVER_ERROR_MESSAGE,
  toIngestJobErrorMessage,
  toPublicIngestJob,
} from "../rag/ingest-job-store.js";
import {
  createIngestWorker,
  getIngestRetryDelayMs,
  INGEST_TEMP_SUBDIRECTORY,
  isRetryableIngestError,
  loadDocumentsIngestedElsewhere,
  refreshDocumentsIngestedElsewhere,
  resolveApiIngestWorkerPlan,
  sweepIngestTempFiles,
} from "../rag/ingest-worker.js";
import {
  getActiveDatabaseTenant,
  runWithDatabaseTenant,
} from "../rag/postgres-tenant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_BYTES = Buffer.from("%PDF-1.4 ingest job fixture");
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };

const withEnv = async (overrides, callback) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const silentLogger = { error() {}, log() {}, warn() {} };

const createClock = (start = Date.parse("2026-09-26T10:00:00.000Z")) => {
  let current = start;

  return {
    advance: (ms) => {
      current += ms;
    },
    now: () => current,
  };
};

const enqueueFor = (store, scope, overrides = {}) =>
  store.enqueue({
    docId: overrides.docId ?? `doc-${Math.random().toString(16).slice(2)}`,
    fileBytes: PDF_BYTES,
    fileName: "notes.pdf",
    ownerUserId: scope.userId,
    workspaceId: scope.workspaceId,
    ...overrides,
  });

// A ragService whose ingestDocument registers into a local map, the way the
// real one registers into the document registry.
const createFakeRagService = ({ ingest } = {}) => {
  const documents = new Map();
  const calls = [];

  return {
    calls,
    documents,
    getDocument: (docId) => documents.get(docId) ?? null,
    ingestDocument: async (input) => {
      calls.push({ ...input, tenant: getActiveDatabaseTenant(), bytes: await readFile(input.filePath) });

      if (ingest) {
        await ingest(input, calls.length);
      }

      const document = { docId: input.docId, fileName: input.fileName };

      documents.set(input.docId, document);
      return document;
    },
  };
};

// --- config ---------------------------------------------------------------

test("ingest config defaults keep synchronous uploads and parse the worker settings", async () => {
  await withEnv(
    {
      INGEST_JOBS_POSTGRES_TABLE: undefined,
      RAG_INGEST_JOB_LEASE_MS: undefined,
      RAG_INGEST_JOB_MAX_ATTEMPTS: undefined,
      RAG_INGEST_MODE: undefined,
      RAG_INGEST_WORKER_CONCURRENCY: undefined,
      RAG_INGEST_WORKER_ENABLED: undefined,
      RAG_INGEST_WORKER_POLL_MS: undefined,
    },
    async () => {
      assert.equal(getRagIngestMode(), "sync");
      assert.equal(isRagIngestAsync(), false);
      assert.equal(isRagIngestWorkerEnabled(), true);
      assert.equal(getRagIngestWorkerConcurrency(), 2);
      assert.equal(getRagIngestWorkerPollMs(), 1000);
      assert.equal(getRagIngestJobLeaseMs(), 60000);
      assert.equal(getRagIngestJobMaxAttempts(), 3);
      assert.equal(getIngestJobsPostgresTable(), "rag_ingest_jobs");
    }
  );

  await withEnv(
    {
      INGEST_JOBS_POSTGRES_TABLE: " custom_jobs ",
      RAG_INGEST_JOB_LEASE_MS: "15000",
      RAG_INGEST_JOB_MAX_ATTEMPTS: "5",
      RAG_INGEST_MODE: " ASYNC ",
      RAG_INGEST_WORKER_CONCURRENCY: "4",
      RAG_INGEST_WORKER_ENABLED: "false",
      RAG_INGEST_WORKER_POLL_MS: "5000",
    },
    async () => {
      assert.equal(getRagIngestMode(), "async");
      assert.equal(isRagIngestAsync(), true);
      assert.equal(isRagIngestWorkerEnabled(), false);
      assert.equal(getRagIngestWorkerConcurrency(), 4);
      assert.equal(getRagIngestWorkerPollMs(), 5000);
      assert.equal(getRagIngestJobLeaseMs(), 15000);
      assert.equal(getRagIngestJobMaxAttempts(), 5);
      assert.equal(getIngestJobsPostgresTable(), "custom_jobs");
    }
  );

  await withEnv(
    {
      RAG_INGEST_MODE: "later",
      RAG_INGEST_WORKER_CONCURRENCY: "0.5",
      RAG_INGEST_WORKER_POLL_MS: "0",
    },
    async () => {
      assert.equal(getRagIngestMode(), "sync");
      assert.equal(getRagIngestWorkerConcurrency(), 1);
      assert.equal(getRagIngestWorkerPollMs(), 1000, "a poll of 0 would spin; the default stays");
    }
  );
});

// --- migration ------------------------------------------------------------

test("migration 015 renders the jobs table, claim index and tenant policy", async () => {
  const migrationSql = await readFile(
    path.join(__dirname, "..", "db", "migrations", "015_create_rag_ingest_jobs.sql"),
    "utf8"
  );
  const rendered = await withEnv({ INGEST_JOBS_POSTGRES_TABLE: "env_ingest_jobs" }, async () =>
    renderMigrationSql(migrationSql, undefined, {
      embeddingDimensions: 8,
      tenantRole: "archive_rag_tenant",
      textSearchConfig: "simple",
      vectorIndexStatement: "",
    })
  );

  assert.doesNotMatch(rendered, /__[A-Z_]+__/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS env_ingest_jobs \(/);
  assert.match(rendered, /CHECK \(status IN \('queued', 'running', 'succeeded', 'failed'\)\)/);
  assert.match(rendered, /ON env_ingest_jobs \(status, available_at, created_at\)/);
  assert.match(rendered, /GRANT SELECT, INSERT, UPDATE, DELETE ON env_ingest_jobs TO archive_rag_tenant/);
  assert.match(rendered, /ALTER TABLE env_ingest_jobs ENABLE ROW LEVEL SECURITY/);
  assert.match(rendered, /CREATE POLICY tenant_isolation ON env_ingest_jobs\s+TO archive_rag_tenant/);
  assert.match(rendered, /owner_user_id <> '' OR workspace_id <> ''/);

  assert.throws(
    () =>
      renderMigrationSql("__INGEST_JOBS_TABLE__", {
        adminAuditEventsTable: "a",
        agentRunEventsTable: "b",
        agentRunsTable: "c",
        documentsTable: "d",
        ingestJobsTable: "bad-name",
        longMemoryTable: "e",
        sessionMemoryTable: "f",
        taskEventsTable: "g",
        tasksTable: "h",
        workspaceArtifactsTable: "i",
      }, { embeddingDimensions: 8, vectorIndexStatement: "" }),
    /INGEST_JOBS_POSTGRES_TABLE must be a simple PostgreSQL identifier/
  );
});

// --- in-memory store ------------------------------------------------------

test("in-memory store claims oldest due job and fences writes on worker and attempt", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const first = await enqueueFor(store, ALICE, { docId: "doc-1" });

  clock.advance(1);
  const second = await enqueueFor(store, BOB, { docId: "doc-2" });

  assert.equal(first.status, "queued");
  assert.equal(first.fileBytes, null, "enqueue never echoes the bytes back");

  const claimed = await store.claim({ leaseMs: 1000, workerId: "w1" });

  assert.equal(claimed.jobId, first.jobId);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.attemptCount, 1);
  assert.equal(claimed.claimedBy, "w1");
  assert.deepEqual(claimed.fileBytes, PDF_BYTES);

  const next = await store.claim({ leaseMs: 1000, workerId: "w2" });

  assert.equal(next.jobId, second.jobId, "a running job with a live lease is skipped");
  assert.equal(await store.claim({ leaseMs: 1000, workerId: "w3" }), null);

  const fence = { attemptCount: 1, jobId: first.jobId, workerId: "w1" };

  assert.equal(await store.renew({ ...fence, workerId: "w2", leaseMs: 1000 }), false);
  assert.equal(await store.succeed({ ...fence, attemptCount: 2 }), false);
  assert.equal(await store.renew({ ...fence, leaseMs: 1000 }), true);
  assert.equal(await store.succeed(fence), true);

  const succeeded = await store.get(first.jobId, ALICE);

  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.fileBytes, null);
  assert.ok(succeeded.finishedAt);
  assert.equal(await store.succeed(fence), false, "a settled job accepts no second outcome");
});

test("in-memory store hands an expired lease to the next claim and fences out the stale worker", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const job = await enqueueFor(store, ALICE);

  const stale = await store.claim({ leaseMs: 1000, workerId: "stale" });

  clock.advance(999);
  assert.equal(await store.claim({ leaseMs: 1000, workerId: "fresh" }), null);

  clock.advance(2);
  const takeover = await store.claim({ leaseMs: 1000, workerId: "fresh" });

  assert.equal(takeover.jobId, job.jobId);
  assert.equal(takeover.attemptCount, 2);
  assert.equal(takeover.claimedBy, "fresh");

  const staleFence = { attemptCount: stale.attemptCount, jobId: job.jobId, workerId: "stale" };

  assert.equal(await store.renew({ ...staleFence, leaseMs: 1000 }), false);
  assert.equal(await store.succeed(staleFence), false);
  assert.equal(await store.fail({ ...staleFence, error: "late" }), null);
  assert.equal(await store.release(staleFence), false);

  assert.equal(
    await store.succeed({ attemptCount: 2, jobId: job.jobId, workerId: "fresh" }),
    true
  );
  assert.equal((await store.get(job.jobId)).status, "succeeded");
});

test("in-memory store requeues failures with a delay and dead-letters the job once its stage's attempts are exhausted", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const job = await enqueueFor(store, ALICE, { maxAttempts: 2 });

  let claimed = await store.claim({ leaseMs: 1000, workerId: "w" });
  const requeued = await store.fail({
    attemptCount: claimed.attemptCount,
    error: Object.assign(new Error("embedding service unavailable\n    at stack frame"), {
      expose: true,
    }),
    jobId: job.jobId,
    retryDelayMs: 5000,
    workerId: "w",
  });

  assert.equal(requeued, "queued");
  let snapshot = await store.get(job.jobId);
  assert.equal(snapshot.lastError, "embedding service unavailable", "only the first line is kept");
  assert.equal(await store.claim({ leaseMs: 1000, workerId: "w" }), null, "not due yet");

  clock.advance(5000);
  claimed = await store.claim({ leaseMs: 1000, workerId: "w" });
  assert.equal(claimed.attemptCount, 2);

  const final = await store.fail({
    attemptCount: 2,
    deadLetterReason: "Stage parse failed on attempt 2 of 2 (status 503): still unavailable",
    error: "still unavailable",
    jobId: job.jobId,
    retryDelayMs: 5000,
    workerId: "w",
  });

  // A retryable failure out of attempts is dead-lettered, not failed: it
  // keeps its bytes for a requeue, and reads as failed to the client.
  assert.equal(final, "dead_letter");
  snapshot = await store.get(job.jobId);
  assert.equal(snapshot.status, "dead_letter");
  assert.equal(snapshot.lastError, "still unavailable");
  assert.equal(snapshot.deadLetterStage, "parse");
  assert.match(snapshot.deadLetterReason, /attempt 2 of 2/);
  assert.ok(snapshot.finishedAt);
  assert.equal(toPublicIngestJob(snapshot).status, "failed");
  assert.equal(toPublicIngestJob(snapshot).deadLetter.stage, "parse");

  clock.advance(60000);
  assert.equal(await store.claim({ leaseMs: 1000, workerId: "w" }), null);

  const permanent = await enqueueFor(store, ALICE);
  const permanentClaim = await store.claim({ leaseMs: 1000, workerId: "w" });

  assert.equal(
    await store.fail({
      attemptCount: permanentClaim.attemptCount,
      error: "No extractable text was found in the uploaded PDF.",
      jobId: permanent.jobId,
      retryable: false,
      workerId: "w",
    }),
    "failed",
    "a non-retryable error does not spend the remaining attempts"
  );
});

test("in-memory store dead-letters a job whose last allowed attempt let its lease expire", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const job = await enqueueFor(store, ALICE, { maxAttempts: 1 });

  await store.claim({ leaseMs: 1000, workerId: "crashed" });
  clock.advance(1001);

  assert.equal(await store.claim({ leaseMs: 1000, workerId: "next" }), null);

  const snapshot = await store.get(job.jobId);

  assert.equal(snapshot.status, "dead_letter");
  assert.equal(snapshot.lastError, LEASE_EXHAUSTED_ERROR_MESSAGE);
  assert.equal(snapshot.deadLetterStage, "parse");
  assert.equal(snapshot.attemptCount, 1);
});

test("in-memory store release gives the attempt back and a new claimer a distinct fence", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const job = await enqueueFor(store, ALICE);
  const claimed = await store.claim({ leaseMs: 1000, workerId: "stopping" });
  const fence = { attemptCount: claimed.attemptCount, jobId: job.jobId, workerId: "stopping" };

  assert.equal(await store.release(fence), true);
  assert.equal((await store.get(job.jobId)).attemptCount, 0);

  const reclaimed = await store.claim({ leaseMs: 1000, workerId: "other" });

  assert.equal(reclaimed.attemptCount, 1);
  assert.equal(await store.succeed(fence), false, "the stopped worker's late success is ignored");
  assert.equal(await store.succeed({ ...fence, workerId: "other" }), true);
});

test("in-memory store answers get only for the owning scope and validates enqueue input", async () => {
  const store = createInMemoryIngestJobStore();
  const job = await enqueueFor(store, ALICE);
  const unowned = await enqueueFor(store, { userId: "", workspaceId: "" });

  assert.equal((await store.get(job.jobId, ALICE)).jobId, job.jobId);
  assert.equal(await store.get(job.jobId, BOB), null);
  assert.equal(await store.get(job.jobId, { userId: "alice", workspaceId: "ws-b" }), null);
  assert.equal(await store.get(unowned.jobId, ALICE), null, "an unowned job is no tenant's");
  assert.equal((await store.get(unowned.jobId, {})).jobId, unowned.jobId);
  assert.equal(await store.get("missing"), null);

  await assert.rejects(() => store.enqueue({ fileBytes: PDF_BYTES }), /requires a docId/);
  await assert.rejects(() => store.enqueue({ docId: "doc" }), /requires the file bytes/);
  await assert.rejects(
    () => store.enqueue({ docId: "doc", fileBytes: PDF_BYTES, jobId: job.jobId }),
    /already exists/
  );
});

test("public job projection and error messages never carry more than a bounded first line", () => {
  assert.equal(
    toIngestJobErrorMessage(Object.assign(new Error("boom\n    at x (y.js:1:1)"), { status: 422 })),
    "boom"
  );
  assert.equal(toIngestJobErrorMessage(Object.assign(new Error("boom"), { expose: true })), "boom");
  // A dependency's message may name a host, a path or part of a key: the job
  // shows a generic message and the worker log keeps the error.
  for (const internal of [
    new Error("connect ECONNREFUSED 10.0.3.7:5432"),
    Object.assign(new Error("EACCES: permission denied, open '/app/server/uploads/x.pdf'"), {
      code: "EACCES",
    }),
    Object.assign(new Error("401 Incorrect API key provided: sk-proj-****abcd"), { status: 401 }),
    Object.assign(new Error("Rate limit reached"), { status: 429 }),
  ]) {
    assert.equal(toIngestJobErrorMessage(internal), SERVER_ERROR_MESSAGE);
  }
  assert.equal(toIngestJobErrorMessage("stored message\nsecond line"), "stored message");
  assert.equal(toIngestJobErrorMessage(""), "Ingestion failed.");
  assert.equal(toIngestJobErrorMessage("x".repeat(1000)).length, 300);
  assert.equal(toPublicIngestJob(null), null);
  assert.deepEqual(
    Object.keys(
      toPublicIngestJob({
        attemptCount: 1,
        createdAt: "c",
        docId: "d",
        fileBytes: PDF_BYTES,
        fileName: "f",
        finishedAt: null,
        jobId: "j",
        lastError: null,
        ownerUserId: "alice",
        startedAt: "s",
        status: "running",
      })
    ),
    [
      "jobId",
      "docId",
      "fileName",
      "status",
      "attemptCount",
      "error",
      "createdAt",
      "startedAt",
      "finishedAt",
      // Additive fields of the staged pipeline.
      "kind",
      "stage",
      "duplicate",
      "superseded",
      "documentVersion",
      "deadLetter",
    ]
  );
  // A job resolved to another document reports that document.
  assert.equal(
    toPublicIngestJob({ docId: "fresh", duplicate: true, resolvedDocId: "existing", status: "succeeded" }).docId,
    "existing"
  );
});

test("default store is PostgreSQL only when a database is configured", () => {
  assert.equal(createDefaultIngestJobStore({ postgresConfigured: false }).backend, "memory");
  assert.equal(createDefaultIngestJobStore({ postgresConfigured: true }).backend, "postgres");
});

// --- PostgreSQL store over a fake query layer -----------------------------

const createRecordingQuery = (respond = () => ({ rows: [] })) => {
  const calls = [];
  const query = async (sql, values = []) => {
    const call = { sql, tenant: getActiveDatabaseTenant(), values };

    calls.push(call);
    return respond(call);
  };

  return { calls, query };
};

const jobRow = (overrides = {}) => ({
  attempt_count: 1,
  available_at: new Date("2026-09-26T10:00:00Z"),
  claimed_by: "w1",
  created_at: new Date("2026-09-26T10:00:00Z"),
  doc_id: "doc-1",
  file_name: "notes.pdf",
  finished_at: null,
  job_id: "job-1",
  last_error: null,
  lease_expires_at: new Date("2026-09-26T10:01:00Z"),
  max_attempts: 3,
  owner_user_id: "alice",
  started_at: new Date("2026-09-26T10:00:01Z"),
  status: "running",
  updated_at: new Date("2026-09-26T10:00:01Z"),
  workspace_id: "ws-a",
  ...overrides,
});

test("postgres store claims with one SKIP LOCKED update as the owner role, even inside a tenant", async () => {
  const { calls, query } = createRecordingQuery(({ sql }) =>
    /SET status = 'running'/.test(sql)
      ? { rows: [jobRow({ previous_status: "running" })] }
      : { rows: [] }
  );
  const store = createPostgresIngestJobStore({
    getDocumentsTable: () => "docs_t",
    getTable: () => "jobs_t",
    queryPostgres: query,
    runMigrations: async () => {},
  });

  const claimed = await runWithDatabaseTenant(ALICE, () =>
    store.claim({ leaseMs: 60000, workerId: "w1" })
  );

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.tenant === null), "worker queries run as the owner");

  const [sweep, claim] = calls;

  // An exhausted expired job is settled from whether its document committed
  // (a new document only), and dead-lettered at its stage otherwise.
  assert.match(sweep.sql, /SET status = CASE WHEN committed\.doc_id IS NULL THEN 'dead_letter' ELSE 'succeeded' END/);
  assert.match(sweep.sql, /dead_letter_stage = CASE WHEN committed\.doc_id IS NULL THEN expired\.stage ELSE NULL END/);
  assert.match(sweep.sql, /LEFT JOIN docs_t AS committed\s+ON committed\.doc_id = expired\.doc_id AND expired\.kind = 'create'/);
  assert.match(sweep.sql, /expired\.lease_expires_at < NOW\(\)\s+AND expired\.stage_attempts >= expired\.max_attempts/);
  assert.deepEqual(sweep.values, [LEASE_EXHAUSTED_ERROR_MESSAGE, LEASE_EXHAUSTED_DEAD_LETTER_REASON]);
  assert.match(claim.sql, /UPDATE jobs_t AS j/);
  assert.match(claim.sql, /attempt_count = j\.attempt_count \+ 1,\s+stage_attempts = j\.stage_attempts \+ 1/);
  assert.match(claim.sql, /WITH candidate AS \(\s+SELECT c\.job_id, c\.status AS previous_status\s+FROM jobs_t AS c/);
  assert.match(claim.sql, /\(c\.status = 'queued' AND c\.available_at <= NOW\(\)\)/);
  assert.match(claim.sql, /c\.status = 'running'\s+AND c\.lease_expires_at < NOW\(\)\s+AND c\.stage_attempts < c\.max_attempts/);
  assert.match(claim.sql, /r\.owner_user_id = c\.owner_user_id\s+AND r\.workspace_id = c\.workspace_id\s+\) ASC, c\.created_at ASC/);
  assert.match(claim.sql, /LIMIT 1\s+FOR UPDATE OF c SKIP LOCKED/);
  assert.doesNotMatch(claim.sql, /file_bytes/, "the bytes are read by copyJobFile, not the claim");
  assert.deepEqual(claim.values, ["w1", 60000]);

  assert.equal(claimed.jobId, "job-1");
  assert.equal(claimed.ownerUserId, "alice");
  assert.equal(claimed.fileBytes, null);
  assert.equal(claimed.recoveredFromExpiredLease, true);
  assert.equal(claimed.startedAt, "2026-09-26T10:00:01.000Z");

  await assert.rejects(
    () =>
      createPostgresIngestJobStore({
        getDocumentsTable: () => "bad name",
        getTable: () => "jobs_t",
        queryPostgres: query,
      }).claim({ leaseMs: 1, workerId: "w" }),
    /DOCUMENTS_POSTGRES_TABLE/
  );
});

test("postgres store copies a claimed job's bytes to a file in fenced slices", async (t) => {
  const bytes = Buffer.from("%PDF-1.4 sliced into several reads");
  const { calls, query } = createRecordingQuery(({ sql, values }) => {
    if (values[1] !== "w1") {
      return { rows: [] };
    }

    if (/octet_length\(file_bytes\) AS size/.test(sql)) {
      return { rows: [{ size: bytes.length }] };
    }

    const [, , , from, length] = values;

    return { rows: [{ part: bytes.subarray(from - 1, from - 1 + length) }] };
  });
  const store = createPostgresIngestJobStore({
    fileReadChunkBytes: 8,
    getTable: () => "jobs_t",
    queryPostgres: query,
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "ingest-copy-"));

  t.after(() => rm(directory, { force: true, recursive: true }));

  const target = path.join(directory, "copy.pdf");
  const fence = { attemptCount: 1, jobId: "job-1", workerId: "w1" };

  assert.equal(await runWithDatabaseTenant(ALICE, () => store.copyJobFile({ ...fence, filePath: target })), true);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(calls.length, 1 + Math.ceil(bytes.length / 8));
  assert.ok(calls.every((call) => call.tenant === null));
  assert.ok(
    calls.every((call) =>
      /WHERE\s+job_id = \$1 AND claimed_by = \$2 AND attempt_count = \$3 AND status = 'running'/.test(call.sql)
    )
  );
  assert.match(calls[1].sql, /substring\(file_bytes FROM \$4::integer FOR \$5::integer\)/);
  assert.equal(
    await store.copyJobFile({ ...fence, filePath: path.join(directory, "stale.pdf"), workerId: "stale" }),
    false,
    "an attempt that lost its lease reads nothing"
  );
});

test("postgres store fences renew, succeed, fail and release on job, worker and attempt", async () => {
  const { calls, query } = createRecordingQuery(({ sql, values }) => {
    if (values[1] === "stale") {
      return { rows: [] };
    }

    return /SELECT status FROM settled/.test(sql) ? { rows: [{ status: "queued" }] } : { rows: [{ job_id: values[0] }] };
  });
  const store = createPostgresIngestJobStore({
    getTable: () => "jobs_t",
    queryPostgres: query,
  });
  const fence = { attemptCount: 2, jobId: "job-1", workerId: "w1" };

  assert.equal(await store.renew({ ...fence, leaseMs: 30000 }), true);
  assert.equal(await store.succeed(fence), true);
  assert.equal(
    await store.fail({
      ...fence,
      error: Object.assign(new Error("boom\nstack"), { status: 422 }),
      retryDelayMs: 5000,
      retryable: true,
    }),
    "queued"
  );
  assert.equal(await store.release(fence), true);

  for (const call of calls) {
    assert.match(
      call.sql,
      /WHERE\s+job_id = \$1 AND claimed_by = \$2 AND attempt_count = \$3 AND status = 'running'/
    );
    assert.deepEqual(call.values.slice(0, 3), ["job-1", "w1", 2]);
    assert.equal(call.tenant, null);
  }

  assert.equal(calls[0].values[3], 30000);
  assert.match(calls[1].sql, /status = 'succeeded',\s+file_bytes = NULL/);
  assert.match(calls[1].sql, /DELETE FROM jobs_t_outputs AS o\s+USING succeeded/, "success drops the stage outputs");
  assert.match(
    calls[2].sql,
    /WHEN NOT \$4::boolean THEN 'failed'\s+WHEN stage_attempts < max_attempts THEN 'queued'\s+ELSE 'dead_letter' END/
  );
  assert.match(calls[2].sql, /file_bytes = CASE WHEN \$4::boolean THEN file_bytes ELSE NULL END/);
  assert.deepEqual(calls[2].values.slice(3), [true, 5000, "boom", "boom"]);
  assert.match(
    calls[3].sql,
    /attempt_count = GREATEST\(attempt_count - 1, 0\),\s+stage_attempts = GREATEST\(stage_attempts - 1, 0\),\s+claimed_by = NULL/
  );

  const staleFence = { ...fence, workerId: "stale" };

  assert.equal(await store.renew({ ...staleFence, leaseMs: 1 }), false);
  assert.equal(await store.succeed(staleFence), false);
  assert.equal(await store.fail({ ...staleFence, error: "late" }), null);
  assert.equal(await store.release(staleFence), false);
});

test("postgres store enqueues and reads under the request tenant and filters by scope", async () => {
  const { calls, query } = createRecordingQuery(({ sql, values }) =>
    /INSERT INTO/.test(sql)
      ? {
          rows: [
            jobRow({
              attempt_count: 0,
              claimed_by: null,
              doc_id: values[1],
              job_id: values[0],
              lease_expires_at: null,
              started_at: null,
              status: "queued",
            }),
          ],
        }
      : { rows: [jobRow({ status: "queued" })] }
  );
  let migrated = false;
  const store = createPostgresIngestJobStore({
    getTable: () => "jobs_t",
    queryPostgres: query,
    runMigrations: async () => {
      migrated = true;
    },
  });

  assert.equal(await store.initialize(), true);
  assert.equal(migrated, true);

  const job = await runWithDatabaseTenant(ALICE, () =>
    store.enqueue({
      docId: "doc-1",
      fileBytes: PDF_BYTES,
      fileName: " notes.pdf ",
      jobId: "job-1",
      maxAttempts: 4,
      ownerUserId: " alice ",
      workspaceId: "ws-a",
    })
  );

  assert.equal(job.status, "queued");
  assert.deepEqual(calls[0].tenant, ALICE, "enqueue runs as the tenant so RLS checks the insert");
  assert.deepEqual(calls[0].values.slice(0, 10), [
    "job-1",
    "doc-1",
    "alice",
    "ws-a",
    "notes.pdf",
    PDF_BYTES,
    4,
    getRagIngestMaxPendingJobsPerTenant(),
    getRagIngestMaxPendingBytesPerTenant(),
    "jobs_t_enqueued",
  ]);
  assert.equal(typeof calls[0].values[10], "string", "the NOTIFY payload is the store's id");
  assert.doesNotMatch(calls[0].values[10], /job-1|doc-1|alice/, "and nothing about the job");
  // One statement: the NOTIFY commits with the INSERT, and a refused
  // (capped) insert returns no row, so it announces nothing.
  assert.match(
    calls[0].sql,
    /WITH inserted AS \(\s+INSERT INTO jobs_t[\s\S]+\)\s+SELECT inserted\.\*, pg_notify\(\$10::text, \$11::text\) AS notified\s+FROM inserted/
  );
  assert.doesNotMatch(calls[0].sql, /RETURNING[\s\S]*file_bytes/);
  assert.match(calls[0].sql, /status IN \('queued', 'running'\)/);
  assert.match(calls[0].sql, /\$8::integer = 0 OR pending\.pending_jobs < \$8::integer/);
  assert.match(
    calls[0].sql,
    /\$9::bigint = 0 OR pending\.pending_bytes \+ octet_length\(\$6::bytea\) <= \$9::bigint/
  );

  assert.equal((await runWithDatabaseTenant(ALICE, () => store.get("job-1", ALICE))).jobId, "job-1");
  assert.deepEqual(calls[1].tenant, ALICE);
  assert.equal(await store.get("job-1", BOB), null, "the application filter backs row-level security");
  assert.equal(await store.get("  "), null);

  const badStore = createPostgresIngestJobStore({ getTable: () => "bad name", queryPostgres: query });

  await assert.rejects(() => badStore.get("job-1"), /INGEST_JOBS_POSTGRES_TABLE/);

  // The INSERT inserts nothing when the tenant is over a cap.
  const fullStore = createPostgresIngestJobStore({
    getPendingLimits: () => ({ maxPendingBytes: 0, maxPendingJobs: 1 }),
    getTable: () => "jobs_t",
    queryPostgres: async () => ({ rows: [] }),
  });

  await assert.rejects(
    () => fullStore.enqueue({ docId: "doc-2", fileBytes: PDF_BYTES, ownerUserId: "alice" }),
    (error) =>
      error.status === 429 && error.expose === true && error.message === PENDING_LIMIT_ERROR_MESSAGE
  );
});

test("in-memory store caps each tenant's pending jobs and bytes", async () => {
  const clock = createClock();
  let limits = { maxPendingBytes: 0, maxPendingJobs: 2 };
  const store = createInMemoryIngestJobStore({ getPendingLimits: () => limits, now: clock.now });
  const first = await enqueueFor(store, ALICE);

  await enqueueFor(store, ALICE);
  await assert.rejects(() => enqueueFor(store, ALICE), (error) => error.status === 429);
  await enqueueFor(store, BOB, { docId: "doc-bob" });

  const claimed = await store.claim({ leaseMs: 1000, workerId: "w" });

  assert.equal(claimed.jobId, first.jobId);
  await store.succeed({ attemptCount: 1, jobId: first.jobId, workerId: "w" });
  await enqueueFor(store, ALICE);

  limits = { maxPendingBytes: PDF_BYTES.length * 3, maxPendingJobs: 0 };
  await enqueueFor(store, BOB);
  await enqueueFor(store, BOB);
  await assert.rejects(() => enqueueFor(store, BOB), /still waiting to be indexed/);

  assert.equal(getRagIngestMaxPendingJobsPerTenant(), 50);
  assert.equal(getRagIngestMaxPendingBytesPerTenant(), 1024 * 1024 * 1024);
  await withEnv(
    { RAG_INGEST_MAX_PENDING_BYTES_PER_TENANT: "0", RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT: "7" },
    async () => {
      assert.equal(getRagIngestMaxPendingJobsPerTenant(), 7);
      assert.equal(getRagIngestMaxPendingBytesPerTenant(), 0);
    }
  );
});

test("in-memory store claims fairly across tenants and flags a job whose attempt died", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const aliceJobs = [];

  for (let index = 0; index < 3; index += 1) {
    aliceJobs.push(await enqueueFor(store, ALICE, { docId: `doc-alice-${index}` }));
    clock.advance(1);
  }

  const bobJob = await enqueueFor(store, BOB, { docId: "doc-bob" });
  const firstClaim = await store.claim({ leaseMs: 1000, workerId: "w" });

  assert.equal(firstClaim.jobId, aliceJobs[0].jobId, "the oldest job goes first");
  assert.equal(firstClaim.recoveredFromExpiredLease, false);
  assert.equal(
    (await store.claim({ leaseMs: 1000, workerId: "w" })).jobId,
    bobJob.jobId,
    "a tenant with nothing running goes before an older backlog"
  );
  assert.equal((await store.claim({ leaseMs: 1000, workerId: "w" })).jobId, aliceJobs[1].jobId);

  clock.advance(1001);

  const reclaimed = await store.claim({ leaseMs: 1000, workerId: "w2" });

  assert.equal(reclaimed.jobId, aliceJobs[0].jobId);
  assert.equal(reclaimed.recoveredFromExpiredLease, true);
});

test("in-memory store settles an exhausted expired job from whether its document committed, and prunes finished jobs", async () => {
  const clock = createClock();
  const committed = new Set(["doc-committed"]);
  const store = createInMemoryIngestJobStore({
    isDocumentCommitted: (docId) => committed.has(docId),
    now: clock.now,
  });
  const done = await enqueueFor(store, ALICE, { docId: "doc-committed", maxAttempts: 1 });
  const lost = await enqueueFor(store, ALICE, { docId: "doc-lost", maxAttempts: 1 });

  await store.claim({ leaseMs: 1000, workerId: "crashed" });
  await store.claim({ leaseMs: 1000, workerId: "crashed" });
  clock.advance(1001);
  assert.equal(await store.claim({ leaseMs: 1000, workerId: "next" }), null);

  const succeeded = await store.get(done.jobId);
  const failed = await store.get(lost.jobId);

  assert.equal(succeeded.status, "succeeded", "the attempt committed and died before recording it");
  assert.equal(succeeded.lastError, null);
  assert.equal(failed.status, "dead_letter");
  assert.equal(failed.lastError, LEASE_EXHAUSTED_ERROR_MESSAGE);

  const pending = await enqueueFor(store, ALICE);

  assert.equal(await store.pruneFinished({ olderThanMs: 60000 }), 0);
  clock.advance(60001);
  assert.equal(await store.pruneFinished({ olderThanMs: 60000 }), 2);
  assert.equal(await store.get(done.jobId), null);
  assert.equal((await store.get(pending.jobId)).status, "queued", "pending jobs are never pruned");
});

// --- worker ---------------------------------------------------------------

test("worker ingests a claimed job under the job's tenant through ragService.ingestDocument", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const ragService = createFakeRagService();
  const job = await enqueueFor(store, ALICE, { docId: "doc-alice" });
  const worker = createIngestWorker({
    leaseMs: 60000,
    logger: silentLogger,
    ragService,
    store,
    workerId: "w1",
  });

  assert.equal(await worker.runOnce().then((result) => result.outcome), "succeeded");
  assert.equal(await worker.runOnce(), null);

  assert.equal(ragService.calls.length, 1);
  const [call] = ragService.calls;

  assert.equal(call.docId, "doc-alice");
  assert.equal(call.fileName, "notes.pdf");
  assert.equal(call.ownerUserId, "alice");
  assert.equal(call.workspaceId, "ws-a");
  assert.deepEqual(call.tenant, ALICE);
  assert.deepEqual(call.bytes, PDF_BYTES);

  const settled = await store.get(job.jobId, ALICE);

  assert.equal(settled.status, INGEST_JOB_STATUSES.succeeded);
  assert.equal(settled.docId, "doc-alice");
  assert.equal(settled.fileBytes, null);
});

test("a retried attempt does not ingest again when an earlier attempt committed the document", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const loadCalls = [];
  const ragService = {
    ...createFakeRagService(),
    loadDocumentsFromStore: async (docIds) => {
      loadCalls.push(docIds);
      return [];
    },
  };
  const job = await enqueueFor(store, ALICE, { docId: "doc-crash" });
  // The first worker commits the document and then dies before recording the
  // outcome: its success write never reaches the store.
  const crashingStore = {
    ...store,
    succeed: async () => {
      throw new Error("process killed");
    },
  };
  const crashed = createIngestWorker({
    leaseMs: 1000,
    logger: silentLogger,
    ragService,
    store: crashingStore,
    workerId: "crashed",
  });

  await assert.rejects(() => crashed.runOnce(), /process killed/);
  assert.equal(ragService.calls.length, 1);
  assert.equal((await store.get(job.jobId)).status, "running");

  clock.advance(1001);

  const retry = createIngestWorker({
    leaseMs: 1000,
    logger: silentLogger,
    ragService,
    store,
    workerId: "retry",
  });

  assert.deepEqual(await retry.runOnce(), { jobId: job.jobId, outcome: "succeeded" });
  assert.equal(ragService.calls.length, 1, "the committed document is not ingested twice");
  assert.deepEqual(loadCalls.at(-1), ["doc-crash"]);

  const settled = await store.get(job.jobId);

  assert.equal(settled.status, "succeeded");
  assert.equal(settled.attemptCount, 2);
});

test("worker requeues retryable failures, dead-letters at the attempt limit, and fails upload errors at once", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const ragService = createFakeRagService({
    ingest: async (input) => {
      if (input.docId === "doc-no-text") {
        const error = new Error("No extractable text was found in the uploaded PDF.");

        error.status = 422;
        throw error;
      }

      throw new Error("embedding service unavailable");
    },
  });
  const flaky = await enqueueFor(store, ALICE, { docId: "doc-flaky", maxAttempts: 3 });
  const worker = createIngestWorker({
    leaseMs: 60000,
    logger: silentLogger,
    ragService,
    retryDelayMs: (attempt) => attempt * 1000,
    store,
    workerId: "w",
  });

  assert.equal((await worker.runOnce()).outcome, "queued");
  assert.equal(await worker.runOnce(), null, "the retry waits for its backoff");
  clock.advance(1000);
  assert.equal((await worker.runOnce()).outcome, "queued");
  clock.advance(2000);
  assert.equal((await worker.runOnce()).outcome, "dead_letter");

  const failed = await store.get(flaky.jobId, ALICE);

  assert.equal(failed.status, "dead_letter");
  assert.equal(failed.attemptCount, 3);
  assert.match(failed.deadLetterReason, /^Stage parse failed on attempt 3 of 3:/);
  assert.equal(toPublicIngestJob(failed).status, "failed", "clients see a terminal failure");
  assert.equal(
    toPublicIngestJob(failed).error,
    SERVER_ERROR_MESSAGE,
    "a dependency's message stays in the worker log"
  );

  const noText = await enqueueFor(store, ALICE, { docId: "doc-no-text" });

  assert.equal((await worker.runOnce()).outcome, "failed");
  assert.equal((await store.get(noText.jobId)).attemptCount, 1);
  assert.equal(
    (await store.get(noText.jobId)).lastError,
    "No extractable text was found in the uploaded PDF."
  );
});

test("a worker that lost its lease finishes without overwriting the newer attempt", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  let releaseSlowIngest;
  const slowIngestStarted = new Promise((resolve) => {
    releaseSlowIngest = resolve;
  });
  let resumeSlowIngest;
  const slowIngestResumed = new Promise((resolve) => {
    resumeSlowIngest = resolve;
  });
  const ragService = createFakeRagService({
    ingest: async (input, callNumber) => {
      if (callNumber === 1) {
        releaseSlowIngest();
        await slowIngestResumed;
        throw new Error("stale attempt failed late");
      }
    },
  });
  const job = await enqueueFor(store, ALICE);
  const stale = createIngestWorker({
    leaseMs: 1000,
    logger: silentLogger,
    ragService,
    renewIntervalMs: 60000,
    store,
    workerId: "stale",
  });
  const fresh = createIngestWorker({
    leaseMs: 1000,
    logger: silentLogger,
    ragService,
    store,
    workerId: "fresh",
  });

  const staleRun = stale.runOnce();

  await slowIngestStarted;
  clock.advance(1001);
  assert.deepEqual(await fresh.runOnce(), { jobId: job.jobId, outcome: "succeeded" });

  resumeSlowIngest();
  assert.deepEqual(await staleRun, { jobId: job.jobId, outcome: "lease_lost" });

  const settled = await store.get(job.jobId);

  assert.equal(settled.status, "succeeded", "the late failure did not overwrite the newer attempt");
  assert.equal(settled.lastError, null);
});

test("worker loop drains the queue with bounded concurrency and stop hands running jobs back", async (t) => {
  const store = createInMemoryIngestJobStore();
  let active = 0;
  let maxActive = 0;
  const ragService = createFakeRagService({
    ingest: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
  });

  const jobs = await Promise.all(
    Array.from({ length: 5 }, (_, index) => enqueueFor(store, ALICE, { docId: `doc-${index}` }))
  );
  const worker = createIngestWorker({
    concurrency: 2,
    leaseMs: 60000,
    logger: silentLogger,
    pollIntervalMs: 5,
    ragService,
    store,
    workerId: "loop",
  });

  worker.start();
  worker.start();

  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const statuses = await Promise.all(jobs.map((job) => store.get(job.jobId).then((j) => j.status)));

    if (statuses.every((status) => status === "succeeded")) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await worker.stop();
  await worker.stop();

  assert.equal(ragService.calls.length, 5);
  assert.ok(maxActive <= 2, `at most two jobs ran at once (saw ${maxActive})`);
  assert.equal(worker.running, false);

  // A job still running when the grace period ends goes back to the queue.
  // Its ingest never settles, so the worker never removes its temp file: keep
  // that file in a directory of this test's own instead of the OS temp dir.
  const hanging = createFakeRagService({ ingest: () => new Promise(() => {}) });
  const stuck = await enqueueFor(store, ALICE, { docId: "doc-stuck" });
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-worker-stop-"));

  t.after(() => rm(tempDirectory, { force: true, recursive: true }));

  const stopping = createIngestWorker({
    concurrency: 1,
    leaseMs: 60000,
    logger: silentLogger,
    pollIntervalMs: 5,
    ragService: hanging,
    shutdownGraceMs: 20,
    store,
    tempDirectory,
    workerId: "stopping",
  });

  stopping.start();

  while ((await store.get(stuck.jobId)).status !== "running") {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.equal(stopping.inFlightCount, 1);
  await stopping.stop();

  const released = await store.get(stuck.jobId);

  assert.equal(released.status, "queued");
  assert.equal(released.attemptCount, 0);
  assert.equal(released.claimedBy, null);
  assert.equal(
    (await readdir(path.join(tempDirectory, INGEST_TEMP_SUBDIRECTORY))).length,
    1,
    "the hung attempt's temp file stays in the test's directory"
  );
});

test("a rate-limited or timed-out ingest is retried, no sooner than the provider's Retry-After", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const ragService = createFakeRagService({
    ingest: async (input, callNumber) => {
      if (callNumber === 1) {
        throw Object.assign(new Error("Rate limit reached for text-embedding"), {
          retryAfterMs: 30000,
          status: 429,
        });
      }

      if (callNumber === 2) {
        throw Object.assign(new Error("Request timed out"), { status: 408 });
      }
    },
  });
  const job = await enqueueFor(store, ALICE, { maxAttempts: 3 });
  const worker = createIngestWorker({
    leaseMs: 60000,
    logger: silentLogger,
    ragService,
    retryDelayMs: () => 1000,
    store,
    workerId: "w",
  });

  assert.equal((await worker.runOnce()).outcome, "queued");
  clock.advance(1000);
  assert.equal(await worker.runOnce(), null, "the provider's Retry-After is the floor");
  clock.advance(29000);
  assert.equal((await worker.runOnce()).outcome, "queued");
  clock.advance(1000);
  assert.equal((await worker.runOnce()).outcome, "succeeded");
  assert.equal((await store.get(job.jobId)).attemptCount, 3);
});

test("recording an outcome is retried through a database blip", async () => {
  const store = createInMemoryIngestJobStore();
  let failures = 1;
  const ragService = createFakeRagService();
  const job = await enqueueFor(store, ALICE);
  const worker = createIngestWorker({
    leaseMs: 60000,
    logger: silentLogger,
    ragService,
    settleRetryDelayMs: 1,
    store: {
      ...store,
      succeed: async (fence) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("Connection terminated unexpectedly");
        }

        return store.succeed(fence);
      },
    },
    workerId: "w",
  });

  assert.deepEqual(await worker.runOnce(), { jobId: job.jobId, outcome: "succeeded" });
  assert.equal((await store.get(job.jobId)).attemptCount, 1);
});

test("a retry ingests again when this process's map holds a document the database never committed", async (t) => {
  const { rows, store: registryStore } = createSharedRegistryStore();
  // Attempt 1 registered inside a transaction whose COMMIT failed: the map got
  // the entry, the store never did, and the resync after rollback failed too.
  let commitFails = true;

  configureDocumentRegistryStore({
    ...registryStore,
    async upsert(document) {
      const row = await registryStore.upsert(document);

      if (commitFails) {
        rows.delete(row.docId);
      }

      return row;
    },
  });
  t.after(() => resetDocumentRegistryStore());

  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const ingested = [];
  const ragService = {
    getDocument,
    ingestDocument: async (input) => {
      ingested.push(input.docId);
      return registerDocument({ ...input, fileBuffer: PDF_BYTES });
    },
    loadDocumentsFromStore,
    resyncDocument,
  };
  const job = await enqueueFor(store, ALICE, { docId: "doc-uncommitted" });
  const crashed = createIngestWorker({
    leaseMs: 1000,
    logger: silentLogger,
    ragService,
    store: {
      ...store,
      succeed: async () => {
        throw new Error("database unavailable");
      },
    },
    settleRetryDelayMs: 1,
    workerId: "crashed",
  });

  await assert.rejects(() => crashed.runOnce(), /database unavailable/);
  assert.ok(getDocument("doc-uncommitted", ALICE), "the map holds the uncommitted entry");
  assert.equal(rows.has("doc-uncommitted"), false);

  commitFails = false;
  clock.advance(1001);

  const retry = createIngestWorker({
    leaseMs: 1000,
    logger: silentLogger,
    ragService,
    store,
    workerId: "retry",
  });

  assert.deepEqual(await retry.runOnce(), { jobId: job.jobId, outcome: "succeeded" });
  assert.deepEqual(ingested, ["doc-uncommitted", "doc-uncommitted"], "the retry ingested again");
  assert.equal(rows.has("doc-uncommitted"), true);
});

test("a job whose previous attempt died runs alone, after the jobs already running", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const events = [];
  let finishHealthy;
  const healthyGate = new Promise((resolve) => {
    finishHealthy = resolve;
  });
  let healthyStarted;
  const healthyStartedPromise = new Promise((resolve) => {
    healthyStarted = resolve;
  });
  const ragService = createFakeRagService({
    ingest: async (input) => {
      events.push(`start ${input.docId}`);

      if (input.docId === "doc-healthy") {
        healthyStarted();
        await healthyGate;
      }

      events.push(`end ${input.docId}`);
    },
  });

  // The suspect job's first attempt died holding it.
  const suspect = await enqueueFor(store, ALICE, { docId: "doc-suspect" });

  await store.claim({ leaseMs: 1000, workerId: "dead" });
  clock.advance(1);
  await enqueueFor(store, BOB, { docId: "doc-healthy" });

  const worker = createIngestWorker({
    leaseMs: 60000,
    logger: silentLogger,
    ragService,
    store,
    workerId: "w",
  });
  const healthyRun = worker.runOnce();

  await healthyStartedPromise;
  clock.advance(1000);

  const suspectRun = worker.runOnce();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["start doc-healthy"], "the suspect waits for the running job");
  finishHealthy();

  assert.equal((await healthyRun).outcome, "succeeded");
  assert.deepEqual(await suspectRun, { jobId: suspect.jobId, outcome: "succeeded" });
  assert.deepEqual(events, ["start doc-healthy", "end doc-healthy", "start doc-suspect", "end doc-suspect"]);
  assert.equal((await store.get(suspect.jobId)).attemptCount, 2);
});

test("housekeeping prunes finished jobs and removes attempt files no live attempt touches", async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-housekeeping-"));

  t.after(() => rm(tempDirectory, { force: true, recursive: true }));

  const attemptDirectory = path.join(tempDirectory, INGEST_TEMP_SUBDIRECTORY);
  const stale = path.join(attemptDirectory, "ingest-dead-1-x.pdf");
  const live = path.join(attemptDirectory, "ingest-live-1-y.pdf");

  await mkdir(attemptDirectory, { recursive: true });
  await writeFile(stale, PDF_BYTES);
  await writeFile(live, PDF_BYTES);
  await utimes(stale, new Date(Date.now() - 10000), new Date(Date.now() - 10000));

  const pruned = [];
  const worker = createIngestWorker({
    finishedJobRetentionMs: 1234,
    leaseMs: 1000,
    logger: silentLogger,
    ragService: createFakeRagService(),
    store: {
      ...createInMemoryIngestJobStore(),
      pruneFinished: async (options) => {
        pruned.push(options);
        return 0;
      },
    },
    tempDirectory,
    workerId: "w",
  });

  await worker.runHousekeeping();
  assert.deepEqual(pruned, [{ olderThanMs: 1234 }]);
  assert.deepEqual(await readdir(attemptDirectory), ["ingest-live-1-y.pdf"]);
  assert.equal(
    await sweepIngestTempFiles({ directory: path.join(tempDirectory, "missing"), olderThanMs: 1 }),
    0
  );
  assert.equal(getRagIngestJobRetentionMs(), 7 * 24 * 60 * 60 * 1000);
});

test("an API process keeps its ingest worker where the queue or the index is per process", () => {
  assert.deepEqual(
    resolveApiIngestWorkerPlan({ asyncMode: false, storeBackend: "postgres", workerEnabled: true }),
    { errors: [], start: false, warnings: [] }
  );
  assert.deepEqual(
    resolveApiIngestWorkerPlan({
      asyncMode: true,
      storeBackend: "postgres",
      vectorStoreProvider: "pgvector",
      workerEnabled: false,
    }),
    { errors: [], start: false, warnings: [] },
    "dedicated workers drain a shared queue into a shared index"
  );

  const memory = resolveApiIngestWorkerPlan({
    asyncMode: true,
    storeBackend: "memory",
    vectorStoreProvider: "local",
    workerEnabled: false,
  });

  assert.equal(memory.start, true);
  assert.match(memory.errors[0], /in this process's memory/);

  const local = resolveApiIngestWorkerPlan({
    asyncMode: true,
    storeBackend: "postgres",
    vectorStoreProvider: "local",
    workerEnabled: false,
  });

  assert.equal(local.start, true);
  assert.match(local.errors[0], /VECTOR_STORE_PROVIDER=local/);
  assert.match(local.warnings[0], /single API process/);
});

test("worker rejects a missing store or ingest function and classifies retryable errors", () => {
  assert.throws(() => createIngestWorker({ ragService: createFakeRagService() }), /job store/);
  assert.throws(
    () => createIngestWorker({ ragService: {}, store: createInMemoryIngestJobStore() }),
    /ingestDocument/
  );
  assert.equal(isRetryableIngestError(new Error("network")), true);
  assert.equal(isRetryableIngestError(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(isRetryableIngestError(Object.assign(new Error("x"), { status: 422 })), false);
  assert.equal(isRetryableIngestError(Object.assign(new Error("x"), { status: 400 })), false);
  assert.equal(isRetryableIngestError(Object.assign(new Error("x"), { status: 401 })), false);
  assert.equal(isRetryableIngestError(Object.assign(new Error("x"), { status: 429 })), true);
  assert.equal(isRetryableIngestError(Object.assign(new Error("x"), { status: 408 })), true);
  assert.equal(isRetryableIngestError(Object.assign(new Error("x"), { status: 409 })), true);
  assert.equal(isRetryableIngestError(Object.assign(new Error("x"), { retryable: false })), false);
  assert.equal(
    isRetryableIngestError(Object.assign(new Error("x"), { retryable: false, status: 429 })),
    false
  );
  assert.equal(getIngestRetryDelayMs(1), 5000);
  assert.equal(getIngestRetryDelayMs(3), 20000);
  assert.equal(getIngestRetryDelayMs(20), 300000);
});

// --- document visibility across processes ---------------------------------

const createSharedRegistryStore = () => {
  const rows = new Map();

  return {
    rows,
    store: {
      async initialize() {
        return true;
      },
      async list() {
        return [...rows.values()];
      },
      async listByIds(docIds) {
        return docIds.map((docId) => rows.get(docId)).filter(Boolean);
      },
      async upsert(document) {
        const row = {
          docId: document.docId,
          fileName: document.fileName,
          ownerUserId: document.ownerUserId,
          uploadedAt: document.uploadedAt ?? new Date().toISOString(),
          workspaceId: document.workspaceId,
        };

        rows.set(row.docId, row);
        return row;
      },
    },
  };
};

test("documents another process registered become visible through the targeted load and the refresh", async (t) => {
  const { rows, store } = createSharedRegistryStore();

  configureDocumentRegistryStore(store);
  t.after(() => resetDocumentRegistryStore());

  rows.set("doc-startup", {
    docId: "doc-startup",
    fileName: "startup.pdf",
    ownerUserId: "alice",
    uploadedAt: "2026-09-26T09:00:00.000Z",
    workspaceId: "ws-a",
  });
  await initializeDocumentRegistry();

  // Another process's worker commits a document behind this process's back.
  rows.set("doc-elsewhere", {
    docId: "doc-elsewhere",
    fileName: "elsewhere.pdf",
    ownerUserId: "alice",
    uploadedAt: "2026-09-26T10:00:00.000Z",
    workspaceId: "ws-a",
  });

  assert.equal(getDocument("doc-elsewhere", ALICE), null);
  assert.deepEqual(await loadDocumentsFromStore(["doc-elsewhere", "doc-unknown", "doc-startup"]), [
    "doc-elsewhere",
  ]);
  assert.equal(getDocument("doc-elsewhere", ALICE).fileName, "elsewhere.pdf");
  assert.equal(getDocument("doc-elsewhere", BOB), null, "the loaded entry is still scoped");
  assert.deepEqual(await loadDocumentsFromStore([]), []);

  // The other process deletes one document and adds another.
  rows.delete("doc-startup");
  rows.set("doc-later", {
    docId: "doc-later",
    fileName: "later.pdf",
    ownerUserId: "alice",
    uploadedAt: "2026-09-26T11:00:00.000Z",
    workspaceId: "ws-a",
  });

  await refreshDocumentRegistry();
  assert.deepEqual(
    listDocuments(ALICE).map((document) => document.docId),
    ["doc-elsewhere", "doc-later"]
  );
});

test("a refresh keeps what this process registered while the listing was in flight", async (t) => {
  const { rows, store } = createSharedRegistryStore();
  let releaseList;
  const listGate = new Promise((resolve) => {
    releaseList = resolve;
  });
  let listStarted;
  const listStartedPromise = new Promise((resolve) => {
    listStarted = resolve;
  });

  configureDocumentRegistryStore({
    ...store,
    async list() {
      const snapshot = [...rows.values()];

      if (rows.size > 0) {
        listStarted();
        await listGate;
      }

      return snapshot;
    },
  });
  t.after(() => resetDocumentRegistryStore());

  await initializeDocumentRegistry();
  rows.set("doc-old", {
    docId: "doc-old",
    fileName: "old.pdf",
    ownerUserId: "alice",
    uploadedAt: "2026-09-26T09:00:00.000Z",
    workspaceId: "ws-a",
  });

  const refreshing = refreshDocumentRegistry();

  await listStartedPromise;
  await registerDocument({
    docId: "doc-new",
    fileBuffer: PDF_BYTES,
    fileName: "new.pdf",
    ownerUserId: "alice",
    workspaceId: "ws-a",
  });
  releaseList();
  await refreshing;

  assert.deepEqual(
    listDocuments(ALICE).map((document) => document.docId).sort(),
    ["doc-new", "doc-old"],
    "the in-flight registration survives a listing that predates it"
  );
});

test("a refresh leaves a document this process is writing in a transaction as this process has it", async (t) => {
  const { rows, store } = createSharedRegistryStore();

  configureDocumentRegistryStore(store);
  t.after(() => resetDocumentRegistryStore());
  await initializeDocumentRegistry();

  // An ingest transaction put the row in the map and has not committed: the
  // store (another connection) does not list it yet.
  let commit;
  const committed = new Promise((resolve) => {
    commit = resolve;
  });
  const ingest = trackDocumentWrite("doc-ingesting", async () => {
    await registerDocument({
      docId: "doc-ingesting",
      fileBuffer: PDF_BYTES,
      fileName: "ingesting.pdf",
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });
    rows.delete("doc-ingesting");
    await committed;
    rows.set("doc-ingesting", {
      docId: "doc-ingesting",
      fileName: "ingesting.pdf",
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });
  });

  await new Promise((resolve) => setImmediate(resolve));
  await refreshDocumentRegistry();
  assert.ok(getDocument("doc-ingesting", ALICE), "the uncommitted document is not dropped");

  commit();
  await ingest;
  await refreshDocumentRegistry();
  assert.ok(getDocument("doc-ingesting", ALICE));

  // A delete removed the entry before its COMMIT; a listing that still sees
  // the committed row must not bring it back, even when the delete settles
  // while the listing is in flight.
  let releaseList;
  const listGate = new Promise((resolve) => {
    releaseList = resolve;
  });
  let listStarted;
  const listStartedPromise = new Promise((resolve) => {
    listStarted = resolve;
  });
  const originalList = store.list;

  store.list = async () => {
    const snapshot = [...rows.values()];

    listStarted();
    await listGate;
    return snapshot;
  };

  let finishDelete;
  const deleteCommitted = new Promise((resolve) => {
    finishDelete = resolve;
  });
  const deleting = trackDocumentWrite("doc-ingesting", async () => {
    await deleteCommitted;
  });
  const refreshing = refreshDocumentRegistry();

  await listStartedPromise;
  finishDelete();
  await deleting;
  rows.delete("doc-ingesting");
  releaseList();
  await refreshing;
  store.list = originalList;

  assert.ok(
    getDocument("doc-ingesting", ALICE),
    "an entry written while the listing ran is left for the next refresh"
  );
  await refreshDocumentRegistry();
  assert.equal(getDocument("doc-ingesting", ALICE), null);
});

test("a refresh reads the requesting tenant's documents only, and callers that arrive while it runs share the next one", async (t) => {
  const { rows, store } = createSharedRegistryStore();
  const listings = [];

  configureDocumentRegistryStore({
    ...store,
    async list(accessScope = {}) {
      listings.push(accessScope);
      return store.list();
    },
  });
  t.after(() => resetDocumentRegistryStore());

  for (const [docId, scope] of [
    ["doc-a", ALICE],
    ["doc-b", BOB],
  ]) {
    rows.set(docId, { docId, fileName: `${docId}.pdf`, ownerUserId: scope.userId, workspaceId: scope.workspaceId });
  }

  await initializeDocumentRegistry();
  listings.length = 0;

  // Another process deletes bob's document and adds one for each tenant.
  rows.delete("doc-b");
  rows.set("doc-a2", { docId: "doc-a2", fileName: "a2.pdf", ownerUserId: "alice", workspaceId: "ws-a" });
  rows.set("doc-b2", { docId: "doc-b2", fileName: "b2.pdf", ownerUserId: "bob", workspaceId: "ws-b" });

  const results = await Promise.all([
    refreshDocumentRegistry(ALICE),
    refreshDocumentRegistry(ALICE),
    refreshDocumentRegistry(ALICE),
  ]);

  assert.deepEqual(
    listings,
    [ALICE, ALICE],
    "alice's scope only: the first caller's listing, and one shared by the two that arrived while it ran"
  );
  assert.deepEqual(results[0].map((document) => document.docId).sort(), ["doc-a", "doc-a2"]);
  assert.ok(getDocument("doc-b", BOB), "bob's entries wait for bob's own refresh");
  assert.equal(getDocument("doc-b2", BOB), null);

  await refreshDocumentRegistry(BOB);
  assert.equal(getDocument("doc-b", BOB), null);
  assert.ok(getDocument("doc-b2", BOB));
});

test("the PostgreSQL registry lists a scope with the tenant rule in SQL", async () => {
  const calls = [];
  const { createDocumentRegistryStore } = await import("../rag/doc-registry.js");
  const store = createDocumentRegistryStore({
    getDocumentsTable: () => "docs_t",
    queryPostgres: async (sql, values = []) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  });

  await store.list(ALICE);
  await store.list();

  assert.match(calls[0].sql, /WHERE \(owner_user_id <> '' OR workspace_id <> ''\)/);
  assert.match(calls[0].sql, /\(owner_user_id = '' OR owner_user_id = \$1\)/);
  assert.deepEqual(calls[0].values, ["alice", "ws-a"]);
  assert.doesNotMatch(calls[1].sql, /WHERE/);
});

test("the cross-process document helpers read the store whenever the registry is shared, in either ingest mode", async () => {
  const calls = [];
  const createRagService = (shared) => ({
    isDocumentRegistryShared: () => shared,
    loadDocumentsFromStore: async (docIds) => {
      calls.push(["load", docIds]);
    },
    refreshDocumentRegistry: async (accessScope) => {
      calls.push(["refresh", accessScope]);
      throw new Error("database unavailable");
    },
  });
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    for (const mode of [undefined, "async"]) {
      await withEnv({ RAG_INGEST_MODE: mode }, async () => {
        await loadDocumentsIngestedElsewhere(createRagService(true), ["doc-1"]);
        // A failed refresh is reported, so the caller can keep that request
        // off the read replicas.
        assert.equal(await refreshDocumentsIngestedElsewhere(createRagService(true), ALICE), false);
        // A file-backed or in-memory registry has one writer: this process.
        await loadDocumentsIngestedElsewhere(createRagService(false), ["doc-2"]);
        assert.equal(await refreshDocumentsIngestedElsewhere(createRagService(false), ALICE), true);
        await loadDocumentsIngestedElsewhere({ isDocumentRegistryShared: () => true }, ["doc-3"]);
      });
    }
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(
    calls,
    [
      ["load", ["doc-1"]],
      ["refresh", ALICE],
      ["load", ["doc-1"]],
      ["refresh", ALICE],
    ],
    "sync and async alike; a failed refresh is logged, not thrown"
  );
});

test("the registry counts as shared when it is PostgreSQL, whatever the ingest mode", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ingest-registry-shared-"));

  t.after(async () => {
    await resetDocumentRegistryStore();
    await rm(tempRoot, { force: true, recursive: true });
  });

  for (const mode of [undefined, "async"]) {
    await withEnv(
      {
        LONG_MEMORY_DATABASE_URL: undefined,
        POSTGRES_DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
        RAG_INGEST_MODE: mode,
      },
      async () => {
        configureDocumentRegistryStore(
          createDocumentRegistryStore({ queryPostgres: async () => ({ rows: [] }) })
        );
        assert.equal(isDocumentRegistryShared(), true, "an injected PostgreSQL store");

        configureDocumentRegistryStore(
          createFileDocumentRegistryStore({
            getDocumentsDirectory: () => path.join(tempRoot, "documents"),
            getRegistryFilePath: () => path.join(tempRoot, "documents.json"),
          })
        );
        assert.equal(isDocumentRegistryShared(), false, "the standalone file registry");

        configureDocumentRegistryStore(createSharedRegistryStore().store);
        assert.equal(isDocumentRegistryShared(), false, "a store that does not say it is PostgreSQL");

        configureDocumentRegistryStore(null);
        assert.equal(isDocumentRegistryShared(), true, "the default store with a database");
      }
    );
  }

  await withEnv({ LONG_MEMORY_DATABASE_URL: undefined, POSTGRES_DATABASE_URL: undefined }, async () => {
    configureDocumentRegistryStore(null);
    assert.equal(
      isDocumentRegistryShared(),
      false,
      "the default store without a database cannot answer, so nothing is re-read"
    );
  });
});

test("in sync mode a PostgreSQL registry picks up another instance's upload; a file registry is left alone", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ingest-registry-sync-"));

  t.after(async () => {
    await resetDocumentRegistryStore();
    await rm(tempRoot, { force: true, recursive: true });
  });

  // The module functions the app's ragService is built from; without its own
  // isDocumentRegistryShared the helpers ask the configured registry.
  const ragService = { loadDocumentsFromStore, refreshDocumentRegistry };
  const { rows, store } = createSharedRegistryStore();

  await withEnv({ RAG_INGEST_MODE: undefined }, async () => {
    configureDocumentRegistryStore({ ...store, backend: "postgres" });
    await initializeDocumentRegistry();

    // Another API instance's synchronous upload commits a row.
    rows.set("doc-other-instance", {
      docId: "doc-other-instance",
      fileName: "other.pdf",
      ownerUserId: "alice",
      uploadedAt: "2026-09-26T10:00:00.000Z",
      workspaceId: "ws-a",
    });
    assert.equal(getDocument("doc-other-instance", ALICE), null);

    await loadDocumentsIngestedElsewhere(ragService, ["doc-other-instance"]);
    assert.equal(getDocument("doc-other-instance", ALICE).fileName, "other.pdf");

    // It deletes that one and uploads another; this tenant's listing follows.
    rows.delete("doc-other-instance");
    rows.set("doc-listed", {
      docId: "doc-listed",
      fileName: "listed.pdf",
      ownerUserId: "alice",
      uploadedAt: "2026-09-26T11:00:00.000Z",
      workspaceId: "ws-a",
    });
    await refreshDocumentsIngestedElsewhere(ragService, ALICE);
    assert.deepEqual(listDocuments(ALICE).map((document) => document.docId), ["doc-listed"]);

    // The standalone file registry: even a record written behind this
    // process's back is not read, because nothing but this process writes it.
    const fileStoreOptions = {
      getDocumentsDirectory: () => path.join(tempRoot, "documents"),
      getRegistryFilePath: () => path.join(tempRoot, "documents.json"),
    };

    configureDocumentRegistryStore(createFileDocumentRegistryStore(fileStoreOptions));
    await initializeDocumentRegistry();
    await createFileDocumentRegistryStore(fileStoreOptions).upsert({
      docId: "doc-file-elsewhere",
      fileBuffer: PDF_BYTES,
      fileName: "elsewhere.pdf",
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });

    await loadDocumentsIngestedElsewhere(ragService, ["doc-file-elsewhere"]);
    await refreshDocumentsIngestedElsewhere(ragService, ALICE);
    assert.equal(getDocument("doc-file-elsewhere", ALICE), null);
    assert.deepEqual(listDocuments(ALICE), []);
  });
});

test("a refresh does not bring back documents a clear removed before its COMMIT", async (t) => {
  const { rows, store } = createSharedRegistryStore();

  configureDocumentRegistryStore(store);
  t.after(() => resetDocumentRegistryStore());

  for (const docId of ["doc-a", "doc-b"]) {
    rows.set(docId, { docId, fileName: `${docId}.pdf`, ownerUserId: "alice", workspaceId: "ws-a" });
  }

  await initializeDocumentRegistry();

  // rag/index.js clears the map inside the transaction; the store (another
  // connection) still lists both rows until COMMIT.
  let commit;
  const committed = new Promise((resolve) => {
    commit = resolve;
  });
  const clearing = trackDocumentWrite(["doc-a", "doc-b"], async () => {
    await clearDocuments({ accessScope: ALICE });
    await committed;
    rows.delete("doc-a");
    rows.delete("doc-b");
  });

  await new Promise((resolve) => setImmediate(resolve));
  await refreshDocumentRegistry(ALICE);
  assert.deepEqual(listDocuments(ALICE), [], "the pre-COMMIT listing does not resurrect them");

  commit();
  await clearing;
  await refreshDocumentRegistry(ALICE);
  assert.deepEqual(listDocuments(ALICE), []);
});

const createGate = () => {
  let release;
  let started;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });

  return { release, released, started, startedPromise };
};

const aliceRow = (docId) => ({
  docId,
  fileName: `${docId}.pdf`,
  ownerUserId: "alice",
  uploadedAt: "2026-09-26T09:00:00.000Z",
  workspaceId: "ws-a",
});

test("a refresh requested while an older listing runs waits for one that starts after it", async (t) => {
  const { rows, store } = createSharedRegistryStore();
  const listings = [];
  let gate = null;

  configureDocumentRegistryStore({
    ...store,
    async list() {
      const snapshot = [...rows.values()];

      listings.push(snapshot.map((row) => row.docId));

      if (gate) {
        const held = gate;

        gate = null;
        held.started();
        await held.released;
      }

      return snapshot;
    },
  });
  t.after(() => resetDocumentRegistryStore());

  rows.set("doc-a", aliceRow("doc-a"));
  await initializeDocumentRegistry();
  listings.length = 0;

  // Someone's GET /documents is listing the store on this instance...
  gate = createGate();
  const held = gate;
  const older = refreshDocumentRegistry();

  await held.startedPromise;

  // ...when another instance commits an upload and answers 201, and the
  // uploader's own GET /documents reaches this instance (auth off: one scope).
  rows.set("doc-new", aliceRow("doc-new"));
  const mine = refreshDocumentRegistry();
  const another = refreshDocumentRegistry();

  held.release();

  const [olderListing, myListing, anotherListing] = await Promise.all([older, mine, another]);

  assert.deepEqual(olderListing.map((document) => document.docId), ["doc-a"]);
  assert.ok(
    myListing.some((document) => document.docId === "doc-new"),
    "a caller never gets a listing that started before it arrived"
  );
  assert.deepEqual(anotherListing, myListing);
  assert.deepEqual(listings, [["doc-a"], ["doc-a", "doc-new"]], "the two later callers share one listing");
});

test("a named read drops a document another process deleted, and never undoes this process's delete before its COMMIT", async (t) => {
  const { rows, store } = createSharedRegistryStore();
  // Rows a DELETE of this process removed but has not committed: other
  // connections still read them.
  const uncommittedDeletes = new Set();
  let byIdGate = null;

  configureDocumentRegistryStore({
    ...store,
    async delete(docId) {
      const row = rows.get(docId) ?? null;

      if (row) {
        uncommittedDeletes.add(docId);
      }

      return row;
    },
    async listByIds(docIds) {
      const snapshot = docIds.map((docId) => rows.get(docId)).filter(Boolean);

      if (byIdGate) {
        const held = byIdGate;

        byIdGate = null;
        held.started();
        await held.released;
      }

      return snapshot;
    },
  });
  t.after(() => resetDocumentRegistryStore());

  for (const docId of ["doc-x", "doc-y", "doc-z", "doc-w"]) {
    rows.set(docId, aliceRow(docId));
  }

  await initializeDocumentRegistry();

  // Another instance deletes doc-y and changes nothing else: a hit, not a
  // miss, and the read by id drops it (the /chat and DELETE 404 checks).
  rows.delete("doc-y");
  assert.ok(getDocument("doc-y", ALICE));
  assert.deepEqual(await loadDocumentsFromStore(["doc-y", "doc-z", "doc-unknown"]), []);
  assert.equal(getDocument("doc-y", ALICE), null);
  assert.ok(getDocument("doc-z", ALICE), "a document the store still has stays");

  // DELETE /documents/doc-x on this instance: the map drops it inside the
  // transaction, before COMMIT. A lookup that misses meanwhile reads the row
  // the uncommitted delete still leaves visible, and must not re-add it.
  let commit;
  const committed = new Promise((resolve) => {
    commit = resolve;
  });
  const deleting = trackDocumentWrite("doc-x", async () => {
    await deleteDocument("doc-x", ALICE);
    await committed;
    rows.delete("doc-x");
    uncommittedDeletes.delete("doc-x");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getDocument("doc-x", ALICE), null);
  assert.deepEqual(await loadDocumentsFromStore(["doc-x"]), []);
  assert.equal(getDocument("doc-x", ALICE), null, "the uncommitted delete is not undone");

  commit();
  await deleting;
  assert.deepEqual(await loadDocumentsFromStore(["doc-x"]), []);
  assert.equal(getDocument("doc-x", ALICE), null);

  // The read started before a delete that settles while it runs: its row
  // predates the delete, so it is not applied either.
  byIdGate = createGate();
  const heldRead = byIdGate;
  const reading = loadDocumentsFromStore(["doc-w"]);

  await heldRead.startedPromise;
  await trackDocumentWrite("doc-w", async () => {
    await deleteDocument("doc-w", ALICE);
    rows.delete("doc-w");
  });
  heldRead.release();
  assert.deepEqual(await reading, []);
  assert.equal(getDocument("doc-w", ALICE), null);
});

test("deleting a document another process already deleted answers null and drops the stale entry", async (t) => {
  const { rows, store } = createSharedRegistryStore();

  configureDocumentRegistryStore({
    ...store,
    async delete(docId) {
      const row = rows.get(docId) ?? null;

      rows.delete(docId);
      return row;
    },
  });
  t.after(() => resetDocumentRegistryStore());

  rows.set("doc-gone", aliceRow("doc-gone"));
  rows.set("doc-here", aliceRow("doc-here"));
  await initializeDocumentRegistry();

  rows.delete("doc-gone");
  assert.equal(await deleteDocument("doc-gone", ALICE), null, "the route answers 404");
  assert.equal(getDocument("doc-gone", ALICE), null);
  assert.equal((await deleteDocument("doc-here", ALICE)).docId, "doc-here");
});

test("a clear deletes and reports what the store holds for the scope, and a listing that predates it brings none of it back", async (t) => {
  const { rows, store } = createSharedRegistryStore();
  let listGate = null;

  configureDocumentRegistryStore({
    ...store,
    // DELETE ... RETURNING inside the caller's transaction: the rows stay
    // visible to other connections until the caller commits.
    async clear(accessScope = {}) {
      return [...rows.values()].filter(
        (row) => row.ownerUserId === accessScope.userId && row.workspaceId === accessScope.workspaceId
      );
    },
    async list() {
      const snapshot = [...rows.values()];

      if (listGate) {
        const held = listGate;

        listGate = null;
        held.started();
        await held.released;
      }

      return snapshot;
    },
  });
  t.after(() => resetDocumentRegistryStore());

  rows.set("doc-1", aliceRow("doc-1"));
  rows.set("doc-bob", { ...aliceRow("doc-bob"), ownerUserId: "bob", workspaceId: "ws-b" });
  await initializeDocumentRegistry();

  // Another instance uploads doc-2, which this map has not read.
  rows.set("doc-2", aliceRow("doc-2"));

  // A GET /documents starts a listing that sees doc-1 and doc-2...
  listGate = createGate();
  const heldList = listGate;
  const refreshing = refreshDocumentRegistry(ALICE);

  await heldList.startedPromise;

  // ...and POST /documents/clear runs the way rag/index.js runs it.
  let commit;
  const committed = new Promise((resolve) => {
    commit = resolve;
  });
  const clearing = trackDocumentWrite([], async (track) => {
    const cleared = await clearDocuments({ accessScope: ALICE, onCleared: track });

    await committed;

    for (const document of cleared) {
      rows.delete(document.docId);
    }

    return cleared;
  });

  await new Promise((resolve) => setImmediate(resolve));
  commit();

  const cleared = await clearing;

  assert.deepEqual(
    cleared.map((document) => document.docId).sort(),
    ["doc-1", "doc-2"],
    "the response counts every document the DELETE removed"
  );

  heldList.release();
  await refreshing;

  assert.deepEqual(listDocuments(ALICE), [], "the older listing brings nothing back");
  assert.ok(getDocument("doc-bob", BOB), "another tenant's entry is untouched");
});

// --- waking idle workers ----------------------------------------------------

const waitFor = async (predicate, { timeoutMs = 5000, label = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;

  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

// Stands in for pg.Client: connect/query/end plus the events the listener
// uses. `connectFailures` connects fail first; `hangConnect` never connects
// until end() aborts it, as pg does by destroying the socket.
const createFakeListenClients = ({ connectFailures = 0, hangConnect = false } = {}) => {
  const clients = [];
  let failuresLeft = connectFailures;

  const create = () => {
    const client = new EventEmitter();

    client.ended = false;
    client.queries = [];
    client.connect = async () => {
      client.tenant = getActiveDatabaseTenant();

      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
      }

      if (hangConnect) {
        await new Promise((resolve, reject) => {
          client.abortConnect = () => reject(new Error("Connection terminated"));
        });
      }
    };
    client.query = async (sql) => {
      client.queries.push(sql);
      return { rows: [] };
    };
    client.end = async () => {
      if (client.ended) {
        return;
      }

      client.ended = true;
      client.abortConnect?.();
      client.emit("end");
    };
    clients.push(client);
    return client;
  };

  return { clients, create };
};

test("an idle worker claims a job enqueued in its own process at once, not at its next poll", async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-wake-"));

  t.after(() => rm(tempDirectory, { force: true, recursive: true }));

  const store = createInMemoryIngestJobStore();
  const ragService = createFakeRagService();
  const worker = createIngestWorker({
    concurrency: 1,
    leaseMs: 60000,
    logger: silentLogger,
    pollIntervalMs: 60 * 60 * 1000,
    ragService,
    store,
    tempDirectory,
    workerId: "woken",
  });

  worker.start();
  await waitFor(() => worker.idleLoopCount === 1, { label: "the loop to fall asleep" });
  assert.equal(store.enqueueNotificationStatus().subscribers, 1);

  const job = await enqueueFor(store, ALICE, { docId: "doc-woken" });

  // The poll is an hour away: only the wake-up can have claimed it.
  await waitFor(async () => (await store.get(job.jobId)).status === "succeeded", {
    label: "the woken loop to ingest the job",
  });
  assert.equal(ragService.calls.length, 1);

  await worker.stop();
  assert.equal(store.enqueueNotificationStatus().subscribers, 0, "stop unsubscribes");
  worker.wake();
  assert.equal(worker.running, false, "a wake-up after stop starts nothing");
});

test("a wake-up that arrives while the loop is claiming makes it look again instead of sleeping", async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-wake-race-"));

  t.after(() => rm(tempDirectory, { force: true, recursive: true }));

  const inner = createInMemoryIngestJobStore();
  let firstClaim = true;
  let claimReadQueue;
  const claimRead = new Promise((resolve) => {
    claimReadQueue = resolve;
  });
  let releaseClaim;
  const claimGate = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  // The first claim reads an empty queue and is held before it returns: the
  // job is enqueued after that read, while no loop is asleep to wake.
  const store = {
    ...inner,
    async claim(options) {
      const claimed = await inner.claim(options);

      if (firstClaim) {
        firstClaim = false;
        claimReadQueue();
        await claimGate;
      }

      return claimed;
    },
  };
  const worker = createIngestWorker({
    concurrency: 1,
    leaseMs: 60000,
    logger: silentLogger,
    pollIntervalMs: 60 * 60 * 1000,
    ragService: createFakeRagService(),
    store,
    tempDirectory,
    workerId: "racing",
  });

  worker.start();
  t.after(() => worker.stop());
  await claimRead;

  const job = await enqueueFor(inner, ALICE, { docId: "doc-raced" });

  assert.equal(worker.idleLoopCount, 0, "the wake-up found no loop asleep");
  releaseClaim();

  await waitFor(async () => (await inner.get(job.jobId)).status === "succeeded", {
    label: "the loop to look again and claim the job",
  });
});

test("a store whose wake-ups fail to start leaves the worker polling", async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-wake-broken-"));

  t.after(() => rm(tempDirectory, { force: true, recursive: true }));

  const inner = createInMemoryIngestJobStore();
  const errors = [];
  const worker = createIngestWorker({
    concurrency: 1,
    leaseMs: 60000,
    logger: { ...silentLogger, error: (message) => errors.push(message) },
    pollIntervalMs: 5,
    ragService: createFakeRagService(),
    store: {
      ...inner,
      subscribeToEnqueues() {
        throw new Error("INGEST_JOBS_POSTGRES_TABLE must be a simple PostgreSQL identifier.");
      },
    },
    tempDirectory,
    workerId: "polling",
  });

  worker.start();
  t.after(() => worker.stop());
  assert.match(errors[0], /polling every 5 ms instead/);

  const job = await enqueueFor(inner, ALICE, { docId: "doc-polled" });

  await waitFor(async () => (await inner.get(job.jobId)).status === "succeeded", {
    label: "the poll to claim the job",
  });
});

test("the PostgreSQL store wakes subscribers on other processes' NOTIFY, skips its own, and reconnects", async () => {
  const listen = createFakeListenClients({ connectFailures: 1 });
  const { calls, query } = createRecordingQuery(({ sql, values }) => {
    if (/INSERT INTO/.test(sql)) {
      return {
        rows: [
          jobRow({
            attempt_count: 0,
            claimed_by: null,
            doc_id: values[1],
            job_id: values[0],
            status: "queued",
          }),
        ],
      };
    }

    return /WITH released AS/.test(sql) ? { rows: [{ job_id: values[0] }] } : { rows: [] };
  });
  const warnings = [];
  const store = createPostgresIngestJobStore({
    createListenClient: listen.create,
    getTable: () => "Jobs_T",
    listenRetryBaseMs: 1,
    logger: { error() {}, warn: (message) => warnings.push(message) },
    queryPostgres: query,
  });
  const wakes = [];

  assert.equal(getIngestJobsNotifyChannel("Jobs_T"), "jobs_t_enqueued");
  assert.equal(getIngestJobsNotifyChannel("x".repeat(80)).length, 63);

  // Subscribing never waits for the database, even inside a tenant request.
  const unsubscribe = runWithDatabaseTenant(ALICE, () =>
    store.subscribeToEnqueues(() => wakes.push("wake"))
  );

  assert.equal(typeof unsubscribe, "function");
  assert.equal(store.enqueueNotificationStatus().listening, false);

  // The first connect fails; the retry listens on a dedicated owner session.
  await waitFor(() => store.enqueueNotificationStatus().listening, { label: "LISTEN" });

  const [refused, session] = listen.clients;

  assert.equal(refused.ended, true);
  assert.equal(session.tenant, null, "the LISTEN session is the owner's, not the tenant's");
  assert.deepEqual(session.queries, ['LISTEN "jobs_t_enqueued"']);
  assert.deepEqual(wakes, ["wake"], "one look once listening, for jobs announced before");

  // Another process's enqueue.
  session.emit("notification", { channel: "jobs_t_enqueued", payload: "another-store" });
  assert.equal(wakes.length, 2);
  session.emit("notification", { channel: "other_channel", payload: "another-store" });
  assert.equal(wakes.length, 2, "other channels are ignored");

  // This process's enqueue wakes its subscribers directly, after the INSERT;
  // the NOTIFY it sent comes back with this store's id and is skipped.
  await runWithDatabaseTenant(ALICE, () =>
    store.enqueue({ docId: "doc-1", fileBytes: PDF_BYTES, ownerUserId: "alice", workspaceId: "ws-a" })
  );
  assert.equal(wakes.length, 3);

  const ownPayload = calls.find((call) => /INSERT INTO/.test(call.sql)).values[10];

  session.emit("notification", { channel: "jobs_t_enqueued", payload: ownPayload });
  assert.equal(wakes.length, 3, "an own enqueue is not announced twice");

  // A released job is claimable at once, so it is announced like an enqueue.
  assert.equal(await store.release({ attemptCount: 1, jobId: "job-1", workerId: "w1" }), true);
  assert.equal(wakes.length, 4);

  const release = calls.find((call) => /WITH released AS/.test(call.sql));

  assert.match(release.sql, /SELECT released\.job_id, pg_notify\(\$4::text, \$5::text\) AS notified/);
  assert.deepEqual(release.values.slice(3), ["jobs_t_enqueued", ownPayload]);

  // The session drops; the store reconnects and looks once more.
  session.emit("error", new Error("terminating connection due to administrator command"));
  await waitFor(
    () => listen.clients.length === 3 && store.enqueueNotificationStatus().listening,
    { label: "the reconnect" }
  );
  assert.equal(session.ended, true);
  assert.equal(wakes.length, 5);
  assert.match(warnings[0], /closed \(terminating connection due to administrator command\); reconnecting/);

  // The last unsubscribe closes the session and nothing reconnects.
  await unsubscribe();
  await unsubscribe();
  assert.equal(listen.clients[2].ended, true);
  assert.deepEqual(store.enqueueNotificationStatus(), {
    channel: null,
    failures: 0,
    listening: false,
    subscribers: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(listen.clients.length, 3);
});

test("a worker on the PostgreSQL store opens its LISTEN session on start, wakes on NOTIFY and closes it on stop", async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-wake-pg-"));

  t.after(() => rm(tempDirectory, { force: true, recursive: true }));

  const listen = createFakeListenClients();
  let claims = 0;
  const store = createPostgresIngestJobStore({
    createListenClient: listen.create,
    getTable: () => "jobs_t",
    logger: silentLogger,
    queryPostgres: async (sql) => {
      if (/SET status = 'running'/.test(sql)) {
        claims += 1;
      }

      return { rowCount: 0, rows: [] };
    },
  });
  const worker = createIngestWorker({
    concurrency: 1,
    leaseMs: 60000,
    logger: silentLogger,
    pollIntervalMs: 60 * 60 * 1000,
    ragService: createFakeRagService(),
    store,
    tempDirectory,
    workerId: "listening",
  });

  worker.start();
  await waitFor(
    () =>
      store.enqueueNotificationStatus().listening && worker.idleLoopCount === 1 && claims === 2,
    { label: "the start-up claim and the look after LISTEN" }
  );

  listen.clients[0].emit("notification", { channel: "jobs_t_enqueued", payload: "another-store" });
  await waitFor(() => claims === 3, { label: "the claim the NOTIFY woke" });

  await worker.stop();
  assert.equal(listen.clients[0].ended, true, "stop closes the LISTEN session");
  assert.equal(store.enqueueNotificationStatus().subscribers, 0);
});
