import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_VECTOR_STORE_PROVIDER,
  VECTOR_STORE_PROVIDERS,
  VectorStoreProviderConfigError,
  configureEmbeddingDimensions,
  getEmbeddingDimensionsConfigStatus,
  getHybridFusionMethod,
  getRetrievalArchitectureConfig,
  getVectorStoreProvider,
  getVectorStoreProviderConfigStatus,
  isHybridRetrievalEnabled,
} from "../rag/config.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  addDocumentsToIndex,
  describeVectorStoreRuntime,
  resetVectorStore,
  searchDocuments,
  searchDocumentsWithRoutes,
} from "../rag/vector-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.resolve(__dirname, "..");

// The provider decides where every chunk in the archive lives. These tests pin
// the two things that must never drift: pgvector is the default, and a value
// outside the allowlist is an error rather than a quiet trip to the local
// JSON index.

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

const noDatabase = {
  LONG_MEMORY_DATABASE_URL: undefined,
  POSTGRES_DATABASE_URL: undefined,
};

test("the default retrieval stack is pgvector with dense + sparse routes fused by RRF", async () => {
  await withEnv(
    {
      RAG_HYBRID_ENABLED: undefined,
      RAG_HYBRID_FUSION: undefined,
      VECTOR_STORE_PROVIDER: undefined,
    },
    () => {
      assert.equal(DEFAULT_VECTOR_STORE_PROVIDER, "pgvector");
      assert.equal(getVectorStoreProvider(), "pgvector");
      assert.deepEqual(getVectorStoreProviderConfigStatus(), {
        allowedProviders: ["local", "pgvector", "qdrant"],
        configured: false,
        provider: "pgvector",
        rawValue: "",
        reason: "default",
        valid: true,
      });
      assert.equal(isHybridRetrievalEnabled(), true);
      assert.equal(getHybridFusionMethod(), "rrf");
      assert.deepEqual(getRetrievalArchitectureConfig(), {
        hybridEnabled: true,
        hybridFusion: "rrf",
        vectorStoreProvider: "pgvector",
        vectorStoreProviderValid: true,
      });
    }
  );
});

test("an unknown provider fails closed everywhere instead of falling back to local", async () => {
  await withEnv({ VECTOR_STORE_PROVIDER: "faiss", ...noDatabase }, async () => {
    const status = getVectorStoreProviderConfigStatus();

    assert.equal(status.valid, false);
    assert.equal(status.provider, null);
    assert.equal(status.reason, "invalid_provider");
    assert.equal(status.rawValue, "faiss");
    assert.equal(getRetrievalArchitectureConfig().vectorStoreProvider, null);

    assert.throws(() => getVectorStoreProvider(), (error) => {
      assert.ok(error instanceof VectorStoreProviderConfigError);
      assert.equal(error.code, "VECTOR_STORE_PROVIDER_INVALID");
      assert.match(error.message, /must be one of local, pgvector, qdrant/);
      assert.match(error.message, /Refusing to fall back/);
      return true;
    });
    assert.throws(() => describeVectorStoreRuntime(), VectorStoreProviderConfigError);
    await assert.rejects(
      searchDocuments({ queryVector: [1, 0], queryText: "x", docIds: ["doc"], topK: 1 }),
      VectorStoreProviderConfigError
    );
    await assert.rejects(
      addDocumentsToIndex({
        documents: [{ id: "doc:0", pageContent: "x", metadata: { docId: "doc" } }],
      }),
      VectorStoreProviderConfigError
    );
  });
});

test("provider values are matched case-insensitively but only inside the allowlist", async () => {
  await withEnv({ VECTOR_STORE_PROVIDER: " PgVector " }, () => {
    assert.equal(getVectorStoreProvider(), "pgvector");
    assert.equal(getVectorStoreProviderConfigStatus().reason, "env_configured");
  });
  await withEnv({ VECTOR_STORE_PROVIDER: "pgvector2" }, () => {
    assert.throws(() => getVectorStoreProvider(), VectorStoreProviderConfigError);
  });
});

test("local and qdrant stay available as explicit opt-ins with their own route backends", async () => {
  await withEnv({ VECTOR_STORE_PROVIDER: "local", RAG_HYBRID_ENABLED: "true" }, () => {
    assert.deepEqual(describeVectorStoreRuntime(), {
      denseBackend: "local_json_cosine",
      hybridEnabled: true,
      hybridFusion: "rrf",
      sparseBackend: "local_json_bm25",
      transactional: false,
      vectorStoreProvider: "local",
    });
  });
  await withEnv({ VECTOR_STORE_PROVIDER: "qdrant", RAG_HYBRID_ENABLED: "false" }, () => {
    assert.deepEqual(describeVectorStoreRuntime(), {
      denseBackend: "qdrant_dense",
      hybridEnabled: false,
      hybridFusion: null,
      sparseBackend: null,
      transactional: false,
      vectorStoreProvider: "qdrant",
    });
  });
  await withEnv({ VECTOR_STORE_PROVIDER: "pgvector", ...noDatabase }, () => {
    // Describing the runtime never touches the database.
    assert.deepEqual(describeVectorStoreRuntime(), {
      denseBackend: "pgvector_cosine",
      hybridEnabled: true,
      hybridFusion: "rrf",
      sparseBackend: "postgres_fts_ts_rank_cd",
      transactional: true,
      vectorStoreProvider: "pgvector",
    });
  });
  assert.deepEqual(Object.values(VECTOR_STORE_PROVIDERS).sort(), ["local", "pgvector", "qdrant"]);
});

test("pgvector without a database URL refuses to search or ingest rather than using another index", async () => {
  await withEnv({ VECTOR_STORE_PROVIDER: "pgvector", RAG_HYBRID_ENABLED: "true", ...noDatabase }, async () => {
    resetVectorStore();

    await assert.rejects(
      searchDocumentsWithRoutes({
        queryVector: new Array(1536).fill(0),
        queryText: "anything",
        docIds: ["doc-1"],
        topK: 3,
      }),
      (error) => {
        assert.equal(error.code, "PGVECTOR_UNAVAILABLE");
        assert.match(error.message, /requires POSTGRES_DATABASE_URL/);
        assert.match(error.message, /Refusing to fall back to the local index/);
        return true;
      }
    );

    configureOpenAIProvider({
      embedTexts: async (texts) => texts.map(() => new Array(1536).fill(0.5)),
    });

    try {
      await assert.rejects(
        addDocumentsToIndex({
          documents: [{ id: "doc-1:0", pageContent: "alpha", metadata: { docId: "doc-1", chunkIndex: 0 } }],
        }),
        /requires POSTGRES_DATABASE_URL/
      );
    } finally {
      resetOpenAIProvider();
    }
  });
});

test("the local provider keeps working end to end as an explicit opt-in", async () => {
  const originalDirectory = getRagDataDirectory();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vector-provider-local-"));

  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map((text) => [text.includes("alpha") ? 1 : 0, 1]),
    embedQuery: async () => [1, 1],
  });

  try {
    await withEnv(
      { VECTOR_STORE_PROVIDER: "local", RAG_HYBRID_ENABLED: "true", RAG_HYBRID_FUSION: "rrf" },
      async () => {
        resetVectorStore();
        await addDocumentsToIndex({
          documents: [
            { id: "doc-1:0", pageContent: "alpha policy", metadata: { docId: "doc-1", chunkIndex: 0, fileName: "a.pdf" } },
            { id: "doc-2:0", pageContent: "beta budget", metadata: { docId: "doc-2", chunkIndex: 0, fileName: "b.pdf" } },
          ],
        });

        const search = await searchDocumentsWithRoutes({
          queryVector: [1, 1],
          queryText: "alpha policy",
          docIds: ["doc-1", "doc-2"],
          topK: 2,
        });

        assert.equal(search.routes.dense.executed, true);
        assert.equal(search.routes.sparse.executed, true);
        assert.equal(search.results[0].document.metadata.docId, "doc-1");
      }
    );
  } finally {
    resetOpenAIProvider();
    resetVectorStore();
    configureRagDataDirectory(originalDirectory);
    resetVectorStore();
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("embedding dimensions resolve from the provider override, then env, then the model", async () => {
  await withEnv(
    { OPENAI_EMBEDDING_MODEL: undefined, RAG_EMBEDDING_DIMENSIONS: undefined },
    () => {
      try {
        configureEmbeddingDimensions(64);
        assert.deepEqual(getEmbeddingDimensionsConfigStatus(), {
          dimensions: 64,
          source: "provider_override",
        });
      } finally {
        configureEmbeddingDimensions(null);
      }

      assert.deepEqual(getEmbeddingDimensionsConfigStatus(), {
        dimensions: 1536,
        source: "model",
      });
    }
  );
  await withEnv({ OPENAI_EMBEDDING_MODEL: "text-embedding-3-large", RAG_EMBEDDING_DIMENSIONS: undefined }, () => {
    assert.deepEqual(getEmbeddingDimensionsConfigStatus(), { dimensions: 3072, source: "model" });
  });
  await withEnv({ OPENAI_EMBEDDING_MODEL: "some-custom-model", RAG_EMBEDDING_DIMENSIONS: "768" }, () => {
    assert.deepEqual(getEmbeddingDimensionsConfigStatus(), { dimensions: 768, source: "env" });
  });
  await withEnv({ OPENAI_EMBEDDING_MODEL: "some-custom-model", RAG_EMBEDDING_DIMENSIONS: "not-a-number" }, () => {
    assert.deepEqual(getEmbeddingDimensionsConfigStatus(), { dimensions: 1536, source: "default" });
  });
});

test("vector:reindex prints usage and refuses to run against a non-pgvector provider", () => {
  const help = spawnSync(process.execPath, ["vector-reindex.mjs", "--help"], {
    cwd: serverDirectory,
    encoding: "utf8",
  });

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node vector-reindex\.mjs/);
  assert.match(help.stdout, /dry run/);

  const refused = spawnSync(process.execPath, ["vector-reindex.mjs"], {
    cwd: serverDirectory,
    encoding: "utf8",
    env: { ...process.env, VECTOR_STORE_PROVIDER: "local" },
  });

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Set VECTOR_STORE_PROVIDER=pgvector first/);

  const unknown = spawnSync(process.execPath, ["vector-reindex.mjs", "--from", "csv"], {
    cwd: serverDirectory,
    encoding: "utf8",
    env: { ...process.env, VECTOR_STORE_PROVIDER: "pgvector" },
  });

  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--from must be local, qdrant, or documents/);
});
