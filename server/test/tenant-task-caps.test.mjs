import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgentTaskService } from "../rag/agent-tasks.js";
import { getTenantMaxQueuedTasks, getTenantMaxRunningTasks } from "../rag/config.js";
import {
  createJobOrchestrator,
  DEFAULT_RUNNING_CAP_RETRY_MS,
  TENANT_TASK_LIMITED,
} from "../rag/job-orchestrator.js";
import { createInMemoryTaskStore, createTaskService, TASK_STATUSES } from "../rag/tasks.js";

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };

const settle = async () => {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

// A schedule the test drives: every scheduled run waits in `pending` until the
// test runs it.
const createManualSchedule = () => {
  const pending = [];

  return {
    pending,
    // Starts every due run without waiting for it (a started run blocks
    // in its runner until the test releases it), then lets them settle as
    // far as they can.
    runAll: async () => {
      const due = pending.splice(0);

      due.forEach((entry) => {
        void entry.work();
      });
      await settle();
    },
    schedule: (work, delayMs = 0) => {
      pending.push({ delayMs, work });
    },
  };
};

const seedTask = (taskService, accessScope, id, status = TASK_STATUSES.queued) =>
  taskService.upsertTask({
    accessScope,
    task: { id, runnerId: "blocking", status, type: "test" },
  });

const createHarness = ({ maxRunning = 0 } = {}) => {
  const taskService = createTaskService({ taskStore: createInMemoryTaskStore() });
  const releases = new Map();
  const started = [];
  const traces = [];
  const manual = createManualSchedule();
  const runner = {
    run: async ({ task }) => {
      started.push(task.id);
      const gate = createDeferred();

      releases.set(task.id, gate.resolve);
      await gate.promise;
      return { summary: `${task.id} done` };
    },
  };
  const orchestrator = createJobOrchestrator({
    recordTaskRecoveryTrace: async (event) => traces.push(event),
    runners: { blocking: runner },
    schedule: manual.schedule,
    startTaskClaimHeartbeat: () => null,
    clearTaskClaimHeartbeat: () => {},
    taskLimits: () => ({ maxQueued: 0, maxRunning }),
    taskService,
  });

  return { manual, orchestrator, releases, started, taskService, traces };
};

const statusOf = async (taskService, accessScope, taskId) =>
  (await taskService.getTask({ accessScope, taskId }))?.status;

test("the task caps default to 0 (off)", () => {
  assert.equal(getTenantMaxRunningTasks(), 0);
  assert.equal(getTenantMaxQueuedTasks(), 0);
});

test("without a running cap (the default) a tenant's tasks run side by side", async () => {
  const { orchestrator, releases, started, taskService } = createHarness();

  await seedTask(taskService, ALICE, "a-1");
  await seedTask(taskService, ALICE, "a-2");

  const runs = [orchestrator.runTask({ accessScope: ALICE, taskId: "a-1" }), orchestrator.runTask({ accessScope: ALICE, taskId: "a-2" })];

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["a-1", "a-2"]);
  releases.get("a-1")();
  releases.get("a-2")();
  await Promise.all(runs);
});

test("over the running cap a task stays queued and runs once the tenant's running task finishes", async () => {
  const { manual, orchestrator, releases, started, taskService, traces } = createHarness({ maxRunning: 1 });

  await seedTask(taskService, ALICE, "a-1");
  await seedTask(taskService, ALICE, "a-2");
  await seedTask(taskService, BOB, "b-1");

  const first = orchestrator.runTask({ accessScope: ALICE, taskId: "a-1" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a-1"]);

  // Alice is at her cap: a-2 is not claimed and stays queued.
  const deferred = await orchestrator.runTask({ accessScope: ALICE, taskId: "a-2" });

  assert.equal(deferred.status, TASK_STATUSES.queued);
  assert.equal(await statusOf(taskService, ALICE, "a-2"), TASK_STATUSES.queued);
  assert.deepEqual(started, ["a-1"]);
  assert.equal(manual.pending.length, 1, "a retry is scheduled");
  assert.equal(manual.pending[0].delayMs, DEFAULT_RUNNING_CAP_RETRY_MS);
  assert.deepEqual(
    traces.map((event) => [event.eventType, event.reason, event.status, event.taskId]),
    [["task_run_deferred", "tenant_running_cap", "deferred", "a-2"]]
  );

  // Bob has his own cap.
  const bob = orchestrator.runTask({ accessScope: BOB, taskId: "b-1" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a-1", "b-1"]);

  // a-1 finishes: the held-back a-2 is woken at once.
  releases.get("a-1")();
  assert.equal((await first).status, TASK_STATUSES.completed);

  const woken = manual.pending.filter((entry) => entry.delayMs === 0);

  assert.equal(woken.length, 1);
  void woken[0].work();
  await settle();
  assert.deepEqual(started, ["a-1", "b-1", "a-2"]);
  assert.equal(await statusOf(taskService, ALICE, "a-2"), TASK_STATUSES.running);

  // The earlier retry timer finds the run already taken and does nothing.
  const retry = manual.pending.find((entry) => entry.delayMs === DEFAULT_RUNNING_CAP_RETRY_MS);

  manual.pending.length = 0;
  await retry.work();
  assert.equal(manual.pending.length, 0);

  releases.get("a-2")();
  releases.get("b-1")();
  await bob;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await statusOf(taskService, ALICE, "a-2"), TASK_STATUSES.completed);
});

test("the retry timer tries a held-back task again and holds it back again while the tenant is full", async () => {
  const { manual, orchestrator, releases, started, taskService } = createHarness({ maxRunning: 1 });

  await seedTask(taskService, ALICE, "a-1");
  await seedTask(taskService, ALICE, "a-2");

  const first = orchestrator.runTask({ accessScope: ALICE, taskId: "a-1" });

  await new Promise((resolve) => setImmediate(resolve));
  await orchestrator.runTask({ accessScope: ALICE, taskId: "a-2" });
  // The retry fires: scheduleTaskRun, then the run defers again.
  await manual.runAll();
  await manual.runAll();
  assert.deepEqual(started, ["a-1"]);
  assert.equal(manual.pending.length, 1);
  assert.equal(manual.pending[0].delayMs, DEFAULT_RUNNING_CAP_RETRY_MS);

  releases.get("a-1")();
  await first;
  await manual.runAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a-1", "a-2"]);
  releases.get("a-2")();
});

test("a running task whose claim lease expired holds no place, and a task that is not runnable is never held back", async () => {
  const taskStore = createInMemoryTaskStore({ now: () => new Date().toISOString() });
  const taskService = createTaskService({ taskStore });

  await taskService.upsertTask({
    accessScope: ALICE,
    task: {
      claimedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      id: "stale",
      runnerId: "x",
      status: TASK_STATUSES.running,
      type: "test",
    },
  });
  await taskService.upsertTask({
    accessScope: ALICE,
    task: { claimedAt: new Date().toISOString(), id: "live", runnerId: "x", status: TASK_STATUSES.running, type: "test" },
  });
  await seedTask(taskService, ALICE, "q-1");
  await seedTask(taskService, ALICE, "w-1", TASK_STATUSES.waitingForUser);
  await seedTask(taskService, BOB, "q-bob");

  assert.deepEqual(await taskService.countActiveTasks({ accessScope: ALICE }), { queued: 1, running: 1 });
  assert.deepEqual(await taskService.countActiveTasks({ accessScope: ALICE, excludeTaskId: "live" }), {
    queued: 1,
    running: 0,
  });
  assert.deepEqual(await taskService.countActiveTasks({ accessScope: BOB }), { queued: 1, running: 0 });

  // A store without countActive is counted from its listing.
  const listingOnly = createTaskService({
    taskStore: { ...taskStore, countActive: undefined, list: (options) => taskStore.list(options) },
  });

  assert.deepEqual(await listingOnly.countActiveTasks({ accessScope: ALICE }), { queued: 1, running: 1 });

  const manual = createManualSchedule();
  const orchestrator = createJobOrchestrator({
    runners: { blocking: { run: async () => ({}) }, x: { run: async () => ({}) } },
    schedule: manual.schedule,
    startTaskClaimHeartbeat: () => null,
    clearTaskClaimHeartbeat: () => {},
    taskLimits: () => ({ maxRunning: 1 }),
    taskService,
  });

  // Alice holds one live claim: a waiting task is answered as before (not
  // claimable), with no retry scheduled.
  const waiting = await orchestrator.runTask({ accessScope: ALICE, taskId: "w-1" });

  assert.equal(waiting.status, TASK_STATUSES.waitingForUser);
  assert.equal(manual.pending.length, 0);
});

test("over the queued cap a new task is refused with 429 TENANT_TASK_LIMITED; another tenant and a replay are not", async () => {
  const taskService = createTaskService({ taskStore: createInMemoryTaskStore() });
  const scheduled = [];
  let ids = 0;
  const service = createAgentTaskService({
    createTaskId: () => `t-${(ids += 1)}`,
    jobOrchestrator: { scheduleTaskRun: (request) => scheduled.push(request.taskId) },
    taskLimits: () => ({ maxQueued: 2, maxRunning: 0 }),
    taskService,
  });
  const create = (accessScope, extra = {}) =>
    service.createTask({ accessScope, question: "Summarize the renewal terms.", ...extra });

  await create(ALICE, { idempotencyKey: "same" });
  await create(ALICE);
  await assert.rejects(
    create(ALICE),
    (error) => error.status === 429 && error.code === TENANT_TASK_LIMITED && error.expose === true
  );
  // Concurrent creations in one process never overshoot.
  const bobResults = await Promise.allSettled([create(BOB), create(BOB), create(BOB), create(BOB)]);

  assert.equal(bobResults.filter((result) => result.status === "fulfilled").length, 2);
  // An idempotent replay returns the existing task.
  const replay = await create(ALICE, { idempotencyKey: "same" });

  assert.equal(replay.status, TASK_STATUSES.queued);
  assert.equal(scheduled.length, 4);

  // Without a cap (the default) nothing is counted.
  const uncapped = createAgentTaskService({
    jobOrchestrator: null,
    taskLimits: () => ({ maxQueued: 0 }),
    taskService: {
      ...taskService,
      countActiveTasks: async () => {
        throw new Error("counted without a cap");
      },
    },
  });

  await uncapped.createTask({ accessScope: ALICE, question: "Another question?" });
});

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

test("POST /agent-tasks answers 429 with the stable code over TENANT_MAX_QUEUED_TASKS", async () => {
  const saved = {
    API_AUTH_ENABLED: process.env.API_AUTH_ENABLED,
    API_AUTH_TOKENS: process.env.API_AUTH_TOKENS,
    TENANT_MAX_QUEUED_TASKS: process.env.TENANT_MAX_QUEUED_TASKS,
  };
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "task-caps-"));

  process.env.API_AUTH_ENABLED = "true";
  process.env.API_AUTH_TOKENS = JSON.stringify({ "alice-token": ALICE });
  process.env.TENANT_MAX_QUEUED_TASKS = "1";

  try {
    const [{ createApp }, { createInMemoryAdminAuditStore, createAdminAuditService }, runs, artifacts, jobs] =
      await Promise.all([
        import("../app.js"),
        import("../rag/admin-audit.js"),
        import("../rag/agent-runs.js"),
        import("../rag/workspace-artifacts/memory-store.js"),
        import("../rag/ingest-job-store.js"),
      ]);
    const app = await createApp({
      adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore() }),
      agentRunStore: runs.createInMemoryAgentRunStore(),
      healthService: {
        buildHealthReport: async () => ({ checks: {}, status: "ok" }),
        runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
      },
      ingestJobStore: jobs.createInMemoryIngestJobStore(),
      jobSchedule: () => {},
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeLongMemory: async () => true,
        initializeSessionMemory: async () => true,
        listDocuments: () => [],
      },
      taskStore: createInMemoryTaskStore(),
      uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
      uploadsDirectory: path.join(tempRoot, "uploads"),
      workspaceArtifactStore: artifacts.createInMemoryWorkspaceArtifactStore(),
    });
    const server = await startServer(app);

    try {
      const post = () =>
        fetch(`${server.baseUrl}/agent-tasks`, {
          body: JSON.stringify({ question: "Summarize the renewal terms." }),
          headers: { "Content-Type": "application/json", "x-api-key": "alice-token" },
          method: "POST",
        });

      assert.equal((await post()).status, 202);

      const refused = await post();
      const body = await refused.json();

      assert.equal(refused.status, 429);
      assert.equal(body.code, TENANT_TASK_LIMITED);
      assert.match(body.error, /waiting to run/);
    } finally {
      await server.close();
      await app.locals.stop?.();
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("the PostgreSQL task store counts a tenant's queued and live running tasks in one statement", async () => {
  const { createPostgresTaskStore } = await import("../rag/postgres-task-store.js");
  const calls = [];
  const store = createPostgresTaskStore({
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [{ queued: "2", running: "1" }] };
    },
    runMigrations: async () => {},
    tableName: "tasks_t",
  });

  assert.deepEqual(
    await store.countActive({ accessScope: ALICE, excludeTaskId: "a-9", leaseMs: 30_000 }),
    { queued: 2, running: 1 }
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM tasks_t\s+WHERE user_id = \$1\s+AND workspace_id = \$2/);
  assert.match(
    calls[0].text,
    /COALESCE\(claimed_at, updated_at\)\s+> clock_timestamp\(\) - \(\$6::double precision \* INTERVAL '1 millisecond'\)/
  );
  assert.deepEqual(calls[0].values, ["alice", "ws-a", "a-9", "queued", "running", 30_000]);
});
