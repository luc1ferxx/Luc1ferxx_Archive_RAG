import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";

// Real-database checks for the staged ingest pipeline (migrations 017 and 018,
// rag/ingest-pipeline.js, rag/ingest-worker.js, rag/ingest-job-store.js):
//
// * a job's stages persist their outputs, the PDF leaves the job row once
//   parse succeeded, and the index stage commits the document together with
//   the job's success (a lost lease rolls the document back);
// * a worker killed in any stage leaves a job the next worker resumes at that
//   stage, without re-running the stages before it;
// * the embed stages of concurrent jobs share one embeddings request, each job
//   gets its own vectors, and a bad input fails only its own job;
// * a stage out of attempts dead-letters the job, listed and requeued per
//   tenant under the row policies, counted in health, resumed at its stage;
// * identical bytes resolve to the tenant's existing document, never to
//   another tenant's, also when two identical uploads race;
// * a replacement swaps the chunks atomically while tenant searches run, and
//   one during an index-version build reaches the building version too.
//
// It runs only when PGVECTOR_TEST_DATABASE_URL points at a pgvector-enabled
// PostgreSQL whose login may create roles and databases (`bash
// scripts/run-pgvector-integration.sh` provisions one); otherwise it is
// reported as skipped, never as passed. Like the other ingest suites it
// provisions its own database owned by a non-superuser login, so the tenant
// policies really apply, and drops everything afterwards.

const adminDatabaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

const MODEL_A = "pipeline-it-embed-a";
const MODEL_B = "pipeline-it-embed-b";
const TOPICS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "orchard", "bridge", "copper", "policy"];
const DIMENSIONS = { [MODEL_A]: TOPICS.length + 1, [MODEL_B]: 6 };
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };
const POINTER_TTL_MS = 300;
const silentLogger = { error() {}, log() {}, warn() {} };

const embedFor = (text, model = MODEL_A) => {
  const lower = String(text).toLowerCase();
  const hits = TOPICS.map((topic) => (new RegExp(`\\b${topic}\\b`).test(lower) ? 1 : 0));

  if (model === MODEL_B) {
    return [hits[0] + hits[5], hits[1] + hits[6], hits[2] + hits[7], hits[3] + hits[8], hits[4] + hits[9], 0.1];
  }

  return [...hits, 0.05];
};

if (!adminDatabaseUrl) {
  test("staged ingest pipeline PostgreSQL integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` to run the real-database suites",
  }, () => {});
} else {
  const suffix = randomBytes(6).toString("hex");
  const ownerRole = `pipeline_it_owner_${suffix}`;
  const ownerPassword = `pw_${randomBytes(12).toString("hex")}`;
  const tenantRole = `pipeline_it_tenant_${suffix}`;
  const databaseName = `pipeline_it_${suffix}`;
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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The embedding provider: counts every documents request, can refuse any
  // text containing POISON (a 400 for that input) and can be down (503).
  const provider = {
    down: false,
    requests: [],
  };
  const embeddingProvider = {
    completeText: async () => "unused",
    embedQuery: async (query, options) => embedFor(query, options?.embeddingSpace?.model ?? MODEL_A),
    embedTexts: async (texts, options) => {
      const model = options?.embeddingSpace?.model ?? MODEL_A;

      provider.requests.push({ count: texts.length, model, texts: [...texts] });

      if (provider.down) {
        throw Object.assign(new Error("embedding service unavailable"), { status: 503 });
      }

      if (texts.some((text) => text.includes("POISON"))) {
        throw Object.assign(new Error("input rejected"), { status: 400 });
      }

      return texts.map((text) => embedFor(text, model));
    },
  };

  let modules;
  let tempRoot;

  const q = (sql, values = []) => modules.tenant.runAsDatabaseSystem(() => modules.postgres.queryPostgres(sql, values));
  const asTenant = (scope, callback) => modules.tenant.runWithDatabaseTenant(scope, callback);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const pdf = (...pages) => buildTextPdf({ pages: pages.map((page) => (Array.isArray(page) ? page : [page])) });
  const writePdf = async (name, bytes) => {
    const filePath = path.join(tempRoot, `${name}-${randomBytes(3).toString("hex")}.pdf`);

    await writeFile(filePath, bytes);
    return filePath;
  };
  const jobRow = async (jobId) =>
    (
      await q(
        `SELECT status, stage, stage_attempts, max_attempts, attempt_count, file_bytes IS NULL AS bytes_dropped,
                resolved_doc_id, duplicate, document_version, dead_letter_stage, dead_letter_reason, kind
           FROM rag_ingest_jobs WHERE job_id = $1`,
        [jobId]
      )
    ).rows[0];
  const outputsOf = async (jobId) =>
    (await q(`SELECT output FROM rag_ingest_jobs_outputs WHERE job_id = $1 ORDER BY output`, [jobId])).rows.map(
      (row) => row.output
    );
  const documentRow = async (docId) =>
    (
      await q(
        `SELECT doc_id, owner_user_id, content_sha256, content_version, uploaded_at::text AS uploaded_at, file_name
           FROM rag_documents WHERE doc_id = $1`,
        [docId]
      )
    ).rows[0] ?? null;
  const chunkVersions = async (table, docId) =>
    (
      await q(
        `SELECT (metadata->>'documentVersion')::int AS version, content FROM ${table} WHERE doc_id = $1 ORDER BY chunk_index`,
        [docId]
      )
    ).rows;

  const enqueue = (store, scope, { bytes, docId, kind = "create", deduplicate = false, maxAttempts } = {}) =>
    asTenant(scope, () =>
      store.enqueue({
        contentSha256: sha256(bytes),
        deduplicate,
        docId,
        fileBytes: bytes,
        fileName: `${docId}.pdf`,
        kind,
        ...(maxAttempts ? { maxAttempts } : {}),
        ownerUserId: scope.userId,
        workspaceId: scope.workspaceId,
      })
    );

  // A pipeline over the real stages that counts every stage call and can be
  // told to throw in one of them (the index stage throws inside its write
  // transaction, after the job's success was written in it).
  const createCountingPipeline = ({ batcher, crashAt = null, loadPages = null } = {}) => {
    const counts = { chunk: 0, embed: 0, index: 0, parse: 0 };
    const real = modules.pipeline.createIngestPipeline({
      batcher:
        batcher ??
        modules.batcher.createEmbeddingBatcher({
          embed: (texts, space) => modules.vectorStore.embedDocumentTextsForIndex(texts, space),
          lingerMs: 5,
          logger: silentLogger,
        }),
      ...(loadPages ? { loadPages } : {}),
    });
    const crash = () => Object.assign(new Error("process killed"), { status: 503 });
    const wrap = (stage) => async (input) => {
      counts[stage] += 1;

      if (crashAt === stage && stage !== "index") {
        throw crash();
      }

      if (stage === "index" && crashAt === "index") {
        return real.index({
          ...input,
          onCommit: async (outcome) => {
            await input.onCommit(outcome);
            throw crash();
          },
        });
      }

      return real[stage](input);
    };

    return {
      counts,
      pipeline: {
        findDuplicate: real.findDuplicate,
        chunk: wrap("chunk"),
        embed: wrap("embed"),
        index: wrap("index"),
        parse: wrap("parse"),
      },
    };
  };

  const createWorker = ({ pipeline, store, workerId, ...options }) =>
    modules.worker.createIngestWorker({
      leaseMs: 60000,
      logger: silentLogger,
      pipeline,
      retryDelayMs: () => 0,
      settleRetryDelayMs: 1,
      store,
      tempDirectory: tempRoot,
      workerId,
      ...options,
    });

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "ingest-pipeline-it-"));

    await adminQuery(adminDatabaseUrl, `CREATE ROLE ${ownerRole} LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
    await adminQuery(adminDatabaseUrl, `CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
    await adminQuery(withDatabase(adminDatabaseUrl, databaseName), "CREATE EXTENSION IF NOT EXISTS vector");

    process.env.POSTGRES_DATABASE_URL = withDatabase(adminDatabaseUrl, databaseName, {
      password: ownerPassword,
      user: ownerRole,
    });
    process.env.LONG_MEMORY_DATABASE_URL = "";
    process.env.POSTGRES_TENANT_ROLE = tenantRole;
    process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
    process.env.VECTOR_STORE_PROVIDER = "pgvector";
    process.env.RAG_HYBRID_ENABLED = "true";
    process.env.OPENAI_EMBEDDING_MODEL = MODEL_A;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "pipeline-it-key";
    process.env.RAG_EMBEDDING_DIMENSIONS = String(DIMENSIONS[MODEL_A]);
    process.env.RAG_INDEX_VERSION_POINTER_TTL_MS = String(POINTER_TTL_MS);
    process.env.RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS = "600000";
    process.env.PDF_PARSER = "pdfjs";
    // Keeps the registry's legacy importer away from any real data directory.
    process.env.RAG_DATA_DIRECTORY = tempRoot;

    const [
      config,
      postgres,
      tenant,
      migrations,
      registry,
      rag,
      openai,
      store,
      worker,
      pipeline,
      batcher,
      vectorStore,
      pgvector,
      lifecycle,
      health,
      cli,
    ] = await Promise.all([
      import("../rag/config.js"),
      import("../rag/postgres.js"),
      import("../rag/postgres-tenant.js"),
      import("../rag/db-migrations.js"),
      import("../rag/doc-registry.js"),
      import("../rag/index.js"),
      import("../rag/openai.js"),
      import("../rag/ingest-job-store.js"),
      import("../rag/ingest-worker.js"),
      import("../rag/ingest-pipeline.js"),
      import("../rag/ingest-embedding-batcher.js"),
      import("../rag/vector-store.js"),
      import("../rag/vector-store-pgvector.js"),
      import("../rag/vector-store-pgvector-version-lifecycle.js"),
      import("../health.js"),
      import("../ingest-jobs.mjs"),
    ]);

    modules = {
      batcher,
      cli,
      config,
      health,
      lifecycle,
      migrations,
      openai,
      pgvector,
      pipeline,
      postgres,
      rag,
      registry,
      store,
      tenant,
      vectorStore,
      worker,
    };
    config.configureEmbeddingDimensions(DIMENSIONS[MODEL_A]);
    openai.configureOpenAIProvider(embeddingProvider);
    await postgres.resetPostgresPool();
    migrations.resetPostgresMigrations();
    await registry.resetDocumentRegistryStore();
    vectorStore.resetVectorStore();
    await migrations.runPostgresMigrations();
    await registry.initializeDocumentRegistry();
  });

  after(async () => {
    try {
      modules?.openai.resetOpenAIProvider();
      modules?.config.configureEmbeddingDimensions(null);
      modules?.vectorStore.resetVectorStore();
      await modules?.registry.resetDocumentRegistryStore();
      await modules?.postgres.resetPostgresPool();
    } finally {
      await adminQuery(adminDatabaseUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${tenantRole}`);
      await adminQuery(adminDatabaseUrl, `DROP ROLE IF EXISTS ${ownerRole}`);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("migrations 017 and 018 put the stage outputs under the tenant policy and give documents a content identity", async () => {
    const security = (
      await q(
        `SELECT c.relrowsecurity AS rls,
                EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
                has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS granted
           FROM pg_class c
          WHERE c.relname = 'rag_ingest_jobs_outputs' AND c.relnamespace = current_schema()::regnamespace`,
        [tenantRole]
      )
    ).rows[0];

    assert.deepEqual(security, { granted: true, policy: true, rls: true });

    const columns = (
      await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'rag_documents' AND column_name LIKE 'content_%' ORDER BY column_name`
      )
    ).rows.map((row) => row.column_name);

    assert.deepEqual(columns, ["content_sha256", "content_updated_at", "content_version"]);
    await assert.rejects(
      () => q(`INSERT INTO rag_ingest_jobs (job_id, doc_id, status) VALUES ('bad', 'd', 'dead')`),
      /rag_ingest_jobs_status_check/
    );
  });

  test("a staged job stores each stage's output, drops the PDF after parse, and commits its document with its success", async () => {
    const store = modules.store.createPostgresIngestJobStore({ logger: silentLogger });
    const bytes = pdf("Orchard pruning happens in late winter.", "Copper wiring needs grounding.");
    const job = await enqueue(store, ALICE, { bytes, deduplicate: true, docId: `doc-staged-${suffix}` });
    const afterStages = {};
    const { counts, pipeline } = createCountingPipeline();
    const worker = createWorker({
      hooks: {
        afterStage: async ({ stage }) => {
          afterStages[stage] = { job: await jobRow(job.jobId), outputs: await outputsOf(job.jobId) };
        },
      },
      pipeline,
      store,
      workerId: "staged",
    });

    assert.deepEqual(await worker.runOnce(), { jobId: job.jobId, outcome: "succeeded" });
    assert.deepEqual(counts, { chunk: 1, embed: 1, index: 1, parse: 1 });
    assert.equal(afterStages.parse.job.stage, "chunk");
    assert.equal(afterStages.parse.job.bytes_dropped, true, "the PDF left the job row when parse succeeded");
    assert.deepEqual(afterStages.parse.outputs, ["document_file", "pages"]);
    assert.deepEqual(afterStages.embed.outputs, ["chunks", "document_file", "embeddings", "pages"]);
    assert.equal(afterStages.embed.job.stage_attempts, 1);

    const finished = await jobRow(job.jobId);

    assert.equal(finished.status, "succeeded");
    assert.equal(finished.document_version, 1);
    assert.deepEqual(await outputsOf(job.jobId), [], "a finished job keeps no outputs");

    const document = await documentRow(job.docId);

    assert.equal(document.content_sha256, sha256(bytes));
    assert.equal(document.content_version, 1);
    assert.ok((await chunkVersions("rag_document_chunks", job.docId)).every((chunk) => chunk.version === 1));
    assert.equal(modules.rag.getDocument(job.docId, ALICE).version, 1);

    // A job that lost its lease between embed and index: its index write
    // rolls back together with the success it tried to record.
    const stolen = await enqueue(store, ALICE, { bytes: pdf("Bridge inspections are biennial."), docId: `doc-stolen-${suffix}` });
    const stealing = createCountingPipeline();
    const thief = createWorker({
      hooks: {
        afterStage: async ({ stage }) => {
          if (stage === "embed") {
            await q(`UPDATE rag_ingest_jobs SET claimed_by = 'someone-else' WHERE job_id = $1`, [stolen.jobId]);
          }
        },
      },
      pipeline: stealing.pipeline,
      store,
      workerId: "loser",
    });

    assert.deepEqual(await thief.runOnce(), { jobId: stolen.jobId, outcome: "lease_lost" });
    assert.equal(await documentRow(stolen.docId), null, "nothing was committed");
    assert.deepEqual(await chunkVersions("rag_document_chunks", stolen.docId), []);
  });

  for (const crashStage of ["parse", "chunk", "embed", "index"]) {
    test(`a worker killed in ${crashStage} leaves a job the next worker resumes at ${crashStage}`, async () => {
      const store = modules.store.createPostgresIngestJobStore({ logger: silentLogger });
      const bytes = pdf(`Delta clause ${crashStage} covers scoped workspace documents.`);
      const job = await enqueue(store, BOB, { bytes, docId: `doc-crash-${crashStage}-${suffix}` });
      const dying = createCountingPipeline({ crashAt: crashStage });
      // The process dies right after the stage failed: nothing records it.
      const deadStore = {
        ...store,
        fail: async () => {
          throw new Error("process killed");
        },
      };
      const dyingWorker = createWorker({
        leaseMs: 300,
        pipeline: dying.pipeline,
        store: deadStore,
        workerId: `dying-${crashStage}`,
      });

      await assert.rejects(() => dyingWorker.runOnce(), /process killed/);

      const midway = await jobRow(job.jobId);
      const stagesBefore = ["parse", "chunk", "embed", "index"].slice(0, ["parse", "chunk", "embed", "index"].indexOf(crashStage));

      assert.equal(midway.status, "running", "the dead attempt still holds its lease");
      assert.equal(midway.stage, crashStage);
      assert.equal(midway.bytes_dropped, crashStage !== "parse");
      assert.equal(await documentRow(job.docId), null, "nothing was committed");
      assert.deepEqual(
        await outputsOf(job.jobId),
        [
          ...(crashStage === "parse" ? [] : ["document_file"]),
          ...(stagesBefore.includes("chunk") ? ["chunks"] : []),
          ...(stagesBefore.includes("embed") ? ["embeddings"] : []),
          ...(stagesBefore.includes("parse") ? ["pages"] : []),
        ].sort()
      );

      await sleep(400);

      const resumed = createCountingPipeline();
      const nextWorker = createWorker({ pipeline: resumed.pipeline, store, workerId: `next-${crashStage}` });

      assert.deepEqual(await nextWorker.runOnce(), { jobId: job.jobId, outcome: "succeeded" });
      assert.deepEqual(
        Object.fromEntries(Object.entries(resumed.counts).filter(([, count]) => count > 0)),
        Object.fromEntries(
          ["parse", "chunk", "embed", "index"].filter((stage) => !stagesBefore.includes(stage)).map((stage) => [stage, 1])
        ),
        "the stages before the crash were not run again"
      );

      const finished = await jobRow(job.jobId);

      assert.equal(finished.status, "succeeded");
      assert.equal(finished.attempt_count, 2);
      assert.equal((await documentRow(job.docId)).content_sha256, sha256(bytes));
      assert.ok((await chunkVersions("rag_document_chunks", job.docId)).length > 0);
    });
  }

  test("concurrent jobs' embed stages share one request, each job gets its own vectors, and a bad input fails only its job", async () => {
    const store = modules.store.createPostgresIngestJobStore({ logger: silentLogger });
    const run = async (documents) => {
      const arrived = [];
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const { loadPdfPages } = await import("../rag/pdf-loader.js");
      // No cap of its own, so the jobs linger into one request (under a cap
      // only what the cap holds back is merged; ingest-pipeline.test.mjs).
      const batcher = modules.batcher.createEmbeddingBatcher({
        embed: (texts, space) => modules.vectorStore.embedDocumentTextsForIndex(texts, space),
        lingerMs: 200,
        logger: silentLogger,
        maxConcurrency: 0,
      });
      const { pipeline } = createCountingPipeline({
        batcher,
        // Every job reaches its embed stage at the same moment.
        loadPages: async (filePath) => {
          const pages = await loadPdfPages(filePath);

          arrived.push(filePath);

          if (arrived.length === documents.length) {
            release();
          }

          await gate;
          return pages;
        },
      });
      const jobs = [];

      for (const { docId, scope, sentence } of documents) {
        jobs.push(await enqueue(store, scope, { bytes: pdf(sentence), docId }));
      }

      const worker = createWorker({ concurrency: documents.length, pipeline, store, workerId: `batch-${documents.length}` });

      provider.requests.length = 0;

      const outcomes = await Promise.all(documents.map(() => worker.runOnce()));

      return { jobs, outcomes, requests: [...provider.requests], stats: batcher.stats() };
    };

    const clean = [
      { docId: `doc-batch-alpha-${suffix}`, scope: ALICE, sentence: "Alpha orchard rules." },
      { docId: `doc-batch-beta-${suffix}`, scope: ALICE, sentence: "Beta bridge rules." },
      { docId: `doc-batch-gamma-${suffix}`, scope: BOB, sentence: "Gamma copper rules." },
      { docId: `doc-batch-delta-${suffix}`, scope: BOB, sentence: "Delta policy rules." },
    ];
    const first = await run(clean);

    assert.deepEqual(first.outcomes.map((entry) => entry.outcome), ["succeeded", "succeeded", "succeeded", "succeeded"]);
    assert.equal(first.requests.length, 1, "four documents, one embeddings request");
    assert.equal(first.requests[0].count, 4);
    assert.equal(first.stats.batchedRequests, 1);

    for (const { docId, scope, sentence } of clean) {
      const topic = sentence.split(" ")[0].toLowerCase();
      const search = await asTenant(scope, () =>
        modules.vectorStore.searchDocumentsWithRoutes({
          docIds: clean.map((entry) => entry.docId),
          queryText: topic,
          queryVector: embedFor(topic),
          topK: 1,
        })
      );

      assert.equal(search.results[0]?.document.metadata.docId, docId, `${topic} finds its own document`);
    }

    const poisoned = [
      { docId: `doc-p-epsilon-${suffix}`, scope: ALICE, sentence: "Epsilon orchard notes." },
      { docId: `doc-p-poison-${suffix}`, scope: ALICE, sentence: "POISON zeta notes." },
      { docId: `doc-p-zeta-${suffix}`, scope: BOB, sentence: "Zeta bridge notes." },
    ];
    const second = await run(poisoned);
    const byDoc = Object.fromEntries(second.jobs.map((job, index) => [job.docId, second.outcomes.find((entry) => entry.jobId === job.jobId)?.outcome ?? index]));

    // A provider's 4xx at embed is no verdict on the upload: that job keeps
    // its bytes and spends its retries (then dead_letter); the others succeed.
    assert.deepEqual(byDoc, {
      [`doc-p-epsilon-${suffix}`]: "succeeded",
      [`doc-p-poison-${suffix}`]: "queued",
      [`doc-p-zeta-${suffix}`]: "succeeded",
    });
    assert.deepEqual(
      second.requests.map((request) => request.count),
      [3, 1, 1, 1],
      "one merged request, then one per job to find the bad input"
    );
    assert.equal(await documentRow(`doc-p-poison-${suffix}`), null);

    const poisonedRow = await jobRow(second.jobs[1].jobId);

    assert.equal(poisonedRow.status, "queued");
    assert.equal(poisonedRow.stage, "embed");
    assert.deepEqual(await outputsOf(second.jobs[1].jobId), ["chunks", "document_file", "pages"], "kept for a retry");

    // Out of the way of the next suites' workers, which claim any due job.
    await q(`DELETE FROM rag_ingest_jobs WHERE job_id = $1`, [second.jobs[1].jobId]);
  });

  test("a stage out of attempts dead-letters the job; it is listed and requeued per tenant, counted in health, and resumes at its stage", async () => {
    const store = modules.store.createPostgresIngestJobStore({ logger: silentLogger });
    const job = await enqueue(store, ALICE, { bytes: pdf("Epsilon policy for dead letters."), docId: `doc-dead-${suffix}` });
    const { counts, pipeline } = createCountingPipeline();
    const worker = createWorker({
      pipeline,
      stageMaxAttempts: (stage) => (stage === "embed" ? 2 : 3),
      store,
      workerId: "dead",
    });

    provider.down = true;

    try {
      assert.equal((await worker.runOnce()).outcome, "queued");
      assert.equal((await worker.runOnce()).outcome, "dead_letter");
    } finally {
      provider.down = false;
    }

    const dead = await jobRow(job.jobId);

    assert.equal(dead.status, "dead_letter");
    assert.equal(dead.dead_letter_stage, "embed");
    assert.match(dead.dead_letter_reason, /^Stage embed failed on attempt 2 of 2 \(status 503\)/);
    assert.deepEqual(await outputsOf(job.jobId), ["chunks", "document_file", "pages"], "kept for the requeue");

    // Owner-scoped, also by the row policy alone.
    assert.deepEqual(await asTenant(BOB, () => store.listDeadLetters({ accessScope: BOB })), []);
    assert.deepEqual(await asTenant(BOB, () => store.listDeadLetters()), [], "the row policy hides it without a filter");
    assert.deepEqual(
      (await asTenant(ALICE, () => store.listDeadLetters({ accessScope: ALICE }))).map((entry) => entry.jobId),
      [job.jobId]
    );
    assert.equal(await asTenant(BOB, () => store.requeue({ accessScope: BOB, jobId: job.jobId })), null);

    const report = await modules.health.buildHealthReport();

    assert.equal(report.checks.ingestJobs.status, "ok");
    assert.equal(report.checks.ingestJobs.deadLetterCount, 1);
    assert.equal(report.checks.rowLevelSecurity.status, "ok");

    let printed = "";
    const listing = await modules.cli.runIngestJobsCommand(["dead-letter", "list", "--user", "alice", "--workspace", "ws-a", "--json"], {
      write: (text) => {
        printed += text;
      },
    });

    assert.deepEqual(listing.map((entry) => entry.jobId), [job.jobId]);
    assert.equal(JSON.parse(printed)[0].deadLetter.stage, "embed");
    assert.deepEqual(
      await modules.cli.runIngestJobsCommand(["dead-letter", "list", "--user", "bob", "--workspace", "ws-b"], { write: () => {} }),
      []
    );

    const requeued = await asTenant(ALICE, () => store.requeue({ accessScope: ALICE, jobId: job.jobId }));

    assert.equal(requeued.status, "queued");
    assert.equal(requeued.stage, "embed");
    assert.equal(requeued.stageAttempts, 0);
    assert.equal((await worker.runOnce()).outcome, "succeeded");
    assert.deepEqual(counts, { chunk: 1, embed: 3, index: 1, parse: 1 }, "parse and chunk never ran again");
    assert.equal((await jobRow(job.jobId)).status, "succeeded");
    assert.equal((await modules.health.buildHealthReport()).checks.ingestJobs.deadLetterCount, 0);
  });

  test("identical bytes resolve to the same tenant's document, never another tenant's, also when two uploads race", async () => {
    const bytes = pdf("Zeta renewal window is twelve months after the audit.");
    const filePath = await writePdf("dedup", bytes);
    const ingest = (scope, docId) =>
      asTenant(scope, () =>
        modules.rag.ingestDocument({
          deduplicate: true,
          docId,
          fileName: "dedup.pdf",
          filePath,
          ownerUserId: scope.userId,
          workspaceId: scope.workspaceId,
        })
      );
    const aliceFirst = await ingest(ALICE, `doc-dedup-a1-${suffix}`);
    const aliceAgain = await ingest(ALICE, `doc-dedup-a2-${suffix}`);
    const bob = await ingest(BOB, `doc-dedup-b1-${suffix}`);

    assert.equal(aliceAgain.duplicate, true);
    assert.equal(aliceAgain.docId, aliceFirst.docId);
    assert.equal(bob.docId, `doc-dedup-b1-${suffix}`, "bob's identical upload is his own document");
    assert.equal(bob.duplicate, undefined);
    assert.deepEqual(
      (await q(`SELECT owner_user_id FROM rag_documents WHERE content_sha256 = $1 ORDER BY owner_user_id`, [sha256(bytes)])).rows.map(
        (row) => row.owner_user_id
      ),
      ["alice", "bob"]
    );

    // Async: the enqueue itself resolves to the tenant's own document.
    const store = modules.store.createPostgresIngestJobStore({ logger: silentLogger });
    const resolvedForAlice = await enqueue(store, ALICE, { bytes, deduplicate: true, docId: `doc-dedup-a3-${suffix}` });
    const resolvedForBob = await enqueue(store, BOB, { bytes, deduplicate: true, docId: `doc-dedup-b2-${suffix}` });

    assert.equal(resolvedForAlice.status, "succeeded");
    assert.equal(resolvedForAlice.resolvedDocId, aliceFirst.docId);
    assert.equal(resolvedForBob.resolvedDocId, bob.docId, "never to another tenant's document");

    // Two identical uploads that both pass the early checks: the content lock
    // in the index transaction lets exactly one become a document.
    const racing = pdf("Eta travel needs a signed itinerary before booking.");
    const first = await enqueue(store, ALICE, { bytes: racing, deduplicate: true, docId: `doc-race-1-${suffix}` });
    const second = await enqueue(store, ALICE, { bytes: racing, deduplicate: true, docId: `doc-race-2-${suffix}` });
    const arrived = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { loadPdfPages } = await import("../rag/pdf-loader.js");
    const { pipeline } = createCountingPipeline({
      loadPages: async (path_) => {
        arrived.push(path_);

        if (arrived.length === 2) {
          release();
        }

        await gate;
        return loadPdfPages(path_);
      },
    });
    const worker = createWorker({ concurrency: 2, pipeline, store, workerId: "race" });

    assert.deepEqual(
      (await Promise.all([worker.runOnce(), worker.runOnce()])).map((entry) => entry.outcome),
      ["succeeded", "succeeded"]
    );

    const rows = [await jobRow(first.jobId), await jobRow(second.jobId)];
    const documents = (await q(`SELECT doc_id FROM rag_documents WHERE content_sha256 = $1`, [sha256(racing)])).rows;

    assert.equal(documents.length, 1, "one document for both uploads");
    assert.equal(rows.filter((row) => row.duplicate).length, 1);
    assert.equal(rows.find((row) => row.duplicate).resolved_doc_id, documents[0].doc_id);
  });

  test("a replacement swaps the chunks atomically while tenant searches run, and serves only the new version afterwards", async () => {
    const docId = `doc-swap-${suffix}`;
    const v1 = pdf(
      "Alpha policy one requires manager approval.",
      "Alpha policy two caps meals at forty dollars.",
      "Alpha policy three covers remote work."
    );
    const v2 = pdf(
      "Beta policy one requires director approval.",
      "Beta policy two caps meals at sixty dollars."
    );

    await asTenant(ALICE, async () =>
      modules.rag.ingestDocument({
        docId,
        fileName: "v1.pdf",
        filePath: await writePdf("swap-v1", v1),
        ownerUserId: ALICE.userId,
        workspaceId: ALICE.workspaceId,
      })
    );

    const before = await documentRow(docId);
    const observed = [];
    let stop = false;
    // Bounded, so a replacement that never finished fails the test instead of
    // filling memory with observations.
    const deadline = Date.now() + 20000;
    const searchLoop = async (route) => {
      while (!stop && Date.now() < deadline) {
        const results = await asTenant(ALICE, () =>
          route === "dense"
            ? modules.pgvector.searchPgvectorDocuments({
                docIds: [docId],
                queryText: "policy approval",
                queryVector: embedFor("policy approval"),
                topK: 10,
              })
            : modules.pgvector.searchPgvectorSparseDocuments({ docIds: [docId], queryText: "approval meals", topK: 10 })
        );

        observed.push({
          count: results.length,
          route,
          startsWithBeta: results.map((result) => /^Beta/.test(result.document.pageContent.trim())),
          versions: [...new Set(results.map((result) => result.document.metadata.documentVersion))],
        });
        // Leave the pool to the replacement now and then.
        await sleep(2);
      }
    };
    const loops = [searchLoop("dense"), searchLoop("sparse"), searchLoop("dense"), searchLoop("sparse")];

    await sleep(50);

    const replaced = await asTenant(ALICE, async () =>
      modules.rag.replaceDocument({
        docId,
        fileName: "v2.pdf",
        filePath: await writePdf("swap-v2", v2),
        ownerUserId: ALICE.userId,
        workspaceId: ALICE.workspaceId,
      })
    );

    await sleep(50);
    stop = true;
    await Promise.all(loops);

    assert.equal(replaced.version, 2);
    assert.ok(observed.length > 8, `searches ran during the swap (${observed.length})`);
    assert.ok(
      observed.every(
        (entry) =>
          entry.versions.length === 1 &&
          entry.count > 0 &&
          entry.startsWithBeta.every((isBeta) => isBeta === (entry.versions[0] === 2))
      ),
      "every search saw one complete version, never a mix and never nothing"
    );
    assert.ok(observed.some((entry) => entry.versions[0] === 1));
    assert.ok(observed.some((entry) => entry.versions[0] === 2));

    const lastIndexOfOld = observed.findLastIndex((entry) => entry.versions[0] === 1);
    const firstIndexOfNew = observed.findIndex((entry) => entry.versions[0] === 2);

    assert.ok(
      observed.slice(firstIndexOfNew).filter((entry) => entry.versions[0] === 1).length <= 3,
      `only searches already in flight at the commit may still have seen version 1 (${lastIndexOfOld} vs ${firstIndexOfNew})`
    );

    // Afterwards only version 2 is served: its chunks, its bytes, its registry entry.
    const afterwards = await asTenant(ALICE, () =>
      modules.vectorStore.searchDocumentsWithRoutes({
        docIds: [docId],
        queryText: "policy approval meals",
        queryVector: embedFor("policy approval meals"),
        topK: 10,
      })
    );

    assert.ok(afterwards.results.length > 0);
    assert.ok(afterwards.results.every((result) => /^Beta/.test(result.document.pageContent.trim())));
    assert.ok((await chunkVersions("rag_document_chunks", docId)).every((chunk) => chunk.version === 2 && /Beta/.test(chunk.content)));

    const document = await documentRow(docId);

    assert.equal(document.content_version, 2);
    assert.equal(document.uploaded_at, before.uploaded_at, "the document keeps its upload time");
    assert.equal(document.content_sha256, sha256(v2));
    assert.deepEqual((await asTenant(ALICE, () => modules.rag.getDocumentFile(docId, ALICE))).fileBuffer, v2);
    assert.equal(modules.rag.getDocument(docId, ALICE).version, 2);

    // Bob can neither see nor replace it.
    await assert.rejects(
      () =>
        asTenant(BOB, async () =>
          modules.rag.replaceDocument({
            docId,
            fileName: "x.pdf",
            filePath: await writePdf("swap-bob", v1),
            ownerUserId: BOB.userId,
            workspaceId: BOB.workspaceId,
          })
        ),
      (error) => error.status === 404
    );
    assert.equal((await documentRow(docId)).content_version, 2);
  });

  test("a replacement during an index build reaches the building version, and the builder never writes the older content over it", async () => {
    const docId = `doc-build-replace-${suffix}`;
    const store = modules.store.createPostgresIngestJobStore({ logger: silentLogger });

    await asTenant(ALICE, async () =>
      modules.rag.ingestDocument({
        docId,
        fileName: "gamma-v1.pdf",
        filePath: await writePdf("build-v1", pdf("Gamma audit happens every twelve months.")),
        ownerUserId: ALICE.userId,
        workspaceId: ALICE.workspaceId,
      })
    );

    const replacementJob = await enqueue(store, ALICE, {
      bytes: pdf("Gamma audit now happens every eighteen months."),
      docId,
      kind: "replace",
    });
    const { pipeline } = createCountingPipeline();
    const worker = createWorker({ pipeline, store, workerId: "replace-during-build" });
    let replacedDuringBuild = null;
    const build = await modules.lifecycle.startIndexVersionBuild({
      batchSize: 50,
      builderId: "pipeline-it-builder",
      hooks: {
        beforeDocumentWrite: async ({ attempt, docId: building }) => {
          // Between the builder's read of the old bytes and its write.
          if (building === docId && attempt === 1) {
            replacedDuringBuild = await worker.runOnce();
          }
        },
      },
      space: modules.lifecycle.resolveBuildEmbeddingSpace({ dimensions: DIMENSIONS[MODEL_B], model: MODEL_B }),
    });

    assert.deepEqual(replacedDuringBuild, { jobId: replacementJob.jobId, outcome: "succeeded" });
    assert.equal(build.version.status, "ready");

    const table = `rag_document_chunks_v${build.versionId}`;
    const building = await chunkVersions(table, docId);
    const active = await chunkVersions("rag_document_chunks", docId);

    assert.ok(building.length > 0);
    assert.ok(building.every((chunk) => chunk.version === 2 && /eighteen/.test(chunk.content)), "the new version holds the replacement");
    assert.ok(active.every((chunk) => chunk.version === 2 && /eighteen/.test(chunk.content)));
    assert.deepEqual(
      (await q(`SELECT DISTINCT embedding_model FROM ${table} WHERE doc_id = $1`, [docId])).rows,
      [{ embedding_model: MODEL_B }],
      "embedded in the building version's own space"
    );
    assert.equal((await jobRow(replacementJob.jobId)).document_version, 2);

    await modules.lifecycle.retireIndexVersion({ force: true, versionId: build.versionId });
  });

  test("replacements are ordered by the database's clock: a job overtaken by a later request succeeds as superseded", async () => {
    const docId = `doc-overtaken-${suffix}`;
    const store = modules.store.createPostgresIngestJobStore({ logger: silentLogger });

    await asTenant(ALICE, async () =>
      modules.rag.ingestDocument({
        docId,
        fileName: "eta-v1.pdf",
        filePath: await writePdf("overtaken-v1", pdf("Eta leave policy grants ten days.")),
        ownerUserId: ALICE.userId,
        workspaceId: ALICE.workspaceId,
      })
    );

    // An async replacement is requested (its created_at is the database's clock) ...
    const lateJob = await enqueue(store, ALICE, { bytes: pdf("Eta leave policy grants twelve days."), docId, kind: "replace" });

    // ... and a synchronous one after it commits first, stamped by the same clock.
    const newer = await asTenant(ALICE, async () =>
      modules.rag.replaceDocument({
        docId,
        fileName: "eta-v2.pdf",
        filePath: await writePdf("overtaken-v2", pdf("Eta leave policy grants fifteen days.")),
        ownerUserId: ALICE.userId,
        workspaceId: ALICE.workspaceId,
      })
    );
    const stamps = (
      await q(
        `SELECT d.content_updated_at > j.created_at AS after_job, d.content_updated_at <= NOW() AS not_future
           FROM rag_documents d, rag_ingest_jobs j WHERE d.doc_id = $1 AND j.job_id = $2`,
        [docId, lateJob.jobId]
      )
    ).rows[0];

    assert.equal(newer.version, 2);
    assert.deepEqual(stamps, { after_job: true, not_future: true }, "the database's clock, not this host's");

    const { pipeline } = createCountingPipeline();
    const worker = createWorker({ pipeline, store, workerId: "overtaken" });

    assert.equal((await worker.runOnce()).outcome, "succeeded");

    const row = (await q(`SELECT superseded, document_version FROM rag_ingest_jobs WHERE job_id = $1`, [lateJob.jobId])).rows[0];
    const publicJob = modules.store.toPublicIngestJob(await asTenant(ALICE, () => store.get(lateJob.jobId, ALICE)));

    assert.deepEqual(row, { document_version: 2, superseded: true });
    assert.equal(publicJob.superseded, true);
    assert.equal(publicJob.status, "succeeded");
    assert.ok((await chunkVersions("rag_document_chunks", docId)).every((chunk) => chunk.version === 2 && /fifteen/.test(chunk.content)));
    assert.equal((await documentRow(docId)).content_version, 2);
  });

  test("an advance retried after its commit counts as done, and the sweep drops a settled job's outputs", async () => {
    const store = modules.store.createPostgresIngestJobStore({ logger: silentLogger });
    const docId = `doc-sweep-${suffix}`;
    const bytes = pdf("Theta travel needs a receipt.");
    const job = await enqueue(store, ALICE, { bytes, docId, maxAttempts: 1 });
    const claimed = await store.claim({ leaseMs: 60000, workerId: "sweep-a" });

    assert.equal(claimed.jobId, job.jobId);

    const fence = { attemptCount: claimed.attemptCount, jobId: job.jobId, workerId: "sweep-a" };
    const advance = () =>
      store.advanceStage({
        ...fence,
        fromStage: "parse",
        leaseMs: 60000,
        maxAttempts: 1,
        moveDocumentFile: true,
        output: { name: "pages", payload: Buffer.from("[]") },
        toStage: "chunk",
      });

    assert.equal(await advance(), true);
    assert.equal(await advance(), true, "the same advance again: already done, not a lost lease");
    assert.equal(await store.advanceStage({ ...fence, workerId: "someone", fromStage: "parse", toStage: "chunk", leaseMs: 1, maxAttempts: 1 }), false);
    assert.deepEqual(await outputsOf(job.jobId), ["document_file", "pages"]);

    // The worker committed the document and died before recording success,
    // during the stage's last allowed attempt.
    await asTenant(ALICE, async () =>
      modules.rag.ingestDocument({
        docId,
        fileName: "theta.pdf",
        filePath: await writePdf("sweep", bytes),
        ownerUserId: ALICE.userId,
        workspaceId: ALICE.workspaceId,
      })
    );
    await q(`UPDATE rag_ingest_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE job_id = $1`, [job.jobId]);

    // The next claim's sweep settles it; whatever else that claim takes goes back.
    const next = await store.claim({ leaseMs: 60000, workerId: "sweep-b" });

    assert.notEqual(next?.jobId, job.jobId);

    if (next) {
      await store.release({ attemptCount: next.attemptCount, jobId: next.jobId, workerId: "sweep-b" });
    }

    assert.equal((await jobRow(job.jobId)).status, "succeeded");
    assert.deepEqual(await outputsOf(job.jobId), [], "no output waits for retention");
  });

  test("with a PostgreSQL registry, identical uploads on a non-transactional index serialize across processes on the tenant's content lock", async () => {
    const bytes = pdf("Omega archive rule: keep receipts.");
    const hash = sha256(bytes);
    const filePath = await writePdf("shared-lock", bytes);
    const key = JSON.stringify(["archive_rag:document_content", "rag_documents", ALICE.userId, ALICE.workspaceId, hash]);
    const other = new pg.Client({ connectionString: process.env.POSTGRES_DATABASE_URL });
    const previousProvider = process.env.VECTOR_STORE_PROVIDER;

    await other.connect();
    process.env.VECTOR_STORE_PROVIDER = "local";
    modules.vectorStore.resetVectorStore();

    try {
      // Another process holds the lock while it stores the same bytes.
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);

      const racing = asTenant(ALICE, () =>
        modules.rag.ingestDocument({
          deduplicate: true,
          docId: `doc-shared-lock-b-${suffix}`,
          fileName: "shared.pdf",
          filePath,
          ownerUserId: ALICE.userId,
          workspaceId: ALICE.workspaceId,
        })
      );
      const deadline = Date.now() + 10000;
      let waiting = false;

      while (!waiting && Date.now() < deadline) {
        waiting = (
          await q(`SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
        ).rows[0].n > 0;
        await sleep(20);
      }

      assert.equal(waiting, true, "this process waits on the other's content lock");

      await other.query(
        `INSERT INTO rag_documents (doc_id, file_name, mime_type, file_size, file_bytes, chunk_count, page_count,
                                    owner_user_id, workspace_id, profile, uploaded_at, content_sha256)
         VALUES ($1, 'shared.pdf', 'application/pdf', $2, $3, 1, 1, $4, $5, '{}'::jsonb, NOW(), $6)`,
        [`doc-shared-lock-a-${suffix}`, bytes.length, bytes, ALICE.userId, ALICE.workspaceId, hash]
      );
      await other.query("COMMIT");

      const result = await racing;

      assert.equal(result.duplicate, true);
      assert.equal(result.docId, `doc-shared-lock-a-${suffix}`, "resolved to the other process's document");
      assert.equal(await documentRow(`doc-shared-lock-b-${suffix}`), null, "no second document");
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      await other.end();
      process.env.VECTOR_STORE_PROVIDER = previousProvider;
      modules.vectorStore.resetVectorStore();
    }
  });
}
