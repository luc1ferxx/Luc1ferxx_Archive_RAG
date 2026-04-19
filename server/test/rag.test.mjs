import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import chat, {
  clearDocuments,
  getDocument,
  ingestDocumentPages,
} from "../chat.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import { resetDocumentRegistry } from "../rag/doc-registry.js";
import { resetVectorStore } from "../rag/vector-store.js";
import {
  recordSessionTurn,
  resetSessionMemory,
  resolveQueryWithSessionMemory,
} from "../rag/memory.js";
import { buildTermSet } from "../rag/text-utils.js";

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
  completeText: async (prompt) => {
    if (prompt.includes("preserved_ambiguity")) {
      return JSON.stringify({
        rewritten_query: "What is the remote work approval policy?",
        preserved_ambiguity: false,
      });
    }

    if (prompt.includes("Standalone retrieval question:")) {
      return "What is the remote work approval policy?";
    }

    if (prompt.includes("Write the answer using these sections:")) {
      return [
        "Summary:",
        "Both documents discuss remote work (Source 1; Source 2).",
        "Per document:",
        "Source 1 allows two remote days.",
        "Source 2 allows three remote days.",
        "Agreements:",
        "Both require manager approval.",
        "Differences:",
        "The weekly day limit differs.",
        "Gaps or uncertainty:",
        "No additional gaps.",
      ].join("\n");
    }

    return "Grounded answer based on Source 1.";
  },
};

const writeFixtureFile = async (fileName) => {
  const filePath = path.join(tempRoot, fileName);
  await writeFile(filePath, "fixture", "utf8");
  return filePath;
};

const ingestFixture = async ({ docId, fileName, pages }) =>
  ingestDocumentPages({
    docId,
    fileName,
    filePath: await writeFixtureFile(fileName),
    pages: pages.map((text, index) => ({
      pageNumber: index + 1,
      text,
    })),
  });

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentai-rag-test-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  resetDocumentRegistry();
  resetVectorStore();
  resetSessionMemory();
  configureOpenAIProvider(provider);
});

afterEach(async () => {
  await clearDocuments({
    deleteFiles: false,
  });
  resetSessionMemory();
  resetVectorStore();
  resetDocumentRegistry();
  resetOpenAIProvider();
  configureRagDataDirectory(originalDataDirectory);
  resetSessionMemory();
  resetVectorStore();
  resetDocumentRegistry();

  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

test("qa flow returns grounded citations", async () => {
  await ingestFixture({
    docId: "benefits-2024",
    fileName: "benefits-2024.pdf",
    pages: [
      "Annual leave policy: employees receive 10 paid annual leave days each year.",
      "Remote work policy: employees may work remotely 2 days per week with manager approval.",
    ],
  });

  const response = await chat(["benefits-2024"], "What is the annual leave policy?");

  assert.match(response.text, /Grounded answer/);
  assert.equal(response.citations.length, 1);
  assert.equal(response.citations[0].pageNumber, 1);
});

test("legacy prompt version remains supported", async () => {
  const originalPromptVersion = process.env.RAG_PROMPT_VERSION;
  process.env.RAG_PROMPT_VERSION = "v1";

  try {
    await ingestFixture({
      docId: "benefits-legacy",
      fileName: "benefits-legacy.pdf",
      pages: [
        "Annual leave policy: employees receive 10 paid annual leave days each year.",
      ],
    });

    const response = await chat(
      ["benefits-legacy"],
      "What is the annual leave policy?"
    );

    assert.match(response.text, /Grounded answer/);
    assert.equal(response.citations.length, 1);
  } finally {
    if (originalPromptVersion === undefined) {
      delete process.env.RAG_PROMPT_VERSION;
    } else {
      process.env.RAG_PROMPT_VERSION = originalPromptVersion;
    }
  }
});

test("v3 rewrite prompt accepts structured JSON output", async () => {
  const originalPromptVersion = process.env.RAG_PROMPT_VERSION;

  process.env.RAG_PROMPT_VERSION = "v3";
  configureOpenAIProvider({
    ...provider,
    completeText: async (prompt) => {
      if (prompt.includes("preserved_ambiguity")) {
        return JSON.stringify({
          rewritten_query: "What is the remote work approval policy?",
          preserved_ambiguity: false,
        });
      }

      return "Grounded answer based on Source 1.";
    },
  });

  try {
    await ingestFixture({
      docId: "benefits-json",
      fileName: "benefits-json.pdf",
      pages: [
        "Remote work policy: employees may work remotely 3 days per week with manager approval.",
      ],
    });

    recordSessionTurn({
      sessionId: "session-json",
      query: "Tell me about remote work.",
      resolvedQuery: "Tell me about remote work.",
      answer: "Manager approval is required.",
      documents: [getDocument("benefits-json")],
      routeMode: "qa",
    });

    const memoryResolution = await resolveQueryWithSessionMemory({
      sessionId: "session-json",
      query: "And approval?",
      documents: [getDocument("benefits-json")],
    });

    assert.equal(memoryResolution.memoryApplied, true);
    assert.equal(
      memoryResolution.resolvedQuery,
      "What is the remote work approval policy?"
    );
  } finally {
    if (originalPromptVersion === undefined) {
      delete process.env.RAG_PROMPT_VERSION;
    } else {
      process.env.RAG_PROMPT_VERSION = originalPromptVersion;
    }

    configureOpenAIProvider(provider);
  }
});

test("compare flow returns multi-document evidence", async () => {
  await ingestFixture({
    docId: "benefits-2024",
    fileName: "benefits-2024.pdf",
    pages: [
      "Remote work policy: employees may work remotely 2 days per week with manager approval.",
    ],
  });
  await ingestFixture({
    docId: "benefits-2025",
    fileName: "benefits-2025.pdf",
    pages: [
      "Remote work policy: employees may work remotely 3 days per week with manager approval.",
    ],
  });

  const response = await chat(
    ["benefits-2024", "benefits-2025"],
    "Compare the remote work policy."
  );
  const citedDocIds = new Set(response.citations.map((citation) => citation.docId));

  assert.match(response.text, /Summary:/);
  assert.equal(citedDocIds.size, 2);
  assert.ok(citedDocIds.has("benefits-2024"));
  assert.ok(citedDocIds.has("benefits-2025"));
});

test("hybrid retrieval fuses sparse evidence when dense scores are flat", async () => {
  const originalHybridEnabled = process.env.RAG_HYBRID_ENABLED;
  const originalSparseTopK = process.env.RAG_SPARSE_TOP_K;
  const originalDenseWeight = process.env.RAG_HYBRID_DENSE_WEIGHT;
  const originalSparseWeight = process.env.RAG_HYBRID_SPARSE_WEIGHT;

  process.env.RAG_HYBRID_ENABLED = "true";
  process.env.RAG_SPARSE_TOP_K = "4";
  process.env.RAG_HYBRID_DENSE_WEIGHT = "0.1";
  process.env.RAG_HYBRID_SPARSE_WEIGHT = "0.9";

  configureOpenAIProvider({
    ...provider,
    embedTexts: async (texts) =>
      texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(1)),
    embedQuery: async () => new Array(EMBEDDING_DIMENSIONS).fill(1),
  });

  try {
    await ingestFixture({
      docId: "cobalt-manual",
      fileName: "cobalt.pdf",
      pages: [
        "Archive serial cobalt ceiling: approved amount is 3600 dollars per cycle.",
      ],
    });
    await ingestFixture({
      docId: "amber-manual",
      fileName: "amber.pdf",
      pages: [
        "Archive serial amber ceiling: approved amount is 2400 dollars per cycle.",
      ],
    });

    const response = await chat(
      ["cobalt-manual", "amber-manual"],
      "What is the amber ceiling?"
    );

    assert.equal(response.citations.length, 1);
    assert.equal(response.citations[0].docId, "amber-manual");
  } finally {
    if (originalHybridEnabled === undefined) {
      delete process.env.RAG_HYBRID_ENABLED;
    } else {
      process.env.RAG_HYBRID_ENABLED = originalHybridEnabled;
    }

    if (originalSparseTopK === undefined) {
      delete process.env.RAG_SPARSE_TOP_K;
    } else {
      process.env.RAG_SPARSE_TOP_K = originalSparseTopK;
    }

    if (originalDenseWeight === undefined) {
      delete process.env.RAG_HYBRID_DENSE_WEIGHT;
    } else {
      process.env.RAG_HYBRID_DENSE_WEIGHT = originalDenseWeight;
    }

    if (originalSparseWeight === undefined) {
      delete process.env.RAG_HYBRID_SPARSE_WEIGHT;
    } else {
      process.env.RAG_HYBRID_SPARSE_WEIGHT = originalSparseWeight;
    }

    configureOpenAIProvider(provider);
  }
});

test("unsupported questions abstain instead of using adjacent policies", async () => {
  await ingestFixture({
    docId: "benefits-2024",
    fileName: "benefits-2024.pdf",
    pages: [
      "Annual leave policy: employees receive 10 paid annual leave days each year.",
      "Remote work policy: employees may work remotely 2 days per week with manager approval.",
    ],
  });

  const response = await chat(["benefits-2024"], "What is the parental leave policy?");

  assert.match(response.text, /couldn't find enough grounded evidence/i);
  assert.equal(response.citations.length, 0);
});

test("persisted registry, vector data, and session memory survive reloads", async () => {
  await ingestFixture({
    docId: "benefits-2025",
    fileName: "benefits-2025.pdf",
    pages: [
      "Remote work policy: employees may work remotely 3 days per week with manager approval.",
    ],
  });

  recordSessionTurn({
    sessionId: "session-1",
    query: "Tell me about remote work.",
    resolvedQuery: "Tell me about remote work.",
    answer: "Manager approval is required.",
    documents: [getDocument("benefits-2025")],
    routeMode: "qa",
  });

  resetDocumentRegistry();
  resetVectorStore();
  resetSessionMemory();

  const persistedResponse = await chat(
    ["benefits-2025"],
    "What is the remote work policy?"
  );
  const memoryResolution = await resolveQueryWithSessionMemory({
    sessionId: "session-1",
    query: "And approval?",
    documents: [getDocument("benefits-2025")],
  });

  assert.match(persistedResponse.text, /Grounded answer/);
  assert.equal(persistedResponse.citations.length, 1);
  assert.equal(memoryResolution.memoryApplied, true);
  assert.equal(
    memoryResolution.resolvedQuery,
    "What is the remote work approval policy?"
  );
});
