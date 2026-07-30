import assert from "node:assert/strict";
import test from "node:test";

import { createJobOrchestrator, TASK_ACTIONS } from "../rag/job-orchestrator.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_MUTATION_OUTCOMES,
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

test("job orchestrator claims a queued task before executing it", async () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let executionCount = 0;

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-concurrent",
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "agent_task",
    },
  });

  const orchestrator = createJobOrchestrator({
    runners: {
      test_runner: {
        run: async () => {
          executionCount += 1;
          await Promise.resolve();

          return {
            status: TASK_STATUSES.completed,
          };
        },
      },
    },
    taskService,
  });

  await Promise.all([
    orchestrator.runTask({
      accessScope,
      taskId: "task-concurrent",
    }),
    orchestrator.runTask({
      accessScope,
      taskId: "task-concurrent",
    }),
  ]);

  assert.equal(executionCount, 1);
  assert.equal(
    (
      await taskService.getTask({
        accessScope,
        taskId: "task-concurrent",
      })
    ).status,
    TASK_STATUSES.completed
  );
});

test("job orchestrator cannot overwrite a cancellation after a runner settles", async () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let releaseRunner;
  let markRunnerStarted;
  let runnerAssertClaimActive;
  let runnerSignal;
  const runnerStarted = new Promise((resolve) => {
    markRunnerStarted = resolve;
  });
  const runnerReleased = new Promise((resolve) => {
    releaseRunner = resolve;
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-cancel-running",
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "agent_task",
    },
  });

  const orchestrator = createJobOrchestrator({
    runners: {
      test_runner: {
        run: async ({ assertClaimActive, signal }) => {
          runnerAssertClaimActive = assertClaimActive;
          runnerSignal = signal;
          markRunnerStarted();
          await runnerReleased;
          assertClaimActive();

          return {
            status: TASK_STATUSES.completed,
          };
        },
      },
    },
    taskService,
  });
  const running = orchestrator.runTask({
    accessScope,
    taskId: "task-cancel-running",
  });

  await runnerStarted;
  const canceled = await orchestrator.resumeTask({
    accessScope,
    action: TASK_ACTIONS.cancel,
    taskId: "task-cancel-running",
  });
  assert.equal(runnerSignal?.aborted, true);
  assert.throws(
    () => runnerAssertClaimActive?.(),
    (error) => error?.code === "TASK_CLAIM_LOST"
  );
  releaseRunner();
  await running;

  assert.equal(canceled.status, TASK_STATUSES.canceled);
  assert.equal(
    (
      await taskService.getTask({
        accessScope,
        taskId: "task-cancel-running",
      })
    ).status,
    TASK_STATUSES.canceled
  );
});

test("job orchestrator reports a canceled recovery as skipped when the runner rejects", async () => {
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const traceEvents = [];
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let releaseRunner;
  let markRunnerStarted;
  const runnerStarted = new Promise((resolve) => {
    markRunnerStarted = resolve;
  });
  const runnerReleased = new Promise((resolve) => {
    releaseRunner = resolve;
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-cancel-rejected-runner",
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "agent_task",
    },
  });

  const orchestrator = createJobOrchestrator({
    recordTaskRecoveryTrace: async (event) => traceEvents.push(event),
    runners: {
      test_runner: {
        run: async () => {
          markRunnerStarted();
          await runnerReleased;

          const error = new Error("Runner failed after cancellation.");
          error.status = 503;
          throw error;
        },
      },
    },
    taskService,
  });
  const running = orchestrator.runTask({
    accessScope,
    recovery: true,
    taskId: "task-cancel-rejected-runner",
  });

  await runnerStarted;
  await orchestrator.resumeTask({
    accessScope,
    action: TASK_ACTIONS.cancel,
    taskId: "task-cancel-rejected-runner",
  });
  releaseRunner();

  const finalTask = await running;
  const recoveryTrace = traceEvents.find(
    (event) => event.eventType === "task_recovery_run"
  );

  assert.equal(finalTask.status, TASK_STATUSES.canceled);
  assert.deepEqual(recoveryTrace, {
    traceType: "agent_task_recovery",
    errorStatus: 409,
    eventType: "task_recovery_run",
    resultStatus: TASK_STATUSES.canceled,
    runnerId: "test_runner",
    status: "skipped",
    taskId: "task-cancel-rejected-runner",
  });
});

test("job orchestrator cannot queue a stale resume after cancellation wins", async () => {
  const scheduledWork = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let releaseResume;
  let markResumeStarted;
  const resumeStarted = new Promise((resolve) => {
    markResumeStarted = resolve;
  });
  const resumeReleased = new Promise((resolve) => {
    releaseResume = resolve;
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-cancel-resume",
      requiredUserAction: "confirm_task",
      runnerId: "test_runner",
      status: TASK_STATUSES.waitingForUser,
      type: "agent_task",
    },
  });

  const orchestrator = createJobOrchestrator({
    runners: {
      test_runner: {
        resume: async () => {
          markResumeStarted();
          await resumeReleased;

          return {
            status: TASK_STATUSES.queued,
          };
        },
      },
    },
    schedule: (work) => scheduledWork.push(work),
    taskService,
  });
  const confirming = orchestrator.resumeTask({
    accessScope,
    action: TASK_ACTIONS.confirm,
    taskId: "task-cancel-resume",
  });

  await resumeStarted;
  await orchestrator.resumeTask({
    accessScope,
    action: TASK_ACTIONS.cancel,
    taskId: "task-cancel-resume",
  });
  releaseResume();
  await confirming;

  assert.equal(
    (
      await taskService.getTask({
        accessScope,
        taskId: "task-cancel-resume",
      })
    ).status,
    TASK_STATUSES.canceled
  );
  assert.equal(scheduledWork.length, 0);
});

test("job orchestrator keeps retrying claim heartbeats after a transient error", async (t) => {
  const storedTaskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let clearCount = 0;
  let heartbeatCallback;
  let releaseRunner;
  let renewCount = 0;
  let markRunnerStarted;
  let runnerAssertClaimActive;
  let runnerSignal;
  const heartbeatHandle = {
    unref() {},
  };
  const runnerStarted = new Promise((resolve) => {
    markRunnerStarted = resolve;
  });
  const runnerReleased = new Promise((resolve) => {
    releaseRunner = resolve;
  });

  t.mock.method(console, "error", () => {});

  await storedTaskService.upsertTask({
    accessScope,
    task: {
      id: "task-heartbeat-retry",
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "agent_task",
    },
  });

  const taskService = {
    ...storedTaskService,
    renewTaskClaim() {
      renewCount += 1;

      if (renewCount === 1) {
        throw new Error("Temporary database outage.");
      }

      return {
        applied: renewCount === 2,
        outcome:
          renewCount === 2
            ? TASK_MUTATION_OUTCOMES.renewed
            : TASK_MUTATION_OUTCOMES.claimLost,
      };
    },
  };
  const orchestrator = createJobOrchestrator({
    clearTaskClaimHeartbeat: (handle) => {
      assert.equal(handle, heartbeatHandle);
      clearCount += 1;
    },
    runners: {
      test_runner: {
        run: async ({ assertClaimActive, signal }) => {
          runnerAssertClaimActive = assertClaimActive;
          runnerSignal = signal;
          markRunnerStarted();
          await runnerReleased;
          assertClaimActive();

          return {
            status: TASK_STATUSES.completed,
          };
        },
      },
    },
    startTaskClaimHeartbeat: (callback) => {
      heartbeatCallback = callback;
      return heartbeatHandle;
    },
    taskService,
  });
  const running = orchestrator.runTask({
    accessScope,
    taskId: "task-heartbeat-retry",
  });

  await runnerStarted;

  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewCount, 1);
  assert.equal(clearCount, 0);

  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewCount, 2);
  assert.equal(clearCount, 0);

  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewCount, 3);
  assert.equal(clearCount, 1);
  assert.equal(runnerSignal.aborted, true);
  assert.throws(
    () => runnerAssertClaimActive(),
    (error) => error?.code === "TASK_CLAIM_LOST"
  );

  releaseRunner();
  const finalTask = await running;

  assert.equal(finalTask.status, TASK_STATUSES.running);
  assert.equal(clearCount, 1);
});

test("job orchestrator aborts a runner after heartbeat failures exhaust the local lease window", async (t) => {
  const storedTaskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  let clearCount = 0;
  let currentTime = 0;
  let heartbeatCallback;
  let releaseRunner;
  let renewCount = 0;
  let runnerSignal;
  let markRunnerStarted;
  const heartbeatHandle = {
    unref() {},
  };
  const runnerStarted = new Promise((resolve) => {
    markRunnerStarted = resolve;
  });
  const runnerReleased = new Promise((resolve) => {
    releaseRunner = resolve;
  });

  t.mock.method(console, "error", () => {});

  await storedTaskService.upsertTask({
    accessScope,
    task: {
      id: "task-heartbeat-timeout",
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "agent_task",
    },
  });

  const orchestrator = createJobOrchestrator({
    claimLeaseMs: 90,
    clearTaskClaimHeartbeat: (handle) => {
      assert.equal(handle, heartbeatHandle);
      clearCount += 1;
    },
    now: () => currentTime,
    runners: {
      test_runner: {
        run: async ({ assertClaimActive, signal }) => {
          runnerSignal = signal;
          markRunnerStarted();
          await runnerReleased;
          assertClaimActive();
        },
      },
    },
    startTaskClaimHeartbeat: (callback) => {
      heartbeatCallback = callback;
      return heartbeatHandle;
    },
    taskService: {
      ...storedTaskService,
      renewTaskClaim() {
        renewCount += 1;
        throw new Error("Database remains unavailable.");
      },
    },
  });
  const running = orchestrator.runTask({
    accessScope,
    taskId: "task-heartbeat-timeout",
  });

  await runnerStarted;

  currentTime = 30;
  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runnerSignal.aborted, false);

  currentTime = 89;
  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runnerSignal.aborted, false);

  currentTime = 90;
  heartbeatCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runnerSignal.aborted, true);
  assert.equal(renewCount, 2);
  assert.equal(clearCount, 1);

  releaseRunner();
  const finalTask = await running;

  assert.equal(finalTask.status, TASK_STATUSES.running);
  assert.equal(clearCount, 1);
});

test("job orchestrator prefers retryAfterMs for a busy recovery claim", async () => {
  const scheduledWork = [];
  const task = {
    id: "task-busy-recovery",
    runnerId: "test_runner",
    status: TASK_STATUSES.running,
    type: "agent_task",
  };
  const orchestrator = createJobOrchestrator({
    recordTaskRecoveryTrace: async () => {},
    runners: {
      test_runner: {
        run: () => {
          throw new Error("Busy recovery task must not execute.");
        },
      },
    },
    schedule: (work, delayMs) => {
      scheduledWork.push({
        delayMs,
        work,
      });
    },
    taskService: {
      claimTaskForRun: async () => ({
        applied: false,
        outcome: TASK_MUTATION_OUTCOMES.notRunnable,
        retryAfterMs: 2_500,
        retryAt: "2999-01-01T00:00:00.000Z",
        task,
      }),
      getInternalTask: async () => task,
      getTask: async () => task,
    },
  });

  const result = await orchestrator.runTask({
    recovery: true,
    taskId: task.id,
  });

  assert.equal(result.id, task.id);
  assert.equal(scheduledWork.length, 1);
  assert.equal(scheduledWork[0].delayMs, 2_500);
});

test("job orchestrator preserves 404 when a task disappears before claim", async () => {
  const task = {
    id: "task-deleted-before-claim",
    runnerId: "test_runner",
    status: TASK_STATUSES.queued,
    type: "agent_task",
  };
  const orchestrator = createJobOrchestrator({
    runners: {
      test_runner: {
        run: () => {
          throw new Error("Deleted task must not execute.");
        },
      },
    },
    taskService: {
      claimTaskForRun: async () => ({
        applied: false,
        outcome: TASK_MUTATION_OUTCOMES.notFound,
        task: null,
      }),
      getInternalTask: async () => task,
      getTask: async () => null,
    },
  });

  await assert.rejects(
    () =>
      orchestrator.runTask({
        taskId: task.id,
      }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.message, "Task not found.");
      return true;
    }
  );
});

test("job orchestrator preserves 404 when a task disappears before transition", async () => {
  const task = {
    id: "task-deleted-before-transition",
    runnerId: "test_runner",
    status: TASK_STATUSES.waitingForUser,
    type: "agent_task",
  };
  const orchestrator = createJobOrchestrator({
    recordTaskRecoveryTrace: async () => {},
    runners: {},
    taskService: {
      getInternalTask: async () => task,
      transitionTask: async () => ({
        applied: false,
        outcome: TASK_MUTATION_OUTCOMES.notFound,
        task: null,
      }),
    },
  });

  await assert.rejects(
    () =>
      orchestrator.resumeTask({
        action: TASK_ACTIONS.cancel,
        taskId: task.id,
      }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.message, "Task not found.");
      return true;
    }
  );
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

test("job orchestrator records task recovery and resume traces without payloads", async () => {
  const scheduledWork = [];
  const traceEvents = [];
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
      type: "agent_task",
    },
  });
  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-waiting",
      requiredUserAction: "confirm_task",
      runnerId: "test_runner",
      status: TASK_STATUSES.waitingForUser,
      type: "agent_task",
    },
  });

  const orchestrator = createJobOrchestrator({
    recordTaskRecoveryTrace: async (event) => traceEvents.push(event),
    runners: {
      test_runner: {
        resume: () => ({
          status: TASK_STATUSES.queued,
        }),
        run: () => ({
          status: TASK_STATUSES.completed,
        }),
      },
    },
    schedule: (work) => scheduledWork.push(work),
    taskService,
  });

  await orchestrator.recoverRunnableTasks();
  assert.deepEqual(traceEvents[0], {
    traceType: "agent_task_recovery",
    eventType: "task_recovery_scheduled",
    scheduledCount: 1,
    taskRefs: [
      {
        runnerId: "test_runner",
        status: TASK_STATUSES.queued,
        taskId: "task-queued",
      },
    ],
  });

  await scheduledWork[0]();
  assert.deepEqual(traceEvents[1], {
    traceType: "agent_task_recovery",
    eventType: "task_recovery_run",
    resultStatus: TASK_STATUSES.completed,
    runnerId: "test_runner",
    status: "completed",
    taskId: "task-queued",
  });

  await orchestrator.resumeTask({
    accessScope,
    action: TASK_ACTIONS.confirm,
    payload: {
      secret: "do-not-log",
    },
    runImmediately: false,
    taskId: "task-waiting",
  });
  assert.deepEqual(traceEvents[2], {
    traceType: "agent_task_recovery",
    action: TASK_ACTIONS.confirm,
    eventType: "task_resume_action",
    resultStatus: TASK_STATUSES.queued,
    runnerId: "test_runner",
    status: "completed",
    taskId: "task-waiting",
  });

  for (const event of traceEvents) {
    assert.equal(Object.hasOwn(event, "payload"), false);
    assert.equal(Object.hasOwn(event, "accessScope"), false);
  }
});

test("job orchestrator records failed task resume traces without payloads", async () => {
  const traceEvents = [];
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
      id: "task-waiting",
      requiredUserAction: "confirm_task",
      runnerId: "test_runner",
      status: TASK_STATUSES.waitingForUser,
      type: "agent_task",
    },
  });

  const orchestrator = createJobOrchestrator({
    recordTaskRecoveryTrace: async (event) => traceEvents.push(event),
    runners: {
      test_runner: {
        resume: () => {
          const error = new Error("Approval failed.");
          error.status = 409;
          throw error;
        },
      },
    },
    taskService,
  });

  await assert.rejects(
    () =>
      orchestrator.resumeTask({
        accessScope,
        action: TASK_ACTIONS.confirm,
        payload: {
          secret: "do-not-log",
        },
        taskId: "task-waiting",
      }),
    /Approval failed/
  );

  assert.deepEqual(traceEvents, [
    {
      traceType: "agent_task_recovery",
      action: TASK_ACTIONS.confirm,
      errorStatus: 409,
      eventType: "task_resume_action",
      resultStatus: TASK_STATUSES.waitingForUser,
      runnerId: "test_runner",
      status: "failed",
      taskId: "task-waiting",
    },
  ]);
  assert.equal(Object.hasOwn(traceEvents[0], "payload"), false);
  assert.equal(Object.hasOwn(traceEvents[0], "accessScope"), false);
});
