import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp as createProductionApp } from "../app.js";
import { buildChatResponse } from "../app-services.js";
import { runIngestWorkerProcess } from "../ingest-worker.mjs";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { createIngestWorker } from "../rag/ingest-worker.js";

// HTTP contract of RAG_INGEST_MODE: sync answers 201 with the document as it
// always has; async validates the same way, answers 202 with a job, and
// GET /ingest-jobs/:jobId reports it to its own tenant only.

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const PDF_CONTENT = "%PDF-1.4 ingest route fixture";
const ALICE_HEADERS = { "x-user-id": "alice", "x-workspace-id": "ws-a" };
const BOB_HEADERS = { "x-user-id": "bob", "x-workspace-id": "ws-b" };

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const withIngestMode = async (mode, callback) => {
  const previous = process.env.RAG_INGEST_MODE;

  if (mode === undefined) {
    delete process.env.RAG_INGEST_MODE;
  } else {
    process.env.RAG_INGEST_MODE = mode;
  }

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.RAG_INGEST_MODE;
    } else {
      process.env.RAG_INGEST_MODE = previous;
    }
  }
};

// `sharedRegistry` says whether the registry behind the stub is PostgreSQL,
// which other processes write too (isDocumentRegistryShared).
const createStubRagService = ({ sharedRegistry = true } = {}) => {
  const documents = new Map();
  const ingested = [];
  const visibilityCalls = [];

  return {
    documents,
    ingested,
    visibilityCalls,
    service: {
      chat: async () => ({ citations: [], text: "stub" }),
      deleteDocument: async (docId) => {
        const document = documents.get(docId) ?? null;

        documents.delete(docId);
        return document;
      },
      getDocument: (docId, accessScope = {}) => {
        const document = documents.get(docId);

        return document &&
          (!accessScope.userId || document.ownerUserId === accessScope.userId)
          ? document
          : null;
      },
      ingestDocument: async ({ docId, filePath, fileName, ownerUserId, workspaceId }) => {
        const content = await readFile(filePath, "utf8");
        const document = {
          chunkCount: 1,
          docId,
          fileName,
          ownerUserId,
          pageCount: 1,
          workspaceId,
        };

        ingested.push({ content, docId, fileName, ownerUserId, workspaceId });
        documents.set(docId, document);
        return document;
      },
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      isDocumentRegistryShared: () => sharedRegistry,
      listDocuments: (accessScope = {}) =>
        [...documents.values()].filter(
          (document) => !accessScope.userId || document.ownerUserId === accessScope.userId
        ),
      loadDocumentsFromStore: async (docIds) => {
        visibilityCalls.push(["load", docIds]);
        return [];
      },
      refreshDocumentRegistry: async () => {
        visibilityCalls.push(["refresh"]);
        return [];
      },
      // The worker asks the store, not the map, whether a retried job's
      // document was already committed.
      resyncDocument: async (docId) => documents.get(docId) ?? null,
    },
  };
};

const startApp = async ({ ingestJobStore, ragService }) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ingest-routes-"));
  const uploadsDirectory = path.join(tempRoot, "uploads");
  const app = await createProductionApp({
    chatMcp: async () => ({ text: "web" }),
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService: okHealthService,
    ingestJobStore,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService,
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory,
  });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    app,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(tempRoot, { force: true, recursive: true });
    },
    uploadsDirectory,
  };
};

const postDirectUpload = (baseUrl, { content = PDF_CONTENT, headers = ALICE_HEADERS } = {}) => {
  const form = new FormData();

  form.append("file", new Blob([content], { type: "application/pdf" }), "notes.pdf");

  return fetch(`${baseUrl}/upload`, { body: form, headers, method: "POST" });
};

const getJob = (baseUrl, jobId, headers = ALICE_HEADERS) =>
  fetch(`${baseUrl}/ingest-jobs/${encodeURIComponent(jobId)}`, { headers });

test("sync mode keeps answering 201 with the ingested document and queues nothing", async () => {
  await withIngestMode(undefined, async () => {
    const rag = createStubRagService({ sharedRegistry: false });
    const ingestJobStore = createInMemoryIngestJobStore();
    const server = await startApp({ ingestJobStore, ragService: rag.service });

    try {
      const response = await postDirectUpload(server.baseUrl);

      assert.equal(response.status, 201);
      const document = await response.json();

      assert.equal(document.fileName, "notes.pdf");
      assert.equal(document.ownerUserId, "alice");
      assert.equal(rag.ingested.length, 1);
      assert.equal(await ingestJobStore.claim({ leaseMs: 1000, workerId: "w" }), null);

      assert.equal((await fetch(`${server.baseUrl}/documents`, { headers: ALICE_HEADERS })).status, 200);
      assert.deepEqual(
        rag.visibilityCalls,
        [],
        "a registry only this process writes (file-backed, in memory) is never re-read"
      );
    } finally {
      await server.close();
    }
  });
});

test("sync mode on a PostgreSQL registry lists and serves documents another instance uploaded", async () => {
  await withIngestMode(undefined, async () => {
    // Two API instances in sync mode over one registry table: instance A's
    // upload lands in `table`, which instance B's map has never seen.
    const table = new Map();
    const instanceA = createStubRagService();
    const instanceB = createStubRagService();

    instanceA.service.ingestDocument = async ({ docId, fileName, ownerUserId, workspaceId }) => {
      const document = { docId, fileName, ownerUserId, workspaceId };

      table.set(docId, document);
      instanceA.documents.set(docId, document);
      return document;
    };
    // B's reads of the shared table: a named read adds and drops the named
    // documents, a refresh mirrors the table.
    instanceB.service.loadDocumentsFromStore = async (docIds) => {
      instanceB.visibilityCalls.push(["load", docIds]);

      for (const docId of docIds) {
        if (table.has(docId)) {
          instanceB.documents.set(docId, table.get(docId));
        } else {
          instanceB.documents.delete(docId);
        }
      }

      return [];
    };
    instanceB.service.refreshDocumentRegistry = async (accessScope = {}) => {
      instanceB.visibilityCalls.push(["refresh", accessScope]);

      for (const docId of [...instanceB.documents.keys()]) {
        if (!table.has(docId)) {
          instanceB.documents.delete(docId);
        }
      }

      for (const [docId, document] of table) {
        instanceB.documents.set(docId, document);
      }

      return [];
    };

    const serverA = await startApp({
      ingestJobStore: createInMemoryIngestJobStore(),
      ragService: instanceA.service,
    });
    const serverB = await startApp({
      ingestJobStore: createInMemoryIngestJobStore(),
      ragService: instanceB.service,
    });

    try {
      const uploaded = await postDirectUpload(serverA.baseUrl);

      assert.equal(uploaded.status, 201);
      const { docId } = await uploaded.json();

      // A chat about it on B starts from the tenant's rows as the store has
      // them, so the document is found there, not a 404.
      const chatOnB = () =>
        buildChatResponse({
          accessScope: { userId: "alice", workspaceId: "ws-a" },
          docIds: [docId],
          question: "q",
          ragService: {
            ...instanceB.service,
            getDocument: (id) => (instanceB.documents.has(id) ? instanceB.documents.get(id) : null),
          },
        }).catch((error) => error);
      const chat = await chatOnB();

      assert.equal(chat?.status, 200, "the document uploaded on A is found on B, not a 404");
      assert.deepEqual(instanceB.visibilityCalls, [
        ["refresh", { userId: "alice", workspaceId: "ws-a" }],
      ]);

      // A deletes it. B's map still holds it (a hit, not a miss), yet a chat
      // there answers 404 and so does a DELETE routed to B.
      table.delete(docId);
      instanceA.documents.delete(docId);
      assert.ok(instanceB.documents.has(docId));

      const chatAfterDelete = await chatOnB();

      assert.equal(chatAfterDelete?.status, 404, "a document deleted on A is gone on B");
      assert.match(chatAfterDelete.message, /Upload the PDF again/);

      instanceB.documents.set(docId, { docId, fileName: "notes.pdf", ownerUserId: "alice", workspaceId: "ws-a" });

      const deleteOnB = await fetch(`${serverB.baseUrl}/documents/${encodeURIComponent(docId)}`, {
        headers: ALICE_HEADERS,
        method: "DELETE",
      });

      assert.equal(deleteOnB.status, 404, "deleting what A already deleted is a 404 on B, not {deleted: true}");
      assert.deepEqual(instanceB.visibilityCalls.at(-1), ["load", [docId]]);

      table.set(docId, { docId, fileName: "notes.pdf", ownerUserId: "alice", workspaceId: "ws-a" });

      instanceB.documents.clear();
      instanceB.visibilityCalls.length = 0;

      const listed = await fetch(`${serverB.baseUrl}/documents`, { headers: ALICE_HEADERS });

      assert.deepEqual(
        (await listed.json()).map((document) => document.docId),
        [docId],
        "B lists A's upload"
      );
      assert.deepEqual(
        instanceB.visibilityCalls.map(([kind, scope]) => [kind, scope.userId, scope.workspaceId]),
        [["refresh", "alice", "ws-a"]],
        "the refresh reads the requesting tenant only"
      );
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });
});

test("async mode answers 202 with a queued job and reports it to its own tenant only", async () => {
  await withIngestMode("async", async () => {
    const rag = createStubRagService();
    const ingestJobStore = createInMemoryIngestJobStore();
    const server = await startApp({ ingestJobStore, ragService: rag.service });

    try {
      const response = await postDirectUpload(server.baseUrl);

      assert.equal(response.status, 202);
      const queued = await response.json();

      assert.deepEqual(Object.keys(queued).sort(), ["docId", "fileName", "jobId", "status"]);
      assert.equal(queued.status, "queued");
      assert.equal(queued.fileName, "notes.pdf");
      assert.equal(rag.ingested.length, 0, "nothing is parsed inside the request");
      assert.deepEqual(
        (await readdir(server.uploadsDirectory)).filter((name) => name.endsWith(".pdf")),
        [],
        "the multer temp file is removed once the bytes are in the job"
      );

      let status = await getJob(server.baseUrl, queued.jobId);

      assert.equal(status.status, 200);
      let job = await status.json();

      assert.equal(job.jobId, queued.jobId);
      assert.equal(job.docId, queued.docId);
      assert.equal(job.status, "queued");
      assert.equal(job.attemptCount, 0);
      assert.equal(job.error, null);
      assert.ok(job.createdAt);
      assert.equal(job.startedAt, null);
      assert.equal(job.finishedAt, null);
      assert.equal("fileBytes" in job, false);

      status = await getJob(server.baseUrl, queued.jobId, BOB_HEADERS);
      assert.equal(status.status, 404, "another tenant's job does not exist for them");
      assert.equal((await getJob(server.baseUrl, "no-such-job")).status, 404);
      assert.equal((await getJob(server.baseUrl, " ")).status, 400);

      const worker = createIngestWorker({
        logger: { error() {}, log() {}, warn() {} },
        ragService: server.app.locals.services.ragService,
        store: server.app.locals.services.ingestJobStore,
        tempDirectory: server.uploadsDirectory,
        workerId: "route-test",
      });

      assert.equal((await worker.runOnce()).outcome, "succeeded");
      assert.deepEqual(rag.ingested, [
        {
          content: PDF_CONTENT,
          docId: queued.docId,
          fileName: "notes.pdf",
          ownerUserId: "alice",
          workspaceId: "ws-a",
        },
      ]);

      status = await getJob(server.baseUrl, queued.jobId);
      job = await status.json();
      assert.equal(job.status, "succeeded");
      assert.equal(job.attemptCount, 1);
      assert.ok(job.finishedAt);
      assert.equal(job.document.docId, queued.docId);
      assert.deepEqual(rag.visibilityCalls.at(-1), ["load", [queued.docId]]);

      const documentsResponse = await fetch(`${server.baseUrl}/documents`, { headers: ALICE_HEADERS });

      assert.deepEqual(
        (await documentsResponse.json()).map((document) => document.docId),
        [queued.docId]
      );
      assert.deepEqual(rag.visibilityCalls.at(-1), ["refresh"]);

      const deleteResponse = await fetch(`${server.baseUrl}/documents/${queued.docId}`, {
        headers: ALICE_HEADERS,
        method: "DELETE",
      });

      assert.equal(deleteResponse.status, 200);
      assert.deepEqual(rag.visibilityCalls.at(-1), ["load", [queued.docId]]);
    } finally {
      await server.close();
    }
  });
});

test("async mode answers 429 once the tenant's pending uploads reach the cap", async () => {
  await withIngestMode("async", async () => {
    const rag = createStubRagService();
    const ingestJobStore = createInMemoryIngestJobStore({
      getPendingLimits: () => ({ maxPendingBytes: 0, maxPendingJobs: 1 }),
    });
    const server = await startApp({ ingestJobStore, ragService: rag.service });

    try {
      assert.equal((await postDirectUpload(server.baseUrl)).status, 202);

      const refused = await postDirectUpload(server.baseUrl);

      assert.equal(refused.status, 429);
      assert.match((await refused.json()).error, /still waiting to be indexed/);
      assert.deepEqual(
        (await readdir(server.uploadsDirectory)).filter((name) => name.endsWith(".pdf")),
        [],
        "the refused upload's temp file is removed"
      );
      assert.equal(
        (await postDirectUpload(server.baseUrl, { headers: BOB_HEADERS })).status,
        202,
        "another tenant is not held back"
      );
    } finally {
      await server.close();
    }
  });
});

test("async mode still rejects a non-PDF before queueing it", async () => {
  await withIngestMode("async", async () => {
    const rag = createStubRagService();
    const ingestJobStore = createInMemoryIngestJobStore();
    const server = await startApp({ ingestJobStore, ragService: rag.service });

    try {
      const response = await postDirectUpload(server.baseUrl, { content: "not a pdf" });

      assert.equal(response.status, 400);
      assert.equal(await ingestJobStore.claim({ leaseMs: 1000, workerId: "w" }), null);
    } finally {
      await server.close();
    }
  });
});

test("async mode queues a completed chunked upload under its session id and clears the session", async () => {
  await withIngestMode("async", async () => {
    const rag = createStubRagService();
    const ingestJobStore = createInMemoryIngestJobStore();
    const server = await startApp({ ingestJobStore, ragService: rag.service });
    const jsonHeaders = { ...ALICE_HEADERS, "Content-Type": "application/json" };

    try {
      let response = await fetch(`${server.baseUrl}/upload/init`, {
        body: JSON.stringify({
          chunkSize: 1024,
          fileId: "chunked-file",
          fileName: "chunked.pdf",
          fileSize: PDF_CONTENT.length,
          lastModified: 0,
          totalChunks: 1,
        }),
        headers: jsonHeaders,
        method: "POST",
      });

      assert.equal(response.status, 201);
      const session = await response.json();
      const chunk = new FormData();

      chunk.append("fileId", "chunked-file");
      chunk.append("chunkIndex", "0");
      chunk.append("totalChunks", "1");
      chunk.append("chunk", new Blob([PDF_CONTENT]), "chunked.pdf.part-0");
      response = await fetch(`${server.baseUrl}/upload/chunk`, {
        body: chunk,
        headers: ALICE_HEADERS,
        method: "POST",
      });
      assert.equal(response.status, 201);

      response = await fetch(`${server.baseUrl}/upload/complete`, {
        body: JSON.stringify({ fileId: "chunked-file" }),
        headers: jsonHeaders,
        method: "POST",
      });

      assert.equal(response.status, 202);
      const queued = await response.json();

      assert.equal(queued.docId, session.sessionId);
      assert.equal(queued.fileName, "chunked.pdf");
      assert.equal(queued.status, "queued");

      response = await fetch(`${server.baseUrl}/upload/status?fileId=chunked-file`, {
        headers: ALICE_HEADERS,
      });
      assert.equal(response.status, 404, "the upload session is cleared once the job holds the bytes");

      const claimed = await ingestJobStore.claim({ leaseMs: 1000, workerId: "w" });

      assert.equal(claimed.docId, session.sessionId);
      assert.equal(claimed.ownerUserId, "alice");
      assert.equal(claimed.fileBytes.toString("utf8"), PDF_CONTENT);
    } finally {
      await server.close();
    }
  });
});

test("chat reads documents registered by another process before answering 404", async () => {
  for (const mode of ["async", undefined]) {
    await withIngestMode(mode, async () => {
      const loaded = [];
      const ragService = {
        getDocument: () => null,
        isDocumentRegistryShared: () => true,
        loadDocumentsFromStore: async (docIds) => {
          loaded.push(docIds);
          return [];
        },
      };

      await assert.rejects(
        () =>
          buildChatResponse({
            accessScope: {},
            docIds: ["doc-a", "doc-b"],
            question: "q",
            ragService,
          }),
        (error) => error.status === 404 && /doc-a, doc-b/.test(error.message)
      );
      assert.deepEqual(loaded, [["doc-a", "doc-b"]], `ingest mode ${mode ?? "sync"}`);
    });
  }

  // A registry only this process writes has nothing to read back.
  await withIngestMode("async", async () => {
    const loaded = [];

    await assert.rejects(() =>
      buildChatResponse({
        accessScope: {},
        docIds: ["doc-a"],
        question: "q",
        ragService: {
          getDocument: () => null,
          isDocumentRegistryShared: () => false,
          loadDocumentsFromStore: async (docIds) => loaded.push(docIds),
        },
      })
    );
    assert.deepEqual(loaded, []);
  });
});

test("the dedicated worker process refuses to start without PostgreSQL", async () => {
  const errors = [];
  const previous = process.env.POSTGRES_DATABASE_URL;

  delete process.env.POSTGRES_DATABASE_URL;

  try {
    const started = await runIngestWorkerProcess({
      environment: {},
      logger: { error: (message) => errors.push(message), log() {} },
    });

    assert.equal(started, null);
    assert.match(errors[0], /needs PostgreSQL/);

    process.env.POSTGRES_DATABASE_URL = "postgresql://unused@127.0.0.1:1/unused";
    errors.length = 0;
    assert.equal(
      await runIngestWorkerProcess({
        environment: { DOCCOMPARE_STANDALONE: "1" },
        logger: { error: (message) => errors.push(message), log() {} },
      }),
      null,
      "the standalone queue lives in the API process"
    );
    assert.match(errors[0], /needs PostgreSQL/);
  } finally {
    if (previous === undefined) {
      delete process.env.POSTGRES_DATABASE_URL;
    } else {
      process.env.POSTGRES_DATABASE_URL = previous;
    }
  }
});

test("the dedicated worker process refuses the per-process local vector index", async () => {
  const errors = [];
  const previous = {
    POSTGRES_DATABASE_URL: process.env.POSTGRES_DATABASE_URL,
    VECTOR_STORE_PROVIDER: process.env.VECTOR_STORE_PROVIDER,
  };

  process.env.POSTGRES_DATABASE_URL = "postgresql://unused@127.0.0.1:1/unused";
  process.env.VECTOR_STORE_PROVIDER = "local";

  try {
    const started = await runIngestWorkerProcess({
      createStore: () => {
        throw new Error("the store must not be created");
      },
      environment: {},
      logger: { error: (message) => errors.push(message), log() {} },
    });

    assert.equal(started, null);
    assert.match(errors[0], /VECTOR_STORE_PROVIDER=local keeps the index in each process/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("the dedicated worker process drains the queue and stops on SIGTERM", async () => {
  const previous = process.env.POSTGRES_DATABASE_URL;
  const previousProvider = process.env.VECTOR_STORE_PROVIDER;
  // Never connected to: the store is injected and no pool is ever opened.
  process.env.POSTGRES_DATABASE_URL = "postgresql://unused@127.0.0.1:1/unused";
  // A dedicated worker needs a shared index; the stub rag service never uses it.
  process.env.VECTOR_STORE_PROVIDER = "pgvector";

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ingest-worker-process-"));
  const store = createInMemoryIngestJobStore();
  const rag = createStubRagService();
  const signals = new EventEmitter();
  const exits = [];
  let initialized = false;

  try {
    const job = await store.enqueue({
      docId: "doc-worker",
      fileBytes: Buffer.from(PDF_CONTENT),
      fileName: "worker.pdf",
      ownerUserId: "alice",
      workspaceId: "ws-a",
    });
    const started = await runIngestWorkerProcess({
      createStore: () => ({
        ...store,
        initialize: async () => {
          initialized = true;
        },
      }),
      environment: {},
      exit: (code) => exits.push(code),
      logger: { error() {}, log() {}, warn() {} },
      ragService: rag.service,
      signals,
      tempDirectory,
    });

    assert.equal(initialized, true);
    assert.equal(started.worker.running, true);
    assert.equal(store.enqueueNotificationStatus().subscribers, 1, "woken on enqueue");

    const deadline = Date.now() + 5000;

    while ((await store.get(job.jobId)).status !== "succeeded" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal((await store.get(job.jobId)).status, "succeeded");
    assert.equal(rag.ingested[0].docId, "doc-worker");

    signals.emit("SIGTERM");
    await started.shutdown("SIGTERM");
    assert.deepEqual(exits, [0], "one shutdown however many times it is asked for");
    assert.equal(started.worker.running, false);
    assert.equal(
      store.enqueueNotificationStatus().subscribers,
      0,
      "shutdown stops listening (with PostgreSQL: closes the LISTEN session) before the pool"
    );
  } finally {
    if (previous === undefined) {
      delete process.env.POSTGRES_DATABASE_URL;
    } else {
      process.env.POSTGRES_DATABASE_URL = previous;
    }

    process.env.VECTOR_STORE_PROVIDER = previousProvider;
    await rm(tempDirectory, { force: true, recursive: true });
  }
});
