import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configureEmbeddingDimensions } from "../rag/config.js";
import {
  assertIndexVersionChunkTableName,
  getIndexVersionRegistryTableNames,
  renderIndexVersionChunkTableDdl,
  renderIndexVersionDropDdl,
  renderMigrationSql,
} from "../rag/db-migrations.js";
import { configureOpenAIProvider, embedQuery, embedTexts, resetOpenAIProvider } from "../rag/openai.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import {
  beginPgvectorIndexWrite,
  clearPgvectorIndex,
  configurePgvectorRuntime,
  countPgvectorChunks,
  describePgvectorStatus,
  embedDocumentsInSpace,
  embedQueryInSpace,
  ensurePgvectorSchema,
  fenceFailedWriteSpace,
  getActivePgvectorSparseRankFunctionName,
  getActivePgvectorVersion,
  listLivePgvectorVersionTables,
  prepareDocumentsForPgvectorIndex,
  removeDocumentsFromPgvectorIndex,
  resetPgvectorRuntime,
  resetPgvectorVectorStore,
  searchPgvectorDocuments,
  searchPgvectorSparseDocuments,
  writeDocumentsToPgvectorIndex,
} from "../rag/vector-store-pgvector.js";
import {
  EMBEDDING_SPACE_SOURCES,
  INDEX_VERSION_ERROR_CODES,
  IndexVersionError,
  buildEmbeddingSpace,
  buildLegacyIndexVersion,
  describeIndexVersions,
  getConfiguredEmbeddingSpace,
  getEffectiveDualWriteGraceMs,
  getHintedWriteSpaces,
  getInstancePointerTtlMs,
  getLifecyclePointerTtlMs,
  getVersionVerificationKey,
  invalidateIndexVersionSnapshot,
  isIndexVersionSnapshotFresh,
  isSameDocumentSpace,
  isSameQuerySpace,
  lockIndexVersionWriteTargets,
  normalizeIndexParams,
  peekIndexVersionSnapshot,
  readIndexVersionSnapshot,
  resolveVersionIndexParams,
  resolveVersionSpace,
  toIndexVersion,
} from "../rag/vector-store-pgvector-versions.js";
import {
  beginVectorIndexWrite,
  embedTextsForIndexWrite,
  keepNewestDocumentVersion,
  stampChunkDocumentVersion,
} from "../rag/vector-store.js";
import { createFakeVersionDatabase } from "./pgvector-version-fake-database.mjs";

// Database-free tests of the index-version registry (pointer cache, write
// targets, status) and of the store paths that depend on it: dual writes,
// searches against a version pinned to another model, the DDL a version table
// is created with. vector-store-pgvector-versions.integration.test.mjs runs the
// same against PostgreSQL.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "unit-embed-a";
const PINNED_MODEL = "unit-embed-b";
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_EMBEDDING_MODEL",
  "POSTGRES_ROW_LEVEL_SECURITY",
  "RAG_EMBEDDING_DOCUMENT_PREFIX",
  "RAG_EMBEDDING_QUERY_PREFIX",
  "RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS",
  "RAG_INDEX_VERSION_POINTER_TTL_MS",
  "RAG_PGVECTOR_ITERATIVE_SCAN",
];
let savedEnv;
let originalFetch;

const embedTopic = (text, dimensions) =>
  Array.from({ length: dimensions }, (_, index) =>
    String(text).toLowerCase().includes(["alpha", "beta", "gamma", "delta", "zeta", "eta"][index] ?? "~") ? 1 : 0.01
  );

const useProvider = () => {
  const calls = [];

  configureOpenAIProvider({
    embedQuery: async (text, options) => {
      calls.push({ kind: "query", model: options?.embeddingSpace?.model ?? MODEL, text });
      return embedTopic(text, options?.embeddingSpace?.dimensions ?? 4);
    },
    embedTexts: async (texts, options) => {
      calls.push({ kind: "documents", model: options?.embeddingSpace?.model ?? MODEL, texts });
      return texts.map((text) => embedTopic(text, options?.embeddingSpace?.dimensions ?? 4));
    },
  });
  return calls;
};

const useDatabase = (options) => {
  const database = createFakeVersionDatabase(options);

  configurePgvectorRuntime(database.runtime);
  return database;
};

// A pinned version 2 on another model and width, as a builder would register it.
const addPinnedVersion = (database, { dimensions = 3, status = "building", versionId = 2, ...overrides } = {}) => {
  const chunkTable = `rag_document_chunks_v${versionId}`;

  database.state.tables.set(chunkTable, { dimensions, rows: new Map() });
  database.state.versions.set(versionId, {
    builder_id: null,
    chunk_table: chunkTable,
    dual_write_until: null,
    embedding_dimensions: dimensions,
    embedding_document_prefix: "",
    embedding_identity: PINNED_MODEL,
    embedding_model: PINNED_MODEL,
    embedding_query_prefix: "",
    embedding_space_source: "pinned",
    index_params: { indexType: "hnsw" },
    lease_expires_at: null,
    sparse_rank_function: `${chunkTable}_sparse_rank`,
    status,
    version_id: versionId,
    ...overrides,
  });
  return chunkTable;
};

const activate = (database, versionId) => {
  const previous = database.state.pointer.active_version_id;

  database.state.versions.get(previous).status = "ready";
  database.state.versions.get(previous).dual_write_until = new Date(database.clock.now + 60_000);
  database.state.versions.get(versionId).status = "active";
  database.state.pointer = {
    active_version_id: versionId,
    generation: database.state.pointer.generation + 1,
    previous_version_id: previous,
    switched_at: new Date(database.clock.now),
  };
  invalidateIndexVersionSnapshot();
};

const prepared = (docId, texts) =>
  texts.map((text, index) => ({
    id: `${docId}:${index}`,
    metadata: { chunkIndex: index, docId, fileName: `${docId}.pdf`, pageNumber: 1 },
    pageContent: text,
  }));

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  originalFetch = globalThis.fetch;
  process.env.OPENAI_EMBEDDING_MODEL = MODEL;
  process.env.RAG_PGVECTOR_ITERATIVE_SCAN = "off";
  configureEmbeddingDimensions(4);
  resetPgvectorVectorStore();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetPgvectorRuntime();
  resetPgvectorVectorStore();
  resetOpenAIProvider();
  configureEmbeddingDimensions(null);

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// Spaces, descriptors, names
// ---------------------------------------------------------------------------

test("embedding spaces carry the identity rule and tell interchangeable vectors apart", () => {
  const configured = getConfiguredEmbeddingSpace();

  assert.deepEqual(
    { dimensions: configured.dimensions, identity: configured.identity, key: configured.key, model: configured.model },
    { dimensions: 4, identity: MODEL, key: `${MODEL}|4`, model: MODEL }
  );

  const nomic = buildEmbeddingSpace({
    dimensions: 768,
    documentPrefix: "search_document: ",
    model: "nomic-embed-text",
    queryPrefix: "search_query: ",
  });

  assert.equal(nomic.identity, "nomic-embed-text#search_document:");
  assert.equal(isSameDocumentSpace(nomic, nomic), true);
  assert.equal(isSameDocumentSpace(nomic, configured), false);
  assert.equal(isSameDocumentSpace(null, configured), false);
  assert.equal(isSameQuerySpace(nomic, buildEmbeddingSpace({ ...nomic, queryPrefix: "" })), false);
  assert.equal(
    isSameDocumentSpace(nomic, buildEmbeddingSpace({ ...nomic, documentPrefix: "search_document:" })),
    false,
    "the same identity with a different literal prefix is another space"
  );
});

test("index parameters fall back to configuration field by field", () => {
  assert.deepEqual(normalizeIndexParams({ hnswM: 32, indexType: "ivfflat", textSearchConfig: "english" }), {
    hnswEfConstruction: 64,
    hnswM: 32,
    indexType: "ivfflat",
    ivfflatLists: 100,
    textSearchConfig: "english",
  });
  assert.deepEqual(normalizeIndexParams({ hnswM: -1, indexType: "flat", textSearchConfig: "Bad Name" }), {
    hnswEfConstruction: 64,
    hnswM: 16,
    indexType: "hnsw",
    ivfflatLists: 100,
    textSearchConfig: "simple",
  });
  assert.deepEqual(normalizeIndexParams(null).indexType, "hnsw");
});

test("a pinned version keeps its space; version 1 follows the configuration until it is pinned", () => {
  const legacy = buildLegacyIndexVersion();

  assert.equal(legacy.implicit, true);
  assert.equal(legacy.chunkTable, "rag_document_chunks");
  assert.equal(legacy.spaceSource, EMBEDDING_SPACE_SOURCES.configuration);
  assert.equal(resolveVersionSpace(legacy).model, MODEL);
  assert.equal(resolveVersionIndexParams(legacy).indexType, "hnsw");

  const pinned = toIndexVersion({
    chunk_table: "rag_document_chunks_v2",
    dual_write_until: "2026-01-02T00:00:00Z",
    embedding_dimensions: 3,
    embedding_identity: PINNED_MODEL,
    embedding_model: PINNED_MODEL,
    embedding_space_source: "pinned",
    index_params: { indexType: "ivfflat", ivfflatLists: 7 },
    status: "ready",
    version_id: 2,
  });

  assert.equal(resolveVersionSpace(pinned).key, `${PINNED_MODEL}|3`);
  assert.equal(resolveVersionIndexParams(pinned).ivfflatLists, 7);
  assert.equal(pinned.dualWriteUntil, "2026-01-02T00:00:00.000Z");
  assert.equal(toIndexVersion({ activated_at: "not a date" }).activatedAt, null);

  // A configuration change is not a new verification for version 1 (the
  // single table's contract), but a different pinned space is.
  process.env.OPENAI_EMBEDDING_MODEL = "another-model";
  assert.equal(getVersionVerificationKey(legacy), getVersionVerificationKey(buildLegacyIndexVersion()));
  assert.notEqual(
    getVersionVerificationKey(pinned),
    getVersionVerificationKey({ ...pinned, pinnedSpace: buildEmbeddingSpace({ dimensions: 5, model: PINNED_MODEL }) })
  );
});

test("the dual-write grace period is never shorter than twice the pointer TTL", () => {
  process.env.RAG_INDEX_VERSION_POINTER_TTL_MS = "5000";
  assert.equal(getEffectiveDualWriteGraceMs(1000), 10000);
  assert.equal(getEffectiveDualWriteGraceMs(60000), 60000);

  process.env.RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS = "0";
  assert.equal(getEffectiveDualWriteGraceMs(), 10000);
});

test("registry names and version table names are validated identifiers that fit PostgreSQL's limit", () => {
  assert.deepEqual(getIndexVersionRegistryTableNames("rag_index_versions"), {
    buildProgressTable: "rag_index_versions_build_progress",
    pointerTable: "rag_index_versions_pointer",
    versionsTable: "rag_index_versions",
  });
  assert.throws(() => getIndexVersionRegistryTableNames("bad-name"), /simple PostgreSQL identifier/);
  assert.throws(() => getIndexVersionRegistryTableNames("x".repeat(40)), /63 bytes/);
  assert.equal(assertIndexVersionChunkTableName("rag_document_chunks_v12"), "rag_document_chunks_v12");
  assert.throws(() => assertIndexVersionChunkTableName("t; DROP TABLE x"), /simple PostgreSQL identifier/);
  assert.throws(() => assertIndexVersionChunkTableName("c".repeat(50)), /63 bytes/);
  assert.equal(
    renderIndexVersionDropDdl({
      chunkTable: "rag_document_chunks_v2",
      sparseRankFunction: "rag_document_chunks_v2_sparse_rank",
    }),
    "DROP FUNCTION IF EXISTS rag_document_chunks_v2_sparse_rank(tsquery, text[], integer);\nDROP TABLE IF EXISTS rag_document_chunks_v2;"
  );
  assert.throws(
    () => renderIndexVersionDropDdl({ chunkTable: "rag_document_chunks_v2", sparseRankFunction: "f()" }),
    /simple PostgreSQL identifier/
  );
});

test("a version table is rendered from the migration 012/013/014 templates at its own width and index parameters", async () => {
  const ddl = await renderIndexVersionChunkTableDdl({
    chunkTable: "rag_document_chunks_v3",
    dimensions: 768,
    indexParams: { hnswEfConstruction: 128, hnswM: 24, indexType: "hnsw", textSearchConfig: "english" },
    tenantRole: "archive_tenant",
  });

  assert.match(ddl, /CREATE TABLE rag_document_chunks_v3 \(/);
  assert.doesNotMatch(ddl, /CREATE TABLE IF NOT EXISTS/, "a version id is never reused");
  assert.doesNotMatch(ddl, /CREATE EXTENSION/);
  assert.match(ddl, /embedding vector\(768\) NOT NULL/);
  assert.match(ddl, /REFERENCES rag_documents \(doc_id\) ON DELETE CASCADE/);
  assert.match(ddl, /to_tsvector\('english'::regconfig, search_text\)/);
  assert.match(ddl, /USING hnsw \(embedding vector_cosine_ops\)\s+WITH \(m = 24, ef_construction = 128\)/);
  assert.match(ddl, /USING gin \(search_vector\)/);
  assert.match(ddl, /GRANT SELECT, INSERT, UPDATE, DELETE ON rag_document_chunks_v3 TO archive_tenant/);
  assert.match(ddl, /ALTER TABLE rag_document_chunks_v3 ENABLE ROW LEVEL SECURITY/);
  assert.match(ddl, /CREATE POLICY tenant_isolation ON rag_document_chunks_v3\s+TO archive_tenant/);
  assert.match(ddl, /lower\('rag_document_chunks_v3_sparse_rank'\)/);
  assert.match(ddl, /SECURITY DEFINER/);
  assert.match(ddl, /ALTER TABLE rag_document_chunks_v3 ALTER COLUMN search_vector SET STATISTICS 1000/);

  const ivfflat = await renderIndexVersionChunkTableDdl({
    chunkTable: "rag_document_chunks_v4",
    dimensions: 8,
    indexParams: { indexType: "ivfflat", ivfflatLists: 12 },
  });

  assert.match(ivfflat, /USING ivfflat \(embedding vector_cosine_ops\)\s+WITH \(lists = 12\)/);
  await assert.rejects(
    renderIndexVersionChunkTableDdl({ chunkTable: "rag_document_chunks_v5", dimensions: 3072 }),
    { code: "PGVECTOR_ANN_DIMENSION_UNSUPPORTED" }
  );
});

test("migration 016 renders the registry, the single pointer and version 1 over the existing table", async () => {
  const sql = renderMigrationSql(
    await readFile(path.join(__dirname, "..", "db", "migrations", "016_create_rag_index_versions.sql"), "utf8"),
    {
      adminAuditEventsTable: "rag_admin_audit_events",
      agentRunEventsTable: "rag_agent_run_events",
      agentRunsTable: "rag_agent_runs",
      documentsTable: "rag_documents",
      indexVersionsTable: "rag_index_versions",
      longMemoryTable: "long_memory_items",
      sessionMemoryTable: "rag_session_memory",
      taskEventsTable: "rag_task_events",
      tasksTable: "rag_tasks",
      workspaceArtifactsTable: "rag_workspace_artifacts",
    },
    { embeddingDimensions: 1536, tenantRole: "archive_tenant" }
  );

  assert.doesNotMatch(sql, /__[A-Z_]+__/, "every placeholder is rendered");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS rag_index_versions \(/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS rag_index_versions_pointer \(/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS rag_index_versions_build_progress \(/);
  assert.match(sql, /ON rag_index_versions \(\(TRUE\)\) WHERE status = 'active'/);
  assert.match(sql, /ON rag_index_versions \(\(TRUE\)\) WHERE status = 'building'/);
  assert.match(sql, /lower\('rag_document_chunks'\),\s+lower\('rag_document_chunks_sparse_rank'\),\s+'configuration',\s+1536/);
  assert.match(sql, /GRANT SELECT ON rag_index_versions, rag_index_versions_pointer TO archive_tenant;/);
  assert.doesNotMatch(sql, /rag_index_versions_build_progress TO/, "the tenant role never reads the progress table");
});

test("migration 019 records the pointer TTL every instance honours and flags superseded jobs", async () => {
  const template = await readFile(
    path.join(__dirname, "..", "db", "migrations", "019_bound_pointer_ttl_and_flag_superseded_jobs.sql"),
    "utf8"
  );
  const tables = {
    adminAuditEventsTable: "rag_admin_audit_events",
    agentRunEventsTable: "rag_agent_run_events",
    agentRunsTable: "rag_agent_runs",
    documentsTable: "rag_documents",
    indexVersionsTable: "rag_index_versions",
    ingestJobsTable: "rag_ingest_jobs",
    longMemoryTable: "long_memory_items",
    sessionMemoryTable: "rag_session_memory",
    taskEventsTable: "rag_task_events",
    tasksTable: "rag_tasks",
    workspaceArtifactsTable: "rag_workspace_artifacts",
  };
  const sql = renderMigrationSql(template, tables, {
    embeddingDimensions: 1536,
    indexVersionPointerTtlMs: 30000,
    tenantRole: "archive_tenant",
  });

  assert.doesNotMatch(sql, /__[A-Z_]+__/, "every placeholder is rendered");
  assert.match(sql, /ALTER TABLE rag_index_versions_pointer\s+ADD COLUMN IF NOT EXISTS pointer_ttl_ms INTEGER;/);
  assert.match(sql, /SET pointer_ttl_ms = 30000\s+WHERE pointer_ttl_ms IS NULL;/, "the migrating process's TTL, once");
  assert.match(sql, /ADD CONSTRAINT rag_index_versions_pointer_ttl_positive/);
  assert.match(sql, /ALTER TABLE rag_ingest_jobs\s+ADD COLUMN IF NOT EXISTS superseded BOOLEAN NOT NULL DEFAULT FALSE;/);
  assert.doesNotMatch(sql, /CREATE TABLE/, "no new table, so no new grant or policy");
  assert.match(renderMigrationSql(template, tables, { embeddingDimensions: 4 }), /SET pointer_ttl_ms = 2000\s/, "the configured default");
  assert.throws(() => renderMigrationSql(template, tables, { indexVersionPointerTtlMs: 0 }), /positive integer/);
});

// ---------------------------------------------------------------------------
// Pointer snapshot
// ---------------------------------------------------------------------------

test("the pointer is cached for its TTL, shared by concurrent readers and re-read after it", async () => {
  process.env.RAG_INDEX_VERSION_POINTER_TTL_MS = "1000";
  const database = useDatabase();
  const reads = () => database.tags().filter((tag) => tag === "snapshot").length;

  const [first, second] = await Promise.all([readIndexVersionSnapshot(), readIndexVersionSnapshot()]);

  assert.equal(reads(), 1, "concurrent readers share one read");
  assert.equal(first, second);
  assert.equal(first.registry, "present");
  assert.equal(first.active.versionId, 1);
  assert.equal(first.generation, 1);
  assert.equal(isIndexVersionSnapshotFresh(), true);
  assert.equal(peekIndexVersionSnapshot(), first);

  database.clock.now += 999;
  await readIndexVersionSnapshot();
  assert.equal(reads(), 1);

  database.clock.now += 2;
  assert.equal(isIndexVersionSnapshotFresh(), false);
  await readIndexVersionSnapshot();
  assert.equal(reads(), 2, "an expired pointer is read again");

  await readIndexVersionSnapshot({ force: true });
  assert.equal(reads(), 3);

  // A new runtime says nothing about the old one's pointer.
  configurePgvectorRuntime(database.runtime);
  assert.equal(peekIndexVersionSnapshot(), null);
});

test("without a registry the existing table is version 1; other read errors propagate", async () => {
  const absent = useDatabase({ registry: false });

  assert.equal((await readIndexVersionSnapshot()).registry, "absent");
  assert.equal((await readIndexVersionSnapshot()).active.chunkTable, "rag_document_chunks");
  assert.ok(absent.tags().includes("snapshot"));

  const empty = useDatabase();

  empty.state.pointer = null;
  assert.equal((await readIndexVersionSnapshot({ force: true })).registry, "empty");

  const broken = useDatabase();

  broken.failNext("snapshot", Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
  await assert.rejects(readIndexVersionSnapshot({ force: true }), /connection reset/);
  // The failure is not cached: the next read goes to the database again.
  assert.equal((await readIndexVersionSnapshot()).registry, "present");
});

test("write hints list every version a write goes to, active first, one per space", async () => {
  assert.deepEqual(
    getHintedWriteSpaces().map((space) => space.key),
    [`${MODEL}|4`],
    "without a snapshot: the configured space"
  );

  const database = useDatabase();

  addPinnedVersion(database, { status: "building" });
  addPinnedVersion(database, { status: "ready", versionId: 3 });
  addPinnedVersion(database, {
    dual_write_until: new Date(database.clock.now - 1),
    status: "ready",
    versionId: 4,
  });
  await readIndexVersionSnapshot();

  assert.deepEqual(getHintedWriteSpaces().map((space) => space.key), [`${MODEL}|4`, `${PINNED_MODEL}|3`]);
});

test("the write lock comes before the target read, and an empty registry falls back to version 1", async () => {
  const database = useDatabase();

  addPinnedVersion(database, { status: "building" });
  addPinnedVersion(database, { status: "retired", versionId: 3 });

  const targets = await lockIndexVersionWriteTargets({ query: database.runtime.query });

  assert.deepEqual(database.tags(), ["write_lock", "write_targets"]);
  assert.match(database.log[0].sql, /pg_advisory_xact_lock_shared\(hashtext\(\$1\)::bigint\)/);
  assert.deepEqual(database.log[0].values, ["archive_rag:index_versions:rag_index_versions"]);
  assert.deepEqual(targets.map((version) => version.versionId), [1, 2]);

  database.state.versions.clear();
  assert.deepEqual(
    (await lockIndexVersionWriteTargets({ query: database.runtime.query })).map((version) => version.implicit),
    [true]
  );
});

// ---------------------------------------------------------------------------
// Store: verification, writes, reads
// ---------------------------------------------------------------------------

test("a write goes to every target version, each in its own space, inside one transaction", async () => {
  const calls = useProvider();
  const database = useDatabase();

  addPinnedVersion(database, { status: "building" });
  await ensurePgvectorSchema();

  const documents = await prepareDocumentsForPgvectorIndex({
    documents: prepared("doc-1", ["alpha policy", "beta budget"]),
  });

  assert.deepEqual(
    calls.map((call) => `${call.kind}:${call.model}`),
    [`documents:${MODEL}`, `documents:${PINNED_MODEL}`],
    "ingest embeds once per space before its transaction"
  );
  assert.equal(documents[0].vectorSpaceKey, `${MODEL}|4`);
  assert.equal(documents[0].vectors[`${PINNED_MODEL}|3`].length, 3);

  const written = await database.runtime.withTransaction(async (client) => {
    const handle = await beginPgvectorIndexWrite({ client });

    return writeDocumentsToPgvectorIndex({
      accessScope: { userId: "alice", workspaceId: "ws" },
      client: handle,
      preparedDocuments: documents,
    });
  });

  assert.deepEqual(written, { insertedChunkCount: 2, replacedDocIds: ["doc-1"] });
  assert.equal(database.tags().filter((tag) => tag === "write_lock").length, 1, "the handle carries the targets");
  assert.deepEqual(
    [...database.state.tables.get("rag_document_chunks").rows.values()].map((row) => [row.embedding_model, row.owner_user_id]),
    [[MODEL, "alice"], [MODEL, "alice"]]
  );
  assert.deepEqual(
    [...database.state.tables.get("rag_document_chunks_v2").rows.values()].map((row) => [row.embedding_model, row.embedding_dimensions]),
    [[PINNED_MODEL, 3], [PINNED_MODEL, 3]]
  );
  assert.equal(calls.length, 2, "no embedding inside the transaction");

  // A version registered after the write prepared its vectors gets them
  // embedded inside the transaction; a hand-made prepared document carries
  // the configured space only.
  addPinnedVersion(database, { dimensions: 5, status: "ready", versionId: 3 });
  database.state.versions.get(3).embedding_model = "unit-embed-c";
  database.state.versions.get(3).embedding_identity = "unit-embed-c";
  await writeDocumentsToPgvectorIndex({
    preparedDocuments: [{ ...documents[0], vectorSpaceKey: undefined, vectors: undefined }],
  });

  assert.deepEqual(calls.slice(2).map((call) => call.model), [PINNED_MODEL, "unit-embed-c"]);
  assert.equal(database.state.tables.get("rag_document_chunks_v3").rows.size, 1);
  assert.equal(database.state.tables.get("rag_document_chunks").rows.size, 1, "re-ingest replaced the document");
});

test("a version no search reads never fails an upload: its space failing fences it, the active one is written", async () => {
  const calls = [];

  configureOpenAIProvider({
    embedQuery: async (text) => embedTopic(text, 4),
    embedTexts: async (texts, options) => {
      const model = options?.embeddingSpace?.model ?? MODEL;

      calls.push(model);

      if (model === PINNED_MODEL) {
        throw Object.assign(new Error("401 invalid key for unit-embed-b"), { status: 401 });
      }

      return texts.map((text) => embedTopic(text, options?.embeddingSpace?.dimensions ?? 4));
    },
  });

  const database = useDatabase();

  addPinnedVersion(database, { builder_id: "builder-1", status: "building" });
  await ensurePgvectorSchema();

  const documents = await prepareDocumentsForPgvectorIndex({ documents: prepared("doc-1", ["alpha policy"]) });

  assert.deepEqual(calls, [MODEL, PINNED_MODEL]);
  assert.deepEqual(Object.keys(documents[0].vectors), [`${MODEL}|4`], "the failed space is dropped");
  assert.equal(database.state.versions.get(2).status, "failed");
  assert.equal(database.state.versions.get(2).builder_id, null, "the build's lease is revoked with it");
  assert.match(database.state.versions.get(2).last_error, /could not embed its chunks in unit-embed-b\/3: 401/);

  await writeDocumentsToPgvectorIndex({ preparedDocuments: documents });
  assert.equal(database.state.tables.get("rag_document_chunks").rows.size, 1, "the active version got the upload");
  assert.equal(database.state.tables.get("rag_document_chunks_v2").rows.size, 0, "the fenced version is no target");

  // The staged pipeline's embed stage drops the space the same way.
  addPinnedVersion(database, { dimensions: 3, status: "ready", versionId: 3 });
  invalidateIndexVersionSnapshot();
  await readIndexVersionSnapshot();

  const staged = await embedTextsForIndexWrite({ texts: ["beta budget"] });

  assert.deepEqual(staged.spaces.map((space) => space.key), [`${MODEL}|4`]);
  assert.equal(database.state.versions.get(3).status, "failed");

  // The active version's own space failing fails the upload: nothing to fence.
  configureOpenAIProvider({
    embedQuery: async () => [1, 0, 0, 0],
    embedTexts: async () => {
      throw Object.assign(new Error("model gone"), { status: 404 });
    },
  });
  await assert.rejects(prepareDocumentsForPgvectorIndex({ documents: prepared("doc-2", ["gamma"]) }), /model gone/);
  await assert.rejects(embedTextsForIndexWrite({ texts: ["gamma"] }), /model gone/);
});

test("a fenced version is only ever one the pointer does not name, and a fence that cannot land fails the upload", async () => {
  useProvider();
  const database = useDatabase();

  addPinnedVersion(database, { status: "ready" });
  activate(database, 2);
  // As activation pins it (activateIndexVersion).
  Object.assign(database.state.versions.get(1), {
    embedding_dimensions: 4,
    embedding_identity: MODEL,
    embedding_model: MODEL,
    embedding_space_source: "pinned",
  });
  invalidateIndexVersionSnapshot();

  const pinnedSpace = buildEmbeddingSpace({ dimensions: 3, model: PINNED_MODEL });

  // The active version's space is never fenced.
  assert.equal(await fenceFailedWriteSpace({ error: new Error("x"), space: pinnedSpace }), false);
  assert.equal(database.state.versions.get(2).status, "active");

  // Version 1 (in its grace period) is; a lock timeout on the fence keeps it and fails the write.
  database.failNext("fence", Object.assign(new Error("lock timeout"), { code: "55P03" }));
  assert.equal(await fenceFailedWriteSpace({ error: new Error("x"), space: getConfiguredEmbeddingSpace() }), false);
  assert.equal(database.state.versions.get(1).status, "ready");
  assert.equal(await fenceFailedWriteSpace({ error: new Error("x"), space: getConfiguredEmbeddingSpace() }), true);
  assert.equal(database.state.versions.get(1).status, "failed");
  assert.equal(database.state.pointer.previous_version_id, 1, "a rollback to it is then refused by the gate");
});

test("after a switch, concurrent requests of one process share one schema verification", async () => {
  useProvider();
  const database = useDatabase();

  await ensurePgvectorSchema();
  addPinnedVersion(database, { status: "ready" });
  activate(database, 2);

  const scans = () =>
    database.log.filter((entry) => /GROUP BY embedding_model, embedding_dimensions/.test(entry.sql)).length;
  const before = scans();

  await Promise.all(Array.from({ length: 8 }, () => ensurePgvectorSchema()));
  assert.equal(scans() - before, 1, "one full-table verification for eight requests");
  assert.equal((await getActivePgvectorVersion()).versionId, 2);
});

test("deletes and clears reach every target version and report the active version's count", async () => {
  useProvider();
  const database = useDatabase();

  addPinnedVersion(database, { status: "ready" });
  await writeDocumentsToPgvectorIndex({
    preparedDocuments: await prepareDocumentsForPgvectorIndex({
      documents: [...prepared("doc-1", ["alpha", "beta"]), ...prepared("doc-2", ["gamma"])],
      spaces: [getConfiguredEmbeddingSpace(), buildEmbeddingSpace({ dimensions: 3, model: PINNED_MODEL })],
    }),
  });

  assert.equal(await countPgvectorChunks(), 3);
  assert.equal(await countPgvectorChunks({ versionId: 2 }), 3);
  assert.equal(await removeDocumentsFromPgvectorIndex({ docIds: ["doc-1", " ", "doc-1"] }), 2);
  assert.equal(await countPgvectorChunks({ docIds: ["doc-1"], versionId: 2 }), 0);
  assert.equal(await removeDocumentsFromPgvectorIndex({ docIds: [] }), 0);
  assert.equal(await clearPgvectorIndex(), 1);
  assert.equal(await countPgvectorChunks({ versionId: 2 }), 0);
  await assert.rejects(countPgvectorChunks({ versionId: 9 }), /not live/);
});

test("searches go to the active version: its table, its function and a query embedded in its own model", async () => {
  const calls = useProvider();
  const database = useDatabase();
  const table = addPinnedVersion(database, { status: "ready" });

  await writeDocumentsToPgvectorIndex({
    accessScope: { userId: "alice" },
    preparedDocuments: await prepareDocumentsForPgvectorIndex({
      documents: [...prepared("doc-1", ["alpha policy text"]), ...prepared("doc-2", ["beta budget text"])],
      spaces: [getConfiguredEmbeddingSpace(), buildEmbeddingSpace({ dimensions: 3, model: PINNED_MODEL })],
    }),
  });

  const configuredVector = embedTopic("beta budget", 4);
  const before = await searchPgvectorDocuments({ docIds: ["doc-1", "doc-2"], queryText: "beta budget", queryVector: configuredVector, topK: 1 });

  assert.equal(before[0].document.metadata.docId, "doc-2");
  assert.equal(calls.filter((call) => call.kind === "query").length, 0, "version 1 uses the caller's vector");

  activate(database, 2);
  assert.equal((await getActivePgvectorVersion()).versionId, 2);
  assert.equal(await getActivePgvectorSparseRankFunctionName(), `${table}_sparse_rank`);
  assert.deepEqual(await listLivePgvectorVersionTables(), ["rag_document_chunks", table]);

  const after = await searchPgvectorDocuments({ docIds: ["doc-1", "doc-2"], queryText: "beta budget", queryVector: configuredVector, topK: 1 });
  const dense = database.log.filter((entry) => /AS vector_score/.test(entry.sql)).at(-1);

  assert.equal(after[0].document.metadata.docId, "doc-2");
  assert.match(dense.sql, new RegExp(`FROM ${table} WHERE`));
  assert.deepEqual(dense.values.slice(2), [PINNED_MODEL, 3, 1]);
  assert.deepEqual(calls.filter((call) => call.kind === "query").map((call) => call.model), [PINNED_MODEL]);

  // Cached per space and text.
  await searchPgvectorDocuments({ docIds: ["doc-2"], queryText: "beta budget", queryVector: configuredVector, topK: 1 });
  assert.equal(calls.filter((call) => call.kind === "query").length, 1);

  // A caller that sends no text cannot be served by a version on another model.
  await assert.rejects(
    searchPgvectorDocuments({ docIds: ["doc-2"], queryText: " ", queryVector: configuredVector, topK: 1 }),
    { code: "EMBEDDING_DIMENSION_MISMATCH" }
  );

  process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
  const sparse = await runWithDatabaseTenant({ userId: "alice" }, () =>
    searchPgvectorSparseDocuments({ docIds: ["doc-1", "doc-2"], queryText: "beta budget", topK: 3 })
  );
  const sparseCall = database.log.filter((entry) => /_sparse_rank\(/.test(entry.sql)).at(-1);

  assert.equal(sparse[0].document.metadata.docId, "doc-2");
  assert.match(sparseCall.sql, new RegExp(`FROM ${table}_sparse_rank\\(`));
  assert.match(sparseCall.sql, new RegExp(`JOIN ${table} c ON`));
});

test("a search that meets a retired table re-reads the pointer once; a caller's transaction is not retried", async () => {
  useProvider();
  const database = useDatabase();

  await ensurePgvectorSchema();

  const missing = Object.assign(new Error('relation "rag_document_chunks_v9" does not exist'), { code: "42P01" });
  const args = { docIds: ["doc-1"], queryText: "alpha", queryVector: embedTopic("alpha", 4), topK: 1 };

  database.failNext("SELECT chunk_id, doc_id, chunk_index, page_number, section_heading, content, metadata, 1 - (embedding <=> $1::vector) AS vector_score FROM rag_document_chunks WHERE doc_id = ANY($2::text[]) AND embedding_model = $3 AND embedding_dimensions = $4 ORDER BY embedding <=> $1::vector ASC, chunk_id ASC LIMIT $5", missing);
  assert.deepEqual(await searchPgvectorDocuments(args), []);
  assert.equal(
    database.tags().filter((tag) => tag === "snapshot").length,
    2,
    "verified, then verified again on a fresh pointer after the miss"
  );

  database.failNext("SELECT chunk_id, doc_id, chunk_index, page_number, section_heading, content, metadata, 1 - (embedding <=> $1::vector) AS vector_score FROM rag_document_chunks WHERE doc_id = ANY($2::text[]) AND embedding_model = $3 AND embedding_dimensions = $4 ORDER BY embedding <=> $1::vector ASC, chunk_id ASC LIMIT $5", missing);
  await assert.rejects(searchPgvectorDocuments({ ...args, client: { query: database.runtime.query } }), /does not exist/);
});

test("a pinned active version is verified against its own space and never resized", async () => {
  useProvider();
  const database = useDatabase();

  addPinnedVersion(database, { status: "ready" });
  activate(database, 2);
  database.state.tables.get("rag_document_chunks_v2").dimensions = 7;
  await assert.rejects(ensurePgvectorSchema({ force: true }), (error) => {
    assert.equal(error.code, "EMBEDDING_DIMENSION_MISMATCH");
    assert.match(error.message, /vector:index -- build/);
    return true;
  });
  assert.ok(!database.log.some((entry) => /ALTER TABLE/.test(entry.sql)));

  database.state.tables.get("rag_document_chunks_v2").dimensions = 3;
  database.state.tables.get("rag_document_chunks_v2").rows.set("x:0", {
    chunk_id: "x:0",
    doc_id: "x",
    embedding: "[1,0,0]",
    embedding_dimensions: 3,
    embedding_model: "someone-else",
  });
  await assert.rejects(ensurePgvectorSchema({ force: true }), { code: "EMBEDDING_MODEL_MISMATCH" });
  assert.equal(await ensurePgvectorSchema({ allowForeignEmbeddings: true, force: true }), true);

  database.state.tables.delete("rag_document_chunks_v2");
  await assert.rejects(ensurePgvectorSchema({ force: true }), (error) => {
    assert.equal(error.code, "PGVECTOR_UNAVAILABLE");
    assert.match(error.message, /does not exist/);
    return true;
  });
});

test("status describes the active version's table and the registry", async () => {
  useProvider();
  const database = useDatabase();

  addPinnedVersion(database, { status: "ready" });
  activate(database, 2);

  const status = await describePgvectorStatus();

  assert.equal(status.table.name, "rag_document_chunks_v2");
  assert.equal(status.table.exists, true);
  assert.equal(status.embedding.model, PINNED_MODEL);
  assert.equal(status.embedding.configuredDimensions, 3);
  assert.equal(status.embedding.columnDimensions, 3);
  assert.equal(status.embedding.matches, true);
  assert.deepEqual(status.activeVersion, {
    chunkTable: "rag_document_chunks_v2",
    sparseRankFunction: "rag_document_chunks_v2_sparse_rank",
    spaceSource: "pinned",
    versionId: 2,
  });
  assert.equal(status.indexVersions.registry, "present");
  assert.equal(status.indexVersions.active.versionId, 2);

  database.failNext("describe", new Error("registry down"));
  assert.equal((await describePgvectorStatus()).indexVersions.registry, "error");

  database.failNext("snapshot", new Error("pointer down"));
  assert.equal((await describePgvectorStatus()).table.name, "rag_document_chunks", "falls back to version 1");
});

test("beginVectorIndexWrite hands non-transactional providers their client back", async () => {
  const saved = process.env.VECTOR_STORE_PROVIDER;
  const client = { query: async () => ({ rows: [] }) };

  try {
    process.env.VECTOR_STORE_PROVIDER = "local";
    assert.equal(await beginVectorIndexWrite({ client }), client);
  } finally {
    if (saved === undefined) {
      delete process.env.VECTOR_STORE_PROVIDER;
    } else {
      process.env.VECTOR_STORE_PROVIDER = saved;
    }
  }

  await assert.rejects(beginPgvectorIndexWrite({ client: null }), /needs the transaction's client/);
});

// ---------------------------------------------------------------------------
// Embedding spaces through openai.js
// ---------------------------------------------------------------------------

test("embedding in a pinned space checks every vector's width", async () => {
  useProvider();
  const pinned = buildEmbeddingSpace({ dimensions: 3, model: PINNED_MODEL });

  assert.equal((await embedDocumentsInSpace(["alpha"], pinned))[0].length, 3);
  assert.deepEqual(await embedDocumentsInSpace([], pinned), []);
  assert.equal((await embedQueryInSpace("alpha")).length, 4);

  configureOpenAIProvider({ embedQuery: async () => [1], embedTexts: async () => [[1]] });
  await assert.rejects(embedDocumentsInSpace(["alpha", "beta"], pinned), /returned 1 vector\(s\) for 2/);
  await assert.rejects(embedQueryInSpace("alpha", pinned), (error) => {
    assert.equal(error.code, "EMBEDDING_DIMENSION_MISMATCH");
    assert.match(error.message, new RegExp(PINNED_MODEL));
    return true;
  });
});

test("the real embedding client sends a pinned version's model and prefixes; without a space nothing changes", async () => {
  const requests = [];

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "http://embeddings.test/v1";
  process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);

    requests.push(body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: (Array.isArray(body.input) ? body.input : [body.input]).map((_value, index) => ({ embedding: [1, 0], index })),
        }),
    };
  };
  resetOpenAIProvider();

  const embeddingSpace = {
    documentPrefix: "search_document: ",
    model: "nomic-embed-text",
    queryPrefix: "search_query: ",
  };

  await embedTexts(["We use SQuAD."], { embeddingSpace });
  await embedQuery("which datasets?", { embeddingSpace });
  await embedTexts(["Plain."]);
  await embedQuery("plain?");

  assert.deepEqual(requests, [
    { input: ["search_document: We use SQuAD."], model: "nomic-embed-text" },
    { input: "search_query: which datasets?", model: "nomic-embed-text" },
    { input: ["Plain."], model: "text-embedding-3-small" },
    { input: "plain?", model: "text-embedding-3-small" },
  ]);
});

// ---------------------------------------------------------------------------
// Registry status
// ---------------------------------------------------------------------------

test("registry status reports progress, drift, stalled builds, closed windows and failures", async () => {
  const database = useDatabase();

  assert.equal((await describeIndexVersions()).active.versionId, 1);

  addPinnedVersion(database, {
    build_documents_done: 3,
    build_documents_failed: 1,
    build_documents_total: 9,
    builder_id: "dead-builder",
    lease_expires_at: new Date(database.clock.now - 1),
    status: "building",
  });
  addPinnedVersion(database, { status: "ready", versionId: 3 });
  database.state.tables.get("rag_document_chunks_v3").rows.set("d:0", { chunk_id: "d:0", doc_id: "d" });
  addPinnedVersion(database, { dual_write_until: new Date(database.clock.now - 1), status: "ready", versionId: 4 });
  addPinnedVersion(database, { last_error: "width mismatch", status: "failed", versionId: 5 });
  addPinnedVersion(database, { status: "retired", versionId: 6 });

  const status = await describeIndexVersions();
  const codes = status.warnings.map((warning) => `${warning.code}:${warning.versionId}`);

  assert.deepEqual(status.building, {
    builderId: "dead-builder",
    documentsDone: 3,
    documentsFailed: 1,
    documentsTotal: 9,
    leaseExpired: true,
    leaseExpiresAt: new Date(database.clock.now - 1).toISOString(),
    versionId: 2,
  });
  assert.deepEqual(codes.sort(), [
    "build_failed:5",
    "build_stalled:2",
    "drift:3",
    "ready_not_activated:3",
    "ready_out_of_grace:4",
  ]);
  assert.deepEqual(status.drift, [
    { active: { chunkCount: 0, documentCount: 0 }, version: { chunkCount: 1, documentCount: 1 }, versionId: 3 },
  ]);
  assert.deepEqual(status.versions.map((version) => version.versionId), [6, 5, 4, 3, 2, 1]);
  // The limit pages the history (retired, failed) only; live versions always show.
  assert.deepEqual(
    (await describeIndexVersions({ includeRetired: false, limit: 1 })).versions.map((version) => version.versionId),
    [5, 4, 3, 2, 1]
  );

  // Health asks without drift: no table is scanned for totals.
  const scansBefore = database.log.filter((entry) => entry.tag === "table_totals").length;
  const withoutDrift = await describeIndexVersions({ includeDrift: false });

  assert.equal(withoutDrift.drift, null);
  assert.equal(database.log.filter((entry) => entry.tag === "table_totals").length, scansBefore);
  assert.ok(!withoutDrift.warnings.some((warning) => warning.code === "drift"));

  // The configured model differs from the one the active version is pinned to.
  activate(database, 3);
  assert.ok(
    (await describeIndexVersions()).warnings.some((warning) => warning.code === "configuration_differs_from_active")
  );

  database.state.pointer.active_version_id = 99;
  assert.deepEqual((await describeIndexVersions()).problems, ["The version pointer names no registered version."]);

  assert.equal((await (useDatabase({ registry: false }), describeIndexVersions())).registry, "absent");

  const empty = useDatabase();

  empty.state.versions.clear();
  assert.equal((await describeIndexVersions()).registry, "empty");
});

test("the active version stays in the status however many newer versions were retired or failed", async () => {
  const database = useDatabase();

  for (let versionId = 2; versionId <= 40; versionId += 1) {
    addPinnedVersion(database, { status: versionId % 3 === 0 ? "failed" : "retired", versionId });
  }

  const status = await describeIndexVersions();

  assert.deepEqual(status.problems, []);
  assert.equal(status.active.versionId, 1);
  assert.equal(status.historyLimit, 25);
  assert.equal(status.versions.length, 26, "the active version plus 25 of history");
  assert.equal(status.versions.at(-1).versionId, 1);
  assert.equal(status.versions[0].versionId, 40);
});

test("the pointer cache lives one TTL from the start of its read, bounded by the registry's TTL", async () => {
  process.env.RAG_INDEX_VERSION_POINTER_TTL_MS = "1000";
  const database = useDatabase();

  // A read that takes 400 ms (a queued pool connection) is 400 ms old when it returns.
  database.hooks.set("snapshot", async () => {
    database.clock.now += 400;
  });
  await readIndexVersionSnapshot();
  database.hooks.delete("snapshot");
  database.clock.now += 599;
  await readIndexVersionSnapshot();
  assert.equal(database.log.filter((entry) => entry.tag === "snapshot").length, 1);
  database.clock.now += 2;
  await readIndexVersionSnapshot();
  assert.equal(database.log.filter((entry) => entry.tag === "snapshot").length, 2, "expired at start + TTL");

  // The registry bounds the cache of every instance (migration 019) ...
  database.state.pointer.pointer_ttl_ms = 300;
  database.clock.now += 1001;
  await readIndexVersionSnapshot();
  database.clock.now += 301;
  await readIndexVersionSnapshot();
  assert.equal(database.log.filter((entry) => entry.tag === "snapshot").length, 4, "cached for 300 ms, not 1000");

  // ... and the lifecycle assumes the longest TTL any instance may use.
  assert.equal(getInstancePointerTtlMs(300), 300);
  assert.equal(getInstancePointerTtlMs(null), 1000);
  assert.equal(getLifecyclePointerTtlMs(30_000), 30_000);
  assert.equal(getLifecyclePointerTtlMs(300), 1000);
  assert.equal(getEffectiveDualWriteGraceMs(0, { registryPointerTtlMs: 30_000 }), 60_000);
  assert.equal((await describeIndexVersions()).registryPointerTtlMs, 300);
  assert.equal((await describeIndexVersions()).pointerTtlMs, 300);
});

test("index version errors carry a stable code and an HTTP status", () => {
  assert.equal(new IndexVersionError(INDEX_VERSION_ERROR_CODES.notFound, "x").status, 404);
  assert.equal(new IndexVersionError(INDEX_VERSION_ERROR_CODES.invalidState, "x", { a: 1 }).status, 409);
  assert.deepEqual(new IndexVersionError(INDEX_VERSION_ERROR_CODES.invalidState, "x", { a: 1 }).details, { a: 1 });
});

test("fusion keeps one content version per document when a replacement lands between the two routes", async () => {
  const chunk = (docId, chunkIndex, version, text) => ({
    document: {
      id: `${docId}:${chunkIndex}`,
      metadata: {
        chunkIndex,
        docId,
        ...(version === null ? {} : { documentVersion: version }),
      },
      pageContent: text,
    },
    score: 0.5,
  });
  // The dense route read before the replacement committed, the sparse one after.
  const dense = [chunk("doc-1", 0, null, "v1 text"), chunk("doc-1", 3, null, "v1 clause"), chunk("doc-2", 0, 4, "other")];
  const sparse = [chunk("doc-1", 3, 2, "v2 clause"), chunk("doc-2", 1, 4, "other two")];
  const [keptDense, keptSparse] = keepNewestDocumentVersion(dense, sparse);

  assert.deepEqual(keptDense.map((result) => result.document.id), ["doc-2:0"], "doc-1's version 1 chunks are dropped");
  assert.deepEqual(keptSparse.map((result) => result.document.pageContent), ["v2 clause", "other two"]);

  // Unversioned chunks (before migration 018) are version 1 and kept when alone.
  assert.equal(keepNewestDocumentVersion(dense.slice(0, 2))[0].length, 2);

  // A replaced document's chunks link to their own version; version 1 keeps the plain link.
  assert.deepEqual(stampChunkDocumentVersion({ docId: "doc 1", publicFilePath: "documents/doc%201/file" }, 3), {
    docId: "doc 1",
    documentVersion: 3,
    publicFilePath: "documents/doc%201/file?version=3",
  });
  assert.equal(stampChunkDocumentVersion({ docId: "doc-1", publicFilePath: "documents/doc-1/file" }, 1).publicFilePath, "documents/doc-1/file");
});
