import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";

// Storage quotas and the database pool (rag/index.js commitDocument): a burst
// of uploads into one workspace with TENANT_MAX_DOCUMENTS set must neither
// deadlock the pool nor park a connection per upload.
//
// The pool is a stand-in (test/storage-quota-pool/postgres-stand-in.mjs): a
// fixed number of connections, handed out in order, no connection timeout --
// node-pg's defaults -- with transaction-scoped advisory locks held to the end
// of the transaction. rag/index.js and rag/tenant-storage-quota.js import it
// in place of rag/postgres.js, and rag/index.js imports a vector-store
// stand-in that can put commitDocument on its pgvector path. The registry is
// an in-memory store that answers as the shared PostgreSQL registry does
// (its writes without a transaction client take a pooled connection).

const HELPERS = new URL("./storage-quota-pool/", import.meta.url);
const POSTGRES_STAND_IN = new URL("postgres-stand-in.mjs", HELPERS).href;
const VECTOR_STORE_STAND_IN = new URL("vector-store-stand-in.mjs", HELPERS).href;
const RAG = new URL("../rag/", import.meta.url);

register("./langgraph-runtime-parity/redirect-hooks.mjs", import.meta.url, {
  data: {
    redirects: [
      {
        capture: POSTGRES_STAND_IN,
        fromPrefix: new URL("index.js", RAG).href,
        target: new URL("postgres.js", RAG).href,
      },
      {
        capture: POSTGRES_STAND_IN,
        fromPrefix: new URL("tenant-storage-quota.js", RAG).href,
        target: new URL("postgres.js", RAG).href,
      },
      {
        capture: VECTOR_STORE_STAND_IN,
        fromPrefix: new URL("index.js", RAG).href,
        target: new URL("vector-store.js", RAG).href,
      },
    ],
  },
});

// The hooks apply only to modules loaded after register().
const { fakePool } = await import(POSTGRES_STAND_IN);
const { vectorStoreControl } = await import(VECTOR_STORE_STAND_IN);
const { ingestDocumentPages } = await import("../rag/index.js");
const {
  configureDocumentRegistryStore,
  DOCUMENT_REGISTRY_BACKENDS,
  resetDocumentRegistry,
  resetDocumentRegistryStore,
} = await import("../rag/doc-registry.js");
const { resetEmbeddingCache } = await import("../rag/embedding-cache.js");
const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const { runWithDatabaseTenant } = await import("../rag/postgres-tenant.js");
const { configureRagDataDirectory, getRagDataDirectory } = await import("../rag/storage.js");
const { TENANT_STORAGE_QUOTA_EXCEEDED } = await import("../rag/tenant-storage-quota.js");
const { configureTenantUsageLedger, createTenantUsageLedger } = await import("../rag/tenant-usage.js");
const { resetVectorStore } = await import("../rag/vector-store.js");

const ENV_NAMES = [
  "LONG_MEMORY_DATABASE_URL",
  "POSTGRES_DATABASE_URL",
  "RAG_HYBRID_ENABLED",
  "RAG_LONG_MEMORY_ENABLED",
  "TENANT_MAX_DOCUMENTS",
  "TENANT_MAX_DOCUMENT_BYTES",
  "VECTOR_STORE_PROVIDER",
];
const originalDataDirectory = getRagDataDirectory();
let savedEnvironment = {};
let tempRoot = null;

const embed = (text) => {
  const vector = new Array(16).fill(0);

  for (const character of String(text)) {
    vector[character.codePointAt(0) % 16] += 1;
  }

  return vector;
};

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });

  return { promise, resolve };
};

const settle = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// Fails instead of hanging when the commits deadlock.
const withinSeconds = (promise, seconds, message) => {
  let timer;

  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), seconds * 1000);
    }),
  ]);
};

// The shared registry: rows in memory; a write without the caller's
// transaction client takes a pooled connection, as the PostgreSQL store's does.
const createSharedRegistryStore = () => {
  const rows = new Map();
  const toOwner = (owner = {}) => ({
    ownerUserId: String(owner.ownerUserId ?? "").trim(),
    workspaceId: String(owner.workspaceId ?? "").trim(),
  });

  return {
    backend: DOCUMENT_REGISTRY_BACKENDS.postgres,
    rows,
    async clear() {
      rows.clear();
      return true;
    },
    async delete(docId) {
      const row = rows.get(docId) ?? null;

      rows.delete(docId);
      return row;
    },
    async findByContentHash(hash, owner, { client = null } = {}) {
      const { ownerUserId, workspaceId } = toOwner(owner);
      const run = client ? (text) => client.query(text, []) : (text) => fakePool.query(text, []);

      await run("SELECT * FROM rag_documents WHERE content_sha256 = $1");

      return (
        [...rows.values()].find(
          (row) => row.contentSha256 === hash && row.ownerUserId === ownerUserId && row.workspaceId === workspaceId
        ) ?? null
      );
    },
    async getFile() {
      return null;
    },
    async initialize() {
      return true;
    },
    async list() {
      return [...rows.values()];
    },
    async lockContentHash(hash, owner, { client }) {
      const { ownerUserId, workspaceId } = toOwner(owner);

      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify(["content", ownerUserId, workspaceId, hash]),
      ]);
    },
    async upsert(document, { client = null } = {}) {
      const text = "INSERT INTO rag_documents ... ON CONFLICT (doc_id) DO UPDATE";

      await (client ? client.query(text, []) : fakePool.query(text, []));

      const { fileBuffer, ...stored } = document;
      const row = { ...stored, fileSize: fileBuffer?.length ?? 0 };

      rows.set(row.docId, row);
      return row;
    },
  };
};

beforeEach(async () => {
  savedEnvironment = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  ENV_NAMES.forEach((name) => delete process.env[name]);
  process.env.VECTOR_STORE_PROVIDER = "local";
  process.env.RAG_HYBRID_ENABLED = "false";
  process.env.RAG_LONG_MEMORY_ENABLED = "false";

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "storage-quota-pool-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  await resetDocumentRegistryStore();
  await resetDocumentRegistry();
  resetVectorStore();
  resetEmbeddingCache();
  fakePool.reset();
  vectorStoreControl.transactional = false;
  vectorStoreControl.onIndexWrite = null;
  configureOpenAIProvider({
    completeText: async () => "unused",
    embedQuery: async (query) => embed(query),
    embedTexts: async (texts) => texts.map((text) => embed(text)),
  });
  // No ledger writes: they are not what this suite looks at.
  configureTenantUsageLedger(createTenantUsageLedger({ isDatabaseConfigured: () => false }));
});

afterEach(async () => {
  vectorStoreControl.transactional = false;
  vectorStoreControl.onIndexWrite = null;
  configureTenantUsageLedger(null);
  resetOpenAIProvider();
  resetEmbeddingCache();
  resetVectorStore();
  await resetDocumentRegistryStore();
  configureRagDataDirectory(originalDataDirectory);
  await rm(tempRoot, { force: true, recursive: true });

  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const totalsOf = (store) => (workspaceId, userId) => {
  const inScope = [...store.rows.values()].filter((row) =>
    workspaceId ? row.workspaceId === workspaceId : row.workspaceId === "" && row.ownerUserId === userId
  );

  return {
    documentBytes: inScope.reduce((sum, row) => sum + row.fileSize, 0),
    documentCount: inScope.length,
  };
};

const upload = (docId, { deduplicate = true, workspaceId = "ws-a" } = {}) =>
  runWithDatabaseTenant({ userId: "alice", workspaceId }, () =>
    ingestDocumentPages({
      deduplicate,
      docId,
      fileBuffer: Buffer.from(`%PDF-1.4 ${docId}`),
      fileName: `${docId}.pdf`,
      ownerUserId: "alice",
      pages: [{ pageNumber: 1, text: `Section 1. Policy text for ${docId}.` }],
      workspaceId,
    })
  );

test("local/Qdrant with a shared registry: concurrent uploads into one quota scope never wait on the pool while holding a connection", async () => {
  // Two connections. Before the fix each upload checked out its content-lock
  // transaction's connection, then queued on the in-process quota lock; the
  // holder of that lock then needed a second connection for the quota count,
  // and both were held by uploads parked behind it.
  const store = createSharedRegistryStore();

  process.env.TENANT_MAX_DOCUMENTS = "3";
  configureDocumentRegistryStore(store);
  fakePool.configure({ max: 2, readTotals: totalsOf(store) });

  const results = await withinSeconds(
    Promise.allSettled(["a-1", "a-2", "a-3", "a-4"].map((docId) => upload(docId))),
    10,
    "the uploads deadlocked on the pool"
  );

  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled", "fulfilled", "rejected"],
    "three fit the quota, in order"
  );
  assert.equal(results[3].reason.code, TENANT_STORAGE_QUOTA_EXCEEDED);
  assert.deepEqual([...store.rows.keys()].sort(), ["a-1", "a-2", "a-3"]);

  // The quota count ran on the content-lock transaction's connection, never
  // on a second one from the pool.
  const counts = fakePool.statements().filter((statement) => /storage_totals/.test(statement.text));

  assert.equal(counts.length, 4);
  assert.ok(counts.every((statement) => statement.onClient), JSON.stringify(counts));
  assert.equal(fakePool.inUse, 0);
  assert.equal(fakePool.waiting, 0);
});

test("pgvector: one quota scope's queued commits hold one pooled connection, so other tenants still get one", async () => {
  // Three connections, five uploads into one workspace. Before the fix every
  // commit checked out a connection and then waited on the scope's advisory
  // lock in it, so the backlog held the whole pool for as long as it lasted.
  const store = createSharedRegistryStore();
  const firstWrite = deferred();
  const gate = deferred();
  let writes = 0;

  process.env.TENANT_MAX_DOCUMENTS = "10";
  configureDocumentRegistryStore(store);
  fakePool.configure({ max: 3, readTotals: totalsOf(store) });
  vectorStoreControl.transactional = true;
  vectorStoreControl.onIndexWrite = async () => {
    writes += 1;

    if (writes === 1) {
      firstWrite.resolve();
      await gate.promise;
    }
  };

  const uploads = Promise.allSettled(
    ["a-1", "a-2", "a-3", "a-4", "a-5"].map((docId) => upload(docId, { deduplicate: false }))
  );

  await withinSeconds(firstWrite.promise, 10, "the first commit never reached its chunk write");
  await settle();

  // The first commit is inside its transaction; the other four wait for
  // their turn in this process without a connection.
  assert.equal(fakePool.inUse, 1);
  assert.equal(fakePool.waiting, 0);

  // Another tenant's statement gets a connection now, not after the backlog.
  await withinSeconds(fakePool.query("SELECT 1", []), 1, "another tenant waited for the pool");

  gate.resolve();

  const results = await withinSeconds(uploads, 10, "the commits never finished");

  assert.deepEqual(results.map((result) => result.status), Array(5).fill("fulfilled"));
  assert.equal(writes, 5);
  assert.equal(fakePool.peak, 2, "one commit at a time, plus the other tenant's statement");

  // Each commit still takes the scope's advisory lock (other processes).
  const scopeLocks = fakePool
    .statements()
    .filter((statement) => /pg_advisory_xact_lock/.test(statement.text));

  assert.equal(scopeLocks.length, 5);
  assert.ok(scopeLocks.every((statement) => statement.onClient));
});

test("without a quota (the default) commits into one workspace are not serialized in this process", async () => {
  const store = createSharedRegistryStore();
  const firstWrite = deferred();
  const gate = deferred();
  let reached = 0;

  configureDocumentRegistryStore(store);
  fakePool.configure({ max: 3, readTotals: totalsOf(store) });
  vectorStoreControl.transactional = true;
  vectorStoreControl.onIndexWrite = async () => {
    reached += 1;

    if (reached === 3) {
      firstWrite.resolve();
    }

    await gate.promise;
  };

  const uploads = Promise.allSettled(["a-1", "a-2", "a-3"].map((docId) => upload(docId, { deduplicate: false })));

  await withinSeconds(firstWrite.promise, 10, "the commits did not run side by side");
  assert.equal(fakePool.inUse, 3);
  gate.resolve();
  assert.deepEqual((await uploads).map((result) => result.status), Array(3).fill("fulfilled"));
  assert.equal(
    fakePool.statements().filter((statement) => /pg_advisory_xact_lock|storage_totals/.test(statement.text)).length,
    0,
    "no quota lock and no count"
  );
});
