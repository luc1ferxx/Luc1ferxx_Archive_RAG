import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// A compound question is retrieved with several queries: the question itself
// and one per requirement (rag/query-decomposer.js). In process, with the
// semantic answer cache off, buildRetrievalInputs starts embedding the
// requirement queries next to the question's own embedding, so retrieval
// finds them done or in flight instead of starting them only once the
// question's vector is back (embedding-cache.js prefetchQueryEmbeddings).
// With the semantic cache on, or retrieval on a remote tier, nothing is
// prefetched.

// The local index loads its file when first imported; keep it in a temp dir.
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "retrieval-query-prefetch-test-"));
process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");

const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const { describeEmbeddingFlights, resetEmbeddingCache } = await import("../rag/embedding-cache.js");
const { addDocumentsToIndex, resetVectorStore } = await import("../rag/vector-store.js");
const { executeDocumentRag, retrieveQaCandidates } = await import("../rag/document-rag-execution.js");
const { buildEvidenceRequirements, buildRetrievalQueries } = await import("../rag/query-decomposer.js");
const { routeQuery } = await import("../rag/query-router.js");
const { resetServiceClients } = await import("../rag/service-client.js");
const { buildTermSet } = await import("../rag/text-utils.js");

const DIMENSIONS = 16;
const ENV_KEYS = [
  "ARCHIVE_RAG_ROLE",
  "INTERNAL_SERVICE_KEYS",
  "OPENAI_EMBEDDING_MODEL",
  "RAG_EMBEDDING_CACHE_ENABLED",
  "RAG_EMBEDDING_DIMENSIONS",
  "RAG_EMBEDDING_DOCUMENT_PREFIX",
  "RAG_EMBEDDING_QUERY_ADAPTER",
  "RAG_EMBEDDING_QUERY_PREFIX",
  "RAG_HYBRID_ENABLED",
  "RAG_RERANK_ENABLED",
  "RAG_SEMANTIC_CACHE",
  "RETRIEVAL_SERVICE_URL",
  "VECTOR_STORE_PROVIDER",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const withEnv = (values) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

afterEach(() => {
  withEnv(savedEnv);
  resetOpenAIProvider();
  resetEmbeddingCache();
  resetServiceClients();
  resetVectorStore();
});

test.after(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

const QUESTION = "What is the notice period, the renewal term, and the monthly fee?";
const COMPARISON = "How do the termination clauses differ between these agreements and what notice does each require?";
const CHUNKS = [
  ["contract-a", "The notice period is ninety days before the renewal date."],
  ["contract-a", "The renewal term is one year, renewed automatically."],
  ["contract-a", "The monthly fee is four hundred dollars, billed in advance."],
  ["contract-b", "Either party may terminate with thirty days notice in writing."],
  ["contract-c", "Termination requires sixty days notice and a final invoice."],
];

const embed = (text) => {
  const vector = new Array(DIMENSIONS).fill(0);

  for (const term of buildTermSet(text)) {
    let hash = 0;

    for (const character of term) {
      hash = (hash * 31 + character.codePointAt(0)) % DIMENSIONS;
    }

    vector[hash] += 1;
  }

  vector[0] += 0.01;
  return vector;
};

// Query embeddings wait until released, so the test can look at what was
// started while the question's own vector is still pending. Chunk embeddings
// (the index) are never held.
const createHeldEmbedder = () => {
  const calls = [];
  const held = [];
  let released = false;

  return {
    calls,
    provider: {
      completeText: async () => "unused",
      embedQuery: async (query) => {
        calls.push(query);

        if (!released) {
          await new Promise((resolve) => held.push(resolve));
        }

        return embed(query);
      },
      embedTexts: async (texts) => texts.map(embed),
    },
    release: () => {
      released = true;
      held.splice(0).forEach((resolve) => resolve());
    },
  };
};

// Yields to the event loop until `condition()` holds; a barrier, not a timer.
const waitUntil = async (condition, label) => {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail(`timed out waiting until ${label}`);
};

const settle = async (turns = 20) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const useIndex = async (embedder) => {
  withEnv({
    ARCHIVE_RAG_ROLE: undefined,
    OPENAI_EMBEDDING_MODEL: "prefetch-test-model",
    RAG_EMBEDDING_CACHE_ENABLED: undefined,
    RAG_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
    RAG_EMBEDDING_DOCUMENT_PREFIX: undefined,
    RAG_EMBEDDING_QUERY_ADAPTER: undefined,
    RAG_EMBEDDING_QUERY_PREFIX: undefined,
    RAG_HYBRID_ENABLED: "true",
    RAG_RERANK_ENABLED: "false",
    RAG_SEMANTIC_CACHE: undefined,
    RETRIEVAL_SERVICE_URL: undefined,
    VECTOR_STORE_PROVIDER: "local",
  });
  configureOpenAIProvider(embedder.provider);
  await addDocumentsToIndex({
    documents: CHUNKS.map(([docId, text], chunkIndex) => ({
      id: `${docId}:${chunkIndex}`,
      metadata: { chunkIndex, docId, fileName: `${docId}.pdf`, pageNumber: chunkIndex + 1 },
      pageContent: text,
    })),
  });
};

// The query texts retrieval embeds for `question`, the question first.
const plannedQueryTexts = (question, docIds) => {
  const route = routeQuery({ query: question, docIds });
  const requirements = buildEvidenceRequirements({ query: question, mode: route.mode });

  return buildRetrievalQueries({ query: question, requirements }).map((retrievalQuery) => retrievalQuery.query);
};

test("a QA question: the requirement queries start embedding while the question's own embedding is pending, and none is embedded twice", async () => {
  const embedder = createHeldEmbedder();

  await useIndex(embedder);

  const planned = plannedQueryTexts(QUESTION, ["contract-a"]);

  assert.equal(planned.length, 3, "the question and two requirements");
  assert.equal(planned[0], QUESTION);

  const retrieving = retrieveQaCandidates({ docIds: ["contract-a"], resolvedQuery: QUESTION });

  await waitUntil(() => embedder.calls.length === planned.length, "every planned query is being embedded");
  assert.deepEqual(embedder.calls, planned, "the question first, then its requirements, all before any returned");
  assert.deepEqual(
    describeEmbeddingFlights(),
    planned.map(() => ({ waiters: 1 })),
    "one flight per text; only the question's own is awaited yet"
  );

  embedder.release();

  const { results, routeMode } = await retrieving;

  assert.equal(routeMode, "qa");
  assert.ok(results.length > 0);
  assert.deepEqual(embedder.calls, planned, "retrieval joined the prefetched embeddings: one model call per text");
  assert.deepEqual(describeEmbeddingFlights(), []);
});

test("a comparison: the per-document retrieval finds the requirement embeddings already started", async () => {
  const embedder = createHeldEmbedder();
  const docIds = ["contract-a", "contract-b", "contract-c"];

  await useIndex(embedder);

  const planned = plannedQueryTexts(COMPARISON, docIds);

  assert.equal(planned.length, 3, "the question and two requirements");

  const executing = executeDocumentRag({
    docIds,
    query: COMPARISON,
    resolvedQuery: COMPARISON,
    selectedDocuments: docIds.map((docId) => ({ docId, fileName: `${docId}.pdf` })),
  });

  await waitUntil(() => embedder.calls.length === planned.length, "every planned query is being embedded");
  assert.deepEqual(embedder.calls, planned);

  embedder.release();

  const { routeMode } = await executing;

  assert.equal(routeMode, "compare");
  assert.deepEqual(embedder.calls, planned, "one model call per text");
  assert.deepEqual(describeEmbeddingFlights(), []);
});

test("a question with one retrieval query embeds only the question", async () => {
  const embedder = createHeldEmbedder();

  await useIndex(embedder);
  embedder.release();
  await retrieveQaCandidates({ docIds: ["contract-a"], resolvedQuery: "What is the monthly fee?" });
  assert.deepEqual(embedder.calls, ["What is the monthly fee?"]);
});

test("with the semantic answer cache on, only the question is embedded before retrieval (a hit would leave the rest unused)", async () => {
  const embedder = createHeldEmbedder();

  await useIndex(embedder);
  withEnv({ RAG_SEMANTIC_CACHE: "on" });

  const planned = plannedQueryTexts(QUESTION, ["contract-a"]);
  const retrieving = retrieveQaCandidates({ docIds: ["contract-a"], resolvedQuery: QUESTION });

  await waitUntil(() => embedder.calls.length === 1, "the question is being embedded");
  await settle();
  assert.deepEqual(embedder.calls, [QUESTION], "nothing else while the question's vector is pending");

  embedder.release();
  await retrieving;
  assert.deepEqual(embedder.calls, planned, "retrieval embedded the requirements itself, once each");
});

test("with the embedding cache off nothing is prefetched, so no text is embedded twice", async () => {
  const embedder = createHeldEmbedder();

  await useIndex(embedder);
  withEnv({ RAG_EMBEDDING_CACHE_ENABLED: "false" });

  const planned = plannedQueryTexts(QUESTION, ["contract-a"]);
  const retrieving = retrieveQaCandidates({ docIds: ["contract-a"], resolvedQuery: QUESTION });

  await waitUntil(() => embedder.calls.length === 1, "the question is being embedded");
  await settle();
  assert.deepEqual(embedder.calls, [QUESTION]);

  embedder.release();
  await retrieving;
  assert.deepEqual(embedder.calls, planned);
});

test("with retrieval on a remote tier this process neither embeds nor prefetches a query", async (t) => {
  const embedder = createHeldEmbedder();
  const requests = [];

  await useIndex(embedder);
  embedder.release();

  // A tier that refuses every retrieval: the call goes out and fails, and
  // nothing in this process embedded anything before or after it.
  const tier = http.createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "RETRIEVAL_REQUEST_INVALID", error: "Refused by the test tier." }));
  });

  await new Promise((resolve) => tier.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => tier.close(resolve)));
  withEnv({
    INTERNAL_SERVICE_KEYS: `k1:${"p".repeat(24)}-prefetch-test-secret-0123456789`,
    RETRIEVAL_SERVICE_URL: `http://127.0.0.1:${tier.address().port}`,
  });
  resetServiceClients();

  await assert.rejects(retrieveQaCandidates({ docIds: ["contract-a"], resolvedQuery: QUESTION }));
  await settle();
  assert.deepEqual(requests, ["/internal/retrieval/v1/global"], "the retrieval went to the tier");
  assert.deepEqual(embedder.calls, [], "no query was embedded here");
  assert.deepEqual(describeEmbeddingFlights(), []);
});
