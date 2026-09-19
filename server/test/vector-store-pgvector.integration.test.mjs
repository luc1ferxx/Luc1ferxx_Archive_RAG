import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Real-database integration suite for the default retrieval stack. It needs a
// PostgreSQL with the pgvector extension and runs only when
// PGVECTOR_TEST_DATABASE_URL points at one (CI provides pgvector/pgvector:pg16).
// Locally, the docker-free runner `scripts/run-pgvector-integration.sh`
// provisions a throwaway cluster on an OS-assigned port, exports
// PGVECTOR_TEST_DATABASE_URL, runs this suite, and tears the cluster down; or
// export PGVECTOR_TEST_DATABASE_URL yourself to point at any pgvector database.
// Without it the suite is reported as skipped -- never as passed.
//
// The database is treated as disposable: documents are cleared before and
// after the run.

const databaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

if (!databaseUrl) {
  test("pgvector integration suite", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` (docker-free, auto-provisions a throwaway cluster) or export PGVECTOR_TEST_DATABASE_URL to run the real-database suite",
  }, () => {});
} else {
  process.env.POSTGRES_DATABASE_URL = databaseUrl;
  process.env.LONG_MEMORY_DATABASE_URL = databaseUrl;
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.RAG_HYBRID_ENABLED = "true";
  process.env.RAG_HYBRID_FUSION = "rrf";
  process.env.RAG_LONG_MEMORY_ENABLED = "false";
  process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED = "false";
  process.env.SESSION_MEMORY_STORE_PROVIDER = "memory";
  process.env.OPENAI_EMBEDDING_MODEL = "integration-test-embedding";
  process.env.RAG_EMBEDDING_DIMENSIONS = "8";
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "integration-test-key";

  const [
    { buildHealthReport },
    { configureEmbeddingDimensions, getVectorStoreProvider },
    { initializeDocumentRegistry, resetDocumentRegistry, resetDocumentRegistryStore, listDocuments },
    { executeDocumentRag },
    ragModule,
    { configureSessionMemoryStore, resetSessionMemory },
    { configureOpenAIProvider, resetOpenAIProvider },
    { queryPostgres, resetPostgresPool, withPostgresTransaction },
    { resetPostgresMigrations },
    vectorStore,
    pgvector,
    { mergeRetrievedResults, tagResultsWithQuery },
  ] = await Promise.all([
    import("../health.js"),
    import("../rag/config.js"),
    import("../rag/doc-registry.js"),
    import("../rag/document-rag-execution.js"),
    import("../rag/index.js"),
    import("../rag/memory.js"),
    import("../rag/openai.js"),
    import("../rag/postgres.js"),
    import("../rag/db-migrations.js"),
    import("../rag/vector-store.js"),
    import("../rag/vector-store-pgvector.js"),
    import("../rag/document-rag-execution.js"),
  ]);
  const chat = ragModule.default;
  const { clearDocuments, deleteDocument, ingestDocumentPages } = ragModule;

  const TOPICS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
  const embed = (text) => {
    const lower = String(text).toLowerCase();

    return [...TOPICS.map((topic) => (lower.includes(topic) ? 1 : 0)), 0.05];
  };
  const answerFromPrompt = async (prompt) => {
    const sourceMatch = String(prompt).match(/\[Source 1\][^\n]*\n([^\n]+)/);

    return `${sourceMatch?.[1]?.trim() ?? "The documents describe the policy."} [Source 1]`;
  };

  const createInMemorySessionStore = () => {
    const sessions = new Map();

    return {
      async initialize() {
        return true;
      },
      async get(sessionId) {
        return sessions.get(sessionId) ?? null;
      },
      async upsert({ sessionId, messages, updatedAt = Date.now() }) {
        const session = { messages: structuredClone(messages ?? []), updatedAt };

        sessions.set(sessionId, session);
        return session;
      },
      async delete(sessionId) {
        return sessions.delete(sessionId);
      },
      async clearAll() {
        sessions.clear();
        return 0;
      },
      async reset() {
        sessions.clear();
        return true;
      },
    };
  };

  let tempRoot;
  let sourceFilePath;

  const ingest = ({ docId, fileName, pages, workspaceId = "" }) =>
    ingestDocumentPages({
      docId,
      fileName,
      filePath: sourceFilePath,
      pages,
      workspaceId,
    });

  const chunkCount = (docIds = null) => pgvector.countPgvectorChunks({ docIds });

  const resultKeys = (results) =>
    results.map((result) => `${result.document.metadata.docId}:${result.document.metadata.chunkIndex}`);

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pgvector-integration-"));
    sourceFilePath = path.join(tempRoot, "source.pdf");
    await writeFile(sourceFilePath, "%PDF-1.4 integration fixture");
    configureEmbeddingDimensions(8);
    configureOpenAIProvider({
      completeText: answerFromPrompt,
      embedQuery: async (query) => embed(query),
      embedTexts: async (texts) => texts.map(embed),
    });
    await resetDocumentRegistryStore();
    configureSessionMemoryStore(createInMemorySessionStore());
    resetSessionMemory();
    resetPostgresMigrations();
    vectorStore.resetVectorStore();
    await initializeDocumentRegistry();
    await clearDocuments();
  });

  after(async () => {
    try {
      await clearDocuments();
    } finally {
      resetOpenAIProvider();
      configureEmbeddingDimensions(null);
      vectorStore.resetVectorStore();
      await resetDocumentRegistryStore();
      await resetPostgresPool();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("pgvector is the resolved default and the migration installs extension, table and indexes", async () => {
    assert.equal(getVectorStoreProvider(), "pgvector");
    await pgvector.ensurePgvectorSchema({ force: true });

    const status = await pgvector.describePgvectorStatus();

    assert.equal(status.reachable, true);
    assert.equal(status.extension.installed, true);
    assert.equal(status.table.exists, true);
    assert.deepEqual(status.indexes, {
      docId: true,
      embedding: true,
      embeddingModel: true,
      scope: true,
      searchVector: true,
    });
    assert.equal(status.embedding.columnDimensions, 8);
    assert.equal(status.embedding.matches, true);

    const constraints = await queryPostgres(
      `SELECT conname, contype, confdeltype FROM pg_constraint WHERE conrelid = 'rag_document_chunks'::regclass ORDER BY conname`
    );
    const foreignKey = constraints.rows.find((row) => row.contype === "f");
    const unique = constraints.rows.find((row) => row.contype === "u");

    assert.ok(foreignKey, "chunk table has a foreign key to the document table");
    assert.equal(foreignKey.confdeltype, "c", "foreign key cascades on delete");
    assert.ok(unique, "chunk table has the (doc_id, chunk_index) unique constraint");

    // Migrations are idempotent: running them again applies nothing new.
    resetPostgresMigrations();
    await pgvector.ensurePgvectorSchema({ force: true });
  });

  test("ingest writes registry row and chunks together; search runs both routes; delete and clear cascade", async () => {
    await ingest({
      docId: "it-alpha",
      fileName: "alpha.pdf",
      pages: [
        "Alpha policy: remote work needs alpha approval from a manager.",
        "Gamma renewal window is twelve months after the audit.",
      ],
    });
    await ingest({
      docId: "it-beta",
      fileName: "beta.pdf",
      pages: ["Beta budget caps meals at forty dollars per day."],
    });

    assert.equal(await chunkCount(["it-alpha"]), 2);
    assert.equal(await chunkCount(["it-beta"]), 1);
    assert.deepEqual(
      listDocuments().map((document) => document.docId).sort(),
      ["it-alpha", "it-beta"]
    );

    const search = await vectorStore.searchDocumentsWithRoutes({
      queryVector: embed("alpha approval"),
      queryText: "alpha approval policy",
      docIds: ["it-alpha", "it-beta"],
      topK: 3,
    });

    assert.equal(search.routes.dense.executed, true);
    assert.equal(search.routes.sparse.executed, true);
    assert.ok(search.routes.dense.candidateCount > 0);
    assert.ok(search.routes.sparse.candidateCount > 0);
    assert.equal(search.results[0].document.metadata.docId, "it-alpha");
    assert.equal(search.results[0].document.metadata.chunkIndex, 0);
    assert.deepEqual(
      search.results[0].provenance.routes.map((route) => route.route),
      ["dense", "sparse"]
    );
    assert.equal(search.results[0].provenance.fusion.method, "rrf");

    // Re-ingesting the same docId replaces its chunks instead of duplicating them.
    await ingest({ docId: "it-beta", fileName: "beta.pdf", pages: ["Beta budget caps meals at forty dollars per day.", "Beta travel needs director approval."] });
    assert.equal(await chunkCount(["it-beta"]), 2);
    assert.equal(listDocuments().length, 2);

    // Delete removes the row and, through the cascade, every chunk.
    await deleteDocument("it-beta");
    assert.equal(await chunkCount(["it-beta"]), 0);
    assert.equal(listDocuments().some((document) => document.docId === "it-beta"), false);

    const health = await buildHealthReport();

    assert.equal(health.checks.vectorStore.status, "ok", health.checks.vectorStore.message);
    assert.equal(health.checks.vectorStore.provider, "pgvector");
    assert.equal(health.checks.vectorStore.embedding.matches, true);
  });

  test("the index survives a process restart", async () => {
    vectorStore.resetVectorStore();
    await resetDocumentRegistry();
    await initializeDocumentRegistry();

    const search = await vectorStore.searchDocumentsWithRoutes({
      queryVector: embed("gamma renewal"),
      queryText: "renewal window",
      docIds: ["it-alpha"],
      topK: 2,
    });

    assert.equal(search.results[0].document.metadata.chunkIndex, 1);
    assert.equal(listDocuments().some((document) => document.docId === "it-alpha"), true);
  });

  test("a failed write rolls back every chunk in the transaction and the foreign key refuses orphans", async () => {
    const preparedDocuments = await pgvector.prepareDocumentsForPgvectorIndex({
      documents: [
        { id: "it-alpha:9", metadata: { chunkIndex: 9, docId: "it-alpha", fileName: "alpha.pdf", pageNumber: 9 }, pageContent: "Alpha addendum." },
      ],
    });

    await assert.rejects(
      withPostgresTransaction(async (client) => {
        await pgvector.writeDocumentsToPgvectorIndex({ client, preparedDocuments });
        assert.equal(await chunkCount(["it-alpha"]), 2, "the delete-then-insert is visible inside the transaction only");
        throw new Error("simulated failure after the chunk write");
      }),
      /simulated failure/
    );
    assert.equal(await chunkCount(["it-alpha"]), 2, "rollback restored the original chunks");

    const orphan = await pgvector.prepareDocumentsForPgvectorIndex({
      documents: [
        { id: "it-missing:0", metadata: { chunkIndex: 0, docId: "it-missing", fileName: "missing.pdf", pageNumber: 1 }, pageContent: "No registry row." },
      ],
    });

    await assert.rejects(
      withPostgresTransaction((client) =>
        pgvector.writeDocumentsToPgvectorIndex({ client, preparedDocuments: orphan })
      ),
      /foreign key/i
    );
    assert.equal(await chunkCount(["it-missing"]), 0);
  });

  test("lexical-only and semantic-only candidates both surface and fusion is stable and deduplicated", async () => {
    await ingest({ docId: "it-beta", fileName: "beta.pdf", pages: ["Beta budget caps meals at forty dollars per day."] });

    const run = () =>
      vectorStore.searchDocumentsWithRoutes({
        queryVector: embed("gamma"),
        queryText: "beta budget meals",
        docIds: ["it-alpha", "it-beta"],
        topK: 4,
      });
    const first = await run();
    const second = await run();
    const keys = resultKeys(first.results);

    assert.ok(keys.includes("it-alpha:1"), `semantic candidate missing from ${keys}`);
    assert.ok(keys.includes("it-beta:0"), `lexical candidate missing from ${keys}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(resultKeys(second.results), keys);

    const semanticOnly = first.results.find((result) => resultKeys([result])[0] === "it-alpha:1");
    const lexicalOnly = first.results.find((result) => resultKeys([result])[0] === "it-beta:0");

    assert.deepEqual(semanticOnly.provenance.routes.map((route) => route.route), ["dense"]);
    assert.ok(lexicalOnly.provenance.routes.some((route) => route.route === "sparse"));
    assert.ok(lexicalOnly.sparseScore > 0);
  });

  test("multi-query retrieval records every query in the provenance and the response reports both routes", async () => {
    const execution = await executeDocumentRag({
      agentRetrievalPlan: {
        retrievalQueries: [
          { id: "primary", label: "primary", primary: true, query: "alpha approval" },
          { id: "renewal", label: "renewal", primary: false, query: "gamma renewal window" },
        ],
        retrievalOptions: { topK: 3 },
        source: "integration-test",
      },
      docIds: ["it-alpha", "it-beta"],
      query: "alpha approval",
      resolvedQuery: "alpha approval",
      selectedDocuments: listDocuments(),
    });

    assert.equal(execution.routeMode, "qa");
    assert.equal(execution.traceFields.retrieval.queryCount, 2);
    assert.equal(execution.traceFields.retrieval.vectorStoreProvider, "pgvector");
    assert.equal(execution.traceFields.retrieval.hybridFusion, "rrf");
    assert.equal(execution.traceFields.retrieval.routes.dense.queryCount, 2);
    assert.equal(execution.traceFields.retrieval.routes.sparse.queryCount, 2);
    assert.equal(execution.response.retrieval.routes.dense.executed, true);
    assert.equal(execution.response.retrieval.routes.sparse.executed, true);

    const traced = execution.traceFields.retrievalResults;
    const queryIds = new Set(
      traced.flatMap((result) => (result.provenance?.queries ?? []).map((query) => query.queryId))
    );

    assert.deepEqual([...queryIds].sort(), ["primary", "renewal"]);
    assert.ok(traced.every((result) => Array.isArray(result.provenance?.routes) && result.provenance.routes.length > 0));

    const merged = mergeRetrievedResults(
      tagResultsWithQuery(
        (await vectorStore.searchDocumentsWithRoutes({ queryVector: embed("alpha"), queryText: "alpha", docIds: ["it-alpha"], topK: 2 })).results,
        { id: "a", primary: true }
      ),
      tagResultsWithQuery(
        (await vectorStore.searchDocumentsWithRoutes({ queryVector: embed("alpha"), queryText: "alpha approval", docIds: ["it-alpha"], topK: 2 })).results,
        { id: "b", primary: false }
      )
    );

    assert.equal(new Set(resultKeys(merged)).size, merged.length);
    assert.ok(merged.some((result) => (result.provenance.queries ?? []).length === 2));
  });

  test("comparison retrieval stays balanced per document", async () => {
    const execution = await executeDocumentRag({
      docIds: ["it-alpha", "it-beta"],
      query: "Compare the alpha approval policy with the beta budget policy",
      resolvedQuery: "Compare the alpha approval policy with the beta budget policy",
      selectedDocuments: listDocuments(),
    });

    assert.equal(execution.routeMode, "compare");

    for (const docId of ["it-alpha", "it-beta"]) {
      const results = execution.traceFields.perDocumentResults[docId] ?? [];

      assert.ok(results.length >= 1, `${docId} contributed evidence`);
      assert.ok(results.every((result) => result.docId === docId));
    }

    assert.equal(execution.traceFields.retrieval.routes.dense.executed, true);
    assert.equal(execution.traceFields.retrieval.routes.sparse.executed, true);
  });

  test("access scope isolates documents and their chunks", async () => {
    await ingest({
      docId: "it-scoped",
      fileName: "scoped.pdf",
      pages: ["Delta clause: scoped workspace document."],
      workspaceId: "workspace-b",
    });

    const rows = await queryPostgres(
      `SELECT workspace_id FROM rag_document_chunks WHERE doc_id = $1`,
      ["it-scoped"]
    );

    assert.ok(rows.rows.length >= 1);
    assert.ok(rows.rows.every((row) => row.workspace_id === "workspace-b"));

    await assert.rejects(
      chat(["it-scoped"], "What is the delta clause?", { accessScope: { workspaceId: "workspace-a" } }),
      (error) => error.status === 404
    );

    const response = await chat(["it-scoped"], "What is the delta clause?", {
      accessScope: { workspaceId: "workspace-b" },
      includeRetrievedContexts: true,
    });

    assert.equal(response.retrieval.vectorStoreProvider, "pgvector");
    assert.equal(response.retrieval.routes.dense.executed, true);
    assert.equal(response.retrieval.routes.sparse.executed, true);

    await clearDocuments({ accessScope: { workspaceId: "workspace-b" } });
    assert.equal(await chunkCount(["it-scoped"]), 0);
    assert.ok(await chunkCount(["it-alpha"]) > 0, "other scopes are untouched by a scoped clear");
  });

  test("a changed embedding width fails explicitly and asks for a reindex", async () => {
    configureEmbeddingDimensions(9);
    pgvector.resetPgvectorVectorStore();

    try {
      await assert.rejects(
        vectorStore.searchDocumentsWithRoutes({
          queryVector: [...embed("alpha"), 0],
          queryText: "alpha",
          docIds: ["it-alpha"],
          topK: 1,
        }),
        (error) => {
          assert.equal(error.code, "EMBEDDING_DIMENSION_MISMATCH");
          assert.match(error.message, /vector:reindex/);
          return true;
        }
      );
    } finally {
      configureEmbeddingDimensions(8);
      pgvector.resetPgvectorVectorStore();
    }
  });

  test("clear empties the chunk table and the registry together", async () => {
    await clearDocuments();

    assert.equal(await chunkCount(), 0);
    assert.equal(listDocuments().length, 0);

    const documents = await queryPostgres(`SELECT COUNT(*)::int AS count FROM rag_documents`);

    assert.equal(documents.rows[0].count, 0);
  });
}
