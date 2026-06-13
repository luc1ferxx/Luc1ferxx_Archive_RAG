import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresTaskStore } from "../rag/postgres-task-store.js";
import { createTaskService, TASK_STATUSES } from "../rag/tasks.js";

const parseJson = (value, fallback = null) =>
  value === null || value === undefined ? fallback : JSON.parse(value);

const buildFakeTaskRow = (values, existingRow = null) => ({
  user_id: values[0],
  workspace_id: values[1],
  task_id: values[2],
  type: values[3],
  status: values[4],
  label: values[5],
  summary: values[6],
  provider: parseJson(values[7]),
  subject: parseJson(values[8]),
  runner_id: values[9],
  action: values[10],
  counts: parseJson(values[11], {}),
  input: parseJson(values[12], {}),
  items: parseJson(values[13], []),
  result: parseJson(values[14], {}),
  error: parseJson(values[15]),
  payload: parseJson(values[16]),
  required_user_action: values[17],
  created_at: values[18] || existingRow?.created_at || values[20],
  updated_at: values[19] || values[20],
  attempt_count: existingRow?.attempt_count ?? 0,
  next_run_at: existingRow?.next_run_at ?? null,
  claimed_by: existingRow?.claimed_by ?? "",
  claimed_at: existingRow?.claimed_at ?? null,
});

test("postgres task store persists scoped task snapshots and event records", async () => {
  const rows = new Map();
  const events = [];
  let migrationRuns = 0;
  const buildKey = ({ taskId, userId, workspaceId }) =>
    `${userId}\u0000${workspaceId}\u0000${taskId}`;
  const query = async (queryText, values = []) => {
    if (queryText.includes("INSERT INTO rag_tasks_test")) {
      const key = buildKey({
        taskId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = buildFakeTaskRow(values, rows.get(key));

      rows.set(key, row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (queryText.includes("INSERT INTO rag_task_events_test")) {
      events.push({
        eventPayload: parseJson(values[4], {}),
        eventType: values[3],
        taskId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      return {
        rowCount: 1,
        rows: [],
      };
    }

    if (queryText.includes("DELETE FROM rag_tasks_test")) {
      const key = buildKey({
        taskId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const deleted = rows.delete(key);

      return {
        rowCount: deleted ? 1 : 0,
        rows: [],
      };
    }

    if (
      queryText.includes("status = ANY") &&
      queryText.includes("FROM rag_tasks_test")
    ) {
      const statuses = new Set(values[0]);

      return {
        rowCount: 0,
        rows: [...rows.values()].filter((row) => statuses.has(row.status)),
      };
    }

    if (
      queryText.includes("task_id = $3") &&
      queryText.includes("FROM rag_tasks_test")
    ) {
      const key = buildKey({
        taskId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = rows.get(key);

      return {
        rowCount: row ? 1 : 0,
        rows: row ? [row] : [],
      };
    }

    if (queryText.includes("FROM rag_tasks_test")) {
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

    throw new Error(`Unexpected query: ${queryText}`);
  };
  const taskService = createTaskService({
    taskStore: createPostgresTaskStore({
      eventsTableName: "rag_task_events_test",
      now: () => "2026-06-13T00:00:00.000Z",
      query,
      runMigrations: async () => {
        migrationRuns += 1;
        return {
          appliedMigrations: [],
          status: "ok",
        };
      },
      tableName: "rag_tasks_test",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await taskService.initialize();
  await taskService.initialize();

  assert.equal(migrationRuns, 1);

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "task-1",
      counts: {
        selected: 1,
      },
      items: [
        {
          id: "paper-1",
          status: TASK_STATUSES.queued,
        },
      ],
      label: "arXiv import",
      payload: {
        selectedIds: ["paper-1"],
      },
      provider: {
        id: "arxiv",
      },
      runnerId: "arxiv_recommendation_import",
      status: TASK_STATUSES.queued,
      subject: {
        id: "doc-1",
      },
      type: "external_recommendation",
    },
  });

  const publicTask = await taskService.getTask({
    accessScope,
    taskId: "task-1",
  });
  const internalTask = await taskService.getInternalTask({
    accessScope,
    taskId: "task-1",
  });

  assert.equal(publicTask.payload, undefined);
  assert.equal(publicTask.accessScope, undefined);
  assert.deepEqual(internalTask.payload.selectedIds, ["paper-1"]);
  assert.deepEqual(internalTask.accessScope, accessScope);

  await taskService.patchTask({
    accessScope,
    taskId: "task-1",
    patch: {
      counts: {
        imported: 1,
      },
      status: TASK_STATUSES.running,
    },
  });

  const scopedTasks = await taskService.listTasks({
    accessScope,
    type: "external_recommendation",
  });
  const otherScopeTasks = await taskService.listTasks({
    accessScope: {
      userId: "bob",
      workspaceId: "workspace-a",
    },
  });
  const recoverableTasks = await taskService.listRecoverableTasks({
    statuses: [TASK_STATUSES.running],
  });

  assert.equal(scopedTasks.tasks.length, 1);
  assert.equal(scopedTasks.tasks[0].counts.imported, 1);
  assert.deepEqual(otherScopeTasks, {
    tasks: [],
  });
  assert.equal(recoverableTasks.tasks[0].id, "task-1");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["task_upsert", "task_upsert", "task_patch"]
  );

  assert.equal(
    await taskService.deleteTask({
      accessScope,
      taskId: "task-1",
    }),
    true
  );
  assert.equal(events.at(-1).eventType, "task_delete");
});
