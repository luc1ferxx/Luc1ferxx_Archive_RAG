import assert from "node:assert/strict";
import test from "node:test";

import {
  createInMemoryTaskStore,
  createTaskService,
  normalizeTask,
  TASK_STATUSES,
} from "../rag/tasks.js";

test("task store isolates tasks by authenticated scope and type", async () => {
  let tick = 0;
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore({
      now: () => `2026-06-13T00:00:0${tick++}.000Z`,
    }),
  });

  await taskService.upsertTask({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    task: {
      id: "task-1",
      items: [
        {
          id: "paper-1",
          label: "Paper 1",
          status: TASK_STATUSES.queued,
        },
      ],
      type: "external_recommendation",
      label: "arXiv recommendations",
      payload: {
        private: true,
      },
      runnerId: "arxiv_recommendation_import",
      status: TASK_STATUSES.waitingForUser,
      summary: "Found 3 papers.",
    },
  });
  await taskService.upsertTask({
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
    (
      await taskService.listTasks({
        accessScope: {
          userId: "alice",
          workspaceId: "workspace-a",
        },
        type: "external_recommendation",
      })
    ).tasks.map((task) => task.id),
    ["task-1"]
  );
  assert.deepEqual(
    await taskService.listTasks({
      accessScope: {
        userId: "bob",
        workspaceId: "workspace-a",
      },
    }),
    {
      tasks: [],
    }
  );

  await taskService.patchTask({
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

  const updatedTask = await taskService.getTask({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    taskId: "task-1",
  });

  assert.equal(updatedTask.status, TASK_STATUSES.running);
  assert.equal(updatedTask.counts.imported, 2);
  assert.equal(updatedTask.items[0].id, "paper-1");
  assert.equal(updatedTask.payload, undefined);
  assert.equal("scopeKey" in updatedTask, false);
});

test("task service exposes recoverable internal tasks without changing public shape", async () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-1",
      payload: {
        selectedIds: ["paper-1"],
      },
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "external_recommendation",
    },
  });

  const publicTask = await taskService.getTask({
    accessScope,
    taskId: "task-1",
  });
  const recoverableTasks = await taskService.listRecoverableTasks({
    statuses: [TASK_STATUSES.queued],
  });

  assert.equal(publicTask.payload, undefined);
  assert.equal(publicTask.accessScope, undefined);
  assert.equal(recoverableTasks.tasks[0].payload.selectedIds[0], "paper-1");
  assert.deepEqual(recoverableTasks.tasks[0].accessScope, accessScope);
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
      runnerId: "",
      action: "",
      counts: {},
      input: {},
      items: [],
      result: {},
      error: null,
      payload: null,
      requiredUserAction: "",
      createdAt: "",
      updatedAt: "",
    }
  );
});
