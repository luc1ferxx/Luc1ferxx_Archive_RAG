import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { configureEmbeddingDimensions } from "../rag/config.js";
import {
  configurePgvectorRuntime,
  resetPgvectorRuntime,
  resetPgvectorVectorStore,
} from "../rag/vector-store-pgvector.js";
import { createDocumentsRouter } from "../routes/documents.js";
import { createFakeVersionDatabase } from "./pgvector-version-fake-database.mjs";

// GET /admin/index-versions: the pgvector index versions for operators,
// read-only, behind the admin status permission.

const ENV_KEYS = ["API_AUTH_ENABLED", "API_AUTH_TOKEN", "OPENAI_EMBEDDING_MODEL", "VECTOR_STORE_PROVIDER"];
let savedEnv;

const request = async (services, pathname = "/admin/index-versions") => {
  const app = express();

  app.use(createDocumentsRouter({ ragService: { listDocuments: () => [] }, ...services }));

  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);

    return { body: await response.json(), status: response.status };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.API_AUTH_ENABLED;
  delete process.env.API_AUTH_TOKEN;
  process.env.OPENAI_EMBEDDING_MODEL = "route-embed";
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  configureEmbeddingDimensions(4);
  resetPgvectorVectorStore();
});

afterEach(() => {
  resetPgvectorRuntime();
  resetPgvectorVectorStore();
  configureEmbeddingDimensions(null);

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("the registry status comes back as JSON", async () => {
  configurePgvectorRuntime(createFakeVersionDatabase().runtime);

  const { body, status } = await request({});

  assert.equal(status, 200);
  assert.equal(body.registry, "present");
  assert.equal(body.active.versionId, 1);
  assert.equal(body.active.chunkTable, "rag_document_chunks");
  assert.equal(body.pointerTtlMs, 2000);
});

test("other providers answer 409, a failing registry its own status, and an unauthorised caller 403", async () => {
  process.env.VECTOR_STORE_PROVIDER = "local";
  assert.deepEqual((await request({})).status, 409);
  assert.match((await request({})).body.error, /only for VECTOR_STORE_PROVIDER=pgvector/);

  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  const failing = await request({
    describeIndexVersions: async () => {
      throw Object.assign(new Error("registry unavailable"), { status: 503 });
    },
  });

  assert.equal(failing.status, 503);

  process.env.API_AUTH_ENABLED = "true";
  process.env.API_AUTH_TOKEN = "secret";

  const forbidden = await request({ describeIndexVersions: async () => ({ registry: "present" }) });

  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.adminAuthorization.permissionId, "admin.status.read");
});

test("a file link naming a replaced content version gets a 409, never the newer PDF", async () => {
  const pdf = Buffer.from("%PDF-1.4 version three");
  const ragService = {
    getDocumentFile: async (docId) =>
      docId === "doc-1"
        ? { document: { docId, version: 3 }, fileBuffer: pdf, fileName: "v3.pdf", mimeType: "application/pdf" }
        : null,
    listDocuments: () => [],
  };
  const app = express();

  app.use(createDocumentsRouter({ ragService }));

  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}/documents`;
    const stale = await fetch(`${base}/doc-1/file?version=2`);

    assert.equal(stale.status, 409);
    assert.deepEqual(
      { ...(await stale.json()), error: undefined },
      { currentVersion: 3, error: undefined, requestedVersion: 2 }
    );

    const current = await fetch(`${base}/doc-1/file?version=3`);

    assert.equal(current.status, 200);
    assert.equal(Buffer.from(await current.arrayBuffer()).toString(), "%PDF-1.4 version three");
    assert.equal((await fetch(`${base}/doc-1/file`)).status, 200, "an unversioned link opens the current PDF");
    assert.equal((await fetch(`${base}/doc-1/file?version=zero`)).status, 400);
    assert.equal((await fetch(`${base}/doc-9/file?version=1`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
