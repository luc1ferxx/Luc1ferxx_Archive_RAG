import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The local index loads its file when first imported; keep it in a temp dir.
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "query-adapter-test-"));
process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");

const { configureOpenAIProvider, embedQuery, resetOpenAIProvider } = await import("../rag/openai.js");
const { embedQueryCached, resetEmbeddingCache } = await import("../rag/embedding-cache.js");
const {
  QUERY_ADAPTER_SCOPE_QA,
  QueryAdapterConfigError,
  adaptQueryVectorForSearch,
  applyQueryAdapter,
  assertSameQueryAdapterFingerprint,
  describeQueryAdapter,
  describeQueryAdapterHealth,
  getModelQueryVectorSpace,
  getQueryAdapterReportFingerprint,
  getQueryVectorAdapterFingerprint,
  parseQueryAdapter,
  resetQueryAdapter,
  serializeQueryAdapter,
  stampQueryAdapterProvenance,
} = await import("../rag/query-adapter.js");
const {
  addDocumentsToIndex,
  mergeRouteSummaries,
  resetVectorStore,
  searchDocumentsPerDocumentWithRoutes,
  searchDocumentsWithRoutes,
  supportsDenseScoreVector,
} = await import("../rag/vector-store.js");
const { executeDocumentRag, retrieveQaCandidates } = await import("../rag/document-rag-execution.js");
const { configureEmbeddingDimensions } = await import("../rag/config.js");
const { configurePgvectorRuntime, resetPgvectorRuntime, resetPgvectorVectorStore, searchPgvectorDocuments } =
  await import("../rag/vector-store-pgvector.js");
const { buildAdapterTrainingIndex, selectAdapterTrainingCases } = await import("../evaluation/query-adapter-data.mjs");
const { collectAdapterStamps, countVectorScoreDrift, decideQueryAdapter, pairedMeanDelta, scoreAdapterRow } =
  await import("../evaluation/run-query-adapter-eval.mjs");

const SPACE = Object.freeze({ dimensions: 3, documentPrefix: "", model: "adapter-test-model", queryPrefix: "" });
// y = W q with W a cyclic permutation: [a, b, c] -> [c, a, b].
const PERMUTATION = [0, 0, 1, 1, 0, 0, 0, 1, 0];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

let fileCounter = 0;
const writeAdapter = ({ embedding = SPACE, matrix = PERMUTATION } = {}) => {
  const filePath = path.join(tempRoot, `adapter-${(fileCounter += 1)}.json`);

  writeFileSync(filePath, JSON.stringify(serializeQueryAdapter({ embedding, matrix, training: { note: "test" } })));
  return filePath;
};

const ENV_KEYS = [
  "OPENAI_EMBEDDING_MODEL",
  "RAG_EMBEDDING_DIMENSIONS",
  "RAG_EMBEDDING_QUERY_PREFIX",
  "RAG_EMBEDDING_DOCUMENT_PREFIX",
  "RAG_EMBEDDING_QUERY_ADAPTER",
  "VECTOR_STORE_PROVIDER",
  "RAG_HYBRID_ENABLED",
  "RAG_RETRIEVAL_ROUTE",
  "RAG_RERANK_ENABLED",
  "RAG_HYBRID_FUSION",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const useSpace = ({
  adapterPath = null,
  model = SPACE.model,
  dimensions = SPACE.dimensions,
  queryPrefix = "",
  documentPrefix = "",
} = {}) => {
  process.env.OPENAI_EMBEDDING_MODEL = model;
  process.env.RAG_EMBEDDING_DIMENSIONS = String(dimensions);
  process.env.RAG_EMBEDDING_QUERY_PREFIX = queryPrefix;
  process.env.RAG_EMBEDDING_DOCUMENT_PREFIX = documentPrefix;
  process.env.VECTOR_STORE_PROVIDER = "local";
  process.env.RAG_HYBRID_ENABLED = "true";
  process.env.RAG_RERANK_ENABLED = "false";
  delete process.env.RAG_RETRIEVAL_ROUTE;
  delete process.env.RAG_HYBRID_FUSION;

  if (adapterPath) {
    process.env.RAG_EMBEDDING_QUERY_ADAPTER = adapterPath;
  } else {
    delete process.env.RAG_EMBEDDING_QUERY_ADAPTER;
  }
};

// A stand-in embedding provider: `vectors` maps a text to its vector, anything
// else gets `fallback`. `allowQueryAdapter` is the explicit opt-in that makes
// its query vectors count as the model's (rag/openai.js).
const useProvider = ({ allowQueryAdapter = false, fallback = [1, 2, 3], vectors = {} } = {}) => {
  const calls = [];
  const vectorOf = (text) => [...(vectors[text] ?? fallback)];

  configureOpenAIProvider({
    ...(allowQueryAdapter ? { allowQueryAdapter: true } : {}),
    completeText: async () => "The answer is in the evidence [Source 1].",
    embedQuery: async (query, options) => {
      calls.push({ options, query });
      return vectorOf(query);
    },
    embedTexts: async (texts) => texts.map(vectorOf),
  });

  return calls;
};

// Two chunks of one paper. The query's model vector is [1, 0, 0]: unadapted
// it is nearest "alpha" (cosine 1, "beta" 0); W q = [0, 1, 0] is nearest
// "beta". The texts share no word with the query, so the sparse route adds
// nothing and the fused order is the dense order.
const ALPHA = "alpha paragraph";
const BETA = "beta paragraph";
const QUERY = "question";
const PAPER_VECTORS = { [ALPHA]: [1, 0, 0], [BETA]: [0, 1, 0], [QUERY]: [1, 0, 0] };

const indexPaper = async (docId = "doc-1") => {
  await addDocumentsToIndex({
    documents: [ALPHA, BETA].map((text, chunkIndex) => ({
      id: `${docId}:${chunkIndex}`,
      metadata: { chunkIndex, docId, fileName: `${docId}.pdf`, pageNumber: chunkIndex + 1 },
      pageContent: text,
    })),
  });
};

const summarize = (search) =>
  search.results.map((result) => ({
    admissionScore: result.admissionScore,
    text: result.document.pageContent,
    vectorScore: result.vectorScore,
  }));

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  resetOpenAIProvider();
  resetEmbeddingCache();
  resetQueryAdapter();
  resetVectorStore();
});

test.after(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

test("the file format round-trips and the fingerprint covers weights and space", () => {
  const adapter = parseQueryAdapter(serializeQueryAdapter({ embedding: SPACE, matrix: PERMUTATION }));

  assert.equal(adapter.dimensions, 3);
  assert.equal(adapter.identity, "adapter-test-model");
  assert.deepEqual(Array.from(adapter.matrix), PERMUTATION);
  assert.match(adapter.fingerprint, /^qa1-[0-9a-f]{16}$/);
  assert.equal(
    parseQueryAdapter(serializeQueryAdapter({ embedding: SPACE, matrix: PERMUTATION })).fingerprint,
    adapter.fingerprint
  );
  assert.notEqual(
    parseQueryAdapter(serializeQueryAdapter({ embedding: SPACE, matrix: IDENTITY })).fingerprint,
    adapter.fingerprint
  );
  assert.notEqual(
    parseQueryAdapter(serializeQueryAdapter({ embedding: { ...SPACE, queryPrefix: "q: " }, matrix: PERMUTATION }))
      .fingerprint,
    adapter.fingerprint
  );
});

test("malformed adapter files are refused", () => {
  const valid = serializeQueryAdapter({ embedding: SPACE, matrix: PERMUTATION });

  assert.throws(() => parseQueryAdapter({ ...valid, format: "other" }), QueryAdapterConfigError);
  assert.throws(
    () => parseQueryAdapter({ ...valid, weights: { ...valid.weights, data: Buffer.alloc(8).toString("base64") } }),
    /bytes/
  );
  assert.throws(
    () => parseQueryAdapter(serializeQueryAdapter({ embedding: SPACE, matrix: [NaN, 0, 0, 0, 1, 0, 0, 0, 1] })),
    /non-finite/
  );
  assert.throws(() => parseQueryAdapter({ ...valid, embedding: { ...SPACE, dimensions: 0 } }), QueryAdapterConfigError);
});

test("applying W keeps the query's length and tags the vector", () => {
  const adapter = parseQueryAdapter(serializeQueryAdapter({ embedding: SPACE, matrix: PERMUTATION }));
  const adapted = applyQueryAdapter(adapter, [3, 4, 0]);

  assert.deepEqual(adapted, [0, 3, 4]);
  assert.equal(getQueryVectorAdapterFingerprint(adapted), adapter.fingerprint);
  assert.equal(getQueryVectorAdapterFingerprint([0, 3, 4]), null);
  assert.throws(() => applyQueryAdapter(adapter, [1, 2]), /expects 3/);
});

test("embedQuery returns the model's vector unchanged; only a model (or opted-in) vector is marked with its space", async () => {
  useSpace({ adapterPath: writeAdapter() });

  useProvider({ fallback: [1, 2, 3] });
  const standIn = await embedQuery("question");
  assert.deepEqual(standIn, [1, 2, 3]);
  assert.equal(getModelQueryVectorSpace(standIn), null);
  assert.equal(getQueryVectorAdapterFingerprint(standIn), null);

  useProvider({ allowQueryAdapter: true, fallback: [1, 2, 3] });
  const model = await embedQuery("question");
  assert.deepEqual(model, [1, 2, 3]);
  assert.deepEqual({ ...getModelQueryVectorSpace(model) }, { ...SPACE });

  // A vector embedded for an index version pinned to another space is marked
  // with that space, not the configured one.
  const pinned = await embedQuery("question", {
    embeddingSpace: { dimensions: 3, documentPrefix: "d: ", model: "pinned-model", queryPrefix: "q: " },
  });
  assert.deepEqual(
    { ...getModelQueryVectorSpace(pinned) },
    { dimensions: 3, documentPrefix: "d: ", model: "pinned-model", queryPrefix: "q: " }
  );
});

test("the query-embedding cache holds the model's vectors: switching the adapter never re-embeds or changes them", async () => {
  const calls = useProvider({ allowQueryAdapter: true, fallback: [1, 2, 3] });

  useSpace();
  const first = await embedQueryCached("question");

  useSpace({ adapterPath: writeAdapter() });
  assert.equal(await embedQueryCached("question"), first);
  assert.deepEqual(first, [1, 2, 3]);
  assert.equal(calls.length, 1);
});

test("the dense route ranks by W q but vectorScore and admission stay the model's cosine", async () => {
  useSpace();
  useProvider({ allowQueryAdapter: true, vectors: PAPER_VECTORS });
  await indexPaper();

  const queryVector = await embedQueryCached(QUERY);
  const args = { docIds: ["doc-1"], queryAdapterScope: QUERY_ADAPTER_SCOPE_QA, queryText: QUERY, queryVector, topK: 2 };
  const plain = await searchDocumentsWithRoutes(args);

  process.env.RAG_EMBEDDING_QUERY_ADAPTER = writeAdapter();
  const adapted = await searchDocumentsWithRoutes(args);
  const fingerprint = describeQueryAdapter().fingerprint;

  assert.deepEqual(summarize(plain).map((row) => row.text), [ALPHA, BETA]);
  assert.deepEqual(summarize(adapted).map((row) => row.text), [BETA, ALPHA]);
  // Same chunk, same cosine and admission score in both arms: the floors
  // (RAG_MIN_RELEVANCE_SCORE, selectQaContext's extras) read the scale they
  // were set on, while W q alone would score beta 1 and alpha 0.
  const byText = (rows) => Object.fromEntries(rows.map((row) => [row.text, row]));
  assert.deepEqual(byText(summarize(adapted)), byText(summarize(plain)));
  assert.equal(byText(summarize(adapted))[ALPHA].vectorScore, 1);
  assert.equal(byText(summarize(adapted))[BETA].vectorScore, 0);
  assert.deepEqual(countVectorScoreDrift(plain.results, adapted.results), { compared: 2, drifted: 0, maxAbsDiff: 0 });

  assert.equal(adapted.routes.dense.queryAdapter, fingerprint);
  assert.deepEqual(collectAdapterStamps(adapted.results), [fingerprint]);
  assert.equal("queryAdapter" in plain.routes.dense, false);
  assert.deepEqual(collectAdapterStamps(plain.results), [null]);
  assert.equal(supportsDenseScoreVector(), true);
});

test("the adapter applies to single-document QA retrieval on the hybrid route only", async () => {
  useSpace({ adapterPath: writeAdapter() });
  useProvider({ allowQueryAdapter: true, vectors: PAPER_VECTORS });
  await indexPaper("doc-1");
  await indexPaper("doc-2");

  const fingerprint = describeQueryAdapter().fingerprint;
  const queryVector = await embedQueryCached(QUERY);
  const qa = { docIds: ["doc-1"], queryAdapterScope: QUERY_ADAPTER_SCOPE_QA, queryText: QUERY, queryVector, topK: 2 };
  const stampOf = (search) => search.routes.dense.queryAdapter ?? null;

  assert.equal(stampOf(await searchDocumentsWithRoutes(qa)), fingerprint);
  // The QA route's own entry point passes the scope.
  const candidates = await retrieveQaCandidates({ docIds: ["doc-1"], resolvedQuery: QUERY });
  assert.deepEqual(collectAdapterStamps(candidates.results), [fingerprint]);
  assert.equal(candidates.results[0].document.pageContent, BETA);

  // Callers without the scope: comparison per document, gap-plan and other
  // global searches.
  assert.equal(stampOf(await searchDocumentsWithRoutes({ ...qa, queryAdapterScope: null })), null);
  const perDocument = await searchDocumentsPerDocumentWithRoutes({ docIds: ["doc-1", "doc-2"], queryText: QUERY, queryVector, topKPerDoc: 2 });
  assert.equal(perDocument.routes.dense.queryAdapter, undefined);
  // More than one document.
  assert.equal(stampOf(await searchDocumentsWithRoutes({ ...qa, docIds: ["doc-1", "doc-2"] })), null);

  // Weighted fusion scores the dense route by vectorScore: never measured.
  process.env.RAG_HYBRID_FUSION = "weighted";
  assert.equal(stampOf(await searchDocumentsWithRoutes(qa)), null);
  delete process.env.RAG_HYBRID_FUSION;

  // Dense-only (measured worse) and a forced dense route.
  process.env.RAG_HYBRID_ENABLED = "false";
  const denseOnly = await searchDocumentsWithRoutes(qa);
  assert.equal(stampOf(denseOnly), null);
  assert.equal(denseOnly.results[0].document.pageContent, ALPHA);
  process.env.RAG_HYBRID_ENABLED = "true";
  process.env.RAG_RETRIEVAL_ROUTE = "dense";
  assert.equal(stampOf(await searchDocumentsWithRoutes(qa)), null);
});

test("agent-planned document retrieval stays unadapted; the plain QA route is adapted", async () => {
  useSpace({ adapterPath: writeAdapter() });
  useProvider({ allowQueryAdapter: true, vectors: PAPER_VECTORS });
  await indexPaper();

  const fingerprint = describeQueryAdapter().fingerprint;
  const run = (agentRetrievalPlan) =>
    executeDocumentRag({
      agentRetrievalPlan,
      docIds: ["doc-1"],
      query: QUERY,
      resolvedQuery: QUERY,
      selectedDocuments: [{ docId: "doc-1", fileName: "doc-1.pdf" }],
    });

  const plain = await run(null);
  const planned = await run({
    intent: "qa",
    retrievalOptions: { profile: "default" },
    retrievalQueries: [{ id: "primary", primary: true, query: QUERY }],
  });

  assert.equal(plain.response.retrieval.routes.dense.queryAdapter, fingerprint);
  assert.equal(planned.response.retrieval.routes.dense.queryAdapter, undefined);
});

test("a stand-in provider is never adapted: the deterministic path is byte-identical with the adapter set", async () => {
  // What eval:synthetic and the quality gates run: a configured nomic space,
  // a 64-dimension deterministic stand-in and (from server/.env) an adapter
  // trained for nomic.
  const nomic = { dimensions: 768, documentPrefix: "search_document: ", model: "nomic-embed-text", queryPrefix: "search_query: " };
  const shift = new Array(768 * 768).fill(0);

  for (let row = 0; row < 768; row += 1) {
    shift[row * 768 + ((row + 1) % 768)] = 1;
  }

  const nomicAdapter = writeAdapter({ embedding: nomic, matrix: shift });
  const basis = (dimensions, index) => Array.from({ length: dimensions }, (_, position) => (position === index ? 1 : 0));

  for (const dimensions of [64, 768]) {
    const vectors = { [ALPHA]: basis(dimensions, 0), [BETA]: basis(dimensions, 1), [QUERY]: basis(dimensions, 0) };
    const runOnce = async (adapterPath) => {
      resetVectorStore();
      resetEmbeddingCache();
      resetQueryAdapter();
      useSpace({
        adapterPath,
        dimensions: 768,
        documentPrefix: nomic.documentPrefix,
        model: nomic.model,
        queryPrefix: nomic.queryPrefix,
      });
      useProvider({ vectors });
      await indexPaper();

      const vector = await embedQuery(QUERY);
      const candidates = await retrieveQaCandidates({ docIds: ["doc-1"], resolvedQuery: QUERY });

      return JSON.stringify({ candidates, vector });
    };

    const without = await runOnce(null);
    const withAdapter = await runOnce(nomicAdapter);

    assert.equal(withAdapter, without, `${dimensions}-dimension stand-in`);
    assert.doesNotMatch(withAdapter, /queryAdapter/);
  }
});

test("a mismatched, missing or half-written adapter never fails a query; it searches unadapted", async () => {
  useProvider({ allowQueryAdapter: true, vectors: PAPER_VECTORS });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));

  try {
    const truncated = path.join(tempRoot, "half-written.json");
    writeFileSync(truncated, JSON.stringify(serializeQueryAdapter({ embedding: SPACE, matrix: PERMUTATION })).slice(0, 40));

    for (const adapterPath of [
      writeAdapter({ embedding: { ...SPACE, model: "another-model" } }),
      path.join(tempRoot, "missing.json"),
      truncated,
    ]) {
      resetVectorStore();
      resetEmbeddingCache();
      resetQueryAdapter();
      useSpace({ adapterPath });
      await indexPaper();

      const candidates = await retrieveQaCandidates({ docIds: ["doc-1"], resolvedQuery: QUERY });

      assert.deepEqual(collectAdapterStamps(candidates.results), [null]);
      assert.equal(candidates.results[0].document.pageContent, ALPHA);
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.some((message) => /space_mismatch/.test(message)));
  assert.ok(warnings.some((message) => /adapter_unavailable/.test(message) && /cannot read/.test(message)));
});

test("a query embedded in the adapter's space is adapted even while the configured model has moved on", async () => {
  // The index-version window: the configured model changed, the active
  // version is still pinned to the adapter's space and embeds queries there.
  useSpace({ adapterPath: writeAdapter(), model: "the-next-model" });
  useProvider({ allowQueryAdapter: true, fallback: [1, 0, 0] });

  const pinnedVector = await embedQuery(QUERY, { embeddingSpace: { ...SPACE } });
  const configuredVector = await embedQuery(QUERY);
  const search = { docIds: ["doc-1"], hybrid: true, scope: QUERY_ADAPTER_SCOPE_QA, supportsScoreVector: true };

  assert.deepEqual(adaptQueryVectorForSearch({ ...search, queryVector: pinnedVector }).rankVector, [0, 1, 0]);
  assert.equal(adaptQueryVectorForSearch({ ...search, queryVector: configuredVector }), null);
  assert.equal(adaptQueryVectorForSearch({ ...search, queryVector: pinnedVector, supportsScoreVector: false }), null);
});

test("checks.queryAdapter: an unusable file is an error, settings it would never apply under are warnings", () => {
  const healthy = { hybrid: true, supportsScoreVector: true };

  useSpace();
  assert.equal(describeQueryAdapterHealth(healthy).status, "disabled");

  useSpace({ adapterPath: path.join(tempRoot, "missing.json") });
  assert.equal(describeQueryAdapterHealth(healthy).status, "error");

  const truncated = path.join(tempRoot, "truncated-health.json");
  writeFileSync(truncated, "{\"format\":");
  resetQueryAdapter();
  useSpace({ adapterPath: truncated });
  assert.equal(describeQueryAdapterHealth(healthy).status, "error");

  resetQueryAdapter();
  useSpace({ adapterPath: writeAdapter() });
  const ok = describeQueryAdapterHealth(healthy);
  assert.equal(ok.status, "ok");
  assert.equal(ok.warnings, undefined);
  assert.equal(ok.fingerprint, describeQueryAdapter().fingerprint);
  assert.deepEqual(describeQueryAdapterHealth({ hybrid: false, supportsScoreVector: false }).warnings, [
    "route_not_hybrid",
    "store_cannot_keep_model_cosine",
  ]);
  assert.deepEqual(describeQueryAdapterHealth({ ...healthy, fusion: "weighted" }).warnings, ["fusion_not_rrf"]);

  useSpace({ adapterPath: writeAdapter(), model: "another-model" });
  assert.deepEqual(describeQueryAdapterHealth(healthy).warnings, ["space_mismatch"]);
});

test("reports carry the adapter fingerprint and refuse to pair runs made with different ones", () => {
  useSpace();
  assert.equal(getQueryAdapterReportFingerprint(), null);

  useSpace({ adapterPath: writeAdapter() });
  const fingerprint = getQueryAdapterReportFingerprint();
  assert.match(fingerprint, /^qa1-/);

  useSpace({ adapterPath: path.join(tempRoot, "missing.json") });
  assert.equal(getQueryAdapterReportFingerprint(), "unavailable:QUERY_ADAPTER_INVALID");

  assert.doesNotThrow(() => assertSameQueryAdapterFingerprint(null, undefined));
  assert.doesNotThrow(() => assertSameQueryAdapterFingerprint(fingerprint, fingerprint));
  assert.throws(
    () => assertSameQueryAdapterFingerprint(fingerprint, null, { label: "old.json" }),
    (error) => error.code === "QUERY_ADAPTER_MISMATCH" && /old\.json/.test(error.message)
  );
  assert.throws(() => assertSameQueryAdapterFingerprint(null, fingerprint), QueryAdapterConfigError);
});

test("pgvector ranks by the adapted vector and reads vectorScore from the model's vector", async () => {
  const MODEL = "pgvector-adapter-model";
  const calls = [];
  let extensionVersion = "0.7.4";
  const rows = [
    { chunk_id: "doc-1:1", chunk_index: 1, content: BETA, doc_id: "doc-1", metadata: { docId: "doc-1" }, page_number: 2, score_vector_score: 0.2, section_heading: null, vector_score: 0.9 },
    { chunk_id: "doc-1:0", chunk_index: 0, content: ALPHA, doc_id: "doc-1", metadata: { docId: "doc-1" }, page_number: 1, score_vector_score: 0.8, section_heading: null, vector_score: 0.1 },
  ];
  const query = async (sql, values = []) => {
    const compact = sql.replace(/\s+/g, " ").trim();

    calls.push({ sql: compact, values });

    if (/FROM pg_extension/.test(compact)) {
      return { rows: [{ extversion: extensionVersion }] };
    }

    if (/FROM pg_attribute/.test(compact)) {
      return { rows: [{ typmod: 3 }] };
    }

    if (/GROUP BY embedding_model/.test(compact)) {
      return { rows: [{ chunk_count: 2, embedding_dimensions: 3, embedding_model: MODEL }] };
    }

    if (/AS access_method/.test(compact)) {
      return { rows: [{ access_method: "hnsw" }] };
    }

    if (/to_regclass/.test(compact)) {
      return { rows: [{ relation: values[0] }] };
    }

    if (/AS vector_score/.test(compact)) {
      return { rows: /score_vector_score/.test(compact) ? rows : rows.map(({ score_vector_score, ...row }) => row) };
    }

    return { rowCount: 0, rows: [] };
  };

  process.env.OPENAI_EMBEDDING_MODEL = MODEL;
  configureEmbeddingDimensions(3);
  resetPgvectorVectorStore();
  configurePgvectorRuntime({
    checkPostgresHealth: async () => ({ message: "ok", status: "ok" }),
    isPostgresConfigured: () => true,
    query,
    runMigrations: async () => ({ appliedMigrations: [], status: "ok" }),
    withTransaction: async (callback) => callback({ query }),
  });

  try {
    const base = { docIds: ["doc-1"], queryText: QUERY, scoringMode: "dense", topK: 2 };
    const scored = await searchPgvectorDocuments({ ...base, queryVector: [0, 1, 0], scoreVector: [1, 0, 0] });
    const scoredCall = calls.findLast((call) => /AS vector_score/.test(call.sql));

    assert.match(scoredCall.sql, /1 - \(embedding <=> \$6::vector\) AS score_vector_score/);
    assert.match(scoredCall.sql, /ORDER BY embedding <=> \$1::vector ASC, chunk_id ASC LIMIT \$5/);
    assert.deepEqual(scoredCall.values, ["[0,1,0]", ["doc-1"], MODEL, 3, 2, "[1,0,0]"]);
    assert.deepEqual(
      scored.map((result) => [result.document.pageContent, result.score, result.vectorScore, result.rankVectorScore]),
      [
        [BETA, 0.9, 0.2, 0.9],
        [ALPHA, 0.1, 0.8, 0.1],
      ]
    );

    const plain = await searchPgvectorDocuments({ ...base, queryVector: [1, 0, 0] });
    const plainCall = calls.findLast((call) => /AS vector_score/.test(call.sql));

    assert.doesNotMatch(plainCall.sql, /score_vector_score/);
    assert.deepEqual(plainCall.values, ["[1,0,0]", ["doc-1"], MODEL, 3, 2]);
    assert.equal("rankVectorScore" in plain[0], false);
    assert.equal(plain[0].vectorScore, plain[0].score);

    // pgvector 0.8 iterative scans: the materialized CTE carries both distances.
    extensionVersion = "0.8.6";
    resetPgvectorVectorStore();
    const iterative = await searchPgvectorDocuments({ ...base, queryVector: [0, 1, 0], scoreVector: [1, 0, 0] });
    const iterativeCall = calls.findLast((call) => /AS vector_score/.test(call.sql));

    assert.match(iterativeCall.sql, /embedding <=> \$6::vector AS score_distance/);
    assert.match(iterativeCall.sql, /1 - score_distance AS score_vector_score FROM nearest ORDER BY distance \+ 0 ASC/);
    assert.deepEqual(iterative.map((result) => result.vectorScore), [0.2, 0.8]);
  } finally {
    resetPgvectorRuntime();
    resetPgvectorVectorStore();
    configureEmbeddingDimensions(null);
  }
});

test("dense-route provenance carries a fingerprint only when one is given", () => {
  const search = {
    results: [
      { provenance: { fusion: null, routes: [{ rank: 1, route: "dense", score: 0.9 }] } },
      { provenance: { fusion: null, routes: [{ rank: 1, route: "sparse", score: 4 }] } },
    ],
    routes: { dense: { candidateCount: 1, executed: true, topK: 6 }, sparse: { candidateCount: 1, executed: true, topK: 8 } },
  };

  assert.equal(stampQueryAdapterProvenance(search, null), search);

  const stamped = stampQueryAdapterProvenance(search, "qa1-0123456789abcdef");
  assert.equal(stamped.routes.dense.queryAdapter, "qa1-0123456789abcdef");
  assert.equal(stamped.results[0].provenance.queryAdapter, "qa1-0123456789abcdef");
  assert.equal(stamped.results[1].provenance.queryAdapter, undefined);
  assert.equal(mergeRouteSummaries(stamped.routes, search.routes).dense.queryAdapter, "qa1-0123456789abcdef");
  assert.equal(mergeRouteSummaries(search.routes).dense.queryAdapter, undefined);
});

test("training data: positives are the chunks on evidence paragraphs, unmatched questions are dropped", () => {
  const corpus = {
    cases: [
      { docKeys: ["p1"], expectedEvidence: [{ pages: [2] }], id: "a", question: "qa", shouldAbstain: false },
      { docKeys: ["p2"], expectedEvidence: [{ pages: [9] }], id: "b", question: "qb", shouldAbstain: false },
      { docKeys: ["p2"], expectedEvidence: [{ pages: [1, 3] }], id: "c", question: "qc", shouldAbstain: false },
      { docKeys: ["p1"], expectedEvidence: [], id: "d", question: "qd", shouldAbstain: true },
    ],
  };
  const cases = selectAdapterTrainingCases(corpus);
  const index = buildAdapterTrainingIndex({
    cases,
    chunksByPaper: new Map([
      ["p1", [1, 2, 2, 3]],
      ["p2", [1, 2, 3]],
    ]),
  });

  assert.deepEqual(cases.map((testCase) => testCase.id), ["a", "b", "c"]);
  assert.deepEqual(index.chunkPaper, [0, 0, 0, 0, 1, 1, 1]);
  assert.deepEqual(index.chunkPage, [1, 2, 2, 3, 1, 2, 3]);
  assert.equal(index.dropped, 1);
  assert.deepEqual(
    index.questions.map(({ id, paper, positives }) => ({ id, paper, positives })),
    [
      { id: "a", paper: 0, positives: [1, 2] },
      { id: "c", paper: 1, positives: [4, 6] },
    ]
  );
});

test("eval rows, drift, paired means and the pre-declared decision rule", () => {
  const page = (pageNumber) => ({ document: { metadata: { pageNumber } } });

  assert.deepEqual(
    scoreAdapterRow({
      admittedResults: [page(2)],
      contextResults: [page(2), page(5)],
      expectedPages: [5],
      gateConfident: true,
      id: "x",
      results: [page(2), page(3), page(4), page(5)],
    }),
    {
      admitted: false,
      candidateCount: 4,
      "context@0": true,
      extraCount: 1,
      gateConfident: true,
      hitAt1: false,
      hitAt3: false,
      hitAtAll: true,
      hitRank: 4,
      id: "x",
    }
  );

  const dense = (chunkIndex, vectorScore, queryId = "primary") => ({
    document: { metadata: { chunkIndex, docId: "d" } },
    provenance: { queries: [{ queryId }], routes: [{ route: "dense" }] },
    vectorScore,
  });
  assert.deepEqual(countVectorScoreDrift([dense(0, 0.7), dense(1, 0.5)], [dense(1, 0.5), dense(2, 0.1)]), {
    compared: 1,
    drifted: 0,
    maxAbsDiff: 0,
  });
  assert.equal(countVectorScoreDrift([dense(0, 0.7)], [dense(0, 0.2)]).drifted, 1);
  // A merged candidate kept from another retrieval query carries that query's cosine.
  assert.equal(countVectorScoreDrift([dense(0, 0.7, "q1")], [dense(0, 0.4, "q2")]).compared, 0);

  const delta = pairedMeanDelta(
    [{ id: "a", extraCount: 3 }, { id: "b", extraCount: 1 }],
    [{ id: "a", extraCount: 1 }, { id: "b", extraCount: 1 }],
    "extraCount"
  );
  assert.equal(delta.delta, 1);
  assert.equal(delta.cases, 2);

  const up = { ci95: [0.004, 0.03], delta: 0.017 };
  const flat = { ci95: [-0.01, 0.02], delta: 0.005 };
  const answerable = { "context@0": up, hitAtAll: up };

  assert.equal(decideQueryAdapter({ answerable, unanswerable: { gateConfident: flat } }).recommend, true);
  // Candidates alone are not enough: the context the model reads must gain too.
  assert.equal(
    decideQueryAdapter({ answerable: { ...answerable, "context@0": flat }, unanswerable: { gateConfident: flat } }).recommend,
    false
  );
  assert.equal(
    decideQueryAdapter({ answerable: { ...answerable, hitAtAll: { ci95: [0, 0.03], delta: 0.015 } }, unanswerable: { gateConfident: flat } })
      .recommend,
    false
  );
  // A measured rise in false admissions on unanswerable questions blocks it.
  const rejected = decideQueryAdapter({ answerable, unanswerable: { gateConfident: { ci95: [0.01, 0.09], delta: 0.05 } } });
  assert.equal(rejected.recommend, false);
  assert.match(rejected.reason, /No retrieval gain: .*unanswerable\.falseAdmit/);
  // Not measured is not a pass.
  assert.equal(decideQueryAdapter({ answerable, unanswerable: null }).recommend, false);
});
