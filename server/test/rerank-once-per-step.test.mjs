import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildTranslationBypass,
  mergeRetrievedResults,
  retrieveGlobalContextForQueriesInProcess,
  retrievePerDocumentContextForQueriesInProcess,
  tagResultsWithQuery,
} from "../rag/document-rag-execution.js";
import { buildAgentRetrievalQueries, isFollowUpRetrievalQuery } from "../rag/agent-retrieval-queries.js";
import { resetEmbeddingCache } from "../rag/embedding-cache.js";
import { getMetricsRegistry, setMetricsEnabled } from "../rag/metrics.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import {
  configureCrossEncoderProvider,
  rerankResultsOrKeepOrder,
  resetCrossEncoderProvider,
} from "../rag/reranker.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  addDocumentsToIndex,
  resetVectorStore,
  searchDocumentsPerDocumentWithRoutes,
  searchDocumentsWithRoutes,
} from "../rag/vector-store.js";
import { parseExposition, sampleValue } from "./metrics-exposition.mjs";

// With reranking on, a retrieval step's queries each fetch their fused
// candidates, the candidates are merged, and the cross-encoder scores the
// merged pool once against the question (once per document on the
// per-document route). The agent's follow-up step still reranks each query
// against its own text, and the question's candidates come from the score
// cache. Run on the local backend with a stand-in embedder and cross-encoder;
// no model, database or network.

const originalDataDirectory = getRagDataDirectory();
const pinnedEnvironment = {
  RAG_HYBRID_ENABLED: "true",
  RAG_HYBRID_FUSION: "rrf",
  RAG_RERANK_CANDIDATE_MULTIPLIER: "2",
  RAG_RERANK_ENABLED: "true",
  RAG_RERANK_PROVIDER: "cross-encoder",
  RAG_RERANK_WEIGHT: "0.6",
  RAG_RRF_K: "60",
  RAG_SPARSE_TOP_K: "4",
  VECTOR_STORE_PROVIDER: "local",
};
let originalEnvironment = {};
let tempRoot = null;

// One axis per topic word, so each query's dense candidates are predictable.
const TOPICS = ["leave", "paid", "days", "evidence", "travel", "meals", "approval", "remote"];
const embed = (text) => [...TOPICS.map((topic) => (text.toLowerCase().includes(topic) ? 1 : 0)), 0.05];

const chunk = (docId, chunkIndex, pageContent) => ({
  id: `${docId}:${chunkIndex}`,
  pageContent,
  metadata: { chunkIndex, docId, fileName: `${docId}.pdf`, pageNumber: chunkIndex + 1 },
});
const DOCUMENTS = [
  chunk("doc-a", 0, "Annual leave: employees receive ten paid leave days each year."),
  chunk("doc-a", 1, "Leave requests need manager approval two weeks ahead."),
  chunk("doc-a", 2, "Remote work is allowed two days per week."),
  chunk("doc-a", 3, "Evidence of sick leave is a note from a doctor."),
  chunk("doc-b", 0, "Travel meals are reimbursed up to forty dollars per day."),
  chunk("doc-b", 1, "Travel approval comes from finance."),
  chunk("doc-b", 2, "Paid travel days count as working days."),
  chunk("doc-b", 3, "Receipts are the evidence finance needs for travel claims."),
];
const DOC_IDS = ["doc-a", "doc-b"];
const QUESTION = "How many paid leave days do employees get?";

// The agent's fact question: two queries on the first step, three on the
// follow-up (agent-retrieval-queries.js).
const FIRST_STEP = [
  { id: "primary", primary: true, query: QUESTION },
  { id: "fact-citation", primary: false, query: `Find exact cited evidence for: ${QUESTION}` },
];
const FOLLOW_UP_STEP = [
  { id: "primary", primary: true, query: QUESTION },
  {
    id: "follow-up-evidence",
    primary: false,
    query: "Find citation-backed evidence that fixes this issue: Unsupported claim: travel meals",
  },
  {
    id: "follow-up-source-check",
    primary: false,
    query: `Find source excerpts that directly support the final answer for: ${QUESTION}`,
  },
];

// A stand-in cross-encoder: a fixed logit per chunk, every call recorded.
const LOGITS = {
  "doc-a:0": 3,
  "doc-a:1": 0.5,
  "doc-a:2": -1,
  "doc-a:3": 1.5,
  "doc-b:0": 0,
  "doc-b:1": -2,
  "doc-b:2": 1,
  "doc-b:3": 2,
};
const recordCrossEncoderCalls = () => {
  const calls = [];

  configureCrossEncoderProvider({
    score: async ({ pairs, queryText }) => {
      calls.push({ ids: pairs.map((pair) => pair.id), queryText });
      return pairs.map((pair) => LOGITS[pair.id]);
    },
  });

  return calls;
};

const withEnv = async (overrides, callback) => {
  const originalValues = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));

  Object.assign(process.env, overrides);

  try {
    return await callback();
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const ids = (results) => results.map((result) => result.document.id);

// What each query fused (topK x the rerank multiplier while reranking is on),
// tagged and merged as the step merges it, before any rerank.
const search = (query, options) =>
  searchDocumentsWithRoutes({ docIds: DOC_IDS, queryText: query.query, queryVector: embed(query.query), ...options });
const searchPerDocument = (query, options) =>
  searchDocumentsPerDocumentWithRoutes({
    docIds: DOC_IDS,
    queryText: query.query,
    queryVector: embed(query.query),
    ...options,
  });
const mergedPool = async (queries, topK) =>
  mergeRetrievedResults(
    ...(await Promise.all(
      queries.map(async (query) => tagResultsWithQuery((await search(query, { topK })).results, query))
    ))
  );
const mergedPoolByDocument = async (queries, topKPerDoc) => {
  const searches = await Promise.all(queries.map((query) => searchPerDocument(query, { topKPerDoc })));

  return new Map(
    DOC_IDS.map((docId) => [
      docId,
      mergeRetrievedResults(
        ...searches.map(({ resultsByDocument }, index) => tagResultsWithQuery(resultsByDocument.get(docId), queries[index]))
      ),
    ])
  );
};

// A reranked result is the merged pool's winning copy, with its provenance,
// rescored: the fused score moves to originalScore.
const assertRerankedFromPool = (results, pool) => {
  for (const result of results) {
    const { score: fusedScore, ...pooled } = pool.find((entry) => entry.document.id === result.document.id);
    const { crossEncoderScore, originalScore, rerankScore, score, ...rest } = result;

    assert.equal(typeof crossEncoderScore, "number");
    assert.equal(typeof rerankScore, "number");
    assert.equal(typeof score, "number");
    assert.equal(originalScore, fusedScore);
    assert.deepEqual(rest, pooled);
  }
};

// Each result as [chunk, score, the queries that found it (winning copy first)].
const project = (results) =>
  results.map((result) => [
    result.document.id,
    result.score,
    result.provenance.queries.map((query) => query.queryId).join(","),
  ]);
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The output of the per-query rerank code (9502b39c) for FIRST_STEP at topK 2,
// with reranking off or with every rerank failing: each query's fused top 2,
// tagged, merged and ordered. The sha256 covers the whole output as JSON.
const KEPT_ORDER_GLOBAL = [
  ["doc-a:0", 1, "primary,fact-citation"],
  ["doc-b:2", 0.9838709677419355, "primary"],
  ["doc-a:3", 0.978405017921147, "fact-citation"],
];
const KEPT_ORDER_GLOBAL_SHA256 = "acc6ad562eddf64eb6b19397917b345fe1284a4eea07deee29acbd4d829ecb4c";
const KEPT_ORDER_PER_DOCUMENT = {
  "doc-a": [
    ["doc-a:0", 1, "primary,fact-citation"],
    ["doc-a:3", 0.9838709677419355, "fact-citation"],
    ["doc-a:1", 0.9731098790322581, "primary"],
  ],
  "doc-b": [
    ["doc-b:2", 1, "primary,fact-citation"],
    ["doc-b:3", 0.9838709677419355, "fact-citation"],
    ["doc-b:0", 0.6395161290322581, "primary"],
  ],
};
const KEPT_ORDER_PER_DOCUMENT_SHA256 = "2239ee489d2fb0359d1952dc03ee5f4079f63b539516f2fec4ccb61a1d9b076c";

const assertKeptOrder = ({ global, perDocument }) => {
  assert.deepEqual(project(global.results), KEPT_ORDER_GLOBAL);
  assert.equal(sha256(global.results), KEPT_ORDER_GLOBAL_SHA256);
  assert.deepEqual(
    Object.fromEntries([...perDocument.resultsByDocument].map(([docId, results]) => [docId, project(results)])),
    KEPT_ORDER_PER_DOCUMENT
  );
  assert.equal(sha256([...perDocument.resultsByDocument]), KEPT_ORDER_PER_DOCUMENT_SHA256);
};

const retrieveFirstStep = async () => ({
  global: await retrieveGlobalContextForQueriesInProcess({
    docIds: DOC_IDS,
    retrievalOptions: { topK: 2 },
    retrievalQueries: FIRST_STEP,
  }),
  perDocument: await retrievePerDocumentContextForQueriesInProcess({
    docIds: DOC_IDS,
    retrievalOptions: { topKPerDoc: 2 },
    retrievalQueries: FIRST_STEP,
  }),
});

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(Object.keys(pinnedEnvironment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, pinnedEnvironment);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "rerank-once-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  resetVectorStore();
  resetEmbeddingCache();
  configureOpenAIProvider({
    embedQuery: async (query) => embed(query),
    embedTexts: async (texts) => texts.map(embed),
  });
  await addDocumentsToIndex({ documents: DOCUMENTS });
});

afterEach(async () => {
  resetCrossEncoderProvider();
  resetOpenAIProvider();
  resetEmbeddingCache();
  resetVectorStore();
  configureRagDataDirectory(originalDataDirectory);

  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  await rm(tempRoot, { force: true, recursive: true });
});

test("only the agent's follow-up plan reads as a follow-up step", () => {
  for (const intent of ["fact", "timeline", "comparison", "analysis"]) {
    assert.ok(!buildAgentRetrievalQueries({ question: QUESTION, intent, phase: "primary" }).some(isFollowUpRetrievalQuery));
  }

  for (const phase of ["retry", "follow_up"]) {
    const queries = buildAgentRetrievalQueries({ question: QUESTION, intent: "fact", phase, focus: {} });

    assert.deepEqual(queries.map((query) => query.id), FOLLOW_UP_STEP.map((query) => query.id));
    assert.ok(queries.some(isFollowUpRetrievalQuery));
  }
});

test("a fact question's first step scores its two queries' merged candidates in one call against the question", async () => {
  const calls = recordCrossEncoderCalls();
  const pool = await mergedPool(FIRST_STEP, 4);
  const { results } = await retrieveGlobalContextForQueriesInProcess({
    docIds: DOC_IDS,
    retrievalOptions: { topK: 2 },
    retrievalQueries: FIRST_STEP,
  });

  assert.deepEqual(ids(pool), ["doc-a:0", "doc-b:2", "doc-a:2", "doc-a:1", "doc-a:3"]);
  // One call, with the question, scoring every candidate of the union once.
  assert.deepEqual(calls, [{ ids: ids(pool), queryText: QUESTION }]);
  // The budget stays topK per query: 2 x 2 of the 5 merged candidates.
  assert.deepEqual(ids(results), ["doc-a:0", "doc-a:3", "doc-b:2", "doc-a:1"]);
  assertRerankedFromPool(results, pool);
  assert.deepEqual(results[0].provenance.queries.map((query) => query.queryId), ["primary", "fact-citation"]);
});

// What the per-query code returned for a step: each query's fused candidates
// reranked on their own against its own text, top-K kept, merged.
const rerankedPerQuery = async (queries, topK) =>
  mergeRetrievedResults(
    ...(await Promise.all(
      queries.map(async (query) =>
        rerankResultsOrKeepOrder({
          queryText: query.query,
          results: tagResultsWithQuery((await search(query, { topK: topK * 2 })).results, query),
          topK,
        })
      )
    ))
  );
const byId = (results) => [...results].sort((left, right) => left.document.id.localeCompare(right.document.id));

test("the follow-up step reranks each query against its own text, and the first step's scores answer the question's", async () => {
  const calls = recordCrossEncoderCalls();

  await retrieveGlobalContextForQueriesInProcess({
    docIds: DOC_IDS,
    retrievalOptions: { topK: 2 },
    retrievalQueries: FIRST_STEP,
  });
  calls.length = 0;
  const { results } = await retrieveGlobalContextForQueriesInProcess({
    docIds: DOC_IDS,
    retrievalOptions: { topK: 2 },
    retrievalQueries: FOLLOW_UP_STEP,
  });
  const sent = calls.splice(0);
  const [, evidence, sourceCheck] = FOLLOW_UP_STEP;

  // No call for the question: the first step scored all its candidates.
  assert.deepEqual(
    sent.sort((left, right) => left.queryText.localeCompare(right.queryText)),
    [
      { ids: ids((await search(evidence, { topK: 4 })).results), queryText: evidence.query },
      { ids: ids((await search(sourceCheck, { topK: 4 })).results), queryText: sourceCheck.query },
    ]
  );
  // The same results the per-query code returned, ordered by score.
  assert.deepEqual(byId(results), byId(await rerankedPerQuery(FOLLOW_UP_STEP, 2)));
  assert.ok(results.every((result, index) => index === 0 || results[index - 1].score >= result.score));
  assert.deepEqual(calls, []);
});

test("on the per-document route the follow-up step reranks each query per document against its own text", async () => {
  const calls = recordCrossEncoderCalls();
  const retrieve = (retrievalQueries) =>
    retrievePerDocumentContextForQueriesInProcess({
      docIds: DOC_IDS,
      retrievalOptions: { topKPerDoc: 2 },
      retrievalQueries,
    });

  await retrieve(FIRST_STEP);
  calls.length = 0;
  const { resultsByDocument } = await retrieve(FOLLOW_UP_STEP);
  const [, evidence, sourceCheck] = FOLLOW_UP_STEP;

  assert.deepEqual(calls.map((call) => call.queryText).sort(), [
    evidence.query,
    evidence.query,
    sourceCheck.query,
    sourceCheck.query,
  ]);

  for (const docId of DOC_IDS) {
    assert.ok(resultsByDocument.get(docId).length > 0);
    assert.ok(resultsByDocument.get(docId).every((result) => typeof result.crossEncoderScore === "number"));
  }
});

test("the step reranks against the query marked primary wherever it stands, else against its first query", async () => {
  const calls = recordCrossEncoderCalls();
  const [primary, citation] = FIRST_STEP;
  const retrieve = (retrievalQueries) =>
    retrieveGlobalContextForQueriesInProcess({ docIds: DOC_IDS, retrievalOptions: { topK: 2 }, retrievalQueries });

  await retrieve([citation, primary]);
  await retrieve([citation, { ...primary, primary: false }]);

  assert.deepEqual(
    calls.map((call) => call.queryText),
    [QUESTION, citation.query]
  );
});

test("after the one rerank, a candidate a cross-language rewrite won still reads as the rewrite's", async () => {
  recordCrossEncoderCalls();
  const queries = [
    { id: "primary", primary: true, query: QUESTION },
    { id: "translation-latin", primary: false, query: "travel meals receipts" },
  ];
  const { results } = await retrieveGlobalContextForQueriesInProcess({
    docIds: DOC_IDS,
    retrievalOptions: { topK: 2 },
    retrievalQueries: queries,
  });
  const bypass = buildTranslationBypass(queries);

  assertRerankedFromPool(results, await mergedPool(queries, 4));
  assert.ok(results.some(bypass));
  assert.ok(!results.every(bypass));
});

test("the per-document route scores each document's merged candidates once against the question", async () => {
  const calls = recordCrossEncoderCalls();
  const pools = await mergedPoolByDocument(FIRST_STEP, 4);
  const { resultsByDocument } = await retrievePerDocumentContextForQueriesInProcess({
    docIds: DOC_IDS,
    retrievalOptions: { topKPerDoc: 2 },
    retrievalQueries: FIRST_STEP,
  });

  assert.deepEqual(
    calls.sort((left, right) => left.ids[0].localeCompare(right.ids[0])),
    DOC_IDS.map((docId) => ({ ids: ids(pools.get(docId)), queryText: QUESTION }))
  );
  assert.deepEqual([...resultsByDocument.keys()], DOC_IDS);

  for (const docId of DOC_IDS) {
    // topKPerDoc 2 per query: 4 per document.
    assert.equal(resultsByDocument.get(docId).length, 4);
    assertRerankedFromPool(resultsByDocument.get(docId), pools.get(docId));
  }
});

test("when the rerank fails each query keeps its own fused top-K, with one warning and a degradation per rerank call", async () => {
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  const registry = getMetricsRegistry();
  const degradations = async () =>
    sampleValue(parseExposition(await registry.expose()), "archive_rag_retrieval_rerank_degradations_total");

  configureCrossEncoderProvider({
    score: async ({ pairs }) => {
      calls.push(pairs.length);
      throw new Error("rerank-once test: cross-encoder down");
    },
  });
  setMetricsEnabled(true);
  console.warn = (message) => warnings.push(String(message));

  try {
    const before = await degradations();
    const outputs = await retrieveFirstStep();

    assertKeptOrder(outputs);
    // One call for the global step and one per document, each failing.
    assert.deepEqual(calls, [5, 4, 4]);
    assert.equal(await degradations(), before + 3);
    assert.deepEqual(warnings, [
      "Rerank failed (rerank-once test: cross-encoder down); keeping the retrieval order for this query.",
    ]);
    assert.ok(outputs.global.results.every((result) => result.crossEncoderScore === undefined));

    // The follow-up step's three reranks each fail and keep their query's own
    // fused top-K.
    const followUp = await retrieveGlobalContextForQueriesInProcess({
      docIds: DOC_IDS,
      retrievalOptions: { topK: 2 },
      retrievalQueries: FOLLOW_UP_STEP,
    });

    assert.equal(calls.length, 6);
    assert.equal(await degradations(), before + 6);
    assert.deepEqual(byId(followUp.results), byId(await rerankedPerQuery(FOLLOW_UP_STEP, 2)));
    assert.ok(followUp.results.every((result) => result.crossEncoderScore === undefined));
  } finally {
    console.warn = originalWarn;
    setMetricsEnabled(null);
  }
});

test("with reranking off both routes return exactly what the per-query code returned, and nothing is scored", async () => {
  configureCrossEncoderProvider({
    score: async () => {
      throw new Error("the cross-encoder must not be called while reranking is off");
    },
  });

  await withEnv({ RAG_RERANK_ENABLED: "false" }, async () => assertKeptOrder(await retrieveFirstStep()));
});
