import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildHealthReport } from "../health.js";
import { derivePgvectorHealthProblems } from "../health.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import { resetVectorStore } from "../rag/vector-store.js";

// The vector store health entry is the operator's first stop when retrieval
// misbehaves. These are the branches reachable without a database; the
// pgvector-with-database branches live in the integration suite.

const withEnv = async (overrides, callback) => {
  const originalValues = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

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
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const quietStores = {
  ADMIN_AUDIT_STORE_PROVIDER: "memory",
  AGENT_RUN_STORE_PROVIDER: "memory",
  API_AUTH_ENABLED: "false",
  LONG_MEMORY_DATABASE_URL: undefined,
  OPENAI_API_KEY: "test-key",
  POSTGRES_DATABASE_URL: undefined,
  RAG_HYBRID_ENABLED: undefined,
  RAG_HYBRID_FUSION: undefined,
  TASK_STORE_PROVIDER: "memory",
  WORKSPACE_ARTIFACT_STORE_PROVIDER: "memory",
};

test("an invalid provider is reported as an error with the allowlist, never as another provider", async () => {
  await withEnv({ ...quietStores, VECTOR_STORE_PROVIDER: "elastic" }, async () => {
    const report = await buildHealthReport();
    const entry = report.checks.vectorStore;

    assert.equal(report.status, "error");
    assert.equal(entry.status, "error");
    assert.equal(entry.provider, null);
    assert.equal(entry.configuredValue, "elastic");
    assert.deepEqual(entry.allowedProviders, ["local", "pgvector", "qdrant"]);
    assert.match(entry.message, /not allowed/);
    assert.match(entry.message, /rather than falling back/);
    assert.deepEqual(entry.retrieval, { hybridEnabled: true, hybridFusion: "rrf" });
  });
});

test("the pgvector default without a database is an error that names the missing setting", async () => {
  await withEnv({ ...quietStores, VECTOR_STORE_PROVIDER: undefined }, async () => {
    resetVectorStore();

    const report = await buildHealthReport();
    const entry = report.checks.vectorStore;

    assert.equal(entry.status, "error");
    assert.equal(entry.provider, "pgvector");
    assert.equal(entry.providerSource, "default");
    assert.equal(entry.providerMatchesConfig, true);
    assert.equal(entry.backend, "postgresql");
    assert.match(entry.message, /POSTGRES_DATABASE_URL/);
    assert.deepEqual(entry.retrieval, { hybridEnabled: true, hybridFusion: "rrf" });
  });
});

// A fully-healthy pgvector status: table present, every index in place, the
// column width and stored model matching config, and an hnsw ANN index that is
// both present and the configured method. Each test overrides one facet.
const healthyPgvectorStatus = (overrides = {}) => ({
  configured: true,
  reachable: true,
  extension: { installed: true, version: "0.7.4" },
  table: { exists: true, name: "rag_document_chunks" },
  indexes: {
    docId: true,
    embedding: true,
    embeddingModel: true,
    scope: true,
    searchVector: true,
  },
  annIndex: {
    configured: "hnsw",
    actual: "hnsw",
    present: true,
    matches: true,
    supported: true,
  },
  annDimensionsSupported: true,
  indexType: "hnsw",
  embedding: {
    columnDimensions: 1536,
    configuredDimensions: 1536,
    matches: true,
    model: "text-embedding-3-small",
    storedModels: [
      { chunkCount: 5, dimensions: 1536, model: "text-embedding-3-small" },
    ],
  },
  chunkCount: 5,
  documentCount: 2,
  indexEmptyWithDocuments: false,
  ...overrides,
});

test("a fully-healthy pgvector status yields no problems", () => {
  assert.deepEqual(derivePgvectorHealthProblems(healthyPgvectorStatus()), []);
});

test("health flags an ANN index whose actual access method is not the configured one", () => {
  // pg_indexes reports the name is present, but pg_am says it is a btree, not
  // the configured hnsw ANN index — retrieval would not use it.
  const problems = derivePgvectorHealthProblems(
    healthyPgvectorStatus({
      annIndex: {
        configured: "hnsw",
        actual: "btree",
        present: true,
        matches: false,
        supported: true,
      },
    })
  );

  assert.equal(problems.length, 1);
  assert.match(problems[0], /is a btree index/);
  assert.match(problems[0], /configured ANN method is hnsw/);
  assert.match(problems[0], /vector:reindex -- --apply/);
});

test("health flags a missing ANN index while chunks are stored (partial migration)", () => {
  const problems = derivePgvectorHealthProblems(
    healthyPgvectorStatus({
      indexes: {
        docId: true,
        embedding: false,
        embeddingModel: true,
        scope: true,
        searchVector: true,
      },
      annIndex: {
        configured: "hnsw",
        actual: null,
        present: false,
        matches: false,
        supported: true,
      },
      chunkCount: 5,
    })
  );

  // The embedding index is reported once, via the ANN-specific partial-migration
  // message — not also as a generic "missing pgvector/FTS indexes" line.
  assert.equal(problems.length, 1);
  assert.match(problems[0], /hnsw embedding index is missing/);
  assert.match(problems[0], /partial migration/);
  assert.doesNotMatch(problems[0], /Missing pgvector\/FTS indexes/);
});

test("health explains, rather than hides, an absent ANN index above the vector ceiling", () => {
  const problems = derivePgvectorHealthProblems(
    healthyPgvectorStatus({
      annDimensionsSupported: false,
      annIndex: {
        configured: "hnsw",
        actual: null,
        present: false,
        matches: false,
        supported: false,
      },
      embedding: {
        columnDimensions: 3072,
        configuredDimensions: 3072,
        matches: true,
        model: "text-embedding-3-large",
        storedModels: [
          { chunkCount: 5, dimensions: 3072, model: "text-embedding-3-large" },
        ],
      },
    })
  );

  assert.equal(problems.length, 1);
  assert.match(problems[0], /3072-dimensional/);
  assert.match(problems[0], /ANN limit of 2000/);
  assert.match(problems[0], /sequential scan/);
});

test("a missing ANN index on an empty table is not reported as a partial migration", () => {
  // chunkCount 0: nothing to index yet, so an absent ANN index is not a fault.
  const problems = derivePgvectorHealthProblems(
    healthyPgvectorStatus({
      indexes: {
        docId: true,
        embedding: false,
        embeddingModel: true,
        scope: true,
        searchVector: true,
      },
      annIndex: {
        configured: "hnsw",
        actual: null,
        present: false,
        matches: false,
        supported: true,
      },
      chunkCount: 0,
      documentCount: 0,
      indexEmptyWithDocuments: false,
    })
  );

  assert.deepEqual(problems, []);
});

test("the local provider is checked like any other backend and reports its directory", async () => {
  const originalDirectory = getRagDataDirectory();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vector-health-local-"));
  const directory = path.join(tempRoot, "rag-data");

  configureRagDataDirectory(directory);

  try {
    await withEnv(
      { ...quietStores, RAG_HYBRID_ENABLED: "false", VECTOR_STORE_PROVIDER: "local" },
      async () => {
        const report = await buildHealthReport();
        const entry = report.checks.vectorStore;

        assert.equal(entry.status, "ok");
        assert.equal(entry.provider, "local");
        assert.equal(entry.providerSource, "env_configured");
        assert.equal(entry.backend, "filesystem");
        assert.equal(entry.directory, directory);
        assert.equal(entry.providerMatchesConfig, true);
        assert.match(entry.message, /explicit opt-in/);
        assert.deepEqual(entry.retrieval, { hybridEnabled: false, hybridFusion: "rrf" });
      }
    );
  } finally {
    configureRagDataDirectory(originalDirectory);
    await rm(tempRoot, { force: true, recursive: true });
  }
});
