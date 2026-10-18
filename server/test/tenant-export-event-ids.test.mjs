// The tenant export of the PostgreSQL agent run and task stores never shows
// the raw event_id: a BIGSERIAL every tenant shares (migrations 006 and 007),
// whose gaps count the other tenants' events. Each exported event names its
// ordinal in its run (or task), `${runId}:n` in id order, the form the agent
// run API hands out (rag/agent-runs.js); the keyset pages still read the raw
// ids. A fake query answers the export's statements.
import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAgentRunStore } from "../rag/postgres-agent-run-store.js";
import { createPostgresTaskStore } from "../rag/postgres-task-store.js";
import { runAsDatabaseSystem } from "../rag/postgres-tenant.js";
import { normalizeTenantSelector } from "../rag/tenant-records.js";

// Shared ids with another tenant's events in between (the gaps).
const EVENTS = [
  { event_id: "11", event_type: "run_created", parent: "run-1", user_id: "ann" },
  { event_id: "14", event_type: "run_created", parent: "run-2", user_id: "ann" },
  { event_id: "15", event_type: "run_prepared", parent: "run-1", user_id: "ann" },
  { event_id: "19", event_type: "run_completed", parent: "run-1", user_id: "ann" },
  { event_id: "23", event_type: "run_created", parent: "run-1", user_id: "bob" },
  { event_id: "30", event_type: "run_completed", parent: "run-2", user_id: "ann" },
];

// The export's statements: the distinct users of the workspace, then each
// pair's keyset pages ordered by event_id (`after` is the last raw id of the
// page before, the last value the LIMIT).
const createExportQuery = ({ eventsTable, parentColumn }) => {
  const pages = [];
  const query = async (sql, values = []) => {
    const text = sql.replace(/\s+/g, " ").trim();

    if (text.startsWith("SELECT DISTINCT")) {
      return { rows: text.includes(eventsTable) ? [{ user_id: "ann" }, { user_id: "bob" }] : [] };
    }

    if (!text.startsWith(`SELECT * FROM ${eventsTable} `)) {
      return { rows: [] };
    }

    const [, user] = values;
    const after = values.length === 4 ? values[2] : null;

    pages.push(after);
    return {
      rows: EVENTS.filter((event) => event.user_id === user && (after === null || Number(event.event_id) > Number(after)))
        .slice(0, values.at(-1))
        .map(({ parent, ...event }) => ({ ...event, [parentColumn]: parent, workspace_id: "acme" })),
    };
  };

  return { pages, query };
};

const exportedEvents = async (store, table) => {
  const records = [];

  await runAsDatabaseSystem(async () => {
    for await (const entry of store.iterateTenantRecords(normalizeTenantSelector({ workspaceId: "acme" }))) {
      if (entry.table === table) {
        records.push(entry.record);
      }
    }
  });

  return records;
};

test("an exported agent run event names its ordinal in its run, never the shared id", async () => {
  const { pages, query } = createExportQuery({ eventsTable: "rag_agent_run_events", parentColumn: "run_id" });
  const store = createPostgresAgentRunStore({ query, runMigrations: async () => ({}) });
  const records = await exportedEvents(store, "agent_run_events");

  assert.deepEqual(
    records.map((record) => [record.user_id, record.event_id, record.event_type]),
    [
      ["ann", "run-1:1", "run_created"],
      ["ann", "run-2:1", "run_created"],
      ["ann", "run-1:2", "run_prepared"],
      ["ann", "run-1:3", "run_completed"],
      ["ann", "run-2:2", "run_completed"],
      // Another user's run of the same id counts on its own.
      ["bob", "run-1:1", "run_created"],
    ]
  );
  // One page per pair at the store's page size.
  assert.deepEqual(pages, [null, null]);

  // A second export numbers from 1 again.
  assert.deepEqual((await exportedEvents(store, "agent_run_events")).map((record) => record.event_id).slice(0, 2), [
    "run-1:1",
    "run-2:1",
  ]);
});

test("an exported task event names its ordinal in its task", async () => {
  const { query } = createExportQuery({ eventsTable: "rag_task_events", parentColumn: "task_id" });
  const store = createPostgresTaskStore({ query, runMigrations: async () => ({}) });
  const records = await exportedEvents(store, "task_events");

  assert.deepEqual(
    records.map((record) => record.event_id),
    ["run-1:1", "run-2:1", "run-1:2", "run-1:3", "run-2:2", "run-1:1"]
  );
  assert.ok(records.every((record) => !/^\d+$/.test(record.event_id)));
});
