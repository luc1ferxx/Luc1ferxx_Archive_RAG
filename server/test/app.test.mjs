import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp as createProductionApp } from "../app.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import {
  deterministicIntentPlannerAdapter,
} from "../rag/agent-intent-planner.js";
import {
  CAPABILITY_IDS,
  createCapabilityRegistry,
} from "../rag/capabilities/index.js";
import {
  AGENT_TASK_ACTIONS,
  createAgentTaskRunner,
} from "../rag/agent-tasks.js";
import { ADMIN_ACTION_IDS } from "../rag/admin-actions.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  AGENT_RUN_STEP_KINDS,
  AGENT_RUN_STEP_STATUSES,
} from "../rag/agent-run-steps.js";
import {
  STEP_REPLAY_SAFETY_REASON_CODES,
} from "../rag/agent-run-step-replay-safety.js";
import {
  createInMemoryTaskStore,
} from "../rag/tasks.js";
import {
  buildQualityGateDecision,
  buildQualityHistoryResponse,
} from "../evaluation/quality-report.js";
import {
  ADMIN_PERMISSION_IDS,
  ADMIN_PERMISSION_REASONS,
  ADMIN_ROLE_IDS,
} from "../rag/admin-permissions.js";

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

const createApp = (options = {}) =>
  createProductionApp({
    executionPlannerAdapter: deterministicPlannerAdapter,
    intentPlannerAdapter: deterministicIntentPlannerAdapter,
    ...options,
  });

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

const recoveryAccessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const recoveryScopeHeaders = {
  "x-user-id": recoveryAccessScope.userId,
  "x-workspace-id": recoveryAccessScope.workspaceId,
};

const createRecoveryRagService = (overrides = {}) => ({
  chat: async () => ({
    citations: [],
    text: "stub",
  }),
  clearDocuments: async () => [],
  clearSessionMemory: () => true,
  deleteDocument: async () => null,
  getDocument: () => null,
  ingestDocument: async () => null,
  initializeDocumentRegistry: async () => [],
  initializeSessionMemory: async () => true,
  listDocuments: () => [],
  ...overrides,
});

const createNoopStartupRecoveryService = () => ({
  recoverOnStartup: async () => ({
    mode: "manual",
    recoveredCount: 0,
    runs: [],
  }),
});

const seedRecoverableAgentRun = async ({
  accessScope = recoveryAccessScope,
  agentRunStore,
  goal = "Recover interrupted run",
  manualRecovery = false,
  patch,
  runId,
} = {}) => {
  const agentRunService = createAgentRunService({
    agentRunStore,
  });

  await agentRunService.createRun({
    accessScope,
    goal,
    runId,
  });
  await agentRunService.updateRun({
    accessScope,
    patch,
    runId,
  });

  if (manualRecovery) {
    await agentRunService.appendRunEvent({
      accessScope,
      runId,
      type: "manual_recovery_required",
      payload: {
        reason: patch?.result?.recovery?.reason ?? "server_startup_recovery",
      },
    });
  }

  return agentRunService;
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

test("agent task endpoint creates scoped durable goal tasks", async () => {
  const calls = [];
  const app = await createApp({
    agentTaskService: {
      createTask: async ({ accessScope, docIds, maxIterations, question, sessionId, userId }) => {
        calls.push({
          accessScope,
          docIds,
          maxIterations,
          question,
          sessionId,
          userId,
        });

        return {
          id: "agent_goal:task-1",
          input: {
            docIds,
            maxIterations,
            question,
            sessionId,
            userId,
          },
          status: "queued",
          type: "agent_goal",
        };
      },
    },
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
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/agent-tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        docIds: ["doc-1"],
        maxIterations: 2,
        question: "Summarize the renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      }),
    });

    assert.equal(response.status, 202);
    assert.equal((await response.json()).task.id, "agent_goal:task-1");
    assert.deepEqual(calls, [
      {
        accessScope: {
          authenticated: false,
          userId: "alice",
          workspaceId: "",
        },
        docIds: ["doc-1"],
        maxIterations: 2,
        question: "Summarize the renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
    ]);
  } finally {
    await server.close();
  }
});

test("agent trigger endpoints expose public contracts and dispatch scoped tasks", async () => {
  const calls = [];
  const app = await createApp({
    agentTaskService: {
      createTask: async (request) => {
        calls.push(request);

        return {
          id: "agent_goal:from-trigger",
          input: {
            docIds: request.docIds,
            question: request.question,
            userId: request.userId,
          },
          status: "queued",
          type: "agent_goal",
        };
      },
    },
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
  });
  const server = await startServer(app);

  try {
    const listResponse = await fetch(`${server.baseUrl}/agent-triggers`);
    const listBody = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.deepEqual(
      listBody.triggers.map((trigger) => trigger.id),
      ["research_dossier_manual"]
    );
    assert.equal(listBody.triggers[0].target.workflowId, "research_dossier");
    assert.equal(listBody.triggers[0].target.questionTemplate, undefined);
    assert.doesNotMatch(JSON.stringify(listBody), /research_task/);

    const dispatchResponse = await fetch(
      `${server.baseUrl}/agent-triggers/research_dossier_manual/dispatch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "request-1",
          "x-user-id": "alice",
          "x-workspace-id": "workspace-a",
        },
        body: JSON.stringify({
          input: {
            apiKey: "sk-secret-value",
            docIds: ["doc-1"],
            question: "Build a risk report",
            userId: "mallory",
          },
        }),
      }
    );
    const dispatchBody = await dispatchResponse.json();

    assert.equal(dispatchResponse.status, 202);
    assert.equal(dispatchBody.task.id, "agent_goal:from-trigger");
    assert.equal(dispatchBody.triggerDispatch.triggerId, "research_dossier_manual");
    assert.deepEqual(calls, [
      {
        accessScope: {
          authenticated: false,
          userId: "alice",
          workspaceId: "workspace-a",
        },
        docIds: ["doc-1"],
        idempotencyKey: "research_dossier_manual:request-1",
        maxIterations: 10,
        question: "research_task: Build a risk report",
        sessionId: undefined,
        userPreferences: undefined,
        userId: "alice",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(dispatchBody), /sk-secret-value/);
    assert.doesNotMatch(JSON.stringify(calls), /mallory/);
  } finally {
    await server.close();
  }
});

test("agent trigger dispatch reports contract errors without creating tasks", async () => {
  let createTaskCalled = false;
  const app = await createApp({
    agentTaskService: {
      createTask: async () => {
        createTaskCalled = true;
      },
    },
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
  });
  const server = await startServer(app);

  try {
    const response = await fetch(
      `${server.baseUrl}/agent-triggers/research_dossier_manual/dispatch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "request-missing-question",
          "x-user-id": "alice",
          "x-workspace-id": "workspace-a",
        },
        body: JSON.stringify({
          input: {
            docIds: ["doc-1"],
          },
        }),
      }
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /Trigger input missing required field\(s\): question/);
    assert.equal(createTaskCalled, false);
  } finally {
    await server.close();
  }
});

test("agent task API runs multi-step goals and resumes after approval", async () => {
  const approvalGate = {
    capabilityId: "web.search",
    id: "approval:web.search:1.0.0",
    status: "pending",
  };
  const calls = [];
  const scheduledWork = [];
  const schedule = (work) => {
    scheduledWork.push(Promise.resolve().then(work));
  };
  const drainScheduledWork = async () => {
    while (scheduledWork.length > 0) {
      const batch = scheduledWork.splice(0);
      await Promise.all(batch);
    }
  };
  const agentTaskRunner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          status: 200,
          body: {
            agentAnswer: "Renewal terms found.",
            agentMode: "document",
            agentRunId: "run-task-http",
            agentTask: {
              continue: true,
              nextCandidates: ["Check renewal risk."],
              nextQuestion: "Check renewal risk.",
              userPreferences: ["Keep risk notes short."],
            },
            clarification: {
              needed: false,
            },
            ragSources: [
              {
                excerpt: "Secret evidence should stay out of task memory.",
              },
            ],
          },
        };
      }

      if (calls.length === 2) {
        return {
          status: 200,
          body: {
            agentAnswer: "Approve Web Search?",
            agentMode: "clarification",
            agentRunId: "run-task-http",
            approvalGates: [approvalGate],
            clarification: {
              detail: {
                approvalGates: [approvalGate],
              },
              needed: true,
              question: "Approve Web Search?",
              reason: "capability_approval_required",
            },
          },
        };
      }

      return {
        status: 200,
        body: {
          agentAnswer: "Renewal risk checked with approved web evidence.",
          agentMode: "web",
          agentRunId: "run-task-http",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const app = await createApp({
    agentTaskRunner,
    createAgentTaskId: () => "api-loop",
    healthService: okHealthService,
    jobSchedule: schedule,
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
    taskStore: createInMemoryTaskStore(),
  });
  const server = await startServer(app);
  const taskId = "agent_goal:api-loop";
  const taskUrl = `${server.baseUrl}/tasks/${encodeURIComponent(taskId)}`;
  const scopeHeaders = {
    "x-user-id": "alice",
  };

  try {
    let response = await fetch(`${server.baseUrl}/agent-tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...scopeHeaders,
      },
      body: JSON.stringify({
        docIds: ["doc-1"],
        maxIterations: 3,
        question: "Summarize renewal terms.",
        sessionId: "session-1",
        userId: "alice",
        userPreferences: ["Use concise bullets."],
      }),
    });

    assert.equal(response.status, 202);
    const createdBody = await response.json();
    assert.equal(createdBody.task.id, taskId);
    assert.equal(createdBody.task.status, "queued");
    assert.equal("payload" in createdBody.task, false);

    await drainScheduledWork();

    response = await fetch(taskUrl, {
      headers: scopeHeaders,
    });
    assert.equal(response.status, 200);
    let task = await response.json();
    assert.equal(task.status, "waiting_for_user");
    assert.equal(task.requiredUserAction, "approve_capability");
    assert.equal(task.counts.iterations, 2);
    assert.equal(task.result.agentRunId, "run-task-http");
    assert.equal(task.result.stoppedReason, "waiting_for_user");
    assert.equal("payload" in task, false);
    assert.doesNotMatch(
      JSON.stringify(task),
      /Secret evidence should stay out of task memory/
    );

    assert.deepEqual(
      calls.map((call) => call.question),
      ["Summarize renewal terms.", "Check renewal risk."]
    );
    assert.equal(calls[0].taskMemory.goal, "Summarize renewal terms.");
    assert.equal(calls[0].taskMemory.evidencePolicy, "planning_context_only");
    assert.deepEqual(calls[0].taskMemory.userPreferences, [
      "Use concise bullets.",
    ]);
    assert.equal(
      calls[1].taskMemory.completedSteps[0].answer,
      "Renewal terms found."
    );
    assert.deepEqual(calls[1].taskMemory.nextCandidates, [
      "Check renewal risk.",
    ]);
    assert.deepEqual(calls[1].taskMemory.userPreferences, [
      "Use concise bullets.",
      "Keep risk notes short.",
    ]);

    response = await fetch(
      `${taskUrl}/actions/${AGENT_TASK_ACTIONS.approve}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...scopeHeaders,
        },
        body: JSON.stringify({
          approval: {
            approved: true,
            decision: "approved",
            source: "task_action",
          },
          capabilityId: "web.search",
        }),
      }
    );

    assert.equal(response.status, 202);
    assert.equal((await response.json()).task.status, "queued");

    await drainScheduledWork();

    response = await fetch(taskUrl, {
      headers: scopeHeaders,
    });
    assert.equal(response.status, 200);
    task = await response.json();
    assert.equal(task.status, "completed");
    assert.equal(task.counts.iterations, 3);
    assert.equal(
      task.result.answer,
      "Renewal risk checked with approved web evidence."
    );
    assert.equal(task.result.agentRunId, "run-task-http");
    assert.equal(
      task.result.taskMemory.evidencePolicy,
      "planning_context_only"
    );
    assert.equal("payload" in task, false);
    assert.equal(calls[2].agentRunId, "run-task-http");
    assert.deepEqual(calls[2].capabilityApprovals, {
      "web.search": {
        approved: true,
        decision: "approved",
        source: "task_action",
      },
    });
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
  const chatCalls = [];
  const app = await createApp({
    ragService: {
      chat: async (docIds, question, options = {}) => {
        chatCalls.push({
          docIds,
          options,
          question,
        });

        return {
          text:
            chatCalls.length === 1
              ? "The archive says annual leave is 15 days. [Source 1]"
              : "Retried archive says annual leave is 15 days. [Source 1]",
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
          evidenceSummary: {
            supportedClaimCount: 1,
          },
          resolvedQuery: "What is annual leave?",
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
    const documentStep = agentRun.steps.find(
      (step) => step.type === "document_rag"
    );

    assert.ok(documentStep);
    assert.deepEqual(documentStep.input.docIds, ["doc-1"]);
    assert.equal(documentStep.input.question, "What is annual leave?");
    assert.equal(
      documentStep.input.retrievalPlan.retrievalQueries.length > 0,
      true
    );
    assert.equal(documentStep.output.citationCount, 1);
    assert.equal(
      documentStep.output.text,
      "The archive says annual leave is 15 days. [Source 1]"
    );
    const selfCheckStep = agentRun.steps.find((step) => step.type === "self_check");
    const synthesisStep = agentRun.steps.find((step) => step.type === "synthesis");
    const finalizerStep = agentRun.steps.find(
      (step) => step.type === "answer_finalizer"
    );

    assert.equal(selfCheckStep.output.passed, true);
    assert.equal(synthesisStep.input.agentMode, "document");
    assert.equal(synthesisStep.output.sourceCount, 1);
    assert.equal(finalizerStep.input.citationCount, 1);
    assert.equal(finalizerStep.output.removedClaimCount, 0);
    assert.deepEqual(
      agentRun.events.map((event) => event.type),
      [
        "run_created",
        "run_prepared",
        "execution_planned",
        "step_started",
        "step_completed",
        "run_completed",
      ]
    );
    assert.equal(chatCalls.length, 1);

    const retryResponse = await fetch(
      `${server.baseUrl}/agent-runs/${body.agentRunId}/steps/${encodeURIComponent(
        documentStep.id
      )}/actions/retry`,
      {
        method: "POST",
      }
    );

    assert.equal(retryResponse.status, 200);

    const retryBody = await retryResponse.json();
    const retryStep = retryBody.run.steps.find(
      (step) => step.retryOfStepId === documentStep.id
    );

    assert.equal(chatCalls.length, 2);
    assert.deepEqual(chatCalls[1].docIds, ["doc-1"]);
    assert.equal(chatCalls[1].question, "What is annual leave?");
    assert.deepEqual(
      chatCalls[1].options.retrievalPlan,
      documentStep.input.retrievalPlan
    );
    assert.equal(retryBody.response.agentMode, "document");
    assert.equal(
      retryBody.response.agentAnswer,
      "Retried archive says annual leave is 15 days. [Source 1]"
    );
    assert.equal(retryBody.response.ragSources.length, 1);
    assert.equal(retryBody.response.agentRunStatus, "completed");
    assert.equal(retryStep.status, "completed");
    assert.equal(retryStep.input.question, "What is annual leave?");
    assert.equal(retryStep.output.citationCount, 1);

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
        "workspace.search_documents",
        "citation.verify",
        "report.export",
        "recommendation.import_selected",
        "document.compare_batch",
        "task.create",
        "document.organize",
        "summary.create",
        "external.import",
      ]
    );
  } finally {
    await server.close();
  }
});

test("agent run recovery endpoints list and cancel manual recovery runs", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({
    agentRunStore,
  });

  await agentRunService.createRun({
    goal: "Recover interrupted document answer",
    runId: "run-recovery",
  });
  await agentRunService.updateRun({
    runId: "run-recovery",
    patch: {
      result: {
        recovery: {
          mode: "manual",
          reason: "server_startup_recovery",
        },
      },
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps: [
        {
          id: "step-document",
          input: {
            docIds: ["doc-1"],
            question: "What changed?",
          },
          type: "document_rag",
          kind: "tool_call",
          label: "Document RAG",
          status: "paused",
        },
      ],
    },
  });
  await agentRunService.appendRunEvent({
    runId: "run-recovery",
    type: "manual_recovery_required",
    payload: {
      reason: "server_startup_recovery",
    },
  });

  const app = await createApp({
    agentRunStore,
    healthService: okHealthService,
    ragService: {
      chat: async () => {
        throw new Error("Recovery endpoint should not invoke document RAG.");
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
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/agent-runs/recovery`);

    assert.equal(response.status, 200);

    const recoveryBody = await response.json();

    assert.equal(recoveryBody.runs.length, 1);
    assert.equal(recoveryBody.runs[0].runId, "run-recovery");
    assert.deepEqual(
      recoveryBody.runs[0].recovery.actions.map((action) => action.type),
      ["resume_from_step", "cancel"]
    );
    assert.equal(
      recoveryBody.runs[0].recovery.replaySafety.steps[0].canAutoReplay,
      true
    );
    assert.deepEqual(
      recoveryBody.runs[0].recovery.actions[0].safety.reasonCodes,
      []
    );

    response = await fetch(
      `${server.baseUrl}/agent-runs/run-recovery/recovery/actions/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: "operator_cancel",
        }),
      }
    );

    assert.equal(response.status, 200);

    const cancelBody = await response.json();

    assert.equal(cancelBody.run.status, "canceled");
    assert.equal(cancelBody.run.result.canceled, true);

    response = await fetch(`${server.baseUrl}/agent-runs/recovery`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).runs.length, 0);
  } finally {
    await server.close();
  }
});

test("agent run recovery API resumes a paused document step after restart", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const calls = [];

  await seedRecoverableAgentRun({
    agentRunStore,
    manualRecovery: true,
    patch: {
      result: {
        recovery: {
          mode: "manual",
          reason: "server_startup_recovery",
        },
      },
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps: [
        {
          id: "step-document-paused",
          input: {
            docIds: ["doc-1"],
            question: "What changed after restart?",
            retrievalPlan: {
              retrievalQueries: ["restart change"],
            },
            sessionId: "session-restart",
            userId: "alice",
          },
          kind: AGENT_RUN_STEP_KINDS.toolCall,
          label: "Document RAG",
          status: AGENT_RUN_STEP_STATUSES.paused,
          type: "document_rag",
        },
      ],
    },
    runId: "run-http-restart-resume",
  });

  const app = await createApp({
    agentRunRecoveryService: createNoopStartupRecoveryService(),
    agentRunStore,
    healthService: okHealthService,
    ragService: createRecoveryRagService({
      chat: async (docIds, question, options) => {
        calls.push({
          docIds,
          options,
          question,
        });

        return {
          citations: [
            {
              chunkIndex: 1,
              docId: "doc-1",
              excerpt: "Restarted recovery keeps the persisted input.",
              fileName: "restart.pdf",
              pageNumber: 2,
              rank: 1,
            },
          ],
          resolvedQuery: question,
          text: "Recovered after restart. [Source 1]",
        };
      },
    }),
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/agent-runs/recovery`, {
      headers: recoveryScopeHeaders,
    });

    assert.equal(response.status, 200);

    let body = await response.json();

    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].runId, "run-http-restart-resume");
    assert.deepEqual(
      body.runs[0].recovery.actions.map((action) => action.type),
      ["resume_from_step", "cancel"]
    );
    assert.equal(body.runs[0].recovery.replaySafety.canAutoReplay, true);

    response = await fetch(`${server.baseUrl}/agent-runs/recovery`, {
      headers: {
        "x-user-id": "bob",
        "x-workspace-id": "workspace-a",
      },
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).runs.length, 0);

    response = await fetch(
      `${server.baseUrl}/agent-runs/run-http-restart-resume/recovery/actions/resume_from_step`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...recoveryScopeHeaders,
        },
        body: JSON.stringify({
          stepId: "step-document-paused",
        }),
      }
    );

    assert.equal(response.status, 200);
    body = await response.json();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].docIds, ["doc-1"]);
    assert.equal(calls[0].question, "What changed after restart?");
    assert.equal(calls[0].options.accessScope.userId, recoveryAccessScope.userId);
    assert.equal(
      calls[0].options.accessScope.workspaceId,
      recoveryAccessScope.workspaceId
    );
    assert.deepEqual(calls[0].options.retrievalPlan, {
      retrievalQueries: ["restart change"],
    });
    assert.equal(body.response.agentMode, "document");
    assert.equal(body.response.agentRunStatus, "completed");
    assert.equal(body.response.agentAnswer, "Recovered after restart. [Source 1]");
    assert.equal(body.run.status, AGENT_RUN_STATUSES.completed);
    assert.equal(
      body.run.steps.find((step) => step.id === "step-document-paused").status,
      AGENT_RUN_STEP_STATUSES.completed
    );

    response = await fetch(`${server.baseUrl}/agent-runs/recovery`, {
      headers: recoveryScopeHeaders,
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).runs.length, 0);
  } finally {
    await server.close();
  }
});

test("agent run recovery API retries a failed document step after restart", async () => {
  const agentRunStore = createInMemoryAgentRunStore();
  const calls = [];

  await seedRecoverableAgentRun({
    agentRunStore,
    patch: {
      error: {
        message: "Simulated process failure.",
      },
      result: {
        error: "Document RAG failed before restart.",
      },
      status: AGENT_RUN_STATUSES.failed,
      steps: [
        {
          error: {
            message: "Simulated process failure.",
          },
          id: "step-document-failed",
          input: {
            docIds: ["doc-1"],
            question: "Retry after failure?",
          },
          kind: AGENT_RUN_STEP_KINDS.toolCall,
          label: "Document RAG",
          status: AGENT_RUN_STEP_STATUSES.failed,
          type: "document_rag",
        },
      ],
    },
    runId: "run-http-restart-retry",
  });

  const app = await createApp({
    agentRunRecoveryService: createNoopStartupRecoveryService(),
    agentRunStore,
    healthService: okHealthService,
    ragService: createRecoveryRagService({
      chat: async (docIds, question, options) => {
        calls.push({
          docIds,
          options,
          question,
        });

        return {
          citations: [],
          resolvedQuery: question,
          text: "Retried after restart.",
        };
      },
    }),
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/agent-runs/recovery`, {
      headers: recoveryScopeHeaders,
    });

    assert.equal(response.status, 200);

    let body = await response.json();

    assert.deepEqual(
      body.runs[0].recovery.actions.map((action) => action.type),
      ["retry_failed_step"]
    );
    assert.equal(body.runs[0].recovery.actions[0].stepId, "step-document-failed");

    response = await fetch(
      `${server.baseUrl}/agent-runs/run-http-restart-retry/recovery/actions/retry_failed_step`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...recoveryScopeHeaders,
        },
        body: JSON.stringify({
          stepId: "step-document-failed",
        }),
      }
    );

    assert.equal(response.status, 200);
    body = await response.json();

    const retryStep = body.run.steps.find(
      (step) => step.retryOfStepId === "step-document-failed"
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].docIds, ["doc-1"]);
    assert.equal(calls[0].question, "Retry after failure?");
    assert.equal(calls[0].options.accessScope.userId, recoveryAccessScope.userId);
    assert.equal(
      calls[0].options.accessScope.workspaceId,
      recoveryAccessScope.workspaceId
    );
    assert.equal(body.response.agentAnswer, "Retried after restart.");
    assert.equal(body.run.status, AGENT_RUN_STATUSES.completed);
    assert.equal(retryStep.status, AGENT_RUN_STEP_STATUSES.completed);
    assert.equal(retryStep.input.question, "Retry after failure?");
  } finally {
    await server.close();
  }
});

test("agent run recovery API exposes blocked approval safety after restart", async () => {
  const agentRunStore = createInMemoryAgentRunStore();

  await seedRecoverableAgentRun({
    agentRunStore,
    manualRecovery: true,
    patch: {
      result: {
        recovery: {
          mode: "manual",
          reason: "requires_approval",
        },
      },
      status: AGENT_RUN_STATUSES.waitingForUser,
      steps: [
        {
          id: "step-web-paused",
          input: {
            question: "What changed online?",
          },
          kind: AGENT_RUN_STEP_KINDS.toolCall,
          label: "Web Search",
          status: AGENT_RUN_STEP_STATUSES.paused,
          type: "web_search",
        },
      ],
    },
    runId: "run-http-restart-blocked-web",
  });

  const app = await createApp({
    agentRunRecoveryService: createNoopStartupRecoveryService(),
    agentRunStore,
    healthService: okHealthService,
    ragService: createRecoveryRagService({
      chat: async () => {
        throw new Error("Blocked recovery should not invoke document RAG.");
      },
    }),
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/agent-runs/recovery`, {
      headers: recoveryScopeHeaders,
    });

    assert.equal(response.status, 200);

    const body = await response.json();
    const run = body.runs[0];

    assert.equal(run.runId, "run-http-restart-blocked-web");
    assert.deepEqual(
      run.recovery.actions.map((action) => action.type),
      ["cancel"]
    );
    assert.deepEqual(run.recovery.replaySafety.reasonCodes, [
      STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval,
      STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
    ]);
    assert.equal(run.recovery.replaySafety.steps[0].canAutoReplay, false);

    response = await fetch(
      `${server.baseUrl}/agent-runs/run-http-restart-blocked-web/recovery/actions/resume_from_step`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...recoveryScopeHeaders,
        },
        body: JSON.stringify({
          stepId: "step-web-paused",
        }),
      }
    );

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /no safe step to resume/i);
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

test("chat endpoint agent gates web fallback when document evidence is insufficient", async () => {
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

    assert.equal(body.agentMode, "clarification");
    assert.equal(body.clarification.reason, "capability_approval_required");
    assert.equal(body.approvalGates[0].capabilityId, CAPABILITY_IDS.webSearch);
    assert.deepEqual(body.approvalGates[0].inputPreview, {
      question: "What is the latest launch date?",
    });
    assert.equal(body.ragAbstained, true);
    assert.equal(body.mcpAnswer, "Web search not used: clarification needed.");
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      [
        "plan",
        "query_planner",
        "document_rag",
        "self_check",
        "capability_approval_gate",
      ]
    );
  } finally {
    await server.close();
  }
});

test("agent run approval action resumes a pending capability gate", async () => {
  let webSearchCalls = 0;
  const capabilityRegistry = createCapabilityRegistry([
    {
      id: CAPABILITY_IDS.webSearch,
      version: "1.0.0",
      label: "Web Search",
      inputSchema: {
        type: "object",
        required: ["question"],
        properties: {
          question: {
            type: "string",
          },
        },
      },
      accessScope: {
        required: false,
      },
      approvalPolicy: {
        mode: "user_confirmation",
        writesWorkspace: false,
        userConfirmationRequired: true,
      },
      privacyPolicy: {
        externalCall: true,
        sanitizedInputFields: ["question"],
        storesResult: false,
      },
      execute: async ({ input }) => {
        webSearchCalls += 1;

        return {
          text: `Approved web answer for: ${input.question}`,
        };
      },
    },
  ]);
  const app = await createApp({
    capabilityRegistry,
    ragService: {
      chat: async () => {
        throw new Error("Document RAG should not run for direct web prompts.");
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
    chatMcp: async () => {
      throw new Error("Fallback web service should not run when registry is used.");
    },
    healthService: okHealthService,
  });
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: "Search the web for the current launch date",
      }),
    });

    assert.equal(response.status, 200);

    const pendingBody = await response.json();

    assert.equal(webSearchCalls, 0);
    assert.equal(pendingBody.clarification.reason, "capability_approval_required");
    assert.equal(pendingBody.approvalGates[0].status, "pending");

    response = await fetch(
      `${server.baseUrl}/agent-runs/${pendingBody.agentRunId}/actions/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gateId: pendingBody.approvalGates[0].id,
        }),
      }
    );

    assert.equal(response.status, 200);

    const resumedBody = await response.json();

    assert.equal(webSearchCalls, 1);
    assert.equal(resumedBody.response.agentRunId, pendingBody.agentRunId);
    assert.equal(resumedBody.response.agentMode, "web");
    assert.match(resumedBody.response.agentAnswer, /Approved web answer/);
    assert.equal(resumedBody.response.agentRunStatus, "completed");
    assert.ok(
      resumedBody.response.agentRunSteps.some(
        (step) =>
          step.kind === "capability_call" &&
          step.status === "completed" &&
          step.capabilityId === CAPABILITY_IDS.webSearch
      )
    );
    assert.equal(resumedBody.run.status, "completed");
    assert.equal(resumedBody.run.approvalGates[0].status, "approved");
    assert.match(
      resumedBody.run.approvalGates[0].stepId,
      /\d+-capability_approval_gate/
    );
    assert.deepEqual(
      resumedBody.run.events.map((event) => event.type),
      [
        "run_created",
        "run_prepared",
        "execution_planned",
        "step_started",
        "step_paused",
        "approval_gate_created",
        "run_completed",
        "approval_gate_approved",
        "step_started",
        "step_completed",
        "run_completed",
      ]
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

test("chat endpoint agent gates workspace document discovery", async () => {
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

    assert.equal(body.agentMode, "clarification");
    assert.equal(body.clarification.reason, "capability_approval_required");
    assert.equal(
      body.approvalGates[0].capabilityId,
      CAPABILITY_IDS.documentDiscovery
    );
    assert.deepEqual(body.approvalGates[0].inputPreview, {
      docIds: [],
      question: "Which document covers remote work approval?",
    });
    assert.deepEqual(
      body.agentTrace.map((step) => step.type),
      ["plan", "capability_approval_gate"]
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
              excerpt: `Finding for ${query}: refunds require 30 days notice.`,
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
      [
        "plan",
        "research_plan",
        "research_question",
        "research_question",
        "research_question",
        "synthesis",
        "self_check",
        "answer_finalizer",
      ]
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

test("admin status endpoint returns scoped compact snapshot behind auth", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;
  const calls = [];

  process.env.API_AUTH_ENABLED = "true";
  process.env.API_AUTH_TOKEN = "";
  process.env.API_AUTH_TOKENS = JSON.stringify({
    "admin-token": {
      roles: [ADMIN_ROLE_IDS.viewer],
      userId: "admin-user",
      workspaceId: "admin-workspace",
    },
  });

  try {
    const app = await createApp({
      agentRunRecoveryActionService: {
        listRecoveryRuns: async ({ accessScope }) => {
          calls.push(["recovery", accessScope]);

          return {
            runs: [
              {
                recovery: {
                  actions: [
                    {
                      type: "resume_from_step",
                    },
                  ],
                  required: true,
                },
                result: {
                  recovery: {
                    mode: "manual",
                    rawPrompt: "admin raw prompt should not leak",
                  },
                },
                status: AGENT_RUN_STATUSES.waitingForUser,
              },
            ],
          };
        },
      },
      agentRunRecoveryService: createNoopStartupRecoveryService(),
      agentRunService: {
        initialize: async () => true,
        listRuns: async ({ accessScope, status }) => {
          calls.push(["runs", status, accessScope]);

          if (status === AGENT_RUN_STATUSES.failed) {
            return {
              runs: [
                {
                  input: {
                    prompt: "admin private run prompt",
                  },
                  status,
                },
              ],
            };
          }

          return {
            runs: [],
          };
        },
      },
      agentTriggerRegistry: {
        listPublic: () => [
          {
            enabled: true,
            id: "enabled-trigger",
          },
          {
            enabled: false,
            id: "disabled-trigger",
          },
        ],
      },
      healthService: {
        buildHealthReport: async () => ({
          checks: {
            openai: {
              message: "OPENAI_API_KEY missing sk-secret-openai",
              status: "error",
            },
          },
          status: "error",
        }),
        runStartupHealthChecks: async () => ({
          checks: {},
          status: "ok",
        }),
      },
      jobOrchestrator: {
        recoverRunnableTasks: async () => ({
          scheduledCount: 0,
        }),
      },
      qualityService: {
        readLatestQualityReport: async () => ({
          failedCases: [
            {
              answer: "admin quality answer should not leak",
              question: "admin quality question should not leak",
            },
          ],
          status: "fail",
          summary: {
            metrics: {
              overallPassPercent: 50,
              overallPassRate: 0.5,
            },
            runId: "admin-quality-run",
          },
        }),
      },
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
      },
      taskService: {
        initialize: async () => true,
        listTasks: async ({ accessScope }) => {
          calls.push(["tasks", accessScope]);

          return {
            tasks: [
              {
                payload: {
                  secret: "sk-secret-task",
                },
                status: "queued",
              },
              {
                result: {
                  text: "admin private task result",
                },
                status: "failed",
              },
            ],
          };
        },
      },
    });
    const server = await startServer(app);

    try {
      let response = await fetch(`${server.baseUrl}/admin/status`);
      assert.equal(response.status, 401);

      response = await fetch(`${server.baseUrl}/admin/status`, {
        headers: {
          "x-api-key": "admin-token",
        },
      });
      assert.equal(response.status, 200);

      const body = await response.json();
      const serialized = JSON.stringify(body);

      assert.equal(body.status, "error");
      assert.equal(body.deployment.apiAuthEnabled, true);
      assert.equal(body.health.checks.openai.status, "error");
      assert.equal(body.quality.runId, "admin-quality-run");
      assert.equal(body.quality.failedCaseCount, 1);
      assert.equal(body.tasks.total, 2);
      assert.equal(body.tasks.failedCount, 1);
      assert.equal(body.agentRuns.failedCount, 1);
      assert.equal(body.agentRuns.recoveryCount, 1);
      assert.equal(body.triggers.enabledCount, 1);
      assert.equal(body.triggers.disabledCount, 1);
      assert.ok(
        body.warnings.some((warning) => warning.id === "health_openai_error")
      );
      assert.ok(body.warnings.some((warning) => warning.id === "quality_fail"));
      assert.deepEqual(calls.find(([type]) => type === "tasks"), [
        "tasks",
        {
          authenticated: true,
          roleIds: [ADMIN_ROLE_IDS.viewer],
          userId: "admin-user",
          workspaceId: "admin-workspace",
        },
      ]);
      assert.doesNotMatch(serialized, /sk-secret/);
      assert.doesNotMatch(serialized, /admin raw prompt/);
      assert.doesNotMatch(serialized, /admin private run prompt/);
      assert.doesNotMatch(serialized, /admin quality answer/);
      assert.doesNotMatch(serialized, /admin quality question/);
      assert.doesNotMatch(serialized, /admin private task result/);
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

test("admin status endpoint returns a generic route error", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;

  process.env.API_AUTH_ENABLED = "false";

  try {
    const app = await createApp({
      adminStatusService: {
        buildStatus: async () => {
          throw new Error("admin status failed with sk-secret-admin");
        },
      },
      healthService: okHealthService,
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
      },
    });
    const server = await startServer(app);

    try {
      const response = await fetch(`${server.baseUrl}/admin/status`);
      const body = await response.json();
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 500);
      assert.equal(body.error, "Failed to load admin status.");
      assert.doesNotMatch(serialized, /sk-secret-admin/);
    } finally {
      await server.close();
    }
  } finally {
    if (originalAuthEnabled === undefined) {
      delete process.env.API_AUTH_ENABLED;
    } else {
      process.env.API_AUTH_ENABLED = originalAuthEnabled;
    }
  }
});

test("admin endpoints enforce configured role permissions", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;
  const actionCalls = [];
  let statusCalls = 0;

  process.env.API_AUTH_ENABLED = "true";
  process.env.API_AUTH_TOKEN = "";
  process.env.API_AUTH_TOKENS = JSON.stringify({
    "no-admin-token": {
      userId: "plain-user",
      workspaceId: "workspace-a",
    },
    "quality-token": {
      permissions: [ADMIN_PERMISSION_IDS.adminActionQualityRefresh],
      userId: "quality-user",
      workspaceId: "workspace-a",
    },
    "viewer-token": {
      roles: [ADMIN_ROLE_IDS.viewer],
      userId: "viewer-user",
      workspaceId: "workspace-a",
    },
  });

  try {
    const app = await createApp({
      adminActionRegistry: {
        runAction: async ({ actionId, accessScope }) => {
          actionCalls.push([actionId, accessScope]);

          return {
            action: {
              id: actionId,
              label: "Stub admin action",
            },
            result: {
              ok: true,
            },
            status: "completed",
          };
        },
      },
      adminStatusService: {
        buildStatus: async ({ accessScope }) => {
          statusCalls += 1;

          return {
            accessScope,
            status: "ok",
          };
        },
      },
      healthService: okHealthService,
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
      },
    });
    const server = await startServer(app);

    try {
      let response = await fetch(`${server.baseUrl}/admin/status`, {
        headers: {
          "x-api-key": "no-admin-token",
        },
      });
      let body = await response.json();

      assert.equal(response.status, 403);
      assert.equal(body.error, "Forbidden.");
      assert.deepEqual(body.adminAuthorization, {
        permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
        reason: ADMIN_PERMISSION_REASONS.deniedMissingPermission,
      });
      assert.equal(statusCalls, 0);

      response = await fetch(`${server.baseUrl}/admin/status`, {
        headers: {
          "x-api-key": "viewer-token",
        },
      });
      body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(statusCalls, 1);
      assert.deepEqual(body.accessScope, {
        authenticated: true,
        roleIds: [ADMIN_ROLE_IDS.viewer],
        userId: "viewer-user",
        workspaceId: "workspace-a",
      });

      response = await fetch(
        `${server.baseUrl}/admin/actions/${ADMIN_ACTION_IDS.recoverTasks}`,
        {
          headers: {
            "x-api-key": "viewer-token",
          },
          method: "POST",
        }
      );
      body = await response.json();

      assert.equal(response.status, 403);
      assert.deepEqual(body.adminAuthorization, {
        permissionId: ADMIN_PERMISSION_IDS.adminActionRecoverTasks,
        reason: ADMIN_PERMISSION_REASONS.deniedMissingPermission,
      });
      assert.deepEqual(actionCalls, []);

      response = await fetch(
        `${server.baseUrl}/admin/actions/${ADMIN_ACTION_IDS.qualityRefresh}`,
        {
          headers: {
            "x-api-key": "quality-token",
          },
          method: "POST",
        }
      );
      body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.action.id, ADMIN_ACTION_IDS.qualityRefresh);
      assert.deepEqual(actionCalls, [
        [
          ADMIN_ACTION_IDS.qualityRefresh,
          {
            authenticated: true,
            permissionIds: [ADMIN_PERMISSION_IDS.adminActionQualityRefresh],
            userId: "quality-user",
            workspaceId: "workspace-a",
          },
        ],
      ]);
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

test("admin audit endpoint exposes compact authorization decisions", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;

  process.env.API_AUTH_ENABLED = "true";
  process.env.API_AUTH_TOKEN = "";
  process.env.API_AUTH_TOKENS = JSON.stringify({
    "operator-token": {
      roles: [ADMIN_ROLE_IDS.operator],
      userId: "operator-user",
      workspaceId: "workspace-a",
    },
    "plain-token": {
      userId: "plain-user",
      workspaceId: "workspace-a",
    },
    "viewer-token": {
      roles: [ADMIN_ROLE_IDS.viewer],
      userId: "viewer-user",
      workspaceId: "workspace-a",
    },
  });

  try {
    const app = await createApp({
      adminStatusService: {
        buildStatus: async () => ({
          status: "ok",
        }),
      },
      healthService: okHealthService,
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
      },
    });
    const server = await startServer(app);

    try {
      let response = await fetch(`${server.baseUrl}/admin/status`, {
        headers: {
          "x-api-key": "plain-token",
        },
      });
      assert.equal(response.status, 403);

      response = await fetch(`${server.baseUrl}/admin/audit`, {
        headers: {
          "x-api-key": "viewer-token",
        },
      });
      assert.equal(response.status, 403);

      response = await fetch(`${server.baseUrl}/admin/audit?limit=10`, {
        headers: {
          "x-api-key": "operator-token",
        },
      });
      const body = await response.json();
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 200);
      assert.equal(body.status, "ok");
      assert.equal(body.total, 3);
      assert.equal(body.events.length, 3);
      assert.deepEqual(
        body.events.map((event) => event.authorization.permissionId),
        [
          ADMIN_PERMISSION_IDS.adminAuditRead,
          ADMIN_PERMISSION_IDS.adminAuditRead,
          ADMIN_PERMISSION_IDS.adminStatusRead,
        ]
      );
      assert.deepEqual(
        body.events.map((event) => event.result),
        ["allowed", "denied", "denied"]
      );
      assert.equal(body.events[0].principal.userId, "operator-user");
      assert.equal(body.events[1].principal.userId, "viewer-user");
      assert.equal(body.events[2].principal.userId, "plain-user");
      assert.doesNotMatch(serialized, /operator-token/);
      assert.doesNotMatch(serialized, /viewer-token/);
      assert.doesNotMatch(serialized, /plain-token/);

      response = await fetch(
        `${server.baseUrl}/admin/audit?result=denied&userId=plain-user&limit=5`,
        {
          headers: {
            "x-api-key": "operator-token",
          },
        }
      );
      const filteredBody = await response.json();

      assert.equal(response.status, 200);
      assert.equal(filteredBody.status, "ok");
      assert.equal(filteredBody.total, 1);
      assert.equal(filteredBody.events.length, 1);
      assert.equal(filteredBody.events[0].principal.userId, "plain-user");
      assert.equal(filteredBody.events[0].result, "denied");
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

test("admin actions endpoint runs controlled actions behind auth", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;
  const originalAuthToken = process.env.API_AUTH_TOKEN;
  const originalAuthTokens = process.env.API_AUTH_TOKENS;
  const calls = [];

  process.env.API_AUTH_ENABLED = "true";
  process.env.API_AUTH_TOKEN = "";
  process.env.API_AUTH_TOKENS = JSON.stringify({
    "admin-action-token": {
      roles: [ADMIN_ROLE_IDS.operator],
      userId: "admin-user",
      workspaceId: "admin-workspace",
    },
  });

  try {
    const app = await createApp({
      agentRunRecoveryActionService: {
        listRecoveryRuns: async ({ accessScope }) => {
          calls.push(["recovery-scan", accessScope]);

          return {
            runs: [
              {
                input: {
                  prompt: "admin action private run prompt",
                },
                recovery: {
                  actions: [
                    {
                      label: "Resume document RAG",
                      reason: "safe_step_ready",
                      stepId: "step-1",
                      stepType: "document_rag",
                      type: "resume_from_step",
                    },
                  ],
                  reason: "safe_step_ready",
                  replaySafety: {
                    canAutoReplay: true,
                    reasonCodes: [],
                    steps: [
                      {
                        input: {
                          question: "admin private replay input",
                        },
                      },
                    ],
                  },
                  required: true,
                  stepId: "step-1",
                },
                runId: "run-admin-action",
                status: AGENT_RUN_STATUSES.waitingForUser,
              },
            ],
          };
        },
      },
      agentRunRecoveryService: createNoopStartupRecoveryService(),
      agentRunService: {
        initialize: async () => true,
        listRuns: async () => ({
          runs: [],
        }),
      },
      healthService: okHealthService,
      jobOrchestrator: {
        recoverRunnableTasks: async () => {
          calls.push(["recover-tasks"]);

          return {
            scheduledCount: 3,
            tasks: [
              {
                payload: {
                  secret: "sk-secret-task",
                },
              },
            ],
          };
        },
        recoverRunnableTasksCalled: true,
      },
      qualityService: {
        readLatestQualityReport: async () => ({
          status: "pass",
          summary: {},
        }),
        runSyntheticQualityEvaluation: async ({ corpusPath }) => {
          calls.push(["quality-refresh", corpusPath]);

          return {
            failedCases: [
              {
                question: "admin action private quality question",
              },
            ],
            status: "pass",
            summary: {
              corpus: {
                cases: 1,
                path: corpusPath,
              },
              metrics: {
                overallPassPercent: 100,
              },
              runId: "admin-action-quality",
            },
          };
        },
      },
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
      },
    });
    const server = await startServer(app);
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": "admin-action-token",
    };

    try {
      let response = await fetch(
        `${server.baseUrl}/admin/actions/${ADMIN_ACTION_IDS.recoverTasks}`,
        {
          method: "POST",
        }
      );
      assert.equal(response.status, 401);

      response = await fetch(
        `${server.baseUrl}/admin/actions/${ADMIN_ACTION_IDS.recoverTasks}`,
        {
          headers,
          method: "POST",
        }
      );
      let body = await response.json();
      let serialized = JSON.stringify(body);

      assert.equal(response.status, 200);
      assert.equal(body.action.id, ADMIN_ACTION_IDS.recoverTasks);
      assert.deepEqual(body.result, {
        scheduledCount: 3,
      });
      assert.doesNotMatch(serialized, /sk-secret-task/);

      response = await fetch(
        `${server.baseUrl}/admin/actions/${ADMIN_ACTION_IDS.recoveryScan}`,
        {
          headers,
          method: "POST",
        }
      );
      body = await response.json();
      serialized = JSON.stringify(body);

      assert.equal(response.status, 200);
      assert.equal(body.action.id, ADMIN_ACTION_IDS.recoveryScan);
      assert.equal(body.result.total, 1);
      assert.equal(body.result.actionCount, 1);
      assert.equal(body.result.runs[0].runId, "run-admin-action");
      assert.deepEqual(
        calls.find(([type]) => type === "recovery-scan"),
        [
          "recovery-scan",
          {
            authenticated: true,
            roleIds: [ADMIN_ROLE_IDS.operator],
            userId: "admin-user",
            workspaceId: "admin-workspace",
          },
        ]
      );
      assert.doesNotMatch(serialized, /admin action private run prompt/);
      assert.doesNotMatch(serialized, /admin private replay input/);

      response = await fetch(
        `${server.baseUrl}/admin/actions/${ADMIN_ACTION_IDS.qualityRefresh}`,
        {
          body: JSON.stringify({
            corpusPath: " evaluation/synthetic-corpus-compare-hard.json ",
          }),
          headers,
          method: "POST",
        }
      );
      body = await response.json();
      serialized = JSON.stringify(body);

      assert.equal(response.status, 200);
      assert.equal(body.action.id, ADMIN_ACTION_IDS.qualityRefresh);
      assert.equal(body.result.quality.runId, "admin-action-quality");
      assert.equal(body.result.quality.failedCaseCount, 1);
      assert.deepEqual(
        calls.find(([type]) => type === "quality-refresh"),
        ["quality-refresh", "evaluation/synthetic-corpus-compare-hard.json"]
      );
      assert.doesNotMatch(serialized, /admin action private quality question/);
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

test("admin actions endpoint exposes only controlled route errors", async () => {
  const originalAuthEnabled = process.env.API_AUTH_ENABLED;

  process.env.API_AUTH_ENABLED = "false";

  try {
    const app = await createApp({
      adminActionRegistry: {
        runAction: async () => {
          throw new Error("admin action failed with sk-secret-admin-action");
        },
      },
      healthService: okHealthService,
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeSessionMemory: async () => true,
      },
    });
    const server = await startServer(app);

    try {
      let response = await fetch(
        `${server.baseUrl}/admin/actions/${ADMIN_ACTION_IDS.recoverTasks}`,
        {
          method: "POST",
        }
      );
      let body = await response.json();

      assert.equal(response.status, 500);
      assert.equal(body.error, "Failed to run admin action.");
      assert.doesNotMatch(JSON.stringify(body), /sk-secret-admin-action/);

      const controlledApp = await createApp({
        adminActionRegistry: {
          runAction: async () => {
            const error = new Error("Admin action not found.");
            error.expose = true;
            error.status = 404;
            throw error;
          },
        },
        healthService: okHealthService,
        ragService: {
          initializeDocumentRegistry: async () => [],
          initializeSessionMemory: async () => true,
        },
      });
      const controlledServer = await startServer(controlledApp);

      try {
        response = await fetch(
          `${controlledServer.baseUrl}/admin/actions/unknown-action`,
          {
            method: "POST",
          }
        );
        body = await response.json();

        assert.equal(response.status, 404);
        assert.equal(body.error, "Admin action not found.");
      } finally {
        await controlledServer.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    if (originalAuthEnabled === undefined) {
      delete process.env.API_AUTH_ENABLED;
    } else {
      process.env.API_AUTH_ENABLED = originalAuthEnabled;
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
  const recordedExperienceFeedback = [];
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
      agentExperienceMemoryService: {
        recordFromFeedback: async ({ feedback }) => {
          recordedExperienceFeedback.push(feedback);
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
      assert.equal(recordedExperienceFeedback.length, 1);
      assert.equal(recordedExperienceFeedback[0].feedbackId, recordedFeedback[0].feedbackId);
      assert.equal(recordedExperienceFeedback[0].userId, "alice");

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
