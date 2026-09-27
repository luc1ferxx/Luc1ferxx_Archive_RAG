import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_SPARSE_COMMON_TERM_CAP,
  DEFAULT_SPARSE_PRUNE_DF_FRACTION,
  configureEmbeddingDimensions,
  getBm25B,
  getBm25K1,
  getSparseCommonTermCap,
  getSparsePruneDfFraction,
  getSparseScoring,
} from "../rag/config.js";
import { renderMigrationSql } from "../rag/db-migrations.js";
import {
  configurePgvectorRuntime,
  resetPgvectorVectorStore,
  searchPgvectorSparseDocuments,
} from "../rag/vector-store-pgvector.js";
import {
  PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS,
  PGVECTOR_SPARSE_SEARCH_SIGNATURE,
  buildPgvectorSparseSearchSql,
  getPgvectorBm25InstallFunctionName,
  getPgvectorSparseBackend,
  getPgvectorSparseFoldFunctionName,
  getPgvectorSparseSearchFunctionName,
  getPgvectorSparseStatisticsTables,
  renderPgvectorBm25DropDdl,
  renderPgvectorBm25InstallStatement,
  resolvePgvectorSparseScoring,
  toMissingSparseSearchFunctionError,
  usesPgvectorSparseSearchFunction,
} from "../rag/vector-store-pgvector-sparse.js";
import { describeVectorStoreRuntime } from "../rag/vector-store.js";
import { parseSparseLengthBackfillArgs } from "../sparse-length-backfill.mjs";
import {
  COMPARISONS,
  REGIMES,
  comparePrunedToExhaustive,
  formatMarkdown as formatSparseScoringReport,
  parseFractions,
  recallRow,
  sliceOfPath,
  summarizeLatency,
  summarizePruning,
  tenantCopyOf,
} from "../evaluation/run-sparse-scoring-eval.mjs";

// Database-free checks for the BM25 sparse route: configuration, the SQL the
// store sends, the DDL a new index version gets, and the evaluation helpers.
// The real behaviour (statistics, scores equal to the local BM25 store's,
// pruning, tenant isolation) is vector-store-pgvector-bm25.integration.test.mjs.

const ENV_KEYS = [
  "OPENAI_EMBEDDING_MODEL",
  "RAG_BM25_B",
  "RAG_BM25_K1",
  "RAG_SPARSE_COMMON_TERM_CAP",
  "RAG_SPARSE_PRUNE_DF_FRACTION",
  "RAG_SPARSE_SCORING",
  "VECTOR_STORE_PROVIDER",
];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  configurePgvectorRuntime(null);
  resetPgvectorVectorStore();
  configureEmbeddingDimensions(null);
});

test("sparse scoring settings: a strict choice, BM25 parameters, the pruning fraction and the common-term cap", () => {
  assert.equal(getSparseScoring(), "ts_rank_cd");
  process.env.RAG_SPARSE_SCORING = " BM25 ";
  assert.equal(getSparseScoring(), "bm25");
  process.env.RAG_SPARSE_SCORING = "bm2";
  assert.throws(() => getSparseScoring(), /RAG_SPARSE_SCORING must be one of ts_rank_cd, bm25/);

  assert.equal(getBm25K1(), 1.2);
  assert.equal(getBm25B(), 0.75);
  process.env.RAG_BM25_K1 = "0";
  process.env.RAG_BM25_B = "1.5";
  assert.equal(getBm25K1(), 0);
  assert.equal(getBm25B(), 0.75, "b above 1 falls back to the default");

  assert.equal(getSparsePruneDfFraction(), DEFAULT_SPARSE_PRUNE_DF_FRACTION);

  for (const [value, expected] of [
    ["off", null],
    ["0", null],
    ["1", null],
    ["0.25", 0.25],
    ["nonsense", DEFAULT_SPARSE_PRUNE_DF_FRACTION],
  ]) {
    process.env.RAG_SPARSE_PRUNE_DF_FRACTION = value;
    assert.equal(getSparsePruneDfFraction(), expected, value);
  }

  assert.equal(getSparseCommonTermCap(), DEFAULT_SPARSE_COMMON_TERM_CAP);

  for (const [value, expected] of [
    ["off", null],
    ["0", null],
    ["-3", null],
    ["500", 500],
    ["750.9", 750],
    ["nonsense", DEFAULT_SPARSE_COMMON_TERM_CAP],
  ]) {
    process.env.RAG_SPARSE_COMMON_TERM_CAP = value;
    assert.equal(getSparseCommonTermCap(), expected, value);
  }
});

test("a call may override the configured scoring, and each scoring has its own backend label", () => {
  const defaults = {
    b: 0.75,
    commonTermCap: DEFAULT_SPARSE_COMMON_TERM_CAP,
    k1: 1.2,
    pruneDfFraction: DEFAULT_SPARSE_PRUNE_DF_FRACTION,
    pruneMinChunks: PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS,
  };

  assert.deepEqual(resolvePgvectorSparseScoring(), { ...defaults, scoring: "ts_rank_cd" });
  assert.deepEqual(resolvePgvectorSparseScoring({ scoring: "bm25" }), { ...defaults, scoring: "bm25" });
  assert.equal(resolvePgvectorSparseScoring({ pruneMinChunks: 0, scoring: "bm25" }).pruneMinChunks, 0);
  assert.equal(resolvePgvectorSparseScoring({ pruneDfFraction: null, scoring: "bm25" }).pruneDfFraction, null);
  assert.equal(resolvePgvectorSparseScoring({ pruneDfFraction: 1, scoring: "bm25" }).pruneDfFraction, null);
  assert.equal(resolvePgvectorSparseScoring({ commonTermCap: null }).commonTermCap, null);
  assert.equal(resolvePgvectorSparseScoring({ commonTermCap: 0 }).commonTermCap, null);
  assert.throws(() => resolvePgvectorSparseScoring({ scoring: "tfidf" }), /Unknown sparse scoring/);

  // BM25 always goes through the search function; ts_rank_cd only when it
  // prunes a multi-document search (one document keeps the plain statement).
  const tsRankCd = resolvePgvectorSparseScoring();

  assert.equal(usesPgvectorSparseSearchFunction({ docCount: 1, options: resolvePgvectorSparseScoring({ scoring: "bm25" }) }), true);
  assert.equal(usesPgvectorSparseSearchFunction({ docCount: 1, options: tsRankCd }), false);
  assert.equal(usesPgvectorSparseSearchFunction({ docCount: 2, options: tsRankCd }), true);
  assert.equal(
    usesPgvectorSparseSearchFunction({ docCount: 2, options: resolvePgvectorSparseScoring({ pruneDfFraction: null }) }),
    false
  );

  assert.equal(getPgvectorSparseBackend("ts_rank_cd"), "postgres_fts_ts_rank_cd");
  assert.equal(getPgvectorSparseBackend("bm25"), "postgres_bm25");
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  assert.equal(describeVectorStoreRuntime().sparseBackend, "postgres_fts_ts_rank_cd");
  process.env.RAG_SPARSE_SCORING = "bm25";
  assert.equal(getPgvectorSparseBackend(), "postgres_bm25");
  // The runtime report and every /chat retrieval block name the scoring that ran.
  assert.equal(describeVectorStoreRuntime().sparseBackend, "postgres_bm25");
});

test("a new index version's table gets the statistics objects through the migration-030 installer, and retire drops them", () => {
  assert.equal(getPgvectorBm25InstallFunctionName(), "rag_document_chunks_install_bm25");
  assert.equal(
    renderPgvectorBm25InstallStatement({ chunkTable: "rag_document_chunks_v4", textSearchConfig: "simple" }),
    "SELECT rag_document_chunks_install_bm25('rag_document_chunks_v4', 'simple'::regconfig);"
  );
  assert.throws(
    () => renderPgvectorBm25InstallStatement({ chunkTable: "x'; DROP TABLE y; --", textSearchConfig: "simple" }),
    /not a simple PostgreSQL table name/
  );
  assert.throws(
    () => renderPgvectorBm25InstallStatement({ chunkTable: "rag_document_chunks_v4", textSearchConfig: "simple'" }),
    /not a simple text search configuration/
  );
  assert.throws(() => getPgvectorSparseSearchFunctionName("t".repeat(43)), /63 bytes/);
  assert.equal(getPgvectorSparseSearchFunctionName("rag_document_chunks_v4"), "rag_document_chunks_v4_sparse_search");
  assert.equal(getPgvectorSparseFoldFunctionName("rag_document_chunks_v4"), "rag_document_chunks_v4_sparse_fold");
  assert.deepEqual(getPgvectorSparseStatisticsTables("rag_document_chunks_v4"), {
    scopeLog: "rag_document_chunks_v4_sparse_scope_log",
    scopes: "rag_document_chunks_v4_sparse_scopes",
    termLog: "rag_document_chunks_v4_sparse_term_log",
    terms: "rag_document_chunks_v4_sparse_terms",
  });

  const drop = renderPgvectorBm25DropDdl({ chunkTable: "rag_document_chunks_v4" });

  assert.ok(drop.includes(`DROP FUNCTION IF EXISTS rag_document_chunks_v4_sparse_search${PGVECTOR_SPARSE_SEARCH_SIGNATURE};`));

  for (const name of [
    "sparse_stats_ins",
    "sparse_stats_del",
    "sparse_stats_upd",
    "sparse_stats_trunc",
    "sparse_fold",
    "sparse_length",
  ]) {
    assert.match(drop, new RegExp(`DROP FUNCTION IF EXISTS rag_document_chunks_v4_${name}\\(\\);`));
  }

  // Tables after the functions; the chunk table (and its triggers) went first.
  for (const table of ["sparse_term_log", "sparse_scope_log", "sparse_terms", "sparse_scopes"]) {
    assert.ok(drop.indexOf(`DROP TABLE IF EXISTS rag_document_chunks_v4_${table};`) > drop.indexOf("_sparse_length()"), table);
  }
});

test("migrations 029 and 030 render for the configured table names", async () => {
  const tableNames = {
    adminAuditEventsTable: "a_audit",
    agentRunEventsTable: "a_run_events",
    agentRunsTable: "a_runs",
    documentChunksTable: "custom_chunks",
    documentsTable: "custom_documents",
    indexVersionsTable: "custom_versions",
    ingestJobsTable: "custom_jobs",
    longMemoryTable: "a_memory",
    sessionMemoryTable: "a_sessions",
    taskEventsTable: "a_task_events",
    tasksTable: "a_tasks",
    workspaceArtifactsTable: "a_artifacts",
  };
  const [column, statistics] = await Promise.all(
    ["029_add_chunk_sparse_length.sql", "030_create_sparse_bm25_statistics.sql"].map(async (fileName) =>
      renderMigrationSql(
        await readFile(new URL(`../db/migrations/${fileName}`, import.meta.url), "utf8"),
        tableNames,
        { embeddingDimensions: 8, tenantRole: "custom_tenant", textSearchConfig: "english" }
      )
    )
  );

  assert.match(column, /lower\('custom_chunks'\)/);
  assert.match(column, /FROM custom_versions v/);
  assert.match(statistics, /CREATE OR REPLACE FUNCTION custom_chunks_install_bm25\(target_table text, text_search_config regconfig\)/);
  assert.match(statistics, /tenant_role CONSTANT text := 'custom_tenant';/);
  assert.match(statistics, /documents_table CONSTANT text := lower\('custom_documents'\);/);
  assert.match(statistics, /SELECT custom_chunks_install_bm25\('custom_chunks', 'english'::regconfig\);/);
  assert.match(statistics, /REVOKE ALL ON FUNCTION custom_chunks_install_bm25\(text, regconfig\) FROM PUBLIC;/);
  assert.doesNotMatch(statistics, /__[A-Z_]+__/, "every placeholder is rendered");
});

const createFakeDatabase = ({ searchRows = [], rankRows = [], failSearch = null } = {}) => {
  const calls = [];
  const query = async (sql, values = []) => {
    const compact = String(sql).replace(/\s+/g, " ").trim();

    calls.push({ sql: compact, values });

    if (/FROM pg_extension/.test(compact)) {
      return { rows: [{ extversion: "0.7.4" }] };
    }

    if (/FROM pg_attribute/.test(compact)) {
      return { rows: [{ typmod: 4 }] };
    }

    if (/_sparse_search\(/.test(compact)) {
      if (failSearch) {
        throw failSearch;
      }

      return { rows: searchRows };
    }

    if (/AS sparse_score/.test(compact) || /_sparse_rank\(/.test(compact)) {
      return { rows: rankRows };
    }

    return { rowCount: 0, rows: [] };
  };

  return {
    calls,
    runtime: {
      checkPostgresHealth: async () => ({ message: "ok", status: "ok" }),
      isPostgresConfigured: () => true,
      query,
      runMigrations: async () => ({ appliedMigrations: [], status: "ok" }),
    },
  };
};

const row = ({ candidateMode, chunkIndex = 0, content, docId, score }) => ({
  chunk_id: `${docId}:${chunkIndex}`,
  chunk_index: chunkIndex,
  content,
  doc_id: docId,
  metadata: { fileName: `${docId}.pdf` },
  page_number: 1,
  section_heading: null,
  sparse_score: score,
  ...(candidateMode ? { candidate_mode: candidateMode } : {}),
});

const searchCalls = (database) => database.calls.filter((entry) => /_sparse_search\(/.test(entry.sql));

test("the sparse route calls the active version's search function with the query, scoring, k1, b, pruning fraction and cap", async () => {
  process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  configureEmbeddingDimensions(4);

  const database = createFakeDatabase({
    searchRows: [
      row({ candidateMode: "pruned", content: "Amber ceiling is 2400 dollars.", docId: "doc-1", score: 3.7 }),
      row({ candidateMode: "pruned", chunkIndex: 1, content: "Amber again.", docId: "doc-2", score: 1.2 }),
    ],
  });

  configurePgvectorRuntime(database.runtime);
  process.env.RAG_SPARSE_SCORING = "bm25";
  process.env.RAG_BM25_K1 = "1.5";

  const results = await searchPgvectorSparseDocuments({
    docIds: ["doc-1", "doc-2", "doc-1"],
    queryText: "What is the Amber ceiling?",
    topK: 5,
  });
  const call = searchCalls(database)[0];

  assert.ok(call, "the search function ran");
  assert.equal(database.calls.some((entry) => /ts_rank_cd|_sparse_rank\(/.test(entry.sql)), false);
  assert.match(
    call.sql,
    /FROM rag_document_chunks_sparse_search\( to_tsquery\(\$1::regconfig, \$2\), to_tsvector\(\$1::regconfig, \$3\),/
  );
  assert.match(call.sql, /JOIN rag_document_chunks c ON c.chunk_id = r.chunk_id/);
  assert.deepEqual(call.values, [
    "simple",
    "'amber' | 'ceiling'",
    "amber ceiling",
    ["doc-1", "doc-2"],
    5,
    "bm25",
    1.5,
    0.75,
    DEFAULT_SPARSE_PRUNE_DF_FRACTION,
    PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS,
    DEFAULT_SPARSE_COMMON_TERM_CAP,
  ]);
  assert.deepEqual(
    results.map((result) => [result.document.id, result.sparseScore, result.score, result.sparseCandidates]),
    [
      ["doc-1:0", 3.7, 3.7, "pruned"],
      ["doc-2:1", 1.2, 1.2, "pruned"],
    ]
  );
  assert.equal(results[0].keywordScore, 1);

  // Per-call overrides: exhaustive and uncapped BM25.
  await searchPgvectorSparseDocuments({ commonTermCap: null, docIds: ["doc-1"], pruneDfFraction: null, queryText: "amber", topK: 3 });
  assert.deepEqual(searchCalls(database).at(-1).values.slice(8), [null, PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS, null]);

  // ts_rank_cd: one document keeps the plain statement ...
  const before = searchCalls(database).length;

  await searchPgvectorSparseDocuments({ docIds: ["doc-1"], queryText: "amber", scoring: "ts_rank_cd", topK: 3 });
  assert.ok(database.calls.at(-1).sql.includes("ts_rank_cd(search_vector"));
  assert.equal(searchCalls(database).length, before);

  // ... several documents with pruning on go through the search function ...
  await searchPgvectorSparseDocuments({ docIds: ["doc-1", "doc-2"], queryText: "amber", scoring: "ts_rank_cd", topK: 3 });
  assert.equal(searchCalls(database).at(-1).values[5], "ts_rank_cd");

  // ... and with pruning off they keep the plain statement.
  await searchPgvectorSparseDocuments({
    docIds: ["doc-1", "doc-2"],
    pruneDfFraction: null,
    queryText: "amber",
    scoring: "ts_rank_cd",
    topK: 3,
  });
  assert.ok(database.calls.at(-1).sql.includes("ts_rank_cd(search_vector"));
});

test("a version without the search function, or a tenant without its grant, fails with the remedy", async () => {
  process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  configureEmbeddingDimensions(4);

  const missing = Object.assign(
    new Error("function rag_document_chunks_sparse_search(tsquery, tsvector, text[]) does not exist"),
    { code: "42883" }
  );

  configurePgvectorRuntime(createFakeDatabase({ failSearch: missing }).runtime);
  await assert.rejects(
    searchPgvectorSparseDocuments({ docIds: ["doc-1"], queryText: "amber", scoring: "bm25", topK: 3 }),
    (error) =>
      error.code === "PGVECTOR_SPARSE_SEARCH_UNAVAILABLE" &&
      /RAG_SPARSE_SCORING=ts_rank_cd and RAG_SPARSE_PRUNE_DF_FRACTION=off/.test(error.message)
  );

  const denied = Object.assign(new Error("permission denied for function rag_document_chunks_sparse_search"), {
    code: "42501",
  });

  configurePgvectorRuntime(createFakeDatabase({ failSearch: denied }).runtime);
  await assert.rejects(
    searchPgvectorSparseDocuments({ docIds: ["doc-1", "doc-2"], queryText: "amber", topK: 3 }),
    (error) => error.code === "PGVECTOR_SPARSE_SEARCH_UNAVAILABLE" && /checks.rowLevelSecurity/.test(error.message)
  );

  const other = Object.assign(new Error("boom"), { code: "42883" });

  assert.equal(toMissingSparseSearchFunctionError(other, "t"), other, "other missing functions pass through");
  assert.match(buildPgvectorSparseSearchSql({ chunkTable: "rag_document_chunks_v2" }), /rag_document_chunks_v2_sparse_search\(/);
});

test("the sparse-scoring evaluation compares pruned to exhaustive lists and reads evidence rows", () => {
  assert.deepEqual(parseFractions("0.05, 0.1,abc,1,0"), [0.05, 0.1]);
  assert.deepEqual(comparePrunedToExhaustive(["a", "b"], ["a", "b"]), { identical: true, recallAtK: 1, sameSet: true });
  assert.deepEqual(comparePrunedToExhaustive(["b", "a"], ["a", "b"]), { identical: false, recallAtK: 1, sameSet: true });
  assert.deepEqual(comparePrunedToExhaustive(["a", "c"], ["a", "b"]), { identical: false, recallAtK: 0.5, sameSet: false });
  assert.deepEqual(comparePrunedToExhaustive([], []), { identical: true, recallAtK: 1, sameSet: true });
  assert.deepEqual(
    summarizePruning([
      comparePrunedToExhaustive(["a", "b"], ["a", "b"]),
      comparePrunedToExhaustive(["a", "c"], ["a", "b"]),
    ]),
    { meanRecallAtK: 0.75, minRecallAtK: 0.5, queries: 2, queriesWithDifferentOrder: 1, queriesWithDifferentSet: 1 }
  );

  const result = (page) => ({ document: { metadata: { pageNumber: page } } });

  assert.deepEqual(
    recallRow({
      confidence: { usableResults: [result(2)] },
      expectedPages: new Set([4]),
      id: "q1",
      results: [result(2), result(3), result(4)],
    }),
    { admitted: false, hitAt1: false, hitAt3: true, hitAtAll: true, id: "q1" }
  );

  // Over several papers only the question's own paper's page counts.
  const onPaper = (docId, page) => ({ document: { metadata: { docId, pageNumber: page } } });

  assert.deepEqual(
    recallRow({
      confidence: { usableResults: [onPaper("other", 4)] },
      docId: "paper",
      expectedPages: new Set([4]),
      id: "q2",
      results: [onPaper("other", 4), onPaper("paper", 4)],
    }),
    { admitted: false, hitAt1: false, hitAt3: true, hitAtAll: true, id: "q2" }
  );

  // The regimes: pruning is measured where it runs (all papers), and the
  // per-tenant arm is paired with the pooled single-paper arm.
  assert.deepEqual(REGIMES.global.map((arm) => arm.id), ["ts_rank_cd", "ts_rank_cd_pruned", "bm25", "bm25_pruned"]);
  assert.ok(REGIMES.single.every((arm) => arm.pruneDfFraction === null));
  assert.ok(COMPARISONS.some(([left, leftArm, right, rightArm]) => left === "tenant" && leftArm === "bm25_tenant" && right === "single" && rightArm === "bm25"));
  assert.ok(COMPARISONS.some(([left, leftArm, right, rightArm]) => left === "global" && leftArm === "ts_rank_cd_pruned" && right === "global" && rightArm === "ts_rank_cd"));
  assert.deepEqual(tenantCopyOf("paper-1"), { docId: "tenant-paper-1", scope: { userId: "tenant-paper-1", workspaceId: "" } });
  assert.deepEqual(
    ["pruned", "pruned_filled", "common_bounded", "exhaustive", "plain", undefined].map(sliceOfPath),
    ["mixed", "mixed", "all_common", "no_common", "no_match", "no_match"]
  );
  assert.deepEqual(summarizeLatency([4, 1, 3, 2]), { count: 4, p50Ms: 2, p95Ms: 4 });

  const recall = { admitted: 0.2, hitAt1: 0.3, hitAt3: 0.5, hitAtAll: 0.7 };
  const ci = { delta: 0.01, ci95: [-0.01, 0.03] };
  const markdown = formatSparseScoringReport({
    config: { b: 0.75, chunks: 10, commonTermCap: 2000, corpus: "c.json", documents: 2, embeddingModel: "m", k1: 1.2, postgresVersion: "18", pruneDfFraction: 0.1, pruneMinChunks: 1000, questions: 3, retrievalTopK: 6, seed: 1, sparseTopK: 8 },
    generatedAt: "now",
    summary: {
      comparisons: { hybrid: { "global:ts_rank_cd_pruned − global:ts_rank_cd": { admitted: ci, hitAt1: ci, hitAt3: ci, hitAtAll: ci } } },
      raw: {
        mixed: {
          bm25_pruned: {
            exhaustiveLatency: { p50Ms: 9, p95Ms: 20 },
            latency: { p50Ms: 3, p95Ms: 5 },
            lists: { meanRecallAtK: 0.98, minRecallAtK: 0.5, queries: 2, queriesWithDifferentOrder: 1, queriesWithDifferentSet: 1 },
          },
        },
      },
      recall: { global: { hybrid: { ts_rank_cd: recall } } },
      slices: { all_common: { comparisons: { hybrid: { bm25_pruned: { hitAtAll: ci } } }, questions: 1, recall: { hybrid: { bm25_pruned: recall } } } },
    },
  });

  assert.match(markdown, /\| global \| hybrid \| ts_rank_cd \| 0.3 \| 0.5 \| 0.7 \| 0.2 \|/);
  assert.match(markdown, /\| hybrid \| global:ts_rank_cd_pruned − global:ts_rank_cd \| hitAtAll \| 0.01 \| \[-0.01, 0.03\] \|/);
  assert.match(markdown, /\| all_common \| 1 \| hybrid \| bm25_pruned \| 0.7 \| 0.01 \[-0.01, 0.03\] \|/);
  assert.match(markdown, /\| mixed \| bm25_pruned \| 2 \| 1 \| 1 \| 0.98 \| 0.5 \| 3 \| 5 \| 9 \/ 20 \|/);
});

test("the sparse_length backfill command reads its batch, lock timeout and dry-run options", () => {
  assert.deepEqual(parseSparseLengthBackfillArgs([]), {
    batchSize: 500,
    dryRun: false,
    help: false,
    lockTimeoutMs: 2000,
    maxBatches: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(
    parseSparseLengthBackfillArgs(["--dry-run", "--batch-size", "50", "--lock-timeout-ms", "500", "--max-batches", "3"]),
    { batchSize: 50, dryRun: true, help: false, lockTimeoutMs: 500, maxBatches: 3 }
  );
  assert.throws(() => parseSparseLengthBackfillArgs(["--batch-size", "0"]), /positive integer/);
  assert.throws(() => parseSparseLengthBackfillArgs(["--apply"]), /Unknown option/);
});
