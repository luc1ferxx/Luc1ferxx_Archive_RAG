import test from "node:test";
import assert from "node:assert/strict";

import { recordLlmOpsMetric, LLMOPS_OPERATIONS } from "../rag/llmops-metrics.js";
import { MODEL_GATEWAY_MIRROR_ANNOTATION } from "../rag/model-gateway/protocol.js";
import {
  getDatabaseTenantContext,
  runAsDatabaseSystem,
  runWithDatabaseTenant,
} from "../rag/postgres-tenant.js";
import {
  buildTenantUsageUpsertSql,
  configureTenantUsageLedger,
  createTenantUsageLedger,
  createTenantUsageRecordStore,
  describeTenantModelUsage,
  listTenantUsageTop,
  recordTenantModelUsage,
  recordTenantModelUsageShares,
  runWithCallerAttributedModelUsage,
  TENANT_USAGE_METRICS,
  TENANT_USAGE_REFUSALS_METRIC,
} from "../rag/tenant-usage.js";
import { TENANT_REFUSAL_LEDGER_METRICS } from "../rag/tenant-refusal-reasons.js";
import * as config from "../rag/config.js";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 17, 10, 0, 0);

const withEnv = async (values, run) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// A ledger over a fake database: every statement and the context it ran in.
const createRecordingLedger = ({ fail = () => false, ...options } = {}) => {
  const statements = [];
  let clock = T0;
  const timers = [];
  const ledger = createTenantUsageLedger({
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    getFlushMs: () => 60_000,
    isDatabaseConfigured: () => true,
    isEnabled: () => true,
    logger: { error: () => {} },
    now: () => clock,
    query: async (text, values) => {
      const statement = { context: getDatabaseTenantContext(), text, values };

      statements.push(statement);

      if (fail(statement, statements.length)) {
        throw Object.assign(new Error("connection lost"), { code: "57P01" });
      }

      return { rows: [] };
    },
    setTimer: (callback, delay) => {
      const timer = { callback, cleared: false, delay, unref() {} };

      timers.push(timer);
      return timer;
    },
    ...options,
  });

  return {
    advance: (ms) => {
      clock += ms;
    },
    ledger,
    statements,
    timers,
  };
};

const rowsOf = (statement) =>
  statement.values[0].map((workspaceId, index) => ({
    metric: statement.values[2][index],
    periodStart: statement.values[3][index],
    userId: statement.values[1][index],
    value: statement.values[4][index],
    workspaceId,
  }));

test("the ledger aggregates per tenant, metric and UTC hour in memory and writes nothing until a flush", async () => {
  const { advance, ledger, statements, timers } = createRecordingLedger();
  const alice = { userId: "alice", workspaceId: "ws-a" };

  assert.equal(ledger.record(alice, { model_tokens: 100, model_cost_micro_usd: 12.6 }), true);
  ledger.record({ userId: " alice ", workspaceId: "ws-a" }, { model_tokens: 20 });
  ledger.record({ userId: "bob", workspaceId: "ws-b" }, { chat_requests: 1 });
  // Unknown metrics, zero, negative and non-numeric amounts are ignored.
  assert.equal(ledger.record(alice, { not_a_metric: 5, model_tokens: 0, documents: -1, ingested_bytes: "x" }), false);
  // Outside a tenant: the ('', '') row.
  ledger.record(null, { model_tokens: 3 });
  advance(HOUR);
  ledger.record(alice, { model_tokens: 7 });

  assert.equal(statements.length, 0, "recording never touches the database");
  assert.equal(timers.length, 1, "one flush timer, started by the first record");
  assert.equal(timers[0].delay, 60_000);
  assert.equal(ledger.snapshot().pendingEntries, 5);

  assert.deepEqual(await ledger.flush(), { rows: 5 });
  assert.equal(statements.length, 1);
  assert.equal(statements[0].context, "system", "the flush is system work");
  assert.equal(statements[0].text, buildTenantUsageUpsertSql("tenant_usage"));
  assert.match(statements[0].text, /ON CONFLICT \(workspace_id, owner_user_id, metric, period_start\)/);
  assert.match(statements[0].text, /value = tenant_usage\.value \+ EXCLUDED\.value/);
  // Sorted by the primary key, so concurrent flushes lock rows in one order.
  assert.deepEqual(rowsOf(statements[0]), [
    { metric: "model_tokens", periodStart: new Date(T0).toISOString(), userId: "", value: "3", workspaceId: "" },
    { metric: "model_cost_micro_usd", periodStart: new Date(T0).toISOString(), userId: "alice", value: "13", workspaceId: "ws-a" },
    { metric: "model_tokens", periodStart: new Date(T0).toISOString(), userId: "alice", value: "120", workspaceId: "ws-a" },
    { metric: "model_tokens", periodStart: new Date(T0 + HOUR).toISOString(), userId: "alice", value: "7", workspaceId: "ws-a" },
    { metric: "chat_requests", periodStart: new Date(T0).toISOString(), userId: "bob", value: "1", workspaceId: "ws-b" },
  ]);
  assert.equal(ledger.snapshot().pendingEntries, 0);
  assert.deepEqual(await ledger.flush(), { rows: 0 }, "nothing pending, no statement");
  assert.equal(statements.length, 1);
});

test("a flush inside a tenant request still runs as system work", async () => {
  const { ledger, statements } = createRecordingLedger();

  await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws-a" }, async () => {
    ledger.record({ userId: "alice", workspaceId: "ws-a" }, { chat_requests: 1 });
    await ledger.flush();
  });

  assert.equal(statements[0].context, "system");
});

test("a failed flush keeps its totals for the next one, and a partly written flush keeps only the rest", async () => {
  let failNext = true;
  const { ledger, statements } = createRecordingLedger({
    fail: () => {
      if (failNext) {
        failNext = false;
        return true;
      }

      return false;
    },
  });
  const alice = { userId: "alice", workspaceId: "ws-a" };

  ledger.record(alice, { model_tokens: 10 });
  assert.deepEqual(await ledger.flush(), { rows: 0 });
  assert.equal(ledger.snapshot().failedFlushes, 1);
  assert.equal(ledger.snapshot().pendingEntries, 1);
  // Recorded while the database was away: added to the kept total.
  ledger.record(alice, { model_tokens: 5 });
  assert.deepEqual(await ledger.flush(), { rows: 1 });
  assert.equal(rowsOf(statements[1])[0].value, "15");
  assert.equal(ledger.snapshot().lastFlushError, null);

  // 501 totals: two batches (500 + 1); the second fails and only it is kept.
  const partial = createRecordingLedger({ fail: (statement, index) => index === 2 });

  for (let index = 0; index < 501; index += 1) {
    partial.ledger.record({ userId: `user-${String(index).padStart(3, "0")}`, workspaceId: "ws" }, { documents: 1 });
  }

  assert.deepEqual(await partial.ledger.flush(), { rows: 500 });
  assert.equal(partial.statements[0].values[0].length, 500);
  assert.equal(partial.ledger.snapshot().pendingEntries, 1);
  assert.deepEqual(await partial.ledger.flush(), { rows: 1 });
  assert.equal(partial.statements.at(-1).values[1][0], "user-500");
});

test("the pending totals are bounded and new keys past the bound are counted as dropped", () => {
  const { ledger } = createRecordingLedger({ maxPendingEntries: 2 });

  ledger.record({ userId: "a" }, { documents: 1 });
  ledger.record({ userId: "b" }, { documents: 1 });
  assert.equal(ledger.record({ userId: "c" }, { documents: 1 }), false);
  // An existing key still grows.
  assert.equal(ledger.record({ userId: "a" }, { documents: 1 }), true);
  assert.equal(ledger.snapshot().droppedEntries, 1);
  assert.equal(ledger.snapshot().pendingEntries, 2);
});

test("without a database or with TENANT_USAGE_LEDGER=off the ledger keeps nothing and starts no timer", async () => {
  const offline = createRecordingLedger({ isDatabaseConfigured: () => false });

  assert.equal(offline.ledger.record({ userId: "a" }, { documents: 1 }), false);
  assert.equal(offline.timers.length, 0);
  await offline.ledger.stop();
  assert.equal(offline.statements.length, 0);

  const disabled = createRecordingLedger({ isEnabled: () => false });

  assert.equal(disabled.ledger.record({ userId: "a" }, { documents: 1 }), false);
  assert.equal(disabled.timers.length, 0);
});

test("TENANT_USAGE_LEDGER defaults on and only an off value turns it off; the flush interval defaults to 60 s", async () => {
  await withEnv({ TENANT_USAGE_LEDGER: undefined, TENANT_USAGE_FLUSH_MS: undefined }, () => {
    assert.equal(config.isTenantUsageLedgerEnabled(), true);
    assert.equal(config.getTenantUsageFlushMs(), 60_000);
    assert.equal(config.getTenantUsagePostgresTable(), "tenant_usage");
  });

  for (const value of ["off", "false", "0", "no", " OFF "]) {
    await withEnv({ TENANT_USAGE_LEDGER: value }, () => {
      assert.equal(config.isTenantUsageLedgerEnabled(), false, value);
    });
  }

  for (const value of ["on", "true", "", "   "]) {
    await withEnv({ TENANT_USAGE_LEDGER: value }, () => {
      assert.equal(config.isTenantUsageLedgerEnabled(), true, value);
    });
  }

  await withEnv({ TENANT_USAGE_FLUSH_MS: "5000", TENANT_USAGE_POSTGRES_TABLE: " usage_x " }, () => {
    assert.equal(config.getTenantUsageFlushMs(), 5000);
    assert.equal(config.getTenantUsagePostgresTable(), "usage_x");
  });
  await withEnv({ TENANT_USAGE_FLUSH_MS: "0" }, () => {
    assert.equal(config.getTenantUsageFlushMs(), 60_000, "0 is not an interval");
  });
});

test("stop clears the timer and writes what is pending", async () => {
  const { ledger, statements, timers } = createRecordingLedger();

  ledger.record({ userId: "alice", workspaceId: "ws-a" }, { chat_requests: 2 });
  await ledger.stop();

  assert.equal(timers[0].cleared, true);
  assert.equal(statements.length, 1);
  assert.equal(ledger.snapshot().timerRunning, false);
});

test("a successful model call charges its tokens and micro-USD cost to the active database tenant; mirrors and failures charge nothing", async () => {
  const { ledger } = createRecordingLedger();
  const okEvent = { estimatedCostUsd: 0.0012345, inputTokens: 40, outputTokens: 2, status: "ok", totalTokens: 42 };
  const pending = () => ledger.snapshot().pendingEntries;

  await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws-a" }, async () => {
    assert.equal(recordTenantModelUsage(okEvent, { ledger }), true);
    assert.equal(
      recordTenantModelUsage(
        { ...okEvent, annotations: [{ ...MODEL_GATEWAY_MIRROR_ANNOTATION }] },
        { ledger }
      ),
      false,
      "the gateway meters the call itself"
    );
    assert.equal(recordTenantModelUsage({ ...okEvent, status: "error" }, { ledger }), false);
    assert.equal(recordTenantModelUsage({ ...okEvent, status: "skipped" }, { ledger }), false);
  });

  assert.equal(pending(), 2);

  // Without totalTokens the input and output tokens are added.
  await runAsDatabaseSystem(async () => {
    recordTenantModelUsage({ inputTokens: 3, outputTokens: 4, status: "ok", totalTokens: null }, { ledger });
  });

  const statements = [];
  const reader = createTenantUsageLedger({
    isDatabaseConfigured: () => true,
    isEnabled: () => true,
    query: async (text, values) => {
      statements.push(values);
      return { rows: [] };
    },
    setTimer: () => null,
  });

  for (const [tenant, values] of [
    [{ userId: "alice", workspaceId: "ws-a" }, okEvent],
  ]) {
    await runWithDatabaseTenant(tenant, async () => recordTenantModelUsage(values, { ledger: reader }));
  }

  await reader.flush();
  assert.deepEqual(statements[0][2], ["model_cost_micro_usd", "model_tokens"]);
  assert.deepEqual(statements[0][4], ["1235", "42"]);
  assert.equal(pending(), 3);
});

test("a call whose usage its caller books per tenant is left out of the active tenant's totals", async () => {
  // The ingest batcher's merged requests run as no tenant's call; the
  // batcher records each tenant's share itself (ingest-embedding-batcher.js).
  const { ledger, statements } = createRecordingLedger();
  const okEvent = { estimatedCostUsd: 0.00003, status: "ok", totalTokens: 30 };

  await runAsDatabaseSystem(() =>
    runWithCallerAttributedModelUsage(async () => {
      assert.equal(recordTenantModelUsage(okEvent, { ledger }), false, "not booked under ('', '')");
      // An explicit tenant is still booked.
      assert.equal(recordTenantModelUsage(okEvent, { ledger, tenant: { userId: "carol", workspaceId: "ws-c" } }), true);
    })
  );
  // Outside the scope the active tenant is charged as before.
  await runAsDatabaseSystem(async () => assert.equal(recordTenantModelUsage(okEvent, { ledger }), true));

  const usage = describeTenantModelUsage(okEvent);

  assert.equal(usage.tokens, 30);
  assert.equal(Math.round(usage.costMicroUsd), 30);
  assert.equal(describeTenantModelUsage({ ...okEvent, status: "error" }), null);
  assert.equal(
    describeTenantModelUsage({ ...okEvent, annotations: [{ ...MODEL_GATEWAY_MIRROR_ANNOTATION }] }),
    null
  );
  assert.equal(
    recordTenantModelUsageShares(
      [
        { costMicroUsd: 20, tenant: { userId: "alice", workspaceId: "ws-a" }, tokens: 20 },
        { costMicroUsd: 10, tenant: null, tokens: 10 },
        { costMicroUsd: 0, tenant: { userId: "bob", workspaceId: "ws-b" }, tokens: 0 },
      ],
      { ledger }
    ),
    true
  );

  await ledger.flush();

  const totals = Object.fromEntries(
    rowsOf(statements[0]).map((row) => [`${row.workspaceId}/${row.userId}/${row.metric}`, row.value])
  );

  assert.deepEqual(totals, {
    "//model_cost_micro_usd": "40",
    "//model_tokens": "40",
    "ws-a/alice/model_cost_micro_usd": "20",
    "ws-a/alice/model_tokens": "20",
    "ws-c/carol/model_cost_micro_usd": "30",
    "ws-c/carol/model_tokens": "30",
  });
});

test("recordLlmOpsMetric feeds the process ledger with the normalized event, mirrors excluded", async () => {
  const values = [];
  const ledger = createTenantUsageLedger({
    isDatabaseConfigured: () => true,
    isEnabled: () => true,
    query: async (text, params) => {
      values.push(params);
      return { rows: [] };
    },
    setTimer: () => null,
  });

  configureTenantUsageLedger(ledger);

  try {
    await runWithDatabaseTenant({ userId: "carol", workspaceId: "ws-c" }, async () => {
      await recordLlmOpsMetric(
        {
          inputTokens: 10,
          operation: LLMOPS_OPERATIONS.completion,
          outputTokens: 5,
          status: "ok",
          totalTokens: 15,
        },
        { recorder: async () => {} }
      );
      await recordLlmOpsMetric(
        {
          annotations: [{ ...MODEL_GATEWAY_MIRROR_ANNOTATION }],
          operation: LLMOPS_OPERATIONS.completion,
          status: "ok",
          totalTokens: 999,
        },
        { recorder: async () => {} }
      );
    });
    await ledger.flush();
  } finally {
    configureTenantUsageLedger(null);
  }

  assert.equal(values.length, 1);
  assert.deepEqual(values[0][0], ["ws-c"]);
  assert.deepEqual(values[0][1], ["carol"]);
  assert.deepEqual(values[0][2], ["model_tokens"]);
  assert.deepEqual(values[0][4], ["15"]);
});

test("listTenantUsageTop reads one metric over whole hours, grouped by tenant or workspace", async () => {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ params, text });
    return {
      rows: [
        { owner_user_id: "bob", value: "500", workspace_id: "ws-b" },
        { owner_user_id: "alice", value: "200", workspace_id: "ws-a" },
      ],
    };
  };
  const result = await listTenantUsageTop({
    from: new Date(T0 + 25 * 60 * 1000),
    limit: 5,
    metric: TENANT_USAGE_METRICS.modelTokens,
    query,
    to: new Date(T0 + 3 * HOUR),
  });

  assert.equal(result.from, new Date(T0).toISOString(), "from is rounded down to its hour");
  assert.equal(result.to, new Date(T0 + 3 * HOUR).toISOString());
  assert.deepEqual(result.rows, [
    { userId: "bob", value: 500, workspaceId: "ws-b" },
    { userId: "alice", value: 200, workspaceId: "ws-a" },
  ]);
  assert.deepEqual(calls[0].params, [
    "model_tokens",
    new Date(T0).toISOString(),
    new Date(T0 + 3 * HOUR).toISOString(),
    null,
    5,
  ]);
  assert.match(calls[0].text, /GROUP BY workspace_id, owner_user_id/);
  assert.match(calls[0].text, /FROM tenant_usage/);

  const byWorkspace = await listTenantUsageTop({
    from: new Date(T0),
    groupBy: "workspace",
    limit: 1000,
    metric: TENANT_USAGE_METRICS.documents,
    query,
    to: new Date(T0 + HOUR),
    workspaceId: "ws-a",
  });

  assert.match(calls[1].text, /GROUP BY workspace_id\n/);
  assert.deepEqual(calls[1].params.slice(3), ["ws-a", 100], "the limit is capped at 100");
  assert.deepEqual(byWorkspace.rows[0], { value: 500, workspaceId: "ws-b" });

  await assert.rejects(
    listTenantUsageTop({ from: new Date(T0), metric: "tokens; DROP TABLE x", query, to: new Date(T0 + HOUR) }),
    (error) => error.status === 400
  );
});

// The tenant erase and export (rag/tenant-lifecycle.js): the ledger's rows of
// one tenant and this process's unflushed totals.
test("an erase drops the tenant's unflushed totals (after a flush in flight) and deletes its rows as the caller", async () => {
  let releaseFlush;
  const flushGate = new Promise((resolve) => {
    releaseFlush = resolve;
  });
  let failFlush = true;
  const { ledger } = createRecordingLedger({
    query: async () => {
      await flushGate;

      if (failFlush) {
        throw Object.assign(new Error("connection lost"), { code: "57P01" });
      }

      return { rows: [] };
    },
  });
  const acme = { userId: null, workspaceId: "acme" };
  const alice = { userId: "alice", workspaceId: "acme" };

  ledger.record({ userId: "alice", workspaceId: "acme" }, { chat_requests: 1, model_tokens: 10 });
  ledger.record({ userId: "bob", workspaceId: "acme" }, { chat_requests: 1 });
  ledger.record({ userId: "alice", workspaceId: "globex" }, { chat_requests: 1 });
  assert.equal(ledger.countPending(acme), 3);
  assert.equal(ledger.countPending(alice), 2);

  // A flush takes every total out of the pending map and fails: the erase
  // waits for it, so the totals it puts back are erased too.
  const flushing = ledger.flush();
  const erasing = ledger.erasePending(acme);

  releaseFlush();
  await flushing;
  assert.equal(await erasing, 3);
  assert.equal(ledger.countPending(acme), 0);
  assert.equal(ledger.countPending({ userId: null, workspaceId: "globex" }), 1);
  failFlush = false;

  // The table's rows: an exact pair clause, in whatever context the caller
  // bound (the erase binds the system), pages read as each tenant.
  const statements = [];
  const store = createTenantUsageRecordStore({
    getTable: () => "t_usage",
    isDatabaseConfigured: () => true,
    ledger,
    query: async (text, values = []) => {
      const sql = text.replace(/\s+/g, " ").trim();

      statements.push({ context: getDatabaseTenantContext(), sql, values });

      if (sql.startsWith("SELECT COUNT")) return { rows: [{ records: 4 }] };
      if (sql.startsWith("DELETE")) return { rowCount: 4 };
      if (sql.startsWith("SELECT DISTINCT")) return { rows: [{ user_id: "alice" }] };

      return {
        rows: [
          {
            metric: "chat_requests",
            owner_user_id: "alice",
            period_start: new Date(T0),
            updated_at: new Date(T0),
            value: "7",
            workspace_id: "acme",
          },
        ],
      };
    },
  });

  ledger.record({ userId: "alice", workspaceId: "acme" }, { chat_requests: 1 });
  assert.deepEqual(await runAsDatabaseSystem(() => store.countTenantRecords(alice)), {
    tenant_usage: { records: 4 },
    "tenant_usage:pending": { records: 1 },
  });
  assert.deepEqual(await runAsDatabaseSystem(() => store.deleteTenantRecords(alice)), {
    tenant_usage: { deleted: 4 },
    "tenant_usage:pending": { deleted: 1 },
  });
  assert.deepEqual(
    statements.map(({ context, sql, values }) => [context, sql, values]),
    [
      ["system", "SELECT COUNT(*)::int AS records FROM t_usage WHERE workspace_id = $1 AND owner_user_id = $2", ["acme", "alice"]],
      ["system", "DELETE FROM t_usage WHERE workspace_id = $1 AND owner_user_id = $2", ["acme", "alice"]],
    ]
  );

  statements.length = 0;
  const exported = [];

  for await (const entry of store.iterateTenantRecords(acme)) exported.push(entry);

  assert.deepEqual(exported, [
    {
      record: {
        metric: "chat_requests",
        periodStart: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
        userId: "alice",
        value: 7,
        workspaceId: "acme",
      },
      table: "tenant_usage",
    },
  ]);
  assert.match(statements.at(-1).sql, /^SELECT \* FROM t_usage WHERE workspace_id = \$1 AND owner_user_id = \$2 ORDER BY metric, period_start LIMIT \$3$/);
  assert.equal(statements.at(-1).context, "tenant");

  // Without a database the ledger keeps nothing: empty, and no statement.
  statements.length = 0;
  const offline = createTenantUsageRecordStore({ isDatabaseConfigured: () => false, ledger });

  assert.deepEqual(await offline.countTenantRecords(alice), {
    tenant_usage: { records: 0 },
    "tenant_usage:pending": { records: 0 },
  });
  assert.deepEqual(statements, []);
});

// Per-tenant refusals (rag/tenant-refusals.js): refused_<reason> rows of the
// same table, so the flush, the erase and the export need nothing new.
test("refusals are ledger rows per tenant, reason and hour; unknown reasons are ignored", async () => {
  const { ledger, statements } = createRecordingLedger();
  const alice = { userId: "alice", workspaceId: "ws-a" };

  assert.equal(ledger.recordRefusal(alice, "TENANT_RATE_LIMITED"), true);
  ledger.recordRefusal(alice, "TENANT_RATE_LIMITED");
  ledger.recordRefusal({ userId: "alice", workspaceId: "ws-b" }, "WORKSPACE_MEMBERSHIP_REQUIRED");
  ledger.recordRefusal(null, "TENANT_RATE_LIMITED");
  assert.equal(ledger.recordRefusal(alice, "NOT_A_REASON"), false);
  // A refused_<reason> metric can be recorded directly too, a made-up one cannot.
  assert.equal(ledger.record(alice, { refused_not_a_reason: 1 }), false);
  assert.equal(ledger.snapshot().pendingRefusalEntries, 3);

  assert.deepEqual(await ledger.flush(), { rows: 3 });
  assert.deepEqual(rowsOf(statements[0]), [
    { metric: "refused_tenant_rate_limited", periodStart: new Date(T0).toISOString(), userId: "", value: "1", workspaceId: "" },
    { metric: "refused_tenant_rate_limited", periodStart: new Date(T0).toISOString(), userId: "alice", value: "2", workspaceId: "ws-a" },
    {
      metric: "refused_workspace_membership_required",
      periodStart: new Date(T0).toISOString(),
      userId: "alice",
      value: "1",
      workspaceId: "ws-b",
    },
  ]);
  assert.equal(ledger.snapshot().pendingRefusalEntries, 0);
});

test("refusals hold a bounded share of the pending totals, so a flood cannot crowd out usage", () => {
  const { ledger } = createRecordingLedger({ maxPendingEntries: 4, maxPendingRefusalEntries: 2 });

  ledger.recordRefusal({ userId: "u", workspaceId: "probe-1" }, "WORKSPACE_MEMBERSHIP_REQUIRED");
  ledger.recordRefusal({ userId: "u", workspaceId: "probe-2" }, "WORKSPACE_MEMBERSHIP_REQUIRED");
  assert.equal(ledger.recordRefusal({ userId: "u", workspaceId: "probe-3" }, "WORKSPACE_MEMBERSHIP_REQUIRED"), false);
  // An existing refusal key still grows, and usage still has room.
  assert.equal(ledger.recordRefusal({ userId: "u", workspaceId: "probe-1" }, "WORKSPACE_MEMBERSHIP_REQUIRED"), true);
  assert.equal(ledger.record({ userId: "alice", workspaceId: "ws-a" }, { chat_requests: 1 }), true);
  assert.equal(ledger.record({ userId: "bob", workspaceId: "ws-b" }, { chat_requests: 1 }), true);

  const snapshot = ledger.snapshot();

  assert.equal(snapshot.droppedRefusalEntries, 1);
  assert.equal(snapshot.droppedEntries, 0);
  assert.equal(snapshot.pendingEntries, 4);
  assert.equal(snapshot.pendingRefusalEntries, 2);
});

test("a failed flush keeps its refusals for the next one; an erase drops a tenant's unflushed refusals", async () => {
  let fail = true;
  const { ledger, statements } = createRecordingLedger({ fail: () => fail });
  const alice = { userId: "alice", workspaceId: "ws-a" };

  ledger.recordRefusal(alice, "TENANT_STORAGE_QUOTA_EXCEEDED");
  ledger.recordRefusal({ userId: "bob", workspaceId: "ws-a" }, "TENANT_TASK_LIMITED");
  await ledger.flush();
  assert.equal(ledger.snapshot().pendingRefusalEntries, 2);

  assert.equal(ledger.countPending({ userId: null, workspaceId: "ws-a" }), 2);
  assert.equal(await ledger.erasePending({ userId: "alice", workspaceId: "ws-a" }), 1);
  assert.equal(ledger.snapshot().pendingRefusalEntries, 1);

  fail = false;
  await ledger.flush();
  assert.deepEqual(
    rowsOf(statements.at(-1)).map((row) => [row.userId, row.metric]),
    [["bob", "refused_tenant_task_limited"]]
  );
});

test("ids no row can store (too long, or holding U+0000) are dropped and counted instead of failing every flush", async () => {
  const { ledger, statements } = createRecordingLedger();

  assert.equal(
    ledger.recordRefusal({ userId: "u", workspaceId: "w".repeat(257) }, "WORKSPACE_MEMBERSHIP_REQUIRED"),
    false
  );
  assert.equal(ledger.record({ userId: "a\u0000b" }, { chat_requests: 1 }), false);
  assert.equal(ledger.record({ userId: "u", workspaceId: "w".repeat(256) }, { chat_requests: 1 }), true);
  assert.equal(ledger.snapshot().unstorableEntries, 2);
  assert.deepEqual(await ledger.flush(), { rows: 1 });
  assert.equal(statements.length, 1);
});

test("listTenantUsageTop with metric refusals ranks tenants by refusals with their counts per reason", async () => {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ params, text });
    return {
      rows: [
        {
          owner_user_id: "bob",
          reason_metrics: ["refused_tenant_rate_limited", "refused_workspace_membership_required"],
          reason_values: ["5", "2"],
          value: "7",
          workspace_id: "ws-b",
        },
      ],
    };
  };
  const result = await listTenantUsageTop({
    from: new Date(T0 + 10 * 60 * 1000),
    limit: 3,
    metric: TENANT_USAGE_REFUSALS_METRIC,
    query,
    to: new Date(T0 + 2 * HOUR),
  });

  assert.deepEqual(result.rows, [
    {
      refusals: { TENANT_RATE_LIMITED: 5, WORKSPACE_MEMBERSHIP_REQUIRED: 2 },
      userId: "bob",
      value: 7,
      workspaceId: "ws-b",
    },
  ]);
  assert.equal(result.from, new Date(T0).toISOString());
  assert.deepEqual(calls[0].params[0], [...TENANT_REFUSAL_LEDGER_METRICS]);
  assert.deepEqual(calls[0].params.slice(1), [new Date(T0).toISOString(), new Date(T0 + 2 * HOUR).toISOString(), null, 3]);
  assert.match(calls[0].text, /metric = ANY\(\$1::text\[\]\)/);
  assert.match(calls[0].text, /GROUP BY workspace_id, owner_user_id, metric/);

  // One reason, by workspace.
  await listTenantUsageTop({
    from: new Date(T0),
    groupBy: "workspace",
    metric: TENANT_USAGE_REFUSALS_METRIC,
    query,
    reason: "TENANT_RATE_LIMITED",
    to: new Date(T0 + HOUR),
    workspaceId: "ws-b",
  });
  assert.deepEqual(calls[1].params[0], ["refused_tenant_rate_limited"]);
  assert.equal(calls[1].params[3], "ws-b");
  assert.match(calls[1].text, /''::text AS owner_user_id/);
  assert.match(calls[1].text, /GROUP BY workspace_id, metric/);

  await assert.rejects(
    listTenantUsageTop({ from: new Date(T0), metric: "refusals", query, reason: "NOPE", to: new Date(T0 + HOUR) }),
    (error) => error.status === 400
  );
  await assert.rejects(
    listTenantUsageTop({
      from: new Date(T0),
      metric: "model_tokens",
      query,
      reason: "TENANT_RATE_LIMITED",
      to: new Date(T0 + HOUR),
    }),
    (error) => error.status === 400
  );
  assert.equal(calls.length, 2, "refused before any read");
});
