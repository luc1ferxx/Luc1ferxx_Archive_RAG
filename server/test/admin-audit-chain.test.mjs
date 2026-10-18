// Tamper evidence for admin audit events (migration 041): the hash chains
// both stores write and the verifier audit:verify runs. The PostgreSQL store
// runs here against a fake transactional database that models what the chain
// depends on (a per-key transaction lock, ids assigned at insert, rows visible
// at commit); test/admin-audit-chain.integration.test.mjs runs it against a
// real one.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ADMIN_AUDIT_CHAIN_BREAKS,
  buildAdminAuditChainPayload,
  canonicalizeAuditJson,
  computeAdminAuditRowHash,
  getAdminAuditChainLockKey,
  getAdminAuditChainOwner,
  resolveChainedCreatedAt,
  verifyAdminAuditChains,
} from "../rag/admin-audit-chain.js";
import {
  ADMIN_AUDIT_EVENT_TYPES,
  createAdminAuditService,
  createInMemoryAdminAuditStore,
} from "../rag/admin-audit.js";
import {
  ADMIN_AUDIT_CHAIN_ISOLATION_ERROR_CODE,
  ADMIN_AUDIT_CHAIN_MIGRATION_ID,
  createPostgresAdminAuditStore,
} from "../rag/postgres-admin-audit-store.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";

const TABLE = "rag_admin_audit_events_chain_test";

const recordDecision = (service, scope, allowed = true) =>
  service.recordAuthorizationDecision({
    accessScope: { authenticated: true, ...scope },
    actionId: "recover-tasks",
    decision: {
      allowed,
      permissionId: "admin.actions.recover_tasks",
      reason: allowed ? "allowed_by_role" : "denied_missing_permission",
      roleId: allowed ? "admin.operator" : "",
    },
    request: { method: "POST", path: "/admin/actions/recover-tasks", route: "/admin/actions/:action" },
  });

const createCountingClock = (start = Date.parse("2026-10-01T00:00:00.000Z")) => {
  let tick = 0;

  return () => new Date(start + 1000 * tick++).toISOString();
};

const createInMemoryHarness = () => {
  let eventIndex = 0;
  const store = createInMemoryAdminAuditStore({ maxEvents: 1000 });
  const service = createAdminAuditService({
    createEventId: () => `event-${++eventIndex}`,
    now: createCountingClock(),
    store,
  });

  return { service, store };
};

const recomputeRowHash = (row) => computeAdminAuditRowHash(row.prev_hash, row);

describe("canonical rows and hashes", () => {
  test("a JSON object hashes the same whatever order its keys come back in (JSONB reorders them)", () => {
    const row = {
      action_id: "recover-tasks",
      authorization_decision: { actionId: "recover-tasks", allowed: true, permissionId: "p", reason: "r", roleId: "" },
      created_at: "2026-10-01T00:00:00.000Z",
      event_id: "e-1",
      principal: { roleIds: ["admin.operator"], userId: "alice", workspaceId: "ws-a" },
      user_id: "alice",
      workspace_id: "ws-a",
    };
    const reordered = {
      ...row,
      authorization_decision: { roleId: "", reason: "r", permissionId: "p", allowed: true, actionId: "recover-tasks" },
      // node-pg reads timestamptz back as a Date; text JSON columns as strings.
      created_at: new Date(row.created_at),
      principal: JSON.stringify({ workspaceId: "ws-a", userId: "alice", roleIds: ["admin.operator"] }),
    };

    assert.equal(computeAdminAuditRowHash(null, row), computeAdminAuditRowHash(null, reordered));
    assert.equal(
      canonicalizeAuditJson({ b: [2, { d: 1, c: null }], a: "x", skipped: undefined }),
      '{"a":"x","b":[2,{"c":null,"d":1}]}'
    );
  });

  test("every stored column and the predecessor change the hash", () => {
    const row = buildAdminAuditChainPayload({ event_id: "e-1", user_id: "alice", workspace_id: "ws-a" });
    const base = computeAdminAuditRowHash(null, row);

    for (const [column, value] of Object.entries({
      action_id: "x",
      authorization_decision: { allowed: false },
      created_at: "2026-10-02T00:00:00.000Z",
      data_access: { count: 1 },
      event_id: "e-2",
      event_type: "data.access",
      method: "GET",
      path: "/documents/a/file",
      permission_id: "documents.read",
      principal: { userId: "bob" },
      request: { method: "GET" },
      result: "denied",
      route: "/documents/:docId/file",
      user_id: "bob",
      workspace_id: "ws-b",
    })) {
      assert.notEqual(computeAdminAuditRowHash(null, { ...row, [column]: value }), base, column);
    }

    assert.notEqual(computeAdminAuditRowHash("0".repeat(64), row), base, "the predecessor");
    assert.match(base, /^[0-9a-f]{64}$/);
  });

  test("details (migration 038) is covered only when the row has it, so every other row hashes as before", () => {
    const row = { event_id: "e-1", event_type: "admin.tenant.erased", user_id: "ops", workspace_id: "" };
    const withoutDetails = computeAdminAuditRowHash(null, row);
    const details = { counts: { documents: 1, workspaces: 1 }, outcome: "completed", tenant: { userId: null, workspaceId: "acme" } };

    assert.equal(computeAdminAuditRowHash(null, { ...row, details: null }), withoutDetails, "a NULL column");
    assert.equal(computeAdminAuditRowHash(null, { ...row, details: undefined }), withoutDetails);
    assert.equal(Object.hasOwn(buildAdminAuditChainPayload(row), "details"), false);

    const withDetails = computeAdminAuditRowHash(null, { ...row, details });

    assert.notEqual(withDetails, withoutDetails);
    // Read back as JSONB (keys reordered) or as text, it hashes the same.
    assert.equal(
      computeAdminAuditRowHash(null, { ...row, details: JSON.stringify({ tenant: details.tenant, outcome: "completed", counts: details.counts }) }),
      withDetails
    );
    assert.notEqual(
      computeAdminAuditRowHash(null, { ...row, details: { ...details, counts: { documents: 0, workspaces: 1 } } }),
      withDetails
    );
  });

  test("a chain is a workspace's events, or one user's without a workspace, and each chain has its own lock", () => {
    assert.deepEqual(getAdminAuditChainOwner({ userId: "alice", workspaceId: "ws-a" }), { userId: "", workspaceId: "ws-a" });
    assert.deepEqual(getAdminAuditChainOwner({ userId: "carol", workspaceId: "ws-a" }), { userId: "", workspaceId: "ws-a" });
    assert.deepEqual(getAdminAuditChainOwner({ userId: "dave", workspaceId: "" }), { userId: "dave", workspaceId: "" });
    assert.equal(
      getAdminAuditChainLockKey(TABLE, { userId: "alice", workspaceId: "ws-a" }),
      getAdminAuditChainLockKey(TABLE, { userId: "carol", workspaceId: "ws-a" })
    );
    assert.notEqual(
      getAdminAuditChainLockKey(TABLE, { userId: "dave", workspaceId: "" }),
      getAdminAuditChainLockKey(TABLE, { userId: "erin", workspaceId: "" })
    );
    // A workspace named like a user cannot share a user's chain.
    assert.notEqual(
      getAdminAuditChainLockKey(TABLE, { userId: "", workspaceId: "dave" }),
      getAdminAuditChainLockKey(TABLE, { userId: "dave", workspaceId: "" })
    );
  });

  test("a chain's time never goes backwards: an event older than its head takes the head's time", () => {
    assert.equal(
      resolveChainedCreatedAt({ createdAt: "2026-10-01T00:00:00.000Z", headCreatedAt: new Date("2026-10-01T00:00:05.000Z") }),
      "2026-10-01T00:00:05.000Z"
    );
    assert.equal(
      resolveChainedCreatedAt({ createdAt: "2026-10-01T00:00:09.000Z", headCreatedAt: "2026-10-01T00:00:05.000Z" }),
      "2026-10-01T00:00:09.000Z"
    );
    assert.equal(
      resolveChainedCreatedAt({ createdAt: "not a date", now: () => "2026-10-03T00:00:00.000Z" }),
      "2026-10-03T00:00:00.000Z"
    );
  });
});

describe("the in-memory store's chains and the verifier", () => {
  const seed = async () => {
    const harness = createInMemoryHarness();

    await recordDecision(harness.service, { userId: "alice", workspaceId: "ws-a" });
    await recordDecision(harness.service, { userId: "bob", workspaceId: "ws-b" });
    await recordDecision(harness.service, { userId: "carol", workspaceId: "ws-a" }, false);
    await recordDecision(harness.service, { userId: "dave", workspaceId: "" });
    await recordDecision(harness.service, { userId: "alice", workspaceId: "ws-a" });
    await recordDecision(harness.service, { userId: "erin", workspaceId: "" });
    await recordDecision(harness.service, { userId: "dave", workspaceId: "" });

    return { ...harness, rows: await harness.store.listChainRows() };
  };

  test("an untouched store verifies, with one chain per workspace and per workspace-less user", async () => {
    const { rows } = await seed();
    const report = verifyAdminAuditChains(rows);

    assert.equal(report.status, "ok");
    assert.equal(report.rowsScanned, 7);
    assert.equal(report.chainedRows, 7);
    assert.equal(report.legacyRows, 0);
    assert.deepEqual(
      report.chains.map((chain) => [chain.workspaceId, chain.userId, chain.rows, chain.startsAfterPurge]),
      [
        ["ws-a", "", 3, false],
        ["ws-b", "", 1, false],
        ["", "dave", 2, false],
        ["", "erin", 1, false],
      ]
    );

    // ws-a's chain spans alice and carol: each row names the one before it.
    const wsA = rows.filter((row) => row.workspace_id === "ws-a");

    assert.equal(wsA[0].prev_hash, null);
    assert.equal(wsA[1].prev_hash, wsA[0].row_hash);
    assert.equal(wsA[2].prev_hash, wsA[1].row_hash);
    assert.equal(report.chains[0].headHash, wsA[2].row_hash);
    rows.forEach((row) => assert.equal(recomputeRowHash(row), row.row_hash));
  });

  test("a modified row is reported at that row", async () => {
    const { rows } = await seed();
    const tampered = rows.map((row) => (row.id === 3 ? { ...row, result: "allowed" } : row));
    const report = verifyAdminAuditChains(tampered);
    const wsA = report.chains.find((chain) => chain.workspaceId === "ws-a");

    assert.equal(report.status, "broken");
    assert.equal(report.brokenChainCount, 1);
    assert.deepEqual(wsA.break, { eventId: "event-3", kind: ADMIN_AUDIT_CHAIN_BREAKS.rowHashMismatch, rowId: 3 });
    // The other chains still verify.
    assert.ok(report.chains.filter((chain) => chain !== wsA).every((chain) => chain.break === null));
  });

  test("a modified row whose hash was recomputed is reported at the next row of its chain", async () => {
    const { rows } = await seed();
    const tampered = rows.map((row) => {
      if (row.id !== 1) return row;

      const changed = { ...row, principal: { ...row.principal, userId: "mallory" } };

      return { ...changed, row_hash: recomputeRowHash(changed) };
    });
    const wsA = verifyAdminAuditChains(tampered).chains.find((chain) => chain.workspaceId === "ws-a");

    assert.deepEqual(wsA.break, { eventId: "event-3", kind: ADMIN_AUDIT_CHAIN_BREAKS.prevHashMismatch, rowId: 3 });
  });

  test("a deleted row is reported at the row after it", async () => {
    const { rows } = await seed();
    const report = verifyAdminAuditChains(rows.filter((row) => row.id !== 3));
    const wsA = report.chains.find((chain) => chain.workspaceId === "ws-a");

    assert.equal(report.status, "broken");
    assert.deepEqual(wsA.break, { eventId: "event-5", kind: ADMIN_AUDIT_CHAIN_BREAKS.prevHashMismatch, rowId: 5 });
  });

  test("two rows swapped between positions are reported", async () => {
    const { rows } = await seed();
    const dave = rows.filter((row) => row.user_id === "dave");
    // Rewrite the ids so the later row comes first.
    const swapped = rows.map((row) =>
      row.id === dave[0].id ? { ...dave[1], id: dave[0].id } : row.id === dave[1].id ? { ...dave[0], id: dave[1].id } : row
    );
    const daveChain = verifyAdminAuditChains(swapped).chains.find((chain) => chain.userId === "dave");

    assert.equal(daveChain.break.kind, ADMIN_AUDIT_CHAIN_BREAKS.prevHashMismatch);
  });

  test("rows removed from a chain's start (the retention purge) are not a break; the chain says it starts after a purge", async () => {
    const { rows } = await seed();
    const report = verifyAdminAuditChains(rows.filter((row) => row.id !== 1));
    const wsA = report.chains.find((chain) => chain.workspaceId === "ws-a");

    assert.equal(report.status, "ok");
    assert.equal(wsA.startsAfterPurge, true);
    assert.equal(wsA.firstId, 3);
  });

  test("rows from before migration 041 are legacy rows; an unhashed row after a chain started is a break", async () => {
    const { rows } = await seed();
    const legacy = [
      { event_id: "legacy-1", id: -2, prev_hash: null, row_hash: null, user_id: "alice", workspace_id: "ws-a" },
      { event_id: "legacy-2", id: -1, prev_hash: null, row_hash: null, user_id: "dave", workspace_id: "" },
    ];
    const withLegacy = verifyAdminAuditChains([...legacy, ...rows]);

    assert.equal(withLegacy.status, "ok");
    assert.equal(withLegacy.legacyRows, 2);
    assert.equal(withLegacy.chainedRows, 7);

    const injected = { event_id: "forged", id: 6.5, prev_hash: null, row_hash: null, user_id: "carol", workspace_id: "ws-a" };
    const withInjected = verifyAdminAuditChains(
      [...rows, injected].sort((left, right) => left.id - right.id)
    );
    const wsA = withInjected.chains.find((chain) => chain.workspaceId === "ws-a");

    assert.deepEqual(wsA.break, { eventId: "forged", kind: ADMIN_AUDIT_CHAIN_BREAKS.unchainedRow, rowId: 6.5 });
  });

  // A rolling upgrade: an instance still on code from before migration 041
  // inserts rows without hashes into chains a new instance already started.
  test("inside the upgrade window an unhashed row is an upgrade row, not a break, and the head stays the last hashed row", async () => {
    const { rows } = await seed();
    const upgradeWindowEndsAt = "2026-10-02T00:00:00Z";
    const oldReplicaRow = {
      ...rows[0],
      created_at: "2026-10-01T00:00:01.500Z",
      event_id: "old-replica",
      id: 1.5,
      prev_hash: null,
      row_hash: null,
    };
    const withUpgradeRow = [...rows, oldReplicaRow].sort((left, right) => left.id - right.id);
    const clean = verifyAdminAuditChains(rows, { upgradeWindowEndsAt });
    const report = verifyAdminAuditChains(withUpgradeRow, { upgradeWindowEndsAt });
    const wsA = report.chains.find((chain) => chain.workspaceId === "ws-a");

    assert.equal(report.status, "ok", JSON.stringify(report.chains));
    assert.equal(report.upgradeRows, 1);
    assert.equal(report.upgradeWindowEndsAt, "2026-10-02T00:00:00.000Z");
    assert.equal(report.chainedRows, 7, "an upgrade row is not a chained row");
    assert.deepEqual([wsA.rows, wsA.upgradeRows, wsA.headHash], [3, 1, clean.chains[0].headHash]);
    assert.equal(clean.upgradeRows, 0);

    // Without a window (the default) the same row is still a break.
    assert.deepEqual(
      verifyAdminAuditChains(withUpgradeRow).chains.find((chain) => chain.workspaceId === "ws-a").break,
      { eventId: "old-replica", kind: ADMIN_AUDIT_CHAIN_BREAKS.unchainedRow, rowId: 1.5 }
    );
  });

  test("the window never hides tampering with hashed rows, nor a row written after it", async () => {
    const { rows } = await seed();
    const wsAChain = (report) => report.chains.find((chain) => chain.workspaceId === "ws-a");
    const stripHashes = (id) => rows.map((row) => (row.id === id ? { ...row, prev_hash: null, row_hash: null } : row));
    const upgradeWindowEndsAt = "2026-10-02T00:00:00Z";

    // ws-a is rows 1, 3, 5. Removing a middle row's hashes leaves the next
    // row naming a predecessor the head is not.
    assert.deepEqual(wsAChain(verifyAdminAuditChains(stripHashes(3), { upgradeWindowEndsAt })).break, {
      eventId: "event-5",
      kind: ADMIN_AUDIT_CHAIN_BREAKS.prevHashMismatch,
      rowId: 5,
    });

    // Removing the last row's hashes moves the head back, which the head hash
    // kept from an earlier run shows (a chain's end is never visible otherwise).
    const clean = wsAChain(verifyAdminAuditChains(rows, { upgradeWindowEndsAt }));
    const stripped = wsAChain(verifyAdminAuditChains(stripHashes(5), { upgradeWindowEndsAt }));

    assert.equal(stripped.break, null);
    assert.notEqual(stripped.headHash, clean.headHash);

    // Rows 1 (00:00:00) and 3 (00:00:02) are inside a window ending at
    // 00:00:03; row 5 (00:00:04) is after it.
    const shortWindow = { upgradeWindowEndsAt: "2026-10-01T00:00:03.000Z" };
    const insert = (row) =>
      [...rows, { ...rows[0], prev_hash: null, row_hash: null, ...row }].sort((left, right) => left.id - right.id);

    // Written after the window ended.
    assert.equal(
      wsAChain(verifyAdminAuditChains(insert({ created_at: "2026-10-01T00:00:10.000Z", event_id: "late", id: 3.5 }), shortWindow)).break.kind,
      ADMIN_AUDIT_CHAIN_BREAKS.unchainedRow
    );
    // A time inside the window, but placed after a hashed row from after it:
    // the chain had moved past the window, so this is no upgrade row.
    assert.equal(
      wsAChain(verifyAdminAuditChains(insert({ created_at: "2026-10-01T00:00:01.000Z", event_id: "backdated", id: 6.5 }), shortWindow)).break.kind,
      ADMIN_AUDIT_CHAIN_BREAKS.unchainedRow
    );
    // Inside the window on both counts.
    assert.equal(
      verifyAdminAuditChains(insert({ created_at: "2026-10-01T00:00:02.500Z", event_id: "upgrade", id: 3.5 }), shortWindow).status,
      "ok"
    );
    // A row without a readable time is never an upgrade row.
    assert.equal(
      wsAChain(verifyAdminAuditChains(insert({ created_at: null, event_id: "timeless", id: 3.5 }), shortWindow)).break.kind,
      ADMIN_AUDIT_CHAIN_BREAKS.unchainedRow
    );
  });

  test("rows out of id order are refused rather than verified", () => {
    assert.throws(
      () => verifyAdminAuditChains([{ id: 2 }, { id: 1 }]),
      /ascending id order/
    );
  });

  test("events evicted from the bounded store shorten their chain's start and never fork it", async () => {
    let index = 0;
    const store = createInMemoryAdminAuditStore({ maxEvents: 3 });
    const service = createAdminAuditService({ createEventId: () => `e-${++index}`, now: createCountingClock(), store });

    for (let count = 0; count < 6; count += 1) {
      await recordDecision(service, { userId: "alice", workspaceId: "ws-a" });
    }

    const rows = await store.listChainRows();
    const report = verifyAdminAuditChains(rows);

    assert.deepEqual(rows.map((row) => row.id), [4, 5, 6]);
    assert.equal(report.status, "ok");
    assert.equal(report.chains[0].startsAfterPurge, true);
    assert.deepEqual(await store.listChainRows({ afterId: 4, limit: 1 }).then((page) => page.map((row) => row.id)), [5]);
  });
});

// A fake of what the PostgreSQL chain relies on: pg_advisory_xact_lock blocks
// until the holder's transaction ends, ids come from a sequence at INSERT, and
// a transaction's rows become visible to others at commit. `lock: false`
// ignores the lock, the control that shows the chain needs it.
const createFakeChainDatabase = ({ isolation = "read committed", lock = true } = {}) => {
  const committed = [];
  const lockQueues = new Map();
  const statements = [];
  let nextId = 1;

  const acquire = async (key) => {
    const previous = lockQueues.get(key) ?? Promise.resolve();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);

    lockQueues.set(key, tail);
    await previous;

    return () => {
      release();

      if (lockQueues.get(key) === tail) {
        lockQueues.delete(key);
      }
    };
  };

  const yieldToOthers = () => new Promise((resolve) => setImmediate(resolve));

  const insertRow = (values) => ({
    action_id: values[6],
    authorization_decision: JSON.parse(values[10]),
    created_at: new Date(values[13]),
    data_access: JSON.parse(values[14]),
    // Migration 038's nullable jsonb: NULL unless a lifecycle event wrote it.
    details: values[17] === null || values[17] === undefined ? null : JSON.parse(values[17]),
    event_id: values[0],
    event_type: values[1],
    id: String(nextId++),
    method: values[7],
    path: values[8],
    permission_id: values[5],
    prev_hash: values[15],
    principal: JSON.parse(values[11]),
    request: JSON.parse(values[12]),
    result: values[2],
    route: values[9],
    row_hash: values[16],
    user_id: values[3],
    workspace_id: values[4],
  });

  const transaction = async (callback) => {
    const releases = [];
    const pending = [];
    const client = {
      async query(text, values = []) {
        statements.push(
          text.includes("pg_advisory_xact_lock")
            ? "lock"
            : text.includes("transaction_isolation")
              ? "head"
              : text.includes("INSERT INTO")
                ? "insert"
                : "other"
        );

        if (text.includes("pg_advisory_xact_lock")) {
          if (lock) {
            releases.push(await acquire(values[0]));
          }

          return { rows: [{}] };
        }

        if (text.includes("current_setting('transaction_isolation')")) {
          // Give every other writer the chance to run between the lock and
          // the head read, as a real scheduler might.
          await yieldToOthers();

          const [workspaceId, userId] = values;
          const head = committed
            .filter(
              (row) => row.row_hash && row.workspace_id === workspaceId && (workspaceId !== "" || row.user_id === userId)
            )
            .at(-1);

          return { rows: [{ created_at: head?.created_at ?? null, isolation, row_hash: head?.row_hash ?? null }] };
        }

        if (text.includes(`INSERT INTO ${TABLE}`)) {
          await yieldToOthers();
          pending.push(insertRow(values));
          return { rowCount: 1, rows: [] };
        }

        throw new Error(`Unexpected statement: ${text}`);
      },
    };

    try {
      const result = await callback(client);

      await yieldToOthers();
      committed.push(...pending);
      committed.sort((left, right) => Number(left.id) - Number(right.id));
      return result;
    } finally {
      releases.forEach((release) => release());
    }
  };

  const query = async (text, values = []) => {
    if (text.includes(`DELETE FROM ${TABLE}`)) {
      return { rowCount: 0, rows: [] };
    }

    if (text.includes(`FROM ${TABLE}`) && text.includes("WHERE id > $1")) {
      const [afterId, limit, workspaceId] = values;

      return {
        rows: committed
          .filter((row) => Number(row.id) > afterId && (workspaceId === undefined || row.workspace_id === workspaceId))
          .slice(0, limit)
          .map((row) => ({
            ...row,
            data_access: JSON.stringify(row.data_access),
            details: row.details === null ? null : JSON.stringify(row.details),
          })),
      };
    }

    throw new Error(`Unexpected query: ${text}`);
  };

  return { committed, query, statements, transaction };
};

const createFakePostgresService = (database, { now } = {}) => {
  let index = 0;

  return createAdminAuditService({
    createEventId: () => `pg-${++index}`,
    now: now ?? createCountingClock(),
    store: createPostgresAdminAuditStore({
      query: database.query,
      retentionDays: 0,
      runMigrations: async () => {},
      tableName: TABLE,
      transaction: database.transaction,
    }),
  });
};

describe("the PostgreSQL store's chains", () => {
  test("each insert takes its chain's lock, reads the head, then inserts, in one transaction", async () => {
    const database = createFakeChainDatabase();
    const service = createFakePostgresService(database);

    await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws-a" }, () =>
      recordDecision(service, { userId: "alice", workspaceId: "ws-a" })
    );

    assert.deepEqual(database.statements, ["lock", "head", "insert"]);
    assert.equal(database.committed[0].prev_hash, null);
    assert.equal(database.committed[0].row_hash, computeAdminAuditRowHash(null, database.committed[0]));
  });

  test("concurrent inserts into one chain extend it one after another", async () => {
    const database = createFakeChainDatabase();
    const service = createFakePostgresService(database);
    const writers = [];

    for (let index = 0; index < 12; index += 1) {
      const scope = index % 3 === 2
        ? { userId: "dave", workspaceId: "" }
        : { userId: index % 2 ? "carol" : "alice", workspaceId: index % 4 === 3 ? "ws-b" : "ws-a" };

      writers.push(runWithDatabaseTenant(scope, () => recordDecision(service, scope)));
    }

    await Promise.all(writers);

    const report = verifyAdminAuditChains(database.committed);

    assert.equal(database.committed.length, 12);
    assert.equal(report.status, "ok", JSON.stringify(report.chains));
    assert.equal(report.chainedRows, 12);
    assert.ok(report.chains.length >= 2);
  });

  test("the control: without the lock, the same concurrent inserts fork the chain and the verifier sees it", async () => {
    const database = createFakeChainDatabase({ lock: false });
    const service = createFakePostgresService(database);
    const scope = { userId: "alice", workspaceId: "ws-a" };

    await Promise.all(
      Array.from({ length: 6 }, () => runWithDatabaseTenant(scope, () => recordDecision(service, scope)))
    );

    const report = verifyAdminAuditChains(database.committed);

    assert.equal(report.status, "broken");
    assert.equal(report.chains[0].break.kind, ADMIN_AUDIT_CHAIN_BREAKS.prevHashMismatch);
  });

  test("the owner columns are the bound tenant's, and the stored time follows the chain head", async () => {
    const database = createFakeChainDatabase();
    const times = ["2026-10-01T00:00:10.000Z", "2026-10-01T00:00:05.000Z"];
    const service = createFakePostgresService(database, { now: () => times.shift() });
    const tenant = { userId: "erin", workspaceId: "ws\tspaced" };

    await runWithDatabaseTenant(tenant, () => recordDecision(service, tenant));
    // An instance whose clock lags writes an older time after a newer one.
    await runWithDatabaseTenant(tenant, () => recordDecision(service, tenant));

    assert.deepEqual(
      database.committed.map((row) => [row.workspace_id, row.principal.workspaceId, row.created_at.toISOString()]),
      [
        ["ws\tspaced", "ws spaced", "2026-10-01T00:00:10.000Z"],
        ["ws\tspaced", "ws spaced", "2026-10-01T00:00:10.000Z"],
      ]
    );
    assert.equal(verifyAdminAuditChains(database.committed).status, "ok");
  });

  test("a data event's ids are stored in data_access and covered by the hash", async () => {
    const database = createFakeChainDatabase();
    const service = createFakePostgresService(database);
    const scope = { userId: "alice", workspaceId: "ws-a" };

    await runWithDatabaseTenant(scope, () =>
      service.recordDataAccess({
        accessScope: scope,
        actionId: "document.delete",
        count: 1,
        outcome: "succeeded",
        resourceIds: ["doc-1"],
        status: 200,
      })
    );

    const [row] = database.committed;

    assert.equal(row.event_type, ADMIN_AUDIT_EVENT_TYPES.dataAccess);
    assert.equal(row.action_id, "document.delete");
    assert.equal(row.permission_id, "documents.delete");
    assert.deepEqual(row.data_access.resourceIds, ["doc-1"]);
    assert.equal(computeAdminAuditRowHash(null, row), row.row_hash);
    assert.notEqual(
      computeAdminAuditRowHash(null, { ...row, data_access: { ...row.data_access, resourceIds: ["doc-2"] } }),
      row.row_hash
    );
  });

  test("a transaction that is not READ COMMITTED refuses the write instead of risking a fork", async () => {
    const database = createFakeChainDatabase({ isolation: "repeatable read" });
    const service = createFakePostgresService(database);

    await assert.rejects(
      recordDecision(service, { userId: "alice", workspaceId: "ws-a" }),
      (error) => error.code === ADMIN_AUDIT_CHAIN_ISOLATION_ERROR_CODE
    );
    assert.equal(database.committed.length, 0);
  });

  test("listChainRows pages in id order and filters one workspace", async () => {
    const database = createFakeChainDatabase();
    const service = createFakePostgresService(database);
    const store = createPostgresAdminAuditStore({
      query: database.query,
      runMigrations: async () => {},
      tableName: TABLE,
      transaction: database.transaction,
    });

    for (const scope of [
      { userId: "alice", workspaceId: "ws-a" },
      { userId: "bob", workspaceId: "ws-b" },
      { userId: "alice", workspaceId: "ws-a" },
    ]) {
      await runWithDatabaseTenant(scope, () => recordDecision(service, scope));
    }

    const page = await store.listChainRows({ afterId: 1, limit: 1 });
    const wsA = await store.listChainRows({ workspaceId: "ws-a" });

    assert.deepEqual(page.map((row) => row.id), [2]);
    assert.equal(typeof page[0].data_access, "object", "JSON columns are parsed");
    assert.deepEqual(wsA.map((row) => row.id), [1, 3]);
    assert.equal(verifyAdminAuditChains(wsA).status, "ok");
  });

  test("readChainActivation is the time migration 041 ran, read on the owner login; anything else is unknown", async () => {
    const calls = [];
    const createStore = (answer) =>
      createPostgresAdminAuditStore({
        ownerQuery: async (text, values) => {
          calls.push({ text: text.replace(/\s+/g, " ").trim(), values });
          return answer();
        },
        query: async () => assert.fail("the activation is not read on the runtime login"),
        runMigrations: async () => {},
        tableName: TABLE,
        transaction: async () => assert.fail("no transaction"),
      });

    assert.equal(
      await createStore(() => ({ rows: [{ applied_at: new Date("2026-10-16T08:00:00.000Z") }] })).readChainActivation(),
      "2026-10-16T08:00:00.000Z"
    );
    assert.deepEqual(calls[0], {
      text: "SELECT applied_at FROM schema_migrations WHERE id = $1",
      values: [ADMIN_AUDIT_CHAIN_MIGRATION_ID],
    });
    assert.equal(await createStore(() => ({ rows: [] })).readChainActivation(), "");
    assert.equal(
      await createStore(() => {
        throw Object.assign(new Error("permission denied for table schema_migrations"), { code: "42501" });
      }).readChainActivation(),
      ""
    );

    // The id is the migration file's name, as the migrator records it.
    const { readdir } = await import("node:fs/promises");
    const migrations = await readdir(new URL("../db/migrations/", import.meta.url));

    assert.ok(migrations.includes(ADMIN_AUDIT_CHAIN_MIGRATION_ID));
  });
});

// The tombstone a tenant erase leaves (rag/tenant-lifecycle.js) is the one
// event type that fills `details` (migration 038). It goes through the same
// chained insert as every other event, and audit:verify recomputes its hash
// with `details`, so changing or clearing them is a break.
describe("a tenant erase's tombstone in the chain", () => {
  const quiet = {
    countTenantRecords: async () => ({ tasks: { active: 0, records: 2 } }),
    deleteTenantRecords: async () => ({ tasks: { deleted: 2 } }),
    listTenantRecords: async () => [],
  };

  const eraseThrough = async (adminAuditService) => {
    const { createTenantLifecycleService } = await import("../rag/tenant-lifecycle.js");
    const service = createTenantLifecycleService({
      adminAuditService,
      agentRunStore: quiet,
      claimJudge: null,
      documents: null,
      feedbackStore: quiet,
      ingestJobStore: quiet,
      logger: { error() {} },
      longMemory: () => ({ status: "not_configured", store: null }),
      semanticCache: null,
      sessionMemory: () => ({ status: "not_configured", store: null }),
      taskStore: quiet,
      tenantRegistry: null,
      tenantUsageStore: quiet,
      workspaceArtifactStore: quiet,
    });

    return service.eraseTenant({
      actor: { authenticated: true, roleIds: ["admin.owner"], userId: "ops", workspaceId: "" },
      dryRun: false,
      permissionId: "admin.tenants.erase",
      request: { method: "POST", path: "/admin/tenants/erase", route: "/admin/tenants/erase" },
      userId: "alice",
      workspaceId: "acme",
    });
  };

  const assertTombstoneVerifies = (rows) => {
    const tombstone = rows.find((row) => row.event_type === ADMIN_AUDIT_EVENT_TYPES.tenantErased);

    assert.ok(tombstone, "the tombstone was chained");
    assert.deepEqual(tombstone.details.tenant, { userId: "alice", workspaceId: "acme" });
    assert.equal(tombstone.details.counts.tasks, 2);
    assert.equal(verifyAdminAuditChains(rows).status, "ok");

    for (const tampered of [
      { ...tombstone, details: { ...tombstone.details, counts: { ...tombstone.details.counts, tasks: 0 } } },
      { ...tombstone, details: { ...tombstone.details, tenant: { userId: "bob", workspaceId: "acme" } } },
      { ...tombstone, details: null },
    ]) {
      const report = verifyAdminAuditChains(rows.map((row) => (row.id === tombstone.id ? tampered : row)));
      const chain = report.chains.find((entry) => entry.userId === "ops");

      assert.equal(report.status, "broken");
      assert.deepEqual(chain.break, {
        eventId: tombstone.event_id,
        kind: ADMIN_AUDIT_CHAIN_BREAKS.rowHashMismatch,
        rowId: Number(tombstone.id),
      });
    }

    // A details block added to a row that had none breaks it too.
    const plain = rows.find((row) => row.event_type !== ADMIN_AUDIT_EVENT_TYPES.tenantErased);

    if (plain) {
      const report = verifyAdminAuditChains(
        rows.map((row) => (row.id === plain.id ? { ...row, details: { outcome: "completed" } } : row))
      );

      assert.equal(report.status, "broken");
    }
  };

  test("through the in-memory store", async () => {
    const { service } = createInMemoryHarness();

    // An event before it in the operator's own chain.
    await recordDecision(service, { userId: "ops", workspaceId: "" });

    const result = await eraseThrough(service);

    assert.equal(result.tombstoneRecorded, true);
    assertTombstoneVerifies(await service.listChainRows());
  });

  test("through the PostgreSQL store's chained insert, read back by listChainRows as audit:verify reads it", async () => {
    const database = createFakeChainDatabase();
    const service = createFakePostgresService(database);
    const store = createPostgresAdminAuditStore({
      query: database.query,
      runMigrations: async () => {},
      tableName: TABLE,
      transaction: database.transaction,
    });

    await runWithDatabaseTenant({ userId: "ops", workspaceId: "" }, () =>
      recordDecision(service, { userId: "ops", workspaceId: "" })
    );

    const result = await eraseThrough(service);

    assert.equal(result.tombstoneRecorded, true);
    // The erase runs as the system, so the tombstone's owner columns are the
    // operator's own ids, in the operator's chain.
    assert.equal(database.committed.at(-1).user_id, "ops");
    assert.equal(database.committed.at(-1).workspace_id, "");
    assert.equal(database.statements.filter((statement) => statement === "insert").length, 2);

    const rows = await store.listChainRows();

    assert.equal(typeof rows.at(-1).details, "object", "details is parsed like the other JSON columns");
    assertTombstoneVerifies(rows);
  });
});
