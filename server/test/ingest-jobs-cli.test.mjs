import test from "node:test";
import assert from "node:assert/strict";

import { parseIngestJobsArgs, runIngestJobsCommand, USAGE } from "../ingest-jobs.mjs";
import { backfillDocumentContentHashes } from "../rag/doc-registry.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { getActiveDatabaseTenant } from "../rag/postgres-tenant.js";

// `npm run ingest:jobs`: argument rules (dead-letter commands are owner-scoped
// or explicitly --all), the commands over an in-memory queue, and the content
// hash backfill over a recording query.

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };

const deadLetterFor = async (store, scope, docId) => {
  const job = await store.enqueue({
    docId,
    fileBytes: Buffer.from("%PDF-1.4 cli"),
    fileName: `${docId}.pdf`,
    maxAttempts: 1,
    ownerUserId: scope.userId,
    workspaceId: scope.workspaceId,
  });
  const claimed = await store.claim({ leaseMs: 1000, workerId: "cli" });

  await store.fail({
    attemptCount: claimed.attemptCount,
    deadLetterReason: "Stage parse failed on attempt 1 of 1 (status 503): Indexing failed on the server.",
    error: "Indexing failed on the server.",
    jobId: job.jobId,
    workerId: "cli",
  });
  return job;
};

test("dead-letter commands must name an owner or say --all, and the rest parse strictly", () => {
  assert.deepEqual(parseIngestJobsArgs(["dead-letter", "list", "--user", "alice", "--workspace", "ws-a"]), {
    all: false,
    command: "dead-letter list",
    dryRun: false,
    help: false,
    jobId: null,
    json: false,
    owner: { ownerUserId: "alice", workspaceId: "ws-a" },
    user: "alice",
    workspace: "ws-a",
  });
  assert.deepEqual(parseIngestJobsArgs(["dead-letter", "requeue", "job-1", "--all"]).owner, null);
  assert.deepEqual(
    parseIngestJobsArgs(["dead-letter", "requeue", "job-1", "--workspace=ws-a"]).owner,
    { ownerUserId: "", workspaceId: "ws-a" },
    "an omitted part of the owner is the empty value"
  );
  assert.throws(() => parseIngestJobsArgs(["dead-letter", "list"]), /--user and\/or --workspace\), or pass --all/);
  assert.throws(() => parseIngestJobsArgs(["dead-letter", "list", "--all", "--user", "a"]), /not both/);
  assert.throws(() => parseIngestJobsArgs(["dead-letter", "requeue", "--all"]), /needs a job id/);
  assert.throws(() => parseIngestJobsArgs(["dead-letter", "drop", "--all"]), /"list" or "requeue/);
  assert.throws(() => parseIngestJobsArgs(["purge"]), /Unknown command/);
  assert.throws(() => parseIngestJobsArgs(["counts", "extra"]), /Unexpected argument/);
  assert.throws(() => parseIngestJobsArgs(["backfill-hashes", "--batch-size", "0"]), /positive integer/);
  assert.throws(() => parseIngestJobsArgs(["counts", "--verbose"]), /Unknown option/);
  assert.equal(parseIngestJobsArgs(["backfill-hashes", "--batch-size", "25", "--dry-run"]).batchSize, 25);
  assert.equal(parseIngestJobsArgs(["--help"]).help, true);
});

test("the commands list, requeue and count the queue's dead-letter jobs per owner, as the table owner", async () => {
  const store = createInMemoryIngestJobStore();
  const alicesJob = await deadLetterFor(store, ALICE, "doc-alice");
  const bobsJob = await deadLetterFor(store, BOB, "doc-bob");
  const tenants = [];
  const observedStore = {
    ...store,
    listDeadLetters: async (options) => {
      tenants.push(getActiveDatabaseTenant());
      return store.listDeadLetters(options);
    },
  };
  const run = async (argv) => {
    let printed = "";
    const result = await runIngestJobsCommand(argv, {
      createStore: () => observedStore,
      isConfigured: () => true,
      write: (text) => {
        printed += text;
      },
    });

    return { printed, result };
  };

  const alice = await run(["dead-letter", "list", "--user", "alice", "--workspace", "ws-a"]);

  assert.deepEqual(alice.result.map((job) => job.jobId), [alicesJob.jobId]);
  assert.match(alice.printed, /stage parse, dead-lettered/);
  assert.match(alice.printed, /attempt 1 of 1 \(status 503\)/);
  assert.equal(tenants[0], null, "the CLI reads as the owner, never under a tenant");

  const everyone = await run(["dead-letter", "list", "--all", "--json"]);

  assert.deepEqual(JSON.parse(everyone.printed).map((job) => job.jobId).sort(), [alicesJob.jobId, bobsJob.jobId].sort());

  await assert.rejects(
    () => run(["dead-letter", "requeue", bobsJob.jobId, "--user", "alice", "--workspace", "ws-a"]),
    /No dead-letter job .* for that owner/
  );

  const requeued = await run(["dead-letter", "requeue", bobsJob.jobId, "--user", "bob", "--workspace", "ws-b"]);

  assert.equal(requeued.result.status, "queued");
  assert.match(requeued.printed, /Requeued .* at stage parse/);
  assert.deepEqual((await run(["counts", "--json"])).result, {
    dead_letter: 1,
    failed: 0,
    queued: 1,
    running: 0,
    succeeded: 0,
  });

  let usage = "";

  assert.equal(await runIngestJobsCommand(["--help"], { write: (text) => (usage += text) }), null);
  assert.equal(usage, USAGE);
  await assert.rejects(
    () => runIngestJobsCommand(["counts"], { isConfigured: () => false, write: () => {} }),
    /needs PostgreSQL/
  );
});

test("backfill-hashes lets the database hash stored PDFs in batches, as the owner, and a dry run only counts", async () => {
  const calls = [];
  let missing = 5;
  const queryPostgres = async (sql, values = []) => {
    calls.push({ sql, tenant: getActiveDatabaseTenant(), values });

    if (/COUNT\(\*\)::int AS missing/.test(sql)) {
      return { rows: [{ missing }] };
    }

    const hashed = Math.min(values[0], missing);

    missing -= hashed;
    return { rows: Array.from({ length: hashed }, (_, index) => ({ doc_id: `d${index}` })) };
  };
  const batches = [];
  const result = await backfillDocumentContentHashes({
    batchSize: 2,
    getDocumentsTable: () => "docs_t",
    onBatch: (batch) => batches.push(batch),
    queryPostgres,
    runMigrations: async () => {},
  });

  assert.deepEqual(result, { dryRun: false, hashed: 5, missing: 5, remaining: 0 });
  assert.deepEqual(batches.map((batch) => batch.count), [2, 2, 1]);
  assert.ok(calls.every((call) => call.tenant === null));

  const update = calls.find((call) => /UPDATE docs_t AS d/.test(call.sql));

  assert.match(update.sql, /SET content_sha256 = encode\(sha256\(d\.file_bytes\), 'hex'\)/);
  assert.match(update.sql, /WHERE content_sha256 IS NULL\s+ORDER BY doc_id\s+LIMIT \$1\s+FOR UPDATE SKIP LOCKED/);

  missing = 3;
  calls.length = 0;
  assert.deepEqual(
    await backfillDocumentContentHashes({
      dryRun: true,
      getDocumentsTable: () => "docs_t",
      queryPostgres,
      runMigrations: async () => {},
    }),
    { dryRun: true, hashed: 0, missing: 3, remaining: 3 }
  );
  assert.equal(calls.length, 1, "a dry run changes nothing");

  let printed = "";

  await runIngestJobsCommand(["backfill-hashes", "--dry-run"], {
    backfill: async (options) => {
      assert.deepEqual(options, { batchSize: undefined, dryRun: true });
      return { dryRun: true, hashed: 0, missing: 3, remaining: 3 };
    },
    isConfigured: () => true,
    write: (text) => {
      printed += text;
    },
  });
  assert.equal(printed, "3 document(s) have no content hash yet.\n");
});
