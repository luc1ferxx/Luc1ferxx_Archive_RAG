import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { configureEmbeddingDimensions } from "../rag/config.js";
import {
  createEmbeddingBatcher,
  getDefaultEmbeddingBatcher,
  resetDefaultEmbeddingBatcher,
} from "../rag/ingest-embedding-batcher.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import {
  configurePgvectorRuntime,
  embedDocumentsInSpace,
  getActivePgvectorVersion,
  resetPgvectorRuntime,
  resetPgvectorVectorStore,
} from "../rag/vector-store-pgvector.js";
import {
  activateIndexVersion,
  assertIndexVersionsSupported,
  claimIndexVersionBuild,
  createDefaultBuilderId,
  createIndexVersion,
  loadStoredDocumentPages,
  resolveBuildEmbeddingBatcher,
  resolveBuildEmbeddingSpace,
  resumeIndexVersionBuild,
  retireIndexVersion,
  rollbackIndexVersion,
  runBuildDocuments,
  runIndexVersionBuild,
  runIndexVersionRecallProbe,
  startIndexVersionBuild,
  validateIndexVersion,
} from "../rag/vector-store-pgvector-version-lifecycle.js";
import {
  INDEX_VERSION_ERROR_CODES,
  buildEmbeddingSpace,
  readIndexVersionSnapshot,
  toIndexVersion,
} from "../rag/vector-store-pgvector-versions.js";
import { createFakeVersionDatabase, loadFakePages } from "./pgvector-version-fake-database.mjs";

// Database-free tests of the index-version lifecycle: creation DDL and
// registration, the leased and resumable build, the activation gate and its
// recall probe, the pointer switch, rollback and retire. The fake database
// (pgvector-version-fake-database.mjs) answers the registry statements; the
// PostgreSQL behaviour is covered by the integration suite.

const MODEL = "unit-embed-a";
const NEW_MODEL = "unit-embed-b";
const TOPICS = ["alpha", "beta", "gamma", "delta", "epsilon"];
const ENV_KEYS = [
  "OPENAI_EMBEDDING_MODEL",
  "RAG_EMBEDDING_DOCUMENT_PREFIX",
  "RAG_EMBEDDING_QUERY_PREFIX",
  "RAG_INGEST_EMBED_BATCHING",
  "RAG_LLM_MAX_CONCURRENCY",
  "RAG_INDEX_VERSION_POINTER_TTL_MS",
  "VECTOR_STORE_PROVIDER",
];
let savedEnv;

const embedTopic = (text, dimensions) => {
  const lower = String(text).toLowerCase();

  return Array.from({ length: dimensions }, (_, index) => (lower.includes(TOPICS[index] ?? "~") ? 1 : 0.01));
};

const useProvider = ({ dimensionsFor = (space) => space?.dimensions ?? 4, fail = null } = {}) => {
  const calls = [];

  configureOpenAIProvider({
    embedQuery: async (text, options) => {
      calls.push({ kind: "query", model: options?.embeddingSpace?.model ?? MODEL, text });
      return embedTopic(text, dimensionsFor(options?.embeddingSpace));
    },
    embedTexts: async (texts, options) => {
      calls.push({ kind: "documents", model: options?.embeddingSpace?.model ?? MODEL, texts });

      if (fail) {
        throw fail;
      }

      return texts.map((text) => embedTopic(text, dimensionsFor(options?.embeddingSpace)));
    },
  });
  return calls;
};

const useDatabase = (options) => {
  const database = createFakeVersionDatabase(options);

  configurePgvectorRuntime(database.runtime);
  return database;
};

const NEW_SPACE = () => buildEmbeddingSpace({ dimensions: 3, model: NEW_MODEL });

// Version 1's table holds each document's chunks, as ingest would have written them.
const seedActiveChunks = (database, docId, texts, { model = MODEL, owner = "" } = {}) => {
  texts.forEach((text, index) => {
    database.state.tables.get("rag_document_chunks").rows.set(`${docId}:${index}`, {
      chunk_id: `${docId}:${index}`,
      content: text,
      doc_id: docId,
      embedding: `[${embedTopic(text, 4).join(",")}]`,
      embedding_dimensions: 4,
      embedding_model: model,
      owner_user_id: owner,
      search_text: text,
    });
  });
};

const seedDocuments = (database) => {
  database.addDocument({ docId: "doc-a", owner: "alice", pages: ["Alpha policy needs approval."] });
  database.addDocument({ docId: "doc-b", owner: "bob", pages: ["Beta budget caps meals."] });
  seedActiveChunks(database, "doc-a", ["Alpha policy needs approval."], { owner: "alice" });
  seedActiveChunks(database, "doc-b", ["Beta budget caps meals."], { owner: "bob" });
};

const build = (options = {}) =>
  startIndexVersionBuild({ builderId: "builder-1", loadPages: loadFakePages, space: NEW_SPACE(), ...options });

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  process.env.OPENAI_EMBEDDING_MODEL = MODEL;
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  process.env.RAG_INDEX_VERSION_POINTER_TTL_MS = "1000";
  configureEmbeddingDimensions(4);
  resetPgvectorVectorStore();
});

afterEach(() => {
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
// Space and provider
// ---------------------------------------------------------------------------

test("a new version's space defaults to the configuration; another model brings its prefixes and known width", () => {
  assert.equal(resolveBuildEmbeddingSpace().key, `${MODEL}|4`);
  assert.equal(resolveBuildEmbeddingSpace({ dimensions: 8 }).key, `${MODEL}|8`);
  assert.equal(resolveBuildEmbeddingSpace({ model: "text-embedding-3-large" }).dimensions, 3072);

  const nomic = resolveBuildEmbeddingSpace({ dimensions: 768, model: "nomic-embed-text" });

  assert.equal(nomic.identity, "nomic-embed-text#search_document:");
  assert.equal(nomic.queryPrefix, "search_query: ");
  assert.equal(
    resolveBuildEmbeddingSpace({ dimensions: 768, documentPrefix: "", model: "nomic-embed-text" }).identity,
    "nomic-embed-text"
  );
  assert.throws(() => resolveBuildEmbeddingSpace({ model: "mystery-model" }), /pass --dimensions/);
  assert.throws(() => resolveBuildEmbeddingSpace({ dimensions: -2, model: "mystery-model" }), /pass --dimensions/);
  assert.match(createDefaultBuilderId(), /^.+:\d+:[0-9a-f]{8}$/);
});

test("index versions refuse the local and Qdrant providers", async () => {
  process.env.VECTOR_STORE_PROVIDER = "local";
  assert.throws(assertIndexVersionsSupported, { code: INDEX_VERSION_ERROR_CODES.unsupportedProvider });
  await assert.rejects(createIndexVersion(), /vector:reindex rewrites in place/);
  await assert.rejects(retireIndexVersion({ versionId: 2 }), { code: INDEX_VERSION_ERROR_CODES.unsupportedProvider });
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test("creating a version locks, renders its table and registers it building, all in one transaction", async () => {
  const calls = useProvider();
  const database = useDatabase();
  const version = await createIndexVersion({
    builderId: "builder-1",
    indexParams: { hnswM: 24 },
    leaseMs: 5000,
    space: NEW_SPACE(),
  });

  assert.equal(version.versionId, 2);
  assert.equal(version.status, "building");
  assert.equal(version.chunkTable, "rag_document_chunks_v2");
  assert.equal(version.sparseRankFunction, "rag_document_chunks_v2_sparse_rank");
  assert.equal(version.builderId, "builder-1");
  assert.equal(version.pinnedSpace.key, `${NEW_MODEL}|3`);
  assert.equal(version.pinnedIndexParams.hnswM, 24);
  assert.equal(new Date(version.leaseExpiresAt).getTime(), database.clock.now + 5000);

  const statements = database.log.map(
    (entry) =>
      entry.tag ??
      (/CREATE TABLE rag_document_chunks_v2 \(/.test(entry.sql)
        ? "ddl"
        : /lock_timeout/.test(entry.sql)
          ? "lock_timeout"
          : entry.sql)
  );

  assert.deepEqual(statements.slice(0, 10), [
    "BEGIN",
    "lock_pointer",
    "lifecycle_lock",
    "find_building",
    "next_id",
    "relation_exists",
    "lock_timeout",
    "ddl",
    "register",
    "COMMIT",
  ]);
  assert.match(database.state.tables.get("rag_document_chunks_v2").ddl, /WITH \(m = 24/);
  // The new space was probed once, before any statement: its model answered at its width.
  assert.deepEqual(
    calls.map((call) => [call.kind, call.model, call.texts.length]),
    [["documents", NEW_MODEL, 1]]
  );

  await assert.rejects(createIndexVersion({ space: NEW_SPACE() }), (error) => {
    assert.equal(error.code, INDEX_VERSION_ERROR_CODES.buildInProgress);
    assert.equal(error.details.versionId, 2);
    return true;
  });
});

test("creation fails closed on an existing table, a missing version 1, a too-wide space and a missing database", async () => {
  useProvider();
  const database = useDatabase();

  database.state.tables.set("rag_document_chunks_v2", { dimensions: 3, rows: new Map() });
  await assert.rejects(createIndexVersion({ space: NEW_SPACE() }), /already exists outside the registry/);
  assert.equal(database.state.versions.size, 1, "nothing was registered");

  database.state.versions.clear();
  await assert.rejects(createIndexVersion({ space: NEW_SPACE() }), /holds no version 1/);

  await assert.rejects(
    createIndexVersion({ space: buildEmbeddingSpace({ dimensions: 3072, model: "wide" }) }),
    { code: "PGVECTOR_ANN_DIMENSION_UNSUPPORTED" }
  );

  configurePgvectorRuntime({ ...database.runtime, isPostgresConfigured: () => false });
  await assert.rejects(createIndexVersion({ space: NEW_SPACE() }), /need POSTGRES_DATABASE_URL/);
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

test("a build re-embeds every document into the new table, skips one deleted under it and re-reads one re-ingested under it", async () => {
  const calls = useProvider();
  const database = useDatabase();

  seedDocuments(database);
  database.addDocument({ docId: "doc-c", pages: "not pages" });
  database.addDocument({ docId: "doc-d", owner: "alice", pages: ["Delta clause."] });
  database.addDocument({ docId: "doc-e", owner: "alice", pages: ["Epsilon travel, first draft."] });

  const batches = [];
  const result = await build({
    batchSize: 2,
    hooks: {
      afterBatch: (summary) => batches.push(summary.indexed),
      beforeDocumentWrite: ({ attempt, docId }) => {
        if (docId === "doc-d") {
          database.state.documents.delete("doc-d");
        }

        if (docId === "doc-e" && attempt === 1) {
          database.addDocument({
            docId: "doc-e",
            owner: "alice",
            pages: ["Epsilon travel, final."],
            uploadedAt: "2026-01-02 00:00:00+00",
          });
        }
      },
    },
  });

  assert.deepEqual(
    { failed: result.failed, indexed: result.indexed, skippedDeleted: result.skippedDeleted, versionId: result.versionId },
    { failed: 1, indexed: 3, skippedDeleted: 1, versionId: 2 }
  );
  assert.equal(result.version.status, "ready");
  assert.equal(result.version.builderId, null);
  assert.equal(result.version.buildDocumentsDone, 4);
  assert.equal(result.version.buildDocumentsFailed, 1);
  assert.deepEqual(batches, [2, 2, 3]);

  const rows = [...database.state.tables.get("rag_document_chunks_v2").rows.values()];

  assert.deepEqual(
    rows.map((row) => [row.doc_id, row.owner_user_id, row.embedding_model, row.embedding_dimensions]),
    [
      ["doc-a", "alice", NEW_MODEL, 3],
      ["doc-b", "bob", NEW_MODEL, 3],
      ["doc-e", "alice", NEW_MODEL, 3],
    ]
  );
  assert.match(rows[2].content, /final/, "the re-ingested bytes, not the ones read first");
  assert.equal(rows[0].metadata.publicFilePath, "documents/doc-a/file");

  const progress = Object.fromEntries(
    [...database.state.progress.values()].map((entry) => [entry.doc_id, entry.outcome])
  );

  assert.deepEqual(progress, {
    "doc-a": "indexed",
    "doc-b": "indexed",
    "doc-c": "failed",
    "doc-d": "skipped_deleted",
    "doc-e": "indexed",
  });
  assert.match(
    [...database.state.progress.values()].find((entry) => entry.doc_id === "doc-c").error,
    /Parsing the stored PDF of doc-c failed/
  );
  assert.ok(calls.every((call) => call.model === NEW_MODEL), "only the new version's model embeds");
});

test("documents without bytes or text are recorded as failed, a document changing on every attempt too", async () => {
  useProvider();
  const database = useDatabase();

  database.addDocument({ docId: "doc-empty", pages: [] });
  database.addDocument({ docId: "doc-moving", pages: ["Gamma moves."] });
  database.state.documents.set("doc-nobytes", { ...database.state.documents.get("doc-empty"), doc_id: "doc-nobytes", file_bytes: null });

  let version = 0;
  const result = await build({
    hooks: {
      beforeDocumentWrite: ({ docId }) => {
        if (docId === "doc-moving") {
          version += 1;
          database.state.documents.get("doc-moving").uploaded_at = `2026-01-0${version + 1} 00:00:00+00`;
        }
      },
    },
    maxAttemptsPerDocument: 2,
  });
  const errors = Object.fromEntries(
    [...database.state.progress.values()].map((entry) => [entry.doc_id, entry.error])
  );

  assert.equal(result.failed, 3);
  assert.match(errors["doc-empty"], /No extractable text/);
  assert.match(errors["doc-nobytes"], /No PDF bytes are stored/);
  assert.match(errors["doc-moving"], /changed during each of 2 attempts/);
});

test("a resumed build skips the documents already committed and retries the failed ones", async () => {
  const calls = useProvider();
  const database = useDatabase();

  seedDocuments(database);
  database.addDocument({ docId: "doc-c", owner: "alice", pages: "broken" });

  // The first builder commits doc-a and doc-b, records doc-c as failed, then dies.
  await assert.rejects(
    build({
      hooks: {
        afterDocument: ({ docId }) => {
          if (docId === "doc-c") {
            throw new Error("process died");
          }
        },
      },
    }),
    /process died/
  );

  const stalled = database.state.versions.get(2);

  assert.equal(stalled.status, "building");
  assert.equal(stalled.builder_id, null, "an ordinary error releases the lease for resume");
  assert.equal(stalled.last_error, "process died");

  database.addDocument({ docId: "doc-c", owner: "alice", pages: ["Gamma, repaired."] });
  calls.length = 0;

  const resumed = await resumeIndexVersionBuild({ builderId: "builder-2", loadPages: loadFakePages });

  assert.equal(resumed.indexed, 1);
  assert.deepEqual(
    calls.map((call) => call.texts.join(" ")),
    ["Gamma, repaired."],
    "doc-a and doc-b are not embedded again"
  );
  assert.equal(resumed.version.status, "ready");
  await assert.rejects(resumeIndexVersionBuild(), { code: INDEX_VERSION_ERROR_CODES.notFound });
});

test("the lease: a live one keeps a second builder out, an expired one is taken over, and a stale builder is fenced out", async () => {
  useProvider();
  const database = useDatabase();

  seedDocuments(database);
  await createIndexVersion({ builderId: "builder-1", leaseMs: 1000, space: NEW_SPACE() });

  await assert.rejects(claimIndexVersionBuild({ builderId: "builder-2", versionId: 2 }), (error) => {
    assert.equal(error.code, INDEX_VERSION_ERROR_CODES.buildInProgress);
    assert.match(error.message, /being built by builder-1/);
    return true;
  });
  await assert.rejects(claimIndexVersionBuild({ builderId: "b", versionId: 9 }), { code: INDEX_VERSION_ERROR_CODES.notFound });
  await assert.rejects(runIndexVersionBuild({ versionId: "x" }), { code: INDEX_VERSION_ERROR_CODES.notFound });

  database.clock.now += 1001;

  // builder-2 takes the expired lease; builder-1 (still running somewhere)
  // is fenced out at its next write and leaves the version to builder-2.
  const run = runIndexVersionBuild({
    builderId: "builder-1",
    hooks: {
      beforeDocumentWrite: async () => {
        database.clock.now += 1001;
        await claimIndexVersionBuild({ builderId: "builder-2", versionId: 2 });
      },
    },
    leaseMs: 1000,
    loadPages: loadFakePages,
    versionId: 2,
  });

  await assert.rejects(run, (error) => {
    assert.equal(error.code, INDEX_VERSION_ERROR_CODES.leaseLost);
    return true;
  });
  assert.equal(database.state.versions.get(2).builder_id, "builder-2", "a fenced builder leaves the version alone");
  assert.equal(database.state.tables.get("rag_document_chunks_v2").rows.size, 0, "and wrote nothing");

  database.state.versions.get(2).status = "ready";
  await assert.rejects(claimIndexVersionBuild({ builderId: "builder-2", versionId: 2 }), /is ready, not building/);
});

// A provider whose document embeddings wait until the test releases them,
// so the tests see exactly which documents are in flight (no timing).
const useGatedProvider = () => {
  const gate = { calls: [], inFlight: 0, maxInFlight: 0, open: false, pending: [] };

  configureOpenAIProvider({
    embedQuery: async (text, options) => embedTopic(text, options?.embeddingSpace?.dimensions ?? 4),
    embedTexts: async (texts, options) => {
      const dimensions = options?.embeddingSpace?.dimensions ?? 4;

      gate.calls.push({ model: options?.embeddingSpace?.model ?? MODEL, texts });
      gate.inFlight += 1;
      gate.maxInFlight = Math.max(gate.maxInFlight, gate.inFlight);

      try {
        if (!gate.open) {
          await new Promise((resolve, reject) => gate.pending.push({ reject, resolve, texts }));
        }

        return texts.map((text) => embedTopic(text, dimensions));
      } finally {
        gate.inFlight -= 1;
      }
    },
  });
  gate.release = (entry) => {
    gate.pending.splice(gate.pending.indexOf(entry), 1);
    entry.resolve();
  };
  gate.openAll = () => {
    gate.open = true;
    gate.pending.splice(0).forEach((entry) => entry.resolve());
  };
  return gate;
};

// Lets every pending promise chain run (several macrotask turns).
const settle = async (turns = 20) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const waitFor = async (predicate, label) => {
  for (let turn = 0; turn < 500; turn += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail(`timed out waiting for ${label}`);
};

// The builder's batcher as a test wires it: the store's width-checked embedding, a cap of its own.
const createBuildBatcher = (maxConcurrency) =>
  createEmbeddingBatcher({ embed: (texts, space) => embedDocumentsInSpace(texts, space), maxConcurrency });

const seedTopicDocuments = (database, count) => {
  for (let index = 0; index < count; index += 1) {
    database.addDocument({ docId: `doc-${index}`, owner: "alice", pages: [`${TOPICS[index % TOPICS.length]} clause ${index}.`] });
  }
};

test("a build keeps `concurrency` documents in flight, each written in its own transaction with its progress row", async () => {
  useProvider();
  const database = useDatabase();
  const transactions = [];

  // Record which statements each transaction ran.
  configurePgvectorRuntime({
    ...database.runtime,
    withTransaction: (callback) =>
      database.runtime.withTransaction((client) => {
        const statements = [];

        transactions.push(statements);
        return callback({
          query: (sql, values) => {
            statements.push({ sql: String(sql).replace(/\s+/g, " "), values });
            return client.query(sql, values);
          },
        });
      }),
  });
  seedTopicDocuments(database, 5);
  await createIndexVersion({ builderId: "builder-1", space: NEW_SPACE() });

  const gate = useGatedProvider();
  const run = runIndexVersionBuild({
    batchSize: 2,
    batcher: createBuildBatcher(8),
    builderId: "builder-1",
    concurrency: 3,
    loadPages: loadFakePages,
    versionId: 2,
  });

  await waitFor(() => gate.pending.length === 3, "three documents embedding");
  await settle();
  assert.equal(gate.pending.length, 3, "a fourth document waits for a place");
  assert.equal(gate.maxInFlight, 3);
  assert.equal(database.state.versions.get(2).builder_id, "builder-1");

  // One finishes: exactly one more starts.
  gate.release(gate.pending[0]);
  await waitFor(() => gate.pending.length === 3 && gate.calls.length === 4, "the next document");
  gate.openAll();

  const result = await run;

  assert.equal(result.indexed, 5);
  assert.equal(result.version.status, "ready");
  assert.equal(gate.maxInFlight, 3, "never more than the concurrency");
  // With free slots under the cap every document's texts left alone.
  assert.deepEqual(gate.calls.map((call) => call.texts.length), [1, 1, 1, 1, 1]);
  assert.ok(gate.calls.every((call) => call.model === NEW_MODEL));

  const documentWrites = transactions.filter((statements) =>
    statements.some((statement) => statement.sql.includes("index_versions:progress"))
  );

  assert.equal(documentWrites.length, 5, "one transaction per document");

  for (const statements of documentWrites) {
    const [docId] = statements.find((statement) => statement.sql.includes("index_versions:lock_document")).values;

    // The document row first, then its chunks; the lease (the version row)
    // only after the chunk writes, right before the progress row, so it is
    // held from there to COMMIT and never while chunks are written.
    const tags = statements.map((statement) =>
      /index_versions:(\w+)/.exec(statement.sql)?.[1] ?? (/^ ?(DELETE|INSERT)/.exec(statement.sql)?.[1] ?? "other")
    );

    assert.equal(tags[0], "lock_document", "the document row is locked first");
    assert.deepEqual(tags.slice(-2), ["renew_lease", "progress"], "the lease is renewed last, fencing the write");
    assert.ok(
      tags.lastIndexOf("INSERT") < tags.indexOf("renew_lease"),
      `the chunk writes come before the version row is taken: ${tags.join(", ")}`
    );
    assert.deepEqual(
      statements.filter((statement) => statement.sql.includes("index_versions:progress")).map((statement) => statement.values[1]),
      [docId]
    );
    assert.ok(
      statements.some((statement) => /^ ?INSERT INTO rag_document_chunks_v2 /.test(statement.sql) && statement.values.includes(docId)),
      `${docId}'s chunks are written in its own transaction`
    );
  }

  assert.deepEqual(
    [...database.state.progress.values()].map((entry) => [entry.doc_id, entry.outcome]).sort(),
    [0, 1, 2, 3, 4].map((index) => [`doc-${index}`, "indexed"])
  );
});

test("the build's documents share embedding requests only when RAG_LLM_MAX_CONCURRENCY holds them back", async () => {
  useProvider();
  const database = useDatabase();

  seedTopicDocuments(database, 4);
  await createIndexVersion({ builderId: "builder-1", space: NEW_SPACE() });

  const gate = useGatedProvider();
  const batcher = createBuildBatcher(1);
  const run = runIndexVersionBuild({ batcher, builderId: "builder-1", concurrency: 4, loadPages: loadFakePages, versionId: 2 });

  // The first document takes the only slot; the other three queue behind it.
  await waitFor(() => gate.pending.length === 1 && batcher.stats().queuedTexts === 3, "three documents queued");
  gate.openAll();

  const result = await run;

  assert.equal(result.indexed, 4);
  assert.deepEqual(gate.calls.map((call) => call.texts.length), [1, 3], "the held-back documents left in one request");
  assert.equal(batcher.stats().batchedRequests, 1);
  assert.equal(database.state.tables.get("rag_document_chunks_v2").rows.size, 4);
});

test("RAG_INGEST_EMBED_BATCHING=false sends each of the build's documents as its own request, even under a cap of 1", async () => {
  useProvider();
  const database = useDatabase();

  process.env.RAG_INGEST_EMBED_BATCHING = "false";
  process.env.RAG_LLM_MAX_CONCURRENCY = "1";
  resetDefaultEmbeddingBatcher();
  seedTopicDocuments(database, 4);
  await createIndexVersion({ builderId: "builder-1", space: NEW_SPACE() });

  assert.notEqual(resolveBuildEmbeddingBatcher(), getDefaultEmbeddingBatcher(), "the switch bypasses the batcher");

  const gate = useGatedProvider();
  // No batcher passed: the build resolves its own from the configuration.
  const run = runIndexVersionBuild({ builderId: "builder-1", concurrency: 4, loadPages: loadFakePages, versionId: 2 });

  // A batcher under a cap of 1 would hold three documents back and merge
  // them; straight through, all four are in flight at once, one each.
  await waitFor(() => gate.pending.length === 4, "four documents embedding at once");
  gate.openAll();

  const result = await run;

  assert.equal(result.indexed, 4);
  assert.deepEqual(gate.calls.map((call) => call.texts.length), [1, 1, 1, 1]);
  assert.equal(getDefaultEmbeddingBatcher().stats().requests, 0, "the shared batcher sent nothing");

  // With the switch on (the default) the build uses the process's batcher.
  delete process.env.RAG_INGEST_EMBED_BATCHING;
  assert.equal(resolveBuildEmbeddingBatcher(), getDefaultEmbeddingBatcher());
  resetDefaultEmbeddingBatcher();
});

test("a failed document stops the build from taking more; the ones in flight settle before the lease is released; resume finishes the rest", async () => {
  useProvider();
  const database = useDatabase();

  seedTopicDocuments(database, 4);
  await createIndexVersion({ builderId: "builder-1", space: NEW_SPACE() });

  const gate = useGatedProvider();
  const run = runIndexVersionBuild({
    batcher: createBuildBatcher(8),
    builderId: "builder-1",
    concurrency: 2,
    loadPages: loadFakePages,
    versionId: 2,
  });
  const failed = run.then(
    () => null,
    (error) => error
  );

  await waitFor(() => gate.pending.length === 2, "two documents embedding");

  const [first, second] = [...gate.pending].sort((left, right) => left.texts[0].localeCompare(right.texts[0]));

  gate.pending.splice(gate.pending.indexOf(first), 1);
  first.reject(Object.assign(new Error("embeddings unavailable"), { status: 503 }));
  await settle();

  assert.equal(gate.calls.length, 2, "no document starts after the failure");
  assert.equal(database.state.versions.get(2).builder_id, "builder-1", "the lease is held while a document is in flight");

  gate.release(second);

  const error = await failed;

  assert.match(error?.message ?? "", /embeddings unavailable/);
  assert.equal(database.state.versions.get(2).status, "building");
  assert.equal(database.state.versions.get(2).builder_id, null, "released once nothing was in flight");
  assert.deepEqual(
    [...database.state.progress.values()].map((entry) => [entry.doc_id, entry.outcome]),
    [["doc-1", "indexed"]],
    "the document in flight committed; the failed one left no progress row"
  );

  const calls = useProvider();
  const resumed = await resumeIndexVersionBuild({ builderId: "builder-2", concurrency: 2, loadPages: loadFakePages });

  assert.equal(resumed.indexed, 3);
  assert.equal(resumed.version.status, "ready");
  assert.deepEqual(
    calls.flatMap((call) => call.texts).sort(),
    ["alpha clause 0.", "delta clause 3.", "gamma clause 2."],
    "only what has no progress row is embedded again"
  );
});

test("the document runner lists pages as it needs them and finishes them in order, serially at concurrency 1", async () => {
  const pages = [["a", "b"], ["c"], []];
  const events = [];

  await runBuildDocuments({
    concurrency: 1,
    finishPage: async () => events.push("page"),
    listPage: async () => {
      events.push("list");
      return pages.shift();
    },
    processDocument: async (docId) => events.push(docId),
  });
  assert.deepEqual(events, ["list", "a", "b", "page", "list", "c", "page", "list"]);

  // A later page that settles first waits for the earlier one.
  const release = {};
  const finished = [];
  const run = runBuildDocuments({
    concurrency: 2,
    finishPage: async () => finished.push(finished.length),
    listPage: (() => {
      const listed = [["slow"], ["fast"], []];

      return async () => listed.shift();
    })(),
    processDocument: (docId) =>
      docId === "slow" ? new Promise((resolve) => (release.slow = resolve)) : Promise.resolve(),
  });

  await waitFor(() => typeof release.slow === "function", "the slow document");
  await settle();
  assert.deepEqual(finished, [], "the fast page waits for the slow one before it");
  release.slow();
  await run;
  assert.deepEqual(finished, [0, 1]);
});

test("creation probes the new space: a model that is not served or answers at another width registers nothing", async () => {
  const database = useDatabase();

  seedDocuments(database);
  useProvider({ dimensionsFor: () => 7 });
  await assert.rejects(build(), (error) => {
    assert.equal(error.code, INDEX_VERSION_ERROR_CODES.invalidState);
    assert.match(error.message, /could not embed a probe text at 3 dimensions.*7 was observed/);
    return true;
  });
  useProvider({ fail: Object.assign(new Error("model not found"), { status: 404 }) });
  await assert.rejects(build(), /could not embed a probe text.*model not found/);
  assert.equal(database.state.versions.size, 1, "nothing was registered");
  assert.equal(database.state.tables.has("rag_document_chunks_v2"), false, "no DDL ran");
});

test("a width the model stops producing fails the version; an embedding outage leaves it resumable", async () => {
  useProvider();
  const database = useDatabase();

  seedDocuments(database);
  await createIndexVersion({ builderId: "builder-1", space: NEW_SPACE() });
  useProvider({ dimensionsFor: () => 7 });
  await assert.rejects(runIndexVersionBuild({ builderId: "builder-1", loadPages: loadFakePages, versionId: 2 }), {
    code: "EMBEDDING_DIMENSION_MISMATCH",
  });
  assert.equal(database.state.versions.get(2).status, "failed");
  assert.match(database.state.versions.get(2).last_error, /produces 3-dimensional vectors but 7/);

  await retireIndexVersion({ versionId: 2 });
  useProvider();
  await createIndexVersion({ builderId: "builder-1", space: NEW_SPACE() });
  useProvider({ fail: Object.assign(new Error("embeddings unavailable"), { status: 503 }) });
  await assert.rejects(
    runIndexVersionBuild({ builderId: "builder-1", loadPages: loadFakePages, versionId: 3 }),
    /embeddings unavailable/
  );
  assert.equal(database.state.versions.get(3).status, "building");
  assert.equal(database.state.versions.get(3).builder_id, null);
});

test("the default page loader parses the stored PDF bytes", async () => {
  const pages = await loadStoredDocumentPages({
    fileBuffer: buildTextPdf({ pages: [["Alpha page one."], ["Beta page two."]] }),
  });

  assert.deepEqual(pages.map((page) => page.text), ["Alpha page one.", "Beta page two."]);
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const builtVersion = async (database) => {
  useProvider();
  seedDocuments(database);
  return build();
};

test("the gate passes a complete version and names every reason it refuses one", async () => {
  const database = useDatabase();

  await builtVersion(database);

  const passed = await validateIndexVersion({ versionId: 2 });

  assert.equal(passed.ok, true, passed.reasons.join(" "));
  assert.deepEqual(passed.totals, { activeChunks: 2, documents: 2, targetChunks: 2 });
  assert.equal(passed.activeVersionId, 1);

  await assert.rejects(validateIndexVersion({ versionId: 7 }), { code: INDEX_VERSION_ERROR_CODES.notFound });
  assert.deepEqual((await validateIndexVersion({ versionId: 1 })).reasons, ["Version 1 is already active."]);

  // A missing chunk, and one too many.
  const table = database.state.tables.get("rag_document_chunks_v2");
  const [firstKey, firstRow] = [...table.rows.entries()][0];

  table.rows.delete(firstKey);
  seedActiveChunks(database, "doc-b", ["Beta budget caps meals.", "Beta extra."], { owner: "bob" });

  const drift = await validateIndexVersion({ versionId: 2 });

  assert.equal(drift.ok, false);
  assert.equal(drift.mismatchedDocuments, 2);
  assert.deepEqual(drift.mismatches, [
    { activeCount: 1, docId: "doc-a", targetCount: 0 },
    { activeCount: 2, docId: "doc-b", targetCount: 1 },
  ]);
  assert.match(drift.reasons[0], /2 document\(s\) have a different chunk count/);

  const tolerant = await validateIndexVersion({ allowChunkCountDrift: true, versionId: 2 });

  assert.deepEqual(tolerant.reasons.length, 1);
  assert.match(tolerant.reasons[0], /1 document\(s\) have no chunks in version 2 although the active version 1 has some .*doc-a 1->0/);

  table.rows.set(firstKey, { ...firstRow, embedding_model: "stray-model" });
  database.state.tables.get("rag_document_chunks").rows.delete("doc-b:1");
  table.dimensions = 5;

  const shape = await validateIndexVersion({ versionId: 2 });

  assert.match(shape.reasons.join(" "), /is vector\(5\), not the vector\(3\)/);
  assert.match(shape.reasons.join(" "), /holds chunks embedded as stray-model\/3/);

  database.state.versions.get(2).status = "building";
  assert.match((await validateIndexVersion({ versionId: 2 })).reasons[0], /is building; only a ready version/);

  database.state.versions.get(2).status = "ready";
  database.state.versions.get(2).dual_write_until = new Date(database.clock.now - 1);
  assert.match((await validateIndexVersion({ versionId: 2 })).reasons[0], /stopped receiving writes/);
});

test("the gate compares content versions: a replacement the version missed blocks it even at equal chunk counts", async () => {
  const database = useDatabase();

  await builtVersion(database);
  assert.equal((await validateIndexVersion({ versionId: 2 })).ok, true);

  // An instance running older code replaced doc-a (same chunk count) and wrote
  // the active version only: the registry says v2, version 2 still holds v1.
  database.state.documents.get("doc-a").content_version = 2;

  const report = await validateIndexVersion({ versionId: 2 });

  assert.equal(report.ok, false);
  assert.equal(report.mismatchedDocuments, 0, "the chunk counts agree");
  assert.equal(report.staleDocuments, 1);
  assert.deepEqual(report.stale, [{ docId: "doc-a", maxVersion: 1, minVersion: 1, registryVersion: 2 }]);
  assert.match(report.reasons.join(" "), /1 document\(s\) have chunks in version 2 cut from another content version .*doc-a v1, registry v2/);

  // Chunks written by a dual write of the replacement name their version.
  for (const row of database.state.tables.get("rag_document_chunks_v2").rows.values()) {
    if (row.doc_id === "doc-a") {
      row.metadata = { ...row.metadata, documentVersion: 2 };
    }
  }

  assert.equal((await validateIndexVersion({ versionId: 2 })).ok, true);
  await assert.rejects(activateIndexVersion({ versionId: 99 }), { code: INDEX_VERSION_ERROR_CODES.notFound });
});

test("the gate refuses to pin a configuration-following version whose rows another configuration wrote", async () => {
  const database = useDatabase();

  await builtVersion(database);
  process.env.OPENAI_EMBEDDING_MODEL = "configured-elsewhere";
  resetPgvectorVectorStore();

  const report = await validateIndexVersion({ versionId: 2 });

  assert.equal(report.ok, false);
  assert.match(report.reasons[0], /follows the configuration, which in this process names configured-elsewhere\/4/);
});

test("the recall probe measures self-retrieval and agreement with the active version", async () => {
  const database = useDatabase();

  await builtVersion(database);

  const [active, target] = await Promise.all([
    readIndexVersionSnapshot({ force: true }).then((snapshot) => snapshot.active),
    Promise.resolve(toIndexVersion(database.state.versions.get(2))),
  ]);
  const probe = await runIndexVersionRecallProbe({
    active,
    minRecall: 0.9,
    queries: ["alpha approval", { query: "beta meals" }, { question: "alpha" }, "  "],
    sampleSize: 2,
    target,
    topK: 1,
  });

  assert.equal(probe.passed, true);
  assert.deepEqual(probe.selfRetrieval, { hits: 2, recall: 1, sampled: 2 });
  assert.deepEqual(probe.queryAgreement, { meanAgreement: 1, minAgreement: 1, queries: 3 });

  // Scramble the candidate's vectors: nothing finds itself any more.
  for (const row of database.state.tables.get("rag_document_chunks_v2").rows.values()) {
    row.embedding = row.doc_id === "doc-a" ? "[0,1,0]" : "[1,0,0]";
  }

  const report = await validateIndexVersion({
    probe: { minRecall: 0.9, queries: ["alpha approval"], sampleSize: 2, topK: 1 },
    versionId: 2,
  });

  assert.equal(report.ok, false);
  assert.equal(report.probe.selfRetrieval.recall, 0);
  assert.equal(report.probe.queryAgreement.meanAgreement, 0);
  assert.match(report.reasons.at(-1), /recall probe stayed below 0.9/);
  assert.equal((await validateIndexVersion({ probe: { sampleSize: 0 }, versionId: 2 })).probe, null);
});

// ---------------------------------------------------------------------------
// Switch, rollback, retire
// ---------------------------------------------------------------------------

test("activation switches the pointer once, pins the configuration-following version and keeps it written for the grace period", async () => {
  const database = useDatabase();

  await builtVersion(database);
  database.log.length = 0;

  const result = await activateIndexVersion({ graceMs: 60_000, versionId: 2 });

  assert.equal(result.activeVersionId, 2);
  assert.equal(result.previousVersionId, 1);
  assert.equal(result.generation, 2);
  assert.equal(result.dualWriteGraceMs, 60_000);
  assert.equal(result.mode, "activate");
  assert.deepEqual(
    database.log
      .slice(database.log.findLastIndex((entry) => entry.sql === "BEGIN"))
      .map((entry) => entry.tag ?? entry.sql),
    [
      "BEGIN",
      "lock_pointer",
      "lock_versions",
      "lifecycle_lock",
      "switch_state",
      "read_version",
      "pin",
      "deactivate",
      "activate",
      "switch_pointer",
      "COMMIT",
    ]
  );

  const previous = database.state.versions.get(1);

  assert.equal(previous.status, "ready");
  assert.equal(previous.embedding_space_source, "pinned");
  assert.equal(previous.embedding_model, MODEL);
  assert.equal(previous.embedding_dimensions, 4);
  assert.equal(previous.dual_write_until.getTime(), database.clock.now + 60_000);
  assert.equal(database.state.versions.get(2).status, "active");
  assert.equal((await getActivePgvectorVersion()).versionId, 2, "this process sees the switch at once");

  // A grace period shorter than two pointer TTLs is raised to it.
  database.clock.now += 5000;
  const rollback = await rollbackIndexVersion({ graceMs: 1 });

  assert.equal(rollback.mode, "rollback");
  assert.equal(rollback.activeVersionId, 1);
  assert.equal(rollback.dualWriteGraceMs, 2000);
  assert.ok(!database.log.slice(-12).some((entry) => entry.tag === "pin"), "a pinned version is not pinned again");
});

test("activation refuses a version that fails the gate, a pointer that moved and a window that closed", async () => {
  const database = useDatabase();

  await builtVersion(database);
  database.state.tables.get("rag_document_chunks_v2").rows.clear();

  await assert.rejects(activateIndexVersion({ versionId: 2 }), (error) => {
    assert.equal(error.code, INDEX_VERSION_ERROR_CODES.validationFailed);
    assert.equal(error.details.validation.ok, false);
    return true;
  });
  assert.equal(database.state.pointer.active_version_id, 1);

  const fresh = useDatabase();

  await builtVersion(fresh);
  fresh.hooks.set("lock_pointer", () => {
    fresh.state.pointer.active_version_id = 3;
  });
  await assert.rejects(activateIndexVersion({ versionId: 2 }), /active version changed to 3/);
  fresh.hooks.delete("lock_pointer");
  fresh.state.pointer.active_version_id = 1;

  fresh.hooks.set("switch_state", () => {
    fresh.state.versions.get(2).dual_write_until = new Date(fresh.clock.now - 1);
  });
  await assert.rejects(activateIndexVersion({ versionId: 2 }), /no longer a ready version inside its write window/);
  assert.equal(fresh.state.versions.get(1).status, "active", "a refused switch changes nothing");
  await assert.rejects(activateIndexVersion({ versionId: 0 }), { code: INDEX_VERSION_ERROR_CODES.notFound });
});

test("rollback needs a previous version", async () => {
  useDatabase();
  await assert.rejects(rollbackIndexVersion(), /no previous index version/);
});

test("with the active table gone, rollback still runs on the target's own checks and never writes the missing table", async () => {
  const database = useDatabase();

  await builtVersion(database);
  await activateIndexVersion({ graceMs: 60_000, versionId: 2 });
  database.clock.now += 5000;

  // The active version's table is dropped by hand; searches fail everywhere.
  database.state.tables.delete("rag_document_chunks_v2");

  const refused = await validateIndexVersion({ versionId: 1 });

  assert.equal(refused.ok, false);
  assert.equal(refused.activeReadable, false);
  assert.match(refused.reasons.join(" "), /table rag_document_chunks_v2 does not exist.*--active-unreadable/);
  await assert.rejects(rollbackIndexVersion(), { code: INDEX_VERSION_ERROR_CODES.validationFailed });

  const rolledBack = await rollbackIndexVersion({ allowUnreadableActive: true });

  assert.equal(rolledBack.activeVersionId, 1);
  assert.equal(rolledBack.previousFailed, true);
  assert.equal(rolledBack.validation.mismatchedDocuments, null, "no comparison with the missing table");
  assert.equal(rolledBack.validation.totals.activeChunks, null);
  assert.equal(database.state.versions.get(2).status, "failed", "the missing table is no write target");
  assert.match(database.state.versions.get(2).last_error, /was missing/);
  assert.equal(database.state.versions.get(1).status, "active");

  // The target's own checks still apply: a target missing its content is refused.
  const other = useDatabase();

  await builtVersion(other);
  await activateIndexVersion({ graceMs: 60_000, versionId: 2 });
  other.clock.now += 5000;
  other.state.tables.delete("rag_document_chunks_v2");
  other.state.documents.get("doc-b").content_version = 3;
  await assert.rejects(rollbackIndexVersion({ allowUnreadableActive: true }), /cut from another content version/);
});

test("retire marks the version retired without DDL first, then drops it a short lock attempt at a time", async () => {
  const database = useDatabase();

  await builtVersion(database);
  database.log.length = 0;

  // Every attempt at the drop meets a lock it cannot get within its timeout.
  database.state.lockedTables = new Set(["rag_document_chunks_v2"]);

  const pending = await retireIndexVersion({ dropAttempts: 3, dropLockTimeoutMs: 50, dropRetryDelayMs: 1, versionId: 2 });

  assert.equal(pending.dropPending, true);
  assert.equal(pending.dropAttempts, 3);
  assert.equal(pending.droppedTable, false);
  assert.equal(database.state.versions.get(2).status, "retired", "retired, so no write goes to it any more");
  assert.equal(database.state.tables.has("rag_document_chunks_v2"), true);

  const transactions = [];
  let current = null;

  for (const entry of database.log) {
    if (entry.sql === "BEGIN") {
      current = [];
    } else if (entry.sql === "COMMIT" || entry.sql === "ROLLBACK") {
      transactions.push([...current, entry.sql]);
      current = null;
    } else if (current) {
      current.push(entry.tag ?? (/lock_timeout/.test(entry.sql) ? `lock_timeout=${entry.values[0]}` : /DROP/.test(entry.sql) ? "drop" : entry.sql));
    }
  }

  assert.deepEqual(transactions[0], [
    "lock_pointer",
    "lock_retire",
    "lifecycle_lock",
    "retire",
    "clear_progress",
    "clear_previous",
    "COMMIT",
  ], "the state change holds no documents-table lock");
  assert.deepEqual(transactions.slice(1), [
    ["lock_timeout=50ms", "drop", "ROLLBACK"],
    ["lock_timeout=50ms", "drop", "ROLLBACK"],
    ["lock_timeout=50ms", "drop", "ROLLBACK"],
  ]);

  // Running retire again finishes the drop once the lock is free.
  database.state.lockedTables.clear();

  const finished = await retireIndexVersion({ versionId: 2 });

  assert.equal(finished.droppedTable, true);
  assert.equal(finished.dropPending, false);
  assert.equal(finished.previousStatus, "retired");
  assert.equal(database.state.tables.has("rag_document_chunks_v2"), false);
  await assert.rejects(retireIndexVersion({ versionId: 2 }), /already retired/);

  // Errors other than a lock timeout are not retried.
  await build();
  database.state.versions.get(3).status = "ready";
  database.failNext("DROP FUNCTION IF EXISTS rag_document_chunks_v3_sparse_rank(tsquery, text[], integer); DROP TABLE IF EXISTS rag_document_chunks_v3;", new Error("disk full"));
  await assert.rejects(retireIndexVersion({ dropRetryDelayMs: 1, versionId: 3 }), /disk full/);
  assert.equal(database.state.versions.get(3).status, "retired");
});

test("the retire window and the grace floor use the longest pointer TTL any instance may use", async () => {
  const database = useDatabase();

  await builtVersion(database);
  // Migration 019 recorded 30 s; this CLI process is configured for 1 s.
  database.state.pointer.pointer_ttl_ms = 30_000;

  const switched = await activateIndexVersion({ graceMs: 0, versionId: 2 });

  assert.equal(switched.dualWriteGraceMs, 60_000);
  database.clock.now += 5000;
  await assert.rejects(retireIndexVersion({ force: true, versionId: 1 }), /less than two pointer TTLs ago/);
  database.clock.now += 60_000;
  assert.equal((await retireIndexVersion({ force: true, versionId: 1 })).emptiedTable, true);
});

test("retire refuses what may still be served or rolled back to, then drops the table and forgets the version", async () => {
  const database = useDatabase();

  await builtVersion(database);
  await activateIndexVersion({ graceMs: 60_000, versionId: 2 });

  await assert.rejects(retireIndexVersion({ versionId: 9 }), { code: INDEX_VERSION_ERROR_CODES.notFound });
  await assert.rejects(retireIndexVersion({ versionId: 2 }), /is active/);
  await assert.rejects(retireIndexVersion({ force: true, versionId: 1 }), /less than two pointer TTLs ago/);

  database.clock.now += 2001;
  await assert.rejects(retireIndexVersion({ versionId: 1 }), /can still be rolled back to until .*--force/);

  // Version 1's table belongs to the migrations: retiring it empties it.
  const retiredBase = await retireIndexVersion({ force: true, versionId: 1 });

  assert.deepEqual(retiredBase, {
    chunkTable: "rag_document_chunks",
    dropAttempts: 1,
    dropPending: false,
    droppedTable: false,
    emptiedTable: true,
    previousStatus: "ready",
    versionId: 1,
  });
  assert.equal(database.state.tables.get("rag_document_chunks").rows.size, 0);
  assert.equal(database.state.pointer.previous_version_id, null);
  await assert.rejects(retireIndexVersion({ versionId: 1 }), /already retired/);

  // A live build is aborted only on purpose; a dropped table goes with its progress.
  await build();
  database.state.versions.get(3).status = "building";
  database.state.versions.get(3).builder_id = "someone";
  database.state.versions.get(3).lease_expires_at = new Date(database.clock.now + 10_000);
  await assert.rejects(retireIndexVersion({ versionId: 3 }), /being built by someone.*--force/);
  assert.equal(database.state.versions.get(3).status, "building", "a refused retire leaves the build alone");

  database.log.length = 0;

  const retired = await retireIndexVersion({ force: true, versionId: 3 });
  const tags = database.log.map((entry) => entry.tag ?? entry.sql);

  // The build is stopped in a statement of its own before the retire
  // transaction locks the version row and waits for the writers: a builder
  // transaction still in flight then fails its lease check at once instead of
  // waiting for that row while it holds a document row.
  assert.equal(tags[0], "stop_build");
  assert.ok(tags.indexOf("stop_build") < tags.indexOf("BEGIN"), tags.join(", "));
  assert.equal(retired.previousStatus, "building");
  await assert.rejects(
    claimIndexVersionBuild({ builderId: "someone", versionId: 3 }),
    /is retired, not building/,
    "the builder cannot take it back"
  );
  assert.equal(retired.droppedTable, true);
  assert.equal(database.state.tables.has("rag_document_chunks_v3"), false);
  assert.equal([...database.state.progress.values()].filter((entry) => entry.version_id === 3).length, 0);
  assert.equal(database.state.versions.get(3).status, "retired");
  assert.ok(
    database.log.some((entry) => /DROP FUNCTION IF EXISTS rag_document_chunks_v3_sparse_rank/.test(entry.sql))
  );
});
