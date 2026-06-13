import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecommendationTaskService,
  RECOMMENDATION_TASK_TYPE,
} from "../rag/recommendation-tasks.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_STATUSES,
} from "../rag/tasks.js";

test("recommendation task service records review and import lifecycle", () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const recommendationTaskService = createRecommendationTaskService({
    taskService,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  recommendationTaskService.recordSuggestionResult({
    accessScope,
    provider: "arxiv",
    suggestion: {
      document: {
        docId: "doc-1",
        fileName: "private-notes.pdf",
      },
      papers: [
        {
          arxivId: "2401.00001v1",
          title: "Retrieval Augmented Generation for Archives",
        },
        {
          arxivId: "2401.00002v1",
          title: "Grounded Question Answering with Documents",
        },
      ],
      requestedMaxResults: 3,
      selectionToken: "selection-token-1",
      topic: "retrieval augmented generation",
    },
  });

  let tasks = taskService.listTasks({
    accessScope,
    type: RECOMMENDATION_TASK_TYPE,
  }).tasks;

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, TASK_STATUSES.waitingForUser);
  assert.equal(tasks[0].requiredUserAction, "confirm_import");
  assert.equal(tasks[0].counts.recommended, 2);

  recommendationTaskService.recordImportStarted({
    accessScope,
    docId: "doc-1",
    document: {
      docId: "doc-1",
      fileName: "private-notes.pdf",
    },
    provider: "arxiv",
    selectedPapers: [
      {
        arxivId: "2401.00001v1",
      },
    ],
    topic: "retrieval augmented generation",
  });

  assert.equal(
    taskService.getTask({
      accessScope,
      taskId: "external_recommendation:arxiv:doc-1",
    }).status,
    TASK_STATUSES.running
  );

  recommendationTaskService.recordImportCompleted({
    accessScope,
    docId: "doc-1",
    document: {
      docId: "doc-1",
      fileName: "private-notes.pdf",
    },
    importResult: {
      failedCount: 0,
      failedPapers: [],
      importedCount: 1,
      importedPapers: [
        {
          arxivId: "2401.00001v1",
          docId: "doc-arxiv",
          title: "Retrieval Augmented Generation for Archives",
        },
      ],
      skippedCount: 0,
      skippedPapers: [],
    },
    provider: "arxiv",
    remainingSuggestion: {
      papers: [
        {
          arxivId: "2401.00002v1",
          title: "Grounded Question Answering with Documents",
        },
      ],
    },
    selectedPapers: [
      {
        arxivId: "2401.00001v1",
      },
    ],
    topic: "retrieval augmented generation",
  });

  tasks = taskService.listTasks({
    accessScope,
    type: RECOMMENDATION_TASK_TYPE,
  }).tasks;

  assert.equal(tasks[0].status, TASK_STATUSES.waitingForUser);
  assert.equal(tasks[0].action, "review_remaining_recommendations");
  assert.equal(tasks[0].counts.imported, 1);
  assert.equal(tasks[0].counts.remaining, 1);
  assert.deepEqual(tasks[0].result.remainingPaperIds, ["2401.00002v1"]);
});

test("recommendation task service records failed imports", () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const recommendationTaskService = createRecommendationTaskService({
    taskService,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  recommendationTaskService.recordImportFailed({
    accessScope,
    docId: "doc-1",
    error: new Error("network timeout"),
    provider: "arxiv",
    selectedPapers: [
      {
        arxivId: "2401.00001v1",
      },
    ],
    topic: "retrieval augmented generation",
  });

  const task = taskService.getTask({
    accessScope,
    taskId: "external_recommendation:arxiv:doc-1",
  });

  assert.equal(task.status, TASK_STATUSES.failed);
  assert.equal(task.counts.failed, 1);
  assert.match(task.summary, /network timeout/);
});
