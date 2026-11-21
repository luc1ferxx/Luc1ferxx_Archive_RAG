import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArxivTopicFromDocumentProfile,
  createArxivEnrichmentService,
  evaluateArxivPaperRelevance,
  rankArxivTopicCandidatesFromDocumentProfile,
} from "../rag/arxiv-enrichment.js";
import {
  createJobOrchestrator,
  TASK_ACTIONS,
} from "../rag/job-orchestrator.js";
import { createPostgresTaskStore } from "../rag/postgres-task-store.js";
import { createInMemoryRecommendationSnapshotStore } from "../rag/recommendation-snapshots.js";
import { createRecommendationTaskService } from "../rag/recommendation-tasks.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_STATUSES,
} from "../rag/tasks.js";

test("arxiv enrichment derives a public topic while filtering profile entities", () => {
  const topic = buildArxivTopicFromDocumentProfile({
    fileName: "confidential-project-redwood.pdf",
    profile: {
      summary: "Customer Alpha private roadmap for Redwood.",
      tags: ["retrieval", "augmented", "generation", "internal", "redwood"],
      entities: ["Customer Alpha", "REDWOOD-917"],
    },
  });

  assert.equal(topic, "retrieval augmented generation");
  assert.equal(topic.includes("Customer"), false);
  assert.equal(topic.includes("REDWOOD-917"), false);
});

test("arxiv enrichment ranks summary keyphrases when tags are generic", () => {
  const topic = buildArxivTopicFromDocumentProfile({
    fileName: "paper-notes.pdf",
    profile: {
      summary:
        "Graph neural networks improve molecule property prediction. Graph neural networks support molecular representation learning.",
      tags: ["document", "report"],
      entities: [],
    },
  });

  assert.equal(topic, "graph neural networks molecule");
  assert.equal(topic.includes("improve"), false);
  assert.equal(topic.includes("support"), false);
});

test("arxiv enrichment filters private entities and internal terms before ranking", () => {
  const rankedTerms = rankArxivTopicCandidatesFromDocumentProfile(
    {
      fileName: "customer-alpha-redwood-917.pdf",
      profile: {
        summary:
          "Customer Alpha REDWOOD-917 rollout notes. Retrieval augmented generation improves grounded question answering. Retrieval augmented generation pairs with hybrid retrieval for Project Redwood.",
        tags: [
          "alpha",
          "redwood",
          "generation",
          "retrieval",
          "internal",
          "question",
          "answering",
        ],
        entities: ["Customer Alpha", "REDWOOD-917", "Project Redwood"],
      },
    },
    {
      limit: 8,
    }
  );

  assert.deepEqual(rankedTerms.slice(0, 4), [
    "retrieval",
    "augmented",
    "generation",
    "question",
  ]);
  assert.equal(rankedTerms.includes("alpha"), false);
  assert.equal(rankedTerms.includes("redwood"), false);
  assert.equal(rankedTerms.includes("redwood-917"), false);
  assert.equal(rankedTerms.includes("customer"), false);
  assert.equal(rankedTerms.includes("internal"), false);
});

test("arxiv enrichment scores paper relevance from title and summary overlap", () => {
  const document = {
    profile: {
      summary: "Retrieval augmented generation improves grounded archives.",
      tags: ["retrieval", "augmented", "generation"],
    },
  };
  const relevantPaper = evaluateArxivPaperRelevance({
    document,
    paper: {
      title: "Retrieval Augmented Generation for Archives",
      summary: "Grounded document question answering with citations.",
    },
    topic: "retrieval augmented generation",
  });
  const irrelevantPaper = evaluateArxivPaperRelevance({
    document,
    paper: {
      title: "Convolutional Networks for Image Segmentation",
      summary: "Vision models for medical image masks.",
    },
    topic: "retrieval augmented generation",
  });

  assert.equal(relevantPaper.passed, true);
  assert.deepEqual(relevantPaper.matchedTerms.slice(0, 3), [
    "retrieval",
    "augmented",
    "generation",
  ]);
  assert.equal(irrelevantPaper.passed, false);
});

test("arxiv enrichment returns suggestions for a scoped document", async () => {
  const searchCalls = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importTopic: async () => {
        throw new Error("import should not run for suggestions");
      },
    },
    arxivService: {
      search: async ({ maxResults, topic }) => {
        searchCalls.push({
          maxResults,
          topic,
        });

        return [
          {
            arxivId: "2401.00001v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
            summary: "Retrieval augmented generation for archive search.",
            title: "Retrieval Augmented Generation for Archives",
          },
        ];
      },
    },
    recommendationTaskService: createRecommendationTaskService({
      taskService,
    }),
    ragService: {
      getDocument: (docId, accessScope) => {
        assert.equal(docId, "doc-1");

        if (
          accessScope?.userId !== "alice" ||
          accessScope?.workspaceId !== "workspace-a"
        ) {
          return null;
        }

        return {
          docId,
          fileName: "private-notes.pdf",
          profile: {
            tags: ["retrieval", "augmented", "generation"],
          },
        };
      },
    },
  });

  const result = await service.suggestForDocument({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    docId: "doc-1",
    maxResults: 3,
  });

  assert.equal(result.topic, "retrieval augmented generation");
  assert.equal(result.papers.length, 1);
  assert.match(result.selectionToken, /^v1\./);
  assert.deepEqual(searchCalls, [
    {
      maxResults: 3,
      topic: "retrieval augmented generation",
    },
  ]);

  const savedResult = service.listSavedSuggestions({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(savedResult.suggestions.length, 1);
  assert.equal(savedResult.suggestions[0].document.docId, "doc-1");
  assert.equal(savedResult.suggestions[0].provider, "arxiv");
  assert.equal(savedResult.suggestions[0].papers.length, 1);

  const savedDocumentResult = service.getSavedSuggestionForDocument({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    docId: "doc-1",
  });

  assert.equal(savedDocumentResult.papers[0].arxivId, "2401.00001v1");

  assert.deepEqual(
    service.listSavedSuggestions({
      accessScope: {
        userId: "bob",
        workspaceId: "workspace-b",
      },
    }),
    {
      suggestions: [],
    }
  );

  const tasks = (await taskService.listTasks({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    type: "external_recommendation",
  })).tasks;

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, TASK_STATUSES.waitingForUser);
  assert.equal(tasks[0].counts.recommended, 1);
});

test("arxiv enrichment uses sanitized external query policy for search, task input, and trace", async () => {
  const searchCalls = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importTopic: async () => {
        throw new Error("import should not run for suggestions");
      },
    },
    arxivService: {
      search: async ({ topic }) => {
        searchCalls.push(topic);

        return [
          {
            arxivId: "2401.00001v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
            summary: "Retrieval augmented generation for archive search.",
            title: "Retrieval Augmented Generation for Archives",
          },
        ];
      },
    },
    recommendationTaskService: createRecommendationTaskService({
      taskService,
    }),
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "customer-alpha-evelyn-stone-private-ACME-X42.pdf",
        profile: {
          entities: [
            "Customer Alpha",
            "Project Redwood",
            "Evelyn Stone",
            "ACME-X42",
          ],
          summary:
            "Customer Alpha ACME-X42 confidential private proprietary notes by Evelyn Stone for Project Redwood. Retrieval augmented generation.",
          tags: [
            "Customer Alpha",
            "Project Redwood",
            "Evelyn Stone",
            "ACME-X42",
            "confidential",
            "private",
            "proprietary",
            "retrieval",
            "augmented",
            "generation",
          ],
        },
      }),
    },
  });

  const result = await service.suggestForDocument({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    docId: "doc-1",
    maxResults: 3,
  });
  const tasks = (await taskService.listTasks({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    type: "external_recommendation",
  })).tasks;
  const savedSuggestion = service.listSavedSuggestions({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  }).suggestions[0];

  assert.deepEqual(searchCalls, ["retrieval augmented generation"]);
  assert.equal(result.topic, "retrieval augmented generation");
  assert.equal(result.document.fileName, "Uploaded document");
  assert.equal(result.queryPolicy.sanitizedQuery, "retrieval augmented generation");
  assert.equal(
    result.trace.externalQueryPolicy.sanitizedQuery,
    "retrieval augmented generation"
  );
  assert.equal(tasks[0].input.topic, "retrieval augmented generation");
  assert.equal(tasks[0].subject.label, "Uploaded document");
  assert.equal(
    tasks[0].input.queryPolicy.sanitizedQuery,
    "retrieval augmented generation"
  );
  assert.equal(
    savedSuggestion.document.fileName,
    "Uploaded document"
  );
  assert.equal(
    savedSuggestion.queryPolicy.sanitizedQuery,
    "retrieval augmented generation"
  );

  const safePolicyPayload = JSON.stringify({
    resultPolicy: result.queryPolicy,
    savedPolicy: savedSuggestion.queryPolicy,
    savedSuggestion,
    task: tasks[0],
    taskPolicy: tasks[0].input.queryPolicy,
    tracePolicy: result.trace.externalQueryPolicy,
  }).toLowerCase();

  for (const sensitiveTerm of [
    "customer alpha",
    "evelyn",
    "stone",
    "evelyn stone",
    "acme-x42",
    "redwood",
    "confidential",
    "private",
    "proprietary",
  ]) {
    assert.equal(safePolicyPayload.includes(sensitiveTerm), false);
  }
});

test("arxiv enrichment filters irrelevant papers before returning suggestions", async () => {
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importTopic: async () => {
        throw new Error("import should not run for suggestions");
      },
    },
    arxivService: {
      search: async () => [
        {
          arxivId: "2401.00001v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
          summary:
            "Retrieval augmented generation improves grounded answers over archive documents.",
          title: "Retrieval Augmented Generation for Archives",
        },
        {
          arxivId: "2401.00002v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00002v1",
          summary: "Vision models for medical image masks.",
          title: "Convolutional Networks for Image Segmentation",
        },
      ],
    },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  const result = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });

  assert.deepEqual(
    result.papers.map((paper) => paper.arxivId),
    ["2401.00001v1"]
  );
  assert.match(result.selectionToken, /^v1\./);
  assert.equal(result.reason, null);
});

test("arxiv enrichment reports when search results fail relevance checks", async () => {
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importTopic: async () => {
        throw new Error("import should not run for suggestions");
      },
    },
    arxivService: {
      search: async () => [
        {
          arxivId: "2401.00002v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00002v1",
          summary: "Vision models for medical image masks.",
          title: "Convolutional Networks for Image Segmentation",
        },
      ],
    },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  const result = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });

  assert.deepEqual(result.papers, []);
  assert.equal(result.selectionToken, null);
  assert.equal(result.reason, "no_relevant_arxiv_matches");
});

test("arxiv enrichment imports papers only after confirmation", async () => {
  const imports = [];
  const searches = [];
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async ({ importContext, maxResults, papers, topic }) => {
        imports.push({
          importContext,
          maxResults,
          paperIds: papers.map((paper) => paper.arxivId),
          topic,
        });

        return {
          topic,
          requestedMaxResults: maxResults,
          foundCount: papers.length,
          importedCount: papers.length,
          skippedCount: 0,
          failedCount: 0,
          importedPapers: [],
          skippedPapers: [],
          failedPapers: [],
        };
      },
    },
    arxivService: {
      search: async ({ maxResults, topic }) => {
        searches.push({
          maxResults,
          topic,
        });

        return [
          {
            arxivId: "2401.00001v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
            summary: "Retrieval augmented generation for archive search.",
            title: "Retrieval Augmented Generation for Archives",
          },
          {
            arxivId: "2401.00002v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00002v1",
            summary:
              "Retrieval augmented generation improves grounded question answering with private documents.",
            title: "Grounded Question Answering with Documents",
          },
          {
            arxivId: "2401.00003v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00003v1",
            summary:
              "Hybrid retrieval supports retrieval augmented generation over private workspaces.",
            title: "Hybrid Retrieval for Private Workspaces",
          },
        ];
      },
    },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  const suggestion = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });

  assert.equal(imports.length, 0);

  const result = await service.importForDocument({
    docId: "doc-1",
    selectionToken: suggestion.selectionToken,
  });

  assert.equal(result.document.docId, "doc-1");
  assert.equal(result.importedCount, 3);
  assert.deepEqual(searches, [
    {
      maxResults: 3,
      topic: "retrieval augmented generation",
    },
  ]);
  assert.deepEqual(imports, [
    {
      importContext: {
        importedByUserConfirmation: true,
        relatedToDocId: "doc-1",
      },
      maxResults: 3,
      paperIds: ["2401.00001v1", "2401.00002v1", "2401.00003v1"],
      topic: "retrieval augmented generation",
    },
  ]);
  assert.deepEqual(service.listSavedSuggestions(), {
    suggestions: [],
  });
});

test("arxiv enrichment imports only selected recommended papers", async () => {
  const imports = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async ({ maxResults, papers }) => {
        imports.push({
          maxResults,
          paperIds: papers.map((paper) => paper.arxivId),
        });

        return {
          topic: "retrieval augmented generation",
          requestedMaxResults: maxResults,
          foundCount: papers.length,
          importedCount: papers.length,
          skippedCount: 0,
          failedCount: 0,
          importedPapers: [],
          skippedPapers: [],
          failedPapers: [],
        };
      },
    },
    arxivService: {
      search: async () => [
        {
          arxivId: "2401.00001v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
          summary: "Retrieval augmented generation for archive search.",
          title: "Retrieval Augmented Generation for Archives",
        },
        {
          arxivId: "2401.00002v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00002v1",
          summary:
            "Retrieval augmented generation improves grounded question answering with private documents.",
          title: "Grounded Question Answering with Documents",
        },
        {
          arxivId: "2401.00003v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00003v1",
          summary:
            "Hybrid retrieval supports retrieval augmented generation over private workspaces.",
          title: "Hybrid Retrieval for Private Workspaces",
        },
      ],
    },
    recommendationTaskService: createRecommendationTaskService({
      taskService,
    }),
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  const suggestion = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });

  const result = await service.importForDocument({
    docId: "doc-1",
    selectedArxivIds: ["2401.00003v1", "2401.00001v1"],
    selectionToken: suggestion.selectionToken,
  });

  assert.equal(result.importedCount, 2);
  assert.deepEqual(imports, [
    {
      maxResults: 2,
      paperIds: ["2401.00003v1", "2401.00001v1"],
    },
  ]);

  const savedResult = service.listSavedSuggestions();

  assert.deepEqual(
    savedResult.suggestions[0].papers.map((paper) => paper.arxivId),
    ["2401.00002v1"]
  );
  assert.match(savedResult.suggestions[0].selectionToken, /^v1\./);

  const tasks = (await taskService.listTasks({
    type: "external_recommendation",
  })).tasks;

  assert.equal(tasks[0].status, TASK_STATUSES.waitingForUser);
  assert.equal(tasks[0].counts.imported, 2);
  assert.equal(tasks[0].counts.remaining, 1);
  assert.deepEqual(tasks[0].result.remainingPaperIds, ["2401.00002v1"]);
  // The paper left is a new offer, on the task as in the saved suggestion.
  assert.equal(
    (await taskService.getInternalTask({ taskId: tasks[0].id })).payload.selectionToken,
    savedResult.suggestions[0].selectionToken
  );
});

test("an import that failed can be confirmed again from the offer it came from", async () => {
  const taskService = createTaskService({ taskStore: createInMemoryTaskStore() });
  let failImport = true;
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async ({ papers }) => {
        if (failImport) {
          throw new Error("disk full");
        }

        return { failedPapers: [], importedCount: papers.length, importedPapers: [], skippedPapers: [] };
      },
    },
    arxivService: { search: async () => RACE_PAPERS },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: { tags: ["retrieval", "augmented", "generation"] },
      }),
    },
    recommendationTaskService: createRecommendationTaskService({ taskService }),
  });
  const orchestrator = createJobOrchestrator({
    runners: { [service.importJobRunner.id]: service.importJobRunner },
    taskService,
  });
  const suggestion = await service.suggestForDocument({ docId: "doc-1", maxResults: 3 });
  const confirm = () =>
    orchestrator.resumeTask({
      action: TASK_ACTIONS.confirm,
      payload: { selectedArxivIds: ["2401.00001v1"], selectionToken: suggestion.selectionToken },
      runImmediately: false,
      taskId: RACE_TASK_ID,
    });

  await confirm();
  assert.equal((await orchestrator.runTask({ taskId: RACE_TASK_ID })).status, TASK_STATUSES.failed);

  failImport = false;
  assert.equal((await confirm()).status, TASK_STATUSES.queued);

  // Imported; the other paper of the offer is left to confirm.
  const retried = await orchestrator.runTask({ taskId: RACE_TASK_ID });

  assert.equal(retried.counts.imported, 1);
  assert.equal(retried.status, TASK_STATUSES.waitingForUser);
});

test("arxiv enrichment runner queues confirmed imports and records per-paper progress", async () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const imports = [];
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async ({ onPaperProgress, papers }) => {
        imports.push(papers.map((paper) => paper.arxivId));
        await onPaperProgress?.({
          paper: papers[0],
          status: "downloading",
        });
        await onPaperProgress?.({
          paper: papers[0],
          result: {
            arxivId: papers[0].arxivId,
            docId: "doc-arxiv",
            fileName: "arxiv-2401.00001.pdf",
            status: "imported",
            title: papers[0].title,
          },
          status: "imported",
        });

        return {
          topic: "retrieval augmented generation",
          requestedMaxResults: papers.length,
          foundCount: papers.length,
          importedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          importedPapers: [
            {
              arxivId: papers[0].arxivId,
              docId: "doc-arxiv",
              fileName: "arxiv-2401.00001.pdf",
              status: "imported",
              title: papers[0].title,
            },
          ],
          skippedPapers: [],
          failedPapers: [],
        };
      },
    },
    arxivService: {
      search: async () => [
        {
          arxivId: "2401.00001v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
          summary: "Retrieval augmented generation for archive search.",
          title: "Retrieval Augmented Generation for Archives",
        },
      ],
    },
    recommendationTaskService: createRecommendationTaskService({
      taskService,
    }),
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  const suggestion = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });

  assert.equal(suggestion.task.status, TASK_STATUSES.waitingForUser);
  assert.equal(suggestion.task.payload, undefined);

  // The job orchestrator hands the runner the stored task, offer included.
  const queuedTask = await service.importJobRunner.resume({
    action: "confirm",
    payload: {
      selectedArxivIds: ["2401.00001v1"],
      selectionToken: suggestion.selectionToken,
    },
    task: await taskService.getInternalTask({ taskId: suggestion.task.id }),
  });

  assert.equal(queuedTask.status, TASK_STATUSES.queued);
  assert.equal(queuedTask.payload, undefined);

  const internalTask = await taskService.getInternalTask({
    taskId: suggestion.task.id,
  });

  assert.equal(internalTask.payload.selectedPapers.length, 1);

  const finalTask = await service.importJobRunner.run({
    patchTask: (patch) =>
      taskService.patchTask({
        taskId: suggestion.task.id,
        patch,
      }),
    task: internalTask,
  });

  assert.deepEqual(imports, [["2401.00001v1"]]);
  assert.equal(finalTask.status, TASK_STATUSES.completed);
  assert.equal(finalTask.items[0].status, TASK_STATUSES.completed);
  assert.equal(finalTask.items[0].result.docId, "doc-arxiv");
});

// A search rewrites the document's one task, which would stop its import.
test("arxiv enrichment refuses a new search while the document's import is queued or running", async () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  let searchCount = 0;
  const service = createArxivEnrichmentService({
    arxivImportService: {},
    arxivService: {
      search: async () => {
        searchCount += 1;

        return [
          {
            arxivId: "2401.00001v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
            summary: "Retrieval augmented generation for archive search.",
            title: "Retrieval Augmented Generation for Archives",
          },
        ];
      },
    },
    recommendationTaskService: createRecommendationTaskService({
      taskService,
    }),
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });
  const suggestion = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });

  await service.importJobRunner.resume({
    action: "confirm",
    payload: {
      selectedArxivIds: ["2401.00001v1"],
      selectionToken: suggestion.selectionToken,
    },
    task: await taskService.getInternalTask({ taskId: suggestion.task.id }),
  });

  for (const status of [TASK_STATUSES.queued, TASK_STATUSES.running]) {
    await taskService.patchTask({
      patch: { status },
      taskId: suggestion.task.id,
    });
    await assert.rejects(
      service.suggestForDocument({
        docId: "doc-1",
        maxResults: 3,
      }),
      {
        message: "An arXiv import for this document is still running.",
        status: 409,
      }
    );
    assert.equal(
      (await taskService.getTask({ taskId: suggestion.task.id })).status,
      status
    );
  }

  assert.equal(searchCount, 1);
});

test("arxiv background task writes remain fenced after cancellation", async () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  let releaseImport;
  let markImportStarted;
  let importAssertClaimActive;
  let importCompleted = false;
  let importSignal;
  const importStarted = new Promise((resolve) => {
    markImportStarted = resolve;
  });
  const importReleased = new Promise((resolve) => {
    releaseImport = resolve;
  });
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async ({ assertClaimActive, papers, signal }) => {
        importAssertClaimActive = assertClaimActive;
        importSignal = signal;
        markImportStarted();
        await importReleased;
        assertClaimActive();
        importCompleted = true;

        return {
          failedCount: 0,
          failedPapers: [],
          foundCount: papers.length,
          importedCount: 1,
          importedPapers: [
            {
              arxivId: papers[0].arxivId,
              docId: "doc-imported-after-cancel",
              status: "imported",
              title: papers[0].title,
            },
          ],
          requestedMaxResults: papers.length,
          skippedCount: 0,
          skippedPapers: [],
          topic: "retrieval augmented generation",
        };
      },
    },
    arxivService: {
      search: async () => [
        {
          arxivId: "2401.00001v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
          summary: "Retrieval augmented generation for archive search.",
          title: "Retrieval Augmented Generation for Archives",
        },
      ],
    },
    recommendationTaskService: createRecommendationTaskService({
      taskService,
    }),
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });
  const suggestion = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [service.importJobRunner.id]: service.importJobRunner,
    },
    taskService,
  });

  await orchestrator.resumeTask({
    action: TASK_ACTIONS.confirm,
    payload: {
      selectedArxivIds: ["2401.00001v1"],
      selectionToken: suggestion.selectionToken,
    },
    runImmediately: false,
    taskId: suggestion.task.id,
  });
  const running = orchestrator.runTask({
    taskId: suggestion.task.id,
  });

  await importStarted;
  const canceled = await orchestrator.resumeTask({
    action: TASK_ACTIONS.cancel,
    taskId: suggestion.task.id,
  });
  assert.equal(importSignal?.aborted, true);
  assert.throws(
    () => importAssertClaimActive?.(),
    (error) => error?.code === "TASK_CLAIM_LOST"
  );
  releaseImport();
  await running;

  const finalTask = await taskService.getTask({
    taskId: suggestion.task.id,
  });

  assert.equal(canceled.status, TASK_STATUSES.canceled);
  assert.equal(finalTask.status, TASK_STATUSES.canceled);
  assert.equal(finalTask.result.importedPapers, undefined);
  assert.equal(importCompleted, false);
});

test("arxiv enrichment rejects selected papers outside the signed recommendation set", async () => {
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async () => {
        throw new Error("import should not run for invalid selections");
      },
    },
    arxivService: {
      search: async () => [
        {
          arxivId: "2401.00001v1",
          pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
          summary: "Retrieval augmented generation for archive search.",
          title: "Retrieval Augmented Generation for Archives",
        },
      ],
    },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  const suggestion = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });

  await assert.rejects(
    () =>
      service.importForDocument({
        docId: "doc-1",
        selectedArxivIds: ["2401.99999v1"],
        selectionToken: suggestion.selectionToken,
      }),
    /not in this recommendation set/
  );
});

test("arxiv enrichment rejects signed import candidates that fail relevance checks", async () => {
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async () => {
        throw new Error("import should not run for irrelevant papers");
      },
    },
    arxivService: {
      search: async () => [],
    },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
    selectionTokenService: {
      verifySelectionToken: () => ({
        docId: "doc-1",
        topic: "retrieval augmented generation",
        requestedMaxResults: 1,
        papers: [
          {
            arxivId: "2401.00002v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00002v1",
            summary: "Vision models for medical image masks.",
            title: "Convolutional Networks for Image Segmentation",
          },
        ],
      }),
    },
  });

  await assert.rejects(
    () =>
      service.importForDocument({
        docId: "doc-1",
        selectionToken: "legacy-token",
      }),
    /no longer pass relevance checks/
  );
});

test("arxiv enrichment requires a confirmed selection token before import", async () => {
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async () => {
        throw new Error("import should not run without a selection token");
      },
    },
    arxivService: {
      search: async () => [],
    },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  await assert.rejects(
    () =>
      service.importForDocument({
        docId: "doc-1",
      }),
    /selectionToken is required/
  );
});

// A search's result is published after the arXiv call, which can take
// seconds. These hold that call until the test lets it return, and change the
// document's task meanwhile, on both task stores the app runs on.
const RACE_TASK_ID = "external_recommendation:arxiv:doc-1";
const RACE_PAPERS = [
  {
    arxivId: "2401.00001v1",
    pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
    summary: "Retrieval augmented generation for archive search.",
    title: "Retrieval Augmented Generation for Archives",
  },
  {
    arxivId: "2401.00002v1",
    pdfUrl: "https://arxiv.org/pdf/2401.00002v1",
    summary: "Retrieval augmented generation with archive memory.",
    title: "Retrieval Augmented Generation with Archive Memory",
  },
];

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

// PostgreSQL's task table behind createPostgresTaskStore, kept in a Map: the
// statements a search, a confirmed import and a document delete send, with
// the conditions they carry (an upsert's DO UPDATE ... WHERE, a transition's
// expected statuses).
const createFakeTaskTable = () => {
  const rows = new Map();
  const parse = (value, fallback = null) =>
    value === null || value === undefined ? fallback : JSON.parse(value);
  const keyOf = (values) => values.slice(0, 3).join("\u0000");

  return async (sql, values = []) => {
    if (sql.trimStart().startsWith("INSERT INTO rag_task_events_race")) {
      return { rowCount: 1, rows: [] };
    }

    if (sql.includes("INSERT INTO rag_tasks_race")) {
      const existing = rows.get(keyOf(values));

      // ... DO UPDATE ... WHERE NOT $22 OR (status = $23 AND updated_at = $24)
      if (
        existing &&
        values[21] === true &&
        !(existing.status === values[22] && existing.updated_at === values[23])
      ) {
        return { rowCount: 0, rows: [] };
      }

      const row = {
        ...existing,
        user_id: values[0],
        workspace_id: values[1],
        task_id: values[2],
        type: values[3],
        status: values[4],
        label: values[5],
        summary: values[6],
        provider: parse(values[7]),
        subject: parse(values[8]),
        runner_id: values[9],
        action: values[10],
        counts: parse(values[11], {}),
        input: parse(values[12], {}),
        items: parse(values[13], []),
        result: parse(values[14], {}),
        error: parse(values[15]),
        payload: parse(values[16]),
        required_user_action: values[17],
        created_at: values[18] || existing?.created_at || values[20],
        updated_at: values[19] || values[20],
        attempt_count: existing?.attempt_count ?? 0,
        claimed_by: existing?.claimed_by ?? "",
      };

      rows.set(keyOf(values), row);
      return { rowCount: 1, rows: [row] };
    }

    if (sql.includes("DELETE FROM rag_tasks_race")) {
      return { rowCount: rows.delete(keyOf(values)) ? 1 : 0, rows: [] };
    }

    if (sql.includes("UPDATE rag_tasks_race") && sql.includes("type = $8")) {
      const row = rows.get(keyOf(values));

      if (!row || !values[3].includes(row.status)) {
        return { rowCount: 0, rows: [] };
      }

      Object.assign(row, {
        action: values[14],
        claimed_by: values[23],
        counts: parse(values[15], {}),
        error: parse(values[19]),
        input: parse(values[16], {}),
        items: parse(values[17], []),
        label: values[9],
        payload: parse(values[20]),
        provider: parse(values[11]),
        required_user_action: values[21],
        result: parse(values[18], {}),
        runner_id: values[13],
        status: values[8],
        subject: parse(values[12]),
        summary: values[10],
        type: values[7],
        updated_at: values[24],
      });

      return { rowCount: 1, rows: [row] };
    }

    if (sql.includes("FROM rag_tasks_race") && sql.includes("task_id = $3")) {
      const row = rows.get(keyOf(values));

      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }

    if (sql.includes("FROM rag_tasks_race") && sql.includes("LIMIT $4")) {
      const [userId, workspaceId, type] = values;

      return {
        rowCount: 0,
        rows: [...rows.values()].filter(
          (row) =>
            row.user_id === userId &&
            row.workspace_id === workspaceId &&
            (!type || row.type === type)
        ),
      };
    }

    throw new Error(`Unexpected query: ${sql}`);
  };
};

const RACE_TASK_STORES = [
  ["in-memory", (now) => createInMemoryTaskStore({ now })],
  [
    "PostgreSQL",
    (now) =>
      createPostgresTaskStore({
        eventsTableName: "rag_task_events_race",
        now,
        query: createFakeTaskTable(),
        runMigrations: async () => ({ appliedMigrations: [], status: "ok" }),
        tableName: "rag_tasks_race",
      }),
  ],
];

const createSearchRace = (createTaskStore) => {
  let second = 0;
  // Each write a second after the last, as writes a user's clicks apart are.
  const now = () => new Date(Date.UTC(2026, 10, 20, 0, 0, second++)).toISOString();
  const taskService = createTaskService({ taskStore: createTaskStore(now) });
  // Runs inside the next task write, before that write lands.
  let beforeTaskWrite = null;
  const recommendationTaskService = createRecommendationTaskService({
    taskService: {
      ...taskService,
      upsertTask: async (options) => {
        const hook = beforeTaskWrite;

        beforeTaskWrite = null;
        await hook?.();

        return taskService.upsertTask(options);
      },
    },
  });
  const snapshotStore = createInMemoryRecommendationSnapshotStore();
  let documentPresent = true;
  let heldSearch = null;
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async ({ papers }) => ({
        failedCount: 0,
        failedPapers: [],
        foundCount: papers.length,
        importedCount: papers.length,
        importedPapers: papers.map((paper) => ({
          arxivId: paper.arxivId,
          docId: `doc-${paper.arxivId}`,
          status: "imported",
          title: paper.title,
        })),
        requestedMaxResults: papers.length,
        skippedCount: 0,
        skippedPapers: [],
        topic: "retrieval augmented generation",
      }),
    },
    arxivService: {
      search: async () => {
        const held = heldSearch;

        heldSearch = null;

        if (held) {
          held.started.resolve();
          await held.released.promise;
        }

        return RACE_PAPERS;
      },
    },
    now,
    ragService: {
      getDocument: () =>
        documentPresent
          ? {
              docId: "doc-1",
              fileName: "private-notes.pdf",
              profile: { tags: ["retrieval", "augmented", "generation"] },
            }
          : null,
    },
    recommendationSnapshotStore: snapshotStore,
    recommendationTaskService,
  });
  const orchestrator = createJobOrchestrator({
    runners: { [service.importJobRunner.id]: service.importJobRunner },
    taskService,
  });

  return {
    // The document goes, and the deletion cascade takes its task.
    deleteDocument: async () => {
      documentPresent = false;
      await recommendationTaskService.deleteDocumentTasks({
        docIds: ["doc-1"],
        provider: "arxiv",
      });
    },
    getSnapshotToken: () =>
      snapshotStore.get({ docId: "doc-1", provider: "arxiv" })?.selectionToken ?? null,
    getTask: () => taskService.getInternalTask({ taskId: RACE_TASK_ID }),
    orchestrator,
    search: () => service.suggestForDocument({ docId: "doc-1", maxResults: 3 }),
    service,
    setBeforeTaskWrite: (hook) => {
      beforeTaskWrite = hook;
    },
    // A search held at its arXiv call, after it read the document's task.
    startHeldSearch: async () => {
      const held = {
        released: createDeferred(),
        started: createDeferred(),
      };

      heldSearch = held;

      const searching = service.suggestForDocument({ docId: "doc-1", maxResults: 3 });

      await held.started.promise;

      return {
        release: () => {
          held.released.resolve();
          return searching;
        },
      };
    },
  };
};

for (const [storeName, createTaskStore] of RACE_TASK_STORES) {
  test(`${storeName} task store: a search that returns after an import was confirmed leaves the import's task as it is`, async () => {
    const race = createSearchRace(createTaskStore);
    const first = await race.search();
    const heldSearch = await race.startHeldSearch();

    // Another tab confirms the first search's papers: the import is queued.
    await race.orchestrator.resumeTask({
      action: TASK_ACTIONS.confirm,
      payload: {
        selectedArxivIds: ["2401.00001v1"],
        selectionToken: first.selectionToken,
      },
      runImmediately: false,
      taskId: RACE_TASK_ID,
    });

    await assert.rejects(heldSearch.release(), {
      message: /changed during the search/,
      status: 409,
    });

    const task = await race.getTask();

    assert.equal(task.status, TASK_STATUSES.queued);
    assert.equal(task.action, "import_recommendations");
    assert.deepEqual(
      task.payload.selectedPapers.map((paper) => paper.arxivId),
      ["2401.00001v1"]
    );
    assert.equal(
      race.getSnapshotToken(),
      first.selectionToken,
      "the late result saved no snapshot over the confirmed one"
    );
  });

  test(`${storeName} task store: a search that returns after a confirmed import already ended keeps the import's result`, async () => {
    const race = createSearchRace(createTaskStore);
    const first = await race.search();
    const heldSearch = await race.startHeldSearch();

    // Another tab imports one of the two papers, start to end, while the
    // search runs. The task waits for the user again, as before the search.
    await race.service.importForDocument({
      docId: "doc-1",
      selectedArxivIds: ["2401.00001v1"],
      selectionToken: first.selectionToken,
    });

    const imported = await race.getTask();

    assert.equal(imported.status, TASK_STATUSES.waitingForUser);
    assert.equal(imported.action, "review_remaining_recommendations");

    await assert.rejects(heldSearch.release(), { status: 409 });

    const task = await race.getTask();

    assert.equal(task.action, "review_remaining_recommendations");
    assert.equal(task.counts.imported, 1);
    assert.deepEqual(task.result.remainingPaperIds, ["2401.00002v1"]);
    assert.equal(task.updatedAt, imported.updatedAt);
  });

  test(`${storeName} task store: a search that returns after its document was deleted writes no task or snapshot`, async () => {
    for (const searchedBefore of [false, true]) {
      const race = createSearchRace(createTaskStore);
      const first = searchedBefore ? await race.search() : null;
      const heldSearch = await race.startHeldSearch();

      await race.deleteDocument();
      await assert.rejects(heldSearch.release(), {
        message: "Document not found.",
        status: 404,
      });
      assert.equal(await race.getTask(), null);
      assert.equal(race.getSnapshotToken(), first?.selectionToken ?? null);
    }
  });

  test(`${storeName} task store: a document deleted while the search's task is written loses that task`, async () => {
    const race = createSearchRace(createTaskStore);
    const heldSearch = await race.startHeldSearch();

    // The delete and its cascade finish just before the task write lands.
    race.setBeforeTaskWrite(race.deleteDocument);
    await assert.rejects(heldSearch.release(), { status: 404 });
    assert.equal(await race.getTask(), null);
    assert.equal(race.getSnapshotToken(), null);
  });
}

// The api and agent tiers of a split deployment: two processes, each with
// its own services and saved suggestions, sharing only the task store (the
// PostgreSQL both use). The search runs on one, the task's confirmation on
// the other.
test("a suggestion searched on one tier is confirmed and imported on another that shares only the task store", async () => {
  const taskStore = createInMemoryTaskStore();
  const downloads = [];
  const createTier = () => {
    const taskService = createTaskService({ taskStore });
    const service = createArxivEnrichmentService({
      arxivImportService: {
        importPapers: async ({ papers }) => {
          downloads.push(...papers.map((paper) => paper.pdfUrl));

          return {
            failedCount: 0,
            failedPapers: [],
            foundCount: papers.length,
            importedCount: papers.length,
            importedPapers: papers.map((paper) => ({ arxivId: paper.arxivId, docId: "doc-arxiv", title: paper.title })),
            requestedMaxResults: papers.length,
            skippedCount: 0,
            skippedPapers: [],
            topic: "retrieval augmented generation",
          };
        },
      },
      arxivService: { search: async () => RACE_PAPERS },
      ragService: {
        getDocument: () => ({
          docId: "doc-1",
          fileName: "private-notes.pdf",
          profile: { tags: ["retrieval", "augmented", "generation"] },
        }),
      },
      recommendationTaskService: createRecommendationTaskService({ taskService }),
    });

    return {
      orchestrator: createJobOrchestrator({
        runners: { [service.importJobRunner.id]: service.importJobRunner },
        taskService,
      }),
      service,
      taskService,
    };
  };
  const api = createTier();
  const agent = createTier();
  const suggestion = await api.service.suggestForDocument({ docId: "doc-1", maxResults: 3 });
  const confirm = (selectionToken) =>
    agent.orchestrator.resumeTask({
      action: TASK_ACTIONS.confirm,
      payload: { docId: "doc-1", selectedArxivIds: ["2401.00001v1"], selectionToken },
      runImmediately: false,
      taskId: RACE_TASK_ID,
    });

  assert.equal(suggestion.task.payload, undefined, "the stored offer stays internal");

  // The same offer naming a paper URL the server never got from arXiv.
  const [version, payloadPart] = suggestion.selectionToken.split(".");
  const offer = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));

  offer.papers[0].pdfUrl = "http://169.254.169.254/latest/meta-data";
  await assert.rejects(
    confirm(`${version}.${Buffer.from(JSON.stringify(offer)).toString("base64url")}`),
    { message: "Invalid arXiv selection token.", status: 400 }
  );

  const queued = await confirm(suggestion.selectionToken);

  assert.equal(queued.status, TASK_STATUSES.queued);

  const finished = await agent.orchestrator.runTask({ taskId: RACE_TASK_ID });

  assert.equal(finished.status, TASK_STATUSES.completed);
  assert.deepEqual(downloads, ["https://arxiv.org/pdf/2401.00001v1"]);
});
