import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getEmbeddingDocumentPrefix,
  getEmbeddingIndexIdentity,
  getEmbeddingQueryPrefix,
  isEmbeddingIdentityCurrent,
} from "../rag/config.js";
import { configureOpenAIProvider, embedQuery, embedTexts, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  addDocumentsToLocalIndex,
  resetDimensionMismatchReports,
  resetLocalVectorStore,
  searchLocalDocuments,
} from "../rag/vector-store-local.js";

const KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_EMBEDDING_MODEL",
  "RAG_EMBEDDING_DIMENSIONS",
  "RAG_EMBEDDING_DOCUMENT_PREFIX",
  "RAG_EMBEDDING_QUERY_PREFIX",
];
let saved;
let originalFetch;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  originalFetch = globalThis.fetch;

  for (const key of KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOpenAIProvider();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("nomic-embed-text gets its documented task prefixes; other models and an explicit empty value get none", () => {
  process.env.OPENAI_EMBEDDING_MODEL = "nomic-embed-text";
  assert.equal(getEmbeddingQueryPrefix(), "search_query: ");
  assert.equal(getEmbeddingDocumentPrefix(), "search_document: ");
  assert.equal(getEmbeddingIndexIdentity(), "nomic-embed-text#search_document:");

  process.env.RAG_EMBEDDING_DOCUMENT_PREFIX = "";
  process.env.RAG_EMBEDDING_QUERY_PREFIX = "";
  assert.equal(getEmbeddingDocumentPrefix(), "");
  assert.equal(getEmbeddingIndexIdentity(), "nomic-embed-text");

  delete process.env.RAG_EMBEDDING_DOCUMENT_PREFIX;
  delete process.env.RAG_EMBEDDING_QUERY_PREFIX;
  process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  assert.equal(getEmbeddingQueryPrefix(), "");
  assert.equal(getEmbeddingIndexIdentity(), "text-embedding-3-small");
});

test("a chunk stored without an identity counts as current only while no prefix applies", () => {
  process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  assert.equal(isEmbeddingIdentityCurrent(null), true);
  assert.equal(isEmbeddingIdentityCurrent("text-embedding-3-small"), true);
  assert.equal(isEmbeddingIdentityCurrent("text-embedding-3-large"), false);

  process.env.OPENAI_EMBEDDING_MODEL = "nomic-embed-text";
  assert.equal(isEmbeddingIdentityCurrent(null), false);
  assert.equal(isEmbeddingIdentityCurrent("nomic-embed-text"), false);
  assert.equal(isEmbeddingIdentityCurrent("nomic-embed-text#search_document:"), true);
});

test("the real embedding client sends the prefixes; a configured stand-in provider never gets them", async () => {
  const inputs = [];

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "http://embeddings.test/v1";
  process.env.OPENAI_EMBEDDING_MODEL = "nomic-embed-text";
  globalThis.fetch = async (_url, options) => {
    const { input } = JSON.parse(options.body);

    inputs.push(input);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: (Array.isArray(input) ? input : [input]).map((_value, index) => ({ embedding: [1, 0], index })),
        }),
    };
  };
  resetOpenAIProvider();

  await embedQuery("which datasets?");
  await embedTexts(["We use SQuAD.", "Results follow."]);
  assert.deepEqual(inputs, [
    "search_query: which datasets?",
    ["search_document: We use SQuAD.", "search_document: Results follow."],
  ]);

  const standIn = [];

  configureOpenAIProvider({
    embedQuery: async (text) => {
      standIn.push(text);
      return [1, 0];
    },
    embedTexts: async (texts) => {
      standIn.push(...texts);
      return texts.map(() => [1, 0]);
    },
  });
  await embedQuery("which datasets?");
  await embedTexts(["We use SQuAD."]);
  assert.deepEqual(standIn, ["which datasets?", "We use SQuAD."]);
});

test("the local store gives no dense score to chunks embedded under another identity", async (t) => {
  const previousDirectory = getRagDataDirectory();
  const directory = await mkdtemp(path.join(os.tmpdir(), "embedding-identity-"));
  const warnings = [];
  const originalWarn = console.warn;

  t.after(async () => {
    console.warn = originalWarn;
    configureRagDataDirectory(previousDirectory);
    resetLocalVectorStore();
    await rm(directory, { force: true, recursive: true });
  });
  console.warn = (message) => warnings.push(String(message));
  configureRagDataDirectory(directory);
  resetLocalVectorStore();
  resetDimensionMismatchReports();
  configureOpenAIProvider({
    embedQuery: async () => [1, 0],
    embedTexts: async (texts) => texts.map(() => [1, 0]),
  });
  process.env.OPENAI_EMBEDDING_MODEL = "nomic-embed-text";

  await addDocumentsToLocalIndex({
    documents: [{ id: "doc-1:0", metadata: { chunkIndex: 0, docId: "doc-1" }, pageContent: "Cobalt ceiling is 3600." }],
  });

  const search = () => searchLocalDocuments({ docIds: ["doc-1"], queryText: "cobalt", queryVector: [1, 0], topK: 1 });

  assert.equal((await search())[0].vectorScore, 1);

  // The same archive, read after the document prefix was turned off.
  process.env.RAG_EMBEDDING_DOCUMENT_PREFIX = "";
  const [stale] = await search();

  assert.equal(stale.vectorScore, 0);
  assert.equal(stale.keywordScore, 1, "keyword matching still applies");
  assert.match(warnings.join("\n"), /embedded as nomic-embed-text#search_document:; the current embedding is nomic-embed-text/);
});
