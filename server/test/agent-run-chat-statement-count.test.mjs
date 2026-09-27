import assert from "node:assert/strict";
import test from "node:test";

import { runAgentRag } from "../rag/agent.js";
import { EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY } from "../rag/agent-execution-graph-checkpoint.js";
import { isAgentRunRevisionConflictError } from "../rag/agent-run-revision.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunCursor,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { AGENT_RUN_STEP_STATUSES } from "../rag/agent-run-steps.js";
import { createPostgresAgentRunStore } from "../rag/postgres-agent-run-store.js";

// Pins how often one /chat touches the agent run store. Every store call is
// one PostgreSQL statement (plus BEGIN, the tenant settings and COMMIT on the
// row-level-security path), so a regression here is a regression in round
// trips per request. Measured with pg_stat_statements before this change: 11
// run-row reads, 15 event-list reads, 3 CAS updates, 2 event appends and 1
// insert per /chat.

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};
const question = "What does remote work require?";
const EXPECTED_CHAT_EVENTS = [
  "run_created",
  "run_prepared",
  "execution_planned",
  "step_started",
  "step_completed",
  "run_completed",
];

const createRagService = () => ({
  chat: async () => ({
    abstained: false,
    citations: [
      {
        docId: "doc-1",
        excerpt: "Remote work requires manager approval.",
        fileName: "policy.pdf",
        pageNumber: 2,
      },
    ],
    memoryApplied: false,
    resolvedQuery: question,
    text: "Remote work requires manager approval. [Source 1]",
  }),
  listDocuments: () => [
    {
      docId: "doc-1",
      fileName: "policy.pdf",
    },
  ],
});

const runOneChat = (agentRunService) =>
  runAgentRag({
    accessScope,
    agentRunService,
    docIds: ["doc-1"],
    question,
    ragService: createRagService(),
    sessionId: "session-1",
    userId: "alice",
    webChatService: async () => {
      throw new Error("Web search should not run.");
    },
  });

// Counts the calls the service makes; the store's own internal calls (the
// in-memory createWithEvent calls its create/appendEvent/get) stay uncounted.
const createCountingStore = (store) => {
  const counts = {};
  const countingStore = {};

  for (const [name, value] of Object.entries(store)) {
    countingStore[name] =
      typeof value === "function"
        ? (...args) => {
            counts[name] = (counts[name] ?? 0) + 1;
            return value.apply(store, args);
          }
        : value;
  }

  return { counts, store: countingStore };
};

test("one /chat writes its run without reading it back", async () => {
  const memoryStore = createInMemoryAgentRunStore({
    now: () => "2026-06-22T00:00:00.000Z",
  });
  const { counts, store } = createCountingStore(memoryStore);
  const agentRunService = createAgentRunService({ agentRunStore: store });
  const response = await runOneChat(agentRunService);

  assert.equal(response.status, 200);
  assert.equal(response.body.agentRunStatus, AGENT_RUN_STATUSES.completed);
  assert.deepEqual(counts, {
    appendEvent: 2,
    createWithEvent: 1,
    updateWithEvent: 3,
  });

  const run = await memoryStore.get({
    accessScope,
    runId: response.body.agentRunId,
  });

  assert.deepEqual(run.events.map(({ type }) => type), EXPECTED_CHAT_EVENTS);
  assert.equal(run.revision, 3);
  assert.deepEqual(
    response.body.agentRunSteps,
    run.steps,
    "the response snapshot is the committed run"
  );
});

const toPgEventRow = (event) => ({
  created_at: event.created_at,
  event_id: event.event_id,
  event_payload: event.event_payload,
  event_type: event.event_type,
});

// A PostgreSQL stand-in that models the statements one /chat sends,
// including the event list a write returns, and classifies every statement.
const createCountingPostgresQuery = () => {
  const runs = new Map();
  const events = [];
  const statements = [];
  let clock = Date.parse("2026-06-22T00:00:00.000Z");
  const nextTimestamp = () => new Date((clock += 1));
  const keyOf = (values) => `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
  const recordEvent = (values, type, payload) => {
    const event = {
      created_at: nextTimestamp(),
      event_id: String(events.length + 1),
      event_payload: JSON.parse(payload),
      event_type: type,
      key: keyOf(values),
    };

    events.push(event);
    return event;
  };
  const withRunEvents = (row, key) => {
    const runEvents = events.filter((event) => event.key === key);

    return {
      ...row,
      run_event_created_ats: runEvents.map((event) => event.created_at),
      run_event_ids: runEvents.map((event) => event.event_id),
      run_event_payloads: runEvents.map((event) => event.event_payload),
      run_event_types: runEvents.map((event) => event.event_type),
    };
  };
  const writeRow = (values, existing) => ({
    user_id: values[0],
    workspace_id: values[1],
    run_id: values[2],
    status: existing ? values[4] : values[3],
    goal: existing ? values[5] : values[4],
    input: JSON.parse(existing ? values[6] : values[5]),
    plan: JSON.parse(existing ? values[7] : values[6]),
    steps: JSON.parse(existing ? values[8] : values[7]),
    observations: JSON.parse(existing ? values[9] : values[8]),
    decisions: JSON.parse(existing ? values[10] : values[9]),
    approval_gates: JSON.parse(existing ? values[11] : values[10]),
    result: JSON.parse(existing ? values[12] : values[11]),
    error: JSON.parse((existing ? values[13] : values[12]) ?? "null"),
    revision: existing ? existing.revision + 1 : 0,
    created_at: existing?.created_at ?? nextTimestamp(),
    updated_at: nextTimestamp(),
  });
  const query = async (queryText, values = []) => {
    const key = keyOf(values);

    if (queryText.includes("WITH inserted_run AS")) {
      statements.push("insert_run_with_event");
      assert.match(queryText, /run_events AS/);

      if (runs.has(key)) {
        return { rows: [] };
      }

      const row = writeRow(values, null);

      runs.set(key, row);
      recordEvent(values, values[16], values[17]);
      return { rows: [withRunEvents(row, key)] };
    }

    if (
      queryText.includes("WITH updated_run AS") &&
      queryText.includes("recorded_event AS") &&
      !queryText.includes("requested_approval_snapshots")
    ) {
      statements.push("cas_update_with_event");
      assert.match(queryText, /AND revision = \$4/);
      assert.match(queryText, /run_events AS/);
      const existing = runs.get(key);

      if (!existing || existing.revision !== values[3]) {
        return { rows: [] };
      }

      const row = writeRow(values, existing);

      runs.set(key, row);
      recordEvent(values, values[15], values[16]);
      return { rows: [withRunEvents(row, key)] };
    }

    if (queryText.includes("WITH touched_run AS")) {
      statements.push("append_event");

      if (!runs.has(key)) {
        return { rows: [] };
      }

      return {
        rows: [toPgEventRow(recordEvent(values, values[3], values[4]))],
      };
    }

    if (queryText.includes("FROM rag_agent_run_events_count")) {
      statements.push("read_events");
      return {
        rows: events
          .filter((event) => event.key === key)
          .map(toPgEventRow),
      };
    }

    if (queryText.includes("FROM rag_agent_runs_count")) {
      statements.push("read_run");
      return { rows: runs.has(key) ? [runs.get(key)] : [] };
    }

    throw new Error(`Unexpected statement: ${queryText}`);
  };

  return { events, query, runs, statements };
};

const createCountingPostgresService = () => {
  const database = createCountingPostgresQuery();
  const agentRunStore = createPostgresAgentRunStore({
    eventsTableName: "rag_agent_run_events_count",
    query: database.query,
    runMigrations: async () => ({ appliedMigrations: [], status: "ok" }),
    tableName: "rag_agent_runs_count",
  });

  return {
    agentRunService: createAgentRunService({ agentRunStore }),
    agentRunStore,
    database,
  };
};

const countStatements = (statements) =>
  statements.reduce(
    (counts, statement) => ({
      ...counts,
      [statement]: (counts[statement] ?? 0) + 1,
    }),
    {}
  );

test("one /chat on the PostgreSQL run store sends six statements and no run or event read", async () => {
  const { agentRunService, agentRunStore, database } =
    createCountingPostgresService();
  const response = await runOneChat(agentRunService);

  assert.equal(response.status, 200);
  assert.deepEqual(countStatements(database.statements), {
    append_event: 2,
    cas_update_with_event: 3,
    insert_run_with_event: 1,
  });

  const run = await agentRunStore.get({
    accessScope,
    runId: response.body.agentRunId,
  });

  assert.deepEqual(run.events.map(({ type }) => type), EXPECTED_CHAT_EVENTS);
  assert.equal(run.revision, 3);
  assert.deepEqual(response.body.agentRunSteps, run.steps);
});

test("a write returns the same run projection a read-back returns", async () => {
  const { agentRunService, database } = createCountingPostgresService();
  const runCursor = createAgentRunCursor();
  const createdRun = await agentRunService.createRun({
    accessScope,
    goal: question,
    runCursor,
    runId: "run-projection",
  });

  assert.deepEqual(
    createdRun,
    await agentRunService.getRun({ accessScope, runId: "run-projection" })
  );

  await agentRunService.appendRunEvent({
    accessScope,
    runId: "run-projection",
    type: "run_prepared",
  });
  const startedRun = await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    input: { question },
    label: "Document RAG",
    runCursor,
    runId: "run-projection",
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "document_rag:primary",
    type: "document_rag",
  });

  assert.deepEqual(
    startedRun,
    await agentRunService.getRun({ accessScope, runId: "run-projection" })
  );
  assert.deepEqual(startedRun.events.map(({ type }) => type), [
    "run_created",
    "run_prepared",
    "step_started",
  ]);
  assert.equal(typeof startedRun.events[0].eventId, "string");
  assert.equal(
    database.statements.filter((statement) => statement.startsWith("read_"))
      .length,
    4,
    "only the two explicit getRun calls read"
  );
});

test("a run cursor behind the stored revision still loses the CAS and nothing is overwritten", async () => {
  const { agentRunService, database } = createCountingPostgresService();
  const runCursor = createAgentRunCursor();

  await agentRunService.createRun({
    accessScope,
    goal: question,
    runCursor,
    runId: "run-stale-cursor",
  });

  // Another writer (a second instance) moves the run on without this cursor.
  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Other writer",
    runId: "run-stale-cursor",
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "other-writer",
    type: "capability_call",
  });
  database.statements.length = 0;

  const run = await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Document RAG",
    runCursor,
    runId: "run-stale-cursor",
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "document_rag:primary",
    type: "document_rag",
  });

  assert.deepEqual(database.statements, [
    "cas_update_with_event",
    "read_run",
    "read_events",
    "read_run",
    "read_events",
    "cas_update_with_event",
  ], "stale CAS, conflict classification, fresh read, committed CAS");
  assert.equal(run.steps.length, 2);
  assert.deepEqual(
    run.steps.map(({ id }) => id),
    ["other-writer", "document_rag:primary"]
  );
  assert.deepEqual(runCursor.peek({ accessScope, runId: "run-stale-cursor" }), run);
});

test("a rejected decision on a stale cursor is decided again from the stored run", async () => {
  const memoryStore = createInMemoryAgentRunStore();
  const { counts, store } = createCountingStore(memoryStore);
  const agentRunService = createAgentRunService({ agentRunStore: store });
  const runCursor = createAgentRunCursor();

  await agentRunService.createRun({
    accessScope,
    goal: question,
    runCursor,
    runId: "run-canceled-elsewhere",
  });
  await agentRunService.cancelRun({
    accessScope,
    reason: "user canceled",
    runId: "run-canceled-elsewhere",
  });

  const withoutCursor = await agentRunService
    .completeRun({
      accessScope,
      result: { answer: "late" },
      runId: "run-canceled-elsewhere",
    })
    .then(
      (run) => ({ run }),
      (error) => ({ error: error.message })
    );
  const getsBefore = counts.get ?? 0;
  const withCursor = await agentRunService
    .completeRun({
      accessScope,
      result: { answer: "late" },
      runCursor,
      runId: "run-canceled-elsewhere",
    })
    .then(
      (run) => ({ run }),
      (error) => ({ error: error.message })
    );

  assert.deepEqual(withCursor, withoutCursor);
  assert.ok(
    (counts.get ?? 0) > getsBefore,
    "the stale cursor's verdict was checked against a fresh read"
  );
  assert.equal(
    (await memoryStore.get({ accessScope, runId: "run-canceled-elsewhere" }))
      .status,
    AGENT_RUN_STATUSES.canceled
  );
});

test("a standalone step next to a persisted graph is decided on a fresh read, not the cursor", async () => {
  const memoryStore = createInMemoryAgentRunStore();
  const { counts, store } = createCountingStore(memoryStore);
  const agentRunService = createAgentRunService({ agentRunStore: store });
  const runCursor = createAgentRunCursor();
  const createdRun = await agentRunService.createRun({
    accessScope,
    goal: question,
    runCursor,
    runId: "run-graph-events",
  });
  const cursorRun = runCursor.read({ accessScope, runId: createdRun.runId });

  // A cursor whose snapshot holds a graph checkpoint: the replay guard reads
  // the durable event order, which only a fresh read carries in full.
  runCursor.remember({
    accessScope,
    run: {
      ...cursorRun,
      result: { [EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY]: { phase: "running" } },
    },
  });
  const getsBefore = counts.get ?? 0;

  await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_started",
    label: "Web",
    runCursor,
    runId: createdRun.runId,
    status: AGENT_RUN_STEP_STATUSES.running,
    stepId: "web:primary",
    type: "web_search",
  });

  assert.equal((counts.get ?? 0) - getsBefore, 1);
});

test("a PostgreSQL CAS on a caller-supplied base run rejects a stale revision without a pre-read", async () => {
  const { agentRunStore, database } = createCountingPostgresService();
  const createdRun = await agentRunStore.createWithEvent({
    accessScope,
    event: { type: "run_created" },
    run: { goal: question, runId: "run-base" },
  });

  await agentRunStore.updateWithEvent({
    accessScope,
    baseRun: createdRun,
    event: { type: "run_touched" },
    expectedRevision: 0,
    patch: { result: { first: true } },
    runId: "run-base",
  });
  database.statements.length = 0;

  await assert.rejects(
    agentRunStore.updateWithEvent({
      accessScope,
      baseRun: createdRun,
      event: { type: "run_touched" },
      expectedRevision: 0,
      patch: { result: { stale: true } },
      runId: "run-base",
    }),
    (error) => isAgentRunRevisionConflictError(error) && error.actualRevision === 1
  );
  assert.deepEqual(database.statements, [
    "cas_update_with_event",
    "read_run",
    "read_events",
  ]);

  const storedRun = await agentRunStore.get({ accessScope, runId: "run-base" });

  assert.deepEqual(storedRun.result, { first: true });
  assert.equal(storedRun.revision, 1);
});
