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

test("task claims are exclusive, fenced by attempt, and hidden from public tasks", async () => {
  let currentTime = "2026-06-13T00:00:00.000Z";
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore({
      now: () => currentTime,
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-claimed",
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "agent_task",
    },
  });

  const [firstClaim, competingClaim] = await Promise.all([
    taskService.claimTaskForRun({
      accessScope,
      claimId: "claim-1",
      leaseMs: 60_000,
      taskId: "task-claimed",
    }),
    taskService.claimTaskForRun({
      accessScope,
      claimId: "claim-2",
      leaseMs: 60_000,
      taskId: "task-claimed",
    }),
  ]);

  assert.equal(firstClaim.applied, true);
  assert.equal(firstClaim.attemptCount, 1);
  assert.equal(competingClaim.applied, false);

  const publicTask = await taskService.getTask({
    accessScope,
    taskId: "task-claimed",
  });
  const internalTask = await taskService.getInternalTask({
    accessScope,
    taskId: "task-claimed",
  });

  assert.equal("attemptCount" in publicTask, false);
  assert.equal("claimedAt" in publicTask, false);
  assert.equal("claimedBy" in publicTask, false);
  assert.equal(internalTask.claimedBy, "claim-1");
  assert.equal(internalTask.attemptCount, 1);

  currentTime = "2026-06-13T00:02:00.000Z";
  const recoveredClaim = await taskService.claimTaskForRun({
    accessScope,
    claimId: "claim-3",
    leaseMs: 60_000,
    taskId: "task-claimed",
  });

  assert.equal(recoveredClaim.applied, true);
  assert.equal(recoveredClaim.attemptCount, 2);

  const protectedProgress = await taskService.patchClaimedTask({
    accessScope,
    attemptCount: recoveredClaim.attemptCount,
    claimId: "claim-3",
    patch: {
      attemptCount: 999,
      status: TASK_STATUSES.running,
    },
    taskId: "task-claimed",
  });

  assert.equal(protectedProgress.applied, true);
  assert.equal(
    (
      await taskService.getInternalTask({
        accessScope,
        taskId: "task-claimed",
      })
    ).attemptCount,
    2
  );

  const staleWrite = await taskService.patchClaimedTask({
    accessScope,
    attemptCount: firstClaim.attemptCount,
    claimId: "claim-1",
    patch: {
      status: TASK_STATUSES.completed,
    },
    taskId: "task-claimed",
  });

  assert.equal(staleWrite.applied, false);
  assert.equal(
    (
      await taskService.getInternalTask({
        accessScope,
        taskId: "task-claimed",
      })
    ).claimedBy,
    "claim-3"
  );
});

test("task cancellation clears the claim and rejects the old runner terminal write", async () => {
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
      id: "task-cancel-fence",
      runnerId: "test_runner",
      status: TASK_STATUSES.queued,
      type: "agent_task",
    },
  });
  const claim = await taskService.claimTaskForRun({
    accessScope,
    claimId: "claim-cancel",
    taskId: "task-cancel-fence",
  });
  const cancellation = await taskService.transitionTask({
    accessScope,
    expectedStatuses: [TASK_STATUSES.running],
    patch: {
      status: TASK_STATUSES.canceled,
    },
    taskId: "task-cancel-fence",
  });
  const staleCompletion = await taskService.patchClaimedTask({
    accessScope,
    attemptCount: claim.attemptCount,
    claimId: "claim-cancel",
    patch: {
      status: TASK_STATUSES.completed,
    },
    taskId: "task-cancel-fence",
  });

  assert.equal(cancellation.applied, true);
  assert.equal(staleCompletion.applied, false);
  assert.equal(staleCompletion.task.status, TASK_STATUSES.canceled);
  assert.equal(
    (
      await taskService.getInternalTask({
        accessScope,
        taskId: "task-cancel-fence",
      })
    ).claimedBy,
    ""
  );
});

test("in-memory task store list() applies default limit of 200 and supports explicit limit/offset", async () => {
  let tick = 0;
  const store = createInMemoryTaskStore({
    now: () => `2026-06-13T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  for (let i = 0; i < 5; i++) {
    store.upsert({
      accessScope,
      task: {
        id: `task-${i}`,
        type: "test",
        status: TASK_STATUSES.pending,
      },
    });
  }

  const defaultResult = store.list({ accessScope });
  assert.equal(defaultResult.length, 5, "should return all 5 tasks within default limit");

  const limitedResult = store.list({ accessScope, limit: 2 });
  assert.equal(limitedResult.length, 2, "explicit limit of 2 should return 2 tasks");

  const offsetResult = store.list({ accessScope, limit: 2, offset: 3 });
  assert.equal(offsetResult.length, 2, "limit 2 offset 3 should return 2 tasks");

  const beyondResult = store.list({ accessScope, limit: 2, offset: 10 });
  assert.equal(beyondResult.length, 0, "offset beyond total should return empty");

  const invalidLimitResult = store.list({ accessScope, limit: -5 });
  assert.equal(invalidLimitResult.length, 5, "invalid limit should fall back to default 200");

  const overLimitResult = store.list({ accessScope, limit: 5000 });
  assert.equal(overLimitResult.length, 5, "limit above 1000 should clamp to 1000");

  const nonNumericResult = store.list({ accessScope, limit: "bad", offset: "bad" });
  assert.equal(nonNumericResult.length, 5, "non-numeric limit/offset should fall back to defaults");
});

test("in-memory task store list() via service plumbs limit/offset through", async () => {
  let tick = 0;
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore({
      now: () => `2026-06-13T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  for (let i = 0; i < 5; i++) {
    await taskService.upsertTask({
      accessScope,
      task: {
        id: `task-${i}`,
        type: "test",
        status: TASK_STATUSES.pending,
      },
    });
  }

  const allTasks = await taskService.listTasks({ accessScope });
  assert.equal(allTasks.tasks.length, 5);

  const limited = await taskService.listTasks({ accessScope, limit: 3 });
  assert.equal(limited.tasks.length, 3);

  const withOffset = await taskService.listTasks({ accessScope, limit: 2, offset: 3 });
  assert.equal(withOffset.tasks.length, 2);
});

test("in-memory task store list() returns the complete set for limit \"all\"", async () => {
  let tick = 0;
  const store = createInMemoryTaskStore({
    now: () => `2026-06-13T00:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}.000Z`,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  for (let i = 0; i < 250; i++) {
    store.upsert({
      accessScope,
      task: {
        id: `task-${i}`,
        type: "test",
        status: i < 10 ? TASK_STATUSES.failed : TASK_STATUSES.pending,
      },
    });
  }

  const capped = store.list({ accessScope });
  assert.equal(capped.length, 200, "default list should cap at 200");
  assert.equal(
    capped.filter((task) => task.status === TASK_STATUSES.failed).length,
    0,
    "oldest failed tasks fall outside the default page"
  );

  const complete = store.list({ accessScope, limit: "all" });
  assert.equal(complete.length, 250, "limit \"all\" should bypass the cap");
  assert.equal(
    complete.filter((task) => task.status === TASK_STATUSES.failed).length,
    10,
    "limit \"all\" should include the oldest failed tasks"
  );

  const completeViaService = await createTaskService({ taskStore: store })
    .listTasks({ accessScope, limit: "all" });
  assert.equal(completeViaService.tasks.length, 250);
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
