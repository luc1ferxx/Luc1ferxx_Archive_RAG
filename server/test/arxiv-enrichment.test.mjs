import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArxivTopicFromDocumentProfile,
  createArxivEnrichmentService,
  evaluateArxivPaperRelevance,
  rankArxivTopicCandidatesFromDocumentProfile,
} from "../rag/arxiv-enrichment.js";
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
        fileName: "customer-alpha-ACME-X42.pdf",
        profile: {
          entities: ["Customer Alpha", "Project Redwood", "ACME-X42"],
          summary:
            "Customer Alpha ACME-X42 notes for Project Redwood. Retrieval augmented generation.",
          tags: [
            "Customer Alpha",
            "Project Redwood",
            "ACME-X42",
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
  assert.equal(result.queryPolicy.sanitizedQuery, "retrieval augmented generation");
  assert.equal(
    result.trace.externalQueryPolicy.sanitizedQuery,
    "retrieval augmented generation"
  );
  assert.equal(tasks[0].input.topic, "retrieval augmented generation");
  assert.equal(
    tasks[0].input.queryPolicy.sanitizedQuery,
    "retrieval augmented generation"
  );
  assert.equal(
    savedSuggestion.queryPolicy.sanitizedQuery,
    "retrieval augmented generation"
  );

  const safePolicyPayload = JSON.stringify({
    resultPolicy: result.queryPolicy,
    savedPolicy: savedSuggestion.queryPolicy,
    taskPolicy: tasks[0].input.queryPolicy,
    tracePolicy: result.trace.externalQueryPolicy,
  }).toLowerCase();

  assert.equal(safePolicyPayload.includes("customer alpha"), false);
  assert.equal(safePolicyPayload.includes("acme-x42"), false);
  assert.equal(safePolicyPayload.includes("redwood"), false);
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

  const queuedTask = await service.importJobRunner.resume({
    action: "confirm",
    payload: {
      selectedArxivIds: ["2401.00001v1"],
      selectionToken: suggestion.selectionToken,
    },
    task: suggestion.task,
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
