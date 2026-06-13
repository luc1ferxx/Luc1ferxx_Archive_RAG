import assert from "node:assert/strict";
import test from "node:test";

import {
  createInMemoryTaskStore,
  createTaskService,
  normalizeTask,
  TASK_STATUSES,
} from "../rag/tasks.js";

test("task store isolates tasks by authenticated scope and type", () => {
  let tick = 0;
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore({
      now: () => `2026-06-13T00:00:0${tick++}.000Z`,
    }),
  });

  taskService.upsertTask({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    task: {
      id: "task-1",
      type: "external_recommendation",
      label: "arXiv recommendations",
      status: TASK_STATUSES.waitingForUser,
      summary: "Found 3 papers.",
    },
  });
  taskService.upsertTask({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    task: {
      id: "task-2",
      type: "agent_run",
      label: "Agent run",
      status: TASK_STATUSES.completed,
      summary: "Answered question.",
    },
  });

  assert.deepEqual(
    taskService
      .listTasks({
        accessScope: {
          userId: "alice",
          workspaceId: "workspace-a",
        },
        type: "external_recommendation",
      })
      .tasks.map((task) => task.id),
    ["task-1"]
  );
  assert.deepEqual(
    taskService.listTasks({
      accessScope: {
        userId: "bob",
        workspaceId: "workspace-a",
      },
    }),
    {
      tasks: [],
    }
  );

  taskService.patchTask({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    taskId: "task-1",
    patch: {
      counts: {
        imported: 2,
      },
      status: TASK_STATUSES.running,
    },
  });

  const updatedTask = taskService.getTask({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    taskId: "task-1",
  });

  assert.equal(updatedTask.status, TASK_STATUSES.running);
  assert.equal(updatedTask.counts.imported, 2);
  assert.equal("scopeKey" in updatedTask, false);
});

test("task normalization rejects incomplete tasks and defaults unknown statuses", () => {
  assert.equal(
    normalizeTask({
      id: "task-1",
    }),
    null
  );
  assert.equal(
    normalizeTask({
      type: "external_recommendation",
    }),
    null
  );
  assert.deepEqual(
    normalizeTask({
      id: " task-1 ",
      label: " Review papers ",
      status: "unknown",
      summary: " Waiting ",
      type: " external_recommendation ",
    }),
    {
      id: "task-1",
      type: "external_recommendation",
      status: TASK_STATUSES.pending,
      label: "Review papers",
      summary: "Waiting",
      provider: null,
      subject: null,
      action: "",
      counts: {},
      input: {},
      result: {},
      error: null,
      requiredUserAction: "",
      createdAt: "",
      updatedAt: "",
    }
  );
});
