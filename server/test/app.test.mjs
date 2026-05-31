import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import {
  buildQualityGateDecision,
  buildQualityHistoryResponse,
} from "../evaluation/quality-report.js";

const okHealthService = {
  buildHealthReport: async () => ({
    status: "ok",
    checks: {},
  }),
  runStartupHealthChecks: async () => ({
    status: "ok",
    checks: {},
  }),
};

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
};

test("upload flow stores chunks, completes ingestion, and deletes documents", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentai-app-test-"));
  const uploadsDirectory = path.join(tempRoot, "uploads");
  const uploadSessionDirectory = path.join(tempRoot, "upload-sessions");
  const documents = new Map();
  let mergedContent = null;

  const ragService = {
    chat: async () => ({
      text: "stub",
      citations: [],
    }),
    clearDocuments: async () => {
      const cleared = [...documents.values()];
      documents.clear();
      return cleared;
    },
    clearSessionMemory: () => true,
    deleteDocument: async (docId) => {
      const document = documents.get(docId) ?? null;
      documents.delete(docId);
      return document;
    },
    getDocument: (docId) => documents.get(docId) ?? null,
    getDocumentFile: async (docId) => {
      const document = documents.get(docId);

      if (!document) {
        return null;
      }

      return {
        document,
        fileBuffer: Buffer.from(mergedContent ?? "", "utf8"),
        fileName: document.fileName,
        mimeType: "application/pdf",
        fileSize: Buffer.byteLength(mergedContent ?? "", "utf8"),
      };
    },
    ingestDocument: async ({ docId, filePath, fileName }) => {
      mergedContent = await readFile(filePath, "utf8");
      const document = {
        docId,
        fileName,
        filePath: `documents/${docId}/file`,
        publicFilePath: `documents/${docId}/file`,
        fileSize: Buffer.byteLength(mergedContent ?? "", "utf8"),
        pageCount: 1,
        chunkCount: 1,
        uploadedAt: new Date().toISOString(),
        storageBackend: "postgresql",
      };

      documents.set(docId, document);
      return document;
    },
    initializeDocumentRegistry: async () => [],
    initializeSessionMemory: async () => true,
    listDocuments: () => [...documents.values()],
  };

  const app = await createApp({
    ragService,
    chatMcp: async () => ({
      text: "web",
    }),
    healthService: okHealthService,
    uploadSessionDirectory,
    uploadsDirectory,
  });
  const server = await startServer(app);

  try {
    const fileId = "test-file-id";
    const content = "fake-pdf-content";

    let response = await fetch(`${server.baseUrl}/upload/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileId,
        fileName: "notes.pdf",
        fileSize: content.length,
        lastModified: 0,
        totalChunks: 2,
        chunkSize: 8,
      }),
    });

    assert.equal(response.status, 201);

    const chunkOne = new FormData();
    chunkOne.append("fileId", fileId);
    chunkOne.append("chunkIndex", "0");
    chunkOne.append("totalChunks", "2");
    chunkOne.append("chunk", new Blob([content.slice(0, 8)]), "notes.pdf.part-0");

    response = await fetch(`${server.baseUrl}/upload/chunk`, {
      method: "POST",
      body: chunkOne,
    });

    assert.equal(response.status, 201);

    const chunkTwo = new FormData();
    chunkTwo.append("fileId", fileId);
    chunkTwo.append("chunkIndex", "1");
    chunkTwo.append("totalChunks", "2");
    chunkTwo.append("chunk", new Blob([content.slice(8)]), "notes.pdf.part-1");

    response = await fetch(`${server.baseUrl}/upload/chunk`, {
      method: "POST",
      body: chunkTwo,
    });

    assert.equal(response.status, 201);

    response = await fetch(`${server.baseUrl}/upload/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileId,
      }),
    });

    assert.equal(response.status, 201);
    const uploadedDocument = await response.json();
    assert.equal(uploadedDocument.fileName, "notes.pdf");
    assert.equal(mergedContent, content);

    response = await fetch(`${server.baseUrl}/documents`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).length, 1);

    response = await fetch(
      `${server.baseUrl}/documents/${uploadedDocument.docId}`,
      {
        method: "DELETE",
      }
    );

    assert.equal(response.status, 200);
    assert.equal(documents.size, 0);
  } finally {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("chat endpoint exposes explicit rag abstain fields", async () => {
  const documents = new Map([
    [
      "doc-1",
      {
        docId: "doc-1",
        fileName: "notes.pdf",
      },
    ],
  ]);
  const app = await createApp({
    ragService: {
      chat: async () => ({
        text: 'I found related material, but I still cannot confirm "NULPAR-DZ" reliably.',
        citations: [],
        abstained: true,
        abstainReason:
          'I found related material, but I still cannot confirm "NULPAR-DZ" reliably.',
        resolvedQuery: "What is the NULPAR-DZ allocation amount?",
        memoryApplied: false,
        gapPlan: {
          missingAspects: [
            {
              label: "NULPAR-DZ",
            },
          ],
          supplementalSearches: [],
        },
      }),
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: (docId) => documents.get(docId) ?? null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [...documents.values()],
    },
    chatMcp: async () => ({
      text: "web",
    }),
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        docId: "doc-1",
        question: "What is the NULPAR-DZ allocation amount?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.ragAbstained, true);
    assert.match(body.ragAbstainReason, /NULPAR-DZ/);
    assert.equal(body.ragResolvedQuestion, "What is the NULPAR-DZ allocation amount?");
    assert.equal(body.ragGapPlan.missingAspects[0].label, "NULPAR-DZ");
    assert.equal("possibleLocations" in body.ragGapPlan, false);
  } finally {
    await server.close();
  }
});

test("chat endpoint returns unified agent answer and trace while preserving legacy fields", async () => {
  const documents = new Map([
    [
      "doc-1",
      {
        docId: "doc-1",
        fileName: "notes.pdf",
      },
    ],
  ]);
  const app = await createApp({
    ragService: {
      chat: async () => ({
        text: "The archive says annual leave is 15 days. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "notes.pdf",
            pageNumber: 2,
            chunkIndex: 0,
            excerpt: "Annual leave is 15 days.",
          },
        ],
        abstained: false,
        resolvedQuery: "What is annual leave?",
        memoryApplied: false,
      }),
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: (docId) => documents.get(docId) ?? null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [...documents.values()],
    },
    chatMcp: async () => ({
      text: "web should not be required",
    }),
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        docId: "doc-1",
        question: "What is annual leave?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.agentMode, "document");
    assert.equal(body.agentAnswer, body.ragAnswer);
    assert.equal(body.ragAnswer, "The archive says annual leave is 15 days. [Source 1]");
    assert.equal(body.mcpAnswer, "Web search not used: document evidence was sufficient.");
    assert.ok(Array.isArray(body.agentTrace));
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      ["plan", "document_rag", "synthesis"]
    );
    assert.equal(body.agentTrace.every((step) => step.status === "completed"), true);
  } finally {
    await server.close();
  }
});

test("chat endpoint agent falls back to web when document evidence is insufficient", async () => {
  const documents = new Map([
    [
      "doc-1",
      {
        docId: "doc-1",
        fileName: "notes.pdf",
      },
    ],
  ]);
  const app = await createApp({
    ragService: {
      chat: async () => ({
        text: "I found related material, but cannot confirm the launch date.",
        citations: [],
        abstained: true,
        abstainReason: "I found related material, but cannot confirm the launch date.",
        resolvedQuery: "What is the latest launch date?",
        memoryApplied: false,
      }),
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: (docId) => documents.get(docId) ?? null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [...documents.values()],
    },
    chatMcp: async () => ({
      text: "The public launch date is May 30, 2026.",
    }),
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        docId: "doc-1",
        question: "What is the latest launch date?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.agentMode, "document_web");
    assert.match(body.agentAnswer, /Document evidence/i);
    assert.match(body.agentAnswer, /Web context/i);
    assert.match(body.agentAnswer, /May 30, 2026/);
    assert.equal(body.ragAbstained, true);
    assert.equal(body.mcpAnswer, "The public launch date is May 30, 2026.");
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      ["plan", "document_rag", "web_search", "synthesis"]
    );
  } finally {
    await server.close();
  }
});

test("chat endpoint agent can answer workspace inventory without selected documents", async () => {
  const app = await createApp({
    ragService: {
      chat: async () => {
        throw new Error("Document RAG should not run for inventory prompts.");
      },
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: () => null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [
        {
          docId: "doc-1",
          fileName: "benefits.pdf",
          pageCount: 12,
          chunkCount: 20,
        },
      ],
    },
    chatMcp: async () => {
      throw new Error("Web search should not run for inventory prompts.");
    },
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: "What documents are indexed?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.agentMode, "inventory");
    assert.match(body.agentAnswer, /benefits\.pdf/);
    assert.equal(body.ragAnswer, "");
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      ["plan", "inventory", "synthesis"]
    );
  } finally {
    await server.close();
  }
});

test("chat endpoint agent discovers relevant documents from profile metadata", async () => {
  const app = await createApp({
    ragService: {
      chat: async () => {
        throw new Error("Document RAG should not run for workspace discovery prompts.");
      },
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: () => null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [
        {
          docId: "doc-remote",
          fileName: "remote-work.pdf",
          summary: "Remote work approvals, weekly remote days, and manager review.",
          tags: ["remote", "approval", "work"],
          entities: ["Remote Work"],
          profile: {
            summary: "Remote work approvals, weekly remote days, and manager review.",
            tags: ["remote", "approval", "work"],
            entities: ["Remote Work"],
          },
        },
        {
          docId: "doc-security",
          fileName: "security.pdf",
          summary: "MFA, encryption, and device security requirements.",
          tags: ["security", "mfa", "encryption"],
          entities: ["MFA"],
          profile: {
            summary: "MFA, encryption, and device security requirements.",
            tags: ["security", "mfa", "encryption"],
            entities: ["MFA"],
          },
        },
      ],
    },
    chatMcp: async () => {
      throw new Error("Web search should not run for workspace discovery prompts.");
    },
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: "Which document covers remote work approval?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.agentMode, "document_discovery");
    assert.match(body.agentAnswer, /remote-work\.pdf/);
    assert.doesNotMatch(body.agentAnswer, /security\.pdf/);
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      ["plan", "document_discovery", "synthesis"]
    );
  } finally {
    await server.close();
  }
});

test("chat endpoint agent returns a structured research brief", async () => {
  const documents = new Map([
    [
      "doc-contract",
      {
        docId: "doc-contract",
        fileName: "refund-contract.pdf",
        summary: "Refund terms, customer notice windows, and fee exceptions.",
        tags: ["refund", "contract", "risk"],
        entities: ["Refund"],
        profile: {
          summary: "Refund terms, customer notice windows, and fee exceptions.",
          tags: ["refund", "contract", "risk"],
          entities: ["Refund"],
        },
      },
    ],
  ]);
  const askedQuestions = [];
  const app = await createApp({
    ragService: {
      chat: async (_docIds, query) => {
        askedQuestions.push(query);

        return {
          text: `Finding for ${query}: refunds require 30 days notice. [Source 1]`,
          citations: [
            {
              rank: 1,
              docId: "doc-contract",
              fileName: "refund-contract.pdf",
              pageNumber: 4,
              chunkIndex: askedQuestions.length,
              excerpt: "Refunds require 30 days notice.",
            },
          ],
          abstained: false,
          resolvedQuery: query,
          memoryApplied: false,
        };
      },
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: (docId) => documents.get(docId) ?? null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [...documents.values()],
    },
    chatMcp: async () => {
      throw new Error("Web search should not run for document-grounded research briefs.");
    },
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        docId: "doc-contract",
        question: "Create a research brief about refund risk.",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.agentMode, "research_brief");
    assert.ok(askedQuestions.length >= 3);
    assert.match(body.agentAnswer, /Executive Summary/i);
    assert.match(body.agentAnswer, /Key Findings/i);
    assert.equal(body.researchBrief.topic, "Create a research brief about refund risk.");
    assert.equal(body.researchBrief.questions.length, askedQuestions.length);
    assert.equal(body.ragSources.length, askedQuestions.length);
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      ["plan", "research_plan", "research_question", "research_question", "research_question", "synthesis"]
    );
  } finally {
    await server.close();
  }
});

test("chat endpoint research brief requests require selected documents", async () => {
  const app = await createApp({
    ragService: {
      chat: async () => {
        throw new Error("Document RAG should not run without selected documents.");
      },
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: () => null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
    },
    chatMcp: async () => ({
      text: "web",
    }),
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: "Create a research brief about refund risk.",
      }),
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /At least one docId is required/i);
  } finally {
    await server.close();
  }
});

test("memory endpoints list, create, and delete long-term memories", async () => {
  const memories = [
    {
      memoryId: "memory-1",
      userId: "user-1",
      category: "preference",
      memoryKey: "reply_language",
      memoryValue: "zh",
      text: "Reply in Chinese by default.",
      source: "user_explicit",
      confidence: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
    },
  ];
  const app = await createApp({
    ragService: {
      listLongMemories: async ({ userId }) =>
        memories.filter((memory) => memory.userId === userId),
      rememberLongMemory: async ({ userId, text, category, memoryKey, memoryValue }) => {
        const memory = {
          memoryId: "memory-2",
          userId,
          category: category ?? "note",
          memoryKey: memoryKey ?? null,
          memoryValue: memoryValue ?? null,
          text,
          source: "user_explicit",
          confidence: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUsedAt: null,
        };

        memories.push(memory);
        return memory;
      },
      deleteLongMemory: async ({ userId, memoryId }) => {
        const memoryIndex = memories.findIndex(
          (memory) => memory.userId === userId && memory.memoryId === memoryId
        );

        if (memoryIndex === -1) {
          return null;
        }

        const [deletedMemory] = memories.splice(memoryIndex, 1);
        return deletedMemory;
      },
      clearLongMemories: async ({ userId }) => {
        const matchingMemories = memories.filter((memory) => memory.userId === userId);
        memories.splice(
          0,
          memories.length,
          ...memories.filter((memory) => memory.userId !== userId)
        );
        return matchingMemories.length;
      },
      initializeSessionMemory: async () => true,
      initializeDocumentRegistry: async () => [],
    },
    chatMcp: async () => ({
      text: "web",
    }),
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/memory?userId=user-1`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).memories.length, 1);

    response = await fetch(`${server.baseUrl}/memory`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        text: "Keep answers concise by default.",
        category: "preference",
        memoryKey: "answer_style",
        memoryValue: "concise",
      }),
    });

    assert.equal(response.status, 201);
    assert.equal((await response.json()).memory.memoryId, "memory-2");

    response = await fetch(`${server.baseUrl}/memory/memory-2?userId=user-1`, {
      method: "DELETE",
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).deleted, true);

    response = await fetch(`${server.baseUrl}/memory?userId=user-1`, {
      method: "DELETE",
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).deletedCount, 1);
  } finally {
    await server.close();
  }
});

test("health and ready endpoints expose startup status", async () => {
  const healthService = {
    buildHealthReport: async () => ({
      status: "error",
      checkedAt: new Date().toISOString(),
      checks: {
        vectorStore: {
          status: "error",
          message: "Qdrant is unreachable.",
        },
      },
    }),
    runStartupHealthChecks: async () => ({
      status: "ok",
      checks: {},
    }),
  };
  const app = await createApp({
    chatMcp: async () => ({
      text: "web",
    }),
    healthService,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
    },
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "error");

    response = await fetch(`${server.baseUrl}/ready`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, "error");
  } finally {
    await server.close();
  }
});

test("api auth protects document routes while leaving health public", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;

  process.env.API_AUTH_ENABLED = "true";
  process.env.API_AUTH_TOKEN = "local-test-token";

  try {
    const app = await createApp({
      healthService: okHealthService,
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
      },
    });
    const server = await startServer(app);

    try {
      let response = await fetch(`${server.baseUrl}/health`);
      assert.equal(response.status, 200);

      response = await fetch(`${server.baseUrl}/documents`);
      assert.equal(response.status, 401);

      response = await fetch(`${server.baseUrl}/documents`, {
        headers: {
          "x-api-key": "local-test-token",
        },
      });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
  } finally {
    if (originalAuthEnabled === undefined) {
      delete process.env.API_AUTH_ENABLED;
    } else {
      process.env.API_AUTH_ENABLED = originalAuthEnabled;
    }

    if (originalAuthToken === undefined) {
      delete process.env.API_AUTH_TOKEN;
    } else {
      process.env.API_AUTH_TOKEN = originalAuthToken;
    }
  }
});

test("document file route streams stored PDFs before auth middleware", async () => {
  const fileBuffer = Buffer.from("%PDF-test-document", "utf8");
  const app = await createApp({
    healthService: okHealthService,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      getDocumentFile: async (docId) =>
        docId === "doc-1"
          ? {
              document: {
                docId,
                fileName: "stored.pdf",
              },
              fileBuffer,
              fileName: "stored.pdf",
              mimeType: "application/pdf",
              fileSize: fileBuffer.byteLength,
            }
          : null,
    },
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/documents/doc-1/file`, {
      headers: {
        Range: "bytes=0-3",
      },
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(await response.text(), "%PDF");
  } finally {
    await server.close();
  }
});

test("quality latest endpoint returns guardrail report", async () => {
  const app = await createApp({
    healthService: okHealthService,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
    },
    qualityService: {
      readLatestQualityReport: async () => ({
        status: "warn",
        summary: {
          runId: "run-1",
          createdAt: new Date().toISOString(),
          metrics: {
            overallPassRate: 0.875,
            averageCitationCount: 1.5,
          },
        },
        failedCases: [
          {
            id: "qa_remote",
            question: "What is remote work?",
            reasons: ["Page coverage missed"],
          },
        ],
        recommendations: [
          {
            label: "Increase retrieval topK",
            detail: "Page coverage missed on at least one case.",
          },
        ],
      }),
    },
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/quality/latest`);

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.status, "warn");
    assert.equal(body.summary.metrics.overallPassRate, 0.875);
    assert.equal(body.failedCases[0].id, "qa_remote");
    assert.match(body.recommendations[0].label, /retrieval/i);
  } finally {
    await server.close();
  }
});

test("quality synthetic endpoint invokes injected runner", async () => {
  let requestedCorpusPath = null;
  const app = await createApp({
    healthService: okHealthService,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
    },
    qualityService: {
      runSyntheticQualityEvaluation: async ({ corpusPath }) => {
        requestedCorpusPath = corpusPath;

        return {
          status: "ok",
          summary: {
            runId: "run-2",
            metrics: {
              overallPassRate: 1,
            },
          },
          failedCases: [],
          recommendations: [],
        };
      },
    },
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/quality/synthetic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        corpusPath: "evaluation/synthetic-corpus-near-duplicate.json",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(requestedCorpusPath, "evaluation/synthetic-corpus-near-duplicate.json");
    assert.equal(body.status, "ok");
    assert.equal(body.summary.runId, "run-2");
  } finally {
    await server.close();
  }
});

test("quality history response sorts runs and flags regressions", () => {
  const previousPayload = {
    summary: {
      runId: "run-previous",
      createdAt: "2026-05-31T09:00:00.000Z",
      corpus: {
        path: "evaluation/synthetic-corpus-near-duplicate.json",
        cases: 3,
      },
      metrics: {
        overallPassRate: 1,
        qaPageHitRate: 1,
        comparePageHitRate: 1,
        averageCitationCount: 2,
      },
    },
    cases: [
      {
        id: "qa-1",
        passed: true,
        docCoverageHit: true,
        pageCoverageHit: true,
        answerExpectationHit: true,
      },
    ],
  };
  const latestPayload = {
    summary: {
      runId: "run-latest",
      createdAt: "2026-05-31T10:00:00.000Z",
      corpus: {
        path: "evaluation/synthetic-corpus-near-duplicate.json",
        cases: 3,
      },
      metrics: {
        overallPassRate: 0.9,
        qaPageHitRate: 0.82,
        comparePageHitRate: 1,
        averageCitationCount: 1.2,
      },
    },
    cases: [
      {
        id: "qa-1",
        passed: false,
        shouldAbstain: false,
        abstained: false,
        docCoverageHit: true,
        pageCoverageHit: false,
        answerExpectationHit: true,
      },
    ],
  };

  const history = buildQualityHistoryResponse({
    latestPayload,
    runPayloads: [
      {
        fileName: "run-previous.json",
        payload: previousPayload,
      },
      {
        fileName: "run-latest.json",
        payload: latestPayload,
      },
    ],
  });

  assert.equal(history.runs.length, 2);
  assert.equal(history.runs[0].runId, "run-latest");
  assert.equal(history.regressionGate.status, "fail");
  assert.equal(history.regressionGate.baselineRunId, "run-previous");
  assert.ok(
    history.regressionGate.checks.some(
      (check) => check.metric === "overallPassRate" && check.status === "fail"
    )
  );
});

test("quality history endpoint returns regression gate", async () => {
  const app = await createApp({
    healthService: okHealthService,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
    },
    qualityService: {
      readQualityHistory: async () => ({
        status: "fail",
        runs: [
          {
            runId: "run-latest",
            status: "warn",
            failedCaseCount: 1,
            metrics: {
              overallPassPercent: 90,
            },
          },
        ],
        regressionGate: {
          status: "fail",
          currentRunId: "run-latest",
          baselineRunId: "run-previous",
          checks: [
            {
              metric: "overallPassRate",
              status: "fail",
              delta: -0.1,
            },
          ],
          summary: "Regression detected against the previous synthetic run.",
        },
      }),
    },
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/quality/history`);

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.status, "fail");
    assert.equal(body.runs[0].runId, "run-latest");
    assert.equal(body.regressionGate.baselineRunId, "run-previous");
    assert.equal(body.regressionGate.checks[0].status, "fail");
  } finally {
    await server.close();
  }
});

test("quality gate decision maps status to CI exit codes", () => {
  assert.deepEqual(
    buildQualityGateDecision({
      history: {
        regressionGate: {
          status: "pass",
          summary: "No regression detected.",
        },
      },
    }),
    {
      exitCode: 0,
      status: "pass",
      passed: true,
      summary: "No regression detected.",
    }
  );

  assert.equal(
    buildQualityGateDecision({
      history: {
        regressionGate: {
          status: "fail",
          summary: "Regression detected.",
        },
      },
    }).exitCode,
    1
  );

  assert.equal(
    buildQualityGateDecision({
      failOnWarn: true,
      history: {
        regressionGate: {
          status: "warn",
          summary: "Possible regression detected.",
        },
      },
    }).exitCode,
    1
  );

  assert.equal(
    buildQualityGateDecision({
      history: {
        regressionGate: {
          status: "warn",
          summary: "Possible regression detected.",
        },
      },
    }).exitCode,
    0
  );

  assert.equal(
    buildQualityGateDecision({
      history: {
        regressionGate: {
          status: "unknown",
          summary: "No previous synthetic run is available.",
        },
      },
    }).exitCode,
    2
  );

  assert.equal(
    buildQualityGateDecision({
      allowUnknown: true,
      history: {
        regressionGate: {
          status: "unknown",
          summary: "No previous synthetic run is available.",
        },
      },
    }).exitCode,
    0
  );
});
