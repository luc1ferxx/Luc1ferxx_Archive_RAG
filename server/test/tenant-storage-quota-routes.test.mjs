import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAdminAuditService, createInMemoryAdminAuditStore } from "../rag/admin-audit.js";
import {
  configureDocumentRegistryStore,
  registerDocument,
  resetDocumentRegistry,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { TENANT_STORAGE_QUOTA_EXCEEDED } from "../rag/tenant-storage-quota.js";

const TOKENS = {
  "alice-token": { userId: "alice", workspaceId: "ws-a" },
  "bob-token": { userId: "bob", workspaceId: "ws-b" },
};
const PDF = Buffer.from("%PDF-1.4\nquota route test\n%%EOF\n");

const withEnv = async (values, run) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const withQuotaApp = async (env, run) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "quota-routes-"));
  const ingested = [];

  try {
    await withEnv(
      {
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKENS: JSON.stringify(TOKENS),
        LONG_MEMORY_DATABASE_URL: undefined,
        POSTGRES_DATABASE_URL: undefined,
        RAG_INGEST_MODE: undefined,
        TENANT_MAX_DOCUMENTS: undefined,
        TENANT_MAX_DOCUMENT_BYTES: undefined,
        ...env,
      },
      async () => {
        // A single-writer registry holding one 100-byte document of ws-a.
        await resetDocumentRegistryStore();
        await resetDocumentRegistry();
        configureDocumentRegistryStore({
          initialize: async () => true,
          list: async () => [],
          upsert: async (document) => document,
        });
        await registerDocument({
          docId: "existing",
          fileName: "existing.pdf",
          fileSize: 100,
          ownerUserId: "carol",
          workspaceId: "ws-a",
        });

        const [{ createApp }, runs, artifacts, jobs, tasks] = await Promise.all([
          import("../app.js"),
          import("../rag/agent-runs.js"),
          import("../rag/workspace-artifacts/memory-store.js"),
          import("../rag/ingest-job-store.js"),
          import("../rag/tasks.js"),
        ]);
        const app = await createApp({
          adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore() }),
          agentRunStore: runs.createInMemoryAgentRunStore(),
          healthService: {
            buildHealthReport: async () => ({ checks: {}, status: "ok" }),
            runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
          },
          ingestJobStore: jobs.createInMemoryIngestJobStore(),
          ragService: {
            getDocument: () => null,
            ingestDocument: async (input) => {
              ingested.push(input);
              return { docId: input.docId, fileName: input.fileName };
            },
            initializeDocumentRegistry: async () => [],
            initializeLongMemory: async () => true,
            initializeSessionMemory: async () => true,
            listDocuments: () => [],
          },
          taskStore: tasks.createInMemoryTaskStore(),
          uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
          uploadsDirectory: path.join(tempRoot, "uploads"),
          workspaceArtifactStore: artifacts.createInMemoryWorkspaceArtifactStore(),
        });
        const server = await startServer(app);

        try {
          await run({ ingested, server });
        } finally {
          await server.close();
          await app.locals.stop?.();
        }
      }
    );
  } finally {
    await resetDocumentRegistryStore();
    await resetDocumentRegistry();
    await rm(tempRoot, { force: true, recursive: true });
  }
};

const upload = async (server, token) => {
  const form = new FormData();

  form.append("file", new Blob([PDF], { type: "application/pdf" }), "report.pdf");

  const response = await fetch(`${server.baseUrl}/upload`, {
    body: form,
    headers: { "x-api-key": token },
    method: "POST",
  });

  return { body: await response.json(), status: response.status };
};

const initUpload = async (server, token, fileSize) => {
  const response = await fetch(`${server.baseUrl}/upload/init`, {
    body: JSON.stringify({
      chunkSize: 1024 * 1024,
      fileId: `file-${fileSize}`,
      fileName: "report.pdf",
      fileSize,
      lastModified: 1,
      totalChunks: 1,
    }),
    headers: { "Content-Type": "application/json", "x-api-key": token },
    method: "POST",
  });

  return { body: await response.json(), status: response.status };
};

test("without a quota (the default) uploads go through as before", async () => {
  await withQuotaApp({}, async ({ ingested, server }) => {
    const response = await upload(server, "alice-token");

    assert.equal(response.status, 201);
    assert.equal(ingested.length, 1);
    assert.equal((await initUpload(server, "alice-token", 50)).status, 201);
  });
});

test("an upload over the workspace's document quota is refused early with 429 and the stable code", async () => {
  await withQuotaApp({ TENANT_MAX_DOCUMENTS: "1" }, async ({ ingested, server }) => {
    const refused = await upload(server, "alice-token");

    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, TENANT_STORAGE_QUOTA_EXCEEDED);
    assert.equal(refused.body.limit, "documents");
    assert.match(refused.body.error, /quota/);
    assert.equal(ingested.length, 0, "refused before parsing or embedding");

    const init = await initUpload(server, "alice-token", 50);

    assert.equal(init.status, 429);
    assert.equal(init.body.code, TENANT_STORAGE_QUOTA_EXCEEDED);

    // Another workspace has its own quota.
    assert.equal((await upload(server, "bob-token")).status, 201);
    assert.equal(ingested.length, 1);
  });
});

test("an upload that would take the workspace over its byte quota is refused with 413", async () => {
  await withQuotaApp({ TENANT_MAX_DOCUMENT_BYTES: String(100 + PDF.length - 1) }, async ({ ingested, server }) => {
    const refused = await upload(server, "alice-token");

    assert.equal(refused.status, 413);
    assert.equal(refused.body.code, TENANT_STORAGE_QUOTA_EXCEEDED);
    assert.equal(refused.body.limit, "document_bytes");
    assert.equal(ingested.length, 0);

    // The declared size decides at init.
    assert.equal((await initUpload(server, "alice-token", PDF.length - 1)).status, 201);
    assert.equal((await initUpload(server, "alice-token", PDF.length)).status, 413);
  });
});
