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

test("arxiv routes search and import topic papers", async () => {
  const searched = [];
  const imported = [];
  const app = await createApp({
    ragService: {
      chat: async () => ({
        text: "stub",
        citations: [],
      }),
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: () => null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
    },
    arxivService: {
      search: async ({ maxResults, topic }) => {
        searched.push({
          maxResults,
          topic,
        });

        return [
          {
            arxivId: "2401.00001v1",
            title: "Retrieval Augmented Generation for Archives",
            absUrl: "https://arxiv.org/abs/2401.00001v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
          },
        ];
      },
    },
    arxivImportService: {
      importTopic: async ({ accessScope, maxResults, topic }) => {
        imported.push({
          accessScope,
          maxResults,
          topic,
        });

        return {
          topic,
          requestedMaxResults: maxResults,
          foundCount: 1,
          importedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          importedPapers: [
            {
              arxivId: "2401.00001v1",
              title: "Retrieval Augmented Generation for Archives",
              docId: "doc-1",
              fileName: "arxiv-2401.00001.pdf",
            },
          ],
          skippedPapers: [],
          failedPapers: [],
        };
      },
    },
    chatMcp: async () => ({
      text: "web",
    }),
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    let response = await fetch(
      `${server.baseUrl}/arxiv/search?topic=rag&maxResults=99`
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).papers.length, 1);
    assert.deepEqual(searched[0], {
      maxResults: 10,
      topic: "rag",
    });

    response = await fetch(`${server.baseUrl}/arxiv/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        maxResults: 2,
        topic: "retrieval augmented generation",
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();

    assert.equal(body.importedCount, 1);
    assert.equal(imported[0].topic, "retrieval augmented generation");
    assert.equal(imported[0].maxResults, 2);
    assert.deepEqual(imported[0].accessScope, {
      authenticated: false,
      userId: "",
      workspaceId: "",
    });
  } finally {
    await server.close();
  }
});

test("document arxiv enrichment routes suggest first and import after confirmation", async () => {
  const calls = [];
  const app = await createApp({
    ragService: {
      chat: async () => ({
        text: "stub",
        citations: [],
      }),
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: () => null,
      ingestDocument: async () => null,
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
    },
    arxivEnrichmentService: {
      suggestForDocument: async ({ accessScope, docId, maxResults }) => {
        calls.push({
          accessScope,
          docId,
          maxResults,
          type: "suggest",
        });

        return {
          document: {
            docId,
            fileName: "private-notes.pdf",
          },
          topic: "retrieval augmented generation",
          requestedMaxResults: maxResults,
          papers: [
            {
              arxivId: "2401.00001v1",
              title: "Retrieval Augmented Generation for Archives",
            },
          ],
          selectionToken: "selection-token-1",
          reason: null,
        };
      },
      listSavedSuggestions: ({ accessScope }) => {
        calls.push({
          accessScope,
          type: "list-saved",
        });

        return {
          suggestions: [
            {
              document: {
                docId: "doc-1",
                fileName: "private-notes.pdf",
              },
              papers: [
                {
                  arxivId: "2401.00001v1",
                  title: "Retrieval Augmented Generation for Archives",
                },
              ],
              provider: "arxiv",
              selectionToken: "selection-token-1",
              topic: "retrieval augmented generation",
            },
          ],
        };
      },
      getSavedSuggestionForDocument: ({ accessScope, docId }) => {
        calls.push({
          accessScope,
          docId,
          type: "get-saved",
        });

        return {
          document: {
            docId,
            fileName: "private-notes.pdf",
          },
          papers: [
            {
              arxivId: "2401.00001v1",
              title: "Retrieval Augmented Generation for Archives",
            },
          ],
          provider: "arxiv",
          selectionToken: "selection-token-1",
          topic: "retrieval augmented generation",
        };
      },
      importForDocument: async ({
        accessScope,
        docId,
        selectedArxivIds,
        selectionToken,
      }) => {
        calls.push({
          accessScope,
          docId,
          selectedArxivIds,
          selectionToken,
          type: "import",
        });

        return {
          document: {
            docId,
            fileName: "private-notes.pdf",
          },
          topic: "retrieval augmented generation",
          requestedMaxResults: 3,
          foundCount: 1,
          importedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          importedPapers: [
            {
              arxivId: "2401.00001v1",
              docId: "doc-arxiv",
              fileName: "arxiv-2401.00001.pdf",
              title: "Retrieval Augmented Generation for Archives",
            },
          ],
          skippedPapers: [],
          failedPapers: [],
        };
      },
    },
    chatMcp: async () => ({
      text: "web",
    }),
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    let response = await fetch(
      `${server.baseUrl}/documents/doc-1/arxiv/suggestions?maxResults=3`
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).papers.length, 1);

    response = await fetch(`${server.baseUrl}/documents/arxiv/suggestions`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).suggestions.length, 1);

    response = await fetch(
      `${server.baseUrl}/documents/doc-1/arxiv/suggestions/saved`
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).papers.length, 1);

    response = await fetch(`${server.baseUrl}/documents/doc-1/arxiv/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        selectedArxivIds: ["2401.00001v1"],
        selectionToken: "selection-token-1",
      }),
    });

    assert.equal(response.status, 201);
    assert.equal((await response.json()).importedCount, 1);
    assert.deepEqual(
      calls.map((call) => ({
        docId: call.docId,
        maxResults: call.maxResults,
        selectedArxivIds: call.selectedArxivIds,
        selectionToken: call.selectionToken,
        type: call.type,
      })),
      [
        {
          docId: "doc-1",
          maxResults: 3,
          selectedArxivIds: undefined,
          selectionToken: undefined,
          type: "suggest",
        },
        {
          docId: undefined,
          maxResults: undefined,
          selectedArxivIds: undefined,
          selectionToken: undefined,
          type: "list-saved",
        },
        {
          docId: "doc-1",
          maxResults: undefined,
          selectedArxivIds: undefined,
          selectionToken: undefined,
          type: "get-saved",
        },
        {
          docId: "doc-1",
          maxResults: undefined,
          selectedArxivIds: ["2401.00001v1"],
          selectionToken: "selection-token-1",
          type: "import",
        },
      ]
    );
  } finally {
    await server.close();
  }
});

test("tasks endpoint lists scoped task records", async () => {
  const calls = [];
  const app = await createApp({
    ragService: {
      chat: async () => ({
        text: "stub",
        citations: [],
      }),
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
    taskService: {
      listTasks: ({ accessScope, type }) => {
        calls.push({
          accessScope,
          type,
        });

        return {
          tasks: [
            {
              id: "external_recommendation:arxiv:doc-1",
              type: "external_recommendation",
              status: "waiting_for_user",
              label: "arXiv recommendations",
              summary: "Found 3 arXiv recommendations for review.",
            },
          ],
        };
      },
    },
  });
  const server = await startServer(app);

  try {
    const response = await fetch(
      `${server.baseUrl}/tasks?type=external_recommendation`
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).tasks.length, 1);
    assert.deepEqual(calls, [
      {
        accessScope: {
          authenticated: false,
          userId: "",
          workspaceId: "",
        },
        type: "external_recommendation",
      },
    ]);
  } finally {
    await server.close();
  }
});

test("task detail and action routes use scoped job orchestration", async () => {
  const calls = [];
  const app = await createApp({
    ragService: {
      chat: async () => ({
        text: "stub",
        citations: [],
      }),
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
    jobOrchestrator: {
      resumeTask: async ({ accessScope, action, payload, taskId }) => {
        calls.push({
          accessScope,
          action,
          payload,
          taskId,
          type: "resume",
        });

        return {
          id: taskId,
          status: "queued",
          type: "external_recommendation",
        };
      },
    },
    taskService: {
      getTask: ({ accessScope, taskId }) => {
        calls.push({
          accessScope,
          taskId,
          type: "get",
        });

        return {
          id: taskId,
          status: "waiting_for_user",
          type: "external_recommendation",
        };
      },
      listTasks: () => ({
        tasks: [],
      }),
    },
  });
  const server = await startServer(app);

  try {
    let response = await fetch(
      `${server.baseUrl}/tasks/external_recommendation%3Aarxiv%3Adoc-1`
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "waiting_for_user");

    response = await fetch(
      `${server.baseUrl}/tasks/external_recommendation%3Aarxiv%3Adoc-1/actions/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          selectedArxivIds: ["2401.00001v1"],
          selectionToken: "selection-token-1",
        }),
      }
    );

    assert.equal(response.status, 202);
    assert.equal((await response.json()).task.status, "queued");
    assert.deepEqual(
      calls.map((call) => ({
        action: call.action,
        payload: call.payload,
        taskId: call.taskId,
        type: call.type,
      })),
      [
        {
          action: undefined,
          payload: undefined,
          taskId: "external_recommendation:arxiv:doc-1",
          type: "get",
        },
        {
          action: "confirm",
          payload: {
            selectedArxivIds: ["2401.00001v1"],
            selectionToken: "selection-token-1",
          },
          taskId: "external_recommendation:arxiv:doc-1",
          type: "resume",
        },
      ]
    );
  } finally {
    await server.close();
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
    assert.ok(body.agentRunId);
    assert.equal(body.agentAnswer, body.ragAnswer);
    assert.equal(body.ragAnswer, "The archive says annual leave is 15 days. [Source 1]");
    assert.equal(body.mcpAnswer, "Web search not used: document evidence was sufficient.");
    assert.ok(Array.isArray(body.agentTrace));
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      [
        "plan",
        "query_planner",
        "document_rag",
        "self_check",
        "synthesis",
        "answer_finalizer",
      ]
    );
    assert.equal(body.agentTrace.every((step) => step.status === "completed"), true);

    let auditResponse = await fetch(`${server.baseUrl}/agent-runs/${body.agentRunId}`);

    assert.equal(auditResponse.status, 200);

    const agentRun = await auditResponse.json();

    assert.equal(agentRun.runId, body.agentRunId);
    assert.equal(agentRun.status, "completed");
    assert.equal(agentRun.goal, "What is annual leave?");
    assert.equal(agentRun.result.agentMode, "document");
    assert.deepEqual(
      agentRun.events.map((event) => event.type),
      ["run_created", "run_prepared", "execution_planned", "run_completed"]
    );

    auditResponse = await fetch(`${server.baseUrl}/agent-runs?status=completed`);

    assert.equal(auditResponse.status, 200);
    assert.equal((await auditResponse.json()).runs.length, 1);

    const capabilitiesResponse = await fetch(`${server.baseUrl}/capabilities`);

    assert.equal(capabilitiesResponse.status, 200);
    assert.deepEqual(
      (await capabilitiesResponse.json()).capabilities.map(
        (capability) => capability.id
      ),
      [
        "arxiv.import_topic",
        "workspace.document_discovery",
        "web.search",
      ]
    );
  } finally {
    await server.close();
  }
});

test("chat endpoint agent runs follow-up document RAG when self-check finds missing citations", async () => {
  const documents = new Map([
    [
      "doc-1",
      {
        docId: "doc-1",
        fileName: "benefits.pdf",
      },
    ],
  ]);
  const askedQuestions = [];
  const app = await createApp({
    ragService: {
      chat: async (_docIds, query) => {
        askedQuestions.push(query);

        if (askedQuestions.length === 1) {
          return {
            text: "Annual leave appears to be 15 days.",
            citations: [],
            abstained: false,
            resolvedQuery: query,
            memoryApplied: false,
          };
        }

        return {
          text: "The cited policy says annual leave is 15 days. [Source 1]",
          citations: [
            {
              rank: 1,
              docId: "doc-1",
              fileName: "benefits.pdf",
              pageNumber: 3,
              chunkIndex: 2,
              excerpt: "Annual leave is 15 days.",
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
      throw new Error("Web search should not run when document follow-up succeeds.");
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
        docId: "doc-1",
        question: "How many annual leave days are provided?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(askedQuestions.length, 2);
    assert.match(askedQuestions[1], /How many annual leave days are provided/);
    assert.match(askedQuestions[1], /cited support/i);
    assert.equal(body.agentMode, "document");
    assert.equal(body.ragAnswer, "The cited policy says annual leave is 15 days. [Source 1]");
    assert.equal(body.ragSources.length, 1);
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      [
        "plan",
        "query_planner",
        "document_rag",
        "self_check",
        "gap_analysis",
        "follow_up_retrieval",
        "self_check",
        "synthesis",
        "answer_finalizer",
      ]
    );
    assert.equal(
      body.agentTrace.find((step) => step.type === "gap_analysis").status,
      "completed"
    );
    assert.equal(
      body.agentTrace.find((step) => step.type === "follow_up_retrieval").status,
      "completed"
    );
    assert.equal(body.agentObservability.executionLoop.followUpsRun, 1);
    assert.equal(
      body.agentObservability.executionLoop.stoppedReason,
      "follow_up_resolved"
    );
  } finally {
    await server.close();
  }
});

test("chat endpoint agent skips document follow-up when document budget is exhausted", async () => {
  const documents = new Map([
    [
      "doc-1",
      {
        docId: "doc-1",
        fileName: "benefits.pdf",
      },
    ],
  ]);
  const askedQuestions = [];
  const app = await createApp({
    agentBudget: {
      maxDocumentRagCalls: 1,
    },
    ragService: {
      chat: async (_docIds, query) => {
        askedQuestions.push(query);

        return {
          text: "Annual leave appears to be 15 days.",
          citations: [],
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
      throw new Error("Web search should not run for non-abstained document answers.");
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
        docId: "doc-1",
        question: "How many annual leave days are provided?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(askedQuestions.length, 1);
    assert.equal(body.agentMode, "clarification");
    assert.match(body.agentAnswer, /could not verify/i);
    assert.equal(body.clarification.needed, true);
    assert.equal(
      body.clarification.reason,
      "document_follow_up_budget_exhausted"
    );
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      [
        "plan",
        "query_planner",
        "document_rag",
        "self_check",
        "gap_analysis",
        "budget_limit",
        "clarification_gate",
      ]
    );
    assert.match(
      body.agentTrace.find((step) => step.type === "budget_limit").summary,
      /Document follow-up/i
    );
    assert.equal(
      body.agentObservability.executionLoop.stoppedReason,
      "budget_exhausted"
    );
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
      ["plan", "query_planner", "document_rag", "self_check", "web_search", "synthesis"]
    );
  } finally {
    await server.close();
  }
});

test("chat endpoint agent skips web fallback when web budget is exhausted", async () => {
  const documents = new Map([
    [
      "doc-1",
      {
        docId: "doc-1",
        fileName: "notes.pdf",
      },
    ],
  ]);
  let webCalls = 0;
  const app = await createApp({
    agentBudget: {
      maxWebSearchCalls: 0,
    },
    ragService: {
      chat: async () => ({
        text: "I found related material, but cannot confirm the launch date.",
        citations: [],
        abstained: true,
        abstainReason: "I found related material, but cannot confirm the launch date.",
        resolvedQuery: "What is the launch date?",
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
    chatMcp: async () => {
      webCalls += 1;
      return {
        text: "web should not run",
      };
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
        docId: "doc-1",
        question: "What is the launch date?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(webCalls, 0);
    assert.equal(body.mcpAnswer, "Web search not used: agent budget exhausted.");
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      ["plan", "query_planner", "document_rag", "self_check", "budget_limit", "synthesis"]
    );
    assert.match(
      body.agentTrace.find((step) => step.type === "budget_limit").summary,
      /Web Search/i
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

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.agentMode, "clarification");
    assert.equal(body.clarification.needed, true);
    assert.equal(body.clarification.reason, "missing_required_documents");
    assert.match(body.agentAnswer, /Which document should I use/i);
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      ["plan", "clarification_gate"]
    );
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

test("memory endpoints use authenticated user scope over request userId", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;
  const requestedUserIds = [];

  try {
    process.env.API_AUTH_ENABLED = "true";
    process.env.API_AUTH_TOKEN = "";
    process.env.API_AUTH_TOKENS = JSON.stringify({
      "alice-token": {
        userId: "alice",
        workspaceId: "workspace-a",
      },
    });

    const app = await createApp({
      ragService: {
        listLongMemories: async ({ userId }) => {
          requestedUserIds.push(userId);
          return [];
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
      const response = await fetch(`${server.baseUrl}/memory?userId=bob`, {
        headers: {
          "x-api-key": "alice-token",
        },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(requestedUserIds, ["alice"]);
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

    if (originalAuthTokens === undefined) {
      delete process.env.API_AUTH_TOKENS;
    } else {
      process.env.API_AUTH_TOKENS = originalAuthTokens;
    }
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

test("document file route requires auth and enforces document ownership", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;
  const fileBuffer = Buffer.from("%PDF-test-document", "utf8");

  try {
    process.env.API_AUTH_ENABLED = "true";
    process.env.API_AUTH_TOKEN = "";
    process.env.API_AUTH_TOKENS = JSON.stringify({
      "owner-token": {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      "intruder-token": {
        userId: "bob",
        workspaceId: "workspace-b",
      },
    });

    const app = await createApp({
      healthService: okHealthService,
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
        getDocumentFile: async (docId, accessScope) =>
          docId === "doc-1" &&
          accessScope?.userId === "alice" &&
          accessScope?.workspaceId === "workspace-a"
            ? {
                document: {
                  docId,
                  fileName: "stored.pdf",
                  ownerUserId: "alice",
                  workspaceId: "workspace-a",
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
      let response = await fetch(`${server.baseUrl}/documents/doc-1/file`, {
        headers: {
          Range: "bytes=0-3",
        },
      });
      assert.equal(response.status, 401);

      response = await fetch(`${server.baseUrl}/documents/doc-1/file`, {
        headers: {
          Range: "bytes=0-3",
          "x-api-key": "intruder-token",
        },
      });
      assert.equal(response.status, 404);

      response = await fetch(`${server.baseUrl}/documents/doc-1/file`, {
        headers: {
          Range: "bytes=0-3",
          "x-api-key": "owner-token",
        },
      });

      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-type"), "application/pdf");
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(await response.text(), "%PDF");
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

    if (originalAuthTokens === undefined) {
      delete process.env.API_AUTH_TOKENS;
    } else {
      process.env.API_AUTH_TOKENS = originalAuthTokens;
    }
  }
});

test("document file route handles full responses, invalid ranges, and stream errors", async () => {
  const fileBuffer = Buffer.from("%PDF-test-document", "utf8");
  const app = await createApp({
    healthService: okHealthService,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      getDocumentFile: async (docId) => {
        if (docId === "boom") {
          const error = new Error("storage unavailable");
          error.status = 503;
          throw error;
        }

        if (docId !== "doc-1") {
          return null;
        }

        return {
          document: {
            docId,
            fileName: "stored.pdf",
          },
          fileBuffer,
          fileName: "stored.pdf",
          mimeType: "application/pdf",
          fileSize: fileBuffer.byteLength,
        };
      },
    },
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/documents/doc-1/file`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(fileBuffer.byteLength));
    assert.equal(await response.text(), "%PDF-test-document");

    response = await fetch(`${server.baseUrl}/documents/doc-1/file`, {
      headers: {
        Range: "bytes=5-999",
      },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 5-17/18");
    assert.equal(await response.text(), "test-document");

    response = await fetch(`${server.baseUrl}/documents/doc-1/file`, {
      headers: {
        Range: "items=0-3",
      },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */18");

    response = await fetch(`${server.baseUrl}/documents/doc-1/file`, {
      headers: {
        Range: "bytes=10-1",
      },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */18");

    response = await fetch(`${server.baseUrl}/documents/missing/file`);
    assert.equal(response.status, 404);

    response = await fetch(`${server.baseUrl}/documents/boom/file`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /storage unavailable/);
  } finally {
    await server.close();
  }
});

test("upload routes report missing and invalid request boundaries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentai-upload-boundary-"));
  const app = await createApp({
    healthService: okHealthService,
    uploadSessionDirectory: path.join(tempRoot, "sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      ingestDocument: async () => ({
        docId: "accepted",
        fileName: "accepted.pdf",
      }),
    },
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/upload/status`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /fileId is required/);

    response = await fetch(`${server.baseUrl}/upload/status?fileId=missing`);
    assert.equal(response.status, 404);

    response = await fetch(`${server.baseUrl}/upload/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileId: "bad-init",
        fileSize: 10,
        totalChunks: 1,
        chunkSize: 10,
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /fileName is required/);

    response = await fetch(`${server.baseUrl}/upload/chunk`, {
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /No chunk uploaded/);

    const missingFileIdForm = new FormData();
    missingFileIdForm.append("chunkIndex", "0");
    missingFileIdForm.append("totalChunks", "1");
    missingFileIdForm.append("chunk", new Blob(["partial"]), "paper.pdf.part-0");

    response = await fetch(`${server.baseUrl}/upload/chunk`, {
      method: "POST",
      body: missingFileIdForm,
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /fileId is required/);

    response = await fetch(`${server.baseUrl}/upload/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);

    response = await fetch(`${server.baseUrl}/upload/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileId: "missing",
      }),
    });
    assert.equal(response.status, 404);

    response = await fetch(`${server.baseUrl}/upload`, {
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /PDF file is required/);

    const directUploadForm = new FormData();
    directUploadForm.append(
      "file",
      new Blob(["not a pdf"], {
        type: "text/plain",
      }),
      "notes.txt"
    );

    response = await fetch(`${server.baseUrl}/upload`, {
      method: "POST",
      body: directUploadForm,
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /PDF file is required/);
  } finally {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("upload completion removes merged file when ingestion fails", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentai-upload-failure-"));
  let removedPath = null;
  let clearedFileId = null;
  const app = await createApp({
    healthService: okHealthService,
    uploadSessionDirectory: path.join(tempRoot, "sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    uploadStore: {
      ensureUploadStorage: async () => {},
      initializeUploadSession: async () => {
        throw new Error("not used");
      },
      getUploadSessionStatus: async (fileId) =>
        fileId === "file-1"
          ? {
              fileId,
              fileName: "paper.pdf",
              totalChunks: 1,
              uploadedChunks: [0],
            }
          : null,
      storeUploadChunk: async () => {
        throw new Error("not used");
      },
      finalizeUploadSession: async () => ({
        fileId: "file-1",
      }),
      clearUploadSession: async (fileId) => {
        clearedFileId = fileId;
      },
      removeMergedUpload: async (filePath) => {
        removedPath = filePath;
      },
    },
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      ingestDocument: async () => {
        const error = new Error("ingestion rejected");
        error.status = 422;
        throw error;
      },
    },
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/upload/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileId: "file-1",
      }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /ingestion rejected/);
    assert.match(removedPath, /paper-/);
    assert.equal(clearedFileId, null);
  } finally {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("api routes expose consistent error responses for route failures", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentai-route-errors-"));
  const makeServiceError = (message, status = 503) => {
    const error = new Error(message);
    error.status = status;
    return error;
  };
  const app = await createApp({
    uploadSessionDirectory: path.join(tempRoot, "sessions"),
    uploadsDirectory: path.join(tempRoot, "uploads"),
    healthService: {
      runStartupHealthChecks: async () => ({
        status: "ok",
        checks: {},
      }),
      buildHealthReport: async () => {
        throw makeServiceError("health failed");
      },
    },
    qualityService: {
      readLatestQualityReport: async () => {
        throw makeServiceError("latest failed");
      },
      readQualityHistory: async () => {
        throw makeServiceError("history failed");
      },
      runSyntheticQualityEvaluation: async () => {
        throw makeServiceError("synthetic failed", 502);
      },
    },
    feedbackService: {
      listFeedback: async () => {
        throw makeServiceError("feedback list failed");
      },
      recordFeedback: async () => {
        throw makeServiceError("feedback write failed", 409);
      },
    },
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      listDocuments: () => [],
      deleteDocument: async (docId) => {
        if (docId === "missing") {
          return null;
        }

        throw makeServiceError("delete failed");
      },
      clearDocuments: async () => {
        throw makeServiceError("clear failed");
      },
      clearSessionMemory: async () => {
        throw makeServiceError("session clear failed");
      },
      listLongMemories: async () => {
        throw makeServiceError("memory list failed");
      },
      rememberLongMemory: async () => {
        throw makeServiceError("memory write failed");
      },
      deleteLongMemory: async ({ memoryId }) => {
        if (memoryId === "missing") {
          return null;
        }

        throw makeServiceError("memory delete failed");
      },
      clearLongMemories: async () => {
        throw makeServiceError("memory clear failed");
      },
      ingestDocument: async () => {
        throw makeServiceError("ingest failed", 422);
      },
      chat: async () => {
        throw makeServiceError("chat failed");
      },
      getDocument: () => null,
    },
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /health failed/);

    response = await fetch(`${server.baseUrl}/ready`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /health failed/);

    response = await fetch(`${server.baseUrl}/documents/missing`, {
      method: "DELETE",
    });
    assert.equal(response.status, 404);

    response = await fetch(`${server.baseUrl}/documents/boom`, {
      method: "DELETE",
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /delete failed/);

    response = await fetch(`${server.baseUrl}/documents/clear`, {
      method: "POST",
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /clear failed/);

    response = await fetch(`${server.baseUrl}/sessions/session-1`, {
      method: "DELETE",
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /session clear failed/);

    response = await fetch(`${server.baseUrl}/memory`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /userId is required/);

    response = await fetch(`${server.baseUrl}/memory?userId=user-1`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /memory list failed/);

    response = await fetch(`${server.baseUrl}/memory`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /text is required/);

    response = await fetch(`${server.baseUrl}/memory`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        text: "remember this",
      }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /memory write failed/);

    response = await fetch(`${server.baseUrl}/memory/missing?userId=user-1`, {
      method: "DELETE",
    });
    assert.equal(response.status, 404);

    response = await fetch(`${server.baseUrl}/memory/boom?userId=user-1`, {
      method: "DELETE",
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /memory delete failed/);

    response = await fetch(`${server.baseUrl}/memory`, {
      method: "DELETE",
    });
    assert.equal(response.status, 400);

    response = await fetch(`${server.baseUrl}/memory?userId=user-1`, {
      method: "DELETE",
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /memory clear failed/);

    response = await fetch(`${server.baseUrl}/quality/latest`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /latest failed/);

    response = await fetch(`${server.baseUrl}/quality/history`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /history failed/);

    response = await fetch(`${server.baseUrl}/quality/synthetic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /synthetic failed/);

    response = await fetch(`${server.baseUrl}/feedback`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /feedback list failed/);

    response = await fetch(`${server.baseUrl}/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        feedbackType: "helpful",
        question: "What changed?",
        answerText: "The answer changed.",
      }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /feedback write failed/);

    response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Question is required/);

    response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: "What happened?",
        docIds: ["doc-1"],
      }),
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /Document not found/);

    const pdfUpload = new FormData();
    pdfUpload.append(
      "file",
      new Blob(["%PDF-1.4 fake"], {
        type: "application/pdf",
      }),
      "paper.pdf"
    );

    response = await fetch(`${server.baseUrl}/upload`, {
      method: "POST",
      body: pdfUpload,
    });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /ingest failed/);
  } finally {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("chat endpoint rejects documents outside the authenticated workspace", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;

  try {
    process.env.API_AUTH_ENABLED = "true";
    process.env.API_AUTH_TOKEN = "";
    process.env.API_AUTH_TOKENS = JSON.stringify({
      "owner-token": {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      "intruder-token": {
        userId: "bob",
        workspaceId: "workspace-b",
      },
    });

    const documents = new Map([
      [
        "doc-1",
        {
          docId: "doc-1",
          fileName: "stored.pdf",
          ownerUserId: "alice",
          workspaceId: "workspace-a",
        },
      ],
    ]);
    let chatCallCount = 0;
    const app = await createApp({
      healthService: okHealthService,
      ragService: {
        chat: async () => {
          chatCallCount += 1;
          return {
            text: "The stored document is visible to Alice.",
            citations: [],
            abstained: false,
          };
        },
        clearDocuments: async () => [],
        clearSessionMemory: () => true,
        deleteDocument: async () => null,
        getDocument: (docId, accessScope) => {
          const document = documents.get(docId);

          if (
            !document ||
            accessScope?.userId !== document.ownerUserId ||
            accessScope?.workspaceId !== document.workspaceId
          ) {
            return null;
          }

          return document;
        },
        ingestDocument: async () => null,
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
        listDocuments: () => [...documents.values()],
      },
      chatMcp: async () => ({
        text: "web",
      }),
    });
    const server = await startServer(app);

    try {
      const requestBody = {
        docId: "doc-1",
        question: "What is visible?",
      };
      let response = await fetch(`${server.baseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "intruder-token",
        },
        body: JSON.stringify(requestBody),
      });

      assert.equal(response.status, 404);
      assert.equal(chatCallCount, 0);

      response = await fetch(`${server.baseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "owner-token",
        },
        body: JSON.stringify(requestBody),
      });

      assert.equal(response.status, 200);
      assert.equal(chatCallCount > 0, true);
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

    if (originalAuthTokens === undefined) {
      delete process.env.API_AUTH_TOKENS;
    } else {
      process.env.API_AUTH_TOKENS = originalAuthTokens;
    }
  }
});

test("feedback endpoints store and list scoped answer feedback", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;
  const recordedFeedback = [];
  const listScopes = [];

  try {
    process.env.API_AUTH_ENABLED = "true";
    process.env.API_AUTH_TOKEN = "";
    process.env.API_AUTH_TOKENS = JSON.stringify({
      "alice-token": {
        userId: "alice",
        workspaceId: "workspace-a",
      },
    });

    const app = await createApp({
      healthService: okHealthService,
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
      },
      feedbackService: {
        recordFeedback: async (feedback) => {
          recordedFeedback.push(feedback);
          return {
            feedbackId: "feedback-1",
            ...feedback,
          };
        },
        listFeedback: async ({ accessScope, limit }) => {
          listScopes.push({
            accessScope,
            limit,
          });

          return recordedFeedback;
        },
      },
    });
    const server = await startServer(app);

    try {
      let response = await fetch(`${server.baseUrl}/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "alice-token",
        },
        body: JSON.stringify({
          userId: "bob",
          workspaceId: "workspace-b",
          question: "What does the policy say?",
          docIds: ["doc-1"],
          feedbackType: "citation_error",
          note: "The page citation looks wrong.",
          answer: {
            agentAnswer: "The policy says remote work is allowed.",
            ragSources: [
              {
                docId: "doc-1",
                fileName: "policy.pdf",
                pageNumber: 3,
                chunkIndex: 1,
                excerpt: "Remote work is allowed.",
              },
            ],
            retrievedContexts: [
              {
                pageContent: "Sensitive full chunk text should not be stored.",
              },
            ],
          },
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(recordedFeedback.length, 1);
      assert.equal(recordedFeedback[0].userId, "alice");
      assert.equal(recordedFeedback[0].workspaceId, "workspace-a");
      assert.equal(recordedFeedback[0].feedbackType, "citation_error");
      assert.equal(recordedFeedback[0].answerText, "The policy says remote work is allowed.");
      assert.equal(recordedFeedback[0].citations[0].pageNumber, 3);
      assert.equal("retrievedContexts" in recordedFeedback[0], false);

      response = await fetch(`${server.baseUrl}/feedback?limit=5`, {
        headers: {
          "x-api-key": "alice-token",
        },
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).feedback.length, 1);
      assert.equal(listScopes[0].accessScope.userId, "alice");
      assert.equal(listScopes[0].accessScope.workspaceId, "workspace-a");
      assert.equal(listScopes[0].limit, 5);
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

    if (originalAuthTokens === undefined) {
      delete process.env.API_AUTH_TOKENS;
    } else {
      process.env.API_AUTH_TOKENS = originalAuthTokens;
    }
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
