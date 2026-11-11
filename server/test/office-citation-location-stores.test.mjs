import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { configureEmbeddingDimensions } from "../rag/config.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  addDocumentsToQdrantIndex,
  configureQdrantClientFactory,
  resetQdrantClientFactory,
  resetQdrantVectorStore,
  searchQdrantDocuments,
  searchQdrantSparseDocuments,
} from "../rag/vector-store-qdrant.js";
import {
  addDocumentsToLocalIndex,
  resetLocalVectorStore,
  searchLocalDocuments,
} from "../rag/vector-store-local.js";
import {
  addDocumentsToSparseIndex,
  resetSparseStore,
  searchSparseDocuments,
} from "../rag/sparse-store.js";
import {
  configurePgvectorRuntime,
  prepareDocumentsForPgvectorIndex,
  resetPgvectorRuntime,
  resetPgvectorVectorStore,
  searchPgvectorDocuments,
  writeDocumentsToPgvectorIndex,
} from "../rag/vector-store-pgvector.js";

// Every vector store gives back an Office chunk's location (locationUnit,
// locationLabel; rag/citations.js) exactly as it was written, and a PDF
// chunk's metadata exactly as before: pgvector keeps the whole metadata as
// JSONB, the local stores spread it, and the Qdrant payload names its fields
// one by one, so it has to name these two.

const slideChunk = {
  id: "doc-slide:0",
  pageContent: "Revenue grew 12 percent in the third quarter.",
  metadata: {
    docId: "doc-slide",
    fileName: "deck.pptx",
    filePath: "/srv/uploads/doc-slide",
    publicFilePath: "/documents/doc-slide/file",
    pageNumber: 3,
    chunkIndex: 0,
    sectionHeading: null,
    locationUnit: "slide",
    locationLabel: "Q3 Revenue",
  },
};
const sheetChunk = {
  id: "doc-sheet:0",
  pageContent: "Sheet: 2\nRegion: North; Revenue: 120",
  metadata: {
    docId: "doc-sheet",
    fileName: "book.xlsx",
    filePath: "/srv/uploads/doc-sheet",
    publicFilePath: "/documents/doc-sheet/file",
    pageNumber: 2,
    chunkIndex: 0,
    sectionHeading: null,
    locationUnit: "sheet",
  },
};
const pdfChunk = {
  id: "doc-pdf:0",
  pageContent: "Revenue policy for annual leave.",
  metadata: {
    docId: "doc-pdf",
    fileName: "policy.pdf",
    filePath: "/srv/uploads/doc-pdf.pdf",
    publicFilePath: "/documents/doc-pdf/file",
    pageNumber: 1,
    chunkIndex: 0,
    sectionHeading: "Leave",
  },
};
const DOC_IDS = ["doc-slide", "doc-sheet", "doc-pdf"];

const byDocId = (results) =>
  Object.fromEntries(results.map((result) => [result.document.metadata.docId, result.document.metadata]));

// ---------------------------------------------------------------------------
// Qdrant
// ---------------------------------------------------------------------------

// The collection the Qdrant store talks to, in memory: payloads and vectors as
// written, docId filters, dense and sparse dot products, and scrolling.
const createFakeQdrantClient = () => {
  let collectionConfig = null;
  const pointsById = new Map();
  const matchesFilter = (payload, filter) => {
    if (!filter) {
      return true;
    }

    if (Array.isArray(filter.must)) {
      return filter.must.every((condition) => payload?.[condition?.key] === condition?.match?.value);
    }

    if (Array.isArray(filter.should)) {
      return filter.should.some((condition) => payload?.[condition?.key] === condition?.match?.value);
    }

    return true;
  };
  const sortedPoints = () =>
    [...pointsById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const sparseDotProduct = (left, right) => {
    const rightByIndex = new Map(right.indices.map((index, position) => [index, right.values[position]]));

    return left.indices.reduce(
      (sum, index, position) => sum + left.values[position] * (rightByIndex.get(index) ?? 0),
      0
    );
  };
  const denseDotProduct = (left = [], right = []) =>
    left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

  return {
    pointsById,
    async collectionExists() {
      return { exists: Boolean(collectionConfig) };
    },
    async createCollection(_collectionName, config) {
      collectionConfig = structuredClone(config);
      return { result: true };
    },
    async getCollection() {
      return {
        config: {
          params: {
            sparse_vectors: structuredClone(collectionConfig?.sparse_vectors),
            vectors: structuredClone(collectionConfig?.vectors),
          },
        },
      };
    },
    async upsert(_collectionName, { points }) {
      for (const point of points) {
        pointsById.set(String(point.id), {
          id: String(point.id),
          payload: structuredClone(point.payload),
          vector: structuredClone(point.vector),
        });
      }

      return { result: true };
    },
    async updateVectors(_collectionName, { points }) {
      for (const point of points) {
        const existing = pointsById.get(String(point.id));

        if (existing) {
          existing.vector = { ...existing.vector, ...structuredClone(point.vector) };
        }
      }

      return { result: true };
    },
    async delete(_collectionName, { filter }) {
      for (const [id, point] of [...pointsById.entries()]) {
        if (matchesFilter(point.payload, filter)) {
          pointsById.delete(id);
        }
      }

      return { result: true };
    },
    async scroll(_collectionName, { filter, limit = 10, offset }) {
      const points = sortedPoints().filter((point) => matchesFilter(point.payload, filter));
      const start = offset ? points.findIndex((point) => point.id === String(offset)) + 1 : 0;
      const page = points.slice(start, start + limit);

      return {
        next_page_offset: points[start + limit]?.id,
        points: page.map((point) => ({ id: point.id, payload: structuredClone(point.payload) })),
      };
    },
    async query(_collectionName, { filter, limit = 10, query, using }) {
      return {
        points: sortedPoints()
          .filter((point) => matchesFilter(point.payload, filter))
          .map((point) => ({
            id: point.id,
            payload: structuredClone(point.payload),
            score:
              using === "sparse"
                ? point.vector.sparse
                  ? sparseDotProduct(query, point.vector.sparse)
                  : 0
                : denseDotProduct(query, point.vector.dense),
          }))
          .sort((left, right) => right.score - left.score)
          .slice(0, limit),
      };
    },
  };
};

// What the payload and the search metadata held before the location fields.
const PDF_PAYLOAD_KEYS = [
  "docId",
  "fileName",
  "filePath",
  "publicFilePath",
  "pageNumber",
  "chunkIndex",
  "sectionHeading",
  "source",
  "pageContent",
  "embeddingIdentity",
];
const PDF_QDRANT_METADATA_KEYS = [
  "docId",
  "fileName",
  "filePath",
  "publicFilePath",
  "pageNumber",
  "chunkIndex",
  "sectionHeading",
  "source",
];

test("the Qdrant payload keeps an Office chunk's location and a PDF chunk's payload as before", async (t) => {
  const client = createFakeQdrantClient();

  configureQdrantClientFactory(() => client);
  t.after(() => {
    resetQdrantClientFactory();
    resetQdrantVectorStore();
  });

  await addDocumentsToQdrantIndex({
    documents: [slideChunk, sheetChunk, pdfChunk],
    vectors: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  });

  const slidePayload = client.pointsById.get("doc-slide:0").payload;

  assert.deepEqual(Object.keys(client.pointsById.get("doc-pdf:0").payload), PDF_PAYLOAD_KEYS);
  assert.deepEqual(Object.keys(slidePayload).slice(4, 7), ["pageNumber", "locationUnit", "locationLabel"]);
  assert.equal(slidePayload.locationLabel, "Q3 Revenue");
  assert.equal("locationLabel" in client.pointsById.get("doc-sheet:0").payload, false);

  const dense = byDocId(
    await searchQdrantDocuments({ docIds: DOC_IDS, queryText: "revenue", queryVector: [1, 1, 1], topK: 3 })
  );
  const sparse = byDocId(await searchQdrantSparseDocuments({ docIds: DOC_IDS, queryText: "revenue", topK: 3 }));

  for (const metadata of [dense, sparse]) {
    assert.equal(metadata["doc-slide"].locationUnit, "slide");
    assert.equal(metadata["doc-slide"].locationLabel, "Q3 Revenue");
    assert.equal(metadata["doc-sheet"].locationUnit, "sheet");
    assert.equal("locationLabel" in metadata["doc-sheet"], false);
    assert.deepEqual(Object.keys(metadata["doc-pdf"]), PDF_QDRANT_METADATA_KEYS);
  }
});

// ---------------------------------------------------------------------------
// Local stores (dense and BM25), through their files
// ---------------------------------------------------------------------------

test("the local dense and sparse stores give the location back after a reload from disk", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "office-location-local-"));
  const previousDirectory = getRagDataDirectory();

  configureRagDataDirectory(directory);
  resetLocalVectorStore();
  resetSparseStore();
  t.after(async () => {
    configureRagDataDirectory(previousDirectory);
    resetLocalVectorStore();
    resetSparseStore();
    await rm(directory, { force: true, recursive: true });
  });

  const documents = [slideChunk, sheetChunk, pdfChunk];

  await addDocumentsToLocalIndex({
    documents,
    vectors: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  });
  await addDocumentsToSparseIndex({ documents });

  // Read back what was written to the index files, not what is in memory.
  resetLocalVectorStore();
  resetSparseStore();

  const dense = byDocId(
    await searchLocalDocuments({ docIds: DOC_IDS, queryText: "revenue", queryVector: [1, 1, 1], topK: 3 })
  );
  const sparse = byDocId(await searchSparseDocuments({ docIds: DOC_IDS, queryText: "revenue", topK: 3 }));

  for (const metadata of [dense, sparse]) {
    assert.deepEqual(metadata["doc-slide"], slideChunk.metadata);
    assert.deepEqual(metadata["doc-sheet"], sheetChunk.metadata);
    assert.deepEqual(metadata["doc-pdf"], pdfChunk.metadata);
    assert.equal("locationUnit" in metadata["doc-pdf"], false);
  }
});

// ---------------------------------------------------------------------------
// pgvector: the metadata JSONB written, and the metadata a search reads back
// ---------------------------------------------------------------------------

const DIMENSIONS = 4;
const MODEL = "text-embedding-3-small";

// Answers the catalogue statements schema verification sends, records the
// writes, and returns `denseRows` for the dense search (the statement shapes
// vector-store-pgvector.test.mjs pins).
const createFakeDatabase = ({ denseRows = [] } = {}) => {
  const calls = [];
  const query = async (sql, values = []) => {
    const compact = sql.replace(/\s+/g, " ").trim();

    calls.push({ sql: compact, values });

    if (/FROM pg_extension/.test(compact)) {
      return { rows: [{ extversion: "0.7.4" }] };
    }

    if (/FROM pg_attribute/.test(compact)) {
      return { rows: [{ typmod: DIMENSIONS }] };
    }

    if (/GROUP BY embedding_model/.test(compact)) {
      return { rows: [{ chunk_count: 3, embedding_dimensions: DIMENSIONS, embedding_model: MODEL }] };
    }

    if (/AS access_method/.test(compact)) {
      return { rows: [{ access_method: "hnsw" }] };
    }

    if (/FROM pg_indexes/.test(compact)) {
      const table = "rag_document_chunks";

      return {
        rows: [
          `${table}_doc_id_idx`,
          `${table}_scope_idx`,
          `${table}_embedding_model_idx`,
          `${table}_search_vector_idx`,
          `${table}_embedding_idx`,
        ].map((indexname) => ({ indexname })),
      };
    }

    if (/to_regclass/.test(compact)) {
      return { rows: [{ relation: values[0] }] };
    }

    if (/AS vector_score/.test(compact)) {
      return { rows: denseRows };
    }

    if (/^DELETE/.test(compact)) {
      return { rowCount: 0, rows: [] };
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

const usePgvector = (t, options) => {
  const previousModel = process.env.OPENAI_EMBEDDING_MODEL;
  const database = createFakeDatabase(options);

  process.env.OPENAI_EMBEDDING_MODEL = MODEL;
  configureEmbeddingDimensions(DIMENSIONS);
  resetPgvectorVectorStore();
  configurePgvectorRuntime(database.runtime);
  t.after(() => {
    resetPgvectorRuntime();
    resetPgvectorVectorStore();
    resetOpenAIProvider();
    configureEmbeddingDimensions(null);

    if (previousModel === undefined) {
      delete process.env.OPENAI_EMBEDDING_MODEL;
    } else {
      process.env.OPENAI_EMBEDDING_MODEL = previousModel;
    }
  });

  return database;
};

test("pgvector writes the location into the metadata JSONB and a PDF chunk's metadata as before", async (t) => {
  const database = usePgvector(t);

  configureOpenAIProvider({ embedTexts: async (texts) => texts.map(() => [1, 0, 0, 0]) });

  const preparedDocuments = await prepareDocumentsForPgvectorIndex({ documents: [slideChunk, pdfChunk] });

  assert.deepEqual(preparedDocuments[0].metadata, slideChunk.metadata);
  assert.deepEqual(preparedDocuments[1].metadata, pdfChunk.metadata);

  await writeDocumentsToPgvectorIndex({
    accessScope: { userId: "alice", workspaceId: "ws-1" },
    client: { query: database.query },
    preparedDocuments,
  });

  const insert = database.calls.find((call) => /^INSERT/.test(call.sql));

  assert.deepEqual(JSON.parse(insert.values[7]), slideChunk.metadata);
  assert.equal(insert.values[20], JSON.stringify(pdfChunk.metadata));
});

test("a pgvector search gives the stored location back on the result's metadata", async (t) => {
  const row = (chunk, score) => ({
    chunk_id: chunk.id,
    chunk_index: chunk.metadata.chunkIndex,
    content: chunk.pageContent,
    doc_id: chunk.metadata.docId,
    metadata: structuredClone(chunk.metadata),
    page_number: chunk.metadata.pageNumber,
    section_heading: chunk.metadata.sectionHeading,
    vector_score: score,
  });

  usePgvector(t, { denseRows: [row(slideChunk, 0.9), row(pdfChunk, 0.4)] });

  const metadata = byDocId(
    await searchPgvectorDocuments({
      docIds: ["doc-slide", "doc-pdf"],
      queryText: "revenue",
      queryVector: [1, 0, 0, 0],
      scoringMode: "dense",
      topK: 2,
    })
  );

  assert.deepEqual(metadata["doc-slide"], slideChunk.metadata);
  assert.deepEqual(metadata["doc-pdf"], pdfChunk.metadata);
  assert.equal("locationUnit" in metadata["doc-pdf"], false);
});

afterEach(() => {
  resetOpenAIProvider();
});
