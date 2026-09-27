import test from "node:test";
import assert from "node:assert/strict";
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
  isRagIngestAsync,
  isRagIngestWorkerEnabled,
} from "../rag/config.js";
import { renderMigrationSql } from "../rag/db-migrations.js";
import {
  configureDocumentRegistryStore,
  getDocument,
  initializeDocumentRegistry,
  listDocuments,
  loadDocumentsFromStore,
  refreshDocumentRegistry,
  registerDocument,
  resetDocumentRegistryStore,
  resyncDocument,
  trackDocumentWrite,
} from "../rag/doc-registry.js";
import {
  createDefaultIngestJobStore,
  createInMemoryIngestJobStore,
  createPostgresIngestJobStore,
  INGEST_JOB_STATUSES,
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
    },
    async () => {
      assert.equal(getRagIngestMode(), "sync");
      assert.equal(isRagIngestAsync(), false);
      assert.equal(isRagIngestWorkerEnabled(), true);
      assert.equal(getRagIngestWorkerConcurrency(), 2);
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
    },
    async () => {
      assert.equal(getRagIngestMode(), "async");
      assert.equal(isRagIngestAsync(), true);
      assert.equal(isRagIngestWorkerEnabled(), false);
      assert.equal(getRagIngestWorkerConcurrency(), 4);
      assert.equal(getRagIngestJobLeaseMs(), 15000);
      assert.equal(getRagIngestJobMaxAttempts(), 5);
      assert.equal(getIngestJobsPostgresTable(), "custom_jobs");
    }
  );

  await withEnv(
    { RAG_INGEST_MODE: "later", RAG_INGEST_WORKER_CONCURRENCY: "0.5" },
    async () => {
      assert.equal(getRagIngestMode(), "sync");
      assert.equal(getRagIngestWorkerConcurrency(), 1);
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

test("in-memory store requeues failures with a delay and fails the job once attempts are exhausted", async () => {
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
    error: "still unavailable",
    jobId: job.jobId,
    retryDelayMs: 5000,
    workerId: "w",
  });

  assert.equal(final, "failed");
  snapshot = await store.get(job.jobId);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.lastError, "still unavailable");
  assert.ok(snapshot.finishedAt);

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

test("in-memory store fails a job whose last allowed attempt let its lease expire", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const job = await enqueueFor(store, ALICE, { maxAttempts: 1 });

  await store.claim({ leaseMs: 1000, workerId: "crashed" });
  clock.advance(1001);

  assert.equal(await store.claim({ leaseMs: 1000, workerId: "next" }), null);

  const snapshot = await store.get(job.jobId);

  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.lastError, LEASE_EXHAUSTED_ERROR_MESSAGE);
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
    ["jobId", "docId", "fileName", "status", "attemptCount", "error", "createdAt", "startedAt", "finishedAt"]
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

  // An exhausted expired job is settled from whether its document committed.
  assert.match(sweep.sql, /SET status = CASE WHEN committed\.doc_id IS NULL THEN 'failed' ELSE 'succeeded' END/);
  assert.match(sweep.sql, /LEFT JOIN docs_t AS committed ON committed\.doc_id = expired\.doc_id/);
  assert.match(sweep.sql, /expired\.lease_expires_at < NOW\(\)\s+AND expired\.attempt_count >= expired\.max_attempts/);
  assert.deepEqual(sweep.values, [LEASE_EXHAUSTED_ERROR_MESSAGE]);
  assert.match(claim.sql, /UPDATE jobs_t AS j/);
  assert.match(claim.sql, /attempt_count = j\.attempt_count \+ 1/);
  assert.match(claim.sql, /WITH candidate AS \(\s+SELECT c\.job_id, c\.status AS previous_status\s+FROM jobs_t AS c/);
  assert.match(claim.sql, /\(c\.status = 'queued' AND c\.available_at <= NOW\(\)\)/);
  assert.match(claim.sql, /c\.status = 'running'\s+AND c\.lease_expires_at < NOW\(\)\s+AND c\.attempt_count < c\.max_attempts/);
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

    return /RETURNING status/.test(sql) ? { rows: [{ status: "queued" }] } : { rows: [{ job_id: values[0] }] };
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
  assert.match(calls[2].sql, /WHEN \$4::boolean AND attempt_count < max_attempts\s+THEN 'queued' ELSE 'failed'/);
  assert.deepEqual(calls[2].values.slice(3), [true, 5000, "boom"]);
  assert.match(calls[3].sql, /attempt_count = GREATEST\(attempt_count - 1, 0\),\s+claimed_by = NULL/);

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
  assert.deepEqual(calls[0].values, [
    "job-1",
    "doc-1",
    "alice",
    "ws-a",
    "notes.pdf",
    PDF_BYTES,
    4,
    getRagIngestMaxPendingJobsPerTenant(),
    getRagIngestMaxPendingBytesPerTenant(),
  ]);
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
  assert.equal(failed.status, "failed");
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

test("worker requeues retryable failures, fails at the attempt limit, and fails upload errors at once", async () => {
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
  assert.equal((await worker.runOnce()).outcome, "failed");

  const failed = await store.get(flaky.jobId, ALICE);

  assert.equal(failed.status, "failed");
  assert.equal(failed.attemptCount, 3);
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

test("a refresh reads the requesting tenant's documents only, and concurrent callers share it", async (t) => {
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

  assert.deepEqual(listings, [ALICE], "one listing, for alice's scope");
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

test("the cross-process document helpers only read the store in async mode", async () => {
  const calls = [];
  const ragService = {
    loadDocumentsFromStore: async (docIds) => {
      calls.push(["load", docIds]);
    },
    refreshDocumentRegistry: async () => {
      calls.push(["refresh"]);
      throw new Error("database unavailable");
    },
  };
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    await withEnv({ RAG_INGEST_MODE: undefined }, async () => {
      await loadDocumentsIngestedElsewhere(ragService, ["doc-1"]);
      await refreshDocumentsIngestedElsewhere(ragService);
    });
    assert.deepEqual(calls, []);

    await withEnv({ RAG_INGEST_MODE: "async" }, async () => {
      await loadDocumentsIngestedElsewhere(ragService, ["doc-1"]);
      await refreshDocumentsIngestedElsewhere(ragService);
      await loadDocumentsIngestedElsewhere({}, ["doc-1"]);
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls, [["load", ["doc-1"]], ["refresh"]], "a failed refresh is logged, not thrown");
});
