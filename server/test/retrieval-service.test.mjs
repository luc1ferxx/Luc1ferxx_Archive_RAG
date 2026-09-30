import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";

// The local index and the file registry load from the data directory when
// first imported; keep both in a temp dir before anything imports them.
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "retrieval-service-test-"));
process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");

const SECRET = "r".repeat(24) + "-retrieval-secret-0123456789";
const PINNED_ENVIRONMENT = {
  INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
  OPENAI_EMBEDDING_MODEL: "retrieval-service-test-model",
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
  "MODEL_GATEWAY_URL",
  "RAG_CROSS_ENCODER_ENDPOINT",
  "RAG_EMBEDDING_QUERY_ADAPTER",
  "RAG_RERANK_PROVIDER",
  "RAG_RETRIEVAL_ROUTE",
  "RETRIEVAL_SERVICE_MAX_DOC_IDS",
  "RETRIEVAL_SERVICE_MAX_QUERIES",
  "RETRIEVAL_SERVICE_MAX_QUERY_CHARS",
  "RETRIEVAL_SERVICE_MAX_TOP_K",
  "RETRIEVAL_SERVICE_TIMEOUT_MS",
  "RETRIEVAL_SERVICE_URL",
];
const savedEnvironment = Object.fromEntries(
  [...Object.keys(PINNED_ENVIRONMENT), ...CLEARED_ENVIRONMENT].map((key) => [key, process.env[key]])
);

Object.assign(process.env, PINNED_ENVIRONMENT);
CLEARED_ENVIRONMENT.forEach((key) => delete process.env[key]);

const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const { resetEmbeddingCache } = await import("../rag/embedding-cache.js");
const { buildTermSet } = await import("../rag/text-utils.js");
const { configureDocumentRegistryStore, registerDocument, resetDocumentRegistry, resetDocumentRegistryStore } =
  await import("../rag/doc-registry.js");
const { createFileDocumentRegistryStore } = await import("../rag/doc-registry-file.js");
const ragIndex = await import("../rag/index.js");
const chat = ragIndex.default;
const { addDocumentsToIndex, resetVectorStore } = await import("../rag/vector-store.js");
const {
  retrieveGlobalContextForQueriesInProcess,
  retrievePerDocumentContextForQueriesInProcess,
  retrieveQaCandidates,
  searchGlobalContextInProcess,
} = await import("../rag/document-rag-execution.js");
const { QUERY_ADAPTER_SCOPE_QA, resetQueryAdapter, serializeQueryAdapter } = await import("../rag/query-adapter.js");
const { describeServiceClients, resetServiceClients, ServiceTimeoutError, ServiceUnavailableError } =
  await import("../rag/service-client.js");
const { SERVICE_DEADLINE_HEADER, SERVICE_TOKEN_HEADER, signServiceToken } = await import("../rag/service-identity.js");
const { runWithDatabaseTenant } = await import("../rag/postgres-tenant.js");
const { createRunUsage, runWithRunUsage } = await import("../rag/run-usage.js");
const { buildRetrievalHealthReport, createRetrievalApp, maskInvisibleDocIds } = await import(
  "../rag/retrieval-service/app.js"
);
const {
  RETRIEVAL_SERVICE_ERROR_CODES,
  RETRIEVAL_SERVICE_PATHS,
  RetrievalServiceError,
  isRetrievalRemote,
  resolveRetrievalAccessScope,
  retrieveGlobalContextRemotely,
  retrievePerDocumentContextRemotely,
  searchGlobalContextRemotely,
} = await import("../rag/retrieval-service/remote-retrieval.js");
const { getServiceCallBudgetMs, runWithServiceCallDeadline } = await import("../rag/retrieval-service/call-deadline.js");
const { decodeWireValue, encodeWireValue } = await import("../rag/retrieval-service/wire.js");

const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-a" };
const BOB = { authenticated: true, userId: "bob", workspaceId: "ws-b" };

// ---------------------------------------------------------------------------
// Fixtures: a hashed bag-of-words embedder, a fixed answer model, and three
// documents -- two of Alice's and one of Bob's that shares her vocabulary.
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

const embedCalls = { query: 0, texts: 0 };
let slowQueries = new Map();
let failingQueries = new Map();

const useStandInModels = () =>
  configureOpenAIProvider({
    completeText: async () => "Employees receive ten paid annual leave days each year. [Source 1]",
    embedQuery: async (query) => {
      embedCalls.query += 1;

      if (slowQueries.has(query)) {
        await new Promise((resolve) => setTimeout(resolve, slowQueries.get(query)));
      }

      if (failingQueries.has(query)) {
        throw failingQueries.get(query)();
      }

      return embed(query);
    },
    embedTexts: async (texts) => {
      embedCalls.texts += 1;
      return texts.map(embed);
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
    pages: [
      "Bob's handbook: employees receive thirty paid annual leave days each year and unlimited remote work.",
    ],
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
// Retrieval tier replicas on OS-assigned ports. Each counts the requests per
// path so a test can prove the remote path really ran.
// ---------------------------------------------------------------------------

const startServer = async (app) => {
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
};

const startRetrievalReplica = async (options = {}) => {
  const hits = {};
  const outer = express();

  outer.use((req, res, next) => {
    hits[req.path] = (hits[req.path] ?? 0) + 1;
    next();
  });
  outer.use(createRetrievalApp({ logger: { error() {}, log() {}, warn() {} }, ...options }));

  return { ...(await startServer(outer)), hits };
};

let replica = null;

const useRemote = (urls) => {
  process.env.RETRIEVAL_SERVICE_URL = (Array.isArray(urls) ? urls : [urls]).join(",");
  resetServiceClients();
};

const useInProcess = () => {
  delete process.env.RETRIEVAL_SERVICE_URL;
  resetServiceClients();
};

// Same inputs, cold caches: the in-process run must not warm the remote one.
const runBothWays = async (run, { urls = replica.url } = {}) => {
  useInProcess();
  resetEmbeddingCache();
  const local = await run();

  useRemote(urls);
  resetEmbeddingCache();
  try {
    return { local, remote: await run() };
  } finally {
    useInProcess();
  }
};

const readTraceEvents = () => {
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
    .map((line) => JSON.parse(line));
};

const clearTraceEvents = () => writeFileSync(process.env.RAG_OBSERVABILITY_EVENTS_PATH, "", "utf8");

// A trace event without what differs per run by design.
const stableTraceEvent = ({ latencyMs, timestamp, traceId, ...rest }) => rest;

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
  slowQueries = new Map();
  failingQueries = new Map();
});

after(async () => {
  await replica?.close();
  resetOpenAIProvider();
  resetVectorStore();
  await resetDocumentRegistryStore();

  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  rmSync(tempRoot, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Wire codec
// ---------------------------------------------------------------------------

test("the wire codec keeps undefined properties, special numbers, Maps and $ keys exactly", () => {
  const value = {
    $: "data",
    list: [1, undefined, Number.NaN, -0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null],
    map: new Map([
      ["doc-1", [{ score: 0.5, sparseRank: null }]],
      ["doc-2", []],
    ]),
    nested: { missing: undefined, text: "a", when: new Date("2026-01-02T03:04:05.000Z") },
  };
  const roundTripped = decodeWireValue(JSON.parse(JSON.stringify(encodeWireValue(value))));

  assert.deepStrictEqual(roundTripped, value);
  assert.equal(Object.hasOwn(roundTripped.nested, "missing"), true);
  assert.equal(Object.is(roundTripped.list[3], -0), true);

  const proto = decodeWireValue(JSON.parse('{"__proto__": {"polluted": true}}'));

  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
  assert.equal({}.polluted, undefined);
  assert.throws(() => decodeWireValue({ $: "bogus" }), TypeError);
  assert.throws(() => encodeWireValue({ vector: new Float32Array(2) }), TypeError);
  assert.throws(() => encodeWireValue(() => 1), TypeError);
});

// ---------------------------------------------------------------------------
// Parity: the remote path hands the caller exactly what the in-process path
// hands it, for the whole chat() path and for each seam function.
// ---------------------------------------------------------------------------

test("chat() through the retrieval tier answers exactly like the in-process path (QA, comparison, abstention)", async () => {
  const questions = [
    { docIds: ["leave-policy"], expectAbstained: false, question: "How many paid annual leave days do employees get?" },
    { docIds: ["leave-policy", "travel-policy"], expectAbstained: true, question: "Compare the leave policy and the travel policy." },
    // Abstains with a gap plan whose supplemental searches run too.
    {
      docIds: ["leave-policy"],
      expectAbstained: true,
      question: "When does the relocation stipend take effect and who approves the pension plan?",
    },
  ];

  for (const { docIds, expectAbstained, question } of questions) {
    const before = { ...replica.hits };
    const run = async () => {
      clearTraceEvents();
      const response = await chat(docIds, question, { accessScope: ALICE, includeRetrievedContexts: true });

      const events = readTraceEvents().map(stableTraceEvent);

      // RAG trace events in order; model-call metrics as a multiset, since
      // concurrent sub-query embeddings finish in either order on both paths.
      return {
        modelCalls: events
          .filter((event) => event.traceType === "llmops")
          .map((event) => JSON.stringify(event))
          .sort(),
        ragEvents: events.filter((event) => event.routeMode),
        response,
      };
    };
    const { local, remote } = await runBothWays(run);

    assert.equal(local.response.abstained, expectAbstained, question);
    assert.deepStrictEqual(remote.response, local.response, question);
    assert.deepStrictEqual(remote.ragEvents, local.ragEvents, question);
    assert.equal(local.ragEvents.length, 1);
    assert.deepStrictEqual(remote.modelCalls, local.modelCalls, question);
    assert.ok(local.response.retrieval?.routes?.dense?.executed, "retrieval ran");

    const remoteCalls = Object.entries(replica.hits).reduce(
      (total, [pathName, count]) => total + count - (before[pathName] ?? 0),
      0
    );

    assert.ok(remoteCalls > 0, `the remote run called the retrieval tier (${question})`);
  }

  assert.ok(replica.hits[RETRIEVAL_SERVICE_PATHS.global] > 0);
  assert.ok(replica.hits[RETRIEVAL_SERVICE_PATHS.perDocument] > 0, "the comparison went per document");
  assert.ok(replica.hits[RETRIEVAL_SERVICE_PATHS.search] > 0, "the abstention's gap plan searched remotely");
});

test("each seam function returns deep-equal results remotely: multi-query plans, per document, one-query search", async () => {
  const retrievalQueries = [
    { id: "primary", label: "Primary", primary: true, query: "annual leave days" },
    { id: "aspect-approval", label: "Approval", primary: false, query: "manager approval for leave" },
    { id: "aspect-remote", label: "Remote", primary: false, query: "remote work days per week" },
  ];

  const global = await runBothWays(async () =>
    runWithDatabaseTenant(ALICE, () =>
      (process.env.RETRIEVAL_SERVICE_URL ? retrieveGlobalContextRemotely : retrieveGlobalContextForQueriesInProcess)({
        accessScope: ALICE,
        docIds: ["leave-policy", "travel-policy"],
        queryAdapterScope: null,
        retrievalOptions: { topK: 3 },
        retrievalQueries,
      })
    )
  );

  assert.ok(global.local.results.length > 0);
  assert.deepStrictEqual(global.remote, global.local);
  assert.ok(global.local.results.every((result) => Array.isArray(result.provenance?.queries)));

  const perDocument = await runBothWays(async () =>
    (process.env.RETRIEVAL_SERVICE_URL ? retrievePerDocumentContextRemotely : retrievePerDocumentContextForQueriesInProcess)({
      accessScope: ALICE,
      docIds: ["travel-policy", "leave-policy"],
      retrievalOptions: { topKPerDoc: 2 },
      retrievalQueries,
    })
  );

  assert.ok(perDocument.remote.resultsByDocument instanceof Map);
  assert.deepEqual([...perDocument.remote.resultsByDocument.keys()], ["travel-policy", "leave-policy"]);
  assert.deepStrictEqual(perDocument.remote, perDocument.local);

  const search = await runBothWays(async () =>
    process.env.RETRIEVAL_SERVICE_URL
      ? searchGlobalContextRemotely({ accessScope: ALICE, docIds: ["leave-policy"], queryText: "parental leave weeks" })
      : searchGlobalContextInProcess({ docIds: ["leave-policy"], queryText: "parental leave weeks" })
  );

  assert.ok(search.local.results.length > 0);
  assert.deepStrictEqual(search.remote, search.local);

  // The evaluation entry point too.
  const candidates = await runBothWays(() =>
    retrieveQaCandidates({ accessScope: ALICE, docIds: ["leave-policy"], resolvedQuery: "How much parental leave is paid?" })
  );

  assert.deepStrictEqual(candidates.remote, candidates.local);
});

test("reranker scores cross the wire unchanged: heuristic rerankScore and cross-encoder crossEncoderScore", async (t) => {
  const crossEncoder = await startServer(
    express()
      .use(express.json())
      .post("/rerank", (req, res) => {
        // A deterministic logit per text: longer texts that share more words
        // with the query score higher.
        const queryTerms = buildTermSet(req.body.query);
        const scores = req.body.texts.map(
          (text) => [...buildTermSet(text)].filter((term) => queryTerms.has(term)).length - text.length / 1000
        );

        res.json({ scores });
      })
  );

  t.after(async () => {
    delete process.env.RAG_RERANK_ENABLED;
    process.env.RAG_RERANK_ENABLED = "false";
    delete process.env.RAG_RERANK_PROVIDER;
    delete process.env.RAG_CROSS_ENCODER_ENDPOINT;
    await crossEncoder.close();
  });

  process.env.RAG_RERANK_ENABLED = "true";

  const run = () =>
    chat(["leave-policy", "travel-policy"], "How many paid annual leave days do employees get?", {
      accessScope: ALICE,
      includeRetrievedContexts: true,
    });
  const heuristic = await runBothWays(run);

  assert.deepStrictEqual(heuristic.remote, heuristic.local);

  const heuristicCandidates = await runBothWays(() =>
    retrieveQaCandidates({ accessScope: ALICE, docIds: ["leave-policy"], resolvedQuery: "annual leave days" })
  );

  assert.ok(heuristicCandidates.local.results.some((result) => Number.isFinite(result.rerankScore)));
  assert.deepStrictEqual(heuristicCandidates.remote, heuristicCandidates.local);

  process.env.RAG_RERANK_PROVIDER = "cross-encoder";
  process.env.RAG_CROSS_ENCODER_ENDPOINT = `${crossEncoder.url}/rerank`;

  const crossEncoded = await runBothWays(() =>
    retrieveQaCandidates({ accessScope: ALICE, docIds: ["leave-policy"], resolvedQuery: "annual leave days" })
  );

  assert.ok(crossEncoded.local.results.length > 0);
  assert.ok(crossEncoded.local.results.every((result) => Number.isFinite(result.crossEncoderScore)));
  assert.deepStrictEqual(crossEncoded.remote, crossEncoded.local);

  const chatWithCrossEncoder = await runBothWays(run);

  assert.deepStrictEqual(chatWithCrossEncoder.remote, chatWithCrossEncoder.local);
});

test("the query adapter applies on the retrieval tier exactly as in process and its stamp comes back", async (t) => {
  const SPACE = { dimensions: 3, documentPrefix: "", model: "adapter-parity-model", queryPrefix: "" };
  const adapterPath = path.join(tempRoot, "adapter.json");
  const vectors = { "alpha paragraph": [1, 0, 0], "beta paragraph": [0, 1, 0], question: [1, 0, 0] };

  writeFileSync(
    adapterPath,
    JSON.stringify(serializeQueryAdapter({ embedding: SPACE, matrix: [0, 0, 1, 1, 0, 0, 0, 1, 0] }))
  );
  process.env.OPENAI_EMBEDDING_MODEL = SPACE.model;
  process.env.RAG_EMBEDDING_DIMENSIONS = String(SPACE.dimensions);
  process.env.RAG_EMBEDDING_QUERY_ADAPTER = adapterPath;
  configureOpenAIProvider({
    allowQueryAdapter: true,
    completeText: async () => "The answer is in the evidence [Source 1].",
    embedQuery: async (query) => [...(vectors[query] ?? [0, 0, 1])],
    embedTexts: async (texts) => texts.map((text) => [...(vectors[text] ?? [0, 0, 1])]),
  });
  t.after(() => {
    process.env.OPENAI_EMBEDDING_MODEL = PINNED_ENVIRONMENT.OPENAI_EMBEDDING_MODEL;
    process.env.RAG_EMBEDDING_DIMENSIONS = PINNED_ENVIRONMENT.RAG_EMBEDDING_DIMENSIONS;
    delete process.env.RAG_EMBEDDING_QUERY_ADAPTER;
    resetQueryAdapter();
    useStandInModels();
  });

  await registerDocument({ docId: "paper", fileBuffer: Buffer.from("paper"), fileName: "paper.pdf", ownerUserId: "alice", workspaceId: "ws-a" });
  await addDocumentsToIndex({
    documents: ["alpha paragraph", "beta paragraph"].map((text, chunkIndex) => ({
      id: `paper:${chunkIndex}`,
      metadata: { chunkIndex, docId: "paper", fileName: "paper.pdf", pageNumber: chunkIndex + 1 },
      pageContent: text,
    })),
  });

  const run = () =>
    process.env.RETRIEVAL_SERVICE_URL
      ? retrieveGlobalContextRemotely({
          accessScope: ALICE,
          docIds: ["paper"],
          queryAdapterScope: QUERY_ADAPTER_SCOPE_QA,
          retrievalQueries: [{ id: "primary", primary: true, query: "question" }],
        })
      : retrieveGlobalContextForQueriesInProcess({
          docIds: ["paper"],
          queryAdapterScope: QUERY_ADAPTER_SCOPE_QA,
          retrievalQueries: [{ id: "primary", primary: true, query: "question" }],
        });
  const { local, remote } = await runBothWays(run);
  const stamp = local.retrieval.routes.dense.queryAdapter;

  assert.match(String(stamp), /^qa1-/, "the adapter ranked the in-process search");
  assert.equal(local.results[0].document.pageContent, "beta paragraph", "W q ranked beta first");
  assert.equal(local.results[0].provenance.queryAdapter, stamp);
  assert.deepStrictEqual(remote, local);
});

// ---------------------------------------------------------------------------
// Tenant isolation through the service
// ---------------------------------------------------------------------------

test("another tenant's document answers exactly like a missing one: no results, same route summary", async () => {
  useRemote(replica.url);

  const queries = [{ id: "primary", primary: true, query: "paid annual leave days each year" }];
  const asAlice = (docIds) =>
    retrieveGlobalContextRemotely({ accessScope: ALICE, docIds, retrievalQueries: queries });
  const withForeign = await asAlice(["leave-policy", "bob-handbook"]);
  const withMissing = await asAlice(["leave-policy", "no-such-document"]);

  assert.ok(withForeign.results.length > 0);
  assert.ok(withForeign.results.every((result) => result.document.metadata.docId === "leave-policy"));
  assert.deepStrictEqual(withForeign, withMissing);

  const onlyForeign = await asAlice(["bob-handbook"]);

  assert.deepEqual(onlyForeign.results, []);
  assert.deepStrictEqual(onlyForeign, await asAlice(["no-such-document"]));

  const perDocument = (docIds) =>
    retrievePerDocumentContextRemotely({ accessScope: ALICE, docIds, retrievalQueries: queries });
  const foreignPerDocument = await perDocument(["leave-policy", "bob-handbook"]);
  const missingPerDocument = await perDocument(["leave-policy", "no-such-document"]);

  assert.deepEqual([...foreignPerDocument.resultsByDocument.keys()], ["leave-policy", "bob-handbook"]);
  assert.deepEqual(foreignPerDocument.resultsByDocument.get("bob-handbook"), []);
  assert.deepStrictEqual(foreignPerDocument.retrieval, missingPerDocument.retrieval);
  assert.deepStrictEqual(
    foreignPerDocument.resultsByDocument.get("leave-policy"),
    missingPerDocument.resultsByDocument.get("leave-policy")
  );

  const search = await searchGlobalContextRemotely({ accessScope: ALICE, docIds: ["bob-handbook"], queryText: "annual leave" });

  assert.deepEqual(search.results, []);

  // Bob sees his own document; the tenant comes from the signed scope.
  const asBob = await retrieveGlobalContextRemotely({ accessScope: BOB, docIds: ["bob-handbook"], retrievalQueries: queries });

  assert.ok(asBob.results.length > 0);
  assert.ok(asBob.results.every((result) => result.document.metadata.docId === "bob-handbook"));

  // The local index itself has no row-level security: searched in process as
  // Alice, Bob's chunks would come back. The retrieval tier's mask is what
  // keeps them out on that provider.
  useInProcess();
  const unmasked = await retrieveGlobalContextForQueriesInProcess({ docIds: ["bob-handbook"], retrievalQueries: queries });

  assert.ok(unmasked.results.length > 0);
});

test("maskInvisibleDocIds hides foreign and unknown ids alike and maps them back", async () => {
  const mask = await maskInvisibleDocIds(["leave-policy", "bob-handbook", "no-such-document"], ALICE);

  assert.equal(mask.docIds[0], "leave-policy");
  assert.equal(mask.invisibleCount, 2);
  assert.match(mask.docIds[1], /^retrieval-invisible-document:/);
  assert.notEqual(mask.docIds[1], mask.docIds[2]);
  assert.equal(mask.unmask(mask.docIds[1]), "bob-handbook");
  assert.equal(mask.unmask(mask.docIds[2]), "no-such-document");

  // The auth-disabled scope sees every registered document, as in process.
  const open = await maskInvisibleDocIds(["leave-policy", "bob-handbook"], { authenticated: false, userId: "", workspaceId: "" });

  assert.deepEqual(open.docIds, ["leave-policy", "bob-handbook"]);
});

test("the signed scope is the caller's; a scope that disagrees with the bound database tenant is refused", () => {
  assert.deepEqual(resolveRetrievalAccessScope({ ...ALICE, permissionIds: ["documents.read"], token: "raw" }), ALICE);
  assert.deepEqual(
    runWithDatabaseTenant(ALICE, () => resolveRetrievalAccessScope(null)),
    { authenticated: true, userId: "alice", workspaceId: "ws-a" }
  );
  assert.deepEqual(resolveRetrievalAccessScope({}), { authenticated: false, userId: "", workspaceId: "" });
  assert.throws(
    () => runWithDatabaseTenant(BOB, () => resolveRetrievalAccessScope(ALICE)),
    (error) => error instanceof RetrievalServiceError && error.code === RETRIEVAL_SERVICE_ERROR_CODES.scopeMismatch
  );
});

// ---------------------------------------------------------------------------
// Malformed requests and identity
// ---------------------------------------------------------------------------

const tokenFor = ({ audience = "retrieval", issuer = "agent", accessScope = ALICE, system = false, secret = null } = {}) =>
  signServiceToken({
    audience,
    env: secret ? { INTERNAL_SERVICE_KEYS: `k9:${secret}` } : process.env,
    issuer,
    ...(system ? { system: true } : { accessScope }),
  });

const post = async (pathName, body, { headers = {}, raw = false, token = tokenFor() } = {}) => {
  const response = await fetch(`${replica.url}${pathName}`, {
    body: raw ? body : JSON.stringify(encodeWireValue(body)),
    headers: {
      "content-type": "application/json",
      ...(token ? { [SERVICE_TOKEN_HEADER]: token } : {}),
      ...headers,
    },
    method: "POST",
  });
  const text = await response.text();

  return { json: text ? JSON.parse(text) : null, status: response.status, text };
};

const VALID_GLOBAL = {
  docIds: ["leave-policy"],
  queries: [{ id: "primary", primary: true, query: "secret question text about leave" }],
  queryAdapterScope: null,
  topK: null,
};

test("malformed or oversized requests get 400/413 with stable codes and never echo request text", async (t) => {
  t.after(() => {
    delete process.env.RETRIEVAL_SERVICE_MAX_DOC_IDS;
    delete process.env.RETRIEVAL_SERVICE_MAX_QUERIES;
    delete process.env.RETRIEVAL_SERVICE_MAX_QUERY_CHARS;
    delete process.env.RETRIEVAL_SERVICE_MAX_TOP_K;
  });

  const ok = await post(RETRIEVAL_SERVICE_PATHS.global, VALID_GLOBAL);

  assert.equal(ok.status, 200);

  process.env.RETRIEVAL_SERVICE_MAX_DOC_IDS = "2";
  process.env.RETRIEVAL_SERVICE_MAX_QUERIES = "2";
  process.env.RETRIEVAL_SERVICE_MAX_QUERY_CHARS = "40";
  process.env.RETRIEVAL_SERVICE_MAX_TOP_K = "10";

  const cases = [
    [{ raw: true, body: "{not json" }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidRequest],
    [{ raw: true, body: "[1, 2]" }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidRequest],
    [{ raw: true, body: JSON.stringify({ $: "bogus" }) }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidRequest],
    [{ body: { ...VALID_GLOBAL, docIds: "leave-policy" } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidDocIds],
    // An empty list is refused on every endpoint: Qdrant reads it as "no
    // filter", which would search every tenant's chunks past the mask.
    [{ body: { ...VALID_GLOBAL, docIds: [] } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidDocIds],
    [{ body: { docIds: [], queries: VALID_GLOBAL.queries, topKPerDoc: null }, path: RETRIEVAL_SERVICE_PATHS.perDocument }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidDocIds],
    [{ body: { docIds: [], query: "secret question text", topK: null }, path: RETRIEVAL_SERVICE_PATHS.search }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidDocIds],
    [{ body: { ...VALID_GLOBAL, docIds: ["leave-policy", ""] } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidDocIds],
    [{ body: { ...VALID_GLOBAL, docIds: ["a", "b", "c"] } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.tooManyDocIds],
    [{ body: { ...VALID_GLOBAL, queries: [] } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidQuery],
    [{ body: { ...VALID_GLOBAL, queries: [{ id: "x", query: "no primary flag" }] } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidQuery],
    [{ body: { ...VALID_GLOBAL, queries: Array(3).fill(VALID_GLOBAL.queries[0]) } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.tooManyQueries],
    [
      { body: { ...VALID_GLOBAL, queries: [{ id: "p", primary: true, query: "secret question text ".repeat(5) }] } },
      400,
      RETRIEVAL_SERVICE_ERROR_CODES.queryTooLong,
    ],
    [{ body: { ...VALID_GLOBAL, topK: 0 } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidTopK],
    [{ body: { ...VALID_GLOBAL, topK: "5" } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidTopK],
    [{ body: { ...VALID_GLOBAL, topK: 11 } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidTopK],
    [{ body: { ...VALID_GLOBAL, queryAdapterScope: "comparison" } }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidQueryAdapterScope],
    [{ body: { docIds: ["leave-policy"], queries: VALID_GLOBAL.queries, topKPerDoc: -1 }, path: RETRIEVAL_SERVICE_PATHS.perDocument }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidTopK],
    [{ body: { docIds: ["leave-policy"], query: 42 }, path: RETRIEVAL_SERVICE_PATHS.search }, 400, RETRIEVAL_SERVICE_ERROR_CODES.invalidQuery],
    [{ raw: true, body: JSON.stringify({ padding: "x".repeat(4 * 1024 * 1024 + 16) }) }, 413, RETRIEVAL_SERVICE_ERROR_CODES.requestTooLarge],
  ];

  for (const [{ body, path: pathName = RETRIEVAL_SERVICE_PATHS.global, raw = false }, status, code] of cases) {
    const answer = await post(pathName, body, { raw });

    assert.equal(answer.status, status, `${code}: ${answer.text.slice(0, 200)}`);
    assert.equal(answer.json?.code, code);
    assert.ok(!answer.text.includes("secret question"), "the answer never echoes the query");
  }

  // The client turns a refusal into a RetrievalServiceError with the tier's
  // status and code.
  useRemote(replica.url);
  await assert.rejects(
    retrieveGlobalContextRemotely({
      accessScope: ALICE,
      docIds: ["a", "b", "c"],
      retrievalQueries: VALID_GLOBAL.queries,
    }),
    (error) =>
      error instanceof RetrievalServiceError &&
      error.status === 400 &&
      error.code === RETRIEVAL_SERVICE_ERROR_CODES.tooManyDocIds &&
      !error.message.includes("secret")
  );

  const unknownPath = await post("/internal/retrieval/v1/nope", VALID_GLOBAL);

  assert.equal(unknownPath.status, 404);
});

test("only a signed identity for the retrieval audience from an allowed issuer gets through", async () => {
  const cases = [
    [null, 401, "SERVICE_TOKEN_MISSING"],
    ["not-a-token", 401, "SERVICE_TOKEN_MALFORMED"],
    [tokenFor({ audience: "model-gateway" }), 403, "SERVICE_TOKEN_AUDIENCE"],
    [tokenFor({ issuer: "api" }), 403, "SERVICE_TOKEN_ISSUER"],
    [tokenFor({ system: true }), 403, "SERVICE_TOKEN_SYSTEM_NOT_ALLOWED"],
    [tokenFor({ secret: "z".repeat(40) }), 401, "SERVICE_TOKEN_UNKNOWN_KEY"],
    [`${tokenFor().slice(0, -2)}xx`, 401, "SERVICE_TOKEN_SIGNATURE"],
  ];

  for (const [token, status, code] of cases) {
    const answer = await post(RETRIEVAL_SERVICE_PATHS.global, VALID_GLOBAL, { token });

    assert.equal(answer.status, status, code);
    assert.equal(answer.json.code, code);
    assert.ok(!answer.text.includes("secret question"));
  }

  for (const issuer of ["agent", "all"]) {
    assert.equal((await post(RETRIEVAL_SERVICE_PATHS.global, VALID_GLOBAL, { token: tokenFor({ issuer }) })).status, 200);
  }

  const ping = (token) =>
    fetch(`${replica.url}${RETRIEVAL_SERVICE_PATHS.ping}`, { headers: token ? { [SERVICE_TOKEN_HEADER]: token } : {} });

  assert.equal((await ping(tokenFor({ issuer: "api", system: true }))).status, 200, "a system probe may ping");
  assert.equal((await ping(null)).status, 401);
  assert.equal((await ping(tokenFor({ audience: "agent", system: true }))).status, 403);

  const health = await fetch(`${replica.url}/health`);
  const report = await health.json();

  assert.equal(health.status, 200, "health needs no identity");
  assert.equal(report.service, "retrieval");
  assert.equal(report.checks.vectorStore.provider, "local");
  assert.equal(report.checks.vectorStore.runtime.vectorStoreProvider, "local");
  assert.equal(report.checks.queryAdapter.status, "disabled");
  assert.ok(!JSON.stringify(report).includes(SECRET), "no key material in health");
  assert.deepEqual(await buildRetrievalHealthReport().then((built) => Object.keys(built.checks).sort()), [
    "queryAdapter",
    "serviceTopology",
    "vectorStore",
  ]);

  const ready = await fetch(`${replica.url}/ready`);

  assert.equal(ready.status, report.status === "ok" ? 200 : 503);
});

// ---------------------------------------------------------------------------
// Replicas: failover, a tier that is down, deadlines
// ---------------------------------------------------------------------------

test("a call fails over from a stopped replica and from one answering 503, and still returns the same results", async (t) => {
  const stopped = await startRetrievalReplica();
  const stoppedUrl = stopped.url;

  await stopped.close();

  const unavailable = await startServer(
    express().use((req, res) => res.status(503).json({ code: "RETRIEVAL_FAILED", error: "Busy." }))
  );

  t.after(() => unavailable.close());

  const run = () =>
    chat(["leave-policy"], "How many paid annual leave days do employees get?", {
      accessScope: ALICE,
      includeRetrievedContexts: true,
    });

  const viaStopped = await runBothWays(run, { urls: [stoppedUrl, replica.url] });

  assert.deepStrictEqual(viaStopped.remote, viaStopped.local);

  useRemote([unavailable.url, replica.url]);
  const viaUnavailable = await run();

  assert.deepStrictEqual(viaUnavailable, viaStopped.local);

  const snapshot = describeServiceClients().retrieval;
  const unavailableReplica = snapshot.replicas.find((entry) => entry.url === unavailable.url);

  assert.equal(unavailableReplica.lastFailureCode, "HTTP_503");
  assert.equal(unavailableReplica.healthy, false);
  assert.ok(snapshot.replicas.find((entry) => entry.url === replica.url).requests > 0);
});

test("a retrieval tier that is down is a 503 with a stable code, and one that hangs is cut off at the budget", async (t) => {
  const stopped = await startRetrievalReplica();

  await stopped.close();
  useRemote(stopped.url);

  const startedAt = Date.now();

  await assert.rejects(
    chat(["leave-policy"], "How many paid annual leave days do employees get?", { accessScope: ALICE }),
    (error) =>
      error instanceof ServiceUnavailableError &&
      error.status === 503 &&
      error.code === "SERVICE_UNREACHABLE" &&
      error.service === "retrieval" &&
      !error.message.includes(stopped.url)
  );
  assert.ok(Date.now() - startedAt < 5000, "no hang");

  const hanging = [];
  const hangingServer = await startServer((req, res) => {
    hanging.push({ deadline: req.headers[SERVICE_DEADLINE_HEADER], res });
  });

  t.after(async () => {
    hanging.forEach(({ res }) => res.destroy());
    await hangingServer.close();
  });
  useRemote(hangingServer.url);
  process.env.RETRIEVAL_SERVICE_TIMEOUT_MS = "300";
  t.after(() => delete process.env.RETRIEVAL_SERVICE_TIMEOUT_MS);

  await assert.rejects(
    chat(["leave-policy"], "How many paid annual leave days do employees get?", { accessScope: ALICE }),
    (error) => error instanceof ServiceTimeoutError && error.status === 504 && error.code === "SERVICE_TIMEOUT"
  );
  assert.ok(Number(hanging[0].deadline) <= 300, "the budget went out as the deadline header");

  // A bound caller deadline shortens the budget further ...
  const deadlineStartedAt = Date.now();

  await assert.rejects(
    runWithServiceCallDeadline(Date.now() + 100, () =>
      retrieveGlobalContextRemotely({ accessScope: ALICE, docIds: ["leave-policy"], retrievalQueries: VALID_GLOBAL.queries })
    ),
    (error) => error instanceof ServiceTimeoutError
  );
  assert.ok(Date.now() - deadlineStartedAt < 290, "cut off at the caller's deadline, not the 300 ms budget");
  assert.ok(Number(hanging.at(-1).deadline) <= 100);

  // ... and a deadline that already passed sends nothing.
  const sentBefore = hanging.length;

  await assert.rejects(
    runWithServiceCallDeadline(Date.now() - 1, () =>
      retrieveGlobalContextRemotely({ accessScope: ALICE, docIds: ["leave-policy"], retrievalQueries: VALID_GLOBAL.queries })
    ),
    (error) => error instanceof ServiceTimeoutError && error.attempts === 0
  );
  assert.equal(hanging.length, sentBefore);
  assert.equal(runWithServiceCallDeadline(null, () => getServiceCallBudgetMs(1234)), 1234);
});

test("the retrieval tier honours the caller's deadline: refused on arrival, answered 504 when it runs out", async () => {
  const late = await post(RETRIEVAL_SERVICE_PATHS.global, VALID_GLOBAL, { headers: { [SERVICE_DEADLINE_HEADER]: "0" } });

  assert.equal(late.status, 504);
  assert.equal(late.json.code, RETRIEVAL_SERVICE_ERROR_CODES.deadlineExceeded);

  slowQueries = new Map([["a slow question about leave", 400]]);

  const startedAt = Date.now();
  const slow = await post(
    RETRIEVAL_SERVICE_PATHS.global,
    { ...VALID_GLOBAL, queries: [{ id: "primary", primary: true, query: "a slow question about leave" }] },
    { headers: { [SERVICE_DEADLINE_HEADER]: "80" } }
  );

  assert.equal(slow.status, 504);
  assert.equal(slow.json.code, RETRIEVAL_SERVICE_ERROR_CODES.deadlineExceeded);
  assert.ok(Date.now() - startedAt < 380, "answered at the deadline, before the slow embedding finished");
  assert.ok(!slow.text.includes("slow question"));
});

test("a dependency failure on the retrieval tier comes back as a status and a stable code, never its message", async (t) => {
  const attempts = new Map();
  const withStatus = (status, code) => () => {
    attempts.set(status, (attempts.get(status) ?? 0) + 1);

    return Object.assign(new Error(`upstream said no to "a failing question ${status}"`), { code, status });
  };

  failingQueries = new Map([
    ["a failing question 502", withStatus(502, "MODEL_GATEWAY_PROTOCOL")],
    ["a failing question 503", withStatus(503, "CIRCUIT_OPEN")],
    ["a failing question 504", withStatus(504, "SERVICE_TIMEOUT")],
    ["a failing question 429", withStatus(429, "RATE_LIMITED")],
    ["a failing question 401", withStatus(401, "invalid_api_key")],
    ["a failing question plain", () => new Error('plain failure mentioning "a failing question plain"')],
  ]);

  const retrieveFor = (query) =>
    retrieveGlobalContextRemotely({
      accessScope: ALICE,
      docIds: ["leave-policy"],
      retrievalQueries: [{ id: "primary", primary: true, query }],
    });

  // An unavailable dependency is shared by every replica, so the call is not
  // failed over: the dependency is tried exactly as often as in process, the
  // caller gets the dependency's own status and code, and neither replica is
  // marked unhealthy for it.
  const second = await startRetrievalReplica();

  t.after(() => second.close());

  for (const [status, code] of [
    [502, "MODEL_GATEWAY_PROTOCOL"],
    [503, "CIRCUIT_OPEN"],
    [504, "SERVICE_TIMEOUT"],
  ]) {
    const query = `a failing question ${status}`;

    useInProcess();
    await assert.rejects(
      retrieveGlobalContextForQueriesInProcess({
        docIds: ["leave-policy"],
        retrievalQueries: [{ id: "primary", primary: true, query }],
      }),
      (error) => error.status === status && error.code === code
    );

    const inProcessAttempts = attempts.get(status);

    useRemote([replica.url, second.url]);
    await assert.rejects(
      retrieveFor(query),
      (error) =>
        error instanceof RetrievalServiceError &&
        error.status === status &&
        error.code === code &&
        !error.message.includes("failing question")
    );
    assert.equal(attempts.get(status) - inProcessAttempts, inProcessAttempts, `no failover on a dependency ${status}`);
    assert.ok(
      describeServiceClients().retrieval.replicas.every((entry) => entry.healthy && entry.failures === 0),
      "a dependency outage marks no replica unhealthy"
    );

    const direct = await post(RETRIEVAL_SERVICE_PATHS.global, {
      ...VALID_GLOBAL,
      queries: [{ id: "primary", primary: true, query }],
    });

    assert.equal(direct.status, 424);
    assert.deepEqual(direct.json, {
      code,
      dependencyStatus: status,
      error: "A dependency of the retrieval service is unavailable.",
    });
  }

  useRemote(replica.url);
  await assert.rejects(
    retrieveFor("a failing question 429"),
    (error) => error instanceof RetrievalServiceError && error.status === 429 && error.code === "RATE_LIMITED"
  );

  for (const query of ["a failing question 401", "a failing question plain"]) {
    await assert.rejects(
      retrieveFor(query),
      (error) =>
        error instanceof RetrievalServiceError &&
        error.status === 500 &&
        error.code === RETRIEVAL_SERVICE_ERROR_CODES.failed &&
        !error.message.includes("failing question")
    );
  }

  const direct = await post(RETRIEVAL_SERVICE_PATHS.global, {
    ...VALID_GLOBAL,
    queries: [{ id: "primary", primary: true, query: "a failing question plain" }],
  });

  assert.equal(direct.status, 500);
  assert.ok(!direct.text.includes("failing question"));
});

test("a tier that refuses this process's identity or lacks the endpoint is an internal 500, never a public 401/403/404", async (t) => {
  // This process signs as `all`; a tier that admits only `agent` refuses it.
  const strict = await startRetrievalReplica({ issuers: ["agent"] });
  const stale = await startServer(
    express().use((req, res) => res.status(404).json({ code: "RETRIEVAL_ROUTE_NOT_FOUND", error: "Unknown retrieval endpoint." }))
  );

  t.after(async () => {
    await strict.close();
    await stale.close();
  });

  useRemote(strict.url);
  await assert.rejects(
    chat(["leave-policy"], "How many paid annual leave days do employees get?", { accessScope: ALICE }),
    (error) => error instanceof RetrievalServiceError && error.status === 500 && error.code === "SERVICE_TOKEN_ISSUER"
  );

  useRemote(stale.url);
  await assert.rejects(
    retrieveGlobalContextRemotely({ accessScope: ALICE, docIds: ["leave-policy"], retrievalQueries: VALID_GLOBAL.queries }),
    (error) => error instanceof RetrievalServiceError && error.status === 500 && error.code === "RETRIEVAL_ROUTE_NOT_FOUND"
  );
});

test("the retrieval tier's model calls are charged to the caller's agent run, as in process", async () => {
  const run = async () => {
    const meter = createRunUsage({ limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 } });

    await runWithRunUsage(meter, () =>
      chat(["leave-policy", "travel-policy"], "How many paid annual leave days do employees get?", { accessScope: ALICE })
    );

    const retrievalMeter = createRunUsage({ limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 } });

    await runWithRunUsage(retrievalMeter, () =>
      retrieveQaCandidates({ accessScope: ALICE, docIds: ["leave-policy"], resolvedQuery: "parental leave weeks" })
    );

    return { chat: meter.used, retrieval: retrievalMeter.used };
  };
  const { local, remote } = await runBothWays(run);

  assert.ok(local.retrieval.modelCalls > 0, "in process the query embedding is charged to the run");
  assert.ok(local.chat.modelCalls > local.retrieval.modelCalls, "the answer model is charged too");
  assert.deepStrictEqual(remote, local);
});

test("remote mode is decided by the topology: the retrieval tier itself never calls RETRIEVAL_SERVICE_URL", () => {
  assert.equal(isRetrievalRemote({}), false);
  assert.equal(isRetrievalRemote({ RETRIEVAL_SERVICE_URL: "http://retrieval:5002" }), true);
  assert.equal(isRetrievalRemote({ ARCHIVE_RAG_ROLE: "agent", RETRIEVAL_SERVICE_URL: "http://retrieval:5002" }), true);
  assert.equal(isRetrievalRemote({ ARCHIVE_RAG_ROLE: "retrieval", RETRIEVAL_SERVICE_URL: "http://retrieval:5002" }), false);
});
