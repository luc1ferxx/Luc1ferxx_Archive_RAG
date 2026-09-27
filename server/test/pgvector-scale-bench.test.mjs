import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuerySet,
  buildTopicWords,
  buildVocabulary,
  clusterForDocument,
  cosineSimilarity,
  createCorpus,
  createGaussian,
  createSeededRandom,
  decideSizeRun,
  DEFAULT_OPTIONS,
  deriveSeed,
  docIdFor,
  formatBytes,
  formatMarkdown,
  formatVectorLiteral,
  generateCentroids,
  generateChunkText,
  generateClusteredVector,
  generateDocumentChunks,
  hnswMaintenanceWorkMemMb,
  normalizeVector,
  isSearchStatement,
  parseArgs,
  parseSize,
  parseSizes,
  percentile,
  PROJECTION_SAFETY_FACTOR,
  planUsesIndex,
  projectStepMs,
  quantizeVector,
  recallAtK,
  recallSampleSize,
  SERIES,
  summarizeLatencies,
  summarizeBuildMessages,
  summarizePlan,
  summarizeRecall,
  VECTOR_SCALE,
} from "../evaluation/run-pgvector-scale-bench.mjs";
import { extractMeaningfulTokens } from "../rag/text-utils.js";

const norm = (vector) => Math.sqrt(Array.from(vector).reduce((sum, value) => sum + value * value, 0));

test("parseSize and parseSizes accept k/M suffixes, dedupe and sort", () => {
  assert.equal(parseSize("10k"), 10000);
  assert.equal(parseSize("1M"), 1000000);
  assert.equal(parseSize("2.5k"), 2500);
  assert.equal(parseSize(" 750 "), 750);
  assert.throws(() => parseSize("ten"), /Invalid size/);
  assert.throws(() => parseSize("0"), /Invalid size/);
  assert.deepEqual(parseSizes("500k,10k,100k,10k"), [10000, 100000, 500000]);
});

test("isSearchStatement recognizes the app's dense and sparse statements, including the tenant rank function", () => {
  assert.equal(isSearchStatement("SELECT chunk_id FROM t ORDER BY x LIMIT $5"), true);
  assert.equal(
    isSearchStatement("SELECT c.chunk_id FROM rag_document_chunks_sparse_rank(to_tsquery($1::regconfig, $2), $3::text[], $4) AS r JOIN t c ON c.chunk_id = r.chunk_id"),
    true
  );
  assert.equal(isSearchStatement("SELECT set_config($1, $2, true)"), false);
});

test("parseArgs requires an explicit database URL and validates numbers", () => {
  assert.throws(() => parseArgs([]), /--database-url/);
  assert.throws(() => parseArgs(["--database-url"]), /Missing value/);
  assert.throws(() => parseArgs(["--database-url", "postgres://x/y", "--bogus", "1"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--database-url", "postgres://x/y", "--queries", "0"]), /positive/);
  assert.throws(() => parseArgs(["--database-url", "postgres://x/y", "--latest-name", "../x"]), /file stem/);
  assert.throws(() => parseArgs(["--database-url", "postgres://x/y", "--iterative-scan", "on"]), /--iterative-scan/);
  assert.equal(parseArgs(["--database-url", "postgres://x/y"]).iterativeScan, "relaxed_order");
  assert.equal(parseArgs(["--database-url", "postgres://x/y", "--iterative-scan", "OFF"]).iterativeScan, "off");

  const options = parseArgs([
    "--",
    "--database-url",
    " postgres://x/y ",
    "--sizes",
    "2k",
    "--queries",
    "5",
    "--recall-queries",
    "9",
    "--ingest-probes",
    "0",
    "--noise",
    "0.5",
    "--time-budget-minutes",
    "2.5",
  ]);

  assert.equal(options.databaseUrl, "postgres://x/y");
  assert.deepEqual(options.sizes, [2000]);
  assert.equal(options.queries, 5);
  assert.equal(options.recallQueries, 5, "recall sample is capped at the query count");
  assert.equal(options.ingestProbes, 0);
  assert.equal(options.noise, 0.5);
  assert.equal(options.timeBudgetMinutes, 2.5);
  assert.equal(options.dimensions, DEFAULT_OPTIONS.dimensions);
  assert.deepEqual(DEFAULT_OPTIONS.sizes, [10000, 100000, 500000, 1000000]);
});

test("seeded random, derived seeds and gaussian samples are deterministic", () => {
  const first = createSeededRandom(7);
  const second = createSeededRandom(7);
  const values = Array.from({ length: 5 }, () => first());

  assert.deepEqual(values, Array.from({ length: 5 }, () => second()));
  assert.ok(values.every((value) => value >= 0 && value < 1));
  assert.equal(deriveSeed(1, 2, 3), deriveSeed(1, 2, 3));
  assert.notEqual(deriveSeed(1, 2, 3), deriveSeed(1, 2, 4));
  assert.notEqual(deriveSeed(1, 2, 3), deriveSeed(1, 3, 3));

  const gaussian = createGaussian(createSeededRandom(11));
  const samples = Array.from({ length: 20000 }, () => gaussian());
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;

  assert.ok(Math.abs(mean) < 0.05, `mean ${mean}`);
  assert.ok(Math.abs(variance - 1) < 0.05, `variance ${variance}`);
});

test("clustered vectors are unit length and closer within a cluster than across", () => {
  const dimensions = 256;
  const centroids = generateCentroids({ clusters: 2, dimensions, seed: 3 });
  const gaussian = createGaussian(createSeededRandom(5));
  const draw = (cluster) => generateClusteredVector({ centroid: centroids[cluster], gaussian, noise: 1 });
  const a1 = draw(0);
  const a2 = draw(0);
  const b1 = draw(1);

  for (const vector of [...centroids, a1, a2, b1]) {
    assert.ok(Math.abs(norm(vector) - 1) < 1e-9);
  }

  // noise 1: ~0.71 to the centroid, ~0.5 between members, ~0 across clusters.
  assert.ok(Math.abs(cosineSimilarity(a1, centroids[0]) - Math.SQRT1_2) < 0.1);
  assert.ok(Math.abs(cosineSimilarity(a1, a2) - 0.5) < 0.15);
  assert.ok(Math.abs(cosineSimilarity(a1, b1)) < 0.2);
  assert.deepEqual(Array.from(normalizeVector(new Float64Array([0, 0]))), [0, 0]);
});

test("vector literals use integer mantissas that round-trip to the quantized values", () => {
  const vector = new Float64Array([0.123456, -0.000004, 0.5]);
  const literal = formatVectorLiteral(vector);

  assert.equal(literal, "[12346e-5,0e-5,50000e-5]");
  assert.deepEqual(
    literal.slice(1, -1).split(",").map(Number),
    quantizeVector(vector)
  );
  assert.deepEqual(quantizeVector(vector), [0.12346, 0, 0.5]);
  assert.equal(VECTOR_SCALE, 1e5);
});

test("vocabulary words are unique and survive the app tokenizer", () => {
  const vocabulary = buildVocabulary(5000);

  assert.equal(new Set(vocabulary).size, 5000);
  assert.deepEqual(extractMeaningfulTokens(vocabulary.join(" ")), vocabulary);
  assert.throws(() => buildVocabulary(70 ** 3 + 1), /exceeds/);

  const topics = buildTopicWords({ clusters: 3, seed: 1, vocabulary });

  assert.equal(topics.length, 3);
  assert.ok(topics.every((words) => words.length === 40 && new Set(words).size === 40));

  const text = generateChunkText({ random: createSeededRandom(1), topicWords: topics[0], vocabulary, words: 50 });

  assert.equal(text.split(" ").length, 50);
  assert.ok(text.split(" ").some((word) => topics[0].includes(word)));
});

test("documents regenerate identically from (seed, docIndex)", () => {
  const corpus = createCorpus({ clusters: 4, dimensions: 32, noise: 1, seed: 9, wordsPerChunk: 20 });
  const first = generateDocumentChunks({ chunksPerDoc: 3, corpus, docIndex: 12 });
  const again = generateDocumentChunks({ chunksPerDoc: 3, corpus, docIndex: 12 });

  assert.equal(first.length, 3);
  assert.deepEqual(first.map((chunk) => chunk.chunkId), ["bench-doc-0000012:0", "bench-doc-0000012:1", "bench-doc-0000012:2"]);
  assert.deepEqual(first.map((chunk) => chunk.pageNumber), [1, 1, 1]);
  assert.deepEqual(
    first.map((chunk) => [chunk.content, formatVectorLiteral(chunk.vector)]),
    again.map((chunk) => [chunk.content, formatVectorLiteral(chunk.vector)])
  );
  assert.equal(first[0].cluster, clusterForDocument({ clusters: 4, docIndex: 12, seed: 9 }));
  assert.equal(docIdFor(3), "bench-doc-0000003");
});

test("query sets are deterministic, target a document and include it in the document set", () => {
  const corpus = createCorpus({ clusters: 4, dimensions: 32, noise: 1, seed: 9, wordsPerChunk: 20 });
  const queries = buildQuerySet({ corpus, count: 6, docCount: 30, docSetSize: 10, seed: 9 });
  const again = buildQuerySet({ corpus, count: 6, docCount: 30, docSetSize: 10, seed: 9 });

  assert.deepEqual(queries, again);

  for (const query of queries) {
    assert.equal(query.docSet.length, 10);
    assert.equal(new Set(query.docSet).size, 10);
    assert.ok(query.docSet.includes(query.docId));
    assert.equal(query.vector.length, 32);
    assert.equal(query.text.split(" ").length, 4);
  }

  const small = buildQuerySet({ corpus, count: 2, docCount: 3, docSetSize: 100, seed: 9 });

  assert.ok(small.every((query) => query.docSet.length === 3), "a document set never exceeds the corpus");
});

test("percentile uses nearest rank and summarizeLatencies rounds", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);

  assert.equal(percentile(values, 0.5), 50);
  assert.equal(percentile(values, 0.95), 95);
  assert.equal(percentile(values, 1), 100);
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(percentile([], 0.5), null);
  assert.deepEqual(summarizeLatencies([1.23456, 2, 3]), {
    count: 3,
    maxMs: 3,
    meanMs: 2.078,
    p50Ms: 2,
    p95Ms: 3,
  });
  assert.equal(summarizeLatencies([]).p50Ms, null);
});

test("recallAtK compares the top-k sets against exact results", () => {
  assert.equal(recallAtK(["a", "b", "c"], ["a", "b", "c"], 3), 1);
  assert.equal(recallAtK(["a", "x", "c"], ["a", "b", "c"], 3), 2 / 3);
  assert.equal(recallAtK(["a"], ["a", "b", "c", "d"], 3), 1 / 3, "missing rows count against recall");
  assert.equal(recallAtK(["a", "b"], ["a", "b"], 10), 1, "fewer exact rows than k");
  assert.equal(recallAtK([], [], 10), 1);
  assert.equal(recallAtK(["a"], [], 10), 0);
  assert.equal(recallAtK(["d", "a"], ["a", "b", "c", "d"], 2), 0.5, "only the first k of each side count");

  // Filtered series check every timed query; the whole-table series only a sample.
  const options = { recallQueries: 20 };
  assert.equal(recallSampleSize({ options, series: "dense_docset", timedQueries: 100 }), 100);
  assert.equal(recallSampleSize({ options, series: "dense_1doc", timedQueries: 100 }), 100);
  assert.equal(recallSampleSize({ options, series: "dense_unfiltered_sql", timedQueries: 100 }), 20);
  assert.equal(recallSampleSize({ options, series: "dense_unfiltered_sql", timedQueries: 5 }), 5);
  assert.equal(recallSampleSize({ options, series: "sparse_docset", timedQueries: 100 }), 0);
  assert.equal(recallSampleSize({ options: { recallQueries: 0 }, series: "dense_docset", timedQueries: 100 }), 0);
  assert.deepEqual(summarizeRecall([1, 0.5, 1]), { meanRecall: 0.8333, minRecall: 0.5, queries: 3, queriesBelowOne: 1 });
  assert.equal(summarizeRecall([]).meanRecall, null);
});

test("projectStepMs scales the previous step and decideSizeRun skips over-budget sizes", () => {
  const previous = {
    chunks: 10000,
    indexBuild: { ginMs: 1000, hnswMs: 4000 },
    load: { analyzeMs: 100, deltaChunks: 10000, loadMs: 2000 },
    measureMs: 3000,
  };
  const projected = projectStepMs({ loadedChunks: 10000, previous, targetChunks: 100000 });
  const nLogN = (100000 * Math.log2(100000)) / (10000 * Math.log2(10000));

  assert.equal(PROJECTION_SAFETY_FACTOR, 1.2);
  assert.equal(
    projected,
    Math.round(1.2 * (0.2 * 90000 + 100 * 10 + 1000 * 10 + 4000 * nLogN + 3000 * 10))
  );
  assert.equal(projectStepMs({ loadedChunks: 0, previous: null, targetChunks: 10 }), null);

  assert.deepEqual(decideSizeRun({ budgetMs: 1000, elapsedMs: 100, projectedMs: null }), {
    projectedMs: null,
    remainingMs: 900,
    run: true,
  });
  assert.equal(decideSizeRun({ budgetMs: 1000, elapsedMs: 100, projectedMs: 900 }).run, true);

  const skip = decideSizeRun({ budgetMs: 600000, elapsedMs: 300000, projectedMs: 420000 });

  assert.equal(skip.run, false);
  assert.match(skip.reason, /projected 7 min exceeds the 5 min left/);
});

test("hnswMaintenanceWorkMemMb sizes the graph with headroom inside the cap", () => {
  assert.equal(hnswMaintenanceWorkMemMb({ capMb: 8192, chunks: 1000, dimensions: 768 }), 64);
  assert.equal(
    hnswMaintenanceWorkMemMb({ capMb: 8192, chunks: 1000000, dimensions: 768 }),
    Math.ceil((1000000 * (768 * 4 + 8 + 1024) * 1.25) / (1024 * 1024))
  );
  assert.equal(hnswMaintenanceWorkMemMb({ capMb: 2048, chunks: 1000000, dimensions: 768 }), 2048);
});

test("summarizePlan flattens EXPLAIN JSON and planUsesIndex finds an index", () => {
  const plan = [
    {
      Plan: {
        "Actual Rows": 10,
        "Node Type": "Limit",
        Plans: [
          {
            "Actual Rows": 3,
            "Index Name": "rag_document_chunks_embedding_idx",
            "Node Type": "Index Scan",
            "Rows Removed by Filter": 37,
          },
        ],
      },
    },
  ];
  const nodes = summarizePlan(plan);

  assert.deepEqual(nodes, ["Limit rows=10", "Index Scan (rag_document_chunks_embedding_idx) rows=3 filtered=37"]);
  assert.equal(planUsesIndex(nodes, "rag_document_chunks_embedding_idx"), true);
  assert.equal(planUsesIndex(nodes, "rag_document_chunks_doc_id_idx"), false);
  assert.deepEqual(summarizePlan({ Plan: { "Node Type": "Seq Scan" } }), ["Seq Scan"]);
  assert.deepEqual(summarizePlan(null), []);
});

test("formatBytes and formatMarkdown render a report", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GB");
  assert.equal(formatBytes(null), "n/a");

  const latency = Object.fromEntries(
    SERIES.map((series) => [series, { count: 5, maxMs: 3, meanMs: 2, meanReturned: 10, p50Ms: 2, p95Ms: 3, requested: 10 }])
  );
  const step = {
    chunks: 2000,
    disk: {
      btreeBytes: 100,
      documentsTotalBytes: 50,
      ginBytes: 200,
      heapBytes: 1000,
      hnswBytes: 3000,
      indexesBytes: 3300,
      toastBytes: 5000,
      totalBytes: 9300,
    },
    documents: 40,
    hybridDenseCandidates: { hybrid_1doc: 10, hybrid_docset: 9.5, requested: 10 },
    indexBuild: {
      ginMaintenanceWorkMemMb: 1024,
      ginMs: 100,
      ginParallelWorkers: null,
      hnswMs: 900,
      hnswParallelWorkers: 7,
      maintenanceWorkMemMb: 64,
      maxParallelMaintenanceWorkers: 8,
      minParallelTableScanSize: "1MB",
      notices: ["hnsw graph no longer fits"],
    },
    ingestProbe: { chunksPerDocument: 50, documents: 3, maxMs: 40, p50Ms: 30 },
    latency,
    load: { analyzeMs: 20, cumulativeLoadMs: 500, deltaChunks: 2000, loadMs: 500, rowsPerSecond: 4000 },
    plans: {
      dense_1doc: { app: ["Limit rows=10", "Sort rows=10"], exact: ["Limit"], usesHnsw: false },
      dense_docset: { app: ["Limit rows=10", "Index Scan (rag_document_chunks_embedding_idx) rows=10"], usesHnsw: true },
    },
    primingRead: {
      dense_docset: { count: 5, maxMs: 9, meanMs: 7, p50Ms: 7, p95Ms: 9 },
      sparse_docset: { count: 5, maxMs: 5, meanMs: 4, p50Ms: 4, p95Ms: 5 },
    },
    recall: { dense_docset: { meanRecall: 0.9, minRecall: 0.5, queries: 5, queriesBelowOne: 2 } },
    schemaVerifyMs: 12,
  };
  const reportConfig = {
    chunksPerDoc: 50,
    clusters: 256,
    dimensions: 768,
    docSetSize: 100,
    embeddingIdentity: "synthetic-clustered-unit",
    gitDirty: true,
    gitSha: "abc123",
    hnsw: { efSearch: "40", indexDefinition: "CREATE INDEX ... USING hnsw", iterativeScan: "off" },
    noise: 1,
    pgvectorVersion: "0.8.6",
    postgresVersion: "18.0",
    queries: 5,
    recallQueries: 5,
    rowLevelSecurity: "enforce",
    runtime: { hybridEnabled: true, hybridFusion: "rrf" },
    seed: 1,
    serverSettings: { shared_buffers: "128MB" },
    tenantRole: "archive_rag_tenant",
    topK: 10,
    vocabularySize: 5000,
    warmup: 2,
    wordsPerChunk: 120,
  };
  const markdown = formatMarkdown({
    config: reportConfig,
    generatedAt: "2026-09-26T00:00:00.000Z",
    skipped: [{ reason: "projected 30 min exceeds the 10 min left of the time budget", targetChunks: 1000000 }],
    steps: [step],
  });

  assert.match(markdown, /^# pgvector scale benchmark/);
  assert.match(markdown, /commit `abc123` \(uncommitted changes\); PostgreSQL 18\.0, pgvector 0\.8\.6/);
  assert.match(markdown, /POSTGRES_ROW_LEVEL_SECURITY=enforce/);
  assert.match(markdown, /hnsw\.ef_search=40, hnsw\.iterative_scan=off/);
  assert.match(
    formatMarkdown({
      config: { ...reportConfig, hnsw: { ...reportConfig.hnsw, appIterativeScan: "relaxed_order" } },
      generatedAt: "2026-09-26T00:00:00.000Z",
      skipped: [],
      steps: [step],
    }),
    /the app's dense route sets hnsw\.iterative_scan=relaxed_order per query \(server default off\)/
  );
  assert.match(markdown, /## 2,000 chunks \(40 documents\)/);
  assert.match(markdown, /\| 2,000 \| 40 \| 0\.5 s \| 0\.1 s \| 0\.9 s \| 9\.1 KB \| 2\.9 KB \| 2 \/ 3 \| 2 \/ 3 \| 2 \/ 3 \| 0\.9 \(HNSW\) \| n\/a \|/);
  assert.match(markdown, /recall on 5 of them\./, "an old report without filteredRecallQueries keeps its wording");
  const exactStep = {
    ...step,
    plans: { dense_docset: { app: ["Limit rows=10"], usesHnsw: false } },
    recall: {
      dense_docset: { meanRecall: 1, minRecall: 1, queries: 5, queriesBelowOne: 0 },
      dense_unfiltered_sql: { meanRecall: 0.6, minRecall: 0, queries: 2, queriesBelowOne: 2 },
    },
  };
  const exactMarkdown = formatMarkdown({
    config: { filteredRecallQueries: 5, hnsw: {}, queries: 5, recallQueries: 2, runtime: {}, serverSettings: {} },
    skipped: [],
    steps: [exactStep],
  });
  assert.match(exactMarkdown, /\| 1 \(exact, no HNSW\) \| 0\.6 \|/, "a recall of 1 without HNSW is labelled as exact");
  assert.match(exactMarkdown, /recall on 5 of them with a document filter and on 2 for the whole table\./);
  assert.doesNotMatch(exactMarkdown, /fsync off/);
  assert.match(
    formatMarkdown({ config: { hnsw: {}, runtime: {}, serverSettings: { fsync: "off" } }, skipped: [], steps: [step] }),
    /per document \(embedding excluded; fsync off on this cluster, so a lower bound for a durable server\)/
  );
  assert.match(markdown, /dense, document set \(searchPgvectorDocuments\) \| 2 \| 3 \| 2 \| 10 \/ 10 \| 0\.9 \(min 0\.5, 2\/5 below 1\) \| yes \|/);
  assert.match(markdown, /notices: "hnsw graph no longer fits"/);
  assert.match(markdown, /GIN build 0\.1 s \(maintenance_work_mem 1024 MB, parallel workers n\/a\)/);
  assert.match(markdown, /parallel workers 7 of max_parallel_maintenance_workers 8, min_parallel_table_scan_size 1MB/);
  assert.match(markdown, /## Sizes not run\n\n- 1,000,000 chunks: projected 30 min exceeds/);
  assert.match(markdown, /Ingest with live indexes: 3 documents of 50 chunks/);
  assert.match(markdown, /Priming reads .*dense_docset p50 7 \/ p95 9 ms, sparse_docset p50 4 \/ p95 5 ms\./);
  assert.doesNotMatch(
    formatMarkdown({ config: { hnsw: {}, runtime: {}, serverSettings: {} }, skipped: [], steps: [{ ...step, primingRead: undefined }] }),
    /Priming reads/
  );
});

test("summarizeBuildMessages reads the worker count and keeps notices", () => {
  assert.deepEqual(
    summarizeBuildMessages([
      { message: 'building index "x" on table "t" with request for 3 parallel workers', severity: "DEBUG" },
      { message: "using 8 parallel workers", severity: "DEBUG" },
      { message: "worker processed 314 tuples", severity: "DEBUG" },
      { message: "hnsw graph no longer fits into maintenance_work_mem after 278 tuples", severity: "NOTICE" },
    ]),
    { notices: ["hnsw graph no longer fits into maintenance_work_mem after 278 tuples"], parallelWorkers: 8 }
  );
  assert.deepEqual(
    summarizeBuildMessages([{ message: 'building index "g" on table "t" with request for 2 parallel workers', severity: "DEBUG" }]),
    { notices: [], parallelWorkers: 2 }
  );
  assert.deepEqual(summarizeBuildMessages([]), { notices: [], parallelWorkers: null });
});
