import "./langgraph-spike/langsmith-off.mjs";

import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";

// Phase 1 of docs/adr/0001-langgraph-runtime.md: the LangChain Embeddings and
// Retriever adapters (rag/langgraph/embeddings.js, rag/langgraph/retriever.js)
// must be pure pass-throughs. Every test calls the existing function directly
// and through the adapter with the same inputs and cold caches, and requires
// deepStrictEqual results, the same requests to the model (or stand-in), and
// the same LLMOps events once timestamps and durations are masked.

// The local index and the file registry load from the data directory when
// first imported; keep both in a temp dir before anything imports them.
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "langgraph-retrieval-adapters-"));
process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");

const SECRET = "l".repeat(24) + "-langgraph-retrieval-secret-0123";
const PINNED_ENVIRONMENT = {
  INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
  OPENAI_EMBEDDING_MODEL: "langgraph-adapter-test-model",
  RAG_EMBEDDING_CACHE_ENABLED: "true",
  RAG_EMBEDDING_DIMENSIONS: "64",
  RAG_EMBEDDING_DOCUMENT_PREFIX: "",
  RAG_EMBEDDING_QUERY_PREFIX: "",
  RAG_HYBRID_ENABLED: "true",
  RAG_HYBRID_FUSION: "rrf",
  RAG_OBSERVABILITY_ENABLED: "true",
  RAG_OBSERVABILITY_EVENTS_PATH: path.join(tempRoot, "rag-events.jsonl"),
  RAG_RERANK_ENABLED: "false",
  RAG_SEMANTIC_CACHE: "off",
  VECTOR_STORE_PROVIDER: "local",
};
// Unset for every test unless a test sets it.
const CLEARED_ENVIRONMENT = [
  "AGENT_SERVICE_URL",
  "ARCHIVE_RAG_ROLE",
  "INTERNAL_SERVICE_AUTH",
  "MODEL_GATEWAY_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_CHAT_FALLBACK_MODEL",
  "RAG_CROSS_ENCODER_ENDPOINT",
  "RAG_EMBEDDING_QUERY_ADAPTER",
  "RAG_RERANK_PROVIDER",
  "RAG_RETRIEVAL_ROUTE",
  "RAG_SHARED_STATE",
  "RETRIEVAL_SERVICE_TIMEOUT_MS",
  "RETRIEVAL_SERVICE_URL",
];
const savedEnvironment = Object.fromEntries(
  [...Object.keys(PINNED_ENVIRONMENT), ...CLEARED_ENVIRONMENT].map((key) => [key, process.env[key]])
);

Object.assign(process.env, PINNED_ENVIRONMENT);
CLEARED_ENVIRONMENT.forEach((key) => delete process.env[key]);

const restoreEnvironment = (saved) => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const { Document } = await import("@langchain/core/documents");
const { awaitAllCallbacks } = await import("@langchain/core/callbacks/promises");
const { configureOpenAIProvider, embedTexts, resetOpenAIProvider } = await import("../rag/openai.js");
const { embedQueryCached, getQueryVectorEmbeddingSpace, resetEmbeddingCache } = await import(
  "../rag/embedding-cache.js"
);
const { buildEmbeddingSpace, getConfiguredEmbeddingSpace } = await import("../rag/vector-store-pgvector-versions.js");
const { embedDocumentsInSpace } = await import("../rag/vector-store-pgvector.js");
const { buildTermSet } = await import("../rag/text-utils.js");
const { LLMOPS_TRACE_TYPE } = await import("../rag/llmops-metrics.js");
const { configureDocumentRegistryStore, registerDocument, resetDocumentRegistry, resetDocumentRegistryStore } =
  await import("../rag/doc-registry.js");
const { createFileDocumentRegistryStore } = await import("../rag/doc-registry-file.js");
const ragIndex = await import("../rag/index.js");
const { addDocumentsToIndex, resetVectorStore } = await import("../rag/vector-store.js");
const { retrieveGlobalContextForQueries, retrievePerDocumentContextForQueries, retrieveQaCandidates } =
  await import("../rag/document-rag-execution.js");
const { buildRetrievalQueries } = await import("../rag/query-decomposer.js");
const { QUERY_ADAPTER_SCOPE_QA, getModelQueryVectorSpace, resetQueryAdapter, serializeQueryAdapter } = await import(
  "../rag/query-adapter.js"
);
const { resetServiceClients } = await import("../rag/service-client.js");
const { runWithDatabaseTenant } = await import("../rag/postgres-tenant.js");
const { createRetrievalApp } = await import("../rag/retrieval-service/app.js");
const { RETRIEVAL_SERVICE_ERROR_CODES, RETRIEVAL_SERVICE_PATHS } = await import(
  "../rag/retrieval-service/remote-retrieval.js"
);
const { LANGSMITH_TRACING_ENABLED_CODE, LANGSMITH_TRACING_VARIABLES } = await import(
  "../rag/langgraph/langsmith-guard.js"
);
const { ArchiveRagEmbeddings } = await import("../rag/langgraph/embeddings.js");
const {
  ARCHIVE_RAG_RETRIEVER_MODES,
  ArchiveRagRetriever,
  LANGGRAPH_RETRIEVER_ERROR_CODES,
  RETRIEVAL_RESULT_METADATA_KEY,
  toPerDocumentRetrievalResults,
  toPerDocumentRetrieverDocuments,
  toRetrievalResults,
  toRetrieverDocuments,
} = await import("../rag/langgraph/retriever.js");

const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-a" };
const BOB = { authenticated: true, userId: "bob", workspaceId: "ws-b" };

// ---------------------------------------------------------------------------
// Fixtures: a hashed bag-of-words stand-in embedder that records exactly what
// it is handed, and three documents -- two of Alice's and one of Bob's that
// shares her vocabulary (the retrieval-service suite's fixtures).
// ---------------------------------------------------------------------------

const DIMENSIONS = 64;
const embed = (text) => {
  const vector = new Array(DIMENSIONS).fill(0);

  for (const term of buildTermSet(text)) {
    let hash = 0;

    for (const character of term) {
      hash = (hash * 31 + character.codePointAt(0)) % DIMENSIONS;
    }

    vector[hash] += 1;
  }

  vector[DIMENSIONS - 1] += 0.05;
  return vector;
};

let standInCalls = [];

const useStandInModels = () =>
  configureOpenAIProvider({
    completeText: async () => "unused",
    // The arguments as received: one for the configured space, a second
    // { embeddingSpace } for a pinned one (openai.js callCustomEmbedding).
    embedQuery: async (...args) => {
      standInCalls.push({ args, method: "embedQuery" });
      return embed(args[0]);
    },
    embedTexts: async (...args) => {
      standInCalls.push({ args, method: "embedTexts" });
      return args[0].map(embed);
    },
  });

const DOCUMENTS = [
  {
    docId: "leave-policy",
    owner: ALICE,
    pages: [
      "Annual leave policy: employees receive ten paid annual leave days each year. Leave requests need manager approval two weeks ahead.",
      "Remote work policy: employees may work remotely two days per week with manager approval.",
      "Parental leave: eligible employees receive sixteen weeks of paid parental leave after one year of service.",
    ],
  },
  {
    docId: "travel-policy",
    owner: ALICE,
    pages: [
      "Travel policy: meals are reimbursed up to forty dollars per day on business travel.",
      "Taxi rides are reimbursed when public transport is unavailable. Annual travel budgets are approved by finance.",
    ],
  },
  {
    docId: "bob-handbook",
    owner: BOB,
    pages: ["Bob's handbook: employees receive thirty paid annual leave days each year and unlimited remote work."],
  },
];

const fixtureFile = path.join(tempRoot, "fixture.pdf");
writeFileSync(fixtureFile, "fixture", "utf8");

const ingestFixtures = async () => {
  for (const document of DOCUMENTS) {
    await ragIndex.ingestDocumentPages({
      docId: document.docId,
      fileName: `${document.docId}.pdf`,
      filePath: fixtureFile,
      ownerUserId: document.owner.userId,
      pages: document.pages.map((text, index) => ({ pageNumber: index + 1, text })),
      workspaceId: document.owner.workspaceId,
    });
  }
};

// ---------------------------------------------------------------------------
// LLMOps events and captures
// ---------------------------------------------------------------------------

const clearTraceEvents = () => writeFileSync(process.env.RAG_OBSERVABILITY_EVENTS_PATH, "", "utf8");

// Timestamps and durations differ per run by design; everything else must not.
const maskTiming = ({ latencyMs, timestamp, ...rest }) => rest;

const readLlmOpsEvents = () => {
  let text = "";

  try {
    text = readFileSync(process.env.RAG_OBSERVABILITY_EVENTS_PATH, "utf8");
  } catch {
    return [];
  }

  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.traceType === LLMOPS_TRACE_TYPE)
    .map(maskTiming);
};

// One side of an equivalence check: what it returned, what the stand-in was
// handed, and the LLMOps events it recorded, from a cold embedding cache
// unless `warm` (the cache-hit checks).
const capture = async (action, { warm = false } = {}) => {
  if (!warm) {
    resetEmbeddingCache();
  }

  clearTraceEvents();
  standInCalls = [];

  const value = await action();

  return { llmOps: readLlmOpsEvents(), modelCalls: standInCalls, value };
};

// ---------------------------------------------------------------------------
// A retrieval tier replica on an OS-assigned port, in this process (the
// retrieval-service suite's set-up). It counts requests per path so a test can
// prove the remote path really ran.
// ---------------------------------------------------------------------------

const startServer = async (app) => {
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
    url: `http://127.0.0.1:${server.address().port}`,
  };
};

let replica = null;

const startRetrievalReplica = async () => {
  const hits = {};
  const outer = express();

  outer.use((req, res, next) => {
    hits[req.path] = (hits[req.path] ?? 0) + 1;
    next();
  });
  outer.use(createRetrievalApp({ logger: { error() {}, log() {}, warn() {} } }));

  return { ...(await startServer(outer)), hits };
};

const useRemote = () => {
  process.env.RETRIEVAL_SERVICE_URL = replica.url;
  resetServiceClients();
};

const useInProcess = () => {
  delete process.env.RETRIEVAL_SERVICE_URL;
  resetServiceClients();
};

const countReplicaHits = () => Object.values(replica.hits).reduce((total, count) => total + count, 0);

before(async () => {
  await resetDocumentRegistryStore();
  await resetDocumentRegistry();
  configureDocumentRegistryStore(createFileDocumentRegistryStore());
  resetVectorStore();
  useStandInModels();
  await ingestFixtures();
  replica = await startRetrievalReplica();
});

afterEach(() => {
  useInProcess();
  resetEmbeddingCache();
  standInCalls = [];
});

after(async () => {
  await replica?.close();
  resetOpenAIProvider();
  resetVectorStore();
  await resetDocumentRegistryStore();
  restoreEnvironment(savedEnvironment);
  rmSync(tempRoot, { force: true, recursive: true });
});

// The dispatcher's arguments for one query, as the retriever builds them and
// as the retrieval tier calls the in-process seam: the primary requirement and
// no precomputed vector.
const oneQueryArgs = ({ accessScope = null, docIds, query, retrievalOptions = {} }) => ({
  accessScope,
  docIds,
  primaryQueryText: null,
  primaryQueryVector: null,
  retrievalOptions,
  retrievalQueries: buildRetrievalQueries({ query, requirements: [] }),
});

const assertRetrieverError = (code) => (error) => {
  assert.equal(error.code, code);
  return true;
};

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

test("the embeddings adapter neutralises LangChain's AsyncCaller and never calls through it", async () => {
  const embeddings = new ArchiveRagEmbeddings();

  assert.equal(embeddings.caller.maxRetries, 0);
  assert.equal(embeddings.caller.maxConcurrency, Infinity);
  assert.equal(embeddings.space, null);

  const trap = () => {
    throw new Error("LangChain's AsyncCaller was used");
  };

  embeddings.caller.call = trap;
  embeddings.caller.callWithOptions = trap;
  embeddings.caller.fetch = trap;

  assert.equal((await embeddings.embedQuery("annual leave days")).length, DIMENSIONS);
  assert.equal((await embeddings.embedDocuments(["one chunk", "another chunk"])).length, 2);

  for (const space of [[], "space", 7]) {
    assert.throws(
      () => new ArchiveRagEmbeddings({ space }),
      (error) => error.code === "LANGGRAPH_EMBEDDINGS_SPACE_INVALID"
    );
  }
});

test("on a stand-in provider the embeddings adapter hands it exactly what embedQueryCached and embedTexts do", async () => {
  const query = "How many paid annual leave days do employees get?";
  const texts = ["Annual leave is ten days.", "Remote work is two days a week."];
  const configured = getConfiguredEmbeddingSpace();
  const pinned = buildEmbeddingSpace({
    dimensions: DIMENSIONS,
    documentPrefix: "passage: ",
    model: "pinned-embedding-model",
    queryPrefix: "query: ",
  });

  for (const space of [null, pinned]) {
    const embeddings = new ArchiveRagEmbeddings({ space });
    const toObserved = (side) => ({
      ...side,
      space: getQueryVectorEmbeddingSpace(side.value),
      modelSpace: getModelQueryVectorSpace(side.value),
    });
    const direct = toObserved(await capture(() => embedQueryCached(query, { space })));
    const adapted = toObserved(await capture(() => embeddings.embedQuery(query)));

    assert.deepStrictEqual(adapted, direct);
    assert.equal(direct.modelCalls.length, 1);
    assert.equal(direct.llmOps.length, 1);
    assert.deepStrictEqual(adapted.space, space ?? configured, "the vector is tagged with the space it was embedded in");
    assert.deepStrictEqual(
      adapted.modelCalls[0].args,
      space ? [query, { embeddingSpace: { ...pick(pinned) } }] : [query],
      "a pinned space reaches the stand-in as its second argument"
    );

    // The second call is a cache hit on both paths: the same object, no model
    // call, no event.
    const first = adapted.value;
    const hit = await capture(() => embeddings.embedQuery(query), { warm: true });
    const directHit = await capture(() => embedQueryCached(query, { space }), { warm: true });

    assert.equal(hit.value, first);
    assert.equal(directHit.value, first, "the adapter and the direct call share one cache");
    assert.deepStrictEqual(hit.modelCalls, []);
    assert.deepStrictEqual(hit.llmOps, []);
    assert.deepStrictEqual(directHit.modelCalls, []);
    assert.equal(getQueryVectorEmbeddingSpace(hit.value), adapted.space);

    const directDocuments = await capture(() => (space ? embedDocumentsInSpace(texts, space) : embedTexts(texts)));
    const adaptedDocuments = await capture(() => embeddings.embedDocuments(texts));

    assert.deepStrictEqual(adaptedDocuments, directDocuments);
    assert.equal(directDocuments.value.length, texts.length);
    assert.deepStrictEqual(
      adaptedDocuments.modelCalls[0].args,
      space ? [texts, { embeddingSpace: { ...pick(pinned) } }] : [texts]
    );
  }
});

// The embedding-space request openai.js receives for a pinned space
// (embedding-cache.js / vector-store-pgvector.js toEmbeddingSpaceRequest).
function pick(space) {
  return {
    dimensions: space.dimensions,
    documentPrefix: space.documentPrefix,
    identity: space.identity,
    model: space.model,
    queryPrefix: space.queryPrefix,
  };
}

// The real OpenAI-compatible client with fetch stubbed, so the request bodies
// are the ones a model would receive: nomic-embed-text's documented task
// prefixes apply, the vectors are marked as the model's own, and openai.js's
// retry/guard/metering path runs for real.
const withRealEmbeddingClient = async (action) => {
  const keys = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_EMBEDDING_MODEL",
    "RAG_EMBEDDING_DIMENSIONS",
    "RAG_EMBEDDING_DOCUMENT_PREFIX",
    "RAG_EMBEDDING_QUERY_PREFIX",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests = [];
  const vectorFor = (input) => {
    const vector = [0, 0, 0, 0];

    [...String(input)].forEach((character, index) => {
      vector[index % 4] += character.codePointAt(0) / 1000;
    });
    return vector;
  };

  try {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "http://embeddings.test/v1";
    process.env.OPENAI_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.RAG_EMBEDDING_DIMENSIONS = "4";
    delete process.env.RAG_EMBEDDING_DOCUMENT_PREFIX;
    delete process.env.RAG_EMBEDDING_QUERY_PREFIX;
    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];

      requests.push({ body, method: options.method, url: String(url) });
      return {
        headers: new Headers(),
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: inputs.map((input, index) => ({ embedding: vectorFor(input), index })),
            usage: { prompt_tokens: inputs.length * 5, total_tokens: inputs.length * 5 },
          }),
      };
    };
    resetOpenAIProvider();
    resetEmbeddingCache();

    return await action(requests);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(saved);
    useStandInModels();
    resetEmbeddingCache();
  }
};

test("on the real client the embeddings adapter sends the same requests and records the same LLMOps events", async () => {
  await withRealEmbeddingClient(async (requests) => {
    const query = "which datasets are used?";
    const texts = ["We use SQuAD.", "Results follow."];
    const pinned = buildEmbeddingSpace({
      dimensions: 4,
      documentPrefix: "passage: ",
      model: "pinned-embedding-model",
      queryPrefix: "query: ",
    });
    const sideWithRequests = async (action, options) => {
      requests.length = 0;
      const side = await capture(action, options);

      return {
        ...side,
        modelSpace: getModelQueryVectorSpace(side.value),
        requests: [...requests],
        space: getQueryVectorEmbeddingSpace(side.value),
      };
    };

    for (const space of [null, pinned]) {
      const embeddings = new ArchiveRagEmbeddings({ space });
      const direct = await sideWithRequests(() => embedQueryCached(query, { space }));
      const adapted = await sideWithRequests(() => embeddings.embedQuery(query));

      assert.deepStrictEqual(adapted, direct);
      assert.equal(direct.requests.length, 1);
      assert.equal(direct.llmOps.length, 1);
      assert.equal(direct.requests[0].body.input, space ? `query: ${query}` : `search_query: ${query}`);
      assert.equal(direct.requests[0].body.model, space ? "pinned-embedding-model" : "nomic-embed-text");
      assert.ok(adapted.modelSpace, "the vector is marked as the model's own, so the query adapter may apply");
      assert.deepStrictEqual(adapted.space, space ?? getConfiguredEmbeddingSpace());

      const hit = await sideWithRequests(() => embeddings.embedQuery(query), { warm: true });

      assert.equal(hit.value, adapted.value, "a cache hit returns the cached object itself");
      assert.deepStrictEqual(hit.requests, []);
      assert.deepStrictEqual(hit.llmOps, []);
      assert.equal(await embedQueryCached(query, { space }), adapted.value, "one cache for both paths");

      const directDocuments = await sideWithRequests(() =>
        space ? embedDocumentsInSpace(texts, space) : embedTexts(texts)
      );
      const adaptedDocuments = await sideWithRequests(() => embeddings.embedDocuments(texts));

      assert.deepStrictEqual(adaptedDocuments, directDocuments);
      assert.deepEqual(
        directDocuments.requests[0].body.input,
        texts.map((text) => (space ? `passage: ${text}` : `search_document: ${text}`))
      );
      assert.equal(directDocuments.llmOps.length, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

const GLOBAL_QUERY = "How many paid annual leave days do employees get?";

test("global retriever: invoke then toRetrievalResults equals the dispatcher, provenance and key order included", async () => {
  const docIds = ["leave-policy", "travel-policy"];
  const retrievalOptions = { topK: 3 };
  const retriever = new ArchiveRagRetriever({ accessScope: ALICE, docIds, retrievalOptions });
  const direct = await capture(() =>
    retrieveGlobalContextForQueries({
      ...oneQueryArgs({ accessScope: ALICE, docIds, query: GLOBAL_QUERY, retrievalOptions }),
      queryAdapterScope: null,
    })
  );
  const adapted = await capture(() => retriever.invoke(GLOBAL_QUERY));
  const restored = toRetrievalResults(adapted.value);

  assert.ok(direct.value.results.length > 0);
  assert.deepStrictEqual(restored, direct.value.results);
  assert.equal(JSON.stringify(restored), JSON.stringify(direct.value.results), "serialized byte for byte");
  assert.deepStrictEqual(adapted.modelCalls, direct.modelCalls);
  assert.deepStrictEqual(adapted.llmOps, direct.llmOps);
  assert.equal(direct.modelCalls.length, 1, "one query embedding");
  assert.equal(direct.llmOps.length, 1, "metered once");
  assert.ok(direct.value.results.every((result) => result.provenance?.queries?.[0]?.queryId === "primary"));

  adapted.value.forEach((document, index) => {
    const result = direct.value.results[index];

    assert.ok(document instanceof Document);
    assert.equal(document.pageContent, result.document.pageContent);
    assert.equal(document.id, result.document.id);
    assert.equal(document.metadata.docId, result.document.metadata.docId);
    assert.equal(document.metadata.fileName, result.document.metadata.fileName);
    assert.equal(document.metadata.pageNumber, result.document.metadata.pageNumber);
    // The text is stored once: in pageContent, not again in metadata.
    assert.equal(JSON.stringify(document.metadata).includes(result.document.pageContent), false);
  });

  // The single-document QA route's own retrieval (executeDocumentRag up to its
  // gate) for the same question: a precomputed primary vector, the QA adapter
  // scope and no options. The retriever built that way returns the same.
  const qaRetriever = new ArchiveRagRetriever({
    accessScope: ALICE,
    docIds: ["leave-policy"],
    queryAdapterScope: QUERY_ADAPTER_SCOPE_QA,
  });
  const qaRoute = await capture(() =>
    retrieveQaCandidates({ accessScope: ALICE, docIds: ["leave-policy"], resolvedQuery: GLOBAL_QUERY })
  );
  const qaAdapted = await capture(() => qaRetriever.invoke(GLOBAL_QUERY));

  assert.ok(qaRoute.value.results.length > 0);
  assert.deepStrictEqual(toRetrievalResults(qaAdapted.value), qaRoute.value.results);
  assert.deepStrictEqual(qaAdapted.modelCalls, qaRoute.modelCalls);
  assert.deepStrictEqual(qaAdapted.llmOps, qaRoute.llmOps);
});

test("per_document retriever: documents map back to the seam's flat results and to its resultsByDocument Map", async () => {
  const query = "What is approved by a manager?";
  const docIds = ["travel-policy", "leave-policy", "no-such-document"];
  const retrievalOptions = { topKPerDoc: 2 };
  const retriever = new ArchiveRagRetriever({
    accessScope: ALICE,
    docIds,
    mode: ARCHIVE_RAG_RETRIEVER_MODES.perDocument,
    retrievalOptions,
  });
  const direct = await capture(() =>
    retrievePerDocumentContextForQueries(oneQueryArgs({ accessScope: ALICE, docIds, query, retrievalOptions }))
  );
  const adapted = await capture(() => retriever.invoke(query));
  const { resultsByDocument } = direct.value;

  assert.deepEqual([...resultsByDocument.keys()], docIds);
  assert.ok(resultsByDocument.get("travel-policy").length > 0);
  assert.ok(resultsByDocument.get("leave-policy").length > 0);
  assert.deepEqual(resultsByDocument.get("no-such-document"), []);
  assert.deepStrictEqual(toRetrievalResults(adapted.value), [...resultsByDocument.values()].flat());
  assert.deepStrictEqual(toPerDocumentRetrievalResults(adapted.value, docIds), resultsByDocument);
  assert.deepStrictEqual(adapted.modelCalls, direct.modelCalls);
  assert.deepStrictEqual(adapted.llmOps, direct.llmOps);
  assert.deepStrictEqual(toPerDocumentRetrieverDocuments(resultsByDocument), adapted.value);
});

test("through the retrieval tier the retriever equals the remote dispatcher and the in-process run", async () => {
  const cases = [
    {
      docIds: ["leave-policy", "travel-policy"],
      mode: ARCHIVE_RAG_RETRIEVER_MODES.global,
      query: GLOBAL_QUERY,
      retrievalOptions: { topK: 3 },
    },
    {
      docIds: ["travel-policy", "leave-policy"],
      mode: ARCHIVE_RAG_RETRIEVER_MODES.perDocument,
      query: "What is approved by a manager?",
      retrievalOptions: { topKPerDoc: 2 },
    },
  ];

  for (const { docIds, mode, query, retrievalOptions } of cases) {
    const args = oneQueryArgs({ accessScope: ALICE, docIds, query, retrievalOptions });
    const callDispatcher = () =>
      mode === ARCHIVE_RAG_RETRIEVER_MODES.global
        ? retrieveGlobalContextForQueries({ ...args, queryAdapterScope: null })
        : retrievePerDocumentContextForQueries(args);
    const flatten = (value) =>
      mode === ARCHIVE_RAG_RETRIEVER_MODES.global ? value.results : [...value.resultsByDocument.values()].flat();
    const retriever = new ArchiveRagRetriever({ accessScope: ALICE, docIds, mode, retrievalOptions });

    const inProcess = await capture(() => retriever.invoke(query));

    useRemote();
    const hitsBefore = countReplicaHits();
    const direct = await capture(callDispatcher);
    const hitsAfterDirect = countReplicaHits();
    const adapted = await capture(() => retriever.invoke(query));

    assert.ok(hitsAfterDirect > hitsBefore, `${mode}: the dispatcher called the retrieval tier`);
    assert.ok(countReplicaHits() > hitsAfterDirect, `${mode}: the retriever called the retrieval tier`);
    assert.deepStrictEqual(toRetrievalResults(adapted.value), flatten(direct.value), mode);
    assert.deepStrictEqual(adapted.modelCalls, direct.modelCalls, mode);
    assert.deepStrictEqual(adapted.llmOps, direct.llmOps, mode);
    assert.equal(direct.llmOps.length, 1, `${mode}: the tier's query embedding was metered`);
    assert.deepStrictEqual(adapted.value, inProcess.value, `${mode}: remote and in process agree`);

    if (mode === ARCHIVE_RAG_RETRIEVER_MODES.perDocument) {
      assert.deepStrictEqual(toPerDocumentRetrievalResults(adapted.value, docIds), direct.value.resultsByDocument);
    }

    useInProcess();
  }

  assert.ok(replica.hits[RETRIEVAL_SERVICE_PATHS.global] > 0);
  assert.ok(replica.hits[RETRIEVAL_SERVICE_PATHS.perDocument] > 0);
});

test("the tenant and the documents are the runtime's: the scope reaches the tier and a query cannot widen either", async () => {
  const query = "Bob's handbook bob-handbook thirty paid annual leave days unlimited remote work";

  // In process the local index has no row-level security; the docIds the
  // runtime chose are the boundary, and naming another document in the query
  // does not reach it.
  const inProcess = await new ArchiveRagRetriever({ accessScope: ALICE, docIds: ["leave-policy"] }).invoke(query);

  assert.ok(inProcess.length > 0);
  assert.ok(inProcess.every((document) => document.metadata.docId === "leave-policy"));

  // Through the tier the signed scope is the constructor's: Bob's document
  // answers Alice like a missing one, and Bob himself.
  useRemote();
  const asAlice = (docIds) => new ArchiveRagRetriever({ accessScope: ALICE, docIds }).invoke(query);
  const withForeign = await asAlice(["leave-policy", "bob-handbook"]);

  assert.ok(withForeign.length > 0);
  assert.ok(withForeign.every((document) => document.metadata.docId === "leave-policy"));
  assert.deepStrictEqual(
    toRetrievalResults(withForeign),
    (
      await retrieveGlobalContextForQueries({
        ...oneQueryArgs({ accessScope: ALICE, docIds: ["leave-policy", "bob-handbook"], query }),
        queryAdapterScope: null,
      })
    ).results
  );
  assert.deepStrictEqual(await asAlice(["bob-handbook"]), []);

  const asBob = await new ArchiveRagRetriever({ accessScope: BOB, docIds: ["bob-handbook"] }).invoke(query);

  assert.ok(asBob.length > 0);
  assert.ok(asBob.every((document) => document.metadata.docId === "bob-handbook"));

  // The request's database tenant (AsyncLocalStorage) is still visible inside
  // LangChain's invoke: a retriever scope that disagrees with it is refused
  // exactly like the direct call.
  const mismatch = (error) => error.code === RETRIEVAL_SERVICE_ERROR_CODES.scopeMismatch;

  await assert.rejects(
    runWithDatabaseTenant(BOB, () =>
      new ArchiveRagRetriever({ accessScope: ALICE, docIds: ["leave-policy"] }).invoke(query)
    ),
    mismatch
  );
  await assert.rejects(
    runWithDatabaseTenant(BOB, () =>
      retrieveGlobalContextForQueries({
        ...oneQueryArgs({ accessScope: ALICE, docIds: ["leave-policy"], query }),
        queryAdapterScope: null,
      })
    ),
    mismatch
  );
});

test("the retriever's serialized form and its callbacks never carry the scope or the document ids", async () => {
  const retriever = new ArchiveRagRetriever({ accessScope: ALICE, docIds: ["leave-policy"] });
  const serialized = JSON.stringify(retriever.toJSON());

  assert.deepStrictEqual(retriever.lc_kwargs, {});
  assert.equal(retriever.lc_serializable, false);

  for (const secret of ["alice", "ws-a", "leave-policy"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const starts = [];

  await retriever.invoke(GLOBAL_QUERY, {
    callbacks: [{ handleRetrieverStart: (serializedRetriever) => starts.push(serializedRetriever) }],
  });
  await awaitAllCallbacks();
  assert.equal(starts.length, 1);
  assert.equal(JSON.stringify(starts[0]).includes("alice"), false);
  assert.equal(JSON.stringify(starts[0]).includes("leave-policy"), false);
});

test("the retriever refuses runtime-owned inputs it cannot honour, and messages carry no query text", async () => {
  const refuses = (fields, code) =>
    assert.throws(() => new ArchiveRagRetriever(fields), assertRetrieverError(code));

  refuses({}, LANGGRAPH_RETRIEVER_ERROR_CODES.docIdsInvalid);
  refuses({ docIds: [] }, LANGGRAPH_RETRIEVER_ERROR_CODES.docIdsInvalid);
  refuses({ docIds: ["leave-policy", " "] }, LANGGRAPH_RETRIEVER_ERROR_CODES.docIdsInvalid);
  refuses({ docIds: "leave-policy" }, LANGGRAPH_RETRIEVER_ERROR_CODES.docIdsInvalid);
  refuses({ docIds: ["leave-policy"], mode: "hybrid" }, LANGGRAPH_RETRIEVER_ERROR_CODES.modeInvalid);
  refuses(
    { docIds: ["leave-policy"], mode: ARCHIVE_RAG_RETRIEVER_MODES.perDocument, queryAdapterScope: QUERY_ADAPTER_SCOPE_QA },
    LANGGRAPH_RETRIEVER_ERROR_CODES.queryAdapterScopeInvalid
  );

  // The docIds are a copy: changing the caller's array afterwards changes nothing.
  const docIds = ["leave-policy"];
  const retriever = new ArchiveRagRetriever({ docIds });

  docIds.push("bob-handbook");
  assert.deepEqual(retriever.docIds, ["leave-policy"]);
  assert.ok(Object.isFrozen(retriever.docIds));

  standInCalls = [];
  await assert.rejects(retriever.invoke({ question: "secret question text" }), (error) => {
    assert.equal(error.code, LANGGRAPH_RETRIEVER_ERROR_CODES.queryInvalid);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.deepStrictEqual(standInCalls, [], "refused before any embedding");

  assert.throws(
    () => toRetrievalResults([new Document({ metadata: { docId: "leave-policy" }, pageContent: "a chunk" })]),
    assertRetrieverError(LANGGRAPH_RETRIEVER_ERROR_CODES.documentInvalid)
  );
  assert.throws(
    () => toPerDocumentRetrievalResults(toPerDocumentRetrieverDocuments(new Map([["leave-policy", [{}]]])), ["other"]),
    assertRetrieverError(LANGGRAPH_RETRIEVER_ERROR_CODES.documentInvalid)
  );
});

test("results the store would never emit still round-trip exactly", () => {
  const results = [
    // A chunk whose metadata uses the record key itself: the record wins the
    // top-level slot, the original metadata survives inside it.
    {
      document: { id: "c1", metadata: { [RETRIEVAL_RESULT_METADATA_KEY]: "theirs", docId: "d" }, pageContent: "text" },
      score: 1,
    },
    // No text, a non-string text, no chunk at all, undefined and special values.
    { document: { id: "c2", metadata: null }, score: Number.NaN },
    { document: { id: 3, metadata: {}, pageContent: 42 }, missing: undefined, score: -0 },
    { score: Number.POSITIVE_INFINITY },
    null,
  ];
  const documents = toRetrieverDocuments(results);

  assert.deepStrictEqual(toRetrievalResults(documents), results);
  assert.equal(documents[0].pageContent, "text");
  assert.equal(documents[0].metadata.docId, "d");
  assert.equal(documents[2].pageContent, "", "a non-string text stays in the record, not in pageContent");
  assert.equal(documents[2].id, undefined);
  assert.equal(Object.is(toRetrievalResults(documents)[2].score, -0), true);
});

// ---------------------------------------------------------------------------
// LangSmith
// ---------------------------------------------------------------------------

test("LangSmith tracing switched on is refused by both adapters before any embedding or retrieval runs", async () => {
  const embeddings = new ArchiveRagEmbeddings();
  const retriever = new ArchiveRagRetriever({ accessScope: ALICE, docIds: ["leave-policy"] });
  const perDocument = new ArchiveRagRetriever({ docIds: ["leave-policy"], mode: ARCHIVE_RAG_RETRIEVER_MODES.perDocument });
  const refused = (error) => error.code === LANGSMITH_TRACING_ENABLED_CODE;
  const saved = Object.fromEntries(LANGSMITH_TRACING_VARIABLES.map((name) => [name, process.env[name]]));

  try {
    for (const name of LANGSMITH_TRACING_VARIABLES) {
      process.env[name] = "true";
      standInCalls = [];
      clearTraceEvents();

      const starts = [];
      const callbacks = [{ handleRetrieverStart: () => starts.push(name) }];

      assert.throws(() => new ArchiveRagEmbeddings(), refused, name);
      assert.throws(() => new ArchiveRagRetriever({ docIds: ["leave-policy"] }), refused, name);
      await assert.rejects(embeddings.embedQuery(GLOBAL_QUERY), refused, name);
      await assert.rejects(embeddings.embedDocuments(["a chunk"]), refused, name);
      await assert.rejects(retriever.invoke(GLOBAL_QUERY, { callbacks }), refused, name);
      await assert.rejects(retriever.batch([GLOBAL_QUERY]), refused, name);
      await assert.rejects(perDocument.invoke(GLOBAL_QUERY), refused, name);
      await assert.rejects(retriever._getRelevantDocuments(GLOBAL_QUERY), refused, name);
      await awaitAllCallbacks();

      assert.deepStrictEqual(starts, [], `${name}: LangChain's callback machinery never started`);
      assert.deepStrictEqual(standInCalls, [], `${name}: no model call`);
      assert.deepStrictEqual(readLlmOpsEvents(), [], `${name}: no LLMOps event`);
      delete process.env[name];
    }
  } finally {
    restoreEnvironment(saved);
  }

  // Switched off again, the same instances work.
  assert.ok((await retriever.invoke(GLOBAL_QUERY)).length > 0);
  assert.equal((await embeddings.embedQuery(GLOBAL_QUERY)).length, DIMENSIONS);
});

// ---------------------------------------------------------------------------
// Query adapter (last: it adds a 3-dimension document to the shared index)
// ---------------------------------------------------------------------------

test("the QA adapter scope reaches the seam in process and remotely; without it the search stays unadapted", async () => {
  const SPACE = { dimensions: 3, documentPrefix: "", model: "adapter-parity-model", queryPrefix: "" };
  const adapterPath = path.join(tempRoot, "adapter.json");
  const vectors = { "alpha paragraph": [1, 0, 0], "beta paragraph": [0, 1, 0], question: [1, 0, 0] };
  const saved = Object.fromEntries(
    ["OPENAI_EMBEDDING_MODEL", "RAG_EMBEDDING_DIMENSIONS", "RAG_EMBEDDING_QUERY_ADAPTER"].map((key) => [
      key,
      process.env[key],
    ])
  );

  try {
    writeFileSync(
      adapterPath,
      JSON.stringify(serializeQueryAdapter({ embedding: SPACE, matrix: [0, 0, 1, 1, 0, 0, 0, 1, 0] }))
    );
    process.env.OPENAI_EMBEDDING_MODEL = SPACE.model;
    process.env.RAG_EMBEDDING_DIMENSIONS = String(SPACE.dimensions);
    process.env.RAG_EMBEDDING_QUERY_ADAPTER = adapterPath;
    configureOpenAIProvider({
      allowQueryAdapter: true,
      completeText: async () => "unused",
      embedQuery: async (query) => [...(vectors[query] ?? [0, 0, 1])],
      embedTexts: async (texts) => texts.map((text) => [...(vectors[text] ?? [0, 0, 1])]),
    });

    await registerDocument({
      docId: "paper",
      fileBuffer: Buffer.from("paper"),
      fileName: "paper.pdf",
      ownerUserId: ALICE.userId,
      workspaceId: ALICE.workspaceId,
    });
    await addDocumentsToIndex({
      documents: ["alpha paragraph", "beta paragraph"].map((text, chunkIndex) => ({
        id: `paper:${chunkIndex}`,
        metadata: { chunkIndex, docId: "paper", fileName: "paper.pdf", pageNumber: chunkIndex + 1 },
        pageContent: text,
      })),
    });

    for (const remote of [false, true]) {
      if (remote) {
        useRemote();
      }

      for (const queryAdapterScope of [QUERY_ADAPTER_SCOPE_QA, null]) {
        const label = `${remote ? "remote" : "in process"}, scope ${queryAdapterScope}`;
        const direct = await capture(() =>
          retrieveGlobalContextForQueries({
            ...oneQueryArgs({ accessScope: ALICE, docIds: ["paper"], query: "question" }),
            queryAdapterScope,
          })
        );
        const adapted = await capture(() =>
          new ArchiveRagRetriever({ accessScope: ALICE, docIds: ["paper"], queryAdapterScope }).invoke("question")
        );
        const restored = toRetrievalResults(adapted.value);
        const stamp = direct.value.retrieval.routes.dense.queryAdapter;

        assert.deepStrictEqual(restored, direct.value.results, label);
        assert.deepStrictEqual(adapted.llmOps, direct.llmOps, label);

        if (queryAdapterScope) {
          assert.match(String(stamp), /^qa1-/, `${label}: the adapter ranked the search`);
          assert.equal(restored[0].document.pageContent, "beta paragraph", `${label}: W q ranked beta first`);
          assert.equal(restored[0].provenance.queryAdapter, stamp, label);
        } else {
          assert.equal(stamp, undefined, label);
          assert.equal(restored[0].document.pageContent, "alpha paragraph", `${label}: unadapted`);
          assert.equal(Object.hasOwn(restored[0].provenance, "queryAdapter"), false, label);
        }
      }
    }
  } finally {
    useInProcess();
    restoreEnvironment(saved);
    resetQueryAdapter();
    useStandInModels();
  }
});
