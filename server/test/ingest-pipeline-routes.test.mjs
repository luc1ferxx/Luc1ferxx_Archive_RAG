import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp as createProductionApp } from "../app.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import { createIngestWorker } from "../rag/ingest-worker.js";

// HTTP contract of the staged pipeline's additions: a same-tenant duplicate
// upload (sync 200 with the stored document, async 202 resolved to it), PUT
// /documents/:docId in both modes, and the owner-scoped dead-letter admin
// routes. The upload and job contract itself is ingest-jobs-routes.test.mjs.

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const PDF_CONTENT = "%PDF-1.4 staged route fixture";
const ALICE_HEADERS = { "x-user-id": "alice", "x-workspace-id": "ws-a" };
const BOB_HEADERS = { "x-user-id": "bob", "x-workspace-id": "ws-b" };
const silentLogger = { error() {}, log() {}, warn() {} };
const sha256 = (text) => createHash("sha256").update(Buffer.from(text)).digest("hex");

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

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

// A ragService over a map that behaves like the real one where these routes
// look: it resolves a same-tenant duplicate when asked to deduplicate, and
// replaces a document's content under its docId.
const createStubRagService = () => {
  const documents = new Map();
  const calls = [];
  const visible = (document, scope = {}) =>
    document && (!scope.userId || document.ownerUserId === scope.userId) ? document : null;

  return {
    calls,
    documents,
    service: {
      chat: async () => ({ citations: [], text: "stub" }),
      getDocument: (docId, scope = {}) => visible(documents.get(docId), scope),
      ingestDocument: async ({ contentSha256, deduplicate, docId, fileName, filePath, ownerUserId, workspaceId }) => {
        calls.push({ contentSha256, deduplicate, docId, kind: "create" });

        const existing = [...documents.values()].find(
          (document) =>
            document.contentSha256 === contentSha256 &&
            document.ownerUserId === ownerUserId &&
            document.workspaceId === workspaceId
        );

        if (deduplicate && existing) {
          return { ...existing, duplicate: true };
        }

        const document = {
          content: await readFile(filePath, "utf8"),
          contentSha256,
          docId,
          fileName,
          ownerUserId,
          version: 1,
          workspaceId,
        };

        documents.set(docId, document);
        return document;
      },
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      isDocumentRegistryShared: () => false,
      listDocuments: (scope = {}) => [...documents.values()].filter((document) => visible(document, scope)),
      loadDocumentsFromStore: async () => [],
      refreshDocumentRegistry: async () => [],
      replaceDocument: async ({ docId, fileName, filePath, requestedAt }) => {
        calls.push({ docId, kind: "replace", requestedAt });

        const current = documents.get(docId);
        const content = await readFile(filePath, "utf8");

        // A newer replacement was requested first: this one's bytes are dropped.
        if (content.includes("superseded")) {
          return { ...current, superseded: true };
        }

        const document = {
          ...current,
          content: await readFile(filePath, "utf8"),
          fileName,
          version: current.version + 1,
        };

        documents.set(docId, document);
        return document;
      },
      resyncDocument: async (docId) => documents.get(docId) ?? null,
    },
  };
};

const startApp = async ({ ingestJobStore, ragService }) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ingest-pipeline-routes-"));
  const app = await createProductionApp({
    chatMcp: async () => ({ text: "web" }),
    executionPlannerAdapter: deterministicPlannerAdapter,
    healthService: okHealthService,
    ingestJobStore,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ragService,
    uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
  });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    app,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempRoot, { force: true, recursive: true });
    },
    tempRoot,
  };
};

const sendPdf = (url, { content = PDF_CONTENT, headers = ALICE_HEADERS, method = "POST", fields = {} } = {}) => {
  const form = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }

  form.append("file", new Blob([content], { type: "application/pdf" }), "notes.pdf");
  return fetch(url, { body: form, headers, method });
};

test("sync mode answers a same-tenant duplicate upload with 200 and the stored document", async () => {
  await withEnv({ RAG_INGEST_DEDUP: undefined, RAG_INGEST_MODE: undefined }, async () => {
    const rag = createStubRagService();
    const server = await startApp({ ingestJobStore: createInMemoryIngestJobStore(), ragService: rag.service });

    try {
      const first = await sendPdf(`${server.baseUrl}/upload`);

      assert.equal(first.status, 201);

      const created = await first.json();
      const again = await sendPdf(`${server.baseUrl}/upload`);

      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { ...created, duplicate: true });
      assert.equal((await sendPdf(`${server.baseUrl}/upload`, { headers: BOB_HEADERS })).status, 201);
      assert.deepEqual(
        rag.calls.map((call) => [call.contentSha256, call.deduplicate]),
        [
          [sha256(PDF_CONTENT), true],
          [sha256(PDF_CONTENT), true],
          [sha256(PDF_CONTENT), true],
        ],
        "the route hashes the bytes and asks for deduplication"
      );
    } finally {
      await server.close();
    }
  });

  await withEnv({ RAG_INGEST_DEDUP: "false", RAG_INGEST_MODE: undefined }, async () => {
    const rag = createStubRagService();
    const server = await startApp({ ingestJobStore: createInMemoryIngestJobStore(), ragService: rag.service });

    try {
      assert.equal((await sendPdf(`${server.baseUrl}/upload`)).status, 201);
      assert.equal((await sendPdf(`${server.baseUrl}/upload`)).status, 201, "RAG_INGEST_DEDUP=false ingests every upload");
      assert.equal(rag.documents.size, 2);
    } finally {
      await server.close();
    }
  });
});

test("async mode answers a same-tenant duplicate with 202 and a job already resolved to the stored document", async () => {
  await withEnv({ RAG_INGEST_DEDUP: undefined, RAG_INGEST_MODE: "async" }, async () => {
    const rag = createStubRagService();
    const ingestJobStore = createInMemoryIngestJobStore({
      findDuplicateDocument: async ({ contentSha256, ownerUserId, workspaceId }) => {
        const existing = [...rag.documents.values()].find(
          (document) =>
            document.contentSha256 === contentSha256 &&
            document.ownerUserId === ownerUserId &&
            document.workspaceId === workspaceId
        );

        return existing ? { docId: existing.docId, documentVersion: existing.version } : null;
      },
    });
    const server = await startApp({ ingestJobStore, ragService: rag.service });

    try {
      const firstResponse = await sendPdf(`${server.baseUrl}/upload`);
      const first = await firstResponse.json();

      assert.equal(firstResponse.status, 202);
      assert.deepEqual(Object.keys(first).sort(), ["docId", "fileName", "jobId", "status"]);

      const worker = createIngestWorker({
        logger: silentLogger,
        ragService: server.app.locals.services.ragService,
        store: ingestJobStore,
        tempDirectory: server.tempRoot,
        workerId: "routes",
      });

      assert.equal((await worker.runOnce()).outcome, "succeeded");

      const duplicateResponse = await sendPdf(`${server.baseUrl}/upload`);
      const duplicate = await duplicateResponse.json();

      assert.equal(duplicateResponse.status, 202);
      assert.equal(duplicate.status, "succeeded");
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.docId, first.docId, "the job resolves to the stored document");

      const job = await (
        await fetch(`${server.baseUrl}/ingest-jobs/${duplicate.jobId}`, { headers: ALICE_HEADERS })
      ).json();

      assert.equal(job.status, "succeeded");
      assert.equal(job.docId, first.docId);
      assert.equal(job.duplicate, true);
      assert.equal(job.document.docId, first.docId);
      assert.equal(await worker.runOnce(), null, "nothing was queued");

      const bobResponse = await sendPdf(`${server.baseUrl}/upload`, { headers: BOB_HEADERS });

      assert.equal((await bobResponse.json()).status, "queued", "another tenant's identical bytes are its own upload");
    } finally {
      await server.close();
    }
  });
});

test("PUT /documents/:docId replaces a document under its docId in sync mode and queues a replace job in async mode", async () => {
  const rag = createStubRagService();
  const ingestJobStore = createInMemoryIngestJobStore();
  const server = await startApp({ ingestJobStore, ragService: rag.service });

  try {
    await withEnv({ RAG_INGEST_MODE: undefined }, async () => {
      const created = await (await sendPdf(`${server.baseUrl}/upload`)).json();
      const replacedResponse = await sendPdf(`${server.baseUrl}/documents/${created.docId}`, {
        content: "%PDF-1.4 the second version",
        method: "PUT",
      });
      const replaced = await replacedResponse.json();

      assert.equal(replacedResponse.status, 200);
      assert.equal(replaced.docId, created.docId);
      assert.equal(replaced.version, 2);
      assert.equal(rag.documents.get(created.docId).content, "%PDF-1.4 the second version");
      assert.equal(
        rag.calls.at(-1).requestedAt,
        undefined,
        "no request time from this host's clock: the registry orders by the database's"
      );

      // A replacement a newer one overtook says so, with a 409.
      const supersededResponse = await sendPdf(`${server.baseUrl}/documents/${created.docId}`, {
        content: "%PDF-1.4 superseded bytes",
        method: "PUT",
      });

      assert.equal(supersededResponse.status, 409);
      assert.equal((await supersededResponse.json()).superseded, true);
      assert.equal(rag.documents.get(created.docId).content, "%PDF-1.4 the second version");

      // Same validation and tenant scope as an upload.
      assert.equal(
        (await sendPdf(`${server.baseUrl}/documents/${created.docId}`, { headers: BOB_HEADERS, method: "PUT" })).status,
        404
      );
      assert.equal((await sendPdf(`${server.baseUrl}/documents/doc-missing`, { method: "PUT" })).status, 404);
      assert.equal(
        (await sendPdf(`${server.baseUrl}/documents/${created.docId}`, { content: "not a pdf", method: "PUT" })).status,
        400
      );
      assert.equal(
        (
          await sendPdf(`${server.baseUrl}/documents/${created.docId}`, {
            fields: { extra: "field" },
            method: "PUT",
          })
        ).status,
        400
      );

      const noFile = await fetch(`${server.baseUrl}/documents/${created.docId}`, {
        body: new FormData(),
        headers: ALICE_HEADERS,
        method: "PUT",
      });

      assert.equal(noFile.status, 400);
      assert.equal(rag.documents.get(created.docId).version, 2, "no rejected request changed it");
    });

    await withEnv({ RAG_INGEST_MODE: "async" }, async () => {
      const [docId] = rag.documents.keys();
      const response = await sendPdf(`${server.baseUrl}/documents/${docId}`, {
        content: "%PDF-1.4 the third version",
        method: "PUT",
      });
      const queued = await response.json();

      assert.equal(response.status, 202);
      assert.equal(queued.kind, "replace");
      assert.equal(queued.docId, docId);
      assert.equal(queued.status, "queued");

      const claimed = await ingestJobStore.claim({ leaseMs: 1000, workerId: "w" });

      assert.equal(claimed.kind, "replace");
      assert.equal(claimed.docId, docId);
      assert.equal(claimed.deduplicate, false, "a replacement is never resolved to another document");
      assert.equal(claimed.fileBytes.toString("utf8"), "%PDF-1.4 the third version");
    });
  } finally {
    await server.close();
  }
});

test("PUT /documents/:docId answers 409 on a provider that cannot swap a document's chunks atomically, in either mode", async () => {
  const rag = createStubRagService();
  const ingestJobStore = createInMemoryIngestJobStore();
  const service = { ...rag.service, supportsDocumentReplacement: () => false };
  const server = await startApp({ ingestJobStore, ragService: service });

  try {
    for (const mode of [undefined, "async"]) {
      await withEnv({ RAG_INGEST_MODE: mode }, async () => {
        const created = await (await sendPdf(`${server.baseUrl}/upload`, { content: `%PDF-1.4 ${mode ?? "sync"}` })).json();
        const response = await sendPdf(`${server.baseUrl}/documents/${created.docId}`, {
          content: "%PDF-1.4 new bytes",
          method: "PUT",
        });

        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /needs VECTOR_STORE_PROVIDER=pgvector/);
      });
    }

    assert.ok(!rag.calls.some((call) => call.kind === "replace"), "nothing was replaced");
    assert.equal((await ingestJobStore.countByStatus()).queued, 1, "only the async upload was queued, no replacement");
  } finally {
    await server.close();
  }
});

test("the dead-letter admin routes list and requeue the requester's own dead-letter jobs only", async () => {
  await withEnv({ RAG_INGEST_MODE: "async" }, async () => {
    const rag = createStubRagService();
    const ingestJobStore = createInMemoryIngestJobStore();
    const server = await startApp({ ingestJobStore, ragService: rag.service });
    const failing = {
      ...rag.service,
      ingestDocument: async () => {
        throw Object.assign(new Error("embedding service unavailable"), { status: 503 });
      },
    };

    try {
      const queued = await (await sendPdf(`${server.baseUrl}/upload`)).json();
      const worker = createIngestWorker({
        logger: silentLogger,
        ragService: failing,
        retryDelayMs: () => 0,
        store: ingestJobStore,
        tempDirectory: server.tempRoot,
        workerId: "failing",
      });

      assert.equal((await worker.runOnce()).outcome, "queued");
      assert.equal((await worker.runOnce()).outcome, "queued");
      assert.equal((await worker.runOnce()).outcome, "dead_letter");

      let response = await fetch(`${server.baseUrl}/admin/ingest-jobs/dead-letter`, { headers: ALICE_HEADERS });

      assert.equal(response.status, 200);

      const listing = await response.json();

      assert.equal(listing.count, 1);
      assert.equal(listing.jobs[0].jobId, queued.jobId);
      assert.equal(listing.jobs[0].status, "dead_letter");
      assert.equal(listing.jobs[0].deadLetter.stage, "parse");
      assert.match(listing.jobs[0].deadLetter.reason, /attempt 3 of 3 \(status 503\)/);
      assert.equal("fileBytes" in listing.jobs[0], false);

      response = await fetch(`${server.baseUrl}/admin/ingest-jobs/dead-letter`, { headers: BOB_HEADERS });
      assert.deepEqual((await response.json()).jobs, [], "another tenant's dead letters are not listed");
      assert.equal((await fetch(`${server.baseUrl}/admin/ingest-jobs/dead-letter?limit=0`, { headers: ALICE_HEADERS })).status, 400);

      // The client polling the job saw a terminal failure all along.
      const polled = await (await fetch(`${server.baseUrl}/ingest-jobs/${queued.jobId}`, { headers: ALICE_HEADERS })).json();

      assert.equal(polled.status, "failed");
      assert.equal(polled.deadLetter.stage, "parse");

      response = await fetch(`${server.baseUrl}/admin/ingest-jobs/${queued.jobId}/requeue`, {
        headers: BOB_HEADERS,
        method: "POST",
      });
      assert.equal(response.status, 404, "bob cannot requeue alice's job");

      response = await fetch(`${server.baseUrl}/admin/ingest-jobs/${queued.jobId}/requeue`, {
        headers: ALICE_HEADERS,
        method: "POST",
      });
      assert.equal(response.status, 200);

      const requeued = await response.json();

      assert.equal(requeued.requeued, true);
      assert.equal(requeued.job.status, "queued");
      assert.equal(requeued.job.requeueCount, 1);

      const recovered = createIngestWorker({
        logger: silentLogger,
        ragService: server.app.locals.services.ragService,
        store: ingestJobStore,
        tempDirectory: server.tempRoot,
        workerId: "recovered",
      });

      assert.equal((await recovered.runOnce()).outcome, "succeeded");
      assert.equal(
        (await fetch(`${server.baseUrl}/admin/ingest-jobs/${queued.jobId}/requeue`, { headers: ALICE_HEADERS, method: "POST" })).status,
        404,
        "only a dead-letter job can be requeued"
      );
    } finally {
      await server.close();
    }
  });
});

test("the dead-letter admin routes need the admin permissions once API auth is on", async () => {
  await withEnv(
    {
      API_AUTH_ENABLED: "true",
      API_AUTH_TOKENS: JSON.stringify([
        { token: "viewer-token", userId: "alice", workspaceId: "ws-a", roles: ["admin.viewer"] },
        { token: "plain-token", userId: "alice", workspaceId: "ws-a" },
      ]),
      RAG_INGEST_MODE: "async",
    },
    async () => {
      const server = await startApp({
        ingestJobStore: createInMemoryIngestJobStore(),
        ragService: createStubRagService().service,
      });

      try {
        const as = (token) => ({ "x-api-key": token });

        assert.equal((await fetch(`${server.baseUrl}/admin/ingest-jobs/dead-letter`, { headers: as("plain-token") })).status, 403);
        assert.equal((await fetch(`${server.baseUrl}/admin/ingest-jobs/dead-letter`, { headers: as("viewer-token") })).status, 200);
        assert.equal(
          (await fetch(`${server.baseUrl}/admin/ingest-jobs/job-x/requeue`, { headers: as("viewer-token"), method: "POST" })).status,
          403,
          "a viewer may list but not requeue"
        );
      } finally {
        await server.close();
      }
    }
  );
});
