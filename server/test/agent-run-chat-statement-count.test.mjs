// Must stay the first import: the LangGraph /chat below loads @langchain, which
// reads the LangSmith tracing variables as it loads.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { runAgentRag } from "../rag/agent.js";
import { EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY } from "../rag/agent-execution-graph-checkpoint.js";
import { isAgentRunRevisionConflictError } from "../rag/agent-run-revision.js";
import {
  AGENT_RUN_STATUSES,
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  createAgentRunCursor,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { AGENT_RUN_STEP_STATUSES } from "../rag/agent-run-steps.js";
import {
  LANGGRAPH_CHECKPOINT_FORMAT,
  LANGGRAPH_CHECKPOINT_RETENTION,
} from "../rag/langgraph/checkpointer.js";
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
// `langGraphRecords` keeps a copy of every non-null LangGraph thread record a
// write hands the store, taken from its patch before the write: the save that
// settles the graph drops the record, so these copies are what is left to
// check once the run finished.
const createCountingStore = (store) => {
  const counts = {};
  const langGraphRecords = [];
  const countingStore = {};

  for (const [name, value] of Object.entries(store)) {
    countingStore[name] =
      typeof value === "function"
        ? (...args) => {
            counts[name] = (counts[name] ?? 0) + 1;
            const record = args[0]?.patch?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY];

            if ((name === "update" || name === "updateWithEvent") && record) {
              langGraphRecords.push(structuredClone(record));
            }

            return value.apply(store, args);
          }
        : value;
  }

  return { counts, langGraphRecords, store: countingStore };
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

    if (queryText.trimStart().startsWith("UPDATE rag_agent_runs_count")) {
      // The event-less CAS (agentRunStore.update): the LangGraph
      // checkpointer's writes are the only ones on the /chat path.
      statements.push("cas_update");
      assert.match(queryText, /AND revision = \$4/);
      const existing = runs.get(key);

      if (!existing || existing.revision !== values[3]) {
        return { rows: [] };
      }

      const row = writeRow(values, existing);

      runs.set(key, row);
      return { rows: [row] };
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

// --- One guarded custom-Skill /chat per runtime -------------------------------
//
// The same request on the native scheduler and on LangGraph
// (AGENT_RUNTIME=langgraph, docs/adr/0001-langgraph-runtime.md phase 3, write
// amplification), and once more with the experimental
// AGENT_OUTER_PLAN_RUNTIME=langgraph, which also puts the outer plan on
// LangGraph (without a checkpointer, so it must add nothing to the counts):
// a contract review that the deterministic planner turns into
// the two-node summarize -> risk DAG under AGENT_SKILL_GRAPH_ROLLOUT=guarded.
// LangGraph checkpoints its thread into the same run row through
// rag/langgraph/checkpointer.js, so every superstep and every task write is
// one more event-less CAS, and the thread is read back once when the graph is
// invoked. Measured before the phase-3 write-amplification changes, with the
// same counting store and stand-in as below (a scratch run of this scenario,
// not the ADR's phase-2 numbers, which are a 3-node stage): 3 run reads and 7
// event-less CAS on the in-memory store, 4 run-row and 11 event-list reads on
// the PostgreSQL stand-in; the thread tombstone every invocation writes first
// read the run although there was no thread to drop, and the plain UPDATE
// read the event list back. Now that no-op costs no read (mutateStoredRun's
// acceptCursorNoOp), the event-less write reuses its base's events
// (reuseBaseEvents), and the one remaining LangGraph read is the thread load
// at invoke. The event log and the run's public shape are the native ones.
//
// These counts are the in-memory store's calls and the stand-in's
// statements, not pg_stat_statements; they were checked against a real
// PostgreSQL 18 (Postgres.app) with pg_stat_statements, a scratch script over
// createPostgresAgentRunStore on the owner path, which gave exactly these
// shapes and counts both times:
//   - a4380782 (2026-10-14): native 1 insert, 9 event-carrying CAS, 3 event
//     appends, 1 run read, 1 event-list read; langgraph the same plus 7
//     event-less CAS, 1 more run read and 1 more event-list read. The
//     completed run's `result` was 11,860 bytes native and 17,006 on
//     LangGraph, the thread record (5,116 bytes) staying with the run.
//   - phase 4 (2026-10-16, AGENT_RUNTIME defaulting to langgraph, the
//     executor's saver keeping LANGGRAPH_CHECKPOINT_RETENTION = 2
//     checkpoints, and the custom-Skill DAG's settling save dropping the
//     record): the same counts on native, on AGENT_RUNTIME=langgraph and with
//     AGENT_RUNTIME unset (the new default; both 16 revisions), since
//     retention shrinks each thread write without adding one and the drop
//     rides on the settling save's own CAS. The completed run's `result` is
//     11,860 bytes native and 11,894 on LangGraph (the null tombstone is 29
//     of the 34; the scratch run's session ids and durations differ by a few
//     bytes), the largest record any write carried is 2,975 bytes, and the
//     largest `result` any write committed 14,639 bytes.
// The real server also runs one `SELECT ... FOR NO KEY UPDATE` row lock
// inside each event-carrying CAS pipeline (9 on both runtimes, none for the
// plain UPDATE), which the stand-in folds into the CAS. Re-measure before
// changing a pinned count.

const CONTRACT_DOC_ID = "contract-1";
const CONTRACT_QUESTION = "Review this contract for risks and key terms.";
const CONTRACT_EXCERPT =
  "Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice. Late notice creates renewal risk.";
const EXPECTED_GUARDED_CHAT_EVENTS = [
  "run_created",
  "run_prepared",
  "execution_planned",
  "skill_graph_checkpointed",
  "step_started",
  "step_completed",
  "skill_graph_checkpointed",
  "step_started",
  "step_completed",
  "skill_graph_checkpointed",
  "skill_graph_checkpointed",
  "skill_graph_planned",
  "run_completed",
];

const createContractRagService = () => ({
  chat: async (docIds, question) => ({
    abstained: false,
    citations: [
      {
        docId: CONTRACT_DOC_ID,
        excerpt: CONTRACT_EXCERPT,
        fileName: "services-agreement.pdf",
        pageNumber: 3,
      },
    ],
    memoryApplied: false,
    resolvedQuery: question,
    text: /risk review|risks?|gaps?|exceptions?/i.test(question)
      ? "Risk Review\n- Risk: Late notice creates renewal risk. [Source 1]"
      : "Contract Summary\n- Parties: Acme and Beta signed a services agreement. [Source 1]",
  }),
  getDocument: (docId) =>
    docId === CONTRACT_DOC_ID
      ? { docId: CONTRACT_DOC_ID, fileName: "services-agreement.pdf" }
      : null,
  listDocuments: () => [{ docId: CONTRACT_DOC_ID, fileName: "services-agreement.pdf" }],
});

const withEnv = async (overrides, work) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]])
  );
  const apply = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };

  apply(overrides);

  try {
    return await work();
  } finally {
    apply(previous);
  }
};

// `langgraph` is AGENT_RUNTIME=langgraph alone (the outer plan on the native
// loop); `outerPlan` adds the outer-plan dial; `default` sets neither, which
// since phase 4 is LangGraph for the graph and native for the outer plan.
const RUNTIME_PASSES = Object.freeze({
  native: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: undefined, AGENT_RUNTIME: "native" }),
  langgraph: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: undefined, AGENT_RUNTIME: "langgraph" }),
  outerPlan: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: "langgraph", AGENT_RUNTIME: "langgraph" }),
  default: Object.freeze({ AGENT_OUTER_PLAN_RUNTIME: undefined, AGENT_RUNTIME: undefined }),
});

const runOneGuardedGraphChat = (agentRunService, pass) =>
  withEnv({ ...RUNTIME_PASSES[pass], AGENT_SKILL_GRAPH_ROLLOUT: "guarded" }, () =>
    runAgentRag({
      accessScope,
      agentRunService,
      docIds: [CONTRACT_DOC_ID],
      question: CONTRACT_QUESTION,
      ragService: createContractRagService(),
      sessionId: "session-graph",
      userId: accessScope.userId,
      webChatService: async () => {
        throw new Error("Web search should not run.");
      },
    })
  );

const assertGuardedGraphRun = (response, run) => {
  assert.equal(response.status, 200);
  assert.equal(response.body.agentRunStatus, AGENT_RUN_STATUSES.completed);
  assert.deepEqual(run.events.map(({ type }) => type), EXPECTED_GUARDED_CHAT_EVENTS);
  assert.equal(run.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY].phase, "completed");
  assert.deepEqual(
    run.events.find(({ type }) => type === "skill_graph_planned").payload.nodeRuns.map(
      ({ nodeId, status }) => [nodeId, status]
    ),
    [
      ["summarize_contract", "completed"],
      ["risk_review", "completed"],
    ]
  );
  assert.deepEqual(response.body.agentRunSteps, run.steps);
};

test("one guarded custom-Skill /chat on LangGraph adds one run read and seven event-less CAS to the native run, and no event", async () => {
  const counts = {};
  const records = {};
  const runs = {};

  for (const runtime of Object.keys(RUNTIME_PASSES)) {
    const memoryStore = createInMemoryAgentRunStore({
      now: () => "2026-06-22T00:00:00.000Z",
    });
    const counting = createCountingStore(memoryStore);
    const response = await runOneGuardedGraphChat(
      createAgentRunService({ agentRunStore: counting.store }),
      runtime
    );
    const run = await memoryStore.get({
      accessScope,
      runId: response.body.agentRunId,
    });

    assertGuardedGraphRun(response, run);
    counts[runtime] = counting.counts;
    records[runtime] = counting.langGraphRecords;
    runs[runtime] = run;
  }

  assert.deepEqual(counts.native, {
    appendEvent: 3,
    createWithEvent: 1,
    get: 1,
    updateWithEvent: 9,
  });
  // + the thread load at invoke (get) and LangGraph's four checkpoints and
  // three task writes (update); the tombstone before the invocation is a
  // no-op on the request's cursor and reads nothing.
  assert.deepEqual(counts.langgraph, {
    appendEvent: 3,
    createWithEvent: 1,
    get: 2,
    update: 7,
    updateWithEvent: 9,
  });
  // The outer plan on LangGraph has no checkpointer: not one store call more.
  assert.deepEqual(counts.outerPlan, counts.langgraph);
  // The default is the LangGraph pass, store call for store call.
  assert.deepEqual(counts.default, counts.langgraph);
  assert.equal(runs.native.revision, 9);
  assert.equal(runs.langgraph.revision, 16);
  assert.equal(runs.outerPlan.revision, 16);
  assert.equal(runs.default.revision, 16);

  // The thread record is private to the run row: absent natively, LangGraph's
  // own format on the other runtime, never in the public projection, and it
  // holds nothing of the question or the evidence. Since phase 4 the
  // completed run keeps only the null tombstone: the graph's settling save
  // (agent-custom-skill-stage.js, dropLangGraphRecord) dropped the thread in
  // its own CAS, which is why no count above changed. Before, the record
  // stayed with the finished run and was checked there; now every record
  // the seven event-less writes carried is checked as it was written.
  assert.equal(Object.hasOwn(runs.native.result, LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
  assert.deepEqual(records.native, []);
  for (const pass of ["langgraph", "outerPlan", "default"]) {
    assert.equal(Object.hasOwn(runs[pass].result, LANGGRAPH_CHECKPOINT_RESULT_KEY), true, pass);
    assert.equal(runs[pass].result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null, pass);
    assert.equal(records[pass].length, counts[pass].update, pass);

    for (const record of records[pass]) {
      assert.equal(record.format, LANGGRAPH_CHECKPOINT_FORMAT, pass);
      // The custom-Skill graph checkpoints into the root namespace, which is
      // the one readLangGraphThread reads, whoever scheduled the outer plan:
      // invoked from the native loop (`langgraph`), and invoked from inside
      // the outer plan graph's custom_skills node (`outerPlan`), where it
      // must not land in a subgraph namespace named after that node.
      assert.deepEqual(record.namespaces.map((namespace) => namespace.ns), [""], pass);
      // Retention (LANGGRAPH_CHECKPOINT_RETENTION): never more than the
      // newest checkpoint and its parent.
      assert.ok(record.namespaces[0].checkpoints.length <= LANGGRAPH_CHECKPOINT_RETENTION, pass);
      assert.equal(JSON.stringify(record).includes(CONTRACT_QUESTION), false, pass);
      assert.equal(JSON.stringify(record).includes("renewal risk"), false, pass);
    }
  }
  for (const run of Object.values(runs)) {
    assert.equal(
      Object.hasOwn(
        (await createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() })
          .getRun({ accessScope, runId: "missing" })) ?? {},
        LANGGRAPH_CHECKPOINT_RESULT_KEY
      ),
      false
    );
    assert.equal(run.status, AGENT_RUN_STATUSES.completed);
  }
});

test("one guarded custom-Skill /chat on the PostgreSQL run store: LangGraph adds one run read, one event-list read and seven event-less CAS", async () => {
  const statements = {};

  for (const runtime of Object.keys(RUNTIME_PASSES)) {
    const { agentRunService, agentRunStore, database } =
      createCountingPostgresService();
    const response = await runOneGuardedGraphChat(agentRunService, runtime);
    const run = await agentRunStore.get({
      accessScope,
      runId: response.body.agentRunId,
    });

    // The read-back above is not part of the request.
    const requestStatements = database.statements.slice(0, -2);
    assert.deepEqual(database.statements.slice(-2), ["read_run", "read_events"]);
    assertGuardedGraphRun(response, run);
    statements[runtime] = countStatements(requestStatements);
  }

  assert.deepEqual(statements.native, {
    append_event: 3,
    cas_update_with_event: 9,
    insert_run_with_event: 1,
    read_events: 1,
    read_run: 1,
  });
  assert.deepEqual(statements.langgraph, {
    append_event: 3,
    cas_update: 7,
    cas_update_with_event: 9,
    insert_run_with_event: 1,
    read_events: 2,
    read_run: 2,
  });
  assert.deepEqual(statements.outerPlan, statements.langgraph);
  assert.deepEqual(statements.default, statements.langgraph);
});

test("an event-less PostgreSQL update that reuses its base's events sends no event-list read; without the flag it reads as before", async () => {
  const { agentRunStore, database } = createCountingPostgresService();
  const createdRun = await agentRunStore.createWithEvent({
    accessScope,
    event: { type: "run_created" },
    run: { goal: question, runId: "run-base-events" },
  });
  database.statements.length = 0;

  // The flag with a usable base: one statement, and the returned run's
  // events are the base's.
  const reused = await agentRunStore.update({
    accessScope,
    baseRun: createdRun,
    expectedRevision: 0,
    patch: { result: { first: true } },
    reuseBaseEvents: true,
    runId: "run-base-events",
  });

  assert.deepEqual(database.statements, ["cas_update"]);
  assert.equal(reused.revision, 1);
  assert.deepEqual(reused.events, createdRun.events);
  assert.deepEqual(reused.result, { first: true });
  database.statements.length = 0;

  // Without the flag the plain UPDATE still reads the list back ...
  const read = await agentRunStore.update({
    accessScope,
    baseRun: reused,
    expectedRevision: 1,
    patch: { result: { second: true } },
    runId: "run-base-events",
  });

  assert.deepEqual(database.statements, ["cas_update", "read_events"]);
  assert.deepEqual(read.events, createdRun.events);
  database.statements.length = 0;

  // ... and so does the flag without a usable base (a stale revision has
  // no base to take the list from).
  await agentRunStore.update({
    accessScope,
    baseRun: createdRun,
    expectedRevision: 2,
    patch: { result: { third: true } },
    reuseBaseEvents: true,
    runId: "run-base-events",
  });

  assert.deepEqual(database.statements, ["read_run", "read_events", "cas_update", "read_events"]);
  assert.deepEqual((await agentRunStore.get({ accessScope, runId: "run-base-events" })).result, {
    first: true,
    second: true,
    third: true,
  });
});
