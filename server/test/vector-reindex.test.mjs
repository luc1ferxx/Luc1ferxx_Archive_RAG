import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  main,
  parseArgs,
  prepareFromStoredVectors,
} from "../vector-reindex.mjs";
import { configureEmbeddingDimensions } from "../rag/config.js";
import {
  configureDocumentRegistryStore,
} from "../rag/doc-registry.js";
import {
  configurePgvectorRuntime,
  resetPgvectorRuntime,
} from "../rag/vector-store-pgvector.js";
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
