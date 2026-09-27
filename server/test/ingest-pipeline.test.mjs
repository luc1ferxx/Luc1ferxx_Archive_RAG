import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import {
  getIngestJobOutputsPostgresTable,
  getRagIngestEmbedBatchLingerMs,
  getRagIngestEmbedBatchMaxItems,
  getRagIngestEmbedBatchMaxTokens,
  getRagIngestStageOutputMaxBytes,
  getRagIngestStageRetryPolicy,
  isRagIngestDedupEnabled,
  isRagIngestEmbedBatchingEnabled,
} from "../rag/config.js";
import {
  getIngestJobOutputsTableName,
  renderMigrationSql,
} from "../rag/db-migrations.js";
import {
  configureDocumentRegistryStore,
  findDocumentByContentHash,
  getDocument,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import {
  createEmbeddingBatcher,
  estimateEmbeddingTokens,
  isBatchWideEmbeddingError,
} from "../rag/ingest-embedding-batcher.js";
import {
  createInMemoryIngestJobStore,
  toDeadLetterIngestJob,
  toPublicIngestJob,
} from "../rag/ingest-job-store.js";
import {
  createIngestPipeline,
  decodeEmbeddingsOutput,
  decodeJsonOutput,
  encodeEmbeddingsOutput,
  encodeJsonOutput,
} from "../rag/ingest-pipeline.js";
import {
  INGEST_STAGES,
  STAGED_INGEST,
  getNextIngestStage,
  supportsStagedIngest,
} from "../rag/ingest-stages.js";
import {
  createIngestWorker,
  describeIngestStageFailure,
  getIngestStageRetryDelayMs,
  isRetryableIngestError,
} from "../rag/ingest-worker.js";
import {
  clearDocuments,
  ingestDocument,
  replaceDocument,
  supportsDocumentReplacement,
} from "../rag/index.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory } from "../rag/storage.js";
import { getActiveDatabaseTenant } from "../rag/postgres-tenant.js";
import { resetVectorStore, searchDocuments } from "../rag/vector-store.js";

// The staged ingest pipeline without a database: the embedding batcher, the
// stage output encodings, the worker's stage machine on the in-memory queue
// (resume after a crash in every stage, per-stage budgets, dead letter and
// requeue), and the real pipeline end to end on the local index with the
// file-backed registry: deduplication per tenant, replacement, and batching
// across jobs. The PostgreSQL guarantees are in
// ingest-pipeline-postgres.integration.test.mjs.

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };
const silentLogger = { error() {}, log() {}, warn() {} };
const SPACE = Object.freeze({ key: "test-space|3" });

const withEnv = async (overrides, callback) => {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));

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

const createClock = (start = Date.parse("2026-09-27T10:00:00.000Z")) => {
  let current = start;

  return {
    advance: (ms) => {
      current += ms;
    },
    now: () => current,
  };
};

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

// Resolves once `count` callers are waiting, then lets them all through.
const createBarrier = (count) => {
  const release = createDeferred();
  let waiting = 0;

  return {
    arrive: async () => {
      waiting += 1;

      if (waiting >= count) {
        release.resolve();
      }

      await release.promise;
    },
  };
};

const statusError = (message, status) => Object.assign(new Error(message), { status });

// --- config and migrations --------------------------------------------------

test("pipeline settings default to the old one-step budget and can be set per stage", async () => {
  await withEnv(
    {
      RAG_INGEST_DEDUP: undefined,
      RAG_INGEST_EMBED_BATCH_LINGER_MS: undefined,
      RAG_INGEST_EMBED_BATCH_MAX_ITEMS: undefined,
      RAG_INGEST_EMBED_BATCH_MAX_TOKENS: undefined,
      RAG_INGEST_EMBED_MAX_ATTEMPTS: undefined,
      RAG_INGEST_JOB_MAX_ATTEMPTS: undefined,
      RAG_INGEST_STAGE_OUTPUT_MAX_BYTES: undefined,
    },
    () => {
      for (const stage of INGEST_STAGES) {
        assert.deepEqual(getRagIngestStageRetryPolicy(stage), {
          baseDelayMs: 5000,
          maxAttempts: 3,
          maxDelayMs: 300000,
        });
      }

      assert.equal(isRagIngestDedupEnabled(), true);
      assert.equal(getRagIngestEmbedBatchMaxItems(), 512);
      assert.equal(getRagIngestEmbedBatchMaxTokens(), 240000);
      assert.equal(getRagIngestEmbedBatchLingerMs(), 25);
      assert.equal(getRagIngestStageOutputMaxBytes(), 64 * 1024 * 1024);
      assert.equal(getIngestJobOutputsPostgresTable(), "rag_ingest_jobs_outputs");
    }
  );

  await withEnv(
    {
      RAG_INGEST_DEDUP: "false",
      RAG_INGEST_EMBED_MAX_ATTEMPTS: "6",
      RAG_INGEST_EMBED_RETRY_BASE_MS: "100",
      RAG_INGEST_EMBED_RETRY_MAX_MS: "50",
      RAG_INGEST_JOB_MAX_ATTEMPTS: "4",
    },
    () => {
      assert.equal(isRagIngestDedupEnabled(), false);
      // The max never falls under the base.
      assert.deepEqual(getRagIngestStageRetryPolicy("embed"), { baseDelayMs: 100, maxAttempts: 6, maxDelayMs: 100 });
      assert.equal(getRagIngestStageRetryPolicy("parse").maxAttempts, 4, "the job budget is every stage's default");
      const top = () => 1;

      assert.equal(getIngestStageRetryDelayMs(1, "embed", top), 100);
      assert.equal(getIngestStageRetryDelayMs(4, "embed", top), 100);
      assert.equal(getIngestStageRetryDelayMs(3, "parse", top), 20000);
      // Jittered down to half, so jobs that failed together come due apart.
      assert.equal(getIngestStageRetryDelayMs(3, "parse", () => 0), 10000);
      assert.equal(getIngestStageRetryDelayMs(3, "parse", () => 0.5), 15000);

      const draws = new Set(Array.from({ length: 20 }, () => getIngestStageRetryDelayMs(3, "parse")));

      assert.ok(draws.size > 1, "the default draw varies");
      assert.ok([...draws].every((delayMs) => delayMs >= 10000 && delayMs <= 20000));
    }
  );

  assert.deepEqual([...INGEST_STAGES], ["parse", "chunk", "embed", "index"]);
  assert.equal(getNextIngestStage("embed"), "index");
  assert.equal(getNextIngestStage("index"), null);
});

test("migrations 017 and 018 stage the jobs table, add the tenant-scoped outputs table and the document identity", async () => {
  const read = (name) => readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
  const tables = {
    adminAuditEventsTable: "audit_t",
    agentRunEventsTable: "run_events_t",
    agentRunsTable: "runs_t",
    documentsTable: "docs_t",
    ingestJobsTable: "jobs_t",
    longMemoryTable: "memory_t",
    sessionMemoryTable: "session_t",
    taskEventsTable: "task_events_t",
    tasksTable: "tasks_t",
    workspaceArtifactsTable: "artifacts_t",
  };
  const staged = renderMigrationSql(await read("017_stage_rag_ingest_jobs.sql"), tables, { tenantRole: "tenant_r" });
  const identity = renderMigrationSql(await read("018_add_document_content_identity.sql"), tables, {
    tenantRole: "tenant_r",
  });

  assert.doesNotMatch(staged + identity, /__[A-Z_]+__/, "every placeholder is rendered");
  assert.match(staged, /CHECK \(status IN \('queued', 'running', 'succeeded', 'failed', 'dead_letter'\)\)/);
  assert.match(staged, /CHECK \(stage IN \('parse', 'chunk', 'embed', 'index'\)\)/);
  assert.match(staged, /CREATE TABLE IF NOT EXISTS jobs_t_outputs \(\s+job_id TEXT NOT NULL REFERENCES jobs_t \(job_id\) ON DELETE CASCADE/);
  assert.match(staged, /GRANT SELECT, INSERT, UPDATE, DELETE ON jobs_t_outputs TO tenant_r/);
  assert.match(staged, /ALTER TABLE jobs_t_outputs ENABLE ROW LEVEL SECURITY/);
  assert.match(staged, /CREATE POLICY tenant_isolation ON jobs_t_outputs\s+TO tenant_r/);
  assert.match(identity, /ADD COLUMN IF NOT EXISTS content_sha256 TEXT/);
  assert.match(identity, /ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 1/);
  assert.match(identity, /ON docs_t \(owner_user_id, workspace_id, content_sha256\)/);
  assert.doesNotMatch(identity, /UPDATE docs_t/, "no stored PDF is read at migration time");
  assert.equal(getIngestJobOutputsTableName("jobs_t"), "jobs_t_outputs");
  assert.throws(() => getIngestJobOutputsTableName("j".repeat(45)), /63 bytes/);
});

// --- embedding batcher ------------------------------------------------------

const createRecordingEmbed = ({ delayMs = 1, failWhen = null } = {}) => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    embed: async (texts, space) => {
      calls.push({ space: space.key, texts: [...texts] });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        const failure = failWhen?.(texts);

        if (failure) {
          throw failure;
        }

        return texts.map((text) => [text.length, text.charCodeAt(0) || 0, 1]);
      } finally {
        inFlight -= 1;
      }
    },
  };
};

test("the batcher sends concurrent jobs' texts as one request and fans the vectors back out in order", async () => {
  const recorder = createRecordingEmbed();
  const batcher = createEmbeddingBatcher({ embed: recorder.embed, lingerMs: 20, maxConcurrency: 0 });
  const jobs = [["alpha", "beta"], ["gamma"], ["delta", "epsilon", "zeta"]];

  const results = await Promise.all(jobs.map((texts) => batcher.embed(texts, SPACE)));

  assert.equal(recorder.calls.length, 1, "three jobs, one request");
  assert.deepEqual(recorder.calls[0].texts, jobs.flat());
  results.forEach((vectors, jobIndex) =>
    assert.deepEqual(
      vectors,
      jobs[jobIndex].map((text) => [text.length, text.charCodeAt(0), 1]),
      "each job gets exactly its own vectors, in order"
    )
  );
  assert.deepEqual(
    { ...batcher.stats(), inFlight: undefined },
    { batchedRequests: 1, failedJobs: 0, inFlight: undefined, isolatedRequests: 0, queuedTexts: 0, requests: 1, texts: 6 }
  );
  assert.deepEqual(await batcher.embed([], SPACE), []);
  await assert.rejects(() => batcher.embed(["x"], {}), /embedding space with a key/);
});

test("a batch leaves as soon as it is full, splits by item and token limits, and keeps spaces apart", async () => {
  const recorder = createRecordingEmbed();
  const batcher = createEmbeddingBatcher({
    embed: recorder.embed,
    estimateTokens: (text) => text.length,
    lingerMs: 60000,
    maxConcurrency: 0,
    maxItems: 3,
    maxTokens: 10,
  });
  const otherSpace = { key: "other|3" };

  // A linger of a minute: only full batches may leave before the test ends,
  // except the remainder, which is flushed by filling it up.
  const first = batcher.embed(["aaaa", "bbbb", "cc"], SPACE); // 10 tokens: full by tokens
  const second = batcher.embed(["d", "e", "f"], SPACE); // 3 items: full by items
  const third = batcher.embed(["g", "h", "i"], otherSpace); // another space, its own batch

  assert.deepEqual(await first, [
    [4, 97, 1],
    [4, 98, 1],
    [2, 99, 1],
  ]);
  assert.deepEqual((await second).length, 3);
  assert.deepEqual((await third).length, 3);
  assert.deepEqual(
    recorder.calls.map((call) => [call.space, call.texts]),
    [
      [SPACE.key, ["aaaa", "bbbb", "cc"]],
      [SPACE.key, ["d", "e", "f"]],
      ["other|3", ["g", "h", "i"]],
    ]
  );

  // One text above the token limit still goes, alone.
  const oversized = createRecordingEmbed();
  const lonely = createEmbeddingBatcher({
    embed: oversized.embed,
    estimateTokens: (text) => text.length,
    lingerMs: 5,
    maxTokens: 4,
  });

  assert.equal((await lonely.embed(["far too long for one batch", "x"], SPACE)).length, 2);
  assert.deepEqual(oversized.calls.map((call) => call.texts), [["far too long for one batch"], ["x"]]);
  assert.equal(estimateEmbeddingTokens("abcd"), 2);
  assert.equal(estimateEmbeddingTokens("中文"), 3, "one token per non-ASCII character");
});

test("one job's bad input fails only that job; a rate limit or an open circuit fails every job in the batch at once", async () => {
  const poisoned = createRecordingEmbed({
    failWhen: (texts) => (texts.includes("POISON") ? statusError("input rejected", 400) : null),
  });
  // No cap of its own: the three jobs linger into one batch.
  const batcher = createEmbeddingBatcher({ embed: poisoned.embed, lingerMs: 10, logger: silentLogger, maxConcurrency: 0 });
  const settled = await Promise.allSettled([
    batcher.embed(["good one", "good two"], SPACE),
    batcher.embed(["POISON"], SPACE),
    batcher.embed(["good three"], SPACE),
  ]);

  assert.deepEqual(
    settled.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"]
  );
  assert.equal(settled[1].reason.status, 400);
  assert.deepEqual(settled[0].value, [
    [8, 103, 1],
    [8, 103, 1],
  ]);
  // One merged request, then one per job to find the culprit.
  assert.deepEqual(
    poisoned.calls.map((call) => call.texts),
    [["good one", "good two", "POISON", "good three"], ["good one", "good two"], ["POISON"], ["good three"]]
  );
  assert.equal(batcher.stats().failedJobs, 1);

  const limited = createRecordingEmbed({ failWhen: () => statusError("rate limited", 429) });
  const limitedBatcher = createEmbeddingBatcher({
    embed: limited.embed,
    lingerMs: 10,
    logger: silentLogger,
    maxConcurrency: 0,
  });
  const down = await Promise.allSettled([
    limitedBatcher.embed(["a"], SPACE),
    limitedBatcher.embed(["b"], SPACE),
  ]);

  assert.deepEqual(down.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(limited.calls.length, 1, "a rate limit is not re-sent per job");
  assert.equal(isBatchWideEmbeddingError(statusError("x", 429)), true);
  assert.equal(isBatchWideEmbeddingError(Object.assign(new Error("open"), { code: "CIRCUIT_OPEN" })), true);
  assert.equal(isBatchWideEmbeddingError(statusError("bad", 400)), false);
  assert.equal(isBatchWideEmbeddingError(statusError("server error", 500)), false);
  assert.equal(isBatchWideEmbeddingError(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), false);

  // A provider that answers with the wrong number of vectors is caught too.
  const short = createEmbeddingBatcher({ embed: async () => [[1]], lingerMs: 1, logger: silentLogger });

  await assert.rejects(() => short.embed(["a", "b"], SPACE), /returned 1 vector\(s\) for 2/);
});

test("a poison input a server answers with a 500 or a timeout fails only its job, not the batch it rode in", async () => {
  for (const failure of [
    () => statusError("internal server error", 500),
    () => Object.assign(new Error("request timed out"), { code: "ETIMEDOUT", status: 408 }),
  ]) {
    const poisoned = createRecordingEmbed({ failWhen: (texts) => (texts.includes("POISON") ? failure() : null) });
    const batcher = createEmbeddingBatcher({ embed: poisoned.embed, lingerMs: 10, logger: silentLogger, maxConcurrency: 0 });
    const settled = await Promise.allSettled([
      batcher.embed(["good one"], SPACE),
      batcher.embed(["POISON"], SPACE),
      batcher.embed(["good two"], SPACE),
    ]);

    assert.deepEqual(settled.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.deepEqual(
      poisoned.calls.map((call) => call.texts),
      [["good one", "POISON", "good two"], ["good one"], ["POISON"], ["good two"]],
      "isolated once per job"
    );
    assert.equal(batcher.stats().isolatedRequests, 3);
  }
});

test("under a concurrency cap texts leave at once while a slot is free; only what the cap holds back is merged", async () => {
  const recorder = createRecordingEmbed({ delayMs: 20 });
  const batcher = createEmbeddingBatcher({ embed: recorder.embed, lingerMs: 60_000, maxConcurrency: 2 });
  const startedAt = Date.now();
  const jobs = [["a1", "a2"], ["b1"], ["c1"], ["d1", "d2"], ["e1"]];
  const results = await Promise.all(jobs.map((texts) => batcher.embed(texts, SPACE)));

  // A and B take the two free slots alone; C, D and E wait and go as one.
  assert.deepEqual(
    recorder.calls.map((call) => call.texts),
    [["a1", "a2"], ["b1"], ["c1", "d1", "d2", "e1"]]
  );
  assert.equal(recorder.maxInFlight, 2);
  assert.ok(Date.now() - startedAt < 10_000, "no linger window under a cap");
  results.forEach((vectors, index) => assert.equal(vectors.length, jobs[index].length));
  assert.equal(batcher.stats().batchedRequests, 1);

  // Idle slots: every job is its own request, sent without waiting.
  const idle = createRecordingEmbed({ delayMs: 5 });
  const roomy = createEmbeddingBatcher({ embed: idle.embed, lingerMs: 60_000, maxConcurrency: 8 });

  await Promise.all([["x"], ["y"], ["z"]].map((texts) => roomy.embed(texts, SPACE)));
  assert.deepEqual(idle.calls.map((call) => call.texts), [["x"], ["y"], ["z"]]);
  assert.equal(roomy.stats().batchedRequests, 0);
});

test("the batcher keeps at most RAG_LLM_MAX_CONCURRENCY requests in flight and queues the rest", async () => {
  const recorder = createRecordingEmbed({ delayMs: 15 });
  const batcher = createEmbeddingBatcher({ embed: recorder.embed, lingerMs: 1, maxConcurrency: 2, maxItems: 1 });
  const results = await Promise.all(["a", "b", "c", "d", "e"].map((text) => batcher.embed([text], SPACE)));

  assert.equal(results.length, 5);
  assert.equal(recorder.calls.length, 5);
  assert.equal(recorder.maxInFlight, 2);

  await withEnv({ RAG_LLM_MAX_CONCURRENCY: "1" }, async () => {
    const single = createRecordingEmbed({ delayMs: 5 });
    const configured = createEmbeddingBatcher({ embed: single.embed, lingerMs: 1, maxItems: 1 });

    await Promise.all(["x", "y", "z"].map((text) => configured.embed([text], SPACE)));
    assert.equal(single.maxInFlight, 1, "the default cap is the model-call concurrency setting");
  });
});

// --- stage outputs ------------------------------------------------------------

test("RAG_INGEST_EMBED_BATCHING=false embeds each job on its own; an injected batcher always merges", async () => {
  await withEnv({ RAG_INGEST_EMBED_BATCHING: undefined }, () => assert.equal(isRagIngestEmbedBatchingEnabled(), true));
  await withEnv({ RAG_INGEST_EMBED_BATCHING: "false" }, () => assert.equal(isRagIngestEmbedBatchingEnabled(), false));

  const space = { dimensions: 3, key: "switch|3", model: "switch" };
  const chunksOf = (texts) =>
    encodeJsonOutput("chunks", {
      documents: texts.map((text, index) => ({ id: `c${index}`, metadata: {}, pageContent: text })),
      pageCount: 1,
      profile: {},
    });
  // The real embed stage's shape: every text of the job in one call per space.
  const embedChunks = async ({ documents, embedInSpace }) => ({
    spaces: [space],
    vectorsBySpace: { [space.key]: await embedInSpace(documents.map((document) => document.pageContent), space) },
  });
  const unbatched = [];
  const off = createIngestPipeline({
    batchingEnabled: () => false,
    embedChunks,
    embedUnbatched: async (texts, requested) => {
      unbatched.push({ space: requested.key, texts });
      return texts.map(() => [1, 0, 0]);
    },
  });

  await Promise.all([
    off.embed({ inputs: { chunks: chunksOf(["alpha", "beta"]) }, job: {} }),
    off.embed({ inputs: { chunks: chunksOf(["gamma"]) }, job: {} }),
  ]);
  assert.deepEqual(
    unbatched.map((entry) => entry.texts).sort((left, right) => left.length - right.length),
    [["gamma"], ["alpha", "beta"]],
    "one request per job, as a synchronous upload sends"
  );
  assert.ok(unbatched.every((entry) => entry.space === space.key));

  const merged = [];
  const on = createIngestPipeline({
    batcher: createEmbeddingBatcher({
      embed: async (texts) => {
        merged.push(texts.length);
        return texts.map((_, index) => [0, index, 1]);
      },
      lingerMs: 20,
      maxConcurrency: 0,
    }),
    batchingEnabled: () => false,
    embedChunks,
    embedUnbatched: async () => {
      throw new Error("an injected batcher is never bypassed");
    },
  });
  const [first, second] = await Promise.all([
    on.embed({ inputs: { chunks: chunksOf(["alpha", "beta"]) }, job: {} }),
    on.embed({ inputs: { chunks: chunksOf(["gamma"]) }, job: {} }),
  ]);

  assert.deepEqual(merged, [3], "both jobs in one request");
  assert.deepEqual(decodeEmbeddingsOutput(first.output).vectorsBySpace[space.key], [
    [0, 0, 1],
    [0, 1, 1],
  ]);
  assert.deepEqual(decodeEmbeddingsOutput(second.output).vectorsBySpace[space.key], [[0, 2, 1]]);
});

test("stage outputs round-trip, embeddings as float32, and an oversized output fails with a 413", () => {
  const pages = [{ pageNumber: 1, text: "Page one." }];

  assert.deepEqual(decodeJsonOutput("pages", encodeJsonOutput("pages", pages)), pages);

  const spaces = [
    { dimensions: 3, key: "a|3", model: "a" },
    { dimensions: 2, key: "b|2", model: "b" },
  ];
  const encoded = encodeEmbeddingsOutput({
    spaces,
    vectorsBySpace: {
      "a|3": [
        [0.5, -0.25, 1],
        [0, 0.125, -1],
      ],
      "b|2": [
        [1, 2],
        [3, 4],
      ],
    },
  });
  const decoded = decodeEmbeddingsOutput(encoded);

  assert.equal(encoded.byteLength, 4 + encoded.readUInt32LE(0) + (2 * 3 + 2 * 2) * 4);
  assert.deepEqual(decoded.vectorsBySpace["a|3"], [
    [0.5, -0.25, 1],
    [0, 0.125, -1],
  ]);
  assert.deepEqual(decoded.spaces.map((space) => space.key), ["a|3", "b|2"]);

  assert.throws(
    () => encodeJsonOutput("chunks", { text: "x".repeat(200) }, { maxBytes: 100 }),
    (error) => error.status === 413 && error.retryable === false && /RAG_INGEST_STAGE_OUTPUT_MAX_BYTES/.test(error.message)
  );
  assert.throws(
    () => encodeEmbeddingsOutput({ spaces: [spaces[0]], vectorsBySpace: { "a|3": [[1, 2, 3]] } }, { maxBytes: 10 }),
    (error) => error.status === 413
  );
  assert.throws(() => decodeEmbeddingsOutput(encoded.subarray(0, encoded.byteLength - 4)), /unreadable/);
  assert.throws(() => decodeJsonOutput("pages", Buffer.from("{}")), /unreadable/);
});

// --- the worker's stage machine on the in-memory queue ------------------------

const PDF_BYTES = Buffer.from("%PDF-1.4 staged pipeline fixture");

// A pipeline whose stages record every call, can fail or hang on demand, and
// pass their inputs along so the index stage can check it got every output.
const createScriptedPipeline = ({ findDuplicate = null } = {}) => {
  const calls = [];
  const behaviour = {};
  const committed = [];

  const run = async (stage, input) => {
    calls.push({ stage, tenant: getActiveDatabaseTenant() });

    const action = behaviour[stage]?.shift?.();

    if (action?.hang) {
      action.hang.started?.();
      await action.hang.release;
    }

    if (action?.error) {
      throw action.error;
    }

    return input;
  };

  return {
    behaviour,
    calls,
    committed,
    stageCalls: (stage) => calls.filter((call) => call.stage === stage).length,
    pipeline: {
      ...(findDuplicate ? { findDuplicate } : {}),
      parse: async ({ filePath, job }) =>
        run("parse", { output: Buffer.from(`pages of ${job.docId}: ${(await readFile(filePath)).length} bytes`) }),
      chunk: async ({ inputs }) => run("chunk", { output: Buffer.from(`chunks <- ${inputs.pages}`) }),
      embed: async ({ inputs }) => run("embed", { output: Buffer.from(`embeddings <- ${inputs.chunks}`) }),
      index: async ({ documentFilePath, inputs, job, onCommit }) => {
        await run("index", null);
        committed.push({
          chunks: inputs.chunks.toString(),
          documentFile: await readFile(documentFilePath),
          embeddings: inputs.embeddings.toString(),
          jobId: job.jobId,
        });
        await onCommit?.({ client: null, docId: job.docId, documentVersion: 1, duplicate: false });
        return { docId: job.docId, documentVersion: 1, duplicate: false, superseded: false };
      },
    },
  };
};

const createStagedWorker = ({ clock, pipeline, store, workerId = "w", ...options }) =>
  createIngestWorker({
    leaseMs: 1000,
    logger: silentLogger,
    pipeline,
    renewIntervalMs: 60000,
    retryDelayMs: () => 0,
    settleRetryDelayMs: 1,
    store,
    tempDirectory: options.tempDirectory,
    workerId,
    ...options,
  });

let tempRoot;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "ingest-pipeline-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

const enqueue = (store, scope = ALICE, overrides = {}) =>
  store.enqueue({
    docId: overrides.docId ?? `doc-${Math.random().toString(16).slice(2)}`,
    fileBytes: PDF_BYTES,
    fileName: "notes.pdf",
    ownerUserId: scope.userId,
    workspaceId: scope.workspaceId,
    ...overrides,
  });

test("a staged job runs every stage in one claim under its tenant, storing each output, and drops the PDF from the job after parse", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const scripted = createScriptedPipeline();
  const stored = [];
  const worker = createStagedWorker({
    clock,
    hooks: {
      afterStage: async ({ job, stage }) => {
        const snapshot = await store.get(job.jobId);

        stored.push({ stage: snapshot.stage, status: snapshot.status });
      },
    },
    pipeline: scripted.pipeline,
    store,
    tempDirectory: tempRoot,
  });
  const job = await enqueue(store, ALICE, { docId: "doc-staged" });

  assert.equal(job.stage, "parse");
  assert.deepEqual(await worker.runOnce(), { jobId: job.jobId, outcome: "succeeded" });
  assert.deepEqual(scripted.calls.map((call) => call.stage), ["parse", "chunk", "embed", "index"]);
  assert.ok(scripted.calls.every((call) => call.tenant?.userId === "alice"));
  assert.deepEqual(stored, [
    { stage: "chunk", status: "running" },
    { stage: "embed", status: "running" },
    { stage: "index", status: "running" },
  ]);
  assert.deepEqual(scripted.committed, [
    {
      chunks: `chunks <- pages of doc-staged: ${PDF_BYTES.length} bytes`,
      documentFile: PDF_BYTES,
      embeddings: `embeddings <- chunks <- pages of doc-staged: ${PDF_BYTES.length} bytes`,
      jobId: job.jobId,
    },
  ]);

  const finished = await store.get(job.jobId);

  assert.equal(finished.status, "succeeded");
  assert.equal(finished.stage, "index");
  assert.equal(finished.attemptCount, 1);
  assert.equal(finished.documentVersion, 1);
  assert.deepEqual(toPublicIngestJob(finished).deadLetter, null);
});

for (const crashStage of INGEST_STAGES) {
  test(`a job whose worker died in ${crashStage} resumes at ${crashStage}, not from the upload`, async () => {
    const clock = createClock();
    const store = createInMemoryIngestJobStore({ now: clock.now });
    const scripted = createScriptedPipeline();
    const started = createDeferred();
    const release = createDeferred();

    // The first worker hangs inside the stage as if its process had died.
    scripted.behaviour[crashStage] = [{ error: new Error("process killed"), hang: { release: release.promise, started: started.resolve } }];

    const job = await enqueue(store, ALICE, { docId: `doc-crash-${crashStage}` });
    const dying = createStagedWorker({ clock, pipeline: scripted.pipeline, store, tempDirectory: tempRoot, workerId: "dying" });
    const dyingRun = dying.runOnce();

    await started.promise;

    const midway = await store.get(job.jobId);

    assert.equal(midway.stage, crashStage, "every stage before it was stored");
    assert.equal(midway.status, "running");

    clock.advance(1001);

    const next = createStagedWorker({ clock, pipeline: scripted.pipeline, store, tempDirectory: tempRoot, workerId: "next" });

    assert.deepEqual(await next.runOnce(), { jobId: job.jobId, outcome: "succeeded" });

    const expected = Object.fromEntries(INGEST_STAGES.map((stage) => [stage, stage === crashStage ? 2 : 1]));

    assert.deepEqual(
      Object.fromEntries(INGEST_STAGES.map((stage) => [stage, scripted.stageCalls(stage)])),
      expected,
      `only ${crashStage} ran twice`
    );

    // The dead attempt wakes up and fails; its fence no longer matches.
    release.resolve();
    assert.deepEqual(await dyingRun, { jobId: job.jobId, outcome: "lease_lost" });

    const finished = await store.get(job.jobId);

    assert.equal(finished.status, "succeeded");
    assert.equal(finished.attemptCount, 2);
    assert.equal(scripted.committed.length, 1);
    assert.deepEqual(scripted.committed[0].documentFile, PDF_BYTES, "the PDF survived the crash as the parse output");
  });
}

test("each stage has its own budget and backoff; a stage out of attempts dead-letters the job, and a requeue resumes it there", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const scripted = createScriptedPipeline();
  const delays = [];
  const outage = () => ({ error: statusError("embedding service unavailable", 503) });

  scripted.behaviour.embed = [outage(), outage()];

  const worker = createStagedWorker({
    clock,
    pipeline: scripted.pipeline,
    retryDelayMs: (attempt, stage) => {
      delays.push([stage, attempt]);
      return 1000 * attempt;
    },
    stageMaxAttempts: (stage) => (stage === "embed" ? 2 : 5),
    store,
    tempDirectory: tempRoot,
  });
  const job = await enqueue(store, ALICE, { docId: "doc-embed-down", maxAttempts: 5 });

  assert.equal((await worker.runOnce()).outcome, "queued");

  let snapshot = await store.get(job.jobId);

  assert.equal(snapshot.stage, "embed", "the retry resumes at the failed stage");
  assert.equal(snapshot.stageAttempts, 1);
  assert.equal(snapshot.maxAttempts, 2, "the embed stage's own budget");
  assert.equal(await worker.runOnce(), null, "its backoff holds");
  clock.advance(1000);
  assert.equal((await worker.runOnce()).outcome, "dead_letter");
  assert.deepEqual(delays, [
    ["embed", 1],
    ["embed", 2],
  ]);

  snapshot = await store.get(job.jobId);

  assert.equal(snapshot.status, "dead_letter");
  assert.equal(snapshot.deadLetterStage, "embed");
  assert.match(snapshot.deadLetterReason, /^Stage embed failed on attempt 2 of 2 \(status 503\): Indexing failed on the server\.$/);
  assert.equal(scripted.stageCalls("parse"), 1);
  assert.equal(scripted.stageCalls("chunk"), 1);

  const operatorView = toDeadLetterIngestJob(snapshot);

  assert.equal(operatorView.deadLetter.stage, "embed");
  assert.equal(operatorView.status, "dead_letter");
  assert.equal(toPublicIngestJob(snapshot).status, "failed");

  // Owner-scoped: bob sees nothing and cannot requeue it.
  assert.deepEqual(await store.listDeadLetters({ accessScope: BOB }), []);
  assert.equal(await store.requeue({ accessScope: BOB, jobId: job.jobId }), null);
  assert.equal(await store.requeue({ jobId: job.jobId, owner: { ownerUserId: "alice", workspaceId: "other" } }), null);
  assert.deepEqual((await store.listDeadLetters({ owner: { ownerUserId: "alice", workspaceId: "ws-a" } })).map((entry) => entry.jobId), [job.jobId]);
  assert.equal((await store.countByStatus()).dead_letter, 1);

  const requeued = await store.requeue({
    accessScope: ALICE,
    jobId: job.jobId,
    maxAttemptsByStage: { chunk: 3, embed: 4, index: 3, parse: 3 },
  });

  assert.equal(requeued.status, "queued");
  assert.equal(requeued.stage, "embed");
  assert.equal(requeued.stageAttempts, 0);
  assert.equal(requeued.maxAttempts, 4, "the stage's current budget");
  assert.equal(requeued.requeueCount, 1);
  assert.equal(await store.requeue({ accessScope: ALICE, jobId: job.jobId }), null, "only a dead-letter job");

  assert.equal((await worker.runOnce()).outcome, "succeeded");
  assert.equal(scripted.stageCalls("parse"), 1, "the upload was never parsed again");
  assert.equal(scripted.stageCalls("embed"), 3);
  assert.equal((await store.countByStatus()).succeeded, 1);
});

test("an upload error fails the job at once and drops what it holds; a 413 from a stage output too", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const scripted = createScriptedPipeline();

  scripted.behaviour.chunk = [{ error: statusError("No extractable text was found in the uploaded PDF.", 422) }];

  const worker = createStagedWorker({ clock, pipeline: scripted.pipeline, store, tempDirectory: tempRoot });
  const job = await enqueue(store, ALICE, { docId: "doc-no-text" });

  assert.equal((await worker.runOnce()).outcome, "failed");

  const failed = await store.get(job.jobId);

  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "chunk");
  assert.equal(failed.lastError, "No extractable text was found in the uploaded PDF.");
  assert.deepEqual(await store.listDeadLetters(), []);

  // A document whose stage output exceeds the bound fails the same way.
  let tooLarge = null;

  try {
    encodeJsonOutput("chunks", { text: "x".repeat(64) }, { maxBytes: 16 });
  } catch (error) {
    tooLarge = error;
  }

  scripted.behaviour.embed = [{ error: tooLarge }];

  const huge = await enqueue(store, ALICE, { docId: "doc-huge" });

  assert.equal((await worker.runOnce()).outcome, "failed");
  assert.equal((await store.get(huge.jobId)).stage, "embed");
  assert.match((await store.get(huge.jobId)).lastError, /too large to ingest/);
  assert.equal(await store.discardOutputs(huge.jobId), 0, "a failed job keeps no outputs");
  assert.equal(
    describeIngestStageFailure({ attempt: 1, error: statusError("x", 413), maxAttempts: 3, stage: "embed" }),
    "Stage embed failed on attempt 1 of 3 (status 413): x"
  );
});

test("a provider or configuration 4xx at embed or index keeps the bytes and dead-letters the job; at parse or chunk it fails it", async () => {
  // At embed and index a 4xx is about the provider or the configuration.
  for (const status of [400, 401, 403, 404, 413, 422]) {
    assert.equal(isRetryableIngestError(statusError("x", status), "embed"), true, `embed ${status}`);
    assert.equal(isRetryableIngestError(statusError("x", status), "index"), true, `index ${status}`);
  }

  assert.equal(isRetryableIngestError(statusError("no text", 422), "chunk"), false);
  assert.equal(isRetryableIngestError(statusError("too large", 413), "parse"), false);
  assert.equal(isRetryableIngestError(statusError("x", 401)), false, "a one-step job keeps the old rule");
  // An error that says it is final is final at any stage (the document it replaces is gone).
  assert.equal(
    isRetryableIngestError(Object.assign(statusError("gone", 404), { retryable: false }), "index"),
    false
  );

  for (const [stage, error] of [
    ["embed", statusError("401 Incorrect API key provided", 401)],
    ["index", statusError("model not found", 404)],
  ]) {
    const clock = createClock();
    const store = createInMemoryIngestJobStore({ now: clock.now });
    const scripted = createScriptedPipeline();

    scripted.behaviour[stage] = [{ error }, { error }];

    const worker = createStagedWorker({
      clock,
      pipeline: scripted.pipeline,
      stageMaxAttempts: () => 2,
      store,
      tempDirectory: tempRoot,
    });
    const job = await enqueue(store, ALICE, { docId: `doc-${stage}-config`, maxAttempts: 2 });

    assert.equal((await worker.runOnce()).outcome, "queued", `${stage}: a retry, not a failure`);
    assert.equal((await worker.runOnce()).outcome, "dead_letter");

    const dead = await store.get(job.jobId);

    assert.equal(dead.deadLetterStage, stage);
    assert.equal(dead.lastError, "Indexing failed on the server.", "the provider's message stays private");

    // The bytes and outputs survived: fixing the key and requeueing finishes it.
    assert.ok((await store.requeue({ accessScope: ALICE, jobId: job.jobId })) !== null);
    assert.equal((await worker.runOnce()).outcome, "succeeded");
    assert.equal(scripted.stageCalls("parse"), 1, `${stage}: the upload was never parsed again`);
    assert.equal(scripted.committed.at(-1).documentFile.equals(PDF_BYTES), true);
  }
});

test("an advanceStage retried after its commit went through but its answer was lost counts as done", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const scripted = createScriptedPipeline();
  let lostAnswers = 0;
  const lostOnce = new Set();
  // The first call of each stage commits, then its connection resets.
  const flaky = {
    ...store,
    advanceStage: async (input) => {
      const advanced = await store.advanceStage(input);

      if (!lostOnce.has(input.fromStage)) {
        lostOnce.add(input.fromStage);
        lostAnswers += 1;
        throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
      }

      return advanced;
    },
  };
  const worker = createStagedWorker({ clock, pipeline: scripted.pipeline, store: flaky, tempDirectory: tempRoot });
  const job = await enqueue(store, ALICE, { docId: "doc-lost-answer" });

  assert.equal((await worker.runOnce()).outcome, "succeeded", "the worker kept the job it still owned");
  assert.equal(lostAnswers, 3);
  assert.deepEqual(scripted.calls.map((call) => call.stage), ["parse", "chunk", "embed", "index"]);
  assert.equal((await store.get(job.jobId)).status, "succeeded");

  // Direct: the same call twice under one fence is true twice; another fence or stage is not.
  const second = await enqueue(store, ALICE, { docId: "doc-twice" });
  const claimed = await store.claim({ leaseMs: 1000, workerId: "w2" });
  const fence = { attemptCount: claimed.attemptCount, jobId: second.jobId, workerId: "w2" };
  const advance = (overrides = {}) =>
    store.advanceStage({
      ...fence,
      fromStage: "parse",
      leaseMs: 1000,
      maxAttempts: 3,
      output: { name: "pages", payload: Buffer.from("p") },
      toStage: "chunk",
      ...overrides,
    });

  assert.equal(await advance(), true);
  assert.equal(await advance(), true);
  assert.equal(await advance({ workerId: "someone-else" }), false);
  assert.equal(await advance({ fromStage: "chunk", toStage: "embed", output: { name: "chunks", payload: Buffer.from("c") } }), true);
  assert.equal(await advance(), false, "no longer at chunk's first attempt");
});

test("an attempt that lost its lease never starts the index commit, and a superseded replacement is recorded as such", async () => {
  const clock = createClock();
  const store = createInMemoryIngestJobStore({ now: clock.now });
  const scripted = createScriptedPipeline();
  let renewals = 0;
  // Another worker took the job over while this attempt embedded it.
  const fenced = {
    ...store,
    renew: async (input) => {
      renewals += 1;
      return false;
    },
  };
  const worker = createStagedWorker({ clock, pipeline: scripted.pipeline, store: fenced, tempDirectory: tempRoot });
  const job = await enqueue(store, ALICE, { docId: "doc-stale-attempt" });

  assert.equal((await worker.runOnce()).outcome, "lease_lost");
  assert.equal(renewals, 1, "one fenced renewal right before the commit");
  assert.equal(scripted.stageCalls("index"), 0, "the commit never started");
  assert.equal(scripted.committed.length, 0);
  assert.equal((await store.get(job.jobId)).stage, "index");

  // A replacement a newer one overtook succeeds (nothing to retry) but says so.
  const superseding = createScriptedPipeline();

  superseding.pipeline.index = async ({ job: current, onCommit }) => {
    await onCommit?.({ client: null, docId: current.docId, documentVersion: 5, duplicate: false, superseded: true });
    return { docId: current.docId, documentVersion: 5, duplicate: false, superseded: true };
  };

  const otherStore = createInMemoryIngestJobStore({ now: clock.now });
  const replacement = await enqueue(otherStore, ALICE, { docId: "doc-overtaken", kind: "replace" });
  const replacer = createStagedWorker({ clock, pipeline: superseding.pipeline, store: otherStore, tempDirectory: tempRoot });

  assert.equal((await replacer.runOnce()).outcome, "succeeded");

  const finished = await otherStore.get(replacement.jobId);

  assert.equal(finished.superseded, true);
  assert.equal(finished.documentVersion, 5, "the version that stays");
  assert.equal(toPublicIngestJob(finished).superseded, true);
  assert.equal(toPublicIngestJob(await store.get(job.jobId)).superseded, false);
});

test("the embeddings output is bounded per space, so a document fits while a second model is being built", () => {
  const spaces = [
    { dimensions: 4, key: "a|4", model: "a" },
    { dimensions: 4, key: "b|4", model: "b" },
  ];
  const vectors = Array.from({ length: 10 }, () => [0.1, 0.2, 0.3, 0.4]);
  // One space's vectors take 160 bytes; both together 320.
  const encoded = encodeEmbeddingsOutput(
    { spaces, vectorsBySpace: { "a|4": vectors, "b|4": vectors } },
    { maxBytes: 200 }
  );

  assert.equal(decodeEmbeddingsOutput(encoded).vectorsBySpace["b|4"].length, 10);
  assert.throws(
    () => encodeEmbeddingsOutput({ spaces: [spaces[0]], vectorsBySpace: { "a|4": vectors } }, { maxBytes: 100 }),
    (error) =>
      error.status === 413 &&
      error.retryable === undefined &&
      isRetryableIngestError(error, "embed") === true &&
      /its embeddings would take 160 bytes/.test(error.message)
  );
});

test("an upload whose bytes the tenant already stored resolves at enqueue, or before its first stage", async () => {
  const clock = createClock();
  const known = new Map([["a".repeat(64), { docId: "doc-existing", documentVersion: 3 }]]);
  const store = createInMemoryIngestJobStore({
    findDuplicateDocument: async ({ contentSha256, ownerUserId }) =>
      ownerUserId === "alice" ? known.get(contentSha256) ?? null : null,
    now: clock.now,
  });
  const resolved = await enqueue(store, ALICE, { contentSha256: "a".repeat(64), deduplicate: true });

  assert.equal(resolved.status, "succeeded");
  assert.equal(resolved.resolvedDocId, "doc-existing");
  assert.equal(resolved.duplicate, true);
  assert.equal(resolved.fileBytes, null);
  assert.equal(toPublicIngestJob(resolved).docId, "doc-existing");
  assert.equal(toPublicIngestJob(resolved).documentVersion, 3);

  // Another tenant with the same bytes, dedup off, or a replacement: queued.
  assert.equal((await enqueue(store, BOB, { contentSha256: "a".repeat(64), deduplicate: true })).status, "queued");
  assert.equal((await enqueue(store, ALICE, { contentSha256: "a".repeat(64), deduplicate: false })).status, "queued");
  assert.equal(
    (await enqueue(store, ALICE, { contentSha256: "a".repeat(64), deduplicate: true, docId: "doc-existing", kind: "replace" })).deduplicate,
    false,
    "a replacement is never resolved to another document"
  );

  // The same bytes stored while the job waited: resolved before parsing.
  const scripted = createScriptedPipeline({
    findDuplicate: async ({ job }) => (job.deduplicate ? { docId: "doc-meanwhile", documentVersion: 1 } : null),
  });
  const racing = createInMemoryIngestJobStore({ findDuplicateDocument: async () => null, now: clock.now });
  const job = await enqueue(racing, ALICE, { contentSha256: "b".repeat(64), deduplicate: true });
  const worker = createStagedWorker({ clock, pipeline: scripted.pipeline, store: racing, tempDirectory: tempRoot });

  assert.equal((await worker.runOnce()).outcome, "succeeded");
  assert.equal(scripted.calls.length, 0, "no stage ran");

  const finished = await racing.get(job.jobId);

  assert.equal(finished.resolvedDocId, "doc-meanwhile");
  assert.equal(finished.duplicate, true);
});

test("the real ingest declares its staged form; a stub's ingest runs as one step", () => {
  assert.equal(supportsStagedIngest(ingestDocument), true);
  assert.equal(ingestDocument[STAGED_INGEST], true);
  assert.equal(supportsStagedIngest(async () => null), false);
});

// --- the real pipeline on the local index and the file registry -------------

const DIMENSIONS = 8;
const embedText = (text) => {
  const vector = new Array(DIMENSIONS).fill(0);

  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    let hash = 0;

    for (const character of word) {
      hash = (hash * 31 + character.charCodeAt(0)) % DIMENSIONS;
    }

    vector[hash] += 1;
  }

  return vector;
};

const createProvider = () => {
  const calls = [];

  return {
    calls,
    provider: {
      completeText: async () => "unused",
      embedQuery: async (query) => embedText(query),
      embedTexts: async (texts) => {
        calls.push(texts.length);

        if (texts.some((text) => text.includes("POISON"))) {
          throw statusError("The provider rejected an input.", 400);
        }

        return texts.map(embedText);
      },
    },
  };
};

const writePdf = async (name, sentences) => {
  const filePath = path.join(tempRoot, `${name}.pdf`);

  await writeFile(filePath, buildTextPdf({ pages: [sentences] }));
  return filePath;
};

const withLocalArchive = async (callback) =>
  withEnv({ RAG_HYBRID_ENABLED: "false", VECTOR_STORE_PROVIDER: "local" }, async () => {
    const provider = createProvider();

    configureRagDataDirectory(path.join(tempRoot, "rag-data"));
    await resetDocumentRegistryStore();
    configureDocumentRegistryStore(createFileDocumentRegistryStore());
    resetVectorStore();
    configureOpenAIProvider(provider.provider);

    try {
      return await callback(provider);
    } finally {
      await clearDocuments({ deleteFiles: false });
      resetVectorStore();
      await resetDocumentRegistryStore();
      resetOpenAIProvider();
    }
  });

const contentsOf = async (docId, query) =>
  (await searchDocuments({ docIds: [docId], queryText: query, queryVector: embedText(query), topK: 10 })).map(
    (result) => result.document
  );

test("sync ingest records the content hash and version, answers a same-tenant duplicate with the stored document, and not another tenant's", async () => {
  await withLocalArchive(async () => {
    const filePath = await writePdf("policy", ["Remote work needs manager approval."]);
    const bytes = await readFile(filePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const first = await ingestDocument({
      deduplicate: true,
      docId: "doc-first",
      fileName: "policy.pdf",
      filePath,
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });

    assert.equal(first.duplicate, undefined);
    assert.equal(first.version, 1);
    assert.equal(first.contentSha256, hash);

    const again = await ingestDocument({
      deduplicate: true,
      docId: "doc-second",
      fileName: "copy.pdf",
      filePath,
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });

    assert.equal(again.duplicate, true);
    assert.equal(again.docId, "doc-first");
    assert.equal(getDocument("doc-second"), null, "no copy was ingested");

    const otherTenant = await ingestDocument({
      deduplicate: true,
      docId: "doc-bob",
      fileName: "policy.pdf",
      filePath,
      ownerUserId: "bob",
      workspaceId: "ws-b",
    });

    assert.equal(otherTenant.docId, "doc-bob", "dedup never crosses tenants");
    assert.equal(otherTenant.duplicate, undefined);

    // Deduplication is opt-in per call: without it the same bytes ingest again.
    const optedOut = await ingestDocument({
      docId: "doc-third",
      fileName: "policy.pdf",
      filePath,
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });

    assert.equal(optedOut.docId, "doc-third");
    assert.equal((await findDocumentByContentHash(hash, { ownerUserId: "alice", workspaceId: "ws-a" })).docId, "doc-first");

    // Identical uploads racing each other still end as one document.
    const racePath = await writePdf("race", ["Racing uploads of one file end as one document."]);
    const raced = await Promise.all(
      ["doc-race-1", "doc-race-2", "doc-race-3"].map((docId) =>
        ingestDocument({ deduplicate: true, docId, fileName: "race.pdf", filePath: racePath, ownerUserId: "alice", workspaceId: "ws-a" })
      )
    );

    assert.equal(new Set(raced.map((document) => document.docId)).size, 1);
    assert.equal(raced.filter((document) => document.duplicate).length, 2);
  });
});

test("without a transactional provider a replacement is refused before anything is parsed, and the document is unchanged", async () => {
  // The local and Qdrant indexes cannot swap a document's chunks atomically:
  // the old ones would go first, and a failed write would leave none. The
  // replacement semantics (version, superseded, atomic swap) are covered on
  // pgvector by ingest-pipeline-postgres.integration.test.mjs.
  await withLocalArchive(async (provider) => {
    const original = await ingestDocument({
      docId: "doc-replace",
      fileName: "v1.pdf",
      filePath: await writePdf("v1", ["Alpha budget caps meals at forty dollars."]),
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });
    const embeddingsBefore = provider.calls.length;

    assert.equal(supportsDocumentReplacement(), false);
    await assert.rejects(
      () =>
        replaceDocument({
          docId: "doc-replace",
          fileName: "v2.pdf",
          filePath: path.join(tempRoot, "does-not-matter.pdf"),
          ownerUserId: "alice",
          workspaceId: "ws-a",
        }),
      (error) =>
        error.status === 409 &&
        error.retryable === false &&
        error.expose === true &&
        /needs VECTOR_STORE_PROVIDER=pgvector/.test(error.message)
    );
    assert.equal(provider.calls.length, embeddingsBefore, "nothing was embedded");
    assert.equal(getDocument("doc-replace").version, 1);
    assert.equal(getDocument("doc-replace").contentSha256, original.contentSha256);
    assert.ok((await contentsOf("doc-replace", "budget meals")).every((chunk) => /Alpha/.test(chunk.pageContent)));
  });
});

test("the real staged pipeline batches concurrent jobs' embeddings, fans them out, and fails only the job with a bad input", async () => {
  await withLocalArchive(async (provider) => {
    const store = createInMemoryIngestJobStore({ findDuplicateDocument: async () => null });
    const documents = {
      "doc-a": ["Apple orchards need pruning in winter."],
      "doc-b": ["Bridge inspections happen every two years."],
      "doc-c": ["Copper wiring must be grounded in wet rooms."],
      "doc-poisoned": ["POISON sentence the provider refuses."],
    };
    const barrier = createBarrier(Object.keys(documents).length);
    const { loadPdfPages } = await import("../rag/pdf-loader.js");
    const pipeline = createIngestPipeline({
      batcher: createEmbeddingBatcher({
        embed: async (texts) => {
          const { embedTexts } = await import("../rag/openai.js");

          return embedTexts(texts);
        },
        lingerMs: 100,
        logger: silentLogger,
        // No cap of its own, so the four jobs linger into one batch.
        maxConcurrency: 0,
      }),
      // Every job reaches the embed stage together.
      loadPages: async (filePath) => {
        const pages = await loadPdfPages(filePath);

        await barrier.arrive();
        return pages;
      },
    });

    for (const [docId, sentences] of Object.entries(documents)) {
      await store.enqueue({
        docId,
        fileBytes: buildTextPdf({ pages: [sentences] }),
        fileName: `${docId}.pdf`,
        ownerUserId: "alice",
        workspaceId: "ws-a",
      });
    }

    const worker = createIngestWorker({
      concurrency: 4,
      leaseMs: 60000,
      logger: silentLogger,
      pipeline,
      retryDelayMs: () => 0,
      store,
      tempDirectory: tempRoot,
      workerId: "batching",
    });
    const outcomes = await Promise.all(Object.keys(documents).map(() => worker.runOnce()));

    // A provider's 4xx at the embed stage is no verdict on the upload: the
    // job keeps its bytes and spends the stage's retries (then dead_letter).
    assert.deepEqual(outcomes.map((entry) => entry.outcome).sort(), ["queued", "succeeded", "succeeded", "succeeded"]);

    const poisonedJob = (await store.listDeadLetters({ limit: 10 })).length === 0
      ? [...(await Promise.all(outcomes.map((entry) => store.get(entry.jobId))))].find(
          (job) => job.docId === "doc-poisoned"
        )
      : null;

    assert.equal(poisonedJob.status, "queued");
    assert.equal(poisonedJob.stage, "embed");
    // One merged request, then one per job to find the bad input: 1 + 4, where
    // one request per job would be 4 and then the 3 good ones are served.
    assert.ok(provider.calls.length < 1 + Object.keys(documents).length + 1);
    assert.equal(provider.calls[0], 4, "the first request carried every job's chunk");

    for (const docId of ["doc-a", "doc-b", "doc-c"]) {
      const [top] = await contentsOf(docId, documents[docId][0]);

      assert.equal(top.metadata.docId, docId);
      assert.equal(top.pageContent.trim(), documents[docId][0]);
      assert.equal(getDocument(docId).version, 1);
    }

    assert.equal(getDocument("doc-poisoned"), null);

    // Without a failing input, four documents cost one embeddings request.
    provider.calls.length = 0;

    const clean = createInMemoryIngestJobStore({ findDuplicateDocument: async () => null });
    const secondBarrier = createBarrier(4);
    const cleanPipeline = createIngestPipeline({
      batcher: createEmbeddingBatcher({
        embed: async (texts) => (await import("../rag/openai.js")).embedTexts(texts),
        lingerMs: 100,
        maxConcurrency: 0,
      }),
      loadPages: async (filePath) => {
        const pages = await loadPdfPages(filePath);

        await secondBarrier.arrive();
        return pages;
      },
    });

    for (const index of [1, 2, 3, 4]) {
      await clean.enqueue({
        docId: `doc-clean-${index}`,
        fileBytes: buildTextPdf({ pages: [[`Clean document number ${index} talks about topic ${"xyzw"[index - 1]}.`]] }),
        fileName: `clean-${index}.pdf`,
        ownerUserId: "alice",
        workspaceId: "ws-a",
      });
    }

    const cleanWorker = createIngestWorker({
      concurrency: 4,
      leaseMs: 60000,
      logger: silentLogger,
      pipeline: cleanPipeline,
      store: clean,
      tempDirectory: tempRoot,
      workerId: "clean",
    });

    assert.deepEqual(
      (await Promise.all([1, 2, 3, 4].map(() => cleanWorker.runOnce()))).map((entry) => entry.outcome),
      ["succeeded", "succeeded", "succeeded", "succeeded"]
    );
    assert.deepEqual(provider.calls, [4], "four documents, one embeddings request");
  });
});

test("an async replacement job on a provider without transactions fails at its index stage and leaves the document as it was", async () => {
  await withLocalArchive(async () => {
    await ingestDocument({
      docId: "doc-async-replace",
      fileName: "v1.pdf",
      filePath: await writePdf("async-v1", ["Gamma renewal window is twelve months."]),
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });

    const store = createInMemoryIngestJobStore();
    const job = await store.enqueue({
      docId: "doc-async-replace",
      fileBytes: buildTextPdf({ pages: [["Gamma renewal window is now eighteen months."]] }),
      fileName: "v2.pdf",
      kind: "replace",
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });
    const worker = createIngestWorker({
      leaseMs: 60000,
      logger: silentLogger,
      pipeline: createIngestPipeline({ batcher: createEmbeddingBatcher({ embed: async (texts) => texts.map(embedText), lingerMs: 1 }) }),
      store,
      tempDirectory: tempRoot,
      workerId: "replacer",
    });

    // The route refuses such a PUT (409) before it queues anything; a job that
    // was queued anyway (the provider changed) fails for good at index.
    assert.equal((await worker.runOnce()).outcome, "failed");

    const finished = await store.get(job.jobId);

    assert.equal(finished.stage, "index");
    assert.match(finished.lastError, /needs VECTOR_STORE_PROVIDER=pgvector/);
    assert.equal(getDocument("doc-async-replace").version, 1);
    assert.ok(
      (await contentsOf("doc-async-replace", "renewal window")).every((chunk) => /twelve/.test(chunk.pageContent))
    );
  });
});
