import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { clearDocuments, ingestDocumentPages } from "../chat.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import {
  configureDocumentRegistryStore,
  resetDocumentRegistry,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { resetEmbeddingCache } from "../rag/embedding-cache.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  assertTenantStorageQuota,
  assertTenantStorageQuotaAllows,
  describeTenantStorageQuotaError,
  evaluateTenantStorageQuota,
  getTenantStorageQuotaLimits,
  hasTenantStorageQuota,
  lockTenantStorageQuota,
  readTenantStorageTotals,
  resolveStorageQuotaScope,
  TENANT_STORAGE_QUOTA_EXCEEDED,
} from "../rag/tenant-storage-quota.js";
import { configureTenantUsageLedger, createTenantUsageLedger } from "../rag/tenant-usage.js";
import { resetVectorStore } from "../rag/vector-store.js";

const ENV_NAMES = [
  "LONG_MEMORY_DATABASE_URL",
  "POSTGRES_DATABASE_URL",
  "RAG_HYBRID_ENABLED",
  "RAG_INGEST_DEDUP",
  "RAG_LONG_MEMORY_ENABLED",
  "TENANT_MAX_DOCUMENTS",
  "TENANT_MAX_DOCUMENT_BYTES",
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
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const isQuotaError = (limit, status) => (error) =>
  error.code === TENANT_STORAGE_QUOTA_EXCEEDED &&
  error.limit === limit &&
  error.status === status &&
  error.expose === true &&
  error.retryable === false;

test("the quotas default to 0 (no limit) and an empty value keeps the default", () => {
  assert.deepEqual(getTenantStorageQuotaLimits(), { maxDocumentBytes: 0, maxDocuments: 0 });
  assert.equal(hasTenantStorageQuota(), false);

  process.env.TENANT_MAX_DOCUMENTS = "  ";
  process.env.TENANT_MAX_DOCUMENT_BYTES = "";
  assert.equal(hasTenantStorageQuota(), false);

  process.env.TENANT_MAX_DOCUMENTS = "3";
  process.env.TENANT_MAX_DOCUMENT_BYTES = "1000";
  assert.deepEqual(getTenantStorageQuotaLimits(), { maxDocumentBytes: 1000, maxDocuments: 3 });
});

test("a quota scope is the workspace, else the user without a workspace, else none", () => {
  assert.deepEqual(resolveStorageQuotaScope({ ownerUserId: "alice", workspaceId: " ws-a " }), {
    kind: "workspace",
    userId: "",
    workspaceId: "ws-a",
  });
  assert.deepEqual(resolveStorageQuotaScope({ ownerUserId: "alice", workspaceId: "" }), {
    kind: "user",
    userId: "alice",
    workspaceId: "",
  });
  assert.equal(resolveStorageQuotaScope({}), null);
});

test("only growth past a limit is refused, with 429 for the count and 413 for the bytes", () => {
  const limits = { maxDocumentBytes: 1000, maxDocuments: 2 };

  assert.equal(
    evaluateTenantStorageQuota({ addedBytes: 10, addedDocuments: 1, limits, totals: { documentBytes: 0, documentCount: 1 } }),
    null
  );
  assert.equal(
    evaluateTenantStorageQuota({ addedBytes: 10, addedDocuments: 1, limits, totals: { documentBytes: 0, documentCount: 2 } }),
    "documents"
  );
  assert.equal(
    evaluateTenantStorageQuota({ addedBytes: 11, addedDocuments: 1, limits, totals: { documentBytes: 990, documentCount: 0 } }),
    "document_bytes"
  );
  // A replacement that shrinks passes, even when the scope is already over a
  // lowered quota; one that grows past it does not.
  assert.equal(
    evaluateTenantStorageQuota({ addedBytes: -50, addedDocuments: 0, limits, totals: { documentBytes: 5000, documentCount: 9 } }),
    null
  );
  assert.equal(
    evaluateTenantStorageQuota({ addedBytes: 1, addedDocuments: 0, limits, totals: { documentBytes: 1000, documentCount: 9 } }),
    "document_bytes"
  );
  assert.equal(
    evaluateTenantStorageQuota({ addedBytes: 10, addedDocuments: 1, limits: { maxDocumentBytes: 0, maxDocuments: 0 }, totals: { documentCount: 1e9 } }),
    null
  );
});

test("without a quota or a scope nothing is read; with one the totals decide", async () => {
  let reads = 0;
  const readTotals = async (scope) => {
    reads += 1;
    assert.deepEqual(scope, { kind: "workspace", userId: "", workspaceId: "ws-a" });
    return { documentBytes: 900, documentCount: 1 };
  };

  assert.equal(
    await assertTenantStorageQuota({ addedDocuments: 1, ownerUserId: "alice", readTotals, workspaceId: "ws-a" }),
    null
  );
  assert.equal(
    await assertTenantStorageQuota({ addedDocuments: 1, limits: { maxDocuments: 1 }, readTotals }),
    null,
    "a document that names no tenant has no quota scope"
  );
  assert.equal(reads, 0);

  await assert.rejects(
    assertTenantStorageQuota({
      addedBytes: 200,
      addedDocuments: 1,
      limits: { maxDocumentBytes: 1000, maxDocuments: 5 },
      ownerUserId: "alice",
      readTotals,
      workspaceId: "ws-a",
    }),
    isQuotaError("document_bytes", 413)
  );
  await assert.rejects(
    assertTenantStorageQuota({
      addedBytes: 1,
      addedDocuments: 1,
      limits: { maxDocuments: 1 },
      ownerUserId: "alice",
      readTotals,
      workspaceId: "ws-a",
    }),
    isQuotaError("documents", 429)
  );
  assert.equal(reads, 2);
  assert.deepEqual(describeTenantStorageQuotaError(new Error("other")), {});
});

test("on a transaction client the quota takes its scope's advisory lock and counts through migration 037's function", async () => {
  const statements = [];
  const client = {
    query: async (text, values) => {
      statements.push({ text, values });
      return /storage_totals/.test(text) ? { rows: [{ document_bytes: "40", document_count: "3" }] } : { rows: [] };
    },
  };
  const scope = { kind: "workspace", userId: "", workspaceId: "ws-a" };

  await lockTenantStorageQuota(scope, { client, documentsTable: "rag_documents" });
  assert.deepEqual(await readTenantStorageTotals(scope, { client, documentsTable: "rag_documents" }), {
    documentBytes: 40,
    documentCount: 3,
  });
  assert.equal(statements[0].text, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))");
  assert.deepEqual(JSON.parse(statements[0].values[0]), [
    "archive_rag:storage_quota",
    "rag_documents",
    "workspace",
    "ws-a",
    "",
  ]);
  assert.equal(
    statements[1].text,
    "SELECT document_count, document_bytes FROM rag_documents_storage_totals($1, $2)"
  );
  assert.deepEqual(statements[1].values, ["ws-a", ""]);

  statements.length = 0;
  await assert.rejects(
    assertTenantStorageQuota({
      addedDocuments: 1,
      client,
      limits: { maxDocuments: 3 },
      lock: true,
      ownerUserId: "bob",
      workspaceId: "ws-a",
    }),
    isQuotaError("documents", 429)
  );
  assert.equal(statements.length, 2, "lock first, then the count");
  assert.match(statements[0].text, /pg_advisory_xact_lock/);
});

// ---------------------------------------------------------------------------
// The commit path (rag/index.js commitDocument) on the local store with the
// file registry: one writer, so the registry map is the whole registry.
// ---------------------------------------------------------------------------

const embed = (text) => {
  const vector = new Array(16).fill(0);

  for (const character of String(text)) {
    vector[character.codePointAt(0) % 16] += 1;
  }

  return vector;
};

const originalDataDirectory = getRagDataDirectory();

const withArchive = async (run) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "storage-quota-test-"));
  const usageRows = [];

  process.env.VECTOR_STORE_PROVIDER = "local";
  process.env.RAG_HYBRID_ENABLED = "false";
  process.env.RAG_LONG_MEMORY_ENABLED = "false";
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  await resetDocumentRegistryStore();
  await resetDocumentRegistry();
  resetVectorStore();
  resetEmbeddingCache();
  configureDocumentRegistryStore(createFileDocumentRegistryStore());
  configureOpenAIProvider({
    completeText: async () => "unused",
    embedQuery: async (query) => embed(query),
    embedTexts: async (texts) => texts.map((text) => embed(text)),
  });
  // The usage ledger as if a database were configured, writing to a list.
  const ledger = createTenantUsageLedger({
    isDatabaseConfigured: () => true,
    isEnabled: () => true,
    query: async (text, values) => {
      values[0].forEach((workspaceId, index) =>
        usageRows.push({
          metric: values[2][index],
          userId: values[1][index],
          value: Number(values[4][index]),
          workspaceId,
        })
      );
      return { rows: [] };
    },
    setTimer: () => null,
  });

  configureTenantUsageLedger(ledger);

  const ingest = async ({ docId, ownerUserId = "", text = "policy text", workspaceId = "" }) => {
    const filePath = path.join(tempRoot, `${docId}.pdf`);

    await writeFile(filePath, `%PDF-1.4 ${docId} ${text}`, "utf8");

    return ingestDocumentPages({
      deduplicate: true,
      docId,
      fileName: `${docId}.pdf`,
      filePath,
      ownerUserId,
      pages: [{ pageNumber: 1, text: `Section 1. ${text} for ${docId}.` }],
      workspaceId,
    });
  };

  try {
    return await run({ ingest, ledger, tempRoot, usageRows });
  } finally {
    configureTenantUsageLedger(null);
    await clearDocuments({ deleteFiles: false });
    resetOpenAIProvider();
    resetEmbeddingCache();
    resetVectorStore();
    await resetDocumentRegistryStore();
    configureRagDataDirectory(originalDataDirectory);
    await rm(tempRoot, { force: true, recursive: true });
  }
};

test("commitDocument refuses a document over the workspace's document quota and stores nothing for it", async () => {
  await withArchive(async ({ ingest }) => {
    process.env.TENANT_MAX_DOCUMENTS = "2";

    await ingest({ docId: "a-1", ownerUserId: "alice", workspaceId: "ws-a" });
    // Another user of the same workspace counts against the same quota.
    await ingest({ docId: "b-1", ownerUserId: "bob", workspaceId: "ws-a" });
    await assert.rejects(
      ingest({ docId: "a-2", ownerUserId: "alice", workspaceId: "ws-a" }),
      isQuotaError("documents", 429)
    );

    const { getDocument } = await import("../rag/doc-registry.js");

    assert.equal(getDocument("a-2"), null, "the refused document was not registered");

    // Another workspace and a user without a workspace have their own quota.
    await ingest({ docId: "c-1", ownerUserId: "carol", workspaceId: "ws-c" });
    await ingest({ docId: "d-1", ownerUserId: "dave" });
    await ingest({ docId: "d-2", ownerUserId: "dave" });
    await assert.rejects(ingest({ docId: "d-3", ownerUserId: "dave" }), isQuotaError("documents", 429));
    // A document that names no tenant has no quota scope.
    await ingest({ docId: "n-1" });
    await ingest({ docId: "n-2" });
    await ingest({ docId: "n-3" });
  });
});

test("an identical upload resolves to the stored document even at the quota", async () => {
  await withArchive(async ({ ingest, tempRoot }) => {
    process.env.TENANT_MAX_DOCUMENTS = "1";

    const first = await ingest({ docId: "a-1", ownerUserId: "alice", workspaceId: "ws-a" });
    const filePath = path.join(tempRoot, "a-1.pdf");
    const again = await ingestDocumentPages({
      deduplicate: true,
      docId: "a-1-copy",
      fileName: "copy.pdf",
      filePath,
      ownerUserId: "alice",
      pages: [{ pageNumber: 1, text: "Section 1. policy text for a-1." }],
      workspaceId: "ws-a",
    });

    assert.equal(again.duplicate, true);
    assert.equal(again.docId, first.docId);
  });
});

test("commitDocument refuses a document that would take the workspace over its byte quota", async () => {
  await withArchive(async ({ ingest }) => {
    await ingest({ docId: "a-1", ownerUserId: "alice", workspaceId: "ws-a" });

    const { getDocument } = await import("../rag/doc-registry.js");
    const stored = getDocument("a-1");

    process.env.TENANT_MAX_DOCUMENT_BYTES = String(stored.fileSize + 5);

    await assert.rejects(
      ingest({ docId: "a-2", ownerUserId: "alice", workspaceId: "ws-a" }),
      isQuotaError("document_bytes", 413)
    );
  });
});

test("without a quota (the default) concurrent uploads all commit, and each committed document reaches the usage ledger", async () => {
  await withArchive(async ({ ingest, ledger, usageRows }) => {
    await Promise.all(
      ["a-1", "a-2", "a-3"].map((docId) => ingest({ docId, ownerUserId: "alice", workspaceId: "ws-a" }))
    );
    await ingest({ docId: "a-1-dup", ownerUserId: "alice", text: "policy text", workspaceId: "ws-a" });
    await ledger.flush();

    // The embedding calls are model usage of their own, outside a tenant here.
    const ingestRows = usageRows.filter((row) => ["documents", "ingested_bytes"].includes(row.metric));
    const totals = Object.fromEntries(ingestRows.map((row) => [row.metric, row.value]));

    assert.equal(totals.documents, 4);
    assert.ok(totals.ingested_bytes > 0);
    assert.deepEqual([...new Set(ingestRows.map((row) => `${row.workspaceId}/${row.userId}`))], ["ws-a/alice"]);
    assert.ok(usageRows.some((row) => row.metric === "model_tokens"));
  });
});

test("concurrent uploads into one workspace never overshoot the quota in one process", async () => {
  await withArchive(async ({ ingest }) => {
    process.env.TENANT_MAX_DOCUMENTS = "2";

    const results = await Promise.allSettled(
      ["a-1", "a-2", "a-3", "a-4"].map((docId) => ingest({ docId, ownerUserId: "alice", workspaceId: "ws-a" }))
    );

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    assert.ok(
      results
        .filter((result) => result.status === "rejected")
        .every((result) => result.reason.code === TENANT_STORAGE_QUOTA_EXCEEDED)
    );
  });
});

test("the early upload check reads the same totals and lets a duplicate of stored bytes through", async () => {
  await withArchive(async ({ ingest }) => {
    process.env.TENANT_MAX_DOCUMENTS = "1";

    await ingest({ docId: "a-1", ownerUserId: "alice", workspaceId: "ws-a" });

    const { getDocument } = await import("../rag/doc-registry.js");
    const stored = getDocument("a-1");

    await assert.rejects(
      assertTenantStorageQuotaAllows({
        addedBytes: 10,
        addedDocuments: 1,
        ownerUserId: "alice",
        workspaceId: "ws-a",
      }),
      isQuotaError("documents", 429)
    );
    assert.equal(
      await assertTenantStorageQuotaAllows({
        addedBytes: 10,
        addedDocuments: 1,
        duplicateOfSha256: stored.contentSha256,
        ownerUserId: "alice",
        workspaceId: "ws-a",
      }),
      null
    );
    // A replacement adds no document.
    assert.deepEqual(
      await assertTenantStorageQuotaAllows({
        addedBytes: 0,
        addedDocuments: 0,
        ownerUserId: "alice",
        workspaceId: "ws-a",
      }),
      { documentBytes: stored.fileSize, documentCount: 1 }
    );
  });
});
