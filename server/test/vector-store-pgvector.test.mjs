import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configureEmbeddingDimensions } from "../rag/config.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import {
  PGVECTOR_ERROR_CODES,
  buildSearchText,
  clearPgvectorIndex,
  configurePgvectorRuntime,
  describePgvectorStatus,
  ensurePgvectorSchema,
  prepareDocumentsForPgvectorIndex,
  removeDocumentsFromPgvectorIndex,
  resetPgvectorRuntime,
  resetPgvectorVectorStore,
  searchPgvectorDocuments,
  getPgvectorSparseRankFunctionName,
  searchPgvectorSparseDocuments,
  supportsPgvectorIterativeScan,
  writeDocumentsToPgvectorIndex,
} from "../rag/vector-store-pgvector.js";

// Database-free tests of the SQL the pgvector provider emits and the
// verdicts it reaches from what the database tells it. The scripted query
// function below answers each catalogue query the provider asks; the
// behaviour against a real pgvector server is covered by
// vector-store-pgvector.integration.test.mjs.

const DIMENSIONS = 4;
const MODEL = "text-embedding-3-small";
const TABLE = "rag_document_chunks";
const ALL_INDEXES = [
  `${TABLE}_doc_id_idx`,
  `${TABLE}_scope_idx`,
  `${TABLE}_embedding_model_idx`,
  `${TABLE}_search_vector_idx`,
  `${TABLE}_embedding_idx`,
];

const createFakeDatabase = ({
  annIndexMethod = "hnsw",
  columnDimensions = DIMENSIONS,
  denseRows = [],
  documentCount = 0,
  extensionInstalled = true,
  extensionVersion = "0.7.4",
  indexNames = ALL_INDEXES,
  sparseRows = [],
  storedModels = [],
  tableExists = true,
} = {}) => {
  const calls = [];
  const query = async (sql, values = []) => {
    const compact = sql.replace(/\s+/g, " ").trim();

    calls.push({ sql: compact, values });

    if (/FROM pg_extension/.test(compact)) {
      return { rows: extensionInstalled ? [{ extversion: extensionVersion }] : [] };
    }

    if (/FROM pg_attribute/.test(compact)) {
      return { rows: columnDimensions ? [{ typmod: columnDimensions }] : [] };
    }

    if (/GROUP BY embedding_model/.test(compact)) {
      return {
        rows: storedModels.map((entry) => ({
          chunk_count: entry.chunkCount,
          embedding_dimensions: entry.dimensions,
          embedding_model: entry.model,
        })),
      };
    }

    if (/AS access_method/.test(compact)) {
      return { rows: annIndexMethod ? [{ access_method: annIndexMethod }] : [] };
    }

    if (/FROM pg_indexes/.test(compact)) {
      return { rows: indexNames.map((indexname) => ({ indexname })) };
    }

    if (/to_regclass/.test(compact)) {
      return { rows: [{ relation: tableExists ? values[0] : null }] };
    }

    if (/AS document_count/.test(compact)) {
      return { rows: [{ document_count: documentCount }] };
    }

    if (/AS chunk_count/.test(compact)) {
      return { rows: [{ chunk_count: 7 }] };
    }

    if (/AS vector_score/.test(compact)) {
      return { rows: denseRows };
    }

    if (/AS sparse_score/.test(compact) || /_sparse_rank\(/.test(compact) || /_sparse_search\(/.test(compact)) {
      return { rows: sparseRows };
    }

    if (/^DELETE/.test(compact)) {
      return { rowCount: 2, rows: [] };
    }

    if (/^INSERT/.test(compact)) {
      return { rowCount: values.length / 13, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  };

  return {
    calls,
    query,
    runtime: {
      checkPostgresHealth: async () => ({ message: "ok", status: "ok" }),
      isPostgresConfigured: () => true,
      query,
      runMigrations: async () => ({ appliedMigrations: [], status: "ok" }),
    },
  };
};

const useDatabase = (options) => {
  const database = createFakeDatabase(options);

  configurePgvectorRuntime(database.runtime);
  return database;
};

const chunkRow = ({ chunkIndex = 0, content, docId, score }) => ({
  chunk_id: `${docId}:${chunkIndex}`,
  chunk_index: chunkIndex,
  content,
  doc_id: docId,
  metadata: { docId, fileName: `${docId}.pdf` },
  page_number: 1,
  section_heading: null,
  sparse_score: score,
  vector_score: score,
});

let originalModel;

let originalSparseScoring;

beforeEach(() => {
  // This file pins the ts_rank_cd statements; BM25 (the default) is covered
  // by vector-store-pgvector-bm25.test.mjs.
  originalSparseScoring = process.env.RAG_SPARSE_SCORING;
  process.env.RAG_SPARSE_SCORING = "ts_rank_cd";
  originalModel = process.env.OPENAI_EMBEDDING_MODEL;
  process.env.OPENAI_EMBEDDING_MODEL = MODEL;
  configureEmbeddingDimensions(DIMENSIONS);
  resetPgvectorVectorStore();
});

afterEach(() => {
  if (originalSparseScoring === undefined) {
    delete process.env.RAG_SPARSE_SCORING;
  } else {
    process.env.RAG_SPARSE_SCORING = originalSparseScoring;
  }
  resetPgvectorRuntime();
  resetOpenAIProvider();
  configureEmbeddingDimensions(null);

  if (originalModel === undefined) {
    delete process.env.OPENAI_EMBEDDING_MODEL;
  } else {
    process.env.OPENAI_EMBEDDING_MODEL = originalModel;
  }
});

test("schema verification passes when the extension, column width and stored model all agree", async () => {
  const database = useDatabase({
    storedModels: [{ chunkCount: 3, dimensions: DIMENSIONS, model: MODEL }],
  });

  assert.equal(await ensurePgvectorSchema(), true);
  assert.ok(database.calls.some((call) => /FROM pg_extension/.test(call.sql)));
  assert.ok(database.calls.some((call) => /FROM pg_attribute/.test(call.sql)));
  assert.ok(!database.calls.some((call) => /ALTER TABLE/.test(call.sql)));

  // Verified once per process; a second call asks the database nothing.
  const callCount = database.calls.length;

  await ensurePgvectorSchema();
  assert.equal(database.calls.length, callCount);
});

test("a populated table at another width fails with the reindex instruction", async () => {
  useDatabase({
    columnDimensions: 1536,
    storedModels: [{ chunkCount: 12, dimensions: 1536, model: MODEL }],
  });

  await assert.rejects(ensurePgvectorSchema(), (error) => {
    assert.equal(error.code, PGVECTOR_ERROR_CODES.dimensionMismatch);
    assert.equal(error.expectedDimensions, DIMENSIONS);
    assert.equal(error.actualDimensions, 1536);
    assert.match(error.message, /vector:reindex/);
    return true;
  });
});

test("an empty table at another width is resized to the configured width", async () => {
  const database = useDatabase({ columnDimensions: 1536, storedModels: [] });

  await ensurePgvectorSchema();

  const statements = database.calls.map((call) => call.sql);

  assert.ok(statements.some((sql) => sql === `DROP INDEX IF EXISTS ${TABLE}_embedding_idx`));
  assert.ok(
    statements.some(
      (sql) => sql === `ALTER TABLE ${TABLE} ALTER COLUMN embedding TYPE vector(${DIMENSIONS})`
    )
  );
  assert.ok(statements.some((sql) => /CREATE INDEX IF NOT EXISTS .* USING hnsw/.test(sql)));
});

test("chunks embedded under another model block the index until it is rebuilt", async () => {
  useDatabase({
    storedModels: [
      { chunkCount: 2, dimensions: DIMENSIONS, model: MODEL },
      { chunkCount: 5, dimensions: DIMENSIONS, model: "text-embedding-ada-002" },
    ],
  });

  await assert.rejects(ensurePgvectorSchema(), (error) => {
    assert.equal(error.code, PGVECTOR_ERROR_CODES.modelMismatch);
    assert.match(error.message, /text-embedding-ada-002\/4/);
    assert.match(error.message, /vector:reindex/);
    return true;
  });
});

test("a missing vector extension and a missing database both fail closed", async () => {
  useDatabase({ extensionInstalled: false });
  await assert.rejects(ensurePgvectorSchema(), (error) => {
    assert.equal(error.code, PGVECTOR_ERROR_CODES.unavailable);
    assert.match(error.message, /`vector` extension is not installed/);
    return true;
  });

  const database = createFakeDatabase();

  configurePgvectorRuntime({ ...database.runtime, isPostgresConfigured: () => false });
  await assert.rejects(ensurePgvectorSchema(), /requires POSTGRES_DATABASE_URL/);
  assert.equal(database.calls.length, 0, "no query is attempted without a database");
});

test("prepare embeds before any write and refuses vectors of the wrong width", async () => {
  const documents = [
    { id: "doc-1:0", metadata: { chunkIndex: 0, docId: "doc-1", fileName: "alpha.pdf", sectionHeading: "Scope" }, pageContent: "Alpha policy needs approval." },
  ];

  configureOpenAIProvider({ embedTexts: async (texts) => texts.map(() => [1, 0, 0]) });
  await assert.rejects(prepareDocumentsForPgvectorIndex({ documents }), (error) => {
    assert.equal(error.code, PGVECTOR_ERROR_CODES.dimensionMismatch);
    return true;
  });

  configureOpenAIProvider({ embedTexts: async (texts) => texts.map(() => [1, 0, 0, 0]) });
  const prepared = await prepareDocumentsForPgvectorIndex({ documents });

  assert.equal(prepared.length, 1);
  assert.deepEqual(prepared[0].vector, [1, 0, 0, 0]);
  // The lexical text is the app tokenizer's output over file name, heading and
  // body -- the same terms the local sparse index would see.
  assert.equal(prepared[0].searchText, buildSearchText(documents[0]));
  // "policy" is a stop word for the shared tokenizer, so it is absent on both
  // routes alike.
  assert.equal(prepared[0].searchText, "alpha pdf scope alpha needs approval");
  assert.equal(prepared[0].metadata.docId, "doc-1");
});

test("writes replace a document's chunks and upsert rows with the embedding contract", async () => {
  const database = useDatabase();
  const client = { query: database.query };
  const preparedDocuments = [
    { id: "doc-1:0", metadata: { chunkIndex: 0, docId: "doc-1", fileName: "a.pdf", pageNumber: 1, sectionHeading: null }, pageContent: "alpha", searchText: "alpha", vector: [1, 0, 0, 0] },
    { id: "doc-1:1", metadata: { chunkIndex: 1, docId: "doc-1", fileName: "a.pdf", pageNumber: 2, sectionHeading: "B" }, pageContent: "beta", searchText: "beta", vector: [0, 1, 0, 0] },
  ];

  const written = await writeDocumentsToPgvectorIndex({
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
    client,
    preparedDocuments,
  });

  assert.deepEqual(written, { insertedChunkCount: 2, replacedDocIds: ["doc-1"] });

  const deleteCall = database.calls.find((call) => /^DELETE/.test(call.sql));
  const insertCall = database.calls.find((call) => /^INSERT/.test(call.sql));

  assert.deepEqual(deleteCall.values, [["doc-1"]]);
  assert.match(insertCall.sql, /ON CONFLICT \(chunk_id\) DO UPDATE SET/);
  assert.match(insertCall.sql, /\$13::vector/);
  assert.match(insertCall.sql, /\$8::jsonb/);
  assert.equal(insertCall.values.length, 26);
  assert.deepEqual(insertCall.values.slice(0, 13), [
    "doc-1:0",
    "doc-1",
    0,
    1,
    null,
    "alpha",
    "alpha",
    JSON.stringify(preparedDocuments[0].metadata),
    "alice",
    "workspace-a",
    MODEL,
    DIMENSIONS,
    "[1,0,0,0]",
  ]);
});

test("remove and clear issue scoped deletes and clear forgets the cached schema verdict", async () => {
  const database = useDatabase();

  assert.equal(await removeDocumentsFromPgvectorIndex({ docIds: ["doc-1", "doc-1", " ", "doc-2"] }), 2);
  assert.equal(await removeDocumentsFromPgvectorIndex({ docIds: [] }), 0);

  const removeCall = database.calls.find((call) => /^DELETE/.test(call.sql));

  assert.deepEqual(removeCall.values, [["doc-1", "doc-2"]]);

  await clearPgvectorIndex();
  const verificationCallsBefore = database.calls.filter((call) => /FROM pg_extension/.test(call.sql)).length;

  await ensurePgvectorSchema();
  assert.equal(
    database.calls.filter((call) => /FROM pg_extension/.test(call.sql)).length,
    verificationCallsBefore + 1,
    "clear invalidates the cached schema verdict"
  );
});

test("dense search orders by cosine distance, filters by document and rejects the wrong query width", async () => {
  const database = useDatabase({
    denseRows: [
      chunkRow({ content: "Alpha policy", docId: "doc-1", score: 0.91 }),
      chunkRow({ content: "Beta budget", docId: "doc-2", score: 0.42 }),
    ],
  });

  const results = await searchPgvectorDocuments({
    queryVector: [1, 0, 0, 0],
    queryText: "alpha policy",
    docIds: ["doc-1", "doc-1", "doc-2"],
    topK: 2,
    scoringMode: "dense",
  });
  const searchCall = database.calls.find((call) => /AS vector_score/.test(call.sql));

  assert.match(searchCall.sql, /ORDER BY embedding <=> \$1::vector ASC/);
  assert.match(searchCall.sql, /embedding_model = \$3 AND embedding_dimensions = \$4/);
  assert.deepEqual(searchCall.values, ["[1,0,0,0]", ["doc-1", "doc-2"], MODEL, DIMENSIONS, 2]);
  assert.equal(results.length, 2);
  assert.equal(results[0].document.metadata.docId, "doc-1");
  assert.equal(results[0].vectorScore, 0.91);
  assert.equal(results[0].score, 0.91);
  assert.equal(results[0].keywordScore, 1);
  assert.equal(results[1].keywordScore, 0);

  await assert.rejects(
    searchPgvectorDocuments({ queryVector: [1, 0], queryText: "x", docIds: ["doc-1"], topK: 1 }),
    (error) => error.code === PGVECTOR_ERROR_CODES.dimensionMismatch
  );
  assert.deepEqual(
    await searchPgvectorDocuments({ queryVector: [1, 0, 0, 0], queryText: "x", docIds: [], topK: 1 }),
    []
  );
});

const withIterativeScanEnv = async (value, callback) => {
  const saved = {
    indexType: process.env.RAG_PGVECTOR_INDEX_TYPE,
    iterativeScan: process.env.RAG_PGVECTOR_ITERATIVE_SCAN,
  };

  for (const [key, entry] of Object.entries(value)) {
    process.env[key] = entry;
  }

  try {
    return await callback();
  } finally {
    for (const [key, name] of [
      ["indexType", "RAG_PGVECTOR_INDEX_TYPE"],
      ["iterativeScan", "RAG_PGVECTOR_ITERATIVE_SCAN"],
    ]) {
      if (saved[key] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[key];
      }
    }
  }
};

const DENSE_ARGS = {
  queryVector: [1, 0, 0, 0],
  queryText: "alpha",
  docIds: ["doc-1", "doc-2"],
  topK: 2,
  scoringMode: "dense",
};

test("iterative HNSW scans need pgvector 0.8 or later", () => {
  assert.equal(supportsPgvectorIterativeScan("0.8.0"), true);
  assert.equal(supportsPgvectorIterativeScan("0.8.6"), true);
  assert.equal(supportsPgvectorIterativeScan("0.10.1"), true);
  assert.equal(supportsPgvectorIterativeScan("1.0.0"), true);
  assert.equal(supportsPgvectorIterativeScan("0.7.4"), false);
  assert.equal(supportsPgvectorIterativeScan(null), false);
  assert.equal(supportsPgvectorIterativeScan("dev"), false);
});

test("dense search on pgvector 0.8 sets a relaxed iterative scan in the search's own transaction and restores distance order", async () => {
  const database = useDatabase({
    denseRows: [
      chunkRow({ content: "Alpha", docId: "doc-1", score: 0.9 }),
      chunkRow({ content: "Beta", docId: "doc-2", score: 0.4 }),
    ],
    extensionVersion: "0.8.6",
  });
  const transactions = [];
  configurePgvectorRuntime({
    ...database.runtime,
    withTransaction: async (callback) => {
      const statements = [];

      transactions.push(statements);
      return callback({
        query: (sql, values) => {
          statements.push(sql.replace(/\s+/g, " ").trim());
          return database.query(sql, values);
        },
      });
    },
  });

  const results = await searchPgvectorDocuments(DENSE_ARGS);
  const settingCall = database.calls.find((call) => /set_config/.test(call.sql));
  const searchCall = database.calls.find((call) => /AS vector_score/.test(call.sql));

  assert.deepEqual(settingCall.values, ["hnsw.iterative_scan", "relaxed_order"]);
  assert.equal(transactions.length, 1, "setting and search share one transaction");
  assert.equal(transactions[0].length, 2);
  assert.match(transactions[0][0], /set_config\(\$1, \$2, true\)/);
  assert.match(transactions[0][1], /WITH nearest AS MATERIALIZED/);
  assert.match(searchCall.sql, /ORDER BY embedding <=> \$1::vector ASC, chunk_id ASC LIMIT \$5/);
  assert.match(searchCall.sql, /ORDER BY distance \+ 0 ASC, chunk_id ASC/);
  assert.deepEqual(searchCall.values, ["[1,0,0,0]", ["doc-1", "doc-2"], MODEL, DIMENSIONS, 2]);
  assert.deepEqual(
    results.map((result) => result.document.metadata.docId),
    ["doc-1", "doc-2"]
  );
});

test("dense search keeps the plain statement when iterative scans are off, and reuses a caller's transaction client", async () => {
  await withIterativeScanEnv({ RAG_PGVECTOR_ITERATIVE_SCAN: "off" }, async () => {
    const database = useDatabase({ extensionVersion: "0.8.6" });

    await searchPgvectorDocuments(DENSE_ARGS);
    assert.ok(!database.calls.some((call) => /set_config/.test(call.sql)));
    assert.ok(!database.calls.some((call) => /MATERIALIZED/.test(call.sql)));
  });

  await withIterativeScanEnv({ RAG_PGVECTOR_ITERATIVE_SCAN: "strict_order" }, async () => {
    const database = useDatabase({ extensionVersion: "0.8.6" });
    const clientCalls = [];
    const client = {
      query: (sql, values) => {
        clientCalls.push(sql);
        return database.query(sql, values);
      },
    };
    configurePgvectorRuntime({
      ...database.runtime,
      withTransaction: () => {
        throw new Error("a caller's client is already in a transaction");
      },
    });

    await searchPgvectorDocuments({ ...DENSE_ARGS, client });
    assert.deepEqual(
      database.calls.find((call) => /set_config/.test(call.sql)).values,
      ["hnsw.iterative_scan", "strict_order"]
    );
    assert.ok(clientCalls.some((sql) => /set_config/.test(sql)));
    assert.ok(clientCalls.some((sql) => /MATERIALIZED/.test(sql)));
  });

  await withIterativeScanEnv({ RAG_PGVECTOR_INDEX_TYPE: "ivfflat" }, async () => {
    const database = useDatabase({ annIndexMethod: "ivfflat", extensionVersion: "0.8.0" });

    await searchPgvectorDocuments(DENSE_ARGS);
    assert.deepEqual(
      database.calls.find((call) => /set_config/.test(call.sql)).values,
      ["ivfflat.iterative_scan", "relaxed_order"]
    );
  });
});

test("sparse search builds an OR tsquery from the app tokenizer and ranks with ts_rank_cd", async () => {
  const database = useDatabase({
    sparseRows: [chunkRow({ content: "Amber ceiling is 2400 dollars.", docId: "doc-1", score: 0.35 })],
  });

  const results = await searchPgvectorSparseDocuments({
    queryText: "What is the Amber ceiling?",
    docIds: ["doc-1"],
    topK: 5,
  });
  const searchCall = database.calls.find((call) => /AS sparse_score/.test(call.sql));

  assert.match(searchCall.sql, /ts_rank_cd\(search_vector, to_tsquery\(\$1::regconfig, \$2\), 32\)/);
  assert.match(searchCall.sql, /search_vector @@ to_tsquery\(\$1::regconfig, \$2\)/);
  assert.deepEqual(searchCall.values, ["simple", "'amber' | 'ceiling'", ["doc-1"], 5]);
  assert.equal(results.length, 1);
  assert.equal(results[0].sparseScore, 0.35);
  assert.equal(results[0].score, 0.35);
  assert.equal(results[0].keywordScore, 1);

  const callCount = database.calls.length;

  assert.deepEqual(
    await searchPgvectorSparseDocuments({ queryText: "the of a", docIds: ["doc-1"], topK: 5 }),
    []
  );
  assert.equal(database.calls.length, callCount, "stop words alone never reach the database");
});

test("a tenant's sparse search ranks through the owner function and joins the ids back under the row policies", async () => {
  const saved = process.env.POSTGRES_ROW_LEVEL_SECURITY;
  const savedPruning = process.env.RAG_SPARSE_PRUNE_DF_FRACTION;
  process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
  // Migration 014's function: ts_rank_cd without common-term pruning.
  process.env.RAG_SPARSE_PRUNE_DF_FRACTION = "off";

  try {
    const database = useDatabase({
      sparseRows: [chunkRow({ content: "Amber ceiling is 2400 dollars.", docId: "doc-1", score: 0.35 })],
    });
    const results = await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws" }, () =>
      searchPgvectorSparseDocuments({ queryText: "What is the Amber ceiling?", docIds: ["doc-1", "doc-2"], topK: 5 })
    );
    const searchCall = database.calls.find((call) => /_sparse_rank\(/.test(call.sql));

    assert.equal(getPgvectorSparseRankFunctionName(), `${TABLE}_sparse_rank`);
    assert.match(searchCall.sql, new RegExp(`FROM ${TABLE}_sparse_rank\\( to_tsquery\\(\\$1::regconfig, \\$2\\),`));
    assert.match(
      searchCall.sql,
      /ARRAY\(SELECT d\.doc_id FROM \w+ d WHERE d\.doc_id = ANY\(\$3::text\[\]\)\), \$4::integer \) AS r/,
      "only doc ids the tenant can see in the documents table reach the owner function"
    );
    assert.match(searchCall.sql, new RegExp(`JOIN ${TABLE} c ON c\\.chunk_id = r\\.chunk_id`));
    assert.match(searchCall.sql, /ORDER BY r.sparse_score DESC, c.chunk_id ASC$/);
    assert.ok(!/@@/.test(searchCall.sql), "the tenant statement leaves the match to the function");
    assert.deepEqual(searchCall.values, ["simple", "'amber' | 'ceiling'", ["doc-1", "doc-2"], 5]);
    assert.equal(results[0].sparseScore, 0.35);

    // With pruning on (the default) several documents go through migration
    // 030's search function instead, which filters the doc ids by the tenant
    // policy itself; the join back still runs under the row policies.
    delete process.env.RAG_SPARSE_PRUNE_DF_FRACTION;

    const pruning = useDatabase({
      sparseRows: [chunkRow({ content: "Amber ceiling is 2400 dollars.", docId: "doc-1", score: 0.35 })],
    });

    await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws" }, () =>
      searchPgvectorSparseDocuments({ queryText: "What is the Amber ceiling?", docIds: ["doc-1", "doc-2"], topK: 5 })
    );

    const prunedCall = pruning.calls.find((call) => /_sparse_search\(/.test(call.sql));

    assert.ok(prunedCall, "the search function ran");
    assert.ok(!pruning.calls.some((call) => /_sparse_rank\(/.test(call.sql)));
    assert.match(prunedCall.sql, new RegExp(`JOIN ${TABLE} c ON c\\.chunk_id = r\\.chunk_id`));
    assert.equal(prunedCall.values[5], "ts_rank_cd");
    process.env.RAG_SPARSE_PRUNE_DF_FRACTION = "off";

    const singleDocument = useDatabase({ sparseRows: [] });

    await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws" }, () =>
      searchPgvectorSparseDocuments({ queryText: "amber", docIds: ["doc-1"], topK: 5 })
    );
    assert.ok(
      !singleDocument.calls.some((call) => /_sparse_rank\(/.test(call.sql)),
      "one document keeps the plain statement"
    );

    process.env.POSTGRES_ROW_LEVEL_SECURITY = "off";
    const ownerDatabase = useDatabase({ sparseRows: [] });

    await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws" }, () =>
      searchPgvectorSparseDocuments({ queryText: "amber", docIds: ["doc-1"], topK: 5 })
    );
    assert.ok(
      ownerDatabase.calls.some((call) => /search_vector @@ to_tsquery/.test(call.sql)),
      "without an enforced tenant the plain statement runs"
    );
  } finally {
    if (saved === undefined) {
      delete process.env.POSTGRES_ROW_LEVEL_SECURITY;
    } else {
      process.env.POSTGRES_ROW_LEVEL_SECURITY = saved;
    }

    if (savedPruning === undefined) {
      delete process.env.RAG_SPARSE_PRUNE_DF_FRACTION;
    } else {
      process.env.RAG_SPARSE_PRUNE_DF_FRACTION = savedPruning;
    }
  }
});

test("status describes extension, table, indexes, width and flags an empty index with registered documents", async () => {
  useDatabase({ documentCount: 3, storedModels: [] });

  const status = await describePgvectorStatus();

  assert.equal(status.configured, true);
  assert.equal(status.reachable, true);
  assert.deepEqual(status.extension, { installed: true, version: "0.7.4" });
  assert.deepEqual(status.iterativeScan, { configured: "relaxed_order", supported: false });
  assert.deepEqual(status.table, { exists: true, name: TABLE });
  assert.deepEqual(status.indexes, {
    docId: true,
    embedding: true,
    embeddingModel: true,
    scope: true,
    searchVector: true,
  });
  assert.equal(status.embedding.columnDimensions, DIMENSIONS);
  assert.equal(status.embedding.matches, true);
  assert.equal(status.chunkCount, 0);
  assert.equal(status.documentCount, 3);
  assert.equal(status.indexEmptyWithDocuments, true);
  assert.deepEqual(status.annIndex, {
    configured: "hnsw",
    actual: "hnsw",
    present: true,
    matches: true,
    supported: true,
  });
  assert.equal(status.annDimensionsSupported, true);

  useDatabase({
    indexNames: [`${TABLE}_doc_id_idx`],
    tableExists: true,
    columnDimensions: 1536,
    storedModels: [{ chunkCount: 1, dimensions: 1536, model: MODEL }],
    annIndexMethod: null,
  });
  const stale = await describePgvectorStatus();

  assert.equal(stale.indexes.embedding, false);
  assert.equal(stale.indexes.searchVector, false);
  assert.equal(stale.embedding.matches, false);
  assert.equal(stale.chunkCount, 1);
  // A partially-migrated table: chunks exist but the ANN index does not.
  assert.equal(stale.annIndex.present, false);
  assert.equal(stale.annIndex.actual, null);
  assert.equal(stale.annIndex.matches, false);
  assert.equal(stale.annIndex.supported, true);
});

test("status reports the actual ANN access method so a wrong index type is visible", async () => {
  // The embedding index exists by name, but as a btree rather than the
  // configured hnsw ANN index — pg_indexes cannot tell these apart, pg_am can.
  useDatabase({
    documentCount: 2,
    storedModels: [{ chunkCount: 5, dimensions: DIMENSIONS, model: MODEL }],
    annIndexMethod: "btree",
  });

  const status = await describePgvectorStatus();

  assert.equal(status.indexes.embedding, true);
  assert.equal(status.annIndex.configured, "hnsw");
  assert.equal(status.annIndex.actual, "btree");
  assert.equal(status.annIndex.present, true);
  assert.equal(status.annIndex.matches, false);
  assert.equal(status.annIndex.supported, true);
});

test("status marks ANN indexing unsupported when the configured embedding exceeds the vector ceiling", async () => {
  // afterEach resets the dimension override; no manual restore needed.
  configureEmbeddingDimensions(3072);

  useDatabase({
    documentCount: 1,
    columnDimensions: 3072,
    storedModels: [{ chunkCount: 4, dimensions: 3072, model: MODEL }],
    annIndexMethod: null,
  });

  const status = await describePgvectorStatus();

  // A missing ANN index here is expected fail-closed behaviour, not a fault:
  // a 3072-dim vector column cannot carry an hnsw/ivfflat index at all.
  assert.equal(status.annDimensionsSupported, false);
  assert.equal(status.annIndex.supported, false);
  assert.equal(status.annIndex.present, false);
});
