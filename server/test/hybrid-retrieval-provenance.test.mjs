import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  mergeRetrievedResults,
  tagResultsWithQuery,
} from "../rag/document-rag-execution.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  addDocumentsToIndex,
  mergeRouteSummaries,
  resetVectorStore,
  searchDocumentsPerDocumentWithRoutes,
  searchDocumentsWithRoutes,
} from "../rag/vector-store.js";

// Multi-route retrieval is only worth something if a report can prove both
// routes ran and show where each candidate came from. These tests run the
// seam on the local backend (no database needed) and pin the provenance,
// fusion and deduplication contract that every provider shares.

const originalDataDirectory = getRagDataDirectory();
const pinnedEnvironment = {
  RAG_HYBRID_ENABLED: "true",
  RAG_HYBRID_FUSION: "rrf",
  RAG_RRF_K: "60",
  RAG_SPARSE_TOP_K: "4",
  VECTOR_STORE_PROVIDER: "local",
};
let originalEnvironment = {};
let tempRoot = null;

// A tiny embedding space: one axis per topic word, so dense similarity is
// fully predictable and independent of the lexical route.
const TOPICS = ["alpha", "beta", "gamma"];
const embed = (text) => [
  ...TOPICS.map((topic) => (text.toLowerCase().includes(topic) ? 1 : 0)),
  0.05,
];

const DOCUMENTS = [
  { id: "doc-1:0", pageContent: "Alpha policy: remote work needs alpha approval.", metadata: { docId: "doc-1", chunkIndex: 0, fileName: "alpha.pdf", pageNumber: 1 } },
  { id: "doc-1:1", pageContent: "Gamma renewal window is twelve months.", metadata: { docId: "doc-1", chunkIndex: 1, fileName: "alpha.pdf", pageNumber: 2 } },
  { id: "doc-2:0", pageContent: "Beta budget caps meals at forty dollars.", metadata: { docId: "doc-2", chunkIndex: 0, fileName: "beta.pdf", pageNumber: 1 } },
];

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

const resultKeys = (results) =>
  results.map((result) => `${result.document.metadata.docId}:${result.document.metadata.chunkIndex}`);

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(
    Object.keys(pinnedEnvironment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, pinnedEnvironment);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "hybrid-provenance-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  resetVectorStore();
  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map(embed),
    embedQuery: async (query) => embed(query),
  });
  await addDocumentsToIndex({ documents: DOCUMENTS });
});

afterEach(async () => {
  resetOpenAIProvider();
  resetVectorStore();
  configureRagDataDirectory(originalDataDirectory);
  resetVectorStore();

  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  await rm(tempRoot, { force: true, recursive: true });
});

test("hybrid search runs the dense and sparse routes independently and stamps both on the result", async () => {
  const search = await searchDocumentsWithRoutes({
    queryVector: embed("alpha"),
    queryText: "alpha approval policy",
    docIds: ["doc-1", "doc-2"],
    topK: 3,
  });

  assert.deepEqual(search.fusion, { enabled: true, method: "rrf" });
  assert.equal(search.routes.dense.executed, true);
  assert.equal(search.routes.sparse.executed, true);
  assert.ok(search.routes.dense.candidateCount > 0);
  assert.ok(search.routes.sparse.candidateCount > 0);

  const [top] = search.results;

  assert.equal(top.document.metadata.docId, "doc-1");
  assert.equal(top.document.metadata.chunkIndex, 0);
  assert.equal(top.provenance.fusion.method, "rrf");
  assert.deepEqual(
    top.provenance.routes.map((route) => [route.route, route.rank]),
    [
      ["dense", 1],
      ["sparse", 1],
    ]
  );
  assert.equal(typeof top.provenance.routes[0].score, "number");
  assert.equal(typeof top.provenance.routes[1].score, "number");
  // Rank 1 on both routes is the maximum RRF sum; normalized to the [0, 1]
  // relevance scale it is exactly the two route weights added together.
  assert.ok(Math.abs(top.score - 1) < 1e-9, `expected 1.0, got ${top.score}`);
  assert.ok(top.rrfScore < top.score);
  assert.equal(top.provenance.fusion.score, top.score);
});

test("lexical-only and semantic-only candidates both surface, each attributed to its own route", async () => {
  // Vector says gamma, words say beta: the two routes disagree on purpose.
  const search = await searchDocumentsWithRoutes({
    queryVector: embed("gamma"),
    queryText: "beta budget meals",
    docIds: ["doc-1", "doc-2"],
    topK: 3,
  });
  const keys = resultKeys(search.results);

  assert.ok(keys.includes("doc-1:1"), `dense candidate missing from ${keys}`);
  assert.ok(keys.includes("doc-2:0"), `sparse candidate missing from ${keys}`);

  const semanticOnly = search.results.find((result) => result.document.metadata.chunkIndex === 1 && result.document.metadata.docId === "doc-1");
  const lexicalOnly = search.results.find((result) => result.document.metadata.docId === "doc-2");

  assert.deepEqual(semanticOnly.provenance.routes.map((route) => route.route), ["dense"]);
  assert.equal(lexicalOnly.provenance.routes.some((route) => route.route === "sparse"), true);
  assert.ok(lexicalOnly.sparseScore > 0);
});

test("turning hybrid off runs the dense route only and says so", async () => {
  await withEnv({ RAG_HYBRID_ENABLED: "false" }, async () => {
    const search = await searchDocumentsWithRoutes({
      queryVector: embed("beta"),
      queryText: "beta budget",
      docIds: ["doc-1", "doc-2"],
      topK: 2,
    });

    assert.deepEqual(search.fusion, { enabled: false, method: null });
    assert.deepEqual(search.routes.sparse, { candidateCount: 0, executed: false, topK: null });
    assert.equal(search.routes.dense.executed, true);
    assert.equal(search.results[0].provenance.fusion, null);
    assert.deepEqual(search.results[0].provenance.routes.map((route) => route.route), ["dense"]);
  });
});

test("weighted fusion stays available as an explicit choice", async () => {
  await withEnv({ RAG_HYBRID_FUSION: "weighted" }, async () => {
    const search = await searchDocumentsWithRoutes({
      queryVector: embed("alpha"),
      queryText: "alpha approval",
      docIds: ["doc-1", "doc-2"],
      topK: 2,
    });

    assert.equal(search.fusion.method, "weighted");
    assert.equal(search.results[0].provenance.fusion.method, "weighted");
    assert.equal(search.results[0].rrfScore, undefined);
  });
});

test("fusion is deterministic and yields one entry per chunk", async () => {
  const run = () =>
    searchDocumentsWithRoutes({
      queryVector: embed("alpha gamma"),
      queryText: "alpha gamma renewal approval",
      docIds: ["doc-1", "doc-2"],
      topK: 5,
    });
  const first = await run();
  const second = await run();
  const keys = resultKeys(first.results);

  assert.deepEqual(resultKeys(second.results), keys);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    second.results.map((result) => result.score),
    first.results.map((result) => result.score)
  );
});

test("multi-query merging keeps one entry per chunk and every query in its provenance", async () => {
  const alphaSearch = await searchDocumentsWithRoutes({
    queryVector: embed("alpha"),
    queryText: "alpha approval",
    docIds: ["doc-1", "doc-2"],
    topK: 3,
  });
  const gammaSearch = await searchDocumentsWithRoutes({
    queryVector: embed("gamma"),
    queryText: "renewal window",
    docIds: ["doc-1", "doc-2"],
    topK: 3,
  });
  const merged = mergeRetrievedResults(
    tagResultsWithQuery(alphaSearch.results, { id: "q-alpha", primary: true }),
    tagResultsWithQuery(gammaSearch.results, { id: "q-gamma", primary: false })
  );
  const keys = resultKeys(merged);

  assert.equal(new Set(keys).size, keys.length);

  const sharedChunk = merged.find((result) =>
    (result.provenance.queries ?? []).length > 1
  );

  assert.ok(sharedChunk, "a chunk retrieved by both queries keeps both queries");
  assert.deepEqual(
    sharedChunk.provenance.queries.map((query) => query.queryId).sort(),
    ["q-alpha", "q-gamma"]
  );

  for (const query of sharedChunk.provenance.queries) {
    assert.equal(typeof query.primary, "boolean");
    assert.ok(Array.isArray(query.routes) && query.routes.length > 0);
    assert.ok(query.routes.every((route) => Number.isInteger(route.rank) && route.rank >= 1));
  }

  // The stronger copy is kept: the merged score is the max of the two runs.
  const alphaCopy = alphaSearch.results.find((result) => resultKeys([result])[0] === resultKeys([sharedChunk])[0]);
  const gammaCopy = gammaSearch.results.find((result) => resultKeys([result])[0] === resultKeys([sharedChunk])[0]);
  const bestScore = Math.max(alphaCopy?.score ?? -1, gammaCopy?.score ?? -1);

  assert.equal(sharedChunk.score, bestScore);
});

test("per-document search keeps every document's candidates separate and reports routes per document", async () => {
  const search = await searchDocumentsPerDocumentWithRoutes({
    queryVector: embed("alpha beta"),
    queryText: "alpha beta",
    docIds: ["doc-1", "doc-2"],
    topKPerDoc: 2,
  });

  assert.deepEqual([...search.resultsByDocument.keys()], ["doc-1", "doc-2"]);

  for (const [docId, results] of search.resultsByDocument) {
    assert.ok(results.length >= 1 && results.length <= 2);
    assert.ok(results.every((result) => result.document.metadata.docId === docId));
  }

  assert.equal(search.routes.dense.queryCount, 2);
  assert.equal(search.routes.sparse.queryCount, 2);
  assert.equal(search.routes.dense.executed, true);
  assert.equal(search.routes.sparse.executed, true);
});

test("route summaries merge across queries by summing candidates and counting executions", () => {
  assert.deepEqual(
    mergeRouteSummaries(
      { dense: { candidateCount: 2, executed: true }, sparse: { candidateCount: 1, executed: true } },
      { dense: { candidateCount: 3, executed: true }, sparse: { candidateCount: 0, executed: false } },
      null
    ),
    {
      dense: { candidateCount: 5, executed: true, queryCount: 2 },
      sparse: { candidateCount: 1, executed: true, queryCount: 2 },
    }
  );
});
