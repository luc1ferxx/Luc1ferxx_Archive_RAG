import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";

// A process whose retrieval runs remotely must not read the vector store or
// embed a query itself on the chat path. Phase one records what a real
// retrieval tier answers for a set of chat() calls; phase two replays those
// answers from a tier that computes nothing, while this process's own
// vector store is one that throws on any search (pgvector without a
// database) and its embedding model throws on any call. chat() must still
// return exactly the phase-one responses.

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "retrieval-remote-only-test-"));
process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");

const SECRET = "q".repeat(24) + "-remote-only-secret-0123456789";
const ENVIRONMENT_KEYS = [
  "ARCHIVE_RAG_ROLE",
  "INTERNAL_SERVICE_KEYS",
  "LONG_MEMORY_DATABASE_URL",
  "OPENAI_EMBEDDING_MODEL",
  "POSTGRES_DATABASE_URL",
  "RAG_HYBRID_ENABLED",
  "RAG_HYBRID_FUSION",
  "RAG_OBSERVABILITY_ENABLED",
  "RAG_RERANK_ENABLED",
  "RAG_SEMANTIC_CACHE",
  "RETRIEVAL_SERVICE_URL",
  "VECTOR_STORE_PROVIDER",
];
const savedEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

Object.assign(process.env, {
  INTERNAL_SERVICE_KEYS: `k1:${SECRET}`,
  OPENAI_EMBEDDING_MODEL: "remote-only-test-model",
  RAG_HYBRID_ENABLED: "true",
  RAG_HYBRID_FUSION: "rrf",
  RAG_OBSERVABILITY_ENABLED: "false",
  RAG_RERANK_ENABLED: "false",
  RAG_SEMANTIC_CACHE: "off",
  VECTOR_STORE_PROVIDER: "local",
});
delete process.env.ARCHIVE_RAG_ROLE;
delete process.env.RETRIEVAL_SERVICE_URL;

const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const { resetEmbeddingCache } = await import("../rag/embedding-cache.js");
const { buildTermSet } = await import("../rag/text-utils.js");
const { configureDocumentRegistryStore, resetDocumentRegistry, resetDocumentRegistryStore } = await import(
  "../rag/doc-registry.js"
);
const { createFileDocumentRegistryStore } = await import("../rag/doc-registry-file.js");
const ragIndex = await import("../rag/index.js");
const { resetVectorStore, searchDocumentsWithRoutes } = await import("../rag/vector-store.js");
const { resetServiceClients } = await import("../rag/service-client.js");
const { requireServiceIdentity } = await import("../rag/service-identity.js");
const { createRetrievalApp } = await import("../rag/retrieval-service/app.js");

const chat = ragIndex.default;
const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-a" };

const embed = (text) => {
  const vector = new Array(32).fill(0);

  for (const term of buildTermSet(text)) {
    let hash = 0;

    for (const character of term) {
      hash = (hash * 31 + character.codePointAt(0)) % 32;
    }

    vector[hash] += 1;
  }

  return vector;
};

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

const CALLS = [
  [["leave-policy"], "How many paid annual leave days do employees get?"],
  [["leave-policy", "travel-policy"], "Compare the leave policy and the travel policy."],
  [["leave-policy"], "When does the relocation stipend take effect and who approves the pension plan?"],
];

const runCalls = async () => {
  const responses = [];

  for (const [docIds, question] of CALLS) {
    responses.push(await chat(docIds, question, { accessScope: ALICE, includeRetrievedContexts: true }));
  }

  return responses;
};

after(async () => {
  resetOpenAIProvider();
  resetServiceClients();
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

test("with remote retrieval, chat() neither searches the local vector store nor embeds a query", async (t) => {
  const answer = async () => "Employees receive ten paid annual leave days each year. [Source 1]";

  await resetDocumentRegistryStore();
  await resetDocumentRegistry();
  configureDocumentRegistryStore(createFileDocumentRegistryStore());
  resetVectorStore();
  configureOpenAIProvider({
    completeText: answer,
    embedQuery: async (query) => embed(query),
    embedTexts: async (texts) => texts.map(embed),
  });

  const fixtureFile = path.join(tempRoot, "fixture.pdf");

  writeFileSync(fixtureFile, "fixture", "utf8");

  for (const [docId, pages] of [
    ["leave-policy", ["Annual leave policy: employees receive ten paid annual leave days each year.", "Remote work needs manager approval."]],
    ["travel-policy", ["Travel policy: meals are reimbursed up to forty dollars per day.", "Taxi rides need a receipt."]],
  ]) {
    await ragIndex.ingestDocumentPages({
      docId,
      fileName: `${docId}.pdf`,
      filePath: fixtureFile,
      ownerUserId: ALICE.userId,
      pages: pages.map((text, index) => ({ pageNumber: index + 1, text })),
      workspaceId: ALICE.workspaceId,
    });
  }

  // Phase one: a real retrieval tier behind a proxy that records each
  // request body and the tier's answer.
  const recorded = new Map();
  const readBody = async (req) => {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
  };
  const tier = await startServer(createRetrievalApp({ logger: { error() {}, log() {}, warn() {} } }));
  const recorderProxy = await startServer(async (req, res) => {
    const body = await readBody(req);
    const upstream = await fetch(`${tier.url}${req.url}`, {
      body: req.method === "POST" ? body : undefined,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => !["connection", "content-length", "host"].includes(name))
      ),
      method: req.method,
    });
    const text = await upstream.text();

    recorded.set(`${req.url}\n${body}`, { body: text, status: upstream.status });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text);
  });

  t.after(async () => {
    await recorderProxy.close();
    await tier.close();
  });

  process.env.RETRIEVAL_SERVICE_URL = recorderProxy.url;
  resetServiceClients();
  const expected = await runCalls();

  assert.ok(recorded.size >= 3, "phase one recorded the retrieval calls");
  assert.ok([...recorded.values()].every((entry) => entry.status === 200));

  // Phase two: nothing local can answer a retrieval any more.
  process.env.VECTOR_STORE_PROVIDER = "pgvector";
  delete process.env.POSTGRES_DATABASE_URL;
  delete process.env.LONG_MEMORY_DATABASE_URL;
  resetVectorStore();
  resetEmbeddingCache();
  await assert.rejects(
    searchDocumentsWithRoutes({ docIds: ["leave-policy"], queryText: "x", queryVector: [1], topK: 1 }),
    /requires POSTGRES_DATABASE_URL/,
    "a local search in this process would fail"
  );

  const forbidden = [];

  configureOpenAIProvider({
    completeText: answer,
    embedQuery: async () => {
      forbidden.push("embedQuery");
      throw new Error("The agent side must not embed a query when retrieval is remote.");
    },
    embedTexts: async () => {
      forbidden.push("embedTexts");
      throw new Error("The agent side must not embed texts when retrieval is remote.");
    },
  });

  const replayed = [];
  const replay = express();

  replay.use(requireServiceIdentity({ audience: "retrieval", issuers: ["all"] }));
  replay.use(express.text({ limit: "8mb", type: "*/*" }));
  replay.use((req, res) => {
    const entry = recorded.get(`${req.originalUrl}\n${req.body}`);

    replayed.push({ found: Boolean(entry), path: req.path, tenant: req.accessScope?.userId });

    if (!entry) {
      res.status(500).json({ code: "NOT_RECORDED", error: "Not recorded." });
      return;
    }

    res.status(entry.status).type("application/json").send(entry.body);
  });

  const replayTier = await startServer(replay);

  t.after(() => replayTier.close());
  process.env.RETRIEVAL_SERVICE_URL = replayTier.url;
  resetServiceClients();

  const actual = await runCalls();

  assert.deepEqual(forbidden, [], "no embedding call on the agent side");
  assert.ok(replayed.length >= 3);
  assert.ok(replayed.every((call) => call.found && call.tenant === "alice"));
  assert.deepStrictEqual(actual, expected);
});
