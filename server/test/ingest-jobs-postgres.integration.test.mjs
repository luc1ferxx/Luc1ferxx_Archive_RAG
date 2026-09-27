import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

// Real-database checks for the async ingest queue (migration 015): concurrent
// claims never hand one job to two workers, an expired lease moves to the next
// claimer and fences the old one out, a tenant never sees another tenant's
// job, and a retried attempt after a committed-but-unrecorded ingest neither
// fails on duplicate keys nor duplicates chunks. It runs only when
// PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled PostgreSQL whose
// login may create roles and databases (`bash scripts/run-pgvector-integration.sh`
// provisions one); otherwise it is reported as skipped, never as passed.
//
// Like the row-level security suite it provisions its own database owned by a
// non-superuser login, so the tenant policies really apply and no other suite
// shares its tables. Everything it creates is dropped afterwards.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!adminDatabaseUrl) {
  test("ingest job queue PostgreSQL integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `ingest_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `ingest_it_tenant_${suffix}`;
  const databaseName = `ingest_it_${suffix}`;
  const withDatabase = (url, name, { user, password } = {}) => {
    const parsed = new URL(url);

    parsed.pathname = `/${name}`;

    if (user) {
      parsed.username = user;
      parsed.password = password;
    }

    return parsed.toString();
  };
  const adminQuery = async (url, sql) => {
    const client = new pg.Client({ connectionString: url });

    await client.connect();

    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  };

  const ALICE = { userId: "alice", workspaceId: "ws-a" };
  const BOB = { userId: "bob", workspaceId: "ws-b" };
  const PDF_BYTES = Buffer.from("%PDF-1.4 ingest queue integration");
  const silentLogger = { error() {}, log() {}, warn() {} };
  const DIMENSIONS = 8;
  const embed = (text) => {
    const vector = Array.from({ length: DIMENSIONS }, (_, index) =>
      (String(text).charCodeAt(index % Math.max(1, String(text).length)) % 17) + index + 1
    );
    const norm = Math.hypot(...vector);

    return vector.map((value) => value / norm);
  };

  let modules;
  let tables;
  let tempRoot;

  const q = (sql, values) => modules.postgres.queryPostgres(sql, values);

  const clearJobs = () => modules.tenant.runAsDatabaseSystem(() => q(`DELETE FROM ${tables.jobs}`));

  const enqueueFor = (store, scope, docId) =>
    modules.tenant.runWithDatabaseTenant(scope, () =>
      store.enqueue({
        docId,
        fileBytes: PDF_BYTES,
        fileName: `${docId}.pdf`,
        ownerUserId: scope.userId,
        workspaceId: scope.workspaceId,
      })
    );

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "ingest-jobs-it-"));

    await adminQuery(
      adminDatabaseUrl,
      `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`
    );
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(
      withDatabase(adminDatabaseUrl, databaseName),
      "CREATE EXTENSION IF NOT EXISTS vector"
    );

    process.env.POSTGRES_DATABASE_URL = withDatabase(adminDatabaseUrl, databaseName, {
      password: ownerPassword,
      user: ownerRole,
    });
    process.env.POSTGRES_TENANT_ROLE = tenantRole;
    process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
    process.env.VECTOR_STORE_PROVIDER = "pgvector";
    process.env.RAG_HYBRID_ENABLED = "true";
    process.env.OPENAI_EMBEDDING_MODEL = "ingest-it-embedding";
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "ingest-it-key";
    process.env.RAG_EMBEDDING_DIMENSIONS = String(DIMENSIONS);
    // Keeps the registry's legacy importer away from any real data directory.
    process.env.RAG_DATA_DIRECTORY = tempRoot;

    const [config, postgres, tenant, migrations, registry, rag, openai, store, worker] =
      await Promise.all([
        import("../rag/config.js"),
        import("../rag/postgres.js"),
        import("../rag/postgres-tenant.js"),
        import("../rag/db-migrations.js"),
        import("../rag/doc-registry.js"),
        import("../rag/index.js"),
        import("../rag/openai.js"),
        import("../rag/ingest-job-store.js"),
        import("../rag/ingest-worker.js"),
      ]);

    modules = { config, migrations, openai, postgres, rag, registry, store, tenant, worker };
    config.configureEmbeddingDimensions(DIMENSIONS);
    openai.configureOpenAIProvider({
      completeText: async () => "unused",
      embedQuery: async (query) => embed(query),
      embedTexts: async (texts) => texts.map(embed),
    });
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    await migrations.runPostgresMigrations();

    tables = {
      chunks: config.getDocumentChunksPostgresTable(),
      documents: config.getDocumentsPostgresTable(),
      jobs: config.getIngestJobsPostgresTable(),
    };
  });

  after(async () => {
    try {
      modules?.openai.resetOpenAIProvider();
      modules?.config.configureEmbeddingDimensions(null);
      await modules?.registry.resetDocumentRegistryStore();
      await modules?.postgres.resetPostgresPool();
    } finally {
      await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("migration 015 puts the jobs table under the tenant policy", async () => {
    const result = await q(
      `
        SELECT c.relrowsecurity AS rls,
               EXISTS (
                 SELECT 1 FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'
               ) AS has_policy,
               has_table_privilege($2, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS tenant_can_write
        FROM pg_class c
        WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace
      `,
      [tables.jobs, tenantRole]
    );

    assert.deepEqual(result.rows, [{ has_policy: true, rls: true, tenant_can_write: true }]);
  });

  test("concurrent claims hand every job to exactly one claimer", async () => {
    await clearJobs();

    const store = modules.store.createPostgresIngestJobStore();
    const enqueued = [];

    for (let index = 0; index < 8; index += 1) {
      enqueued.push(await enqueueFor(store, index % 2 ? BOB : ALICE, `doc-claim-${index}`));
    }

    const claims = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        store.claim({ leaseMs: 60000, workerId: `claimer-${index}` })
      )
    );
    const won = claims.filter(Boolean);

    assert.equal(won.length, 8, "eight jobs, eight successful claims, sixteen empty ones");
    assert.deepEqual(
      won.map((job) => job.jobId).sort(),
      enqueued.map((job) => job.jobId).sort()
    );
    assert.ok(won.every((job) => job.attemptCount === 1 && job.fileBytes === null));

    const rows = await modules.tenant.runAsDatabaseSystem(() =>
      q(`SELECT claimed_by, attempt_count FROM ${tables.jobs}`)
    );

    assert.equal(new Set(rows.rows.map((row) => row.claimed_by)).size, 8);
    assert.ok(rows.rows.every((row) => row.attempt_count === 1));
  });

  test("two worker loops never process one job twice", async () => {
    await clearJobs();

    const store = modules.store.createPostgresIngestJobStore();
    const processed = [];
    const ragService = {
      getDocument: () => null,
      ingestDocument: async ({ docId }) => {
        processed.push(docId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { docId };
      },
    };
    const jobs = [];

    for (let index = 0; index < 12; index += 1) {
      jobs.push(await enqueueFor(store, index % 3 ? ALICE : BOB, `doc-loop-${index}`));
    }

    const workers = ["worker-a", "worker-b"].map((workerId) =>
      modules.worker.createIngestWorker({
        concurrency: 3,
        leaseMs: 60000,
        logger: silentLogger,
        pollIntervalMs: 10,
        ragService,
        store,
        tempDirectory: tempRoot,
        workerId,
      })
    );

    workers.forEach((worker) => worker.start());

    const deadline = Date.now() + 15000;
    let pending = jobs.length;

    while (pending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await modules.tenant.runAsDatabaseSystem(() =>
        q(`SELECT COUNT(*)::int AS pending FROM ${tables.jobs} WHERE status <> 'succeeded'`)
      );

      pending = result.rows[0].pending;
    }

    await Promise.all(workers.map((worker) => worker.stop()));

    assert.equal(pending, 0);
    assert.equal(processed.length, jobs.length, "every job ingested exactly once");
    assert.equal(new Set(processed).size, jobs.length);

    const rows = await modules.tenant.runAsDatabaseSystem(() =>
      q(`SELECT attempt_count, file_bytes, claimed_by FROM ${tables.jobs}`)
    );

    assert.ok(rows.rows.every((row) => row.attempt_count === 1 && row.file_bytes === null));
    assert.deepEqual(
      [...new Set(rows.rows.map((row) => row.claimed_by))].sort(),
      ["worker-a", "worker-b"],
      "both workers took part"
    );
  });

  test("an expired lease moves to the next claimer and the stale worker is fenced out", async () => {
    await clearJobs();

    const store = modules.store.createPostgresIngestJobStore();
    const job = await enqueueFor(store, ALICE, "doc-lease");
    const stale = await store.claim({ leaseMs: 50, workerId: "stale" });

    assert.equal(await store.claim({ leaseMs: 60000, workerId: "fresh" }), null);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const fresh = await store.claim({ leaseMs: 60000, workerId: "fresh" });

    assert.equal(fresh.jobId, job.jobId);
    assert.equal(fresh.attemptCount, 2);

    const staleFence = { attemptCount: stale.attemptCount, jobId: job.jobId, workerId: "stale" };

    assert.equal(await store.renew({ ...staleFence, leaseMs: 60000 }), false);
    assert.equal(await store.succeed(staleFence), false);
    assert.equal(await store.fail({ ...staleFence, error: "late" }), null);
    assert.equal(
      await store.fail({
        attemptCount: 2,
        error: new Error("embedding service unavailable"),
        jobId: job.jobId,
        retryDelayMs: 60000,
        workerId: "fresh",
      }),
      "queued"
    );
    assert.equal(await store.claim({ leaseMs: 60000, workerId: "early" }), null, "backoff holds");

    const settled = await modules.tenant.runWithDatabaseTenant(ALICE, () =>
      store.get(job.jobId, ALICE)
    );

    assert.equal(settled.status, "queued");
    assert.equal(settled.lastError, modules.store.SERVER_ERROR_MESSAGE);
    assert.equal(settled.claimedBy, "fresh");
  });

  test("a tenant never sees another tenant's job, even without a filter", async () => {
    await clearJobs();

    const store = modules.store.createPostgresIngestJobStore();
    const aliceJob = await enqueueFor(store, ALICE, "doc-alice-job");
    const bobJob = await enqueueFor(store, BOB, "doc-bob-job");
    const unowned = await modules.tenant.runAsDatabaseSystem(() =>
      store.enqueue({ docId: "doc-unowned-job", fileBytes: PDF_BYTES, fileName: "u.pdf" })
    );

    const asBob = (callback) => modules.tenant.runWithDatabaseTenant(BOB, callback);

    assert.equal(await asBob(() => store.get(aliceJob.jobId, BOB)), null);
    // Row-level security alone: the application filter is given no scope.
    assert.equal(await asBob(() => store.get(aliceJob.jobId)), null);
    assert.equal(await asBob(() => store.get(unowned.jobId)), null);
    assert.equal((await asBob(() => store.get(bobJob.jobId, BOB))).jobId, bobJob.jobId);

    const visible = await asBob(() => q(`SELECT job_id FROM ${tables.jobs}`));

    assert.deepEqual(visible.rows.map((row) => row.job_id), [bobJob.jobId]);

    const forged = await asBob(() =>
      q(`UPDATE ${tables.jobs} SET status = 'failed' WHERE job_id = $1`, [aliceJob.jobId])
    );

    assert.equal(forged.rowCount, 0);
    await assert.rejects(
      () =>
        asBob(() =>
          store.enqueue({
            docId: "doc-forged",
            fileBytes: PDF_BYTES,
            fileName: "f.pdf",
            ownerUserId: "alice",
            workspaceId: "ws-a",
          })
        ),
      /row-level security/
    );
  });

  test("an exhausted expired job succeeds when its document committed and fails otherwise", async () => {
    await clearJobs();

    const store = modules.store.createPostgresIngestJobStore();
    const enqueueOnce = (docId) =>
      modules.tenant.runWithDatabaseTenant(ALICE, () =>
        store.enqueue({
          docId,
          fileBytes: PDF_BYTES,
          fileName: `${docId}.pdf`,
          maxAttempts: 1,
          ownerUserId: ALICE.userId,
          workspaceId: ALICE.workspaceId,
        })
      );
    const committedJob = await enqueueOnce(`doc-sweep-committed-${suffix}`);
    const lostJob = await enqueueOnce(`doc-sweep-lost-${suffix}`);

    assert.ok(await store.claim({ leaseMs: 50, workerId: "crashed" }));
    assert.ok(await store.claim({ leaseMs: 50, workerId: "crashed" }));

    // The first attempt committed its document and died before recording it.
    const sourcePath = path.join(tempRoot, "sweep.pdf");

    await writeFile(sourcePath, PDF_BYTES);
    await modules.tenant.runWithDatabaseTenant(ALICE, () =>
      modules.rag.ingestDocumentPages({
        docId: committedJob.docId,
        fileName: "sweep.pdf",
        filePath: sourcePath,
        ownerUserId: ALICE.userId,
        pages: [{ pageNumber: 1, text: "A committed document settles its exhausted job." }],
        workspaceId: ALICE.workspaceId,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(await store.claim({ leaseMs: 60000, workerId: "next" }), null);

    const rows = await modules.tenant.runAsDatabaseSystem(() =>
      q(
        `SELECT job_id, status, last_error, file_bytes FROM ${tables.jobs} ORDER BY created_at`
      )
    );

    assert.deepEqual(rows.rows, [
      { file_bytes: null, job_id: committedJob.jobId, last_error: null, status: "succeeded" },
      {
        file_bytes: null,
        job_id: lostJob.jobId,
        last_error: modules.store.LEASE_EXHAUSTED_ERROR_MESSAGE,
        status: "failed",
      },
    ]);
  });

  test("claims prefer the tenant with the fewest running jobs and bytes come back in slices", async () => {
    await clearJobs();

    const store = modules.store.createPostgresIngestJobStore({ fileReadChunkBytes: 7 });
    const aliceFirst = await enqueueFor(store, ALICE, "doc-fair-a1");
    const aliceSecond = await enqueueFor(store, ALICE, "doc-fair-a2");
    const bobJob = await enqueueFor(store, BOB, "doc-fair-b1");

    const first = await store.claim({ leaseMs: 60000, workerId: "fair" });
    const second = await store.claim({ leaseMs: 60000, workerId: "fair" });
    const third = await store.claim({ leaseMs: 60000, workerId: "fair" });

    assert.deepEqual(
      [first.jobId, second.jobId, third.jobId],
      [aliceFirst.jobId, bobJob.jobId, aliceSecond.jobId],
      "bob's later job goes before alice's backlog"
    );
    assert.equal(first.recoveredFromExpiredLease, false);

    const copyPath = path.join(tempRoot, "copied.pdf");
    const fence = { attemptCount: 1, jobId: bobJob.jobId, workerId: "fair" };

    assert.equal(await store.copyJobFile({ ...fence, filePath: copyPath }), true);
    assert.deepEqual(await readFile(copyPath), PDF_BYTES);
    assert.equal(
      await store.copyJobFile({ ...fence, filePath: copyPath, workerId: "stale" }),
      false
    );
  });

  test("enqueue refuses a tenant over its pending cap and old finished jobs are pruned", async () => {
    await clearJobs();

    const capped = modules.store.createPostgresIngestJobStore({
      getPendingLimits: () => ({ maxPendingBytes: PDF_BYTES.length * 2, maxPendingJobs: 2 }),
    });

    await enqueueFor(capped, ALICE, "doc-cap-1");
    await enqueueFor(capped, ALICE, "doc-cap-2");
    await assert.rejects(
      () => enqueueFor(capped, ALICE, "doc-cap-3"),
      (error) => error.status === 429
    );
    await enqueueFor(capped, BOB, "doc-cap-bob");

    const claimed = await capped.claim({ leaseMs: 60000, workerId: "cap" });

    assert.equal(await capped.succeed({ attemptCount: 1, jobId: claimed.jobId, workerId: "cap" }), true);
    await enqueueFor(capped, claimed.ownerUserId === "alice" ? ALICE : BOB, "doc-cap-after");

    assert.equal(await capped.pruneFinished({ olderThanMs: 60 * 60 * 1000 }), 0);
    await modules.tenant.runAsDatabaseSystem(() =>
      q(`UPDATE ${tables.jobs} SET finished_at = NOW() - INTERVAL '2 hours' WHERE job_id = $1`, [
        claimed.jobId,
      ])
    );
    assert.equal(await capped.pruneFinished({ olderThanMs: 60 * 60 * 1000 }), 1);

    const remaining = await modules.tenant.runAsDatabaseSystem(() =>
      q(`SELECT COUNT(*)::int AS count FROM ${tables.jobs}`)
    );

    assert.equal(remaining.rows[0].count, 3);
  });

  test("a retry after a committed but unrecorded ingest neither fails nor duplicates chunks", async () => {
    await clearJobs();

    const store = modules.store.createPostgresIngestJobStore();
    const pages = [
      { pageNumber: 1, text: "Queue ingestion writes the document row and its chunks together." },
      { pageNumber: 2, text: "A retried attempt must leave exactly one copy of every chunk." },
    ];
    let ingestCalls = 0;
    const ragService = {
      getDocument: modules.rag.getDocument,
      // The real ingest path over synthetic pages (the fixture is not a real
      // PDF), in the job tenant's transaction.
      ingestDocument: async (input) => {
        ingestCalls += 1;
        return modules.rag.ingestDocumentPages({ ...input, pages });
      },
      loadDocumentsFromStore: modules.rag.loadDocumentsFromStore,
      resyncDocument: modules.rag.resyncDocument,
    };
    const job = await enqueueFor(store, ALICE, `doc-retry-${suffix}`);
    const chunkCount = async () =>
      (
        await modules.tenant.runAsDatabaseSystem(() =>
          q(`SELECT COUNT(*)::int AS count FROM ${tables.chunks} WHERE doc_id = $1`, [job.docId])
        )
      ).rows[0].count;

    // Attempt 1 commits the document and dies before recording success.
    const crashed = modules.worker.createIngestWorker({
      leaseMs: 50,
      logger: silentLogger,
      ragService,
      store: {
        ...store,
        succeed: async () => {
          throw new Error("process killed");
        },
      },
      tempDirectory: tempRoot,
      workerId: "crashed",
    });

    await assert.rejects(() => crashed.runOnce(), /process killed/);
    assert.equal(ingestCalls, 1);
    const committedChunks = await chunkCount();

    assert.ok(committedChunks > 0);

    // Re-running the same ingest (what a retry without the shortcut does) is
    // itself idempotent: the row is upserted and the chunks replaced.
    const againPath = path.join(tempRoot, "again.pdf");

    await writeFile(againPath, PDF_BYTES);
    await modules.tenant.runWithDatabaseTenant(ALICE, () =>
      ragService.ingestDocument({
        docId: job.docId,
        fileName: "again.pdf",
        filePath: againPath,
        ownerUserId: ALICE.userId,
        workspaceId: ALICE.workspaceId,
      })
    );
    assert.equal(await chunkCount(), committedChunks);

    // A fresh process: nothing in its registry map yet.
    await modules.registry.resetDocumentRegistry();
    await new Promise((resolve) => setTimeout(resolve, 120));

    const retry = modules.worker.createIngestWorker({
      leaseMs: 60000,
      logger: silentLogger,
      ragService,
      store,
      tempDirectory: tempRoot,
      workerId: "retry",
    });

    assert.deepEqual(await retry.runOnce(), { jobId: job.jobId, outcome: "succeeded" });
    assert.equal(ingestCalls, 2, "the retry found the committed document and did not ingest");
    assert.equal(await chunkCount(), committedChunks);

    const row = await modules.tenant.runAsDatabaseSystem(() =>
      q(`SELECT status, attempt_count, file_bytes, doc_id FROM ${tables.jobs} WHERE job_id = $1`, [
        job.jobId,
      ])
    );

    assert.deepEqual(row.rows[0], {
      attempt_count: 2,
      doc_id: job.docId,
      file_bytes: null,
      status: "succeeded",
    });
    assert.equal(modules.rag.getDocument(job.docId, ALICE).docId, job.docId);
    assert.equal(modules.rag.getDocument(job.docId, BOB), null);
  });
}
