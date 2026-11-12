import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// RAG_QA_QUERY_EXPANSION (rag/query-expansion.js): multi_query rewrites the
// question and fuses the lists, hyde searches the dense route with the mean
// of the question's and a generated passage's vectors. Off, nothing changes.

// The local index loads its file when first imported; keep it in a temp dir.
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "qa-query-expansion-test-"));
process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");

const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const { embedHydeQueryVector, embedQueryCached, getQueryVectorEmbeddingSpace, resetEmbeddingCache } =
  await import("../rag/embedding-cache.js");
const { addDocumentsToIndex, resetVectorStore } = await import("../rag/vector-store.js");
const { executeDocumentRag, fuseExpandedQueryResults, retrieveQaCandidates } = await import(
  "../rag/document-rag-execution.js"
);
const {
  QUERY_EXPANSION_MAX_TOKENS,
  assertQaQueryExpansionSettings,
  describeQueryExpansionPrompt,
  listQueryExpansionPromptDescriptors,
  meanOfUnitVectors,
  parseHypotheticalPassage,
  parseRewrittenQueries,
  resolveQaQueryExpansion,
} = await import("../rag/query-expansion.js");
const { getQaQueryExpansion } = await import("../rag/config.js");
const { computeResultQueryTermCoverage } = await import("../rag/confidence.js");
const { getActivePromptTemplates, listPromptTemplates } = await import("../rag/prompt-catalog.js");
const { RequestCancelledError } = await import("../rag/request-deadline.js");
const { describeRetrievalConfig } = await import("../evaluation/eval-run-config.js");
const { summarizeQueryExpansion } = await import("../evaluation/run-abstention-gate-analysis.mjs");
const { createAppServices } = await import("../app-services.js");

const ENV_KEYS = [
  "OPENAI_EMBEDDING_MODEL",
  "RAG_EMBEDDING_DIMENSIONS",
  "RAG_EMBEDDING_QUERY_PREFIX",
  "RAG_EMBEDDING_DOCUMENT_PREFIX",
  "RAG_EMBEDDING_QUERY_ADAPTER",
  "VECTOR_STORE_PROVIDER",
  "RAG_HYBRID_ENABLED",
  "RAG_HYBRID_FUSION",
  "RAG_RETRIEVAL_ROUTE",
  "RAG_RERANK_ENABLED",
  "RAG_RETRIEVAL_TOP_K",
  "RAG_QA_DENSE_RESCUE",
  "RAG_QA_DENSE_RESCUE_THRESHOLD",
  "RAG_QA_QUERY_EXPANSION",
  "RAG_QA_QUERY_EXPANSION_COUNT",
  "RAG_QA_QUERY_EXPANSION_TEMPERATURE",
  "RETRIEVAL_SERVICE_URL",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

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
  resetVectorStore();
});

test.after(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

const withEnv = (values) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

// Three chunks of one paper and 3-dimension stand-in vectors. With top-K 2
// the question's own retrieval is [A, X]; the rewrite's is [B, A]; the HyDE
// vector (the mean of the question's [1, 0, 0] and the passage's [0, 1, 0])
// ranks A, then B. No chunk shares a word with the question, so the sparse
// route adds nothing and every coverage the gate reads is 0.
const QUESTION = "where was the treaty signed";
const REWRITE = "accord ratification venue";
const PASSAGE = "The treaty was signed at the venue in Geneva.";
const TEXTS = Object.freeze({
  A: "alpha clause about borders",
  X: "gamma appendix notes",
  B: "the accord ratification venue geneva",
});
const VECTORS = Object.freeze({
  [TEXTS.A]: [0.9, 0.1, 0],
  [TEXTS.X]: [0.8, 0, 0.6],
  [TEXTS.B]: [0, 1, 0],
  [QUESTION]: [1, 0, 0],
  [REWRITE]: [0, 1, 0],
  [PASSAGE]: [0, 1, 0],
});

const vectorOf = (text) => [...(VECTORS[text] ?? [0, 0, 1])];

// Indexes the three chunks with the stand-in vectors; the test then installs
// the models it needs (useModels), which keeps the index.
const useIndex = async () => {
  configureOpenAIProvider({
    embedQuery: async (query) => vectorOf(query),
    embedTexts: async (texts) => texts.map(vectorOf),
  });
  withEnv({
    OPENAI_EMBEDDING_MODEL: "expansion-test-model",
    RAG_EMBEDDING_DIMENSIONS: "3",
    RAG_EMBEDDING_DOCUMENT_PREFIX: "d: ",
    RAG_EMBEDDING_QUERY_ADAPTER: undefined,
    RAG_EMBEDDING_QUERY_PREFIX: "q: ",
    RAG_HYBRID_ENABLED: "true",
    RAG_HYBRID_FUSION: undefined,
    RAG_RERANK_ENABLED: "false",
    RAG_RETRIEVAL_ROUTE: undefined,
    RAG_RETRIEVAL_TOP_K: "2",
    VECTOR_STORE_PROVIDER: "local",
  });
  await addDocumentsToIndex({
    documents: Object.values(TEXTS).map((text, chunkIndex) => ({
      id: `doc-1:${chunkIndex}`,
      metadata: { chunkIndex, docId: "doc-1", fileName: "doc-1.pdf", pageNumber: chunkIndex + 1 },
      pageContent: text,
    })),
  });
};

// A stand-in model: the expansion prompts get `rewrites` / `passage` (or the
// error a test wants), anything else (an answer prompt) a short answer.
// `embedError` fails the passage's embedding, `failingQueries` the query
// embeddings of the texts it names. The stand-in sees raw texts; the prefix
// a real client would add travels in `embeddingSpace` (embeddedQueries).
const useModels = ({
  answer = "Geneva [Source 1].",
  embedError = null,
  failingQueries = {},
  passage = PASSAGE,
  replyError = null,
  rewrites = `1. ${REWRITE}`,
} = {}) => {
  const completions = [];
  const embeddedQueries = [];
  const embeddedTexts = [];

  configureOpenAIProvider({
    completeText: async (prompt, options) => {
      const kind = prompt.includes("search queries") ? "multi_query" : prompt.includes("short passage") ? "hyde" : "answer";

      completions.push({ kind, options, prompt });

      if (kind !== "answer" && replyError) {
        throw replyError;
      }

      return kind === "multi_query" ? rewrites : kind === "hyde" ? passage : answer;
    },
    embedQuery: async (query, options) => {
      embeddedQueries.push({ options, query });

      if (embedError && query === passage) {
        throw embedError;
      }

      if (failingQueries[query]) {
        throw failingQueries[query];
      }

      return vectorOf(query);
    },
    embedTexts: async (texts) => {
      embeddedTexts.push(texts);
      return texts.map(vectorOf);
    },
  });

  return { completions, embeddedQueries, embeddedTexts };
};

const summarize = (candidates) =>
  candidates.results.map((result) => ({
    keywordScore: result.keywordScore,
    queries: result.provenance?.queries?.map((query) => query.queryId),
    text: result.document.pageContent,
  }));

const retrieve = () => retrieveQaCandidates({ docIds: ["doc-1"], resolvedQuery: QUESTION });

test("the setting is off by default and refuses anything it does not know", () => {
  withEnv({ RAG_QA_QUERY_EXPANSION: undefined, RAG_QA_QUERY_EXPANSION_COUNT: undefined, RAG_QA_QUERY_EXPANSION_TEMPERATURE: undefined });
  assert.equal(getQaQueryExpansion(), null);

  for (const off of ["", "  ", "off", "OFF"]) {
    withEnv({ RAG_QA_QUERY_EXPANSION: off });
    assert.equal(getQaQueryExpansion(), null, JSON.stringify(off));
  }

  withEnv({ RAG_QA_QUERY_EXPANSION: " Multi_Query " });
  assert.deepEqual(getQaQueryExpansion(), { count: 3, mode: "multi_query", temperature: null });
  withEnv({ RAG_QA_QUERY_EXPANSION: "hyde", RAG_QA_QUERY_EXPANSION_COUNT: "5", RAG_QA_QUERY_EXPANSION_TEMPERATURE: "0" });
  assert.deepEqual(getQaQueryExpansion(), { count: 1, mode: "hyde", temperature: 0 });
  withEnv({ RAG_QA_QUERY_EXPANSION: "multi_query", RAG_QA_QUERY_EXPANSION_COUNT: "5", RAG_QA_QUERY_EXPANSION_TEMPERATURE: "0.7" });
  assert.deepEqual(getQaQueryExpansion(), { count: 5, mode: "multi_query", temperature: 0.7 });

  for (const [values, code] of [
    [{ RAG_QA_QUERY_EXPANSION: "multi-query" }, "RAG_QA_QUERY_EXPANSION_INVALID"],
    [{ RAG_QA_QUERY_EXPANSION: "rewrite" }, "RAG_QA_QUERY_EXPANSION_INVALID"],
    [{ RAG_QA_QUERY_EXPANSION: "multi_query", RAG_QA_QUERY_EXPANSION_COUNT: "0" }, "RAG_QA_QUERY_EXPANSION_COUNT_INVALID"],
    [{ RAG_QA_QUERY_EXPANSION: "multi_query", RAG_QA_QUERY_EXPANSION_COUNT: "6" }, "RAG_QA_QUERY_EXPANSION_COUNT_INVALID"],
    [{ RAG_QA_QUERY_EXPANSION: "multi_query", RAG_QA_QUERY_EXPANSION_COUNT: "2.5" }, "RAG_QA_QUERY_EXPANSION_COUNT_INVALID"],
    // Read for hyde too, so a typo does not wait for a switch of mode.
    [{ RAG_QA_QUERY_EXPANSION: "hyde", RAG_QA_QUERY_EXPANSION_COUNT: "three" }, "RAG_QA_QUERY_EXPANSION_COUNT_INVALID"],
    [{ RAG_QA_QUERY_EXPANSION_COUNT: "3", RAG_QA_QUERY_EXPANSION: "hyde", RAG_QA_QUERY_EXPANSION_TEMPERATURE: "-0.1" }, "RAG_QA_QUERY_EXPANSION_TEMPERATURE_INVALID"],
    [{ RAG_QA_QUERY_EXPANSION: "hyde", RAG_QA_QUERY_EXPANSION_TEMPERATURE: "2.5" }, "RAG_QA_QUERY_EXPANSION_TEMPERATURE_INVALID"],
    [{ RAG_QA_QUERY_EXPANSION: "hyde", RAG_QA_QUERY_EXPANSION_TEMPERATURE: "cold" }, "RAG_QA_QUERY_EXPANSION_TEMPERATURE_INVALID"],
  ]) {
    withEnv({ RAG_QA_QUERY_EXPANSION_COUNT: undefined, RAG_QA_QUERY_EXPANSION_TEMPERATURE: undefined, ...values });
    assert.throws(() => getQaQueryExpansion(), { code }, JSON.stringify(values));
  }

  // Off, the count and temperature are never read.
  withEnv({ RAG_QA_QUERY_EXPANSION: "off", RAG_QA_QUERY_EXPANSION_COUNT: "zero", RAG_QA_QUERY_EXPANSION_TEMPERATURE: "hot" });
  assert.equal(getQaQueryExpansion(), null);
});

test("combinations that would mix in scores against something other than the question refuse, also at the start", () => {
  const untouchable = new Proxy(
    {},
    {
      get: (_target, name) => assert.fail(`createAppServices read options.${String(name)}`),
      has: (_target, name) => assert.fail(`createAppServices probed options.${String(name)}`),
    }
  );
  const conflict = { code: "RAG_QA_QUERY_EXPANSION_CONFLICT" };

  for (const [values, refused] of [
    [{ RAG_QA_DENSE_RESCUE: "absolute", RAG_QA_DENSE_RESCUE_THRESHOLD: "0.7", RAG_QA_QUERY_EXPANSION: "multi_query" }, true],
    [{ RAG_QA_DENSE_RESCUE: "absolute", RAG_QA_DENSE_RESCUE_THRESHOLD: "0.7", RAG_QA_QUERY_EXPANSION: "hyde" }, true],
    [{ RETRIEVAL_SERVICE_URL: "http://127.0.0.1:5002", RAG_QA_QUERY_EXPANSION: "hyde" }, true],
    [{ RETRIEVAL_SERVICE_URL: "http://127.0.0.1:5002", RAG_QA_QUERY_EXPANSION: "multi_query" }, false],
    [{ RAG_EMBEDDING_QUERY_ADAPTER: "/tmp/adapter.json", RAG_QA_QUERY_EXPANSION: "hyde" }, true],
    [{ RAG_EMBEDDING_QUERY_ADAPTER: "/tmp/adapter.json", RAG_QA_QUERY_EXPANSION: "multi_query" }, false],
    [{ RAG_RERANK_ENABLED: "true", RAG_QA_QUERY_EXPANSION: "multi_query" }, true],
    [{ RAG_RERANK_ENABLED: "true", RAG_QA_QUERY_EXPANSION: "hyde" }, false],
  ]) {
    withEnv({
      RAG_EMBEDDING_QUERY_ADAPTER: undefined,
      RAG_QA_DENSE_RESCUE: undefined,
      RAG_QA_DENSE_RESCUE_THRESHOLD: undefined,
      RAG_RERANK_ENABLED: undefined,
      RETRIEVAL_SERVICE_URL: undefined,
      ...values,
    });

    if (refused) {
      assert.throws(() => resolveQaQueryExpansion(), conflict, JSON.stringify(values));
      assert.throws(() => assertQaQueryExpansionSettings(), conflict, JSON.stringify(values));
    } else {
      assert.equal(resolveQaQueryExpansion().mode, values.RAG_QA_QUERY_EXPANSION, JSON.stringify(values));
    }
  }

  withEnv({ RETRIEVAL_SERVICE_URL: undefined, RAG_RERANK_ENABLED: undefined, RAG_EMBEDDING_QUERY_ADAPTER: undefined });

  for (const [values, code] of [
    [{ RAG_QA_QUERY_EXPANSION: "hyde", RAG_QA_DENSE_RESCUE: "margin", RAG_QA_DENSE_RESCUE_THRESHOLD: "0.05" }, "RAG_QA_QUERY_EXPANSION_CONFLICT"],
    [{ RAG_QA_QUERY_EXPANSION: "fusion", RAG_QA_DENSE_RESCUE: undefined }, "RAG_QA_QUERY_EXPANSION_INVALID"],
  ]) {
    withEnv(values);
    assert.throws(() => createAppServices(untouchable, { uploadsDirectory: "/nonexistent" }), { code }, code);
  }
});

test("a multi_query reply is read one query per line, without markers, prefaces, repeats or the question", () => {
  const reply = [
    "Here are three search queries:",
    "1. What datasets are used for evaluation?",
    "2) \"Which corpora do they evaluate on\"",
    "- what datasets are used for evaluation",
    "Q-learning baselines compared?",
    "(4) Where do they sign the treaty?",
  ].join("\n");

  assert.deepEqual(parseRewrittenQueries(reply, { count: 3, question: "What datasets do they use?" }), [
    "What datasets are used for evaluation?",
    "Which corpora do they evaluate on",
    "Q-learning baselines compared?",
  ]);
  assert.deepEqual(
    parseRewrittenQueries("Query 1: alpha\nQ2: beta\nquery: gamma\n2.5 million parameter models?", {
      count: 5,
      question: "x",
    }),
    ["alpha", "beta", "gamma", "2.5 million parameter models?"]
  );
  // A label needs a space after ".", ")" or "-": a quarter that starts the query stays.
  assert.deepEqual(
    parseRewrittenQueries("Q3-2024 revenue growth\nQ4.2024 revenue\nQ2) delta epsilon\nQuery 3 - zeta eta", {
      count: 5,
      question: "x",
    }),
    ["Q3-2024 revenue growth", "Q4.2024 revenue", "delta epsilon", "zeta eta"]
  );
  // A line with no term a store would score is no query and takes no slot.
  assert.deepEqual(
    parseRewrittenQueries("1.\nWhich corpora are used?\n2.\n```\n---\n...\nN/A\nWhat is it?\nWhat training data does the paper use?", {
      count: 2,
      question: "What datasets do they train on?",
    }),
    ["Which corpora are used?", "What training data does the paper use?"]
  );
  // The question itself, a preface in Chinese, an empty line and an overlong line never count.
  assert.deepEqual(
    parseRewrittenQueries(`以下是改写：\n\n条约在哪里签署？\n${"long ".repeat(100)}\n签约地点`, {
      count: 3,
      question: "条约在哪里签署",
    }),
    ["签约地点"]
  );
  assert.deepEqual(parseRewrittenQueries("", { count: 3, question: "x" }), []);
});

test("a hyde reply is read as one passage", () => {
  assert.equal(parseHypotheticalPassage("Passage:  We evaluate on SQuAD\n and NewsQA. "), "We evaluate on SQuAD and NewsQA.");
  assert.equal(parseHypotheticalPassage("答案：在日内瓦签署。"), "答案：在日内瓦签署。");
  assert.equal(parseHypotheticalPassage("   \n "), null);
  assert.equal(parseHypotheticalPassage("word ".repeat(1000)).length, 2000);
});

test("HyDE's vector is the normalized mean of two unit vectors", () => {
  assert.deepEqual(meanOfUnitVectors([3, 4, 0], [0, 0, 2]), [0.6 / Math.SQRT2, 0.8 / Math.SQRT2, 1 / Math.SQRT2]);
  // Scale does not matter, only direction.
  assert.deepEqual(meanOfUnitVectors([10, 0], [0, 0.1]), meanOfUnitVectors([1, 0], [0, 1]));
  assert.throws(() => meanOfUnitVectors([1, 0], [1, 0, 0]), /one width/);
  assert.throws(() => meanOfUnitVectors([0, 0], [1, 0]), /zero vector/);
  assert.throws(() => meanOfUnitVectors([1, 0], [-1, 0]), /cancel out/);
});

test("the fused list: reciprocal rank over the lists, the question's copy kept, a rewrite-only copy measured against the question", () => {
  const result = (key, fields = {}) => ({
    document: { metadata: { chunkIndex: key, docId: "doc-1" }, pageContent: `text ${key} venue` },
    keywordScore: 0.9,
    provenance: { queries: [{ queryId: fields.queryId ?? "primary" }] },
    score: 0.5,
    vectorScore: 0.4,
    ...fields,
  });
  const question = [result("a", { keywordScore: 0.2 }), result("x", { keywordScore: 0.1 })];
  const rewriteOne = [result("b", { queryId: "rewrite-1" }), result("a", { keywordScore: 0.95, queryId: "rewrite-1" })];
  // A store stores null coverage for a query with no term; the gate would read it as enough.
  const rewriteTwo = [
    result("c", { keywordScore: null, queryId: "rewrite-2" }),
    result("b", { queryId: "rewrite-2", vectorScore: 0.3 }),
  ];
  const fused = fuseExpandedQueryResults({
    lists: [question, rewriteOne, rewriteTwo],
    queryText: "where is the venue",
    rrfK: 60,
    topK: 3,
  });

  // a: 1/61 + 1/62; b: 1/61 + 1/62 (tie: a came from the question's list); c: 1/61; x: 1/62;
  // scaled by 61 / 3 lists into (0, 1].
  const scaled = (sum) => Number(((sum * 61) / 3).toFixed(6));
  assert.deepEqual(
    fused.map((entry) => [entry.document.metadata.chunkIndex, Number(entry.score.toFixed(6))]),
    [
      ["a", scaled(1 / 61 + 1 / 62)],
      ["b", scaled(1 / 61 + 1 / 62)],
      ["c", scaled(1 / 61)],
    ]
  );
  // Ranked first by every list: 1.
  assert.equal(
    fuseExpandedQueryResults({ lists: [question.slice(0, 1), question.slice(0, 1)], queryText: "q", rrfK: 60, topK: 1 })[0].score,
    1
  );
  // The question's own copy, untouched apart from the fused score, with both queries.
  assert.equal(fused[0].keywordScore, 0.2);
  assert.deepEqual(fused[0].provenance.queries.map((query) => query.queryId), ["primary", "rewrite-1"]);
  // b: the copy of its best rank (rewrite-1, rank 1), remeasured against the question.
  const coverage = computeResultQueryTermCoverage(fused[1], "where is the venue");
  assert.equal(fused[1].vectorScore, 0.4);
  assert.equal(fused[1].keywordScore, coverage);
  assert.notEqual(coverage, 0.9);
  assert.equal(fused[1].admissionScore, Math.max(0.4, coverage));
  assert.deepEqual(fused[1].provenance.queries.map((query) => query.queryId), ["rewrite-1", "rewrite-2"]);
  // c: only the term-less rewrite found it; its null coverage is measured against the question.
  assert.equal(typeof fused[2].keywordScore, "number");
  assert.equal(fused[2].keywordScore, computeResultQueryTermCoverage(fused[2], "where is the venue"));
  assert.equal(fused[2].admissionScore, Math.max(0.4, fused[2].keywordScore));
  // No cut without a top-K.
  assert.equal(fuseExpandedQueryResults({ lists: [question, rewriteOne, rewriteTwo], queryText: "q", rrfK: 60 }).length, 4);
});

test("off: no model call, no trace field, the candidates the route always had", async () => {
  await useIndex();
  const { completions } = useModels();

  withEnv({ RAG_QA_QUERY_EXPANSION: undefined });
  const unset = await retrieve();
  withEnv({ RAG_QA_QUERY_EXPANSION: "off", RAG_QA_QUERY_EXPANSION_COUNT: "bogus" });
  const off = await retrieve();

  assert.deepEqual(off, unset);
  assert.equal("queryExpansion" in unset, false);
  assert.deepEqual(summarize(unset).map((row) => row.text), [TEXTS.A, TEXTS.X]);
  assert.equal(completions.length, 0);
});

test("multi_query: one call, the rewrite's list fused with the question's, the rewrite-only chunk measured against the question", async () => {
  await useIndex();
  const { completions } = useModels();

  withEnv({ RAG_QA_QUERY_EXPANSION: "multi_query", RAG_QA_QUERY_EXPANSION_COUNT: "2", RAG_QA_QUERY_EXPANSION_TEMPERATURE: "0" });
  const candidates = await retrieve();

  assert.equal(completions.length, 1);
  assert.equal(completions[0].kind, "multi_query");
  assert.match(completions[0].prompt, /as 2 different search queries/);
  assert.match(completions[0].prompt, /Question: where was the treaty signed$/);
  assert.equal(completions[0].options.temperature, 0);
  assert.equal(completions[0].options.maxTokens, QUERY_EXPANSION_MAX_TOKENS);
  // A: both lists; B: the rewrite only (X, the question's second, drops out at top-K 2).
  assert.deepEqual(summarize(candidates), [
    { keywordScore: 0, queries: ["primary", "rewrite-1"], text: TEXTS.A },
    { keywordScore: 0, queries: ["rewrite-1"], text: TEXTS.B },
  ]);
  assert.equal(candidates.results[1].admissionScore, candidates.results[1].vectorScore);
  assert.deepEqual({ ...candidates.queryExpansion, durationMs: 0 }, {
    applied: true,
    durationMs: 0,
    generated: 1,
    mode: "multi_query",
    truncated: false,
  });
});

test("hyde: the dense route searches with the mean of the question's and the passage's vectors", async () => {
  await useIndex();
  const { completions, embeddedQueries, embeddedTexts } = useModels();

  withEnv({ RAG_QA_QUERY_EXPANSION: "hyde" });
  const candidates = await retrieve();

  assert.equal(completions.length, 1);
  assert.equal(completions[0].kind, "hyde");
  // No temperature unless set.
  assert.equal("temperature" in completions[0].options, false);
  // The passage was embedded on the query path (the request's lane, not
  // ingest's embedTexts) with the document prefix in place of the query prefix.
  const passageEmbeddings = embeddedQueries.filter((call) => call.query === PASSAGE);
  assert.equal(passageEmbeddings.length, 1);
  assert.equal(passageEmbeddings[0].options.embeddingSpace.queryPrefix, "d: ");
  assert.equal(passageEmbeddings[0].options.embeddingSpace.model, "expansion-test-model");
  assert.equal(embeddedTexts.length, 0);
  // Mean of [1, 0, 0] and [0, 1, 0]: A (0.78) then B (0.71); the question alone ranks A, X.
  assert.deepEqual(summarize(candidates).map((row) => row.text), [TEXTS.A, TEXTS.B]);
  assert.ok(Math.abs(candidates.results[1].vectorScore - Math.SQRT1_2) < 1e-9);
  assert.equal(candidates.queryExpansion.applied, true);
  assert.equal(candidates.queryExpansion.mode, "hyde");

  // Tagged with the space the index serves, as every query vector is.
  const hydeVector = await embedHydeQueryVector({ passage: PASSAGE, queryText: QUESTION });
  assert.deepEqual(getQueryVectorEmbeddingSpace(hydeVector), getQueryVectorEmbeddingSpace(await embedQueryCached(QUESTION)));
  assert.notEqual(getQueryVectorEmbeddingSpace(hydeVector), null);
});

test("a failed or empty expansion retrieves with the question alone and says why", async () => {
  await useIndex();
  useModels();
  withEnv({ RAG_QA_QUERY_EXPANSION: undefined });
  const baseline = (await retrieve()).results;

  for (const [mode, models, fallback] of [
    ["multi_query", { replyError: Object.assign(new Error("upstream down"), { code: "MODEL_UPSTREAM_UNAVAILABLE" }) }, "model_error"],
    ["hyde", { replyError: new Error("boom") }, "model_error"],
    ["multi_query", { rewrites: "Here are the queries:\n\n" }, "empty_reply"],
    ["multi_query", { rewrites: `1. ${QUESTION}?` }, "empty_reply"],
    ["hyde", { passage: "  " }, "empty_reply"],
    ["hyde", { embedError: Object.assign(new Error("embed down"), { code: "EMBED_DOWN" }) }, "embedding_error"],
  ]) {
    resetOpenAIProvider();
    resetEmbeddingCache();
    useModels(models);
    withEnv({ RAG_QA_QUERY_EXPANSION: mode });
    const candidates = await retrieve();

    assert.deepEqual(candidates.results, baseline, `${mode} ${fallback}`);
    assert.equal(candidates.queryExpansion.applied, false);
    assert.equal(candidates.queryExpansion.fallback, fallback);
  }

  resetOpenAIProvider();
  useModels({ replyError: Object.assign(new Error("upstream down"), { code: "MODEL_UPSTREAM_UNAVAILABLE" }) });
  withEnv({ RAG_QA_QUERY_EXPANSION: "multi_query" });
  assert.equal((await retrieve()).queryExpansion.errorCode, "MODEL_UPSTREAM_UNAVAILABLE");

  // A rewrite whose retrieval fails is left out; every one failing is the question alone.
  const down = Object.assign(new Error("embed down"), { code: "EMBED_DOWN" });

  resetOpenAIProvider();
  resetEmbeddingCache();
  useModels({ failingQueries: { [REWRITE]: down }, rewrites: `1. ${REWRITE}\n2. other venue question` });
  const partial = await retrieve();
  assert.equal(partial.queryExpansion.applied, true);
  assert.equal(partial.queryExpansion.failedRewrites, 1);
  assert.equal(partial.queryExpansion.errorCode, "EMBED_DOWN");
  assert.notDeepEqual(partial.results, baseline);

  resetOpenAIProvider();
  resetEmbeddingCache();
  useModels({ failingQueries: { [REWRITE]: down } });
  const none = await retrieve();
  assert.deepEqual(none.results, baseline);
  assert.equal(none.queryExpansion.applied, false);
  assert.equal(none.queryExpansion.fallback, "retrieval_error");
  assert.equal(none.queryExpansion.failedRewrites, 1);
});

test("a cancelled request is not swallowed by the fallback", async () => {
  await useIndex();
  useModels({ replyError: new RequestCancelledError() });
  withEnv({ RAG_QA_QUERY_EXPANSION: "multi_query" });

  await assert.rejects(retrieve(), RequestCancelledError);
});

test("a question split into parts and an agent-planned retrieval are never expanded", async () => {
  await useIndex();
  const { completions } = useModels();

  withEnv({ RAG_QA_QUERY_EXPANSION: "multi_query" });
  const split = await retrieveQaCandidates({
    docIds: ["doc-1"],
    resolvedQuery: "When does it take effect and which regions does it apply to?",
  });

  assert.equal(split.evidenceRequirementCount > 1, true);
  assert.equal(split.queryExpansion.skipped, "multi_part");
  assert.equal(completions.length, 0);

  const planned = await executeDocumentRag({
    agentRetrievalPlan: {
      intent: "qa",
      retrievalOptions: { profile: "default" },
      retrievalQueries: [{ id: "primary", primary: true, query: QUESTION }],
    },
    docIds: ["doc-1"],
    query: QUESTION,
    resolvedQuery: QUESTION,
    selectedDocuments: [{ docId: "doc-1", fileName: "doc-1.pdf" }],
  });

  assert.equal(planned.traceFields.queryExpansion.skipped, "agent_plan");
  assert.equal(completions.filter((completion) => completion.kind !== "answer").length, 0);
});

test("the route's trace carries queryExpansion only with the setting on", async () => {
  await useIndex();
  useModels();
  const run = () =>
    executeDocumentRag({
      docIds: ["doc-1"],
      query: QUESTION,
      resolvedQuery: QUESTION,
      selectedDocuments: [{ docId: "doc-1", fileName: "doc-1.pdf" }],
    });

  withEnv({ RAG_QA_QUERY_EXPANSION: undefined });
  assert.equal("queryExpansion" in (await run()).traceFields, false);

  withEnv({ RAG_QA_QUERY_EXPANSION: "multi_query" });
  const expanded = await run();
  assert.equal(expanded.traceFields.queryExpansion.applied, true);
  assert.equal(expanded.response.retrieval.queryCount, 2);
});

test("prompts: both templates are catalogued, the active set gains one only while the setting is on", () => {
  const keys = (templates) => templates.map(({ id, version }) => `${id}@${version}`);

  assert.deepEqual(keys(listQueryExpansionPromptDescriptors()), ["qa_query_hyde@v1", "qa_query_multi_query@v1"]);
  assert.ok(keys(listPromptTemplates()).includes("qa_query_hyde@v1"));
  assert.ok(keys(listPromptTemplates()).includes("qa_query_multi_query@v1"));

  withEnv({ RAG_QA_QUERY_EXPANSION: undefined });
  assert.equal(keys(getActivePromptTemplates()).some((key) => key.startsWith("qa_query_")), false);
  withEnv({ RAG_QA_QUERY_EXPANSION: "hyde" });
  assert.deepEqual(keys(getActivePromptTemplates()).filter((key) => key.startsWith("qa_query_")), ["qa_query_hyde@v1"]);
  assert.match(describeQueryExpansionPrompt("hyde"), /^qa_query_hyde@v1#[0-9a-f]{12}$/);
  assert.equal(describeQueryExpansionPrompt("off"), null);
});

test("evaluation reports record the setting only while it is on", async () => {
  withEnv({ RAG_QA_QUERY_EXPANSION: undefined });
  const off = await describeRetrievalConfig();
  assert.equal(Object.keys(off).some((key) => key.startsWith("qaQueryExpansion")), false);

  withEnv({ RAG_QA_QUERY_EXPANSION: "multi_query", RAG_QA_QUERY_EXPANSION_TEMPERATURE: "0" });
  const on = await describeRetrievalConfig();
  assert.equal(on.qaQueryExpansion, "multi_query");
  assert.equal(on.qaQueryExpansionCount, 3);
  assert.equal(on.qaQueryExpansionTemperature, 0);
  assert.equal(on.qaQueryExpansionPrompt, describeQueryExpansionPrompt("multi_query"));
});

test("the gate analysis summarizes what the expansion did", () => {
  assert.equal(summarizeQueryExpansion([{ results: [] }]), null);

  const summary = summarizeQueryExpansion([
    { queryExpansion: { applied: true, durationMs: 100, generated: 3, mode: "multi_query", truncated: false } },
    { queryExpansion: { applied: true, durationMs: 300, generated: 2, mode: "multi_query", truncated: true } },
    { queryExpansion: { applied: false, durationMs: 50, errorCode: "TIMEOUT", fallback: "model_error", generated: 0, mode: "multi_query" } },
    { queryExpansion: { applied: false, durationMs: 0, generated: 0, mode: "multi_query", skipped: "multi_part" } },
  ]);

  assert.deepEqual(summary, {
    applied: 2,
    durationMs: { max: 300, mean: 150, p50: 100, p95: 300 },
    errorCodes: { TIMEOUT: 1 },
    fallbacks: { model_error: 1 },
    mode: "multi_query",
    questions: 4,
    rewriteRetrievalFailures: 0,
    skipped: { multi_part: 1 },
    truncated: 1,
  });
});
