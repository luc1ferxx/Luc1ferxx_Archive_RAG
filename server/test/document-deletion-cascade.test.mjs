// What deleting a document also removes (rag/document-deletion-cascade.js):
// its waiting ingest jobs always, and with DOCUMENT_DELETE_REDACTION=on the
// copies of its text in the deleting tenant's settled agent runs, workspace
// artifacts and answer feedback. In-memory and file stores here, the
// PostgreSQL stores through fake query functions; the real database cases
// live in vector-store-pgvector-versions.integration.test.mjs.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileFeedbackStore } from "../feedback.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { isDocumentDeleteRedactionEnabled } from "../rag/config.js";
import {
  configureDocumentRegistryStore,
  getDocument,
  resetDocumentRegistry,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import {
  createDocumentDeletionCascade,
  runDocumentDeletionCascade,
} from "../rag/document-deletion-cascade.js";
import {
  DELETED_SOURCE_TEXT_MARKER,
  buildDocumentReferenceNeedles,
  redactDocumentText,
  referencesDocuments,
  replaceQuotedText,
  replaceQuotedTextDeep,
} from "../rag/document-deletion-redaction.js";
import { resetEmbeddingCache } from "../rag/embedding-cache.js";
import {
  DOCUMENT_DELETED_JOB_ERROR_MESSAGE,
  INGEST_JOB_STATUSES,
  createInMemoryIngestJobStore,
  createPostgresIngestJobStore,
  toDeadLetterIngestJob,
  toPublicIngestJob,
} from "../rag/ingest-job-store.js";
import { clearDocuments, deleteDocument, ingestDocumentPages } from "../rag/index.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { createPostgresAgentRunStore } from "../rag/postgres-agent-run-store.js";
import { createPostgresFeedbackStore } from "../rag/postgres-feedback-store.js";
import { getDatabaseTenantContext, runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import { resetVectorStore } from "../rag/vector-store.js";
import {
  createInMemoryWorkspaceArtifactStore,
  createPostgresWorkspaceArtifactStore,
  createWorkspaceArtifactService,
  toWorkspaceArtifactDetail,
  toWorkspaceArtifactSummary,
} from "../rag/workspace-artifacts/index.js";

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };
const PDF_BYTES = Buffer.from("%PDF-1.4 deletion cascade fixture");
const EXCERPT = "Annual leave policy: employees receive 10 paid annual leave days each year.";
const silentLogger = { error() {}, log() {}, warn() {} };
const ENV_NAMES = [
  "DOCUMENT_DELETE_REDACTION",
  "RAG_HYBRID_ENABLED",
  "RAG_LONG_MEMORY_ENABLED",
  "VECTOR_STORE_PROVIDER",
];
let savedEnvironment = {};

beforeEach(() => {
  savedEnvironment = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

  for (const name of ENV_NAMES) {
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const citation = (docId, overrides = {}) => ({
  chunkIndex: 0,
  docId,
  excerpt: EXCERPT,
  fileName: `${docId}.pdf`,
  pageNumber: 1,
  rank: 1,
  score: 0.9,
  sectionHeading: "Leave",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("DOCUMENT_DELETE_REDACTION is off unless set to on, true, 1 or yes", () => {
  assert.equal(isDocumentDeleteRedactionEnabled(), false);

  for (const value of ["on", "ON", " true ", "1", "yes"]) {
    process.env.DOCUMENT_DELETE_REDACTION = value;
    assert.equal(isDocumentDeleteRedactionEnabled(), true, value);
  }

  for (const value of ["", "  ", "off", "false", "0", "redact", "enabled"]) {
    process.env.DOCUMENT_DELETE_REDACTION = value;
    assert.equal(isDocumentDeleteRedactionEnabled(), false, value);
  }
});

test("redaction replaces the text of every object naming a deleted document and keeps ids, scores and other documents", () => {
  const value = {
    answer: "Employees get 10 days [Source 1].",
    citations: [citation("doc-x"), citation("doc-y", { excerpt: "Remote work two days a week." })],
    nested: [{ document: { metadata: { docId: "doc-x", sectionHeading: "Leave" }, pageContent: "raw chunk" } }],
  };
  const frozen = structuredClone(value);
  const outcome = redactDocumentText(value, ["doc-x", " "]);

  assert.deepEqual(value, frozen, "the input is never mutated");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.value.answer, value.answer, "model-written text stays");
  assert.deepEqual(outcome.value.citations[0], {
    ...citation("doc-x"),
    excerpt: DELETED_SOURCE_TEXT_MARKER,
    sectionHeading: DELETED_SOURCE_TEXT_MARKER,
  });
  assert.equal(outcome.value.citations[1], value.citations[1], "another document's branch keeps its identity");
  assert.deepEqual(outcome.value.nested[0].document, {
    metadata: { docId: "doc-x", sectionHeading: DELETED_SOURCE_TEXT_MARKER },
    pageContent: DELETED_SOURCE_TEXT_MARKER,
  });
  assert.deepEqual(outcome.quotes.sort(), [EXCERPT, "Leave", "raw chunk"].sort());
  assert.equal(outcome.redactedFieldCount, 4);

  const again = redactDocumentText(outcome.value, ["doc-x"]);

  assert.equal(again.changed, false, "redacting twice changes nothing");
  assert.equal(redactDocumentText(value, []).changed, false);
});

test("quoted text is replaced verbatim and JSON-escaped, never growing the text, and needles match both serializations", () => {
  const quote = 'The "annual" leave policy grants 10 days.';
  const body = `Report\n${quote}\n${JSON.stringify({ quote })}\nShort`;
  const replaced = replaceQuotedText(body, [quote, "Short"]);

  assert.equal(replaced.includes(quote), false);
  assert.equal(replaced.includes(JSON.stringify(quote).slice(1, -1)), false);
  assert.match(replaced, /Short$/, "a quote no longer than the marker is left alone");
  assert.ok(replaced.length <= body.length);
  assert.deepEqual(replaceQuotedTextDeep({ list: [body], n: 1 }, [quote]).list, [replaced]);

  const needles = buildDocumentReferenceNeedles(["doc-x"]);

  assert.deepEqual(needles, ['"docId": "doc-x"', '"docId":"doc-x"']);
  assert.equal(referencesDocuments({ citations: [citation("doc-x")] }, ["doc-x"]), true);
  assert.equal(referencesDocuments({ citations: [citation("doc-xy")] }, ["doc-x"]), false);
});

// ---------------------------------------------------------------------------
// Ingest jobs (always)
// ---------------------------------------------------------------------------

const enqueueFor = (store, scope, overrides = {}) =>
  store.enqueue({
    docId: "doc-x",
    fileBytes: PDF_BYTES,
    fileName: "notes.pdf",
    ownerUserId: scope.userId,
    workspaceId: scope.workspaceId,
    ...overrides,
  });

test("the in-memory store cancels a deleted document's queued, retry-waiting and dead-letter jobs and nothing else", async () => {
  const current = Date.parse("2026-10-17T10:00:00.000Z");
  const store = createInMemoryIngestJobStore({ logger: silentLogger, now: () => current });
  const fence = (job) => ({ attemptCount: job.attemptCount, jobId: job.jobId, workerId: "worker-1" });
  const claimNext = async (expectedId) => {
    const claimed = await store.claim({ leaseMs: 60_000, workerId: "worker-1" });

    assert.equal(claimed?.jobId, expectedId);
    return claimed;
  };

  // Created in the order the claims below take them (oldest first).
  await enqueueFor(store, ALICE, { jobId: "a-waiting", kind: "replace" });
  await enqueueFor(store, ALICE, { jobId: "a-dead", kind: "replace", maxAttempts: 1 });
  await enqueueFor(store, ALICE, { jobId: "a-running", kind: "replace" });
  await enqueueFor(store, ALICE, { jobId: "a-queued", kind: "replace" });
  await enqueueFor(store, ALICE, { docId: "doc-other", jobId: "a-other" });
  await enqueueFor(store, BOB, { jobId: "b-queued", kind: "replace" });

  // a-waiting: failed retryably, waiting out its delay.
  assert.equal(
    await store.fail({
      ...fence(await claimNext("a-waiting")),
      error: new Error("busy"),
      retryDelayMs: 60_000,
      retryable: true,
    }),
    INGEST_JOB_STATUSES.queued
  );
  // a-dead: its only attempt failed.
  assert.equal(
    await store.fail({ ...fence(await claimNext("a-dead")), error: new Error("busy"), retryable: true }),
    INGEST_JOB_STATUSES.deadLetter
  );
  // a-running: held by a worker.
  await claimNext("a-running");

  // Bob's job and doc-other stay queued; a-queued is queued; delete doc-x as Alice.
  const canceled = await store.cancelDocumentJobs({ accessScope: ALICE, docIds: ["doc-x", " "] });

  assert.deepEqual(canceled, ["a-dead", "a-queued", "a-waiting"]);

  for (const jobId of canceled) {
    const job = await store.get(jobId, ALICE);

    assert.equal(job.status, INGEST_JOB_STATUSES.failed);
    assert.equal(job.canceledReason, "document_deleted");
    assert.equal(job.lastError, DOCUMENT_DELETED_JOB_ERROR_MESSAGE);
    assert.equal(job.deadLetterReason, null);
    assert.deepEqual(toPublicIngestJob(job), {
      ...toPublicIngestJob({ ...job, canceledReason: undefined }),
      canceledReason: "document_deleted",
    });
    assert.equal(toPublicIngestJob(job).deadLetter, null);
    assert.equal(toDeadLetterIngestJob(job).canceledReason, "document_deleted");
  }

  assert.equal((await store.get("a-running", ALICE)).status, INGEST_JOB_STATUSES.running, "a running job is left to its worker");
  assert.equal((await store.get("a-other", ALICE)).status, INGEST_JOB_STATUSES.queued);
  assert.equal((await store.get("b-queued", BOB)).status, INGEST_JOB_STATUSES.queued, "another tenant's job is untouched");
  assert.equal("canceledReason" in (await store.get("a-other", ALICE)), false, "other jobs read as before");
  assert.equal("canceledReason" in toPublicIngestJob(await store.get("a-other", ALICE)), false);
  assert.deepEqual(await store.listDeadLetters({ accessScope: ALICE }), [], "no longer a dead letter to requeue");
  assert.equal(await store.requeue({ accessScope: ALICE, jobId: "a-dead" }), null);

  // An unscoped delete (auth off) reaches every tenant's jobs of the document.
  assert.deepEqual(await store.cancelDocumentJobs({ docIds: ["doc-x"] }), ["b-queued"]);
  assert.deepEqual(await store.cancelDocumentJobs({ docIds: [] }), []);
});

test("a canceled job no longer counts against its tenant's pending caps", async () => {
  const store = createInMemoryIngestJobStore({
    getPendingLimits: () => ({ maxPendingBytes: 0, maxPendingJobs: 1 }),
    logger: silentLogger,
  });

  await enqueueFor(store, ALICE, { jobId: "first" });
  await assert.rejects(enqueueFor(store, ALICE, { docId: "doc-y", jobId: "second" }), { status: 429 });
  await store.cancelDocumentJobs({ accessScope: ALICE, docIds: ["doc-x"] });
  assert.equal((await enqueueFor(store, ALICE, { docId: "doc-y", jobId: "second" })).status, "queued");
});

test("the PostgreSQL store cancels in one statement in the caller's context, by the access scope rule, dropping outputs", async () => {
  const calls = [];
  const store = createPostgresIngestJobStore({
    getTable: () => "rag_ingest_jobs",
    logger: silentLogger,
    queryPostgres: async (sql, values = []) => {
      calls.push({ context: getDatabaseTenantContext(), sql, values });
      return { rows: [{ job_id: "job-1" }, { job_id: "job-2" }] };
    },
  });

  const canceled = await runWithDatabaseTenant(ALICE, () =>
    store.cancelDocumentJobs({ accessScope: ALICE, docIds: ["doc-x", "doc-x", " "] })
  );

  assert.deepEqual(canceled, ["job-1", "job-2"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context, "tenant", "under the request's tenant: the row policies apply");

  const sql = calls[0].sql.replace(/\s+/g, " ");

  assert.match(sql, /UPDATE rag_ingest_jobs AS j SET status = 'failed', canceled_reason = \$7, last_error = \$8, file_bytes = NULL/);
  assert.match(sql, /WHERE j\.doc_id = ANY\(\$6::text\[\]\) AND j\.status IN \('queued', 'dead_letter'\)/);
  assert.match(sql, /DELETE FROM rag_ingest_jobs_outputs AS o USING canceled WHERE o\.job_id = canceled\.job_id/);
  assert.deepEqual(calls[0].values, [
    "alice",
    "ws-a",
    false,
    "",
    "",
    ["doc-x"],
    "document_deleted",
    DOCUMENT_DELETED_JOB_ERROR_MESSAGE,
  ]);
  assert.deepEqual(await store.cancelDocumentJobs({ docIds: [] }), []);
  assert.equal(calls.length, 1, "nothing to cancel sends nothing");
});

// ---------------------------------------------------------------------------
// The cascade over in-memory stores
// ---------------------------------------------------------------------------

const createRun = (store, scope, { runId, status = "completed", docId = "doc-x" }) =>
  store.create({
    accessScope: scope,
    run: {
      decisions: [],
      goal: "What is the leave policy?",
      observations: [{ citationCount: 1, skillId: "document_rag" }],
      result: {
        answer: "Employees get 10 days [Source 1].",
        __skillGraphCheckpoint: { nodes: [{ output: { citations: [citation(docId)] } }] },
      },
      runId,
      status,
      steps: [
        {
          id: "step:1",
          output: { citations: [citation(docId)], text: "Employees get 10 days [Source 1]." },
          status: "completed",
          type: "document_rag",
          updatedAt: "2026-10-17T09:00:00.000Z",
        },
      ],
      updatedAt: "2026-10-17T09:00:00.000Z",
    },
  });

const createStores = () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const workspaceArtifactStore = createInMemoryWorkspaceArtifactStore();
  const ingestJobStore = createInMemoryIngestJobStore({ logger: silentLogger });

  return { agentRunStore, ingestJobStore, workspaceArtifactStore };
};

const createArtifact = (store, scope, { artifactId, docId = "doc-x", title = "Leave report" }) =>
  createWorkspaceArtifactService({ createArtifactId: () => artifactId, store }).createArtifact({
    accessScope: scope,
    artifact: {
      artifactId,
      artifactType: "report",
      citationManifest: [{ docId, excerpt: EXCERPT, fileName: `${docId}.pdf`, pageNumber: 1 }],
      content: `# ${title}\n\n> ${EXCERPT}\n\nSummary written by the model.`,
      docIds: [docId],
      idempotencyKey: `key-${artifactId}`,
      payload: { metadata: { quoted: EXCERPT }, sources: [{ docId, text: EXCERPT }] },
      title,
    },
  });

test("with redaction off the cascade cancels jobs and leaves runs and artifacts as they are", async () => {
  const stores = createStores();

  await createRun(stores.agentRunStore, ALICE, { runId: "run-1" });
  await createArtifact(stores.workspaceArtifactStore, ALICE, { artifactId: "artifact-1" });
  await enqueueFor(stores.ingestJobStore, ALICE, { jobId: "job-1", kind: "replace" });

  const before = structuredClone(stores.agentRunStore.get({ accessScope: ALICE, runId: "run-1" }));
  const cascade = createDocumentDeletionCascade({ ...stores, logger: silentLogger });
  const summary = await cascade.afterDocumentsDeleted({ accessScope: ALICE, docIds: ["doc-x"] });

  assert.deepEqual(summary, { ingestJobs: { canceled: 1 }, redaction: null });
  assert.deepEqual(stores.agentRunStore.get({ accessScope: ALICE, runId: "run-1" }), before);
  assert.equal(
    (await stores.workspaceArtifactStore.getArtifact({ accessScope: ALICE, artifactId: "artifact-1" })).sourceDeleted,
    undefined
  );
});

test("with redaction on the cascade redacts the tenant's settled runs and artifacts and only those", async () => {
  process.env.DOCUMENT_DELETE_REDACTION = "on";

  const stores = createStores();

  await createRun(stores.agentRunStore, ALICE, { runId: "run-done" });
  await createRun(stores.agentRunStore, ALICE, { runId: "run-failed", status: "failed" });
  await createRun(stores.agentRunStore, ALICE, { runId: "run-active", status: "running" });
  await createRun(stores.agentRunStore, ALICE, { docId: "doc-y", runId: "run-other-doc" });
  await createRun(stores.agentRunStore, BOB, { runId: "run-bob" });
  await createArtifact(stores.workspaceArtifactStore, ALICE, { artifactId: "artifact-a" });
  await createArtifact(stores.workspaceArtifactStore, ALICE, { artifactId: "artifact-other", docId: "doc-y" });
  await createArtifact(stores.workspaceArtifactStore, BOB, { artifactId: "artifact-b" });

  const before = Object.fromEntries(
    ["run-done", "run-active", "run-other-doc"].map((runId) => [
      runId,
      structuredClone(stores.agentRunStore.get({ accessScope: ALICE, runId })),
    ])
  );
  const bobRunBefore = structuredClone(stores.agentRunStore.get({ accessScope: BOB, runId: "run-bob" }));
  const cascade = createDocumentDeletionCascade({ ...stores, logger: silentLogger, now: () => "2026-10-17T11:00:00.000Z" });
  const summary = await cascade.afterDocumentsDeleted({ accessScope: ALICE, docIds: ["doc-x"] });

  assert.deepEqual(summary.redaction.agentRuns, { conflicts: 0, redacted: 2, skippedActive: 1, unchanged: 0 });
  assert.deepEqual(summary.redaction.artifacts, { conflicts: 0, redacted: 1, unchanged: 0 });
  assert.equal(summary.redaction.feedback, null, "no feedback store was given");

  const run = stores.agentRunStore.get({ accessScope: ALICE, runId: "run-done" });
  const redactedCitation = { ...citation("doc-x"), excerpt: DELETED_SOURCE_TEXT_MARKER, sectionHeading: DELETED_SOURCE_TEXT_MARKER };

  assert.deepEqual(run.steps[0].output.citations, [redactedCitation]);
  assert.equal(run.steps[0].output.text, before["run-done"].steps[0].output.text, "the answer text stays");
  assert.deepEqual(run.result.__skillGraphCheckpoint.nodes[0].output.citations, [redactedCitation]);
  assert.equal(run.result.answer, before["run-done"].result.answer);
  assert.equal(run.revision, before["run-done"].revision + 1, "written through the revision CAS");
  assert.equal(run.updatedAt, before["run-done"].updatedAt, "the run keeps its place in the listing");
  assert.equal(run.status, "completed");
  assert.deepEqual(stores.agentRunStore.get({ accessScope: ALICE, runId: "run-active" }), before["run-active"]);
  assert.deepEqual(stores.agentRunStore.get({ accessScope: ALICE, runId: "run-other-doc" }), before["run-other-doc"]);
  assert.deepEqual(stores.agentRunStore.get({ accessScope: BOB, runId: "run-bob" }), bobRunBefore, "another tenant's run is untouched");

  const artifact = await stores.workspaceArtifactStore.getArtifact({ accessScope: ALICE, artifactId: "artifact-a" });

  assert.equal(artifact.sourceDeleted, true);
  assert.deepEqual(artifact.sourceDeletedDocIds, ["doc-x"]);
  assert.equal(artifact.citationManifest[0].excerpt, DELETED_SOURCE_TEXT_MARKER);
  assert.equal(artifact.citationManifest[0].docId, "doc-x");
  assert.equal(artifact.content.includes(EXCERPT), false, "the quoted passage left the body");
  assert.match(artifact.content, /Summary written by the model\./);
  assert.equal(JSON.stringify(artifact.payload).includes(EXCERPT), false);
  assert.equal(artifact.updatedAt, "2026-10-17T11:00:00.000Z");
  assert.deepEqual(
    {
      sourceDeleted: toWorkspaceArtifactSummary(artifact).sourceDeleted,
      sourceDeletedDocIds: toWorkspaceArtifactDetail(artifact).sourceDeletedDocIds,
    },
    { sourceDeleted: true, sourceDeletedDocIds: ["doc-x"] }
  );

  const untouched = await stores.workspaceArtifactStore.getArtifact({ accessScope: ALICE, artifactId: "artifact-other" });

  assert.equal(untouched.sourceDeleted, undefined);
  assert.equal("sourceDeleted" in toWorkspaceArtifactSummary(untouched), false, "unmarked artifacts project as before");
  assert.equal(
    (await stores.workspaceArtifactStore.getArtifact({ accessScope: BOB, artifactId: "artifact-b" })).sourceDeleted,
    undefined
  );

  // Running it again finds nothing left to do.
  const again = await cascade.afterDocumentsDeleted({ accessScope: ALICE, docIds: ["doc-x"] });

  assert.deepEqual(again.redaction.agentRuns, { conflicts: 0, redacted: 0, skippedActive: 1, unchanged: 2 });
  assert.deepEqual(again.redaction.artifacts, { conflicts: 0, redacted: 0, unchanged: 1 });

  // An unscoped delete (auth off) reaches every pair.
  const unscoped = await cascade.afterDocumentsDeleted({ docIds: ["doc-x"] });

  assert.equal(unscoped.redaction.agentRuns.redacted, 1, "Bob's run");
  assert.equal(unscoped.redaction.artifacts.redacted, 1, "Bob's artifact");
});

test("a run that changed under the redaction is read again and redacted on its new revision", async () => {
  process.env.DOCUMENT_DELETE_REDACTION = "on";

  const agentRunStore = createInMemoryAgentRunStore();

  await createRun(agentRunStore, ALICE, { runId: "run-1" });

  let interfered = false;
  const racingStore = {
    ...agentRunStore,
    get: (input) => agentRunStore.get(input),
    listRunsReferencingDocuments: (input) => agentRunStore.listRunsReferencingDocuments(input),
    update: (input) => {
      if (!interfered) {
        interfered = true;
        // Another writer bumps the revision first.
        const current = agentRunStore.get({ accessScope: ALICE, runId: "run-1" });

        agentRunStore.update({
          accessScope: ALICE,
          expectedRevision: current.revision,
          patch: { observations: [...current.observations, { note: "retry" }] },
          runId: "run-1",
        });
      }

      return agentRunStore.update(input);
    },
  };
  const cascade = createDocumentDeletionCascade({ agentRunStore: racingStore, logger: silentLogger });
  const summary = await cascade.afterDocumentsDeleted({ accessScope: ALICE, docIds: ["doc-x"] });
  const run = agentRunStore.get({ accessScope: ALICE, runId: "run-1" });

  assert.equal(summary.redaction.agentRuns.redacted, 1);
  assert.equal(run.revision, 2);
  assert.deepEqual(run.observations.at(-1), { note: "retry" }, "the other writer's change is kept");
  assert.equal(run.steps[0].output.citations[0].excerpt, DELETED_SOURCE_TEXT_MARKER);
});

test("a large clear is redacted in bounded batches whose counts add up, and its failure log names no ids past a few", async () => {
  process.env.DOCUMENT_DELETE_REDACTION = "on";

  const agentRunStore = createInMemoryAgentRunStore();
  const passes = [];
  const docIds = Array.from({ length: 150 }, (_, index) => `doc-${String(index).padStart(3, "0")}`);

  await createRun(agentRunStore, ALICE, { docId: "doc-007", runId: "run-early" });
  await createRun(agentRunStore, ALICE, { docId: "doc-120", runId: "run-late" });

  const errors = [];
  const cascade = createDocumentDeletionCascade({
    agentRunStore: {
      ...agentRunStore,
      get: (input) => agentRunStore.get(input),
      listRunsReferencingDocuments: (input) => {
        passes.push(input.needles.length);
        return agentRunStore.listRunsReferencingDocuments(input);
      },
      update: (input) => agentRunStore.update(input),
    },
    feedbackStore: {
      redactDocumentReferences: async () => {
        throw new Error("feedback down");
      },
    },
    logger: { error: (...args) => errors.push(args) },
  });
  const summary = await cascade.afterDocumentsDeleted({ accessScope: ALICE, docIds });

  assert.deepEqual(passes, [200, 100], "two needles per document, a hundred documents per pass");
  assert.deepEqual(summary.redaction.agentRuns, { conflicts: 0, redacted: 2, skippedActive: 0, unchanged: 0 });
  assert.deepEqual(summary.redaction.feedback, { failed: true });
  assert.equal("docIds" in errors[0][1], false, "a 150-document failure is logged by count");
});

test("one failing part is logged without document text and never stops the others or the delete", async () => {
  process.env.DOCUMENT_DELETE_REDACTION = "on";

  const errors = [];
  const stores = createStores();

  await createArtifact(stores.workspaceArtifactStore, ALICE, { artifactId: "artifact-a" });

  const cascade = createDocumentDeletionCascade({
    ...stores,
    agentRunStore: {
      listRunsReferencingDocuments: async () => {
        throw Object.assign(new Error(`database down while reading ${EXCERPT}`), { code: "08006" });
      },
    },
    ingestJobStore: {
      cancelDocumentJobs: async () => {
        throw new Error("jobs table missing");
      },
    },
    logger: { error: (...args) => errors.push(args) },
  });
  const summary = await cascade.afterDocumentsDeleted({ accessScope: ALICE, docIds: ["doc-x"] });

  assert.deepEqual(summary.ingestJobs, { failed: true });
  assert.deepEqual(summary.redaction.agentRuns, { failed: true });
  assert.equal(summary.redaction.artifacts.redacted, 1);
  assert.equal(errors.length, 2);
  assert.equal(JSON.stringify(errors).includes(EXCERPT), false, "no document text in the log");
  assert.deepEqual(errors[1][1], { code: "08006", docIds: ["doc-x"], name: "Error" });

  assert.equal(await runDocumentDeletionCascade(null, { docIds: ["doc-x"] }), null);
  assert.equal(
    await runDocumentDeletionCascade(
      {
        afterDocumentsDeleted: async () => {
          throw new Error("boom");
        },
      },
      { docIds: ["doc-x"] },
      { logger: silentLogger }
    ),
    null
  );
});

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const feedbackRecord = (scope, feedbackId, docId = "doc-x") => ({
  answerText: "Employees get 10 days.",
  citations: [{ chunkIndex: 0, docId, excerpt: EXCERPT, fileName: `${docId}.pdf`, pageNumber: 1 }],
  createdAt: "2026-10-17T09:00:00.000Z",
  feedbackId,
  feedbackType: "helpful",
  question: "What is the leave policy?",
  userId: scope.userId,
  workspaceId: scope.workspaceId,
});

test("the file feedback store rewrites only the scope's records that cite the document, keeping every other line", async () => {
  process.env.DOCUMENT_DELETE_REDACTION = "on";

  const directory = await mkdtemp(path.join(os.tmpdir(), "deletion-feedback-"));

  try {
    const store = createFileFeedbackStore({ directory });

    await store.recordFeedback(feedbackRecord(ALICE, "f-alice"));
    await store.recordFeedback(feedbackRecord(ALICE, "f-alice-other", "doc-y"));
    await store.recordFeedback(feedbackRecord(BOB, "f-bob"));

    const filePath = path.join(directory, "feedback.jsonl");

    await writeFile(filePath, `${await readFile(filePath, "utf8")}not json "docId":"doc-x"\n`, "utf8");

    const cascade = createDocumentDeletionCascade({ feedbackStore: store, logger: silentLogger });
    const summary = await cascade.afterDocumentsDeleted({ accessScope: ALICE, docIds: ["doc-x"] });

    assert.deepEqual(summary.redaction.feedback, { redacted: 1 });

    const lines = (await readFile(filePath, "utf8")).split("\n");
    const records = lines.slice(0, 3).map((line) => JSON.parse(line));

    assert.equal(records[0].citations[0].excerpt, DELETED_SOURCE_TEXT_MARKER);
    assert.equal(records[0].citations[0].docId, "doc-x");
    assert.equal(records[0].answerText, "Employees get 10 days.");
    assert.deepEqual(Object.keys(records[0]), Object.keys(feedbackRecord(ALICE, "f-alice")), "key order kept");
    assert.equal(records[1].citations[0].excerpt, EXCERPT);
    assert.equal(records[2].citations[0].excerpt, EXCERPT, "another tenant's record is untouched");
    assert.equal(lines[3], 'not json "docId":"doc-x"', "an unparsable line is kept as it was");
    assert.deepEqual(
      (await store.listFeedback({ accessScope: ALICE })).map((record) => record.feedbackId).sort(),
      ["f-alice", "f-alice-other"]
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the PostgreSQL feedback store redacts on the system path with an exact owner filter and writes the citations column only", async () => {
  const calls = [];
  const rows = [
    { citations: feedbackRecord(ALICE, "f-1").citations, id: "11" },
    { citations: feedbackRecord(ALICE, "f-2", "doc-y").citations, id: "12" },
  ];
  const store = createPostgresFeedbackStore({
    query: async (sql, values = []) => {
      calls.push({ context: getDatabaseTenantContext(), sql: sql.replace(/\s+/g, " ").trim(), values });

      return /^SELECT id, citations/.test(sql.trim()) ? { rows } : { rowCount: 1, rows: [] };
    },
    runMigrations: async () => ({ appliedMigrations: [] }),
    tableName: "rag_feedback",
  });
  const outcome = await runWithDatabaseTenant(ALICE, () =>
    store.redactDocumentReferences({
      accessScope: ALICE,
      needles: buildDocumentReferenceNeedles(["doc-x"]),
      redactCitations: (citations) => redactDocumentText(citations, ["doc-x"]),
    })
  );

  assert.deepEqual(outcome, { redacted: 1 });
  assert.deepEqual(
    calls.map((call) => call.context),
    ["system", "system"],
    "the tenant role may not update feedback; the system path does, filtered below"
  );
  assert.match(calls[0].sql, /WHERE id > \$1::bigint AND \(\$2::boolean = FALSE OR \(owner_user_id = \$3 AND workspace_id = \$4\)\)/);
  assert.deepEqual(calls[0].values.slice(0, 4), ["0", true, "alice", "ws-a"]);
  assert.equal(calls[1].sql, "UPDATE rag_feedback SET citations = $2::json WHERE id = $1::bigint");
  assert.equal(calls[1].values[0], "11");
  assert.equal(JSON.parse(calls[1].values[1])[0].excerpt, DELETED_SOURCE_TEXT_MARKER);
});

// ---------------------------------------------------------------------------
// The PostgreSQL run and artifact listings
// ---------------------------------------------------------------------------

test("the PostgreSQL run listing pages by primary key over the exact pair, or every pair when unscoped", async () => {
  const calls = [];
  const store = createPostgresAgentRunStore({
    query: async (sql, values = []) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      return {
        rows: [
          {
            goal: "g",
            result: {},
            revision: 3,
            run_id: "run-1",
            status: "completed",
            steps: [],
            user_id: "alice",
            workspace_id: "ws-a",
          },
        ],
      };
    },
    runMigrations: async () => ({ appliedMigrations: [] }),
  });
  const needles = buildDocumentReferenceNeedles(["doc-x"]);
  const page = await store.listRunsReferencingDocuments({ accessScope: ALICE, limit: 1, needles });

  assert.deepEqual(page.next, { runId: "run-1", userId: "alice", workspaceId: "ws-a" });
  assert.equal(page.runs[0].revision, 3);
  assert.deepEqual(page.runs[0].accessScope, { userId: "alice", workspaceId: "ws-a" });
  assert.match(calls[0].sql, /strpos\(steps::text, needle\.value\) > 0/);
  assert.match(calls[0].sql, /ORDER BY user_id, workspace_id, run_id LIMIT \$8/);
  assert.deepEqual(calls[0].values, [true, "alice", "ws-a", null, null, null, needles, 1]);

  await store.listRunsReferencingDocuments({ after: page.next, needles });
  assert.deepEqual(calls[1].values.slice(0, 6), [false, "", "", "alice", "ws-a", "run-1"]);
  assert.deepEqual(await store.listRunsReferencingDocuments({ needles: [] }), { next: null, runs: [] });
  assert.equal(calls.length, 2);
});

test("the PostgreSQL artifact listing and mark are scoped and compare-and-set on the redacted values", async () => {
  const calls = [];
  const store = createPostgresWorkspaceArtifactStore({
    query: async (sql, values = []) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      return { rows: [] };
    },
    runMigrations: async () => ({ appliedMigrations: [] }),
    tableName: "rag_workspace_artifacts",
  });

  await store.listArtifactsReferencingDocuments({
    accessScope: ALICE,
    docIds: ["doc-x"],
    needles: buildDocumentReferenceNeedles(["doc-x"]),
  });
  assert.match(calls[0].sql, /doc_ids \?\| \$7::text\[\]/);
  assert.deepEqual(calls[0].values.slice(0, 7), [true, "alice", "ws-a", null, null, null, ["doc-x"]]);

  assert.equal(
    await store.markArtifactSourceDeleted({
      accessScope: ALICE,
      artifactId: "artifact-1",
      citationManifest: [{ docId: "doc-x", excerpt: DELETED_SOURCE_TEXT_MARKER }],
      content: "body",
      deletedDocIds: ["doc-x"],
      payload: {},
      previous: { citationManifest: [{ docId: "doc-x", excerpt: EXCERPT }], content: `body ${EXCERPT}`, payload: {} },
      timestamp: "2026-10-17T11:00:00.000Z",
    }),
    null,
    "no row means the values moved: the caller reads again"
  );
  assert.match(calls[1].sql, /source_deleted = TRUE/);
  assert.match(calls[1].sql, /AND citation_manifest = \$9::jsonb AND content = \$10 AND payload = \$11::jsonb/);
  assert.deepEqual(calls[1].values.slice(0, 3), ["alice", "ws-a", "artifact-1"]);
});

// ---------------------------------------------------------------------------
// End to end through rag/index.js (local vector store, file registry)
// ---------------------------------------------------------------------------

test("deleteDocument and clearDocuments run the cascade once the document is gone, and only then", async () => {
  process.env.VECTOR_STORE_PROVIDER = "local";
  process.env.RAG_HYBRID_ENABLED = "false";
  process.env.RAG_LONG_MEMORY_ENABLED = "false";
  process.env.DOCUMENT_DELETE_REDACTION = "on";

  const originalDataDirectory = getRagDataDirectory();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "deletion-cascade-"));

  try {
    configureRagDataDirectory(path.join(tempRoot, "rag-data"));
    await resetDocumentRegistryStore();
    await resetDocumentRegistry();
    resetVectorStore();
    resetEmbeddingCache();
    configureDocumentRegistryStore(createFileDocumentRegistryStore());
    configureOpenAIProvider({
      completeText: async () => "unused",
      embedQuery: async () => [1, 0, 0],
      embedTexts: async (texts) => texts.map(() => [1, 0, 0]),
    });

    const filePath = path.join(tempRoot, "leave.pdf");

    await writeFile(filePath, "fixture", "utf8");

    const ingest = (docId, scope) =>
      ingestDocumentPages({
        docId,
        fileName: `${docId}.pdf`,
        filePath,
        ownerUserId: scope.userId,
        pages: [{ pageNumber: 1, text: EXCERPT }],
        workspaceId: scope.workspaceId,
      });

    await ingest("doc-x", ALICE);
    await ingest("doc-y", ALICE);

    const stores = createStores();
    const cascade = createDocumentDeletionCascade({ ...stores, logger: silentLogger });

    await createRun(stores.agentRunStore, ALICE, { runId: "run-1" });
    await enqueueFor(stores.ingestJobStore, ALICE, { jobId: "job-x", kind: "replace" });
    await enqueueFor(stores.ingestJobStore, ALICE, { docId: "doc-y", jobId: "job-y", kind: "replace" });

    // Bob cannot see doc-x: no delete, so no cascade.
    assert.equal(await deleteDocument("doc-x", { accessScope: BOB, cascade }), null);
    assert.equal((await stores.ingestJobStore.get("job-x", ALICE)).status, "queued");

    const deleted = await deleteDocument("doc-x", { accessScope: ALICE, cascade });

    assert.equal(deleted.docId, "doc-x");
    assert.equal(getDocument("doc-x", ALICE), null);
    assert.equal((await stores.ingestJobStore.get("job-x", ALICE)).canceledReason, "document_deleted");
    assert.equal(
      stores.agentRunStore.get({ accessScope: ALICE, runId: "run-1" }).steps[0].output.citations[0].excerpt,
      DELETED_SOURCE_TEXT_MARKER
    );

    // A second delete of the same document finds nothing and cascades nothing.
    assert.equal(await deleteDocument("doc-x", { accessScope: ALICE, cascade }), null);

    const cleared = await clearDocuments({ accessScope: ALICE, cascade, deleteFiles: false });

    assert.deepEqual(cleared.map((document) => document.docId), ["doc-y"]);
    assert.equal((await stores.ingestJobStore.get("job-y", ALICE)).canceledReason, "document_deleted");

    // Without a cascade the delete behaves as before.
    await ingest("doc-z", ALICE);
    assert.equal((await deleteDocument("doc-z", { accessScope: ALICE })).docId, "doc-z");
  } finally {
    await clearDocuments({ deleteFiles: false });
    resetOpenAIProvider();
    resetEmbeddingCache();
    resetVectorStore();
    await resetDocumentRegistryStore();
    configureRagDataDirectory(originalDataDirectory);
    await rm(tempRoot, { force: true, recursive: true });
  }
});
