import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
} from "../rag/agent-runs.js";
import { createPostgresAgentRunStore } from "../rag/postgres-agent-run-store.js";

const parseJson = (value, fallback = null) =>
  value === null || value === undefined ? fallback : JSON.parse(value);

const buildFakeRunRow = (values, existingRow = null) => ({
  user_id: values[0],
  workspace_id: values[1],
  run_id: values[2],
  status: values[3],
  goal: values[4],
  input: parseJson(values[5], {}),
  plan: parseJson(values[6], {}),
  steps: parseJson(values[7], []),
  observations: parseJson(values[8], []),
  decisions: parseJson(values[9], []),
  approval_gates: parseJson(values[10], []),
  result: parseJson(values[11], {}),
  error: parseJson(values[12]),
  created_at: values[13] || existingRow?.created_at || values[15],
  updated_at: values[14] || values[15],
});

test("postgres agent run store persists scoped run snapshots and event records", async () => {
  const rows = new Map();
  const events = [];
  let migrationRuns = 0;
  const buildKey = ({ runId, userId, workspaceId }) =>
    `${userId}\u0000${workspaceId}\u0000${runId}`;
  const query = async (queryText, values = []) => {
    if (queryText.includes("INSERT INTO rag_agent_runs_test")) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = buildFakeRunRow(values, rows.get(key));

      rows.set(key, row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (queryText.includes("INSERT INTO rag_agent_run_events_test")) {
      const row = {
        event_id: events.length + 1,
        user_id: values[0],
        workspace_id: values[1],
        run_id: values[2],
        event_type: values[3],
        event_payload: parseJson(values[4], {}),
        created_at: "2026-06-14T00:00:00.000Z",
      };

      events.push(row);
      return {
        rowCount: 1,
        rows: [row],
      };
    }

    if (
      queryText.includes("UPDATE rag_agent_runs_test") &&
      queryText.includes("SET updated_at")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = rows.get(key);

      if (row) {
        row.updated_at = values[3];
      }

      return {
        rowCount: row ? 1 : 0,
        rows: [],
      };
    }

    if (queryText.includes("FROM rag_agent_run_events_test")) {
      const [userId, workspaceId, runId] = values;

      return {
        rowCount: 0,
        rows: events.filter(
          (event) =>
            event.user_id === userId &&
            event.workspace_id === workspaceId &&
            event.run_id === runId
        ),
      };
    }

    if (
      queryText.includes("status = ANY") &&
      queryText.includes("FROM rag_agent_runs_test")
    ) {
      const statuses = new Set(values[0]);

      return {
        rowCount: 0,
        rows: [...rows.values()].filter((row) => statuses.has(row.status)),
      };
    }

    if (
      queryText.includes("run_id = $3") &&
      queryText.includes("FROM rag_agent_runs_test")
    ) {
      const key = buildKey({
        runId: values[2],
        userId: values[0],
        workspaceId: values[1],
      });
      const row = rows.get(key);

      return {
        rowCount: row ? 1 : 0,
        rows: row ? [row] : [],
      };
    }

    if (queryText.includes("FROM rag_agent_runs_test")) {
      const [userId, workspaceId, status] = values;

      return {
        rowCount: 0,
        rows: [...rows.values()].filter(
          (row) =>
            row.user_id === userId &&
            row.workspace_id === workspaceId &&
            (!status || row.status === status)
        ),
      };
    }

    throw new Error(`Unexpected query: ${queryText}`);
  };
  const agentRunService = createAgentRunService({
    agentRunStore: createPostgresAgentRunStore({
      eventsTableName: "rag_agent_run_events_test",
      now: () => "2026-06-14T00:00:00.000Z",
      query,
      runMigrations: async () => {
        migrationRuns += 1;
        return {
          appliedMigrations: [],
          status: "ok",
        };
      },
      tableName: "rag_agent_runs_test",
    }),
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  await agentRunService.initialize();
  await agentRunService.initialize();

  assert.equal(migrationRuns, 1);

  await agentRunService.createRun({
    accessScope,
    goal: "Summarize the policy",
    input: {
      docIds: ["doc-1"],
    },
    plan: {
      mode: "document",
    },
    runId: "run-1",
  });
  await agentRunService.completeRun({
    accessScope,
    result: {
      answer: "Done",
    },
    runId: "run-1",
    steps: [
      {
        type: "plan",
      },
    ],
  });

  const publicRun = await agentRunService.getRun({
    accessScope,
    runId: "run-1",
  });
  const scopedRuns = await agentRunService.listRuns({
    accessScope,
  });
  const recoverableRuns = await agentRunService.listRecoverableRuns({
    statuses: [AGENT_RUN_STATUSES.completed],
  });

  assert.equal(publicRun.status, AGENT_RUN_STATUSES.completed);
  assert.equal(publicRun.result.answer, "Done");
  assert.deepEqual(
    publicRun.events.map((event) => event.type),
    ["run_created", "run_completed"]
  );
  assert.equal(publicRun.accessScope, undefined);
  assert.equal(scopedRuns.runs.length, 1);
  assert.equal(recoverableRuns.runs[0].runId, "run-1");
});
