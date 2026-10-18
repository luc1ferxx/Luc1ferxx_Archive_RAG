import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  configureQdrantClientFactory,
  resetQdrantClientFactory,
  resetQdrantVectorStore,
  searchQdrantDocuments,
  searchQdrantDocumentsPerDocument,
  searchQdrantSparseDocuments,
} from "../rag/vector-store-qdrant.js";

// Qdrant has no tenant boundary of its own: a search is scoped only by the
// docIds its caller passes. A filter left out reads every point of the
// collection, every tenant's included, so a search without docIds must find
// nothing and never reach Qdrant unfiltered.

const point = (id, docId, text) => ({
  id,
  payload: { chunkIndex: 0, docId, fileName: `${docId}.pdf`, pageContent: text, pageNumber: 1 },
  score: 0.9,
});

// Two tenants' documents in one collection. Applies a docId filter the way
// Qdrant does; with no filter it returns everything, which is what the store
// must never ask for.
const createRecordingClient = () => {
  const points = [
    point("p-alice", "alice-doc", "alpha ceiling approved amount"),
    point("p-bob", "bob-doc", "alpha ceiling approved amount"),
  ];
  const matches = (payload, filter) => {
    if (!filter) {
      return true;
    }

    if (Array.isArray(filter.must)) {
      return filter.must.every((condition) => payload[condition.key] === condition.match.value);
    }

    return filter.should.some((condition) => payload[condition.key] === condition.match.value);
  };
  const queries = [];

  return {
    queries,
    async collectionExists() {
      return { exists: true };
    },
    async getCollection() {
      return { config: { params: { sparse_vectors: { sparse: {} }, vectors: { dense: { size: 3 } } } } };
    },
    async query(_collection, request) {
      queries.push(request);
      return { points: points.filter((entry) => matches(entry.payload, request.filter)) };
    },
    async scroll() {
      return { next_page_offset: null, points };
    },
  };
};

afterEach(() => {
  resetQdrantClientFactory();
  resetQdrantVectorStore();
});

for (const [label, docIds] of [
  ["an empty list", []],
  ["a missing list", undefined],
  ["null", null],
  ["a non-array value", "alice-doc"],
]) {
  test(`a search with ${label} of docIds finds nothing and never queries Qdrant`, async () => {
    const client = createRecordingClient();
    configureQdrantClientFactory(() => client);

    assert.deepEqual(await searchQdrantDocuments({ docIds, queryText: "alpha ceiling", queryVector: [1, 0, 0], topK: 5 }), []);
    assert.deepEqual(await searchQdrantSparseDocuments({ docIds, queryText: "alpha ceiling", topK: 5 }), []);
    assert.equal(client.queries.length, 0, "no unfiltered query reached the collection");
  });
}

test("a per-document search without docIds is an empty map, not a whole-collection search", async () => {
  const client = createRecordingClient();
  configureQdrantClientFactory(() => client);

  const results = await searchQdrantDocumentsPerDocument({ docIds: undefined, queryVector: [1, 0, 0], topKPerDoc: 3 });

  assert.ok(results instanceof Map);
  assert.equal(results.size, 0);
  assert.equal(client.queries.length, 0);
});

test("a scoped search filters on exactly the docIds given and returns only those documents", async () => {
  const client = createRecordingClient();
  configureQdrantClientFactory(() => client);

  const dense = await searchQdrantDocuments({ docIds: ["alice-doc"], queryText: "alpha ceiling", queryVector: [1, 0, 0], topK: 5 });
  const sparse = await searchQdrantSparseDocuments({ docIds: ["alice-doc", "missing-doc"], queryText: "alpha ceiling", topK: 5 });

  assert.deepEqual(dense.map((result) => result.document.metadata.docId), ["alice-doc"]);
  assert.deepEqual(sparse.map((result) => result.document.metadata.docId), ["alice-doc"]);
  assert.deepEqual(client.queries[0].filter, { must: [{ key: "docId", match: { value: "alice-doc" } }] });
  assert.deepEqual(client.queries[1].filter, {
    should: [
      { key: "docId", match: { value: "alice-doc" } },
      { key: "docId", match: { value: "missing-doc" } },
    ],
  });
  assert.ok(client.queries.every((request) => request.filter), "every query carried a filter");
});
