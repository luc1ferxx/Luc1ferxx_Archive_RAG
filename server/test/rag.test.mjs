import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import chat, {
  clearDocuments,
  getDocument,
  ingestDocumentPages,
} from "../chat.js";
import { buildPublicFilePath } from "../rag/document-utils.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  configureDocumentRegistryStore,
  resetDocumentRegistry,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { resetVectorStore } from "../rag/vector-store.js";
import {
  configureQdrantClientFactory,
  resetQdrantClientFactory,
} from "../rag/vector-store-qdrant.js";
import {
  configureSessionMemoryStore,
  recordSessionTurn,
  resetSessionMemory,
  resetSessionMemoryStore,
  resolveQueryWithSessionMemory,
} from "../rag/memory.js";
import {
  configureLongMemoryStore,
  listLongMemories,
  resetLongMemoryStore,
} from "../rag/long-memory.js";
import { prepareComparisonSourceBundle } from "../rag/answer-writer.js";
import { analyzeComparison } from "../rag/comparison-engine.js";
import { alignComparisonEvidence } from "../rag/evidence-aligner.js";
import { planQaEvidenceGap } from "../rag/gap-planner.js";
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

const createFakeQdrantClient = () => {
  let collectionConfig = null;
  const pointsById = new Map();

  const cloneVector = (vector = {}) => structuredClone(vector);
  const clonePayload = (payload = {}) => structuredClone(payload);

  const matchesFilter = (payload, filter) => {
    if (!filter) {
      return true;
    }

    if (Array.isArray(filter.must)) {
      return filter.must.every((condition) =>
        payload?.[condition?.key] === condition?.match?.value
      );
    }

    if (Array.isArray(filter.should)) {
      return filter.should.some((condition) =>
        payload?.[condition?.key] === condition?.match?.value
      );
    }

    return true;
  };

  const getSortedPoints = () =>
    [...pointsById.values()].sort((left, right) =>
      String(left.id).localeCompare(String(right.id))
    );

  const sparseDotProduct = (left, right) => {
    const rightByIndex = new Map();

    for (let index = 0; index < right.indices.length; index += 1) {
      rightByIndex.set(right.indices[index], right.values[index]);
    }

    let score = 0;

    for (let index = 0; index < left.indices.length; index += 1) {
      score += left.values[index] * (rightByIndex.get(left.indices[index]) ?? 0);
    }

    return score;
  };

  const denseDotProduct = (left = [], right = []) =>
    left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

  return {
    get storedConfig() {
      return collectionConfig;
    },
    get storedPoints() {
      return pointsById;
    },
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
            vectors: cloneVector(collectionConfig?.vectors),
            sparse_vectors: cloneVector(collectionConfig?.sparse_vectors),
          },
        },
      };
    },
    async upsert(_collectionName, { points }) {
      for (const point of points) {
        pointsById.set(String(point.id), {
          id: String(point.id),
          payload: clonePayload(point.payload),
          vector: cloneVector(point.vector),
        });
      }

      return { result: true };
    },
    async updateVectors(_collectionName, { points }) {
      for (const point of points) {
        const existing = pointsById.get(String(point.id));

        if (!existing) {
          continue;
        }

        existing.vector = {
          ...existing.vector,
          ...cloneVector(point.vector),
        };
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
    async deleteCollection() {
      collectionConfig = null;
      pointsById.clear();
      return { result: true };
    },
    async scroll(_collectionName, { limit = 10, offset, filter }) {
      const filteredPoints = getSortedPoints().filter((point) =>
        matchesFilter(point.payload, filter)
      );
      const startIndex = offset
        ? filteredPoints.findIndex((point) => String(point.id) === String(offset)) + 1
        : 0;
      const points = filteredPoints
        .slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit)
        .map((point) => ({
          id: point.id,
          payload: clonePayload(point.payload),
        }));
      const nextPoint = filteredPoints[Math.max(startIndex, 0) + limit];

      return {
        points,
        next_page_offset: nextPoint ? nextPoint.id : undefined,
      };
    },
    async query(_collectionName, { query, using, filter, limit = 10 }) {
      const scoredPoints = getSortedPoints()
        .filter((point) => matchesFilter(point.payload, filter))
        .map((point) => {
          const score =
            using === "sparse"
              ? sparseDotProduct(query, point.vector.sparse)
              : denseDotProduct(query, point.vector.dense);

          return {
            id: point.id,
            payload: clonePayload(point.payload),
            score,
          };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);

      return { points: scoredPoints };
    },
  };
};

const createFakeLongMemoryStore = () => {
  const memoriesByUser = new Map();

  const cloneMemory = (memory) => structuredClone(memory);

  const getUserMemories = (userId) => {
    if (!memoriesByUser.has(userId)) {
      memoriesByUser.set(userId, []);
    }

    return memoriesByUser.get(userId);
  };

  return {
    async initialize() {
      return true;
    },
    async list({ userId, limit = 50 }) {
      return getUserMemories(userId).slice(0, limit).map(cloneMemory);
    },
    async remember({
      userId,
      category = "note",
      memoryKey = null,
      memoryValue = null,
      text,
      source = "user_explicit",
      confidence = 1,
    }) {
      const memories = getUserMemories(userId);
      const existingIndex = memories.findIndex((memory) =>
        memoryKey
          ? memory.category === category && memory.memoryKey === memoryKey
          : memory.category === category && memory.text === text
      );
      const now = new Date().toISOString();

      if (existingIndex !== -1) {
        memories[existingIndex] = {
          ...memories[existingIndex],
          memoryValue,
          text,
          source,
          confidence,
          updatedAt: now,
        };

        return cloneMemory(memories[existingIndex]);
      }

      const memory = {
        memoryId: `${userId}-${memories.length + 1}`,
        userId,
        category,
        memoryKey,
        memoryValue,
        text,
        source,
        confidence,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
      };

      memories.unshift(memory);
      return cloneMemory(memory);
    },
    async delete({ userId, memoryId }) {
      const memories = getUserMemories(userId);
      const index = memories.findIndex((memory) => memory.memoryId === memoryId);

      if (index === -1) {
        return null;
      }

      const [deletedMemory] = memories.splice(index, 1);
      return cloneMemory(deletedMemory);
    },
    async clear({ userId }) {
      const count = getUserMemories(userId).length;
      memoriesByUser.set(userId, []);
      return count;
    },
    async touch({ memoryIds }) {
      const now = new Date().toISOString();
      let touchedCount = 0;

      for (const memories of memoriesByUser.values()) {
        for (const memory of memories) {
          if (memoryIds.includes(memory.memoryId)) {
            memory.lastUsedAt = now;
            touchedCount += 1;
          }
        }
      }

      return touchedCount;
    },
  };
};

const createFakeDocumentRegistryStore = () => {
  const documentsById = new Map();
  const filesById = new Map();

  const toStoredDocument = (document = {}, fileBuffer = Buffer.alloc(0)) => {
    const docId = String(document.docId ?? "").trim();
    const publicFilePath = buildPublicFilePath(docId);

    return {
      docId,
      fileName: String(document.fileName ?? "").trim(),
      filePath: publicFilePath,
      publicFilePath,
      mimeType: String(document.mimeType ?? "application/pdf"),
      fileSize:
        Number.parseInt(document.fileSize ?? `${fileBuffer.byteLength}`, 10) ||
        fileBuffer.byteLength,
      chunkCount: Number.parseInt(document.chunkCount ?? "0", 10) || 0,
      pageCount: Number.parseInt(document.pageCount ?? "0", 10) || 0,
      uploadedAt: document.uploadedAt ?? new Date().toISOString(),
      storageBackend: "postgresql",
    };
  };

  return {
    async initialize() {
      return true;
    },
    async list() {
      return [...documentsById.values()].map((document) => structuredClone(document));
    },
    async upsert(document) {
      const fileBuffer = document.fileBuffer
        ? Buffer.from(document.fileBuffer)
        : document.sourceFilePath
          ? await readFile(document.sourceFilePath)
          : Buffer.alloc(0);
      const storedDocument = toStoredDocument(document, fileBuffer);

      documentsById.set(storedDocument.docId, storedDocument);
      filesById.set(storedDocument.docId, {
        fileBuffer,
        fileName: storedDocument.fileName,
        mimeType: storedDocument.mimeType,
        fileSize: storedDocument.fileSize,
      });

      return structuredClone(storedDocument);
    },
    async getFile(docId) {
      const storedDocument = documentsById.get(docId);
      const storedFile = filesById.get(docId);

      if (!storedDocument || !storedFile) {
        return null;
      }

      return {
        document: structuredClone(storedDocument),
        fileBuffer: Buffer.from(storedFile.fileBuffer),
        fileName: storedFile.fileName,
        mimeType: storedFile.mimeType,
        fileSize: storedFile.fileSize,
      };
    },
    async delete(docId) {
      const storedDocument = documentsById.get(docId) ?? null;
      documentsById.delete(docId);
      filesById.delete(docId);
      return storedDocument ? structuredClone(storedDocument) : null;
    },
    async clear() {
      documentsById.clear();
      filesById.clear();
      return true;
    },
    async reset() {
      documentsById.clear();
      filesById.clear();
      return true;
    },
  };
};

const createFakeSessionMemoryStore = () => {
  const sessionsById = new Map();

  const cloneSession = (session) =>
    session
      ? {
          updatedAt: Number(session.updatedAt ?? Date.now()),
          messages: structuredClone(session.messages ?? []),
        }
      : null;

  return {
    async initialize() {
      return true;
    },
    async get(sessionId) {
      return cloneSession(sessionsById.get(sessionId) ?? null);
    },
    async upsert({ sessionId, messages, updatedAt = Date.now() }) {
      const session = {
        updatedAt,
        messages: structuredClone(messages ?? []),
      };

      sessionsById.set(sessionId, session);
      return cloneSession(session);
    },
    async delete(sessionId) {
      return sessionsById.delete(sessionId);
    },
    async reset() {
      sessionsById.clear();
      return true;
    },
  };
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

const buildComparisonAnalysis = ({ query, entries }) => {
  const documents = entries.map((entry) => ({
    docId: entry.docId,
    fileName: entry.fileName,
  }));
  const perDocumentResults = new Map(
    entries.map((entry) => [
      entry.docId,
      (entry.pageContents ?? []).map((pageContent, index) => ({
        document: {
          id: `${entry.docId}:${index}`,
          pageContent,
          metadata: {
            docId: entry.docId,
            fileName: entry.fileName,
            pageNumber: index + 1,
            chunkIndex: index,
          },
        },
        score: entry.scores?.[index] ?? 0.9,
      })),
    ])
  );

  const alignment = alignComparisonEvidence({
    query,
    documents,
    perDocumentResults,
  });

  return analyzeComparison({
    alignment,
  });
};

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentai-rag-test-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  await resetDocumentRegistryStore();
  configureDocumentRegistryStore(createFakeDocumentRegistryStore());
  await resetDocumentRegistry();
  resetVectorStore();
  await resetSessionMemoryStore();
  configureSessionMemoryStore(createFakeSessionMemoryStore());
  resetSessionMemory();
  await resetLongMemoryStore();
  configureOpenAIProvider(provider);
  resetQdrantClientFactory();
});

afterEach(async () => {
  await clearDocuments({
    deleteFiles: false,
  });
  await resetSessionMemoryStore();
  await resetLongMemoryStore();
  resetVectorStore();
  await resetDocumentRegistryStore();
  resetOpenAIProvider();
  resetQdrantClientFactory();
  configureRagDataDirectory(originalDataDirectory);
  await resetSessionMemoryStore();
  resetVectorStore();
  await resetDocumentRegistryStore();

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

    await recordSessionTurn({
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

test("chat stores explicit long-term preferences and injects them into later prompts", async () => {
  const originalLongMemoryEnabled = process.env.RAG_LONG_MEMORY_ENABLED;
  const fakeLongMemoryStore = createFakeLongMemoryStore();
  const capturedPrompts = [];

  process.env.RAG_LONG_MEMORY_ENABLED = "true";
  configureLongMemoryStore(fakeLongMemoryStore);
  configureOpenAIProvider({
    ...provider,
    completeText: async (prompt) => {
      capturedPrompts.push(prompt);
      return "Grounded answer based on Source 1.";
    },
  });

  try {
    await ingestFixture({
      docId: "benefits-memory",
      fileName: "benefits-memory.pdf",
      pages: [
        "Remote work policy: employees may work remotely 2 days per week with manager approval.",
      ],
    });

    await chat(["benefits-memory"], "以后用中文回答", {
      userId: "user-memory",
    });

    const storedMemories = await listLongMemories({
      userId: "user-memory",
    });

    assert.ok(
      storedMemories.some(
        (memory) =>
          memory.category === "preference" &&
          memory.memoryKey === "reply_language" &&
          memory.memoryValue === "zh"
      )
    );

    capturedPrompts.length = 0;

    await chat(["benefits-memory"], "What is the remote work policy?", {
      userId: "user-memory",
    });

    assert.ok(
      capturedPrompts.some((prompt) => prompt.includes("Reply language: Chinese."))
    );
  } finally {
    if (originalLongMemoryEnabled === undefined) {
      delete process.env.RAG_LONG_MEMORY_ENABLED;
    } else {
      process.env.RAG_LONG_MEMORY_ENABLED = originalLongMemoryEnabled;
    }

    configureOpenAIProvider(provider);
    await resetLongMemoryStore();
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
  assert.doesNotMatch(response.text, /No evidence-backed material differences were found/i);
  assert.equal(citedDocIds.size, 2);
  assert.ok(citedDocIds.has("benefits-2024"));
  assert.ok(citedDocIds.has("benefits-2025"));
});

test("near-duplicate compare flow short-circuits to no material difference", async () => {
  await ingestFixture({
    docId: "handbook-alpha",
    fileName: "handbook-alpha.pdf",
    pages: [
      "Remote work policy: employees may work remotely 2 days per week with manager approval.",
    ],
  });
  await ingestFixture({
    docId: "handbook-beta",
    fileName: "handbook-beta.pdf",
    pages: [
      "Remote work policy: employees may work remotely 2 days per week with manager approval.",
    ],
  });

  const response = await chat(
    ["handbook-alpha", "handbook-beta"],
    "Compare the remote work policy."
  );
  const citedDocIds = new Set(response.citations.map((citation) => citation.docId));

  assert.match(response.text, /No evidence-backed material differences were found/i);
  assert.match(response.text, /2 days per week with manager approval/i);
  assert.doesNotMatch(response.text, /The weekly day limit differs/i);
  assert.doesNotMatch(response.text, /Gaps or uncertainty:/i);
  assert.equal(citedDocIds.size, 2);
  assert.ok(citedDocIds.has("handbook-alpha"));
  assert.ok(citedDocIds.has("handbook-beta"));
});

test("near-duplicate guard can be disabled to preserve baseline compare behavior", async () => {
  const originalNearDuplicateGuard = process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED;

  process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED = "false";

  try {
    await ingestFixture({
      docId: "handbook-alpha",
      fileName: "handbook-alpha.pdf",
      pages: [
        "Remote work policy: employees may work remotely 2 days per week with manager approval.",
      ],
    });
    await ingestFixture({
      docId: "handbook-beta",
      fileName: "handbook-beta.pdf",
      pages: [
        "Remote work policy: employees may work remotely 2 days per week with manager approval.",
      ],
    });

    const response = await chat(
      ["handbook-alpha", "handbook-beta"],
      "Compare the remote work policy."
    );

    assert.doesNotMatch(
      response.text,
      /No evidence-backed material differences were found/i
    );
    assert.match(response.text, /The weekly day limit differs/i);
  } finally {
    if (originalNearDuplicateGuard === undefined) {
      delete process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED;
    } else {
      process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED = originalNearDuplicateGuard;
    }
  }
});

test("comparison analysis does not short-circuit when no comparable evidence exists", () => {
  const analysis = buildComparisonAnalysis({
    query: "Compare the remote work policy.",
    entries: [
      {
        docId: "handbook-alpha",
        fileName: "handbook-alpha.pdf",
        pageContents: [],
      },
      {
        docId: "handbook-beta",
        fileName: "handbook-beta.pdf",
        pageContents: [],
      },
    ],
  });

  assert.equal(analysis.pairwiseAnalysis.length, 0);
  assert.equal(analysis.shouldShortCircuitNoMaterialDifference, false);
  assert.equal(analysis.nearDuplicatePairs.length, 0);
  assert.equal(analysis.explicitConflictPairs.length, 0);
});

test("comparison analysis marks identical evidence as strong near-duplicate without conflicts", () => {
  const analysis = buildComparisonAnalysis({
    query: "Compare the remote work policy.",
    entries: [
      {
        docId: "handbook-alpha",
        fileName: "handbook-alpha.pdf",
        pageContents: [
          "Remote work policy: employees may work remotely 2 days per week with manager approval.",
        ],
      },
      {
        docId: "handbook-beta",
        fileName: "handbook-beta.pdf",
        pageContents: [
          "Remote work policy: employees may work remotely 2 days per week with manager approval.",
        ],
      },
    ],
  });

  assert.equal(analysis.pairwiseAnalysis.length, 1);
  assert.equal(analysis.pairwiseAnalysis[0].strongNearDuplicate, true);
  assert.equal(analysis.pairwiseAnalysis[0].explicitConflict, false);
  assert.equal(analysis.likelyNoMaterialDifferencePairs.length, 1);
  assert.equal(analysis.shouldShortCircuitNoMaterialDifference, true);
});

test("comparison analysis detects explicit conflicts for near-duplicate evidence with different numbers", () => {
  const analysis = buildComparisonAnalysis({
    query: "Compare the remote work policy.",
    entries: [
      {
        docId: "benefits-2024",
        fileName: "benefits-2024.pdf",
        pageContents: [
          "Remote work policy: employees may work remotely 2 days per week with manager approval.",
        ],
      },
      {
        docId: "benefits-2025",
        fileName: "benefits-2025.pdf",
        pageContents: [
          "Remote work policy: employees may work remotely 3 days per week with manager approval.",
        ],
      },
    ],
  });

  assert.equal(analysis.pairwiseAnalysis.length, 1);
  assert.equal(analysis.pairwiseAnalysis[0].nearDuplicate, true);
  assert.equal(analysis.pairwiseAnalysis[0].explicitConflict, true);
  assert.equal(analysis.explicitConflictPairs.length, 1);
  assert.equal(analysis.shouldShortCircuitNoMaterialDifference, false);
});

test("comparison analysis keeps mixed duplicate and conflict evidence from short-circuiting", () => {
  const analysis = buildComparisonAnalysis({
    query: "Compare the remote work policy.",
    entries: [
      {
        docId: "handbook-alpha",
        fileName: "handbook-alpha.pdf",
        pageContents: [
          "Remote work policy: employees may work remotely 2 days per week with manager approval.",
        ],
      },
      {
        docId: "handbook-beta",
        fileName: "handbook-beta.pdf",
        pageContents: [
          "Remote work policy: employees may work remotely 2 days per week with manager approval.",
        ],
      },
      {
        docId: "handbook-gamma",
        fileName: "handbook-gamma.pdf",
        pageContents: [
          "Remote work policy: employees may work remotely 3 days per week with manager approval.",
        ],
      },
    ],
  });

  assert.equal(analysis.pairwiseAnalysis.length, 3);
  assert.equal(analysis.likelyNoMaterialDifferencePairs.length, 1);
  assert.equal(analysis.explicitConflictPairs.length, 2);
  assert.equal(analysis.shouldShortCircuitNoMaterialDifference, false);
});

test("comparison source bundle prefers differentiating extra evidence over shared extras", () => {
  const documents = [
    {
      docId: "alpha",
      fileName: "alpha.pdf",
    },
    {
      docId: "beta",
      fileName: "beta.pdf",
    },
  ];
  const perDocumentResults = new Map([
    [
      "alpha",
      [
        {
          document: {
            id: "alpha:0",
            pageContent:
              "Remote work policy: employees may work remotely 2 days per week.",
            metadata: {
              docId: "alpha",
              fileName: "alpha.pdf",
              pageNumber: 1,
              chunkIndex: 0,
            },
          },
          score: 0.99,
        },
        {
          document: {
            id: "alpha:1",
            pageContent:
              "Shared rule: security checklists must be completed before each remote day.",
            metadata: {
              docId: "alpha",
              fileName: "alpha.pdf",
              pageNumber: 2,
              chunkIndex: 1,
            },
          },
          score: 0.96,
        },
        {
          document: {
            id: "alpha:2",
            pageContent:
              "Alpha equipment rule: monitor reimbursement needs manager sign-off.",
            metadata: {
              docId: "alpha",
              fileName: "alpha.pdf",
              pageNumber: 3,
              chunkIndex: 2,
            },
          },
          score: 0.95,
        },
      ],
    ],
    [
      "beta",
      [
        {
          document: {
            id: "beta:0",
            pageContent:
              "Remote work policy: employees may work remotely 3 days per week.",
            metadata: {
              docId: "beta",
              fileName: "beta.pdf",
              pageNumber: 1,
              chunkIndex: 0,
            },
          },
          score: 0.99,
        },
        {
          document: {
            id: "beta:1",
            pageContent:
              "Shared rule: security checklists must be completed before each remote day.",
            metadata: {
              docId: "beta",
              fileName: "beta.pdf",
              pageNumber: 2,
              chunkIndex: 1,
            },
          },
          score: 0.96,
        },
        {
          document: {
            id: "beta:2",
            pageContent:
              "Beta equipment rule: monitor reimbursement needs finance sign-off.",
            metadata: {
              docId: "beta",
              fileName: "beta.pdf",
              pageNumber: 3,
              chunkIndex: 2,
            },
          },
          score: 0.95,
        },
      ],
    ],
  ]);
  const alignment = alignComparisonEvidence({
    query: "Compare the remote work policy and equipment approval in these documents.",
    documents,
    perDocumentResults,
  });
  const bundle = prepareComparisonSourceBundle({
    alignment,
  });
  const retrievedTexts = bundle.retrievedContexts.map((context) => context.text);

  assert.equal(retrievedTexts.length, 4);
  assert.ok(
    retrievedTexts.some((text) =>
      text.includes("Alpha equipment rule: monitor reimbursement needs manager sign-off.")
    )
  );
  assert.ok(
    retrievedTexts.some((text) =>
      text.includes("Beta equipment rule: monitor reimbursement needs finance sign-off.")
    )
  );
  assert.equal(
    retrievedTexts.filter((text) =>
      text.includes("Shared rule: security checklists must be completed before each remote day.")
    ).length,
    0
  );
});

test("comparison analysis does not mark unrelated evidence as near-duplicate", () => {
  const analysis = buildComparisonAnalysis({
    query: "Compare the remote work policy.",
    entries: [
      {
        docId: "remote-policy",
        fileName: "remote-policy.pdf",
        pageContents: [
          "Remote work policy: employees may work remotely 2 days per week with manager approval.",
        ],
      },
      {
        docId: "badge-manual",
        fileName: "badge-manual.pdf",
        pageContents: [
          "Badge renewal window: renew access badges every 14 months after the last audit.",
        ],
      },
    ],
  });

  assert.equal(analysis.pairwiseAnalysis.length, 1);
  assert.equal(analysis.pairwiseAnalysis[0].nearDuplicate, false);
  assert.equal(analysis.nearDuplicatePairs.length, 0);
  assert.equal(analysis.shouldShortCircuitNoMaterialDifference, false);
});

test("compare flow abstains when only one selected document has strong evidence", async () => {
  await ingestFixture({
    docId: "benefits-2024",
    fileName: "benefits-2024.pdf",
    pages: [
      "Remote work policy: employees may work remotely 2 days per week with manager approval.",
    ],
  });
  await ingestFixture({
    docId: "travel-guide",
    fileName: "travel-guide.pdf",
    pages: [
      "Travel reimbursement policy: meals are capped at 40 dollars per day.",
    ],
  });

  const response = await chat(
    ["benefits-2024", "travel-guide"],
    "Compare the remote work policy."
  );

  assert.equal(response.abstained, true);
  assert.match(response.abstainReason, /comparison would be unreliable|selected documents to compare/i);
});

test("near-duplicate compare flow short-circuits across three highly similar documents", async () => {
  await ingestFixture({
    docId: "manual-alpha",
    fileName: "manual-alpha.pdf",
    pages: [
      "Badge renewal window: renew access badges every 12 months after the last successful audit.",
    ],
  });
  await ingestFixture({
    docId: "manual-beta",
    fileName: "manual-beta.pdf",
    pages: [
      "Badge renewal window: renew access badges every 12 months after the last successful audit.",
    ],
  });
  await ingestFixture({
    docId: "manual-gamma",
    fileName: "manual-gamma.pdf",
    pages: [
      "Badge renewal window: renew access badges every 12 months after the last successful audit.",
    ],
  });

  const response = await chat(
    ["manual-alpha", "manual-beta", "manual-gamma"],
    "Compare the badge renewal window."
  );
  const citedDocIds = new Set(response.citations.map((citation) => citation.docId));

  assert.match(response.text, /No evidence-backed material differences were found/i);
  assert.match(response.text, /12 months after the last successful audit/i);
  assert.doesNotMatch(response.text, /Gaps or uncertainty:/i);
  assert.equal(citedDocIds.size, 3);
  assert.ok(citedDocIds.has("manual-alpha"));
  assert.ok(citedDocIds.has("manual-beta"));
  assert.ok(citedDocIds.has("manual-gamma"));
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

test("qdrant provider keeps dense and sparse vectors in the same collection", async () => {
  const originalProvider = process.env.VECTOR_STORE_PROVIDER;
  const originalHybridEnabled = process.env.RAG_HYBRID_ENABLED;
  const originalSparseTopK = process.env.RAG_SPARSE_TOP_K;
  const originalDenseWeight = process.env.RAG_HYBRID_DENSE_WEIGHT;
  const originalSparseWeight = process.env.RAG_HYBRID_SPARSE_WEIGHT;
  const fakeClient = createFakeQdrantClient();

  process.env.VECTOR_STORE_PROVIDER = "qdrant";
  process.env.RAG_HYBRID_ENABLED = "true";
  process.env.RAG_SPARSE_TOP_K = "4";
  process.env.RAG_HYBRID_DENSE_WEIGHT = "0.1";
  process.env.RAG_HYBRID_SPARSE_WEIGHT = "0.9";

  configureQdrantClientFactory(() => fakeClient);
  resetVectorStore();
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
    assert.ok(fakeClient.storedConfig?.vectors?.dense);
    assert.ok(fakeClient.storedConfig?.sparse_vectors?.sparse !== undefined);

    for (const point of fakeClient.storedPoints.values()) {
      assert.ok(Array.isArray(point.vector?.dense));
      assert.ok(Array.isArray(point.vector?.sparse?.indices));
      assert.ok(Array.isArray(point.vector?.sparse?.values));
    }
  } finally {
    if (originalProvider === undefined) {
      delete process.env.VECTOR_STORE_PROVIDER;
    } else {
      process.env.VECTOR_STORE_PROVIDER = originalProvider;
    }

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

    resetQdrantClientFactory();
    configureOpenAIProvider(provider);
    resetVectorStore();
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

  assert.equal(response.abstained, true);
  assert.ok(response.gapPlan);
  assert.match(response.text, /parental leave|reliable evidence/i);
  assert.match(response.abstainReason, /parental leave|reliable evidence/i);
  assert.ok(response.gapPlan.missingAspects.length > 0);
  assert.equal("possibleLocations" in response.gapPlan, false);
  assert.equal(response.citations.length, 0);
});

test("gap planner points to likely sections and follow-up questions", () => {
  const gapPlan = planQaEvidenceGap({
    query: "When does the refund policy take effect and which regions does it apply to?",
    results: [
      {
        document: {
          id: "refund:0",
          pageContent:
            "Refund policy: unopened products may be returned with a receipt.",
          metadata: {
            docId: "refund",
            fileName: "refund-guide.pdf",
            pageNumber: 3,
            chunkIndex: 0,
            sectionHeading: "Refund Policy",
            publicFilePath: "/uploads/refund-guide.pdf",
          },
        },
        score: 0.92,
        keywordScore: 0.71,
      },
      {
        document: {
          id: "refund:1",
          pageContent: "Implementation notes for store staff.",
          metadata: {
            docId: "refund",
            fileName: "refund-guide.pdf",
            pageNumber: 7,
            chunkIndex: 1,
            sectionHeading: "Effective Date",
            publicFilePath: "/uploads/refund-guide.pdf",
          },
        },
        score: 0.56,
        keywordScore: 0.33,
      },
      {
        document: {
          id: "refund:2",
          pageContent: "Operational checklist for the support team.",
          metadata: {
            docId: "refund",
            fileName: "refund-guide.pdf",
            pageNumber: 8,
            chunkIndex: 2,
            sectionHeading: "Scope",
            publicFilePath: "/uploads/refund-guide.pdf",
          },
        },
        score: 0.51,
        keywordScore: 0.31,
      },
    ],
    confidence: {
      reason: "I couldn't find enough grounded evidence in the uploaded documents to answer reliably.",
    },
  });

  assert.match(gapPlan.summary, /refund/i);
  assert.ok(
    gapPlan.missingAspects.some((aspect) =>
      /effective date or timing/i.test(aspect.label)
    )
  );
  assert.ok(
    gapPlan.missingAspects.some((aspect) =>
      /scope, audience, or region/i.test(aspect.label)
    )
  );
  assert.ok(gapPlan.possibleLocations.some((location) => location.pageNumber === 7));
  assert.ok(gapPlan.possibleLocations.some((location) => location.pageNumber === 8));
  assert.ok(gapPlan.supplementalQueries.length >= 2);
  assert.equal("suggestedQuestions" in gapPlan, false);
});

test("code-like anchors must appear in evidence before qa answers proceed", async () => {
  await ingestFixture({
    docId: "catalog-alpha",
    fileName: "catalog-alpha.pdf",
    pages: [
      "NULPAR-AX allocation amount is 180 dollars per cycle.",
      "NULPAR-BQ allocation amount is 260 dollars per cycle.",
      "NULPAR-CR allocation amount is 340 dollars per cycle.",
    ],
  });

  const response = await chat(
    ["catalog-alpha"],
    "What is the NULPAR-DZ allocation amount?"
  );

  assert.equal(response.abstained, true);
  assert.match(response.abstainReason, /NULPAR-DZ/i);
  assert.equal(response.citations.length, 0);
});

test("qa abstain path runs supplemental retrieval to improve gap suggestions", async () => {
  const originalTopK = process.env.RAG_RETRIEVAL_TOP_K;

  process.env.RAG_RETRIEVAL_TOP_K = "1";

  try {
    await ingestFixture({
      docId: "refund-manual",
      fileName: "refund-manual.pdf",
      pages: [
        "Refund Policy\n\nUnopened products may be returned with a receipt.",
        "Refund Procedure\n\nCustomers should contact support before shipping a return.",
        "Refund Procedure\n\nStore managers must inspect the product before approval.",
        "Refund Procedure\n\nRefunds are issued back to the original payment method.",
        "Refund Procedure\n\nDamaged packaging alone does not qualify for a refund.",
        "Refund Procedure\n\nSupport teams track each return in the internal tool.",
        "Effective Date\n\nThis policy was approved by operations leadership.",
        "Scope\n\nThis policy is used by regional support teams.",
      ],
    });

    const response = await chat(
      ["refund-manual"],
      "When does the refund policy take effect and which regions does it apply to?"
    );

    assert.equal(response.abstained, true);
    assert.ok(response.gapPlan);
    assert.ok(response.gapPlan.supplementalSearches.length >= 2);
    assert.ok(
      response.gapPlan.missingAspects.some((aspect) =>
        /effective date or timing/i.test(aspect.label)
      )
    );
    assert.ok(
      response.gapPlan.supplementalSearches.some((search) =>
        /scope, audience, or region/i.test(search.label)
      )
    );
    assert.equal("possibleLocations" in response.gapPlan, false);
  } finally {
    if (originalTopK === undefined) {
      delete process.env.RAG_RETRIEVAL_TOP_K;
    } else {
      process.env.RAG_RETRIEVAL_TOP_K = originalTopK;
    }
  }
});

test("persisted registry, vector data, and session memory survive reloads", async () => {
  await ingestFixture({
    docId: "benefits-2025",
    fileName: "benefits-2025.pdf",
    pages: [
      "Remote work policy: employees may work remotely 3 days per week with manager approval.",
    ],
  });

  await recordSessionTurn({
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
