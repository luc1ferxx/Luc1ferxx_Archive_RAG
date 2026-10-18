import test from "node:test";
import assert from "node:assert/strict";

import {
  getRagIngestMaxPendingBytesPerWorkspace,
  getRagIngestMaxPendingJobsPerWorkspace,
} from "../rag/config.js";
import {
  createInMemoryIngestJobStore,
  createPostgresIngestJobStore,
  PENDING_LIMIT_ERROR_MESSAGE,
  WORKSPACE_PENDING_LIMIT_ERROR_MESSAGE,
} from "../rag/ingest-job-store.js";
import { getDatabaseTenantContext, runWithDatabaseTenant } from "../rag/postgres-tenant.js";

const PDF_BYTES = Buffer.from("%PDF-1.4 workspace caps");
let docCounter = 0;

const enqueue = (store, { ownerUserId, workspaceId = "", bytes = PDF_BYTES }) => {
  docCounter += 1;

  return store.enqueue({
    docId: `doc-${docCounter}`,
    fileBytes: bytes,
    fileName: "a.pdf",
    ownerUserId,
    workspaceId,
  });
};

const isWorkspaceCap = (error) =>
  error.status === 429 && error.expose === true && error.message === WORKSPACE_PENDING_LIMIT_ERROR_MESSAGE;

test("the workspace caps default to 0 (off)", () => {
  const saved = [
    process.env.RAG_INGEST_MAX_PENDING_JOBS_PER_WORKSPACE,
    process.env.RAG_INGEST_MAX_PENDING_BYTES_PER_WORKSPACE,
  ];

  delete process.env.RAG_INGEST_MAX_PENDING_JOBS_PER_WORKSPACE;
  delete process.env.RAG_INGEST_MAX_PENDING_BYTES_PER_WORKSPACE;

  try {
    assert.equal(getRagIngestMaxPendingJobsPerWorkspace(), 0);
    assert.equal(getRagIngestMaxPendingBytesPerWorkspace(), 0);
    process.env.RAG_INGEST_MAX_PENDING_JOBS_PER_WORKSPACE = "4";
    process.env.RAG_INGEST_MAX_PENDING_BYTES_PER_WORKSPACE = "1000";
    assert.equal(getRagIngestMaxPendingJobsPerWorkspace(), 4);
    assert.equal(getRagIngestMaxPendingBytesPerWorkspace(), 1000);
  } finally {
    for (const [name, value] of [
      ["RAG_INGEST_MAX_PENDING_JOBS_PER_WORKSPACE", saved[0]],
      ["RAG_INGEST_MAX_PENDING_BYTES_PER_WORKSPACE", saved[1]],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("in-memory store: the workspace job cap counts every user's pending jobs in the workspace", async () => {
  const store = createInMemoryIngestJobStore({
    getPendingLimits: () => ({ maxPendingBytes: 0, maxPendingJobs: 0, maxPendingJobsPerWorkspace: 2 }),
  });

  const first = await enqueue(store, { ownerUserId: "alice", workspaceId: "ws-a" });

  await enqueue(store, { ownerUserId: "bob", workspaceId: "ws-a" });
  await assert.rejects(enqueue(store, { ownerUserId: "carol", workspaceId: "ws-a" }), isWorkspaceCap);
  // Other workspaces and workspace-less jobs are not counted.
  await enqueue(store, { ownerUserId: "alice", workspaceId: "ws-b" });
  await enqueue(store, { ownerUserId: "alice" });
  await enqueue(store, { ownerUserId: "alice" });
  await enqueue(store, { ownerUserId: "alice" });

  // A finished job frees its place.
  const claimed = await store.claim({ leaseMs: 1000, workerId: "w" });

  assert.equal(claimed.jobId, first.jobId);
  await store.succeed({ attemptCount: 1, jobId: first.jobId, workerId: "w" });
  await enqueue(store, { ownerUserId: "carol", workspaceId: "ws-a" });
});

test("in-memory store: the workspace byte cap, and the per-tenant caps still apply first-come", async () => {
  const store = createInMemoryIngestJobStore({
    getPendingLimits: () => ({
      maxPendingBytes: 0,
      maxPendingBytesPerWorkspace: PDF_BYTES.length * 2,
      maxPendingJobs: 1,
    }),
  });

  await enqueue(store, { ownerUserId: "alice", workspaceId: "ws-a" });
  await assert.rejects(
    enqueue(store, { ownerUserId: "alice", workspaceId: "ws-a" }),
    (error) => error.status === 429 && error.message === PENDING_LIMIT_ERROR_MESSAGE
  );
  await enqueue(store, { ownerUserId: "bob", workspaceId: "ws-a" });
  await assert.rejects(enqueue(store, { ownerUserId: "carol", workspaceId: "ws-a" }), isWorkspaceCap);
});

const createRecordingQuery = (respond) => {
  const calls = [];

  return {
    calls,
    query: async (sql, values) => {
      calls.push({ context: getDatabaseTenantContext(), sql, values });
      return respond({ sql, values }) ?? { rows: [] };
    },
  };
};

const insertedRow = (values) => ({
  attempt_count: 0,
  content_sha256: null,
  created_at: new Date("2026-10-17T10:00:00Z"),
  doc_id: values[1],
  file_name: values[4],
  job_id: values[0],
  kind: "create",
  max_attempts: 3,
  owner_user_id: values[2],
  stage: "parse",
  status: "queued",
  updated_at: new Date("2026-10-17T10:00:00Z"),
  workspace_id: values[3],
});

test("postgres store: without workspace caps the enqueue is the single INSERT it always was", async () => {
  const { calls, query } = createRecordingQuery(({ sql, values }) =>
    /INSERT INTO/.test(sql) ? { rows: [insertedRow(values)] } : null
  );
  const store = createPostgresIngestJobStore({
    getPendingLimits: () => ({ maxPendingBytes: 0, maxPendingJobs: 5 }),
    getTable: () => "jobs_t",
    queryPostgres: query,
  });

  await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws-a" }, () =>
    enqueue(store, { ownerUserId: "alice", workspaceId: "ws-a" })
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO jobs_t/);
  assert.equal(calls[0].context, "tenant");
});

test("postgres store: a workspace cap reads the workspace's pending jobs as system work before the INSERT", async () => {
  let pending = { pending_bytes: "0", pending_jobs: "1" };
  const { calls, query } = createRecordingQuery(({ sql, values }) => {
    if (/INSERT INTO/.test(sql)) {
      return { rows: [insertedRow(values)] };
    }

    return { rows: [pending] };
  });
  const store = createPostgresIngestJobStore({
    getPendingLimits: () => ({
      maxPendingBytes: 0,
      maxPendingBytesPerWorkspace: 1000,
      maxPendingJobs: 0,
      maxPendingJobsPerWorkspace: 2,
    }),
    getTable: () => "jobs_t",
    queryPostgres: query,
  });
  const asAlice = (callback) => runWithDatabaseTenant({ userId: "alice", workspaceId: "ws-a" }, callback);

  await asAlice(() => enqueue(store, { ownerUserId: "alice", workspaceId: "ws-a" }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context, "system", "a workspace's jobs belong to several users");
  assert.match(calls[0].sql, /FROM jobs_t AS p\s+WHERE p\.workspace_id = \$1::text\s+AND p\.status IN \('queued', 'running'\)/);
  assert.match(calls[0].sql, /FROM jobs_t_outputs AS o/);
  assert.deepEqual(calls[0].values, ["ws-a"]);
  assert.equal(calls[1].context, "tenant", "the INSERT stays the tenant's");

  pending = { pending_bytes: "0", pending_jobs: "2" };
  calls.length = 0;
  await assert.rejects(asAlice(() => enqueue(store, { ownerUserId: "alice", workspaceId: "ws-a" })), isWorkspaceCap);
  assert.equal(calls.length, 1, "refused before the INSERT");

  pending = { pending_bytes: String(1000 - PDF_BYTES.length + 1), pending_jobs: "0" };
  await assert.rejects(asAlice(() => enqueue(store, { ownerUserId: "alice", workspaceId: "ws-a" })), isWorkspaceCap);

  // A job without a workspace is not counted against one.
  calls.length = 0;
  await runWithDatabaseTenant({ userId: "alice", workspaceId: "" }, () => enqueue(store, { ownerUserId: "alice" }));
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO jobs_t/);
});
