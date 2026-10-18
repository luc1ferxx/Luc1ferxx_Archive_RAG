import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureRagDataDirectory,
  getRagDataDirectory,
  getRagDataPath,
  readJsonFileSync,
  writeJsonFileSync,
  writeJsonFileAsync,
} from "../rag/storage.js";
import {
  addDocumentsToLocalIndex,
  removeDocumentsFromLocalIndex,
  clearLocalVectorIndex,
  searchLocalDocuments,
  searchLocalDocumentsPerDocument,
  resetLocalVectorStore,
} from "../rag/vector-store-local.js";
import {
  addDocumentsToSparseIndex,
  removeDocumentsFromSparseIndex,
  clearSparseIndex,
  searchSparseDocuments,
  searchSparseDocumentsPerDocument,
  resetSparseStore,
  getSparseStatisticsSnapshot,
  forceRebuildSparseStatistics,
} from "../rag/sparse-store.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { selectSparseQueryTerms, SPARSE_MAX_QUERY_TERMS } from "../rag/sparse-query-terms.js";
import { buildTermSet } from "../rag/text-utils.js";
import { buildTsQuery, PGVECTOR_SPARSE_MAX_QUERY_TERMS } from "../rag/vector-store-pgvector.js";

const originalDataDirectory = getRagDataDirectory();
const EMBEDDING_DIMENSIONS = 64;
let tempRoot = null;

const hashToken = (token) => {
  let hash = 0;
  for (const character of token) {
    hash = (hash * 31 + character.codePointAt(0)) % EMBEDDING_DIMENSIONS;
  }
  return hash;
};

const toEmbedding = (text) => {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (const term of buildTermSet(text)) {
    vector[hashToken(term)] += 1;
  }
  return vector;
};

const provider = {
  embedTexts: async (texts) => texts.map((text) => toEmbedding(text)),
  embedQuery: async (query) => toEmbedding(query),
  completeText: async () => "test",
};

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "storage-layer-test-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  configureOpenAIProvider(provider);
  resetLocalVectorStore();
  resetSparseStore();
});

afterEach(async () => {
  resetOpenAIProvider();
  configureRagDataDirectory(originalDataDirectory);
  resetLocalVectorStore();
  resetSparseStore();
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

// ---- storage.js tests ----

test("writeJsonFileSync produces compact output without indentation", async () => {
  const filePath = path.join(tempRoot, "compact-check.json");
  const data = { key: "value", nested: { a: 1, b: [1, 2, 3] } };
  writeJsonFileSync(filePath, data);
  const raw = await readFile(filePath, "utf8");
  assert.ok(!raw.includes("  "), "compact JSON should not contain 2-space indentation");
  assert.ok(raw.startsWith("{"), "should start with opening brace");
  assert.ok(!raw.includes("\n  "), "should not have indented lines");
});

test("writeJsonFileAsync writes valid JSON atomically", async () => {
  const filePath = path.join(tempRoot, "async-write.json");
  const data = { items: [1, 2, 3], label: "test" };
  await writeJsonFileAsync(filePath, data);
  const parsed = readJsonFileSync(filePath, null);
  assert.deepEqual(parsed, data);
});

test("writeJsonFileAsync overwrites existing file", async () => {
  const filePath = path.join(tempRoot, "overwrite.json");
  await writeJsonFileAsync(filePath, { version: 1 });
  await writeJsonFileAsync(filePath, { version: 2 });
  const parsed = readJsonFileSync(filePath, null);
  assert.deepEqual(parsed, { version: 2 });
});

test("writeJsonFileAsync creates parent directories", async () => {
  const filePath = path.join(tempRoot, "deep", "nested", "dir", "file.json");
  await writeJsonFileAsync(filePath, { deep: true });
  const parsed = readJsonFileSync(filePath, null);
  assert.deepEqual(parsed, { deep: true });
});

test("writeJsonFileAsync produces compact JSON", async () => {
  const filePath = path.join(tempRoot, "async-compact.json");
  const data = { key: "value", nested: { a: 1 } };
  await writeJsonFileAsync(filePath, data);
  const raw = await readFile(filePath, "utf8");
  assert.ok(!raw.includes("  "), "async compact JSON should not contain indentation");
});

// ---- vector-store-local.js tests ----

test("addDocumentsToLocalIndex persists and searches correctly", async () => {
  await addDocumentsToLocalIndex({
    documents: [
      {
        id: "doc1:0",
        pageContent: "Machine learning algorithms for classification tasks.",
        metadata: { docId: "doc1", fileName: "ml.pdf" },
      },
      {
        id: "doc1:1",
        pageContent: "Neural network training with backpropagation.",
        metadata: { docId: "doc1", fileName: "ml.pdf" },
      },
    ],
  });

  const results = await searchLocalDocuments({
    queryVector: toEmbedding("machine learning classification"),
    queryText: "machine learning classification",
    docIds: ["doc1"],
    topK: 2,
  });

  assert.equal(results.length, 2);
  assert.ok(results[0].score >= results[1].score);
});

test("removeDocumentsFromLocalIndex removes by docId", async () => {
  await addDocumentsToLocalIndex({
    documents: [
      {
        id: "doc1:0",
        pageContent: "Test document content one.",
        metadata: { docId: "doc1", fileName: "test.pdf" },
      },
      {
        id: "doc2:0",
        pageContent: "Test document content two.",
        metadata: { docId: "doc2", fileName: "test2.pdf" },
      },
    ],
  });

  await removeDocumentsFromLocalIndex({ docIds: ["doc1"] });

  const results = await searchLocalDocuments({
    queryVector: toEmbedding("test document"),
    queryText: "test document",
    docIds: ["doc1", "doc2"],
    topK: 10,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].document.metadata.docId, "doc2");
});

test("clearLocalVectorIndex removes all entries", async () => {
  await addDocumentsToLocalIndex({
    documents: [
      {
        id: "doc1:0",
        pageContent: "Content for clearing test.",
        metadata: { docId: "doc1", fileName: "test.pdf" },
      },
    ],
  });

  await clearLocalVectorIndex();

  const results = await searchLocalDocuments({
    queryVector: toEmbedding("content clearing"),
    queryText: "content clearing",
    docIds: ["doc1"],
    topK: 10,
  });

  assert.equal(results.length, 0);
});

test("searchLocalDocumentsPerDocument returns Map with per-doc results in parallel", async () => {
  await addDocumentsToLocalIndex({
    documents: [
      {
        id: "docA:0",
        pageContent: "Alpha document about machine learning.",
        metadata: { docId: "docA", fileName: "alpha.pdf" },
      },
      {
        id: "docB:0",
        pageContent: "Beta document about machine learning.",
        metadata: { docId: "docB", fileName: "beta.pdf" },
      },
    ],
  });

  const perDocResults = await searchLocalDocumentsPerDocument({
    queryVector: toEmbedding("machine learning"),
    queryText: "machine learning",
    docIds: ["docA", "docB"],
    topKPerDoc: 1,
  });

  assert.ok(perDocResults instanceof Map);
  assert.equal(perDocResults.size, 2);
  assert.equal(perDocResults.get("docA").length, 1);
  assert.equal(perDocResults.get("docB").length, 1);
  assert.equal(perDocResults.get("docA")[0].document.metadata.docId, "docA");
  assert.equal(perDocResults.get("docB")[0].document.metadata.docId, "docB");

  // Verify Map preserves input order
  const keys = [...perDocResults.keys()];
  assert.deepEqual(keys, ["docA", "docB"]);
});

test("vector store write lock serializes concurrent mutations", async () => {
  // Run two concurrent adds - they should not interleave
  const addA = addDocumentsToLocalIndex({
    documents: [
      {
        id: "concurrent:a",
        pageContent: "Concurrent document alpha.",
        metadata: { docId: "concurrent", fileName: "c.pdf" },
      },
    ],
  });
  const addB = addDocumentsToLocalIndex({
    documents: [
      {
        id: "concurrent:b",
        pageContent: "Concurrent document beta.",
        metadata: { docId: "concurrent", fileName: "c.pdf" },
      },
    ],
  });

  await Promise.all([addA, addB]);

  const results = await searchLocalDocuments({
    queryVector: toEmbedding("concurrent document"),
    queryText: "concurrent document",
    docIds: ["concurrent"],
    topK: 10,
  });

  // Both entries should be present (no lost updates)
  assert.equal(results.length, 2);
});

// ---- sparse-store.js tests ----

test("addDocumentsToSparseIndex persists and allows search", async () => {
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "sparse1:0",
        pageContent: "Retrieval augmented generation with knowledge bases.",
        metadata: { docId: "sparse1", fileName: "rag.pdf" },
      },
    ],
  });

  const results = await searchSparseDocuments({
    queryText: "retrieval augmented generation",
    docIds: ["sparse1"],
    topK: 5,
  });

  assert.ok(results.length > 0);
  assert.equal(results[0].document.metadata.docId, "sparse1");
});

test("a local sparse query keeps the same first 64 distinct terms the pgvector route keeps", async () => {
  // 100 distinct terms, each repeated: the first 64 distinct ones are scored,
  // exactly as buildTsQuery selects them.
  const terms = Array.from({ length: 100 }, (_, index) => `term${String(index).padStart(3, "0")}`);
  const queryText = [...terms, ...terms].join(" ");

  assert.equal(SPARSE_MAX_QUERY_TERMS, 64);
  assert.equal(PGVECTOR_SPARSE_MAX_QUERY_TERMS, SPARSE_MAX_QUERY_TERMS);
  assert.deepEqual(selectSparseQueryTerms(queryText), terms.slice(0, 64));
  assert.deepEqual(selectSparseQueryTerms(queryText), buildTsQuery(queryText).tokens);

  await addDocumentsToSparseIndex({
    documents: [
      { id: "cap-early:0", metadata: { docId: "cap", fileName: "a.pdf" }, pageContent: "term002 early clause." },
      { id: "cap-late:0", metadata: { docId: "cap", fileName: "b.pdf" }, pageContent: "term070 late clause." },
    ],
  });

  const results = await searchSparseDocuments({ docIds: ["cap"], queryText, topK: 5 });

  // A term past the cap matches nothing; the overlap is over the 64 kept.
  assert.deepEqual(results.map((result) => result.document.id), ["cap-early:0"]);
  assert.equal(results[0].keywordScore, 1 / 64);

  // Below the cap nothing changes: the late term alone still finds its chunk.
  assert.deepEqual(
    (await searchSparseDocuments({ docIds: ["cap"], queryText: "term070 clause", topK: 5 })).map(
      (result) => result.document.id
    ).sort(),
    ["cap-early:0", "cap-late:0"]
  );
});

test("removeDocumentsFromSparseIndex removes by docId", async () => {
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "s1:0",
        pageContent: "Alpha document content here.",
        metadata: { docId: "s1", fileName: "a.pdf" },
      },
      {
        id: "s2:0",
        pageContent: "Beta document content here.",
        metadata: { docId: "s2", fileName: "b.pdf" },
      },
    ],
  });

  await removeDocumentsFromSparseIndex({ docIds: ["s1"] });

  const results = await searchSparseDocuments({
    queryText: "document content",
    docIds: ["s1", "s2"],
    topK: 10,
  });

  assert.ok(results.every((r) => r.document.metadata.docId === "s2"));
});

test("removing docIds that are not indexed does not rewrite either index file", async () => {
  // ingest rolls back unconditionally, so the common case is a rollback for a
  // document that never reached the index. Rewriting both whole index files on
  // every such failure would scale the cost of a failed upload with the size of
  // the entire archive.
  await addDocumentsToLocalIndex({
    documents: [
      {
        id: "keep:0",
        pageContent: "Retained vector content.",
        metadata: { docId: "keep", fileName: "keep.pdf" },
      },
    ],
  });
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "keep:0",
        pageContent: "Retained sparse content.",
        metadata: { docId: "keep", fileName: "keep.pdf" },
      },
    ],
  });

  const vectorIndexPath = getRagDataPath("vector-index.json");
  const sparseIndexPath = getRagDataPath("sparse-index.json");
  const exists = async (filePath) =>
    access(filePath).then(
      () => true,
      () => false
    );

  assert.equal(await exists(vectorIndexPath), true);
  assert.equal(await exists(sparseIndexPath), true);

  // Deleting the files makes a stray write impossible to miss: only a persist
  // call can bring them back.
  await rm(vectorIndexPath);
  await rm(sparseIndexPath);

  await removeDocumentsFromLocalIndex({ docIds: ["never-indexed"] });
  await removeDocumentsFromSparseIndex({ docIds: ["never-indexed"] });

  assert.equal(await exists(vectorIndexPath), false);
  assert.equal(await exists(sparseIndexPath), false);

  // The in-memory index must be untouched too -- skipping the write is only
  // correct if nothing was actually removed.
  const vectorResults = await searchLocalDocuments({
    queryText: "retained vector content",
    docIds: ["keep"],
    topK: 5,
  });
  assert.equal(vectorResults[0]?.document.metadata.docId, "keep");
  assert.equal(getSparseStatisticsSnapshot().entryCount, 1);
});

test("clearSparseIndex empties the store", async () => {
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "clear:0",
        pageContent: "Content for clear test.",
        metadata: { docId: "clear", fileName: "c.pdf" },
      },
    ],
  });

  await clearSparseIndex();

  const stats = getSparseStatisticsSnapshot();
  assert.equal(stats.entryCount, 0);
  assert.equal(stats.averageDocumentLength, 0);
  assert.equal(stats.totalDocumentLength, 0);
  assert.equal(stats.documentFrequencyByTerm.size, 0);
});

test("searchSparseDocumentsPerDocument returns parallel per-doc results", async () => {
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "pA:0",
        pageContent: "Alpha sparse document about retrieval.",
        metadata: { docId: "pA", fileName: "alpha.pdf" },
      },
      {
        id: "pB:0",
        pageContent: "Beta sparse document about retrieval.",
        metadata: { docId: "pB", fileName: "beta.pdf" },
      },
    ],
  });

  const perDocResults = await searchSparseDocumentsPerDocument({
    queryText: "sparse retrieval",
    docIds: ["pA", "pB"],
    topKPerDoc: 1,
  });

  assert.ok(perDocResults instanceof Map);
  assert.equal(perDocResults.size, 2);
  assert.equal(perDocResults.get("pA")[0].document.metadata.docId, "pA");
  assert.equal(perDocResults.get("pB")[0].document.metadata.docId, "pB");

  const keys = [...perDocResults.keys()];
  assert.deepEqual(keys, ["pA", "pB"]);
});

test("sparse store write lock serializes concurrent mutations", async () => {
  const addA = addDocumentsToSparseIndex({
    documents: [
      {
        id: "sc:a",
        pageContent: "Concurrent sparse alpha document.",
        metadata: { docId: "sc", fileName: "c.pdf" },
      },
    ],
  });
  const addB = addDocumentsToSparseIndex({
    documents: [
      {
        id: "sc:b",
        pageContent: "Concurrent sparse beta document.",
        metadata: { docId: "sc", fileName: "c.pdf" },
      },
    ],
  });

  await Promise.all([addA, addB]);

  const results = await searchSparseDocuments({
    queryText: "concurrent sparse",
    docIds: ["sc"],
    topK: 10,
  });

  assert.equal(results.length, 2);
});

// ---- Incremental statistics correctness ----

test("incremental statistics match full rebuild after adds", async () => {
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "inc:0",
        pageContent: "Machine learning classification tasks neural networks.",
        metadata: { docId: "inc1", fileName: "ml.pdf" },
      },
      {
        id: "inc:1",
        pageContent: "Natural language processing with transformers.",
        metadata: { docId: "inc1", fileName: "ml.pdf" },
      },
    ],
  });

  const incrementalStats = getSparseStatisticsSnapshot();

  // Force full rebuild and compare
  forceRebuildSparseStatistics();
  const rebuildStats = getSparseStatisticsSnapshot();

  assert.equal(incrementalStats.averageDocumentLength, rebuildStats.averageDocumentLength);
  assert.equal(incrementalStats.totalDocumentLength, rebuildStats.totalDocumentLength);
  assert.equal(incrementalStats.entryCount, rebuildStats.entryCount);
  assert.deepEqual(
    [...incrementalStats.documentFrequencyByTerm.entries()].sort(),
    [...rebuildStats.documentFrequencyByTerm.entries()].sort()
  );
});

test("incremental statistics match full rebuild after add with id replacement", async () => {
  // Add initial documents
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "replace:0",
        pageContent: "Original content about machine learning.",
        metadata: { docId: "replace1", fileName: "r.pdf" },
      },
      {
        id: "replace:1",
        pageContent: "Deep learning with neural networks.",
        metadata: { docId: "replace1", fileName: "r.pdf" },
      },
    ],
  });

  // Replace one entry by using same id, different content
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "replace:0",
        pageContent: "Replaced content about quantum computing.",
        metadata: { docId: "replace1", fileName: "r.pdf" },
      },
    ],
  });

  const incrementalStats = getSparseStatisticsSnapshot();

  forceRebuildSparseStatistics();
  const rebuildStats = getSparseStatisticsSnapshot();

  assert.equal(incrementalStats.averageDocumentLength, rebuildStats.averageDocumentLength);
  assert.equal(incrementalStats.totalDocumentLength, rebuildStats.totalDocumentLength);
  assert.equal(incrementalStats.entryCount, rebuildStats.entryCount);
  assert.equal(incrementalStats.entryCount, 2);
  assert.deepEqual(
    [...incrementalStats.documentFrequencyByTerm.entries()].sort(),
    [...rebuildStats.documentFrequencyByTerm.entries()].sort()
  );
});

test("incremental statistics match full rebuild after removes", async () => {
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "rem:0",
        pageContent: "Document alpha about statistics.",
        metadata: { docId: "rem-alpha", fileName: "a.pdf" },
      },
      {
        id: "rem:1",
        pageContent: "Document beta about statistics.",
        metadata: { docId: "rem-beta", fileName: "b.pdf" },
      },
      {
        id: "rem:2",
        pageContent: "Document gamma about machine learning.",
        metadata: { docId: "rem-gamma", fileName: "c.pdf" },
      },
    ],
  });

  await removeDocumentsFromSparseIndex({ docIds: ["rem-beta"] });

  const incrementalStats = getSparseStatisticsSnapshot();

  forceRebuildSparseStatistics();
  const rebuildStats = getSparseStatisticsSnapshot();

  assert.equal(incrementalStats.averageDocumentLength, rebuildStats.averageDocumentLength);
  assert.equal(incrementalStats.totalDocumentLength, rebuildStats.totalDocumentLength);
  assert.equal(incrementalStats.entryCount, 2);
  assert.deepEqual(
    [...incrementalStats.documentFrequencyByTerm.entries()].sort(),
    [...rebuildStats.documentFrequencyByTerm.entries()].sort()
  );
});

test("incremental statistics match full rebuild after mixed adds, replacements, and removes", async () => {
  // Phase 1: add initial documents
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "mix:0",
        pageContent: "Alpha retrieval augmented generation framework.",
        metadata: { docId: "mix-a", fileName: "a.pdf" },
      },
      {
        id: "mix:1",
        pageContent: "Beta knowledge graph construction approach.",
        metadata: { docId: "mix-a", fileName: "a.pdf" },
      },
      {
        id: "mix:2",
        pageContent: "Gamma document indexing pipeline.",
        metadata: { docId: "mix-b", fileName: "b.pdf" },
      },
    ],
  });

  // Phase 2: replace mix:0 with different content
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "mix:0",
        pageContent: "Alpha neural search with dense embeddings.",
        metadata: { docId: "mix-a", fileName: "a.pdf" },
      },
    ],
  });

  // Phase 3: add new document
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "mix:3",
        pageContent: "Delta sparse retrieval using BM25 algorithm.",
        metadata: { docId: "mix-c", fileName: "c.pdf" },
      },
    ],
  });

  // Phase 4: remove mix-b
  await removeDocumentsFromSparseIndex({ docIds: ["mix-b"] });

  // Phase 5: replace mix:1
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "mix:1",
        pageContent: "Beta vector database technology comparison.",
        metadata: { docId: "mix-a", fileName: "a.pdf" },
      },
    ],
  });

  const incrementalStats = getSparseStatisticsSnapshot();

  forceRebuildSparseStatistics();
  const rebuildStats = getSparseStatisticsSnapshot();

  assert.equal(incrementalStats.averageDocumentLength, rebuildStats.averageDocumentLength);
  assert.equal(incrementalStats.totalDocumentLength, rebuildStats.totalDocumentLength);
  assert.equal(incrementalStats.entryCount, rebuildStats.entryCount);
  assert.equal(incrementalStats.entryCount, 3); // mix:0, mix:1, mix:3
  assert.deepEqual(
    [...incrementalStats.documentFrequencyByTerm.entries()].sort(),
    [...rebuildStats.documentFrequencyByTerm.entries()].sort()
  );

  // Verify no term has zero or negative frequency
  for (const [term, freq] of incrementalStats.documentFrequencyByTerm) {
    assert.ok(freq > 0, `term "${term}" should have positive frequency`);
  }
});

test("incremental statistics produce correct search scores after mixed operations", async () => {
  // Add documents
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "score:0",
        pageContent: "Retrieval augmented generation for knowledge bases.",
        metadata: { docId: "score-a", fileName: "a.pdf" },
      },
      {
        id: "score:1",
        pageContent: "Dense passage retrieval with dual encoders.",
        metadata: { docId: "score-a", fileName: "a.pdf" },
      },
    ],
  });

  // Replace one
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "score:0",
        pageContent: "Updated retrieval approach for question answering.",
        metadata: { docId: "score-a", fileName: "a.pdf" },
      },
    ],
  });

  // Search with incremental stats
  const incrementalResults = await searchSparseDocuments({
    queryText: "retrieval question answering",
    docIds: ["score-a"],
    topK: 5,
  });

  // Now force rebuild and search again
  forceRebuildSparseStatistics();

  const rebuildResults = await searchSparseDocuments({
    queryText: "retrieval question answering",
    docIds: ["score-a"],
    topK: 5,
  });

  assert.equal(incrementalResults.length, rebuildResults.length);
  for (let i = 0; i < incrementalResults.length; i++) {
    assert.equal(incrementalResults[i].document.id, rebuildResults[i].document.id);
    assert.equal(incrementalResults[i].sparseScore, rebuildResults[i].sparseScore);
  }
});

test("vector store persists data that survives reload", async () => {
  await addDocumentsToLocalIndex({
    documents: [
      {
        id: "persist:0",
        pageContent: "Persistence test document content.",
        metadata: { docId: "persist1", fileName: "p.pdf" },
      },
    ],
  });

  // Reset (reload from disk)
  resetLocalVectorStore();

  const results = await searchLocalDocuments({
    queryVector: toEmbedding("persistence test"),
    queryText: "persistence test",
    docIds: ["persist1"],
    topK: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].document.id, "persist:0");
});

test("sparse store persists data that survives reload", async () => {
  await addDocumentsToSparseIndex({
    documents: [
      {
        id: "sp:0",
        pageContent: "Sparse persistence test document.",
        metadata: { docId: "sp1", fileName: "sp.pdf" },
      },
    ],
  });

  // Reset (reload from disk)
  resetSparseStore();

  const results = await searchSparseDocuments({
    queryText: "sparse persistence",
    docIds: ["sp1"],
    topK: 5,
  });

  assert.ok(results.length > 0);
  assert.equal(results[0].document.id, "sp:0");
});
