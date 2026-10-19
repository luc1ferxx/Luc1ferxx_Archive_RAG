import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  main,
  parseArgs,
  planIndexVersionChunkProfileRecords,
  prepareDocumentForReindex,
  prepareFromStoredVectors,
  writeReindexedDocument,
} from "../vector-reindex.mjs";
import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { MIXED_CHUNK_PROFILE, describeChunkProfile } from "../rag/chunk-profile.js";
import { recordIndexVersionChunkProfile } from "../rag/vector-store-pgvector-version-lifecycle.js";
import { describeIndexVersions, invalidateIndexVersionSnapshot } from "../rag/vector-store-pgvector-versions.js";
import { TENANT_ENCRYPTION_ERROR_CODES, createTenantEncryptionError } from "../rag/kms/errors.js";
import { WORKING_FILE_MAGIC } from "../rag/working-files.js";
import { configureEmbeddingDimensions } from "../rag/config.js";
import {
  configureDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import {
  configurePgvectorRuntime,
  prepareDocumentsForPgvectorIndex,
  resetPgvectorRuntime,
  resetPgvectorVectorStore,
} from "../rag/vector-store-pgvector.js";
import { getConfiguredEmbeddingSpace } from "../rag/vector-store-pgvector-versions.js";
import { createFakeVersionDatabase } from "./pgvector-version-fake-database.mjs";
import {
  configureRagDataDirectory,
  getRagDataDirectory,
} from "../rag/storage.js";

// vector-reindex.mjs is the pgvector migration path. Two properties matter most
// and are covered here without a database: (1) a dry run is strictly read-only —
// it runs no migration and emits no DDL/DML; (2) stored vectors are copied only
// when the operator attests their source model, otherwise they are re-embedded,
// so a same-width vector from another model is never mislabelled. The behaviour
// against a real pgvector server is covered by the integration suite.

const DIMENSIONS = 4;

const originalRagDirectory = getRagDataDirectory();
const originalEnv = {
  POSTGRES_DATABASE_URL: process.env.POSTGRES_DATABASE_URL,
  VECTOR_STORE_PROVIDER: process.env.VECTOR_STORE_PROVIDER,
};

const tempDirectories = [];

afterEach(async () => {
  resetPgvectorRuntime();
  configureDocumentRegistryStore(null);
  configureEmbeddingDimensions(null);
  configureRagDataDirectory(originalRagDirectory);

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop(), { force: true, recursive: true });
  }
});

// A fake pgvector runtime that records every SQL it is asked to run and counts
// migration invocations, so a test can prove a dry run touched neither.
const createRecordingRuntime = ({ tableExists = false } = {}) => {
  const calls = [];
  let migrations = 0;

  const query = async (sql, values = []) => {
    const compact = sql.replace(/\s+/g, " ").trim();
    calls.push(compact);

    if (/FROM pg_extension/.test(compact)) {
      return { rows: [{ extversion: "0.7.4" }] };
    }

    if (/to_regclass/.test(compact)) {
      return { rows: [{ relation: tableExists ? values[0] : null }] };
    }

    if (/AS chunk_count/.test(compact)) {
      return { rows: [{ chunk_count: 0 }] };
    }

    if (/AS document_count/.test(compact)) {
      return { rows: [{ document_count: 0 }] };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    calls,
    migrationCount: () => migrations,
    runtime: {
      checkPostgresHealth: async () => ({ message: "ok", status: "ok" }),
      isPostgresConfigured: () => true,
      query,
      runMigrations: async () => {
        migrations += 1;
        return { appliedMigrations: [], status: "ok" };
      },
    },
  };
};

// A registry store whose initialize() (the migration path) and list() (the
// read-only path) are both observable, so a dry run can be shown to use only the
// latter.
const createRegistryStore = (documents = []) => {
  const calls = [];

  return {
    calls,
    store: {
      async initialize() {
        calls.push("initialize");
        return true;
      },
      async list() {
        calls.push("list");
        return documents;
      },
    },
  };
};

const captureStdout = async (run) => {
  const original = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    await run();
  } finally {
    process.stdout.write = original;
  }

  return output;
};

const runMain = async (argv) => {
  const originalArgv = process.argv;
  process.argv = [process.execPath, "vector-reindex.mjs", ...argv];

  try {
    return await captureStdout(() => main());
  } finally {
    process.argv = originalArgv;
  }
};

const registeredDoc = (overrides = {}) => ({
  docId: "doc-a",
  fileName: "Alpha.pdf",
  mimeType: "application/pdf",
  fileSize: 10,
  chunkCount: 3,
  pageCount: 1,
  ownerUserId: "",
  workspaceId: "",
  uploadedAt: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs defaults to a local, dry-run, untrusted plan", () => {
  const options = parseArgs([]);

  assert.equal(options.apply, false);
  assert.equal(options.from, "local");
  assert.equal(options.trustSourceEmbeddings, false);
  assert.deepEqual(options.docIds, []);
});

test("parseArgs reads --trust-source-embeddings alongside the other flags", () => {
  const options = parseArgs([
    "--from=qdrant",
    "--apply",
    "--doc-id",
    "doc-a",
    "--doc-id=doc-b",
    "--trust-source-embeddings",
  ]);

  assert.equal(options.from, "qdrant");
  assert.equal(options.apply, true);
  assert.equal(options.trustSourceEmbeddings, true);
  assert.deepEqual(options.docIds, ["doc-a", "doc-b"]);
});

test("parseArgs rejects an unknown option and an invalid source", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
  assert.throws(() => parseArgs(["--from", "elastic"]), /--from must be/);
});

// ---------------------------------------------------------------------------
// prepareFromStoredVectors — model-provenance guard (req 2.1)
// ---------------------------------------------------------------------------

const storedEntry = (vector) => ({
  id: "doc-a:0",
  metadata: { docId: "doc-a", fileName: "Alpha.pdf" },
  pageContent: "hello world",
  vector,
});

test("stored vectors of the configured width are re-embedded unless the source model is attested", async () => {
  configureEmbeddingDimensions(DIMENSIONS);

  const entries = [storedEntry([0.1, 0.2, 0.3, 0.4])];
  let prepareCalledWith = null;
  const prepare = async ({ documents }) => {
    prepareCalledWith = documents;
    return documents.map((document) => ({ ...document, vector: [9, 9, 9, 9], reembedded: true }));
  };

  const result = await prepareFromStoredVectors(entries, {
    trustSourceEmbeddings: false,
    prepare,
  });

  // Width matches, but without attestation the vectors are NOT copied: the
  // re-embed path runs so the configured model's own vectors are stored.
  assert.equal(result.reembedded, true);
  assert.ok(prepareCalledWith, "the re-embed path must be taken");
  assert.equal(prepareCalledWith[0].id, "doc-a:0");
});

test("stored vectors are copied verbatim once the source model is attested", async () => {
  configureEmbeddingDimensions(DIMENSIONS);

  const vector = [0.1, 0.2, 0.3, 0.4];
  const entries = [storedEntry(vector)];
  let prepareCalled = false;
  const prepare = async () => {
    prepareCalled = true;
    return [];
  };

  const result = await prepareFromStoredVectors(entries, {
    trustSourceEmbeddings: true,
    prepare,
  });

  assert.equal(result.reembedded, false);
  assert.equal(prepareCalled, false, "attested copy must not re-embed");
  assert.deepEqual(result.preparedDocuments[0].vector, vector);
  assert.equal(result.preparedDocuments[0].id, "doc-a:0");
  assert.equal(typeof result.preparedDocuments[0].searchText, "string");
});

test("a width mismatch is re-embedded even when the source model is attested", async () => {
  configureEmbeddingDimensions(DIMENSIONS);

  // A 2-wide vector cannot go into a 4-wide column: copying it would be
  // corruption, so the trust flag does not apply.
  const entries = [storedEntry([0.1, 0.2])];
  let prepareCalled = false;
  const prepare = async ({ documents }) => {
    prepareCalled = true;
    return documents.map((document) => ({ ...document, vector: [0, 0, 0, 0] }));
  };

  const result = await prepareFromStoredVectors(entries, {
    trustSourceEmbeddings: true,
    prepare,
  });

  assert.equal(result.reembedded, true);
  assert.equal(prepareCalled, true);
});

// ---------------------------------------------------------------------------
// main() dry run — strictly read-only (req 2.2)
// ---------------------------------------------------------------------------

test("a dry run runs no migration and emits no DDL or DML", async () => {
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.POSTGRES_DATABASE_URL = "postgres://test";

  const recording = createRecordingRuntime({ tableExists: false });
  configurePgvectorRuntime(recording.runtime);

  const registry = createRegistryStore([registeredDoc()]);
  configureDocumentRegistryStore(registry.store);

  const output = await runMain(["--from", "documents"]);

  // The registry was read, never migrated.
  assert.ok(registry.calls.includes("list"), "the registry must be read");
  assert.equal(
    registry.calls.includes("initialize"),
    false,
    "a dry run must not initialize (migrate) the registry"
  );

  // No pgvector migration ran, and every SQL the dry run issued is a read.
  assert.equal(recording.migrationCount(), 0, "a dry run must not run migrations");
  const ddlOrDml = recording.calls.filter((sql) =>
    /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)
  );
  assert.deepEqual(ddlOrDml, [], `dry run issued write SQL: ${ddlOrDml.join(" | ")}`);

  assert.match(output, /dry run/);
  assert.match(output, /reembed\s+doc-a/);
  assert.doesNotMatch(output, /Done\./);
});

test("a dry run from local reflects the trust flag in the plan without writing", async () => {
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.POSTGRES_DATABASE_URL = "postgres://test";
  configureEmbeddingDimensions(DIMENSIONS);

  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "vector-reindex-"));
  tempDirectories.push(dataDirectory);
  configureRagDataDirectory(dataDirectory);
  await writeFile(
    path.join(dataDirectory, "vector-index.json"),
    JSON.stringify([
      {
        id: "doc-a:0",
        metadata: { docId: "doc-a", fileName: "Alpha.pdf" },
        pageContent: "hello world",
        vector: [0.1, 0.2, 0.3, 0.4],
      },
    ])
  );

  const recording = createRecordingRuntime({ tableExists: false });
  configurePgvectorRuntime(recording.runtime);
  configureDocumentRegistryStore(createRegistryStore([registeredDoc()]).store);

  // Same width as the configured model, but the local index records no model,
  // so the default plan re-embeds and names why.
  const untrusted = await runMain(["--from", "local"]);
  assert.match(untrusted, /reembed\s+doc-a/);
  assert.match(untrusted, /--trust-source-embeddings/);
  assert.equal(recording.migrationCount(), 0);

  // With attestation the same document is planned as a vector copy.
  const trusted = await runMain(["--from", "local", "--trust-source-embeddings"]);
  assert.match(trusted, /copy\s+doc-a/);
  assert.match(trusted, /source model attested/);
  assert.equal(recording.migrationCount(), 0);
});

test("a dry run warns when the configured embedding exceeds the pgvector ANN ceiling", async () => {
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.POSTGRES_DATABASE_URL = "postgres://test";
  configureEmbeddingDimensions(3072);

  configurePgvectorRuntime(createRecordingRuntime({ tableExists: false }).runtime);
  configureDocumentRegistryStore(createRegistryStore([registeredDoc()]).store);

  const output = await runMain(["--from", "documents"]);

  assert.match(output, /exceed pgvector's ANN limit of 2000/);
  assert.match(output, /fail closed/);
});

// ---------------------------------------------------------------------------
// --apply: one locked, version-checked write per document
// ---------------------------------------------------------------------------

test("an applied document is written only while it is still the content it was prepared from", async () => {
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.OPENAI_EMBEDDING_MODEL = "reindex-embed";
  configureEmbeddingDimensions(DIMENSIONS);
  configureOpenAIProvider({
    embedQuery: async () => [1, 0, 0, 0],
    embedTexts: async (texts) => texts.map(() => [1, 0, 0, 0]),
  });

  const database = createFakeVersionDatabase({ baseDimensions: DIMENSIONS });
  const order = [];
  const current = { contentSha256: "a".repeat(64), docId: "doc-a", ownerUserId: "alice", version: 1, workspaceId: "ws" };
  let row = current;

  database.addDocument({ docId: "doc-a", owner: "alice", pages: ["x"], workspace: "ws" });
  database.hooks.set("write_lock", () => order.push("index write lock"));
  configurePgvectorRuntime(database.runtime);
  configureDocumentRegistryStore({
    async initialize() {
      return true;
    },
    async list() {
      return [];
    },
    async lockForContentReplace(docId, { client }) {
      assert.equal(typeof client.query, "function", "locked on the write's own transaction");
      order.push(`lock ${docId}`);
      return row;
    },
  });

  try {
    const prepared = await prepareDocumentsForPgvectorIndex({
      documents: [
        { id: "doc-a:0", metadata: { chunkIndex: 0, docId: "doc-a", documentVersion: 7 }, pageContent: "alpha one" },
        { id: "doc-a:1", metadata: { chunkIndex: 1, docId: "doc-a" }, pageContent: "alpha two" },
      ],
      spaces: [getConfiguredEmbeddingSpace()],
    });
    const write = (expected) =>
      writeReindexedDocument({
        docId: "doc-a",
        expected,
        preparedDocuments: prepared,
        withTransaction: database.runtime.withTransaction,
      });

    assert.deepEqual(await write({ contentSha256: current.contentSha256, version: 1 }), {
      chunkCount: 2,
      documentVersion: 1,
      status: "written",
      // The versions it wrote into, with what they recorded (version 1:
      // nothing).
      targets: [{ chunkProfile: null, chunkProfileMixed: false, status: "active", versionId: 1 }],
    });
    assert.deepEqual(order, ["index write lock", "lock doc-a"], "the lock order of every writer");

    const rows = [...database.state.tables.get("rag_document_chunks").rows.values()];

    assert.deepEqual(rows.map((entry) => [entry.metadata.documentVersion, entry.owner_user_id, entry.workspace_id]), [
      [1, "alice", "ws"],
      [1, "alice", "ws"],
    ]);

    // PUT /documents/doc-a committed version 2 while these chunks were embedded.
    row = { ...current, contentSha256: "b".repeat(64), version: 2 };
    database.state.tables.get("rag_document_chunks").rows.clear();
    assert.deepEqual(await write({ contentSha256: current.contentSha256, version: 1 }), {
      currentVersion: 2,
      expectedVersion: 1,
      status: "changed",
    });
    assert.equal(database.state.tables.get("rag_document_chunks").rows.size, 0, "the replacement's chunks stay");

    // Same version, other bytes (a restore that reset the version) is a change too.
    row = { ...current, contentSha256: "c".repeat(64) };
    assert.equal((await write({ contentSha256: current.contentSha256, version: 1 })).status, "changed");

    // Deleted meanwhile.
    row = null;
    assert.deepEqual(await write({ contentSha256: current.contentSha256, version: 1 }), { status: "gone" });
  } finally {
    resetOpenAIProvider();
    resetPgvectorVectorStore();
    delete process.env.OPENAI_EMBEDDING_MODEL;
  }
});

test("--from documents skips a document whose stored PDF cannot be read, and only that", async () => {
  const fail = (error) => async () => {
    throw error;
  };

  // A decrypt failure in the registry's read (a destroyed key, a changed
  // byte, bytes that only look like an envelope).
  configureDocumentRegistryStore({
    getFile: fail(createTenantEncryptionError(TENANT_ENCRYPTION_ERROR_CODES.keyDestroyed, "Version 1 was destroyed.")),
  });
  assert.deepEqual(await prepareDocumentForReindex(registeredDoc()), { unreadableCode: "TENANT_KEY_DESTROYED" });

  // Stored plaintext that begins like a working file: its working copy
  // cannot be read back (TENANT_ENCRYPTION off).
  configureDocumentRegistryStore({
    getFile: async () => ({
      document: registeredDoc(),
      fileBuffer: Buffer.concat([WORKING_FILE_MAGIC, Buffer.from([1]), Buffer.from("%PDF-1.4\n%%EOF\n")]),
    }),
  });
  assert.deepEqual(await prepareDocumentForReindex(registeredDoc()), { unreadableCode: "WORKING_FILE_UNREADABLE" });

  // Anything else still ends the run.
  configureDocumentRegistryStore({ getFile: fail(Object.assign(new Error("connection lost"), { code: "57P01" })) });
  await assert.rejects(prepareDocumentForReindex(registeredDoc()), /connection lost/);
});

// ---------------------------------------------------------------------------
// The chunk profile index versions record after --from documents
// ---------------------------------------------------------------------------

test("--from documents records the profile it cut with on the versions it rewrote whole, and mixed on the rest", () => {
  const run = describeChunkProfile();
  const built = describeChunkProfile({ size: 600 });
  const versions = (entries) =>
    new Map(
      entries.map(([versionId, documents, target = {}]) => [
        versionId,
        { documents, target: { chunkProfile: built, chunkProfileMixed: false, status: "active", versionId, ...target } },
      ])
    );
  const plan = (complete, entries, documentsWritten = 3) =>
    planIndexVersionChunkProfileRecords({ complete, documentsWritten, runProfile: run, versions: versions(entries) });

  // A complete run: the active and a ready version received every document;
  // a building version's builder goes on cutting under its own profile.
  assert.deepEqual(plan(true, [[2, 3], [3, 3, { status: "ready" }], [4, 3, { status: "building" }]]), [
    { chunkProfile: run, previous: built.id, versionId: 2 },
    { chunkProfile: run, previous: built.id, versionId: 3 },
    { chunkProfile: MIXED_CHUNK_PROFILE, previous: built.id, versionId: 4 },
  ]);
  // Documents left out (--doc-id, a skip), or a version that became a write
  // target partway: its table holds chunks of both profiles.
  assert.deepEqual(plan(false, [[2, 3]]), [{ chunkProfile: MIXED_CHUNK_PROFILE, previous: built.id, versionId: 2 }]);
  assert.deepEqual(plan(true, [[2, 2]]), [{ chunkProfile: MIXED_CHUNK_PROFILE, previous: built.id, versionId: 2 }]);
  // Already mixed: a partial run leaves it so, a complete one names the run's.
  assert.deepEqual(plan(false, [[2, 3, { chunkProfile: null, chunkProfileMixed: true }]]), []);
  assert.deepEqual(plan(true, [[2, 3, { chunkProfile: null, chunkProfileMixed: true }]]), [
    { chunkProfile: run, previous: "mixed", versionId: 2 },
  ]);
  // Nothing to change: the version recorded the run's profile, recorded none
  // (version 1, older versions: unknown), or received no document.
  assert.deepEqual(plan(false, [[2, 3, { chunkProfile: run }]]), []);
  assert.deepEqual(plan(true, [[1, 3, { chunkProfile: null }]]), []);
  assert.deepEqual(plan(true, [[2, 0]]), []);
});

test("a version's recorded chunk profile is replaced on its own, never added to a version that recorded none", async () => {
  process.env.VECTOR_STORE_PROVIDER = "pgvector";

  const database = createFakeVersionDatabase({ baseDimensions: DIMENSIONS });
  const current = describeChunkProfile();
  const built = describeChunkProfile({ size: 600 });

  database.state.tables.set("rag_document_chunks_v2", { dimensions: DIMENSIONS, rows: new Map() });
  database.state.versions.set(2, {
    ...structuredClone(database.state.versions.get(1)),
    chunk_table: "rag_document_chunks_v2",
    embedding_space_source: "pinned",
    index_params: { chunkProfile: JSON.parse(JSON.stringify(built)), indexType: "hnsw" },
    sparse_rank_function: "rag_document_chunks_v2_sparse_rank",
    version_id: 2,
  });
  database.state.versions.get(1).status = "ready";
  database.state.pointer = { ...database.state.pointer, active_version_id: 2, previous_version_id: 1 };
  configurePgvectorRuntime(database.runtime);

  const chunkWarnings = async () =>
    (await describeIndexVersions({ includeDrift: false })).warnings.filter((warning) => warning.code.startsWith("chunk_profile_"));
  const activeProfile = async () => (await describeIndexVersions({ includeDrift: false })).active.chunkProfile;

  try {
    invalidateIndexVersionSnapshot();
    assert.deepEqual((await chunkWarnings()).map((warning) => warning.code), ["chunk_profile_differs_from_active"]);

    // Every document was cut again with the current profile.
    assert.equal(await recordIndexVersionChunkProfile({ chunkProfile: current, versionId: 2 }), true);
    assert.equal((await activeProfile()).id, current.id);
    assert.deepEqual(await chunkWarnings(), []);
    assert.equal(database.state.versions.get(2).index_params.indexType, "hnsw", "the index params stay");

    // Some were left out: no profile is named, and none is compared.
    assert.equal(await recordIndexVersionChunkProfile({ chunkProfile: MIXED_CHUNK_PROFILE, versionId: 2 }), true);
    assert.equal(await activeProfile(), "mixed");
    assert.deepEqual(await chunkWarnings(), []);

    // Version 1 recorded none: it stays unknown.
    assert.equal(await recordIndexVersionChunkProfile({ chunkProfile: current, versionId: 1 }), false);
    assert.equal(
      (await describeIndexVersions({ includeDrift: false })).versions.find((version) => version.versionId === 1).chunkProfile,
      "unknown"
    );
    assert.deepEqual(database.state.versions.get(1).index_params, {});
  } finally {
    invalidateIndexVersionSnapshot();
  }
});

test("--from documents --apply re-chunks every document and records that profile on the active version", async () => {
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.OPENAI_EMBEDDING_MODEL = "reindex-embed";
  configureEmbeddingDimensions(DIMENSIONS);
  configureOpenAIProvider({
    embedQuery: async () => [1, 0, 0, 0],
    embedTexts: async (texts) => texts.map(() => [1, 0, 0, 0]),
  });

  const database = createFakeVersionDatabase({ baseDimensions: DIMENSIONS });
  const current = describeChunkProfile();
  const built = describeChunkProfile({ size: 600 });
  const documents = ["doc-a", "doc-b"].map((docId) =>
    registeredDoc({ contentSha256: null, docId, fileName: `${docId}.pdf`, ownerUserId: "alice", version: 1, workspaceId: "ws" })
  );
  const pdf = buildTextPdf({ pages: [["Signed contracts are kept for seven years after they end."]] });

  for (const document of documents) {
    database.addDocument({ docId: document.docId, owner: "alice", pages: ["x"], workspace: "ws" });
  }

  // The active version 1, built under another chunk size, as a version
  // `vector:index build` created records it.
  database.state.versions.get(1).index_params = { chunkProfile: JSON.parse(JSON.stringify(built)) };
  configurePgvectorRuntime(database.runtime);

  const runWith = async (argv, registered = documents) => {
    configureDocumentRegistryStore({
      async getFile(docId) {
        return { document: registered.find((document) => document.docId === docId), fileBuffer: pdf };
      },
      async initialize() {
        return true;
      },
      async list() {
        return registered;
      },
      async lockForContentReplace(docId) {
        return registered.find((document) => document.docId === docId) ?? null;
      },
    });
    invalidateIndexVersionSnapshot();
    return runMain(argv);
  };

  try {
    // runMain swallows stdout, where node --test's child process also reports
    // the tests before this one: let those reports out first.
    await new Promise((resolve) => setImmediate(resolve));

    // One document: the table now holds both profiles.
    let output = await runWith(["--from", "documents", "--apply", "--doc-id", "doc-a"]);

    assert.match(output, new RegExp(`Index version 1 now records a mixed chunk profile \\(was ${built.id}\\)`));
    assert.deepEqual(database.state.versions.get(1).index_params.chunkProfile, { mixed: true });

    // Every document: the table holds the current profile alone.
    output = await runWith(["--from", "documents", "--apply"]);

    assert.match(output, new RegExp(`Index version 1 now records chunk profile ${current.id} \\(was mixed\\)`));
    assert.equal(database.state.versions.get(1).index_params.chunkProfile.id, current.id);
    assert.ok(
      [...database.state.tables.get("rag_document_chunks").rows.values()].every((row) => row.metadata.chunkProfileId === current.id)
    );

    // Run again under the same profile: nothing to record.
    output = await runWith(["--from", "documents", "--apply"]);
    assert.doesNotMatch(output, /now records/);
  } finally {
    invalidateIndexVersionSnapshot();
    resetOpenAIProvider();
    resetPgvectorVectorStore();
    delete process.env.OPENAI_EMBEDDING_MODEL;
  }
});
