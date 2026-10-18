// The feedback stores (feedback.js, rag/postgres-feedback-store.js) and the
// /feedback routes over them. The PostgreSQL store runs here against a fake
// that answers its statements the way node-pg would (json parsed, timestamptz
// as a Date, numeric as text) and enforces migration 034's exact-pair policy
// for the bound database tenant; the real table, grant and policy are covered
// by postgres-row-level-security.integration.test.mjs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";

import { createApp as createProductionApp } from "../app.js";
import {
  buildFeedbackRecord,
  createFeedbackService,
  createFileFeedbackStore,
  getDefaultFeedbackStore,
  listAllFeedbackAcrossTenants,
  recordMatchesAccessScope,
} from "../feedback.js";
import {
  createAdminAuditService,
  createInMemoryAdminAuditStore,
} from "../rag/admin-audit.js";
import { deterministicPlannerAdapter } from "../rag/agent-execution-plan.js";
import { deterministicIntentPlannerAdapter } from "../rag/agent-intent-planner.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { getFeedbackStoreConfigStatus } from "../rag/config.js";
import { createInMemoryIngestJobStore } from "../rag/ingest-job-store.js";
import {
  buildStoredFeedback,
  createPostgresFeedbackStore,
  mapFeedbackRow,
  normalizeFeedbackListLimit,
  resolveFeedbackReadScope,
} from "../rag/postgres-feedback-store.js";
import {
  getActiveDatabaseTenant,
  runAsDatabaseSystem,
  runWithDatabaseTenant,
} from "../rag/postgres-tenant.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import { createInMemoryWorkspaceArtifactStore } from "../rag/workspace-artifacts/index.js";

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };

const withEnv = async (values, run) => {
  const original = new Map(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const samplePayload = (overrides = {}) => ({
  answer: {
    agentAnswer: "Remote work needs manager approval.",
    agentMode: "document",
    agentSkills: [{ id: "document_rag", label: "Document RAG", status: "completed", version: "1.0.0" }],
    agentObservability: {
      agentMode: "document",
      budget: { limits: { documentRagCalls: 3 }, used: { documentRagCalls: 1 } },
      skills: [{ attempts: 1, skillId: "document_rag", skillVersion: "1.0.0" }],
    },
    ragSources: [
      { chunkIndex: 2, docId: "doc-1", excerpt: "Manager approval first.", fileName: "policy.pdf", pageNumber: 4 },
    ],
  },
  docIds: ["doc-1"],
  feedbackType: "incomplete",
  note: "Missed the approval step.",
  question: "What does the remote work policy require?",
  sessionId: "session-1",
  turnIndex: 2,
  ...overrides,
});

// Answers the feedback store's statements as node-pg over migration 034
// would, with the policy applied to the bound database tenant.
const createFakeFeedbackDatabase = () => {
  const rows = [];
  const statements = [];
  let migrations = 0;
  let nextId = 1;

  const visible = (row) => {
    const tenant = getActiveDatabaseTenant();

    return (
      !tenant ||
      (row.owner_user_id === tenant.userId && row.workspace_id === tenant.workspaceId)
    );
  };
  const rejectError = (message, code) => Object.assign(new Error(message), { code });

  const query = async (text, values = []) => {
    const sql = text.replace(/\s+/g, " ").trim();

    statements.push({ sql, tenant: getActiveDatabaseTenant(), values });

    if (sql.startsWith("INSERT INTO rag_feedback")) {
      const [
        feedbackId,
        ownerUserId,
        workspaceId,
        createdAt,
        sessionId,
        turnIndex,
        question,
        docIds,
        feedbackType,
        note,
        answerText,
        agentMode,
        skills,
        claimChecks,
        agentObservability,
        citations,
        extra,
      ] = values;
      const tenant = getActiveDatabaseTenant();

      for (const value of [feedbackId, ownerUserId, workspaceId, sessionId, question, note, answerText]) {
        if (String(value ?? "").includes("\u0000")) {
          throw rejectError('invalid byte sequence for encoding "UTF8": 0x00', "22021");
        }
      }

      if (tenant && (ownerUserId !== tenant.userId || workspaceId !== tenant.workspaceId)) {
        throw rejectError('new row violates row-level security policy for table "rag_feedback"', "42501");
      }

      if (rows.some((row) => row.feedback_id === feedbackId)) {
        if (sql.includes("ON CONFLICT (feedback_id) DO NOTHING")) {
          return { rowCount: 0, rows: [] };
        }

        throw rejectError('duplicate key value violates unique constraint "rag_feedback_feedback_id_key"', "23505");
      }

      rows.push({
        id: nextId++,
        feedback_id: feedbackId,
        owner_user_id: ownerUserId,
        workspace_id: workspaceId,
        created_at: new Date(createdAt),
        session_id: sessionId,
        turn_index: turnIndex === null ? null : String(Number(turnIndex)),
        question,
        doc_ids: JSON.parse(docIds),
        feedback_type: feedbackType,
        note,
        answer_text: answerText,
        agent_mode: agentMode,
        skills: JSON.parse(skills),
        claim_checks: JSON.parse(claimChecks),
        agent_observability: agentObservability === null ? null : JSON.parse(agentObservability),
        citations: JSON.parse(citations),
        extra: JSON.parse(extra),
      });

      return { rowCount: 1, rows: [] };
    }

    if (sql.startsWith("SELECT COUNT(*)::int AS existing FROM rag_feedback")) {
      const ids = new Set(values[0]);

      return {
        rowCount: 1,
        rows: [{ existing: rows.filter((row) => visible(row) && ids.has(row.feedback_id)).length }],
      };
    }

    if (sql.startsWith("SELECT feedback_id,")) {
      let selected = rows.filter(visible);

      if (sql.includes("WHERE owner_user_id = $1 AND workspace_id = $2")) {
        selected = selected.filter(
          (row) => row.owner_user_id === values[0] && row.workspace_id === values[1]
        );
      }

      if (sql.includes("ORDER BY created_at DESC, id ASC")) {
        selected = [...selected].sort(
          (left, right) => right.created_at - left.created_at || left.id - right.id
        );
      } else {
        assert.match(sql, /ORDER BY id ASC$/);
        selected = [...selected].sort((left, right) => left.id - right.id);
      }

      if (sql.includes("LIMIT $")) {
        selected = selected.slice(0, values.at(-1));
      }

      return { rowCount: selected.length, rows: selected.map((row) => structuredClone(row)) };
    }

    throw new Error(`Unexpected statement: ${sql}`);
  };

  return {
    query,
    rows,
    runMigrations: async () => {
      migrations += 1;
      return { status: "ok" };
    },
    get migrations() {
      return migrations;
    },
    statements,
  };
};

const createFakeStore = (database = createFakeFeedbackDatabase(), options = {}) =>
  createPostgresFeedbackStore({
    query: database.query,
    runMigrations: database.runMigrations,
    ...options,
  });

test("a record's user and workspace come from the access scope, never from the payload", () => {
  const scoped = buildFeedbackRecord({
    accessScope: { ...ALICE, authenticated: true },
    payload: samplePayload({ userId: "bob", workspaceId: "ws-b" }),
  });

  assert.equal(scoped.userId, "alice");
  assert.equal(scoped.workspaceId, "ws-a");

  // Before, a scope without a workspace took the payload's, and an empty
  // scope took both.
  const userOnly = buildFeedbackRecord({
    accessScope: { userId: "alice" },
    payload: samplePayload({ workspaceId: "ws-b" }),
  });
  const unscoped = buildFeedbackRecord({
    payload: samplePayload({ userId: "bob", workspaceId: "ws-b" }),
  });

  assert.deepEqual([userOnly.userId, userOnly.workspaceId], ["alice", ""]);
  assert.deepEqual([unscoped.userId, unscoped.workspaceId], ["", ""]);
});

test("the read scope is the exact pair for a tenant and everything for a scope naming neither", () => {
  assert.deepEqual(resolveFeedbackReadScope({ ...ALICE, authenticated: true }), {
    mode: "tenant",
    userId: "alice",
    workspaceId: "ws-a",
  });
  assert.deepEqual(resolveFeedbackReadScope({ userId: " alice " }), {
    mode: "tenant",
    userId: "alice",
    workspaceId: "",
  });
  // The single shared API_AUTH_TOKEN without a user (single-tenant mode);
  // requireApiAuth refuses every other authenticated scope naming neither.
  assert.equal(resolveFeedbackReadScope({ authenticated: true }).mode, "all");
  assert.equal(resolveFeedbackReadScope({ authenticated: true, userId: " ", workspaceId: "" }).mode, "all");
  assert.equal(resolveFeedbackReadScope({ authenticated: false }).mode, "all");
  assert.equal(resolveFeedbackReadScope({}).mode, "all");
  assert.equal(resolveFeedbackReadScope(undefined).mode, "all");

  const record = { userId: "alice", workspaceId: "" };

  assert.equal(recordMatchesAccessScope(record, { userId: "alice" }), true);
  assert.equal(recordMatchesAccessScope(record, ALICE), false);
  assert.equal(recordMatchesAccessScope(record, { userId: "bob", workspaceId: "" }), false);
  assert.equal(recordMatchesAccessScope(record, { authenticated: true }), true);
  assert.equal(recordMatchesAccessScope(record, {}), true);
  assert.equal(normalizeFeedbackListLimit("bad"), 25);
  assert.equal(normalizeFeedbackListLimit(0), 25);
  assert.equal(normalizeFeedbackListLimit(-4), 1);
  assert.equal(normalizeFeedbackListLimit(500), 100);
});

test("the default store is PostgreSQL whenever a database is configured and the file without one", async () => {
  await withEnv({ LONG_MEMORY_DATABASE_URL: undefined, POSTGRES_DATABASE_URL: undefined }, () => {
    assert.equal(getFeedbackStoreConfigStatus().backend, "file");
    assert.equal(getDefaultFeedbackStore().backend, "file");
  });
  await withEnv(
    { LONG_MEMORY_DATABASE_URL: undefined, POSTGRES_DATABASE_URL: "postgresql://unused@127.0.0.1:1/none" },
    () => {
      assert.deepEqual(getFeedbackStoreConfigStatus(), {
        backend: "postgres",
        persistent: true,
        postgresConfigured: true,
        reason: "postgres_configured_default",
      });

      // Created without connecting: nothing is read until a route runs.
      const store = getDefaultFeedbackStore();

      assert.equal(store.backend, "postgres");
      assert.deepEqual(store.describe(), { backend: "postgres", table: "rag_feedback" });
      assert.equal(getDefaultFeedbackStore(), store);
    }
  );
  await withEnv({ FEEDBACK_POSTGRES_TABLE: "bad-name" }, () => {
    assert.throws(() => createFakeStore(), /FEEDBACK_POSTGRES_TABLE must be a simple PostgreSQL identifier/);
  });
});

describe("the JSONL file store", () => {
  let directory;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "feedback-file-store-"));
  });

  after(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test("lists the exact pair newest first, keeps line order among equal timestamps, and reads nothing for an authenticated empty scope", async () => {
    const store = createFileFeedbackStore({ directory });
    const at = "2026-10-01T10:00:00.000Z";
    const later = "2026-10-02T10:00:00.000Z";

    for (const record of [
      { createdAt: at, feedbackId: "alice-1", ...ALICE },
      { createdAt: at, feedbackId: "alice-2", ...ALICE },
      { createdAt: later, feedbackId: "alice-3", ...ALICE },
      { createdAt: later, feedbackId: "bob-1", ...BOB },
      { createdAt: later, feedbackId: "alice-user-only", userId: "alice", workspaceId: "" },
      { createdAt: later, feedbackId: "unowned", userId: "", workspaceId: "" },
    ]) {
      assert.equal(await store.recordFeedback(record), record);
    }

    await appendFile(path.join(directory, "feedback.jsonl"), "not-json\n", "utf8");

    const ids = (records) => records.map((record) => record.feedbackId);

    assert.deepEqual(ids(await store.listFeedback({ accessScope: ALICE })), ["alice-3", "alice-1", "alice-2"]);
    assert.deepEqual(ids(await store.listFeedback({ accessScope: ALICE, limit: 2 })), ["alice-3", "alice-1"]);
    // A user without a workspace now sees its own records (it saw none).
    assert.deepEqual(ids(await store.listFeedback({ accessScope: { userId: "alice" } })), ["alice-user-only"]);
    assert.deepEqual(ids(await store.listFeedback({ accessScope: { ...BOB, authenticated: true } })), ["bob-1"]);
    assert.equal((await store.listFeedback({ accessScope: { authenticated: true }, limit: 100 })).length, 6);
    assert.equal((await store.listFeedback({ accessScope: {}, limit: 100 })).length, 6);
    assert.deepEqual(ids(await store.listAllFeedback()), [
      "alice-1",
      "alice-2",
      "alice-3",
      "bob-1",
      "alice-user-only",
      "unowned",
    ]);
    assert.deepEqual(store.describe(), { backend: "file", path: path.join(directory, "feedback.jsonl") });
  });

});

describe("the PostgreSQL store", () => {
  test("stores a built record and reads it back unchanged, under the request's tenant", async () => {
    const database = createFakeFeedbackDatabase();
    const store = createFakeStore(database);
    const record = buildFeedbackRecord({ accessScope: ALICE, payload: samplePayload() });
    const stored = await runWithDatabaseTenant(ALICE, () => store.recordFeedback(record));

    assert.deepStrictEqual(stored, record);
    assert.deepEqual(Object.keys(stored), Object.keys(record), "keys in buildFeedbackRecord's order");
    assert.deepEqual(database.statements[0].tenant, ALICE);
    assert.equal(database.rows[0].owner_user_id, "alice");
    assert.equal(database.rows[0].workspace_id, "ws-a");
    assert.equal(database.rows[0].turn_index, "2");
    assert.doesNotMatch(database.statements[0].sql, /ON CONFLICT/);

    const listed = await runWithDatabaseTenant(ALICE, () => store.listFeedback({ accessScope: ALICE }));

    assert.deepStrictEqual(listed, [record]);
    assert.equal(database.migrations, 1, "migrations run once per store");
  });

  test("lists the exact pair newest first with insertion order among equal timestamps", async () => {
    const database = createFakeFeedbackDatabase();
    const store = createFakeStore(database);
    const at = "2026-10-01T10:00:00.000Z";
    const later = "2026-10-02T10:00:00.000Z";

    await runAsDatabaseSystem(async () => {
      for (const record of [
        { createdAt: at, feedbackId: "alice-1", ...ALICE },
        { createdAt: at, feedbackId: "alice-2", ...ALICE },
        { createdAt: later, feedbackId: "alice-3", ...ALICE },
        { createdAt: later, feedbackId: "bob-1", ...BOB },
        { createdAt: later, feedbackId: "alice-user-only", userId: "alice", workspaceId: "" },
      ]) {
        await store.recordFeedback({ feedbackType: "helpful", question: "Q?", ...record });
      }
    });

    const ids = (records) => records.map((record) => record.feedbackId);
    const select = () => database.statements.at(-1);

    assert.deepEqual(ids(await store.listFeedback({ accessScope: ALICE })), ["alice-3", "alice-1", "alice-2"]);
    assert.deepEqual(select().values, ["alice", "ws-a", 25]);
    assert.deepEqual(ids(await store.listFeedback({ accessScope: ALICE, limit: "2" })), ["alice-3", "alice-1"]);
    assert.deepEqual(select().values, ["alice", "ws-a", 2]);
    assert.deepEqual(ids(await store.listFeedback({ accessScope: { userId: "alice" } })), ["alice-user-only"]);

    // Auth disabled without a user: every record, on the owner path.
    assert.equal((await store.listFeedback({})).length, 5);
    assert.doesNotMatch(select().sql, /WHERE/);

    // The single shared token without a user reads like auth off.
    assert.equal((await store.listFeedback({ accessScope: { authenticated: true } })).length, 5);
    assert.doesNotMatch(select().sql, /WHERE/);

    // The policy narrows a forgotten filter to the bound tenant.
    assert.deepEqual(
      ids(await runWithDatabaseTenant(BOB, () => store.listFeedback({ accessScope: {} }))),
      ["bob-1"]
    );
    assert.deepEqual(ids(await runWithDatabaseTenant(BOB, () => store.listAllFeedback())), ["bob-1"]);
    assert.deepEqual(ids(await listAllFeedbackAcrossTenants({ store })), [
      "alice-1",
      "alice-2",
      "alice-3",
      "bob-1",
      "alice-user-only",
    ]);
  });

  test("a tenant cannot file a record under another tenant, and a reused feedbackId fails the write", async () => {
    const database = createFakeFeedbackDatabase();
    const store = createFakeStore(database);
    const bobRecord = buildFeedbackRecord({ accessScope: BOB, payload: samplePayload() });

    await assert.rejects(
      runWithDatabaseTenant(ALICE, () => store.recordFeedback(bobRecord)),
      (error) => error.code === "42501"
    );

    await runWithDatabaseTenant(BOB, () => store.recordFeedback(bobRecord));
    await assert.rejects(
      runWithDatabaseTenant(BOB, () => store.recordFeedback(bobRecord)),
      (error) => error.code === "23505"
    );
    assert.equal(database.rows.length, 1);
  });

  test("content drops U+0000, ids keep it and fail closed, nested values keep it, and extra fields survive", async () => {
    const database = createFakeFeedbackDatabase();
    const store = createFakeStore(database, { now: () => Date.parse("2026-10-17T00:00:00.000Z") });
    const record = {
      ...buildFeedbackRecord({ accessScope: ALICE, payload: samplePayload() }),
      question: "Policy\u0000 question?",
      skills: [{ label: "nul\u0000label", skillId: "document_rag" }],
    };
    const stored = await store.recordFeedback(record);

    assert.equal(stored.question, "Policy question?");
    assert.equal(stored.skills[0].label, "nul\u0000label", "json keeps the escape jsonb would refuse");
    assert.deepStrictEqual((await store.listAllFeedback())[0], stored);

    await assert.rejects(
      store.recordFeedback({ ...record, feedbackId: "other", userId: "ali\u0000ce" }),
      (error) => error.code === "22021"
    );

    // An imported record's own fields that no column holds come back in extra.
    const imported = await store.recordFeedback({
      createdAt: "not a date",
      expectedAnswerIncludes: ["manager approval"],
      feedbackId: "imported-1",
      feedbackType: "incomplete",
      question: "Q?",
      turnIndex: 1e21,
    });

    assert.equal(imported.createdAt, "2026-10-17T00:00:00.000Z", "an unparseable time becomes now");
    assert.equal(imported.turnIndex, 1e21);
    assert.deepEqual(imported.docIds, []);
    assert.equal(imported.agentObservability, null);
    assert.deepEqual(imported.expectedAnswerIncludes, ["manager approval"]);
    assert.deepStrictEqual(
      (await store.listAllFeedback()).find((entry) => entry.feedbackId === "imported-1"),
      imported
    );
  });

  test("import skips feedbackIds already stored and counts them", async () => {
    const database = createFakeFeedbackDatabase();
    const store = createFakeStore(database);
    const first = { createdAt: "2026-10-01T00:00:00.000Z", feedbackId: "f-1", feedbackType: "helpful", question: "Q?", ...ALICE };
    const second = { ...first, feedbackId: "f-2", ...BOB };

    assert.deepEqual(await runAsDatabaseSystem(() => store.importFeedback([first])), {
      alreadyPresent: 0,
      inserted: 1,
    });
    assert.equal(await runAsDatabaseSystem(() => store.countExistingFeedbackIds(["f-1", "f-2"])), 1);
    assert.equal(await store.countExistingFeedbackIds([]), 0);
    assert.deepEqual(await runAsDatabaseSystem(() => store.importFeedback([first, second])), {
      alreadyPresent: 1,
      inserted: 1,
    });
    assert.match(database.statements.find((entry) => entry.sql.startsWith("INSERT")).sql, /ON CONFLICT \(feedback_id\) DO NOTHING/);
    assert.deepEqual(
      database.rows.map((row) => [row.feedback_id, row.owner_user_id, row.workspace_id]),
      [
        ["f-1", "alice", "ws-a"],
        ["f-2", "bob", "ws-b"],
      ]
    );
  });

  test("the row mapping and the stored record agree for every column", () => {
    const { record, values } = buildStoredFeedback(
      buildFeedbackRecord({ accessScope: ALICE, payload: samplePayload({ turnIndex: undefined }) })
    );

    assert.equal(values.length, 17);
    assert.equal(values[5], null, "no turn index");
    assert.deepStrictEqual(
      mapFeedbackRow({
        agent_mode: values[11],
        agent_observability: JSON.parse(values[14]),
        answer_text: values[10],
        citations: JSON.parse(values[15]),
        claim_checks: JSON.parse(values[13]),
        created_at: new Date(values[3]),
        doc_ids: JSON.parse(values[7]),
        extra: JSON.parse(values[16]),
        feedback_id: values[0],
        feedback_type: values[8],
        note: values[9],
        owner_user_id: values[1],
        question: values[6],
        session_id: values[4],
        skills: JSON.parse(values[12]),
        turn_index: values[5],
        workspace_id: values[2],
      }),
      record
    );
  });
});

describe("the /feedback routes", () => {
  const okHealthService = {
    buildHealthReport: async () => ({ checks: {}, status: "ok" }),
    runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
  };
  const createApp = (feedbackStore) =>
    createProductionApp({
      adminAuditService: createAdminAuditService({ store: createInMemoryAdminAuditStore() }),
      agentExperienceMemoryService: { recordFromFeedback: async () => null },
      agentRunStore: createInMemoryAgentRunStore(),
      executionPlannerAdapter: deterministicPlannerAdapter,
      feedbackStore,
      healthService: okHealthService,
      ingestJobStore: createInMemoryIngestJobStore(),
      intentPlannerAdapter: deterministicIntentPlannerAdapter,
      ragService: {
        initializeDocumentRegistry: async () => [],
        initializeLongMemory: async () => true,
        initializeSessionMemory: async () => true,
      },
      taskStore: createInMemoryTaskStore(),
      workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
    });
  const startServer = async (app) => {
    const server = createServer(app);

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  };
  const call = async (server, { body, headers = {}, method = "GET", path: requestPath }) => {
    const response = await fetch(`${server.baseUrl}${requestPath}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      method,
    });

    return { json: await response.json(), status: response.status };
  };

  test("with auth on, records are filed under the credential's tenant and each tenant lists only its own", async () => {
    const database = createFakeFeedbackDatabase();

    await withEnv(
      {
        API_AUTH_ENABLED: "true",
        API_AUTH_TOKEN: "",
        API_AUTH_TOKENS: JSON.stringify({
          "alice-token": ALICE,
          "bob-token": BOB,
        }),
        RBAC_MODE: undefined,
      },
      async () => {
        const server = await startServer(await createApp(createFakeStore(database)));

        try {
          let response = await call(server, {
            body: samplePayload({ userId: "bob" }),
            headers: { "x-api-key": "alice-token" },
            method: "POST",
            path: "/feedback",
          });

          assert.equal(response.status, 201);
          assert.equal(response.json.feedback.userId, "alice");
          assert.equal(response.json.feedback.workspaceId, "ws-a");

          // A payload workspace that differs from the credential's is refused
          // by requireApiAuth before the route.
          response = await call(server, {
            body: samplePayload({ workspaceId: "ws-b" }),
            headers: { "x-api-key": "alice-token" },
            method: "POST",
            path: "/feedback",
          });
          assert.equal(response.status, 403);

          response = await call(server, {
            body: samplePayload(),
            headers: { "x-api-key": "bob-token" },
            method: "POST",
            path: "/feedback",
          });
          assert.equal(response.status, 201);

          const aliceList = await call(server, { headers: { "x-api-key": "alice-token" }, path: "/feedback" });
          const bobList = await call(server, { headers: { "x-api-key": "bob-token" }, path: "/feedback" });

          assert.deepEqual(aliceList.json.feedback.map((entry) => entry.userId), ["alice"]);
          assert.deepEqual(bobList.json.feedback.map((entry) => entry.userId), ["bob"]);
          assert.deepStrictEqual(aliceList.json.feedback[0], (await call(server, {
            headers: { "x-api-key": "alice-token" },
            path: "/feedback?limit=1",
          })).json.feedback[0]);

          // Every statement ran under the request's own database tenant.
          assert.deepEqual(
            [...new Set(database.statements.map((entry) => JSON.stringify(entry.tenant)))].sort(),
            [JSON.stringify(ALICE), JSON.stringify(BOB)].sort()
          );
          assert.deepEqual(
            database.rows.map((row) => [row.owner_user_id, row.workspace_id]),
            [
              ["alice", "ws-a"],
              ["bob", "ws-b"],
            ]
          );
        } finally {
          await server.close();
        }
      }
    );
  });

  test("the single shared token without a user lists every record (single-tenant mode), and with x-user-id that user's", async () => {
    const database = createFakeFeedbackDatabase();

    await withEnv(
      { API_AUTH_ENABLED: "true", API_AUTH_TOKEN: "shared-token", API_AUTH_TOKENS: "", RBAC_MODE: undefined },
      async () => {
        const server = await startServer(await createApp(createFakeStore(database)));

        try {
          const posted = await call(server, {
            body: samplePayload({ userId: "carol" }),
            headers: { "x-api-key": "shared-token" },
            method: "POST",
            path: "/feedback",
          });

          assert.equal(posted.status, 201);
          assert.deepEqual([posted.json.feedback.userId, posted.json.feedback.workspaceId], ["carol", ""]);

          const unscoped = await call(server, { headers: { "x-api-key": "shared-token" }, path: "/feedback" });
          const carol = await call(server, {
            headers: { "x-api-key": "shared-token", "x-user-id": "carol" },
            path: "/feedback",
          });

          assert.equal(unscoped.status, 200);
          // The single shared token is the single-tenant credential: without a
          // user it reads the whole archive, as auth off does (requireApiAuth
          // lets only this credential through without a tenant).
          assert.deepEqual(unscoped.json.feedback.map((entry) => entry.userId), ["carol"]);
          assert.deepEqual(carol.json.feedback.map((entry) => entry.userId), ["carol"]);
        } finally {
          await server.close();
        }
      }
    );
  });

  test("with auth off, the body's user is the scope's and an empty scope lists every record", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "feedback-routes-"));

    try {
      await withEnv({ API_AUTH_ENABLED: undefined, RBAC_MODE: undefined }, async () => {
        const store = createFileFeedbackStore({ directory });
        const server = await startServer(await createApp(store));

        try {
          for (const userId of ["dave", "erin"]) {
            const response = await call(server, {
              body: samplePayload({ userId }),
              method: "POST",
              path: "/feedback",
            });

            assert.equal(response.status, 201);
            assert.equal(response.json.feedback.userId, userId);
          }

          const all = await call(server, { path: "/feedback" });
          const dave = await call(server, { path: "/feedback?userId=dave" });

          assert.deepEqual(all.json.feedback.map((entry) => entry.userId).sort(), ["dave", "erin"]);
          assert.deepEqual(dave.json.feedback.map((entry) => entry.userId), ["dave"]);
        } finally {
          await server.close();
        }

        const lines = (await readFile(path.join(directory, "feedback.jsonl"), "utf8")).trim().split("\n");

        assert.equal(lines.length, 2);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("createFeedbackService exposes the store's backend and calls", async () => {
    const calls = [];
    const service = createFeedbackService({
      store: {
        backend: "test",
        listFeedback: async (options) => calls.push(["list", options]),
        recordFeedback: async (feedback) => calls.push(["record", feedback]),
      },
    });

    assert.equal(service.backend, "test");
    await service.listFeedback({ limit: 3 });
    await service.recordFeedback({ feedbackId: "x" });
    assert.deepEqual(calls, [
      ["list", { limit: 3 }],
      ["record", { feedbackId: "x" }],
    ]);
  });
});
