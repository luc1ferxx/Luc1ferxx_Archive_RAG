import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  addDocumentsToIndex,
  resetVectorStore,
  searchDocumentsWithRoutes,
} from "../rag/vector-store.js";

// RAG_RETRIEVAL_ROUTE is the measurement selector that lets the evaluation
// harness isolate each retrieval arm. These tests pin its contract on the local
// backend (no database): dense-only and sparse-only each run exactly one route,
// the default stays hybrid, admission never rides the unbounded sparse rank even
// when the dense route is off, and an unknown value fails closed.

const originalDataDirectory = getRagDataDirectory();
const pinnedEnvironment = {
  RAG_HYBRID_ENABLED: "true",
  RAG_HYBRID_FUSION: "rrf",
  RAG_RRF_K: "60",
  RAG_SPARSE_TOP_K: "4",
  VECTOR_STORE_PROVIDER: "local",
  RAG_RETRIEVAL_ROUTE: undefined,
};
let originalEnvironment = {};
let tempRoot = null;

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

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(
    Object.keys(pinnedEnvironment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, pinnedEnvironment);
  delete process.env.RAG_RETRIEVAL_ROUTE;
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "retrieval-route-"));
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

const search = (overrides = {}) =>
  searchDocumentsWithRoutes({
    queryVector: embed("alpha"),
    queryText: "alpha approval policy",
    docIds: ["doc-1", "doc-2"],
    topK: 3,
    ...overrides,
  });

test("the default route is hybrid: both routes execute and fusion is on", async () => {
  const result = await search();

  assert.deepEqual(result.fusion, { enabled: true, method: "rrf" });
  assert.equal(result.routes.dense.executed, true);
  assert.equal(result.routes.sparse.executed, true);
});

test("RAG_RETRIEVAL_ROUTE=dense runs the dense route only, even with hybrid enabled", async () => {
  await withEnv({ RAG_RETRIEVAL_ROUTE: "dense", RAG_HYBRID_ENABLED: "true" }, async () => {
    const result = await search();

    assert.deepEqual(result.fusion, { enabled: false, method: null });
    assert.equal(result.routes.dense.executed, true);
    assert.equal(result.routes.sparse.executed, false);
    assert.equal(result.routes.sparse.candidateCount, 0);

    for (const entry of result.results) {
      const routes = entry.provenance.routes.map((route) => route.route);
      assert.deepEqual(routes, ["dense"], `dense-only result carried ${routes}`);
      // Dense admission rides the bounded cosine signal.
      assert.equal(entry.admissionScore, Math.max(Number(entry.vectorScore) || 0, Number(entry.keywordScore) || 0));
    }
  });
});

test("RAG_RETRIEVAL_ROUTE=sparse runs the sparse route only and admits on the bounded keyword signal", async () => {
  await withEnv({ RAG_RETRIEVAL_ROUTE: "sparse", RAG_HYBRID_ENABLED: "true" }, async () => {
    const result = await search();

    assert.deepEqual(result.fusion, { enabled: false, method: null });
    assert.equal(result.routes.sparse.executed, true);
    assert.equal(result.routes.dense.executed, false);
    assert.equal(result.routes.dense.candidateCount, 0);
    assert.ok(result.results.length > 0, "sparse route returned no candidates");

    const [top] = result.results;
    // The sparse route ranks on sparseScore (BM25 on the local backend), which is
    // unbounded and kept only as provenance.
    assert.deepEqual(top.provenance.routes.map((route) => route.route), ["sparse"]);
    assert.ok(top.sparseScore > 0, "sparse candidate must carry a sparse rank score");
    assert.equal(top.vectorScore, undefined, "sparse-only must not compute a dense score");

    for (const entry of result.results) {
      // Admission is the bounded keyword coverage, never the unbounded sparse rank.
      assert.equal(entry.admissionScore, Number(entry.keywordScore) || 0);
      assert.ok(entry.admissionScore <= 1, `admission ${entry.admissionScore} must stay in [0, 1]`);
    }
  });
});

test("an unknown RAG_RETRIEVAL_ROUTE fails closed instead of measuring the wrong arm", async () => {
  await withEnv({ RAG_RETRIEVAL_ROUTE: "sprase" }, async () => {
    await assert.rejects(() => search(), /RAG_RETRIEVAL_ROUTE must be one of hybrid, dense, sparse/);
  });
});
