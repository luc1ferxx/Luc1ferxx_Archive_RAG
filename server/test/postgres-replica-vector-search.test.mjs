import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { configureEmbeddingDimensions } from "../rag/config.js";
import {
  DOCUMENT_REGISTRY_BACKENDS,
  configureDocumentRegistryStore,
  getStoredDocument,
  initializeDocumentRegistry,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { REPLICA_BEHIND_SENTINEL } from "../rag/postgres-replicas.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { maskInvisibleDocIds } from "../rag/retrieval-service/app.js";
import {
  configurePgvectorRuntime,
  resetPgvectorRuntime,
  resetPgvectorVectorStore,
  searchPgvectorDocuments,
  searchPgvectorSparseDocuments,
} from "../rag/vector-store-pgvector.js";
import {
  invalidateIndexVersionSnapshot,
  peekIndexVersionSnapshot,
  readIndexVersionSnapshot,
} from "../rag/vector-store-pgvector-versions.js";
import { createFakeVersionDatabase } from "./pgvector-version-fake-database.mjs";

// Database-free tests of what the pgvector searches hand rag/postgres.js when
// read replicas are configured: a tenant search over documents this process's
// registry knows is marked read-only with a freshness guard naming each
// document's content version and the pointer generation it searched under;
// the dense route's iterative-scan setting then travels as the statement's
// prelude instead of a transaction. Anything else (no replicas, no tenant, a
// document the registry does not know, a caller's transaction client) is the
// primary path exactly as before. postgres-replica-routing.test.mjs covers
// what postgres.js does with the mark.

const MODEL = "replica-embed";
const ENV_KEYS = [
  "OPENAI_EMBEDDING_MODEL",
  "POSTGRES_READ_REPLICA_URLS",
  "POSTGRES_ROW_LEVEL_SECURITY",
  "RAG_PGVECTOR_ITERATIVE_SCAN",
  "RAG_SPARSE_PRUNE_DF_FRACTION",
  "RAG_SPARSE_SCORING",
];
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const DOCUMENTS = [
  { contentVersion: 3, docId: "doc-1", fileName: "doc-1.pdf", ownerUserId: "alice", workspaceId: "ws-a" },
  { contentVersion: 1, docId: "doc-2", fileName: "doc-2.pdf", ownerUserId: "alice", workspaceId: "ws-a" },
];
const DENSE = { docIds: ["doc-1", "doc-2"], queryText: "alpha", queryVector: [1, 0, 0, 0], topK: 2 };
const SPARSE = { docIds: ["doc-1", "doc-2"], queryText: "alpha budget", topK: 2 };

let savedEnv;
let database;
let searches;
let transactions;
// (answer) => a promise for a pointer snapshot statement, or null to answer it
// as usual; see the lost-race test.
let snapshotInterceptor = null;

const useDatabase = (options = {}) => {
  database = createFakeVersionDatabase({ extensionVersion: "0.8.6", ...options });
  searches = [];
  transactions = 0;
  snapshotInterceptor = null;

  const query = (sql, values, readOptions) => {
    if (/AS vector_score|AS sparse_score|_sparse_search\(|_sparse_rank\(/.test(sql)) {
      searches.push({ options: readOptions, sql: sql.replace(/\s+/g, " ").trim() });
    }

    if (snapshotInterceptor && /index_versions:snapshot/.test(sql)) {
      const intercepted = snapshotInterceptor(() => database.runtime.query(sql, values));

      if (intercepted) {
        return intercepted;
      }
    }

    return database.runtime.query(sql, values);
  };

  configurePgvectorRuntime({
    ...database.runtime,
    query,
    withTransaction: async (callback) => {
      transactions += 1;
      return callback({ query: (sql, values) => query(sql, values) });
    },
  });
};

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  process.env.OPENAI_EMBEDDING_MODEL = MODEL;
  process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
  // Never contacted: the scripted runtime above answers every statement.
  process.env.POSTGRES_READ_REPLICA_URLS = "postgresql://reader@replica.invalid:5432/archive";
  configureEmbeddingDimensions(4);
  resetPgvectorVectorStore();
  configureDocumentRegistryStore({
    initialize: async () => true,
    list: async () => DOCUMENTS,
  });
  await initializeDocumentRegistry();
  useDatabase();
});

afterEach(async () => {
  resetOpenAIProvider();
  resetPgvectorRuntime();
  resetPgvectorVectorStore();
  configureEmbeddingDimensions(null);
  await resetDocumentRegistryStore();

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const asAlice = (callback) => runWithDatabaseTenant(ALICE, callback);

const assertGuard = (options, { generation = "1" } = {}) => {
  const guard = options?.readOnly?.guard;

  assert.ok(guard, "the search is marked read-only with a guard");
  assert.match(guard.text, /read_replica:freshness_guard/);
  assert.match(guard.text, /JOIN rag_documents d/);
  assert.match(guard.text, /FROM rag_index_versions_pointer p/);
  assert.match(guard.text, new RegExp(REPLICA_BEHIND_SENTINEL));
  assert.deepEqual(guard.values, [["doc-1", "doc-2"], [3, 1], generation]);
};

test("a tenant's dense search goes out guarded, with the iterative scan setting as its prelude and no transaction", async () => {
  await asAlice(() => searchPgvectorDocuments(DENSE));

  const [search] = searches;

  assert.match(search.sql, /WITH nearest AS MATERIALIZED/);
  assertGuard(search.options);
  assert.deepEqual(search.options.prelude, [
    { text: "SELECT set_config($1, $2, true)", values: ["hnsw.iterative_scan", "relaxed_order"] },
  ]);
  assert.equal(transactions, 0, "one round trip instead of BEGIN / set_config / search / COMMIT");
});

test("the plain dense statement and both sparse statements carry the guard too", async () => {
  process.env.RAG_PGVECTOR_ITERATIVE_SCAN = "off";

  await asAlice(() => searchPgvectorDocuments(DENSE));
  await asAlice(() => searchPgvectorSparseDocuments(SPARSE));
  process.env.RAG_SPARSE_SCORING = "ts_rank_cd";
  process.env.RAG_SPARSE_PRUNE_DF_FRACTION = "off";
  await asAlice(() => searchPgvectorSparseDocuments(SPARSE));

  assert.equal(searches.length, 3);
  assert.doesNotMatch(searches[0].sql, /MATERIALIZED/);
  assert.equal(searches[0].options.prelude, undefined);
  assert.match(searches[1].sql, /_sparse_search\(/, "BM25 through the search function");
  assert.match(searches[2].sql, /_sparse_rank\(/, "ts_rank_cd through the tenant rank function");
  searches.forEach((search) => assertGuard(search.options));
});

test("the guard names the pointer generation the search's version came from", async () => {
  database.state.pointer.generation = 7;
  invalidateIndexVersionSnapshot();

  await asAlice(() => searchPgvectorDocuments(DENSE));
  assertGuard(searches[0].options, { generation: "7" });
});

test("the guard's generation is the snapshot the searched version came from, even when the cache drops it before the statement", async () => {
  // Version 2, pinned to another model, was activated at generation 8: its
  // build is complete only on a replica that replayed that switch. The
  // caller's vector is in the configured space, so the search embeds the
  // query again (a model call); meanwhile another request drops the cached
  // snapshot (withActiveVersionRetry after a retired table did that).
  database.state.tables.set("rag_document_chunks_v2", { dimensions: 3, rows: new Map() });
  database.state.versions.set(2, {
    ...database.state.versions.get(1),
    chunk_table: "rag_document_chunks_v2",
    embedding_dimensions: 3,
    embedding_identity: "pinned-embed",
    embedding_model: "pinned-embed",
    embedding_space_source: "pinned",
    index_params: { indexType: "hnsw" },
    sparse_rank_function: "rag_document_chunks_v2_sparse_rank",
    version_id: 2,
  });
  database.state.versions.get(1).status = "ready";
  database.state.pointer = { ...database.state.pointer, active_version_id: 2, generation: 8, previous_version_id: 1 };
  invalidateIndexVersionSnapshot();

  let embeddings = 0;

  configureOpenAIProvider({
    embedQuery: async () => {
      embeddings += 1;
      invalidateIndexVersionSnapshot();
      return [1, 0, 0];
    },
  });

  await asAlice(() => searchPgvectorDocuments(DENSE));

  const [search] = searches;

  assert.equal(embeddings, 1, "the query was embedded again for version 2");
  assert.match(search.sql, /FROM rag_document_chunks_v2 WHERE/);
  assertGuard(search.options, { generation: "8" });
});

test("a version whose snapshot the cache did not keep stays on the primary instead of borrowing the cache's older generation", async () => {
  // Warm: the cache holds generation 1 and version 1 is verified.
  await asAlice(() => searchPgvectorDocuments(DENSE));

  // Version 2 is activated at generation 8 and the cached pointer expires.
  database.state.tables.set("rag_document_chunks_v2", { dimensions: 4, rows: new Map() });
  database.state.versions.set(2, {
    ...database.state.versions.get(1),
    chunk_table: "rag_document_chunks_v2",
    sparse_rank_function: "rag_document_chunks_v2_sparse_rank",
    version_id: 2,
  });
  database.state.versions.get(1).status = "ready";
  database.state.pointer = { ...database.state.pointer, active_version_id: 2, generation: 8, previous_version_id: 1 };
  database.clock.now += 24 * 60 * 60 * 1000;

  // Both pointer reads this search makes (the expired cache's and its
  // verification's forced one) lose the race to store: another forced read
  // (another request's verification) starts while each runs and is still in
  // flight when the search goes out. The cache keeps generation 1 while the
  // search reads version 2.
  const held = [];
  let raced = 0;
  let competing = false;

  snapshotInterceptor = (answer) => {
    if (competing) {
      competing = false;
      return new Promise((resolve) => held.push(() => resolve(answer())));
    }

    if (raced >= 2) {
      return null;
    }

    raced += 1;
    return Promise.resolve().then(() => {
      competing = true;
      readIndexVersionSnapshot({ force: true }).catch(() => {});
      return answer();
    });
  };
  searches.length = 0;

  await asAlice(() => searchPgvectorDocuments(DENSE));

  const cachedGeneration = peekIndexVersionSnapshot()?.generation;

  snapshotInterceptor = null;
  held.forEach((release) => release());

  assert.equal(raced, 2);
  assert.equal(cachedGeneration, 1, "the cache still held the old pointer when the search went out");
  assert.match(searches[0].sql, /FROM rag_document_chunks_v2 WHERE/);
  assert.equal(
    searches[0].options,
    undefined,
    "a guard at generation 1 would let a replica that has not replayed the switch to version 2 answer"
  );
});

test("the retrieval tier re-reads every requested document, known ones too, so its guard expects what the primary holds", async () => {
  // A split deployment: this process (the retrieval tier) learned doc-1 at
  // version 3; another instance has since replaced it (version 4) and the
  // agent tier asks about it. A guard at version 3 would let a replica that
  // has not replayed the replacement answer with the old chunks.
  await resetDocumentRegistryStore();

  const stored = new Map(DOCUMENTS.map((document) => [document.docId, document]));

  configureDocumentRegistryStore({
    backend: DOCUMENT_REGISTRY_BACKENDS.postgres,
    initialize: async () => true,
    list: async () => [...stored.values()],
    listByIds: async (docIds) => docIds.map((docId) => stored.get(docId)).filter(Boolean),
  });
  await initializeDocumentRegistry();
  assert.equal(getStoredDocument("doc-1").version, 3);

  stored.set("doc-1", { ...stored.get("doc-1"), contentVersion: 4 });

  const { docIds } = await asAlice(() => maskInvisibleDocIds(["doc-1", "doc-2"], ALICE));

  assert.deepEqual(docIds, ["doc-1", "doc-2"]);
  assert.equal(getStoredDocument("doc-1").version, 4, "read again from the store");

  await asAlice(() => searchPgvectorDocuments(DENSE));
  assert.deepEqual(searches[0].options.readOnly.guard.values, [["doc-1", "doc-2"], [4, 1], "1"]);
});

test("a document this process's registry does not know keeps the search on the primary path", async () => {
  await asAlice(() => searchPgvectorDocuments({ ...DENSE, docIds: ["doc-1", "doc-elsewhere"] }));
  await asAlice(() => searchPgvectorSparseDocuments({ ...SPARSE, docIds: ["doc-1", "doc-elsewhere"] }));

  assert.ok(searches.every((search) => search.options === undefined));
  assert.equal(transactions, 1, "the dense search keeps its own transaction");
});

test("an owner search, a caller's transaction client and an unset configuration are the primary path unchanged", async () => {
  await searchPgvectorDocuments(DENSE);
  assert.equal(searches.at(-1).options, undefined, "no tenant");

  const clientStatements = [];

  await asAlice(() =>
    searchPgvectorDocuments({
      ...DENSE,
      client: {
        query: (sql, values, extra) => {
          clientStatements.push({ extra, sql });
          return database.runtime.query(sql, values);
        },
      },
    })
  );
  assert.ok(clientStatements.some((entry) => /AS vector_score/.test(entry.sql)));
  assert.ok(clientStatements.every((entry) => entry.extra === undefined), "nothing extra on a caller's client");

  delete process.env.POSTGRES_READ_REPLICA_URLS;
  searches.length = 0;
  transactions = 0;
  await asAlice(() => searchPgvectorDocuments(DENSE));
  await asAlice(() => searchPgvectorSparseDocuments(SPARSE));
  assert.ok(searches.every((search) => search.options === undefined));
  assert.equal(transactions, 1);
});
