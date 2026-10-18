// Retention (rag/retention.js, rag/retention-sql.js): the cutoff helpers, the
// stores' deleteExpired (in memory for real, PostgreSQL through a recording
// fake query), the per-workspace policies, the observability file rotation on
// a temporary directory, and the sweeper's loop with fake timers. The
// real-database counterpart is test/retention.integration.test.mjs.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeRetentionCutoff,
  isRetentionExpired,
  normalizeRetentionBatchLimit,
  normalizeRetentionCutoffs,
  RETENTION_KEEP_FOREVER,
} from "../rag/retention-sql.js";
import {
  buildWorkspaceCutoffs,
  createRetentionSweeper,
  describeObservabilitySegments,
  loadWorkspaceRetentionPolicies,
  loadWorkspaceRetentionPoliciesFromRegistry,
  pruneRagObservabilityFiles,
  readWorkspaceRetentionDays,
  resolveRetentionTargets,
  RETENTION_DATA_TYPES,
  RETENTION_POLICIES_UNAVAILABLE_ERROR_CODE,
  RETENTION_SKIP_REASONS,
  RetentionPoliciesUnavailableError,
  startRetentionSweeper,
} from "../rag/retention.js";
import { deleteExpiredTenantUsage } from "../rag/tenant-usage.js";
import { createAgentRunService, createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { createInMemoryTaskStore, createTaskService } from "../rag/tasks.js";
import {
  createInMemoryWorkspaceArtifactStore,
  createWorkspaceArtifactService,
} from "../rag/workspace-artifacts/index.js";
import { createPostgresAgentRunStore } from "../rag/postgres-agent-run-store.js";
import { createPostgresTaskStore } from "../rag/postgres-task-store.js";
import { createPostgresWorkspaceArtifactStore } from "../rag/workspace-artifacts/postgres-store.js";
import { createPostgresFeedbackStore } from "../rag/postgres-feedback-store.js";
import { createFeedbackService } from "../feedback.js";
import * as config from "../rag/config.js";
import { renderMigrationSql } from "../rag/db-migrations.js";
import { DATABASE_TENANT_CONTEXTS, getDatabaseTenantContext } from "../rag/postgres-tenant.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const daysAgo = (days) => new Date(NOW - days * DAY_MS).toISOString();
const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };

const RETENTION_ENV = [
  "AGENT_RUN_RETENTION_DAYS",
  "FEEDBACK_RETENTION_DAYS",
  "RAG_OBSERVABILITY_RETENTION_DAYS",
  "RETENTION_SWEEP_BATCH_SIZE",
  "RETENTION_SWEEP_INTERVAL_MS",
  "TASK_RETENTION_DAYS",
  "TENANT_USAGE_RETENTION_DAYS",
  "WORKSPACE_ARTIFACT_RETENTION_DAYS",
];

const withEnv = async (values, callback) => {
  const saved = new Map(RETENTION_ENV.map((name) => [name, process.env[name]]));

  for (const name of RETENTION_ENV) {
    delete process.env[name];
  }

  Object.assign(process.env, values);

  try {
    return await callback();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

const silentLogger = () => {
  const lines = { error: [], log: [], warn: [] };

  return {
    error: (...args) => lines.error.push(args.join(" ")),
    lines,
    log: (...args) => lines.log.push(args.join(" ")),
    warn: (...args) => lines.warn.push(args.join(" ")),
  };
};

describe("configuration", () => {
  test("every retention setting defaults to keep forever; the sweep to hourly and 500 rows", async () => {
    await withEnv({}, () => {
      assert.equal(config.getAgentRunRetentionDays(), 0);
      assert.equal(config.getTaskRetentionDays(), 0);
      assert.equal(config.getWorkspaceArtifactRetentionDays(), 0);
      assert.equal(config.getFeedbackRetentionDays(), 0);
      assert.equal(config.getRagObservabilityRetentionDays(), 0);
      assert.equal(config.getTenantUsageRetentionDays(), 0);
      assert.equal(config.getRetentionSweepIntervalMs(), 3_600_000);
      assert.equal(config.getRetentionSweepBatchSize(), 500);
    });
  });

  test("days are whole (fractions round down), bad values keep forever, the batch is capped", async () => {
    await withEnv(
      {
        AGENT_RUN_RETENTION_DAYS: "30.9",
        FEEDBACK_RETENTION_DAYS: "-4",
        RETENTION_SWEEP_BATCH_SIZE: "50000",
        RETENTION_SWEEP_INTERVAL_MS: "0",
        TASK_RETENTION_DAYS: "0.5",
        WORKSPACE_ARTIFACT_RETENTION_DAYS: "soon",
      },
      () => {
        assert.equal(config.getAgentRunRetentionDays(), 30);
        assert.equal(config.getTaskRetentionDays(), 0);
        assert.equal(config.getWorkspaceArtifactRetentionDays(), 0);
        assert.equal(config.getFeedbackRetentionDays(), 0);
        assert.equal(config.getRetentionSweepIntervalMs(), 0);
        assert.equal(config.getRetentionSweepBatchSize(), 10_000);
      }
    );
    await withEnv({ RETENTION_SWEEP_BATCH_SIZE: "0.2" }, () => {
      assert.equal(config.getRetentionSweepBatchSize(), 500);
    });
  });
});

describe("migration 039", () => {
  test("grants the system role DELETE on feedback and nothing else; the tenant role gains nothing", async () => {
    const migrationSql = await readFile(
      new URL("../db/migrations/039_grant_feedback_retention_delete.sql", import.meta.url),
      "utf8"
    );
    const rendered = renderMigrationSql(migrationSql, undefined, {
      embeddingDimensions: 8,
      systemRole: "archive_system",
      tenantRole: "archive_tenant",
      vectorIndexStatement: "",
    });
    const statements = rendered
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("--"));

    assert.doesNotMatch(rendered, /__[A-Z_]+__/, "every placeholder is rendered");
    assert.deepEqual(statements, ["GRANT DELETE ON rag_feedback TO archive_system;"]);
    assert.doesNotMatch(rendered, /archive_tenant/);
  });
});

describe("cutoff helpers", () => {
  test("computeRetentionCutoff counts whole days back from now and keeps forever at 0", () => {
    assert.equal(computeRetentionCutoff({ days: 30, now: NOW }), daysAgo(30));
    assert.equal(computeRetentionCutoff({ days: 30.7, now: NOW }), daysAgo(30));
    assert.equal(computeRetentionCutoff({ days: 0, now: NOW }), null);
    assert.equal(computeRetentionCutoff({ days: -1, now: NOW }), null);
    assert.equal(computeRetentionCutoff({ days: "x", now: NOW }), null);
    assert.equal(computeRetentionCutoff({ days: 1e12, now: NOW }), null, "a date JavaScript cannot hold keeps forever");
  });

  test("normalizeRetentionCutoffs refuses a missing cutoff and renders the overrides as bind values", () => {
    assert.throws(() => normalizeRetentionCutoffs({}), TypeError);
    assert.throws(() => normalizeRetentionCutoffs({ cutoff: "not a date" }), TypeError);
    assert.throws(
      () => normalizeRetentionCutoffs({ cutoff: daysAgo(30), workspaceCutoffs: [{ cutoff: "never", workspaceId: "w" }] }),
      TypeError
    );

    const normalized = normalizeRetentionCutoffs({
      cutoff: daysAgo(30),
      workspaceCutoffs: [
        { cutoff: daysAgo(7), workspaceId: "ws-short" },
        { cutoff: null, workspaceId: "ws-keep" },
        { cutoff: daysAgo(365), workspaceId: "ws-long" },
        { cutoff: daysAgo(1), workspaceId: "ws-short" },
        { cutoff: daysAgo(1), workspaceId: "" },
      ],
    });

    assert.equal(normalized.cutoff, daysAgo(30));
    assert.equal(normalized.upperBound, daysAgo(7), "the latest cutoff of all, the first override of a workspace wins");
    assert.deepEqual(normalized.workspaceIds, ["ws-short", "ws-keep", "ws-long"]);
    assert.deepEqual(normalized.workspaceCutoffs, [daysAgo(7), RETENTION_KEEP_FOREVER, daysAgo(365)]);

    assert.equal(isRetentionExpired(normalized, { timestamp: daysAgo(10), workspaceId: "ws-short" }), true);
    assert.equal(isRetentionExpired(normalized, { timestamp: daysAgo(10), workspaceId: "other" }), false);
    assert.equal(isRetentionExpired(normalized, { timestamp: daysAgo(40), workspaceId: "other" }), true);
    assert.equal(isRetentionExpired(normalized, { timestamp: daysAgo(4000), workspaceId: "ws-keep" }), false);
    assert.equal(isRetentionExpired(normalized, { timestamp: daysAgo(100), workspaceId: "ws-long" }), false);
    assert.equal(isRetentionExpired(normalized, { timestamp: "", workspaceId: "other" }), false, "an unreadable time never expires");
  });

  test("the batch limit is a positive whole number up to 10000", () => {
    assert.equal(normalizeRetentionBatchLimit(undefined), 500);
    assert.equal(normalizeRetentionBatchLimit(0), 500);
    assert.equal(normalizeRetentionBatchLimit(12.9), 12);
    assert.equal(normalizeRetentionBatchLimit(1e9), 10_000);
  });
});

describe("in-memory stores", () => {
  const seedRuns = async () => {
    let clock = NOW;
    const store = createInMemoryAgentRunStore({ now: () => new Date(clock).toISOString() });
    const service = createAgentRunService({ agentRunStore: store });
    const seed = async (scope, runId, status, age) => {
      clock = NOW - age * DAY_MS;
      await store.createWithEvent({
        accessScope: scope,
        event: { payload: {}, type: "run_created" },
        run: { goal: "g", runId, status },
      });

      return store;
    };

    for (const scope of [ALICE, BOB]) {
      const p = scope.userId;

      await seed(scope, `${p}-completed-old`, "completed", 100);
      await seed(scope, `${p}-failed-old`, "failed", 90);
      await seed(scope, `${p}-canceled-old`, "canceled", 80);
      await seed(scope, `${p}-running-old`, "running", 100);
      await seed(scope, `${p}-waiting-old`, "waiting_for_user", 100);
      await seed(scope, `${p}-completed-new`, "completed", 1);
    }

    // An approval snapshot on an old finished run and on a waiting one.
    clock = NOW - 100 * DAY_MS;

    for (const runId of ["alice-completed-old", "alice-waiting-old"]) {
      const run = store.get({ accessScope: ALICE, runId });

      await store.updateWithEvent({
        accessScope: ALICE,
        approvalSnapshots: [
          {
            approvalObjectHash: "h",
            capabilityId: "c",
            capabilityVersion: "1",
            executionInput: {},
            gateId: "gate-1",
            snapshotVersion: 1,
          },
        ],
        event: { payload: {}, type: "approval_requested" },
        expectedRevision: run.revision,
        patch: {},
        runId,
      });
    }

    return { service, store };
  };

  const remainingRuns = (store) =>
    [ALICE, BOB].flatMap((scope) => store.list({ accessScope: scope, limit: "all" }).map((run) => run.runId)).sort();

  test("agent runs: only finished runs older than the cutoff go, with their events and approval snapshots", async () => {
    const { service, store } = await seedRuns();
    const result = await service.deleteExpiredRuns({ cutoff: daysAgo(30), limit: 100 });

    assert.deepEqual(result, { acquired: true, deleted: 6, deletedEvents: 7 });
    assert.deepEqual(remainingRuns(store), [
      "alice-completed-new",
      "alice-running-old",
      "alice-waiting-old",
      "bob-completed-new",
      "bob-running-old",
      "bob-waiting-old",
    ]);
    assert.equal(store.getApprovalSnapshot({ accessScope: ALICE, gateId: "gate-1", runId: "alice-completed-old" }), null);
    assert.ok(store.getApprovalSnapshot({ accessScope: ALICE, gateId: "gate-1", runId: "alice-waiting-old" }));
    assert.equal(store.get({ accessScope: ALICE, runId: "alice-waiting-old" }).events.length, 2);

    // A recreated run under a deleted id starts with no stale events.
    await store.createWithEvent({
      accessScope: ALICE,
      event: { payload: {}, type: "run_created" },
      run: { goal: "g", runId: "alice-completed-old", status: "running" },
    });
    assert.equal(store.get({ accessScope: ALICE, runId: "alice-completed-old" }).events.length, 1);
  });

  test("agent runs: batches go oldest first, and workspace overrides shorten, lengthen or keep", async () => {
    const { store } = await seedRuns();
    const first = store.deleteExpired({ cutoff: daysAgo(30), limit: 2 });

    assert.equal(first.deleted, 2);
    assert.deepEqual(
      ["alice-completed-old", "bob-completed-old"].map((runId) =>
        Boolean(store.get({ accessScope: runId.startsWith("alice") ? ALICE : BOB, runId }))
      ),
      [false, false],
      "the two 100-day-old runs go first"
    );

    const { store: other } = await seedRuns();

    other.deleteExpired({
      cutoff: daysAgo(30),
      limit: 100,
      workspaceCutoffs: [
        { cutoff: null, workspaceId: "ws-b" },
        { cutoff: daysAgo(85), workspaceId: "ws-a" },
      ],
    });
    assert.deepEqual(remainingRuns(other), [
      "alice-canceled-old",
      "alice-completed-new",
      "alice-running-old",
      "alice-waiting-old",
      "bob-canceled-old",
      "bob-completed-new",
      "bob-completed-old",
      "bob-failed-old",
      "bob-running-old",
      "bob-waiting-old",
    ]);
  });

  test("tasks: only finished tasks older than the cutoff go", async () => {
    const store = createInMemoryTaskStore();
    const service = createTaskService({ taskStore: store });
    const statuses = ["completed", "failed", "canceled", "pending", "queued", "running", "waiting_for_user"];

    for (const scope of [ALICE, BOB]) {
      for (const status of statuses) {
        store.upsert({
          accessScope: scope,
          task: { id: `${scope.userId}-${status}-old`, status, type: "agent", updatedAt: daysAgo(100) },
        });
      }

      store.upsert({
        accessScope: scope,
        task: { id: `${scope.userId}-completed-new`, status: "completed", type: "agent", updatedAt: daysAgo(1) },
      });
    }

    const result = await service.deleteExpiredTasks({
      cutoff: daysAgo(30),
      limit: 100,
      workspaceCutoffs: [{ cutoff: null, workspaceId: "ws-b" }],
    });
    const remaining = [ALICE, BOB].flatMap((scope) =>
      store.list({ accessScope: scope, limit: "all" }).map((task) => task.id)
    );

    assert.deepEqual(result, { acquired: true, deleted: 3, deletedEvents: 0 });
    assert.deepEqual(remaining.sort(), [
      "alice-completed-new",
      "alice-pending-old",
      "alice-queued-old",
      "alice-running-old",
      "alice-waiting_for_user-old",
      ...statuses.map((status) => `bob-${status}-old`),
      "bob-completed-new",
    ].sort());
  });

  test("workspace artifacts: only archived ones, by archive time; the idempotency key is freed", async () => {
    let clock = NOW;
    const store = createInMemoryWorkspaceArtifactStore();
    let nextId = 0;
    const service = createWorkspaceArtifactService({
      createArtifactId: () => `artifact-${(nextId += 1)}`,
      now: () => new Date(clock).toISOString(),
      store,
    });
    const make = async (scope, key, { archivedDaysAgo = null, createdDaysAgo }) => {
      clock = NOW - createdDaysAgo * DAY_MS;
      const artifact = await service.createArtifact({
        accessScope: scope,
        artifact: { artifactType: "report", content: "x", idempotencyKey: key, title: key },
      });

      if (archivedDaysAgo !== null) {
        clock = NOW - archivedDaysAgo * DAY_MS;
        await service.archiveArtifact({ accessScope: scope, artifactId: artifact.artifactId });
      }

      return artifact;
    };

    const oldArchived = await make(ALICE, "old-archived", { archivedDaysAgo: 60, createdDaysAgo: 200 });
    const oldActive = await make(ALICE, "old-active", { createdDaysAgo: 200 });
    const recentlyArchived = await make(ALICE, "recently-archived", { archivedDaysAgo: 2, createdDaysAgo: 200 });
    const bobArchived = await make(BOB, "bob-archived", { archivedDaysAgo: 60, createdDaysAgo: 200 });

    const result = await service.deleteExpiredArtifacts({ cutoff: daysAgo(30), limit: 100 });

    assert.deepEqual(result, { acquired: true, deleted: 2 });
    assert.equal(await service.getArtifact({ accessScope: ALICE, artifactId: oldArchived.artifactId }), null);
    assert.equal(await service.getArtifact({ accessScope: BOB, artifactId: bobArchived.artifactId }), null);
    assert.ok(await service.getArtifact({ accessScope: ALICE, artifactId: oldActive.artifactId }));
    assert.ok(await service.getArtifact({ accessScope: ALICE, artifactId: recentlyArchived.artifactId }));

    clock = NOW;
    const recreated = await service.createArtifact({
      accessScope: ALICE,
      artifact: { artifactType: "report", content: "y", idempotencyKey: "old-archived", title: "again" },
    });

    assert.notEqual(recreated.artifactId, oldArchived.artifactId, "the key no longer resolves to the deleted artifact");
    assert.equal(recreated.status, "active");
  });

  test("a service whose store has no retention delete answers null", async () => {
    assert.equal(await createAgentRunService({ agentRunStore: {} }).deleteExpiredRuns({ cutoff: daysAgo(1) }), null);
    assert.equal(await createTaskService({ taskStore: {} }).deleteExpiredTasks({ cutoff: daysAgo(1) }), null);
    assert.equal(
      await createWorkspaceArtifactService({ store: {} }).deleteExpiredArtifacts({ cutoff: daysAgo(1) }),
      null
    );
    assert.equal(
      await createFeedbackService({ store: { backend: "file" } }).deleteExpiredFeedback({ cutoff: daysAgo(1) }),
      null
    );
  });
});

describe("PostgreSQL stores (recording query)", () => {
  const recordingQuery = (rows = [{ acquired: true, deleted: 3, deleted_events: 7 }]) => {
    const calls = [];
    const query = async (text, values) => {
      calls.push({ text, values });
      return { rows };
    };

    return { calls, query };
  };
  const overrides = [
    { cutoff: null, workspaceId: "ws-b" },
    { cutoff: daysAgo(7), workspaceId: "ws-a" },
  ];
  const squash = (text) => text.replace(/\s+/g, " ");

  test("agent runs: one statement with the try-lock, finished statuses, the overrides, SKIP LOCKED and events", async () => {
    const { calls, query } = recordingQuery();
    const store = createPostgresAgentRunStore({ query, runMigrations: async () => {} });
    const result = await store.deleteExpired({ cutoff: daysAgo(30), limit: 25, workspaceCutoffs: overrides });
    const sql = squash(calls[0].text);

    assert.deepEqual(result, { acquired: true, deleted: 3, deletedEvents: 7 });
    assert.equal(calls.length, 1);
    assert.match(sql, /pg_try_advisory_xact_lock\(hashtextextended\(\$1::text, 0\)\)/);
    assert.match(sql, /unnest\(\$5::text\[\], \$6::text\[\]\)/);
    assert.match(sql, /WHERE \(SELECT acquired FROM retention_lock\) AND r\.status = ANY\(\$2::text\[\]\)/);
    assert.match(sql, /r\.updated_at < COALESCE\(o\.cutoff, \$3::timestamptz\)/);
    assert.match(sql, /LIMIT \$7 FOR UPDATE OF r SKIP LOCKED/);
    assert.match(sql, /DELETE FROM rag_agent_run_events AS e USING expired AS x/);
    assert.match(sql, /DELETE FROM rag_agent_runs AS r USING expired AS x/);
    assert.deepEqual(calls[0].values, [
      "archive_rag:retention:rag_agent_runs",
      ["canceled", "completed", "failed"],
      daysAgo(30),
      daysAgo(7),
      ["ws-b", "ws-a"],
      [RETENTION_KEEP_FOREVER, daysAgo(7)],
      25,
    ]);
  });

  test("agent runs: a lost try-lock is reported, and a bad cutoff never reaches the database", async () => {
    const { calls, query } = recordingQuery([{ acquired: false, deleted: 0, deleted_events: 0 }]);
    const store = createPostgresAgentRunStore({ query, runMigrations: async () => {} });

    assert.deepEqual(await store.deleteExpired({ cutoff: daysAgo(30) }), {
      acquired: false,
      deleted: 0,
      deletedEvents: 0,
    });
    await assert.rejects(store.deleteExpired({ cutoff: "" }), TypeError);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values[6], 500, "the default batch");
  });

  test("tasks: finished statuses only, with their events, under SKIP LOCKED", async () => {
    const { calls, query } = recordingQuery([{ acquired: true, deleted: 2, deleted_events: 5 }]);
    const store = createPostgresTaskStore({ query, runMigrations: async () => {} });
    const result = await store.deleteExpired({ cutoff: daysAgo(30), limit: 10 });
    const sql = squash(calls[0].text);

    assert.deepEqual(result, { acquired: true, deleted: 2, deletedEvents: 5 });
    assert.match(sql, /t\.status = ANY\(\$2::text\[\]\)/);
    assert.match(sql, /FOR UPDATE OF t SKIP LOCKED/);
    assert.match(sql, /DELETE FROM rag_task_events AS e USING expired AS x/);
    assert.deepEqual(calls[0].values.slice(0, 2), ["archive_rag:retention:rag_tasks", ["canceled", "completed", "failed"]]);
    assert.deepEqual(calls[0].values.slice(4), [[], [], 10]);
  });

  test("workspace artifacts: archived only, by archive time", async () => {
    const { calls, query } = recordingQuery([{ acquired: true, deleted: 4 }]);
    const store = createPostgresWorkspaceArtifactStore({ query, runMigrations: async () => {} });
    const result = await store.deleteExpired({ cutoff: daysAgo(30), limit: 10, workspaceCutoffs: overrides });
    const sql = squash(calls[0].text);

    assert.deepEqual(result, { acquired: true, deleted: 4 });
    assert.match(sql, /a\.status = 'archived'/);
    assert.match(sql, /COALESCE\(a\.archived_at, a\.updated_at\) < COALESCE\(o\.cutoff, \$2::timestamptz\)/);
    assert.match(sql, /FOR UPDATE OF a SKIP LOCKED/);
    assert.deepEqual(calls[0].values, [
      `archive_rag:retention:${config.getWorkspaceArtifactsPostgresTable()}`,
      daysAgo(30),
      daysAgo(7),
      ["ws-b", "ws-a"],
      [RETENTION_KEEP_FOREVER, daysAgo(7)],
      10,
    ]);
  });

  test("feedback: by creation time, without a row lock (the system role holds no UPDATE)", async () => {
    const { calls, query } = recordingQuery([{ acquired: true, deleted: 9 }]);
    const store = createPostgresFeedbackStore({ query, runMigrations: async () => {} });
    const service = createFeedbackService({ store });
    const result = await service.deleteExpiredFeedback({ cutoff: daysAgo(30), limit: 10 });
    const sql = squash(calls[0].text);

    assert.deepEqual(result, { acquired: true, deleted: 9 });
    assert.match(sql, /f\.created_at < COALESCE\(o\.cutoff, \$2::timestamptz\)/);
    assert.doesNotMatch(sql, /FOR UPDATE/);
    assert.match(sql, /DELETE FROM rag_feedback AS f USING expired AS x WHERE f\.id = x\.id/);
    assert.equal(calls[0].values[0], "archive_rag:retention:rag_feedback");
  });

  test("usage ledger: every tenant's rows by the start of their hour, under SKIP LOCKED, nothing without a database", async () => {
    const { calls, query } = recordingQuery([{ acquired: true, deleted: 4 }]);
    const result = await deleteExpiredTenantUsage({
      cutoff: daysAgo(90),
      isDatabaseConfigured: () => true,
      limit: 25,
      query,
    });
    const sql = squash(calls[0].text);

    assert.deepEqual(result, { acquired: true, deleted: 4 });
    assert.match(sql, /u\.period_start < \$2::timestamptz LIMIT \$5 FOR UPDATE SKIP LOCKED/);
    assert.doesNotMatch(sql, /retention_overrides AS o ON/, "no workspace policy applies to the ledger");
    assert.match(sql, /DELETE FROM tenant_usage AS u USING expired AS x/);
    assert.deepEqual(calls[0].values, ["archive_rag:retention:tenant_usage", daysAgo(90), [], [], 25]);

    const offline = recordingQuery();

    assert.deepEqual(
      await deleteExpiredTenantUsage({ cutoff: daysAgo(90), isDatabaseConfigured: () => false, query: offline.query }),
      { acquired: true, deleted: 0 }
    );
    assert.equal(offline.calls.length, 0);
    await assert.rejects(deleteExpiredTenantUsage({ cutoff: "", query }), TypeError, "a bad cutoff never deletes");
  });
});

describe("per-workspace policies", () => {
  test("readWorkspaceRetentionDays reads the type's keys and ignores what it cannot read", () => {
    const type = RETENTION_DATA_TYPES;

    // The tenant registry's format (rag/workspace-retention-policy.js): one
    // camelCase key per type, a whole number of days from 0 to 36500.
    assert.equal(readWorkspaceRetentionDays({ agentRuns: 7 }, type.agentRuns), 7);
    assert.equal(readWorkspaceRetentionDays('{"tasks": 0}', type.tasks), 0);
    assert.equal(readWorkspaceRetentionDays({ workspaceArtifacts: 5 }, type.workspaceArtifacts), 5);
    assert.equal(readWorkspaceRetentionDays({ feedback: 36_500 }, type.feedback), 36_500);
    // What the registry refuses is not read either: the global value applies.
    assert.equal(readWorkspaceRetentionDays({ agent_runs: 14 }, type.agentRuns), undefined);
    assert.equal(readWorkspaceRetentionDays({ AGENT_RUN_RETENTION_DAYS: 3 }, type.agentRuns), undefined);
    assert.equal(readWorkspaceRetentionDays({ agentRuns: "14" }, type.agentRuns), undefined);
    assert.equal(readWorkspaceRetentionDays({ agentRuns: { days: 3 } }, type.agentRuns), undefined);
    assert.equal(readWorkspaceRetentionDays({ agentRuns: 3.8 }, type.agentRuns), undefined);
    assert.equal(readWorkspaceRetentionDays({ feedback: 36_501 }, type.feedback), undefined);
    assert.equal(readWorkspaceRetentionDays({ tasks: -1 }, type.tasks), undefined);
    assert.equal(readWorkspaceRetentionDays({ tasks: true }, type.tasks), undefined);
    assert.equal(readWorkspaceRetentionDays({ tasks: null }, type.tasks), undefined);
    assert.equal(readWorkspaceRetentionDays({ tasks: 3 }, type.agentRuns), undefined);
    assert.equal(readWorkspaceRetentionDays("not json", type.tasks), undefined);
    assert.equal(readWorkspaceRetentionDays([1], type.tasks), undefined);
  });

  test("buildWorkspaceCutoffs turns policies into overrides (0 keeps forever)", () => {
    const policies = new Map([
      ["ws-a", { agentRuns: 7 }],
      ["ws-b", { agentRuns: 0 }],
      ["ws-c", { tasks: 3 }],
    ]);

    assert.deepEqual(buildWorkspaceCutoffs({ dataType: RETENTION_DATA_TYPES.agentRuns, now: NOW, policies }), [
      { cutoff: daysAgo(7), workspaceId: "ws-a" },
      { cutoff: null, workspaceId: "ws-b" },
    ]);
  });

  test("loadWorkspaceRetentionPolicies reads the table only when it has the columns, as system work", async () => {
    const contexts = [];
    const respond = (shape, rows = []) => async (text) => {
      contexts.push(getDatabaseTenantContext());

      return text.includes("to_regclass") ? { rows: [shape] } : { rows };
    };
    const logger = silentLogger();

    assert.deepEqual(
      await loadWorkspaceRetentionPolicies({ logger, query: respond({ table_exists: false }) }),
      new Map()
    );
    assert.deepEqual(
      await loadWorkspaceRetentionPolicies({
        logger,
        query: respond({ has_retention_policy: true, has_workspace_id: false, table_exists: true }),
      }),
      new Map()
    );
    assert.match(logger.lines.warn.at(-1), /no workspace_id column/);

    const policies = await loadWorkspaceRetentionPolicies({
      logger,
      query: respond({ has_retention_policy: true, has_workspace_id: true, table_exists: true }, [
        { retention_policy: { agentRuns: 7 }, workspace_id: "ws-a" },
        { retention_policy: '{"tasks": 2}', workspace_id: "ws-b" },
        { retention_policy: "broken", workspace_id: "ws-c" },
      ]),
    });

    assert.deepEqual([...policies], [
      ["ws-a", { agentRuns: 7 }],
      ["ws-b", { tasks: 2 }],
    ]);
    assert.ok(contexts.every((context) => context === DATABASE_TENANT_CONTEXTS.system));

    // A read that fails is not "no policies": it rejects, and the sweep then
    // deletes nothing (see "the sweeper" below).
    await assert.rejects(
      loadWorkspaceRetentionPolicies({
        logger,
        query: async () => {
          const error = new Error("permission denied for table workspaces");
          error.code = "42501";
          throw error;
        },
      }),
      (error) =>
        error instanceof RetentionPoliciesUnavailableError &&
        error.code === RETENTION_POLICIES_UNAVAILABLE_ERROR_CODE &&
        /42501/.test(error.message) &&
        error.cause?.code === "42501"
    );
    await assert.rejects(
      loadWorkspaceRetentionPolicies({ logger, table: "bad; name" }),
      (error) => error.code === RETENTION_POLICIES_UNAVAILABLE_ERROR_CODE
    );
  });

  test("the probe reads the table's shape from pg_attribute, so a revoked grant fails the read instead of hiding the column", async () => {
    const statements = [];

    await loadWorkspaceRetentionPolicies({
      logger: silentLogger(),
      query: async (text) => {
        statements.push(text);
        return { rows: [{ table_exists: false }] };
      },
      table: "rag_workspaces",
    });

    // information_schema.columns lists only the columns the role holds a
    // privilege on: without the grant it would answer "no retention_policy
    // column", read as no policies, and the sweep would use the global cutoffs.
    assert.match(statements[0], /pg_catalog\.pg_attribute/);
    assert.doesNotMatch(statements[0], /information_schema/);
  });

  test("a transient failure of the policy read after the probe rejects too; only a missing table is no policies", async () => {
    const reset = Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
    const probeOk = { rows: [{ has_retention_policy: true, has_workspace_id: true, table_exists: true }] };

    await assert.rejects(
      loadWorkspaceRetentionPolicies({
        logger: silentLogger(),
        query: async (text) => {
          if (text.includes("to_regclass")) return probeOk;
          throw reset;
        },
        table: "rag_workspaces",
      }),
      (error) => error.code === RETENTION_POLICIES_UNAVAILABLE_ERROR_CODE && error.cause === reset
    );
    await assert.rejects(
      loadWorkspaceRetentionPolicies({
        logger: silentLogger(),
        query: async () => {
          throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        },
        table: "rag_workspaces",
      }),
      /57014/
    );
    assert.deepEqual(
      await loadWorkspaceRetentionPolicies({
        logger: silentLogger(),
        query: async () => ({ rows: [{ table_exists: false }] }),
        table: "rag_workspaces",
      }),
      new Map(),
      "before migration 036 there is no policy to keep"
    );
  });

  test("the policies are the tenant registry's: its configured table with a database, its in-memory store without", async () => {
    const statements = [];
    const query = async (text, values = []) => {
      statements.push({ text: text.replace(/\s+/g, " ").trim(), values });

      return text.includes("to_regclass")
        ? { rows: [{ has_retention_policy: true, has_workspace_id: true, table_exists: true }] }
        : { rows: [{ retention_policy: { agentRuns: 3 }, workspace_id: "ws-a" }, { retention_policy: {}, workspace_id: "ws-b" }] };
    };
    const saved = process.env.WORKSPACES_POSTGRES_TABLE;

    try {
      delete process.env.WORKSPACES_POSTGRES_TABLE;
      assert.deepEqual([...(await loadWorkspaceRetentionPolicies({ logger: silentLogger(), query }))], [
        ["ws-a", { agentRuns: 3 }],
      ], "an empty policy adds no override");
      assert.deepEqual(statements[0].values, ["rag_workspaces"]);
      assert.match(statements[1].text, /FROM rag_workspaces WHERE retention_policy IS NOT NULL/);

      process.env.WORKSPACES_POSTGRES_TABLE = "Tenant_Workspaces";
      statements.length = 0;
      await loadWorkspaceRetentionPolicies({ logger: silentLogger(), query });
      assert.deepEqual(statements[0].values, ["tenant_workspaces"], "WORKSPACES_POSTGRES_TABLE, folded like PostgreSQL folds it");
    } finally {
      if (saved === undefined) delete process.env.WORKSPACES_POSTGRES_TABLE;
      else process.env.WORKSPACES_POSTGRES_TABLE = saved;
    }

    const { createInMemoryTenantRegistryStore, createTenantRegistryService } = await import("../rag/tenant-registry.js");
    const registry = createTenantRegistryService({ cacheTtlMs: 0, store: createInMemoryTenantRegistryStore() });

    await registry.createWorkspace({ retentionPolicy: { agentRuns: 0, tasks: 5 }, workspaceId: "ws-a" });
    await registry.createWorkspace({ workspaceId: "ws-b" });

    assert.deepEqual([...(await loadWorkspaceRetentionPoliciesFromRegistry({ registry }))], [
      ["ws-a", { agentRuns: 0, tasks: 5 }],
    ]);
    assert.deepEqual(await loadWorkspaceRetentionPoliciesFromRegistry({ registry: null }), new Map());

    await assert.rejects(
      loadWorkspaceRetentionPoliciesFromRegistry({
        registry: { listWorkspaces: async () => { throw new Error("down"); } },
      }),
      (error) =>
        error.code === RETENTION_POLICIES_UNAVAILABLE_ERROR_CODE && /tenant registry.*down/.test(error.message)
    );
  });
});

describe("RAG observability files", () => {
  const withDirectory = async (callback) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "retention-observability-"));

    try {
      return await callback(directory);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  };

  test("segments sort before the live file and only their own pattern matches", () => {
    const segments = describeObservabilitySegments("/data/rag-observability/events.jsonl");
    const name = segments.segmentName(NOW);

    assert.match(name, /^events-20261017T120000000Z-[0-9a-f]{6}\.jsonl$/);
    assert.ok([name, "events.jsonl"].sort()[0] === name);
    assert.equal(segments.matchSegment(name), NOW);
    assert.ok(Number.isNaN(segments.matchSegment("events.jsonl")));
    assert.ok(Number.isNaN(segments.matchSegment("events-old.jsonl")));
    assert.ok(Number.isNaN(segments.matchSegment("other-20261017T120000000Z-abcdef.jsonl")));
  });

  test("the live file rotates once a day, and segments whose last write is older than the cutoff go", async () => {
    await withDirectory(async (directory) => {
      const eventsPath = path.join(directory, "events.jsonl");
      const segments = describeObservabilitySegments(eventsPath);

      // Nothing to do on an empty directory or an empty live file.
      assert.deepEqual(await pruneRagObservabilityFiles({ days: 30, eventsPath, now: NOW }), {
        deleted: 0,
        deletedBytes: 0,
        rotated: false,
      });
      await writeFile(eventsPath, "");
      assert.equal((await pruneRagObservabilityFiles({ days: 30, eventsPath, now: NOW })).rotated, false);

      await writeFile(eventsPath, '{"traceId":"a"}\n');
      const oldSegment = path.join(directory, segments.segmentName(NOW - 40 * DAY_MS));
      const keptSegment = path.join(directory, segments.segmentName(NOW - 3 * DAY_MS));
      const unrelated = path.join(directory, "events-manual-export.jsonl");

      await writeFile(oldSegment, '{"traceId":"old"}\n');
      await writeFile(keptSegment, '{"traceId":"kept"}\n');
      await writeFile(unrelated, '{"traceId":"mine"}\n');
      await utimes(oldSegment, new Date(NOW - 35 * DAY_MS), new Date(NOW - 35 * DAY_MS));
      await utimes(keptSegment, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS));
      await utimes(unrelated, new Date(NOW - 400 * DAY_MS), new Date(NOW - 400 * DAY_MS));

      const first = await pruneRagObservabilityFiles({ days: 30, eventsPath, now: NOW });

      assert.equal(first.rotated, true, "the newest segment is three days old");
      assert.equal(first.deleted, 1);
      assert.ok(first.deletedBytes > 0);

      const names = (await readdir(directory)).sort();

      assert.equal(names.includes("events.jsonl"), false, "appends start a new live file");
      assert.equal(names.includes(path.basename(oldSegment)), false);
      assert.ok(names.includes(path.basename(keptSegment)));
      assert.ok(names.includes("events-manual-export.jsonl"), "a file outside the pattern is never deleted");

      const rotated = names.find(
        (name) => name !== path.basename(keptSegment) && Number.isFinite(segments.matchSegment(name))
      );

      assert.equal(await readFile(path.join(directory, rotated), "utf8"), '{"traceId":"a"}\n');

      // Within a day of that rotation the live file stays where it is.
      await writeFile(eventsPath, '{"traceId":"b"}\n');
      const second = await pruneRagObservabilityFiles({ days: 30, eventsPath, now: NOW + 60_000 });

      assert.equal(second.rotated, false);
      assert.ok((await readdir(directory)).includes("events.jsonl"));

      const nextDay = await pruneRagObservabilityFiles({ days: 30, eventsPath, now: NOW + DAY_MS + 1 });

      assert.equal(nextDay.rotated, true);
    });
  });

  test("retention 0 touches nothing", async () => {
    await withDirectory(async (directory) => {
      const eventsPath = path.join(directory, "events.jsonl");

      await writeFile(eventsPath, "{}\n");
      assert.deepEqual(await pruneRagObservabilityFiles({ days: 0, eventsPath, now: NOW }), {
        deleted: 0,
        deletedBytes: 0,
        rotated: false,
      });
      assert.deepEqual(await readdir(directory), ["events.jsonl"]);
    });
  });
});

describe("the sweeper", () => {
  const target = (id, batches, { days = 30, envName = "X_RETENTION_DAYS" } = {}) => {
    const calls = [];
    const queue = [...batches];

    return {
      calls,
      target: {
        days,
        deleteBatch: async (options) => {
          calls.push({ context: getDatabaseTenantContext(), options });
          const next = queue.length > 0 ? queue.shift() : { acquired: true, deleted: 0 };

          if (next instanceof Error) {
            throw next;
          }

          return next;
        },
        envName,
        id,
      },
    };
  };

  test("repeats a type's batch until one comes back short, as system work, with the policies", async () => {
    const runs = target("agent_runs", [
      { acquired: true, deleted: 2, deletedEvents: 4 },
      { acquired: true, deleted: 2, deletedEvents: 1 },
      { acquired: true, deleted: 1, deletedEvents: 0 },
    ]);
    const logger = silentLogger();
    const sweeper = createRetentionSweeper({
      batchSize: 2,
      loadPolicies: async () => new Map([["ws-a", { agentRuns: 0 }]]),
      logger,
      now: () => NOW,
      targets: { database: [runs.target], observability: null },
    });
    const report = await sweeper.sweep();

    assert.deepEqual(report.agent_runs, {
      batches: 3,
      cutoff: daysAgo(30),
      deleted: 5,
      deletedEvents: 5,
      locked: false,
      more: false,
    });
    assert.equal(runs.calls.length, 3);
    assert.ok(runs.calls.every((call) => call.context === DATABASE_TENANT_CONTEXTS.system));
    assert.deepEqual(runs.calls[0].options, {
      cutoff: daysAgo(30),
      limit: 2,
      workspaceCutoffs: [{ cutoff: null, workspaceId: "ws-a" }],
    });
    assert.match(logger.lines.log.join("\n"), /agent_runs: deleted 5 \(and 5 events\) older than 30 days/);
  });

  test("a lost lock stops the type, a cap leaves the rest for the next sweep, one failure spares the others", async () => {
    const locked = target("tasks", [{ acquired: false, deleted: 0 }]);
    const capped = target("feedback", [
      { acquired: true, deleted: 1 },
      { acquired: true, deleted: 1 },
      { acquired: true, deleted: 1 },
    ]);
    const failing = target("agent_runs", [new Error("connection refused")]);
    const unsupported = target("workspace_artifacts", [null, null]);
    const logger = silentLogger();
    const sweeper = createRetentionSweeper({
      batchSize: 1,
      loadPolicies: async () => new Map(),
      logger,
      maxBatchesPerType: 2,
      now: () => NOW,
      targets: {
        database: [failing.target, locked.target, capped.target, unsupported.target],
        observability: null,
      },
    });
    const report = await sweeper.sweep();

    assert.match(report.agent_runs.error, /connection refused/);
    assert.equal(report.tasks.locked, true);
    assert.equal(locked.calls.length, 1);
    assert.equal(report.feedback.more, true);
    assert.equal(report.feedback.deleted, 2);
    assert.equal(report.workspace_artifacts, undefined);
    assert.match(logger.lines.warn.join("\n"), /workspace_artifacts: X_RETENTION_DAYS is set, but this process's store has no retention delete/);
    assert.match(logger.lines.log.join("\n"), /tasks: another instance holds this table's sweep/);
    assert.match(logger.lines.error.join("\n"), /agent_runs: sweep failed/);

    await sweeper.sweep();
    assert.equal(
      logger.lines.warn.filter((line) => line.includes("workspace_artifacts")).length,
      1,
      "the missing delete is reported once"
    );
  });

  test("policies that cannot be read stop every database delete for that sweep; the files are still swept and the next sweep retries", async () => {
    const runs = target("agent_runs", [{ acquired: true, deleted: 1 }]);
    const feedback = target("feedback", [{ acquired: true, deleted: 1 }]);
    const pruned = [];
    const logger = silentLogger();
    const reset = Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
    const loads = [
      () => {
        throw new RetentionPoliciesUnavailableError("workspace retention policies could not be read", { cause: reset });
      },
      () => {
        throw new Error("any other loader failure");
      },
      () => new Map([["legal", { agentRuns: 0 }]]),
    ];
    const sweeper = createRetentionSweeper({
      batchSize: 10,
      loadPolicies: async () => loads.shift()(),
      logger,
      now: () => NOW,
      pruneObservability: async (options) => {
        pruned.push(options.days);
        return { deleted: 0, deletedBytes: 0, rotated: false };
      },
      targets: {
        database: [runs.target, feedback.target],
        observability: { days: 7, id: RETENTION_DATA_TYPES.ragObservability },
      },
    });

    for (const expected of [/could not be read/, /any other loader failure/]) {
      const report = await sweeper.sweep();

      assert.equal(runs.calls.length, 0, "no global cutoff replaces a policy it could not read");
      assert.equal(feedback.calls.length, 0);
      assert.equal(report.agent_runs.skipped, RETENTION_SKIP_REASONS.policiesUnavailable);
      assert.match(report.agent_runs.error, expected);
      assert.equal(report.feedback.skipped, RETENTION_SKIP_REASONS.policiesUnavailable);
      assert.deepEqual(report.rag_observability, { deleted: 0, deletedBytes: 0, rotated: false });
      assert.match(logger.lines.error.at(-1), /nothing is deleted from agent_runs, feedback this sweep/);
    }

    assert.deepEqual(pruned, [7, 7], "the observability files carry no workspace and are swept either way");

    const report = await sweeper.sweep();

    assert.equal(report.agent_runs.deleted, 1);
    assert.deepEqual(runs.calls[0].options.workspaceCutoffs, [{ cutoff: null, workspaceId: "legal" }]);
    assert.equal(feedback.calls.length, 1);
  });

  test("start schedules the first sweep after a minute (or one interval), then one interval after each; stop ends it", async () => {
    const timers = [];
    const cleared = [];
    const runs = target("agent_runs", []);
    const sweeper = createRetentionSweeper({
      clearTimer: (timer) => cleared.push(timer),
      intervalMs: 3_600_000,
      loadPolicies: async () => new Map(),
      logger: silentLogger(),
      now: () => NOW,
      setTimer: (callback, wait) => {
        const timer = { callback, unref() {}, wait };

        timers.push(timer);
        return timer;
      },
      targets: { database: [runs.target], observability: null },
    });

    sweeper.start();
    sweeper.start();
    assert.equal(timers.length, 1, "start is idempotent");
    assert.equal(timers[0].wait, 60_000);

    timers[0].callback();
    await sweeper.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs.calls.length, 1);
    assert.equal(timers.length, 2);
    assert.equal(timers[1].wait, 3_600_000);

    await sweeper.stop();
    assert.deepEqual(cleared, [timers[1]]);
    assert.equal(sweeper.running, false);

    const short = createRetentionSweeper({
      intervalMs: 5_000,
      logger: silentLogger(),
      setTimer: (callback, wait) => {
        timers.push({ callback, wait });
        return { unref() {} };
      },
      targets: { database: [], observability: null },
    });

    short.start();
    assert.equal(timers.at(-1).wait, 5_000);
    await short.stop();
  });

  test("stop waits for the sweep in flight and no batch starts after it", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    const sweeper = createRetentionSweeper({
      batchSize: 1,
      loadPolicies: async () => new Map(),
      logger: silentLogger(),
      now: () => NOW,
      targets: {
        database: [
          {
            days: 30,
            deleteBatch: async () => {
              calls.push("batch");
              await gate;
              return { acquired: true, deleted: 1 };
            },
            envName: "X",
            id: "agent_runs",
          },
        ],
        observability: null,
      },
    });
    const sweeping = sweeper.sweep();

    await new Promise((resolve) => setImmediate(resolve));

    const stopped = sweeper.stop();

    release();
    await stopped;
    await sweeping;
    assert.deepEqual(calls, ["batch"], "a full batch would have asked for another");
  });

  test("the observability target is pruned with the sweep's time", async () => {
    const seen = [];
    const sweeper = createRetentionSweeper({
      eventsPath: "/tmp/never/events.jsonl",
      logger: silentLogger(),
      now: () => NOW,
      pruneObservability: async (options) => {
        seen.push(options);
        return { deleted: 2, deletedBytes: 10, rotated: true };
      },
      targets: { database: [], observability: { days: 7, id: "rag_observability" } },
    });

    assert.deepEqual((await sweeper.sweep()).rag_observability, { deleted: 2, deletedBytes: 10, rotated: true });
    assert.deepEqual(seen, [{ days: 7, eventsPath: "/tmp/never/events.jsonl", now: NOW }]);
  });
});

describe("which process sweeps what", () => {
  const services = {
    agentRunService: { deleteExpiredRuns: async () => ({ acquired: true, deleted: 0 }) },
    feedbackService: { deleteExpiredFeedback: async () => ({ acquired: true, deleted: 0 }) },
    taskService: { deleteExpiredTasks: async () => ({ acquired: true, deleted: 0 }) },
    workspaceArtifactService: { deleteExpiredArtifacts: async () => ({ acquired: true, deleted: 0 }) },
  };
  const allSet = {
    AGENT_RUN_RETENTION_DAYS: "30",
    FEEDBACK_RETENTION_DAYS: "60",
    RAG_OBSERVABILITY_RETENTION_DAYS: "7",
    TASK_RETENTION_DAYS: "30",
    WORKSPACE_ARTIFACT_RETENTION_DAYS: "90",
  };
  const ids = (targets) => [
    ...targets.database.map((entry) => `${entry.id}=${entry.days}`),
    ...(targets.observability ? [`${targets.observability.id}=${targets.observability.days}`] : []),
  ];

  test("the agent tier sweeps runs and tasks, the API tier feedback and artifacts, both the observability files", async () => {
    await withEnv(allSet, () => {
      assert.deepEqual(ids(resolveRetentionTargets({ hostsAgentTier: true, services })), [
        "agent_runs=30",
        "tasks=30",
        "rag_observability=7",
      ]);
      assert.deepEqual(ids(resolveRetentionTargets({ hostsApiTier: true, services })), [
        "workspace_artifacts=90",
        "feedback=60",
        "rag_observability=7",
      ]);
      assert.deepEqual(ids(resolveRetentionTargets({ hostsAgentTier: true, hostsApiTier: true, services })), [
        "agent_runs=30",
        "tasks=30",
        "workspace_artifacts=90",
        "feedback=60",
        "rag_observability=7",
      ]);
      assert.deepEqual(ids(resolveRetentionTargets({ services })), [], "a retrieval or gateway process sweeps nothing");
    });
  });

  test("TENANT_USAGE_RETENTION_DAYS: the API tier sweeps the usage ledger without reading workspace policies", async () => {
    await withEnv({ TENANT_USAGE_RETENTION_DAYS: "90" }, async () => {
      assert.deepEqual(ids(resolveRetentionTargets({ hostsApiTier: true, services })), ["tenant_usage=90"]);
      assert.deepEqual(ids(resolveRetentionTargets({ hostsAgentTier: true, services })), []);

      const calls = [];
      const targets = resolveRetentionTargets({
        hostsApiTier: true,
        services: {
          ...services,
          tenantUsageStore: {
            deleteExpired: async (options) => {
              calls.push({ context: getDatabaseTenantContext(), options });
              return { acquired: true, deleted: 1 };
            },
          },
        },
      });
      const sweeper = createRetentionSweeper({
        batchSize: 10,
        loadPolicies: async () => {
          throw new Error("the ledger needs no policies");
        },
        logger: silentLogger(),
        now: () => NOW,
        targets,
      });
      const report = await sweeper.sweep();

      assert.equal(report.tenant_usage.deleted, 1);
      assert.deepEqual(calls, [
        {
          context: DATABASE_TENANT_CONTEXTS.system,
          options: { cutoff: daysAgo(90), limit: 10, workspaceCutoffs: [] },
        },
      ]);

      // The module's own delete when nothing is injected.
      const [ledger] = resolveRetentionTargets({ hostsApiTier: true, services }).database;

      assert.equal(typeof ledger.deleteBatch, "function");
      assert.equal(ledger.workspacePolicies, false);
    });
  });

  test("by default nothing starts: no sweeper, no timer, no statement", async () => {
    await withEnv({}, () => {
      const logger = silentLogger();
      let timers = 0;

      assert.equal(
        startRetentionSweeper({
          hostsAgentTier: true,
          hostsApiTier: true,
          logger,
          services,
          setTimer: () => {
            timers += 1;
          },
        }),
        null
      );
      assert.equal(timers, 0);
      assert.deepEqual(logger.lines, { error: [], log: [], warn: [] });
    });
  });

  test("an interval of 0 starts nothing and says why; otherwise the sweeper starts and says what it sweeps", async () => {
    await withEnv({ ...allSet, RETENTION_SWEEP_INTERVAL_MS: "0" }, () => {
      const logger = silentLogger();

      assert.equal(startRetentionSweeper({ hostsAgentTier: true, logger, services }), null);
      assert.match(logger.lines.warn[0], /RETENTION_SWEEP_INTERVAL_MS is 0/);
    });

    await withEnv({ AGENT_RUN_RETENTION_DAYS: "30" }, async () => {
      const logger = silentLogger();
      const timers = [];
      const sweeper = startRetentionSweeper({
        hostsAgentTier: true,
        logger,
        services,
        setTimer: (callback, wait) => {
          timers.push(wait);
          return { unref() {} };
        },
      });

      assert.ok(sweeper);
      assert.equal(sweeper.running, true);
      assert.deepEqual(timers, [60_000]);
      assert.match(logger.lines.log[0], /sweeping every 3600000 ms: agent_runs=30d/);
      await sweeper.stop();
    });
  });

  test("end to end over the in-memory stores the app builds", async () => {
    await withEnv({ AGENT_RUN_RETENTION_DAYS: "30", TASK_RETENTION_DAYS: "30" }, async () => {
      let clock = NOW - 100 * DAY_MS;
      const agentRunStore = createInMemoryAgentRunStore({ now: () => new Date(clock).toISOString() });
      const taskStore = createInMemoryTaskStore();
      const appServices = {
        agentRunService: createAgentRunService({ agentRunStore }),
        taskService: createTaskService({ taskStore }),
      };

      await agentRunStore.createWithEvent({
        accessScope: ALICE,
        event: { payload: {}, type: "run_created" },
        run: { goal: "g", runId: "old", status: "completed" },
      });
      clock = NOW;
      await agentRunStore.createWithEvent({
        accessScope: ALICE,
        event: { payload: {}, type: "run_created" },
        run: { goal: "g", runId: "new", status: "completed" },
      });
      taskStore.upsert({
        accessScope: BOB,
        task: { id: "old-task", status: "failed", type: "agent", updatedAt: daysAgo(31) },
      });

      const sweeper = startRetentionSweeper({
        hostsAgentTier: true,
        logger: silentLogger(),
        now: () => NOW,
        services: appServices,
        setTimer: () => ({ unref() {} }),
      });
      const report = await sweeper.sweep();

      await sweeper.stop();
      assert.equal(report.agent_runs.deleted, 1);
      assert.equal(report.tasks.deleted, 1);
      assert.equal(agentRunStore.get({ accessScope: ALICE, runId: "old" }), null);
      assert.ok(agentRunStore.get({ accessScope: ALICE, runId: "new" }));
      assert.equal(taskStore.get({ accessScope: BOB, taskId: "old-task" }), null);
    });
  });

  test("without a database the app's in-memory tenant registry sets the workspace overrides", async () => {
    const savedUrl = process.env.POSTGRES_DATABASE_URL;

    delete process.env.POSTGRES_DATABASE_URL;

    try {
      await withEnv({ AGENT_RUN_RETENTION_DAYS: "30" }, async () => {
        const { createInMemoryTenantRegistryStore, createTenantRegistryService } = await import(
          "../rag/tenant-registry.js"
        );
        const agentRunStore = createInMemoryAgentRunStore({ now: () => daysAgo(100) });
        const tenantRegistry = createTenantRegistryService({ store: createInMemoryTenantRegistryStore() });

        // ws-a keeps its runs forever; ws-b has no policy, so 30 days apply.
        await tenantRegistry.createWorkspace({ retentionPolicy: { agentRuns: 0 }, workspaceId: ALICE.workspaceId });
        await tenantRegistry.createWorkspace({ workspaceId: BOB.workspaceId });

        for (const scope of [ALICE, BOB]) {
          await agentRunStore.createWithEvent({
            accessScope: scope,
            event: { payload: {}, type: "run_created" },
            run: { goal: "g", runId: `old-${scope.userId}`, status: "completed" },
          });
        }

        const sweeper = startRetentionSweeper({
          hostsAgentTier: true,
          logger: silentLogger(),
          now: () => NOW,
          services: { agentRunService: createAgentRunService({ agentRunStore }), tenantRegistry },
          setTimer: () => ({ unref() {} }),
        });
        const report = await sweeper.sweep();

        await sweeper.stop();
        assert.equal(report.agent_runs.deleted, 1);
        assert.ok(agentRunStore.get({ accessScope: ALICE, runId: "old-alice" }), "ws-a's policy keeps it");
        assert.equal(agentRunStore.get({ accessScope: BOB, runId: "old-bob" }), null);
      });
    } finally {
      if (savedUrl === undefined) delete process.env.POSTGRES_DATABASE_URL;
      else process.env.POSTGRES_DATABASE_URL = savedUrl;
    }
  });

  test("a registry that fails once deletes nothing in that sweep, so a keep-forever policy is never replaced by the global cutoff", async () => {
    const savedUrl = process.env.POSTGRES_DATABASE_URL;

    delete process.env.POSTGRES_DATABASE_URL;

    try {
      await withEnv({ AGENT_RUN_RETENTION_DAYS: "30" }, async () => {
        const { createInMemoryTenantRegistryStore, createTenantRegistryService } = await import(
          "../rag/tenant-registry.js"
        );
        const agentRunStore = createInMemoryAgentRunStore({ now: () => daysAgo(100) });
        const registry = createTenantRegistryService({ store: createInMemoryTenantRegistryStore() });
        let failures = 1;
        const flakyRegistry = {
          listWorkspaces: async (options) => {
            if (failures > 0) {
              failures -= 1;
              throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
            }

            return registry.listWorkspaces(options);
          },
        };

        await registry.createWorkspace({ retentionPolicy: { agentRuns: 0 }, workspaceId: ALICE.workspaceId });

        for (const scope of [ALICE, BOB]) {
          await agentRunStore.createWithEvent({
            accessScope: scope,
            event: { payload: {}, type: "run_created" },
            run: { goal: "g", runId: `old-${scope.userId}`, status: "completed" },
          });
        }

        const logger = silentLogger();
        const sweeper = startRetentionSweeper({
          hostsAgentTier: true,
          logger,
          now: () => NOW,
          services: { agentRunService: createAgentRunService({ agentRunStore }), tenantRegistry: flakyRegistry },
          setTimer: () => ({ unref() {} }),
        });
        const failed = await sweeper.sweep();

        assert.equal(failed.agent_runs.skipped, RETENTION_SKIP_REASONS.policiesUnavailable);
        assert.ok(agentRunStore.get({ accessScope: ALICE, runId: "old-alice" }), "the keep-forever workspace keeps its run");
        assert.ok(agentRunStore.get({ accessScope: BOB, runId: "old-bob" }), "nothing is deleted that sweep");
        assert.match(logger.lines.error.join("\n"), /ECONNRESET/);

        const retried = await sweeper.sweep();

        await sweeper.stop();
        assert.equal(retried.agent_runs.deleted, 1);
        assert.ok(agentRunStore.get({ accessScope: ALICE, runId: "old-alice" }));
        assert.equal(agentRunStore.get({ accessScope: BOB, runId: "old-bob" }), null);
      });
    } finally {
      if (savedUrl === undefined) delete process.env.POSTGRES_DATABASE_URL;
      else process.env.POSTGRES_DATABASE_URL = savedUrl;
    }
  });
});
