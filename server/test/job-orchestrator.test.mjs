import assert from "node:assert/strict";
import test from "node:test";

import { createJobOrchestrator, TASK_ACTIONS } from "../rag/job-orchestrator.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_STATUSES,
} from "../rag/tasks.js";

test("job orchestrator resumes waiting tasks and runs the registered runner", async () => {
  const scheduledWork = [];
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
      label: "Import",
      requiredUserAction: "confirm_import",
      runnerId: "test_runner",
      status: TASK_STATUSES.waitingForUser,
      summary: "Waiting",
      type: "external_recommendation",
    },
  });

  const orchestrator = createJobOrchestrator({
    runners: {
      test_runner: {
        resume: ({ action, payload }) => {
          assert.equal(action, TASK_ACTIONS.confirm);
          assert.deepEqual(payload, {
            selectedIds: ["paper-1"],
          });

          return {
            payload: {
              selectedIds: payload.selectedIds,
            },
            status: TASK_STATUSES.queued,
            summary: "Queued",
          };
        },
        run: ({ task }) => {
          assert.deepEqual(task.payload, {
            selectedIds: ["paper-1"],
          });

          return {
            payload: null,
            result: {
              imported: 1,
            },
            status: TASK_STATUSES.completed,
            summary: "Done",
          };
        },
      },
    },
    schedule: (work) => scheduledWork.push(work),
    taskService,
  });

  const queuedTask = await orchestrator.resumeTask({
    accessScope,
    action: TASK_ACTIONS.confirm,
    payload: {
      selectedIds: ["paper-1"],
    },
    taskId: "task-1",
  });

  assert.equal(queuedTask.status, TASK_STATUSES.queued);
  assert.equal(queuedTask.payload, undefined);
  assert.equal(scheduledWork.length, 1);

  await scheduledWork[0]();

  const completedTask = await taskService.getTask({
    accessScope,
    taskId: "task-1",
  });

  assert.equal(completedTask.status, TASK_STATUSES.completed);
  assert.deepEqual(completedTask.result, {
    imported: 1,
  });
  assert.equal(completedTask.payload, undefined);
});

test("job orchestrator cancels tasks without running a runner", async () => {
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
      label: "Import",
      requiredUserAction: "confirm_import",
      runnerId: "test_runner",
      status: TASK_STATUSES.waitingForUser,
      summary: "Waiting",
      type: "external_recommendation",
    },
  });

  const orchestrator = createJobOrchestrator({
    runners: {},
    taskService,
  });
  const canceledTask = await orchestrator.resumeTask({
    accessScope,
    action: TASK_ACTIONS.cancel,
    taskId: "task-1",
  });

  assert.equal(canceledTask.status, TASK_STATUSES.canceled);
  assert.equal(canceledTask.requiredUserAction, "");
});

test("job orchestrator schedules recoverable queued and running tasks", async () => {
  const scheduledWork = [];
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
      id: "task-queued",
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "external_recommendation",
    },
  });
  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-waiting",
      runnerId: "test_runner",
      status: TASK_STATUSES.waitingForUser,
      type: "external_recommendation",
    },
  });

  const orchestrator = createJobOrchestrator({
    runners: {
      test_runner: {
        run: () => ({
          status: TASK_STATUSES.completed,
        }),
      },
    },
    schedule: (work) => scheduledWork.push(work),
    taskService,
  });

  const recovery = await orchestrator.recoverRunnableTasks();

  assert.deepEqual(recovery, {
    scheduledCount: 1,
  });
  assert.equal(scheduledWork.length, 1);

  await scheduledWork[0]();

  const completedTask = await taskService.getTask({
    accessScope,
    taskId: "task-queued",
  });

  assert.equal(completedTask.status, TASK_STATUSES.completed);
});
