// `npm run audit:verify` (audit-verify.mjs): argument parsing, paging through
// a store's chain rows, the report and its exit status. The store is injected
// (an in-memory audit store, or one whose rows were tampered with); the
// PostgreSQL run is in test/admin-audit-chain.integration.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAuditVerifyReport,
  parseAuditVerifyArgs,
  runAuditVerifyCommand,
  USAGE,
  verifyAdminAuditStoreChains,
} from "../audit-verify.mjs";
import {
  createAdminAuditService,
  createInMemoryAdminAuditStore,
} from "../rag/admin-audit.js";
import { createPostgresAdminAuditStore } from "../rag/postgres-admin-audit-store.js";
import { getDatabaseTenantContext } from "../rag/postgres-tenant.js";

const seedStore = async () => {
  let index = 0;
  let tick = 0;
  const store = createInMemoryAdminAuditStore({ maxEvents: 100 });
  const service = createAdminAuditService({
    createEventId: () => `event-${++index}`,
    now: () => new Date(Date.parse("2026-10-01T00:00:00.000Z") + 1000 * tick++).toISOString(),
    store,
  });

  for (const scope of [
    { userId: "alice", workspaceId: "ws-a" },
    { userId: "bob", workspaceId: "ws-b" },
    { userId: "carol", workspaceId: "ws-a" },
    { userId: "dave", workspaceId: "" },
    { userId: "alice", workspaceId: "ws-a" },
  ]) {
    await service.recordAuthorizationDecision({
      accessScope: { authenticated: true, ...scope },
      decision: { allowed: true, permissionId: "admin.status.read", reason: "allowed_by_role", roleId: "admin.viewer" },
      request: { method: "GET", path: "/admin/status", route: "/admin/status" },
    });
  }

  return store;
};

// A store over fixed rows, recording every page request.
const createRowStore = (rows, { table = "rag_admin_audit_events" } = {}) => {
  const pages = [];

  return {
    describe: () => ({ table }),
    async listChainRows({ afterId = 0, limit = 1000, workspaceId = "" } = {}) {
      pages.push({ afterId, limit, workspaceId });

      return rows
        .filter((row) => row.id > afterId && (!workspaceId || row.workspace_id === workspaceId))
        .slice(0, limit);
    },
    pages,
  };
};

test("arguments: --json, --workspace, --page-size and --help; anything else is refused", () => {
  assert.deepEqual(parseAuditVerifyArgs([]), {
    help: false,
    json: false,
    pageSize: 1000,
    upgradeGraceHours: 24,
    upgradeWindowEnd: "",
    workspaceId: "",
  });
  assert.deepEqual(parseAuditVerifyArgs(["--json", "--workspace", "ws-a", "--page-size=50"]), {
    help: false,
    json: true,
    pageSize: 50,
    upgradeGraceHours: 24,
    upgradeWindowEnd: "",
    workspaceId: "ws-a",
  });
  assert.equal(parseAuditVerifyArgs(["--upgrade-grace-hours", "0"]).upgradeGraceHours, 0);
  assert.equal(parseAuditVerifyArgs(["--upgrade-grace-hours=1.5"]).upgradeGraceHours, 1.5);
  assert.equal(
    parseAuditVerifyArgs(["--upgrade-window-end", "2026-10-02T03:04:05+02:00"]).upgradeWindowEnd,
    "2026-10-02T01:04:05.000Z"
  );
  assert.throws(() => parseAuditVerifyArgs(["--upgrade-grace-hours", "-1"]), /--upgrade-grace-hours must be a number/);
  assert.throws(() => parseAuditVerifyArgs(["--upgrade-grace-hours", "soon"]), /--upgrade-grace-hours must be a number/);
  assert.throws(() => parseAuditVerifyArgs(["--upgrade-window-end", "yesterday"]), /--upgrade-window-end must be a time/);
  assert.equal(parseAuditVerifyArgs(["-h"]).help, true);
  assert.throws(() => parseAuditVerifyArgs(["--workspace"]), /--workspace needs a value/);
  assert.throws(() => parseAuditVerifyArgs(["--page-size", "0"]), /--page-size must be an integer/);
  assert.throws(() => parseAuditVerifyArgs(["--page-size", "10001"]), /--page-size must be an integer/);
  assert.throws(() => parseAuditVerifyArgs(["--apply"]), /Unknown argument: --apply/);
});

test("it pages through the rows in id order and verifies every chain", async () => {
  const rows = await (await seedStore()).listChainRows();
  const store = createRowStore(rows);
  const report = await verifyAdminAuditStoreChains(store, { pageSize: 2 });

  assert.equal(report.status, "ok");
  assert.equal(report.rowsScanned, 5);
  assert.deepEqual(
    store.pages.map((page) => page.afterId),
    [0, 2, 4],
    "each page starts after the last id of the one before"
  );
});

test("the command runs as the system, prints an OK summary, and returns the report", async () => {
  const store = await seedStore();
  let output = "";
  const contexts = [];
  const result = await runAuditVerifyCommand([], {
    createStore: () => ({
      describe: () => ({ table: "rag_admin_audit_events" }),
      listChainRows: (options) => {
        contexts.push(getDatabaseTenantContext());
        return store.listChainRows(options);
      },
    }),
    isConfigured: () => true,
    write: (text) => {
      output += text;
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.table, "rag_admin_audit_events");
  assert.deepEqual([...new Set(contexts)], ["system"]);
  assert.match(output, /rag_admin_audit_events: 5 row\(s\), 3 chain\(s\), 5 chained row\(s\), 0 row\(s\) from before migration 041\./);
  assert.match(output, /OK: every chain verifies\./);
});

test("a tampered row is reported with its chain, row and kind; --json carries every chain's head hash", async () => {
  const rows = await (await seedStore()).listChainRows();
  const tampered = rows.map((row) => (row.id === 3 ? { ...row, permission_id: "admin.owner" } : row));
  let text = "";
  let json = "";
  const result = await runAuditVerifyCommand([], {
    createStore: () => createRowStore(tampered),
    isConfigured: () => true,
    write: (chunk) => {
      text += chunk;
    },
  });

  assert.equal(result.status, "broken");
  assert.match(text, /BROKEN: 1 of 3 chain\(s\)\./);
  assert.match(text, /workspace "ws-a": row 3 \(event "event-3"\) no longer matches its hash.*\[row_hash_mismatch\]/);

  await runAuditVerifyCommand(["--json"], {
    createStore: () => createRowStore(rows.filter((row) => row.id !== 3)),
    isConfigured: () => true,
    write: (chunk) => {
      json += chunk;
    },
  });

  const parsed = JSON.parse(json);
  const wsA = parsed.chains.find((chain) => chain.workspaceId === "ws-a");

  assert.equal(parsed.status, "broken");
  assert.equal(wsA.break.kind, "prev_hash_mismatch");
  assert.equal(wsA.break.rowId, 5);
  assert.ok(parsed.chains.every((chain) => typeof chain.headHash === "string" && chain.headHash.length === 64));
});

test("a tenant lifecycle event's details are verified: the tombstone passes, changed details are a break", async () => {
  const store = await seedStore();
  const service = createAdminAuditService({ createEventId: () => "tombstone-1", store });

  await service.recordTenantLifecycleEvent({
    accessScope: { authenticated: true, userId: "dave", workspaceId: "" },
    actionId: "tenant.erase",
    details: { counts: { documents: 3, workspaces: 1 }, outcome: "completed", tenant: { userId: null, workspaceId: "ws-b" } },
    permissionId: "admin.tenants.erase",
    reason: "tenant_erase_completed",
    request: { method: "POST", path: "/admin/tenants/erase" },
  });

  const rows = await store.listChainRows();
  const tombstone = rows.find((row) => row.event_id === "tombstone-1");
  const run = async (chainRows) => {
    let text = "";
    const result = await runAuditVerifyCommand([], {
      createStore: () => createRowStore(chainRows),
      isConfigured: () => true,
      write: (chunk) => {
        text += chunk;
      },
    });

    return { result, text };
  };

  assert.deepEqual(tombstone.details.counts, { documents: 3, workspaces: 1 });
  assert.equal((await run(rows)).result.status, "ok");

  const changed = await run(
    rows.map((row) =>
      row === tombstone ? { ...row, details: { ...row.details, counts: { documents: 0, workspaces: 1 } } } : row
    )
  );

  assert.equal(changed.result.status, "broken");
  assert.match(changed.text, /user "dave".*event "tombstone-1".*\[row_hash_mismatch\]/);
  assert.equal(
    (await run(rows.map((row) => (row === tombstone ? { ...row, details: null } : row)))).result.status,
    "broken",
    "clearing them too"
  );
});

test("--workspace verifies only that workspace's chain", async () => {
  const rows = await (await seedStore()).listChainRows();
  const store = createRowStore(rows);
  const result = await runAuditVerifyCommand(["--workspace", "ws-a"], {
    createStore: () => store,
    isConfigured: () => true,
    write: () => {},
  });

  assert.equal(result.status, "ok");
  assert.equal(result.workspaceId, "ws-a");
  assert.deepEqual(result.chains.map((chain) => chain.workspaceId), ["ws-a"]);
  assert.equal(store.pages[0].workspaceId, "ws-a");
});

test("a chain that starts after purged rows is reported as such, not as broken", () => {
  const output = formatAuditVerifyReport({
    brokenChainCount: 0,
    chainCount: 1,
    chainedRows: 2,
    chains: [{ break: null, startsAfterPurge: true, userId: "", workspaceId: "ws-a" }],
    legacyRows: 0,
    rowsScanned: 2,
    status: "ok",
  });

  assert.match(output, /1 chain\(s\) start after removed rows/);
  assert.match(output, /OK: every chain verifies\./);
});

test("without PostgreSQL the command refuses; --help prints the usage and touches nothing", async () => {
  let output = "";

  await assert.rejects(
    runAuditVerifyCommand([], { createStore: () => assert.fail("no store"), isConfigured: () => false, write: () => {} }),
    /audit:verify needs PostgreSQL/
  );
  assert.equal(
    await runAuditVerifyCommand(["--help"], {
      createStore: () => assert.fail("no store"),
      isConfigured: () => assert.fail("no configuration read"),
      write: (text) => {
        output += text;
      },
    }),
    null
  );
  assert.equal(output, USAGE);
});

// --- One snapshot for the whole scan -----------------------------------------

// What the scan's correctness depends on in PostgreSQL: ids are taken at
// INSERT and become visible at COMMIT, a statement outside a transaction reads
// the rows committed when it runs (a snapshot per page), and a cursor reads
// the rows committed at its DECLARE, whatever commits while it is fetched.
const createSnapshotDatabase = (rows, { visible }) => {
  const committed = new Set(visible);
  const statements = [];
  let afterRead = async () => {};
  const snapshot = () => rows.filter((row) => committed.has(row.id));
  const select = (source, afterId, workspaceId) =>
    source.filter((row) => row.id > afterId && (!workspaceId || row.workspace_id === workspaceId));

  const query = async (text, values = []) => {
    if (text.includes("schema_migrations")) {
      statements.push("activation");
      return { rows: [] };
    }

    if (text.includes("WHERE id > $1") && text.includes("LIMIT $2")) {
      statements.push("page");
      const [afterId, limit, workspaceId] = values;
      const page = select(snapshot(), afterId, workspaceId).slice(0, limit);

      await afterRead();
      return { rows: page };
    }

    throw new Error(`Unexpected query: ${text}`);
  };

  const transaction = async (callback) => {
    let cursor = null;

    statements.push("begin");

    const result = await callback({
      async query(text, values = []) {
        if (/^\s*DECLARE archive_rag_admin_audit_chain_scan NO SCROLL CURSOR FOR\s+SELECT/.test(text)) {
          statements.push("declare");
          const [afterId, workspaceId] = values;

          cursor = { position: 0, rows: select(snapshot(), afterId, workspaceId) };
          return { rows: [] };
        }

        const fetch = /^\s*FETCH FORWARD (\d+) FROM archive_rag_admin_audit_chain_scan\s*$/.exec(text);

        if (fetch && cursor) {
          statements.push(`fetch ${fetch[1]}`);
          const page = cursor.rows.slice(cursor.position, cursor.position + Number(fetch[1]));

          cursor.position += page.length;
          await afterRead();
          return { rows: page };
        }

        if (/^\s*CLOSE archive_rag_admin_audit_chain_scan\s*$/.test(text)) {
          statements.push("close");
          cursor = null;
          return { rows: [] };
        }

        throw new Error(`Unexpected statement in the scan transaction: ${text}`);
      },
    });

    statements.push("commit");
    return result;
  };

  return {
    commit: (...ids) => ids.forEach((id) => committed.add(id)),
    onRead: (callback) => {
      afterRead = callback;
    },
    query,
    statements,
    transaction,
  };
};

// Y, X, Y, X, Y: ids 1-5, chain Y = ws-y (1, 3, 5), chain X = ws-x (2, 4).
const seedInterleavedChains = async () => {
  let index = 0;
  let tick = 0;
  const store = createInMemoryAdminAuditStore({ maxEvents: 100 });
  const service = createAdminAuditService({
    createEventId: () => `event-${++index}`,
    now: () => new Date(Date.parse("2026-10-01T00:00:00.000Z") + 1000 * tick++).toISOString(),
    store,
  });

  for (const workspaceId of ["ws-y", "ws-x", "ws-y", "ws-x", "ws-y"]) {
    await service.recordAuthorizationDecision({
      accessScope: { authenticated: true, userId: "alice", workspaceId },
      decision: { allowed: true, permissionId: "admin.status.read", reason: "allowed_by_role", roleId: "admin.viewer" },
      request: { method: "GET", path: "/admin/status", route: "/admin/status" },
    });
  }

  return store.listChainRows();
};

const createSnapshotStore = (database) =>
  createPostgresAdminAuditStore({
    query: database.query,
    retentionDays: 0,
    runMigrations: async () => {},
    tableName: "rag_admin_audit_events",
    transaction: database.transaction,
  });

test("the PostgreSQL scan reads every page from one snapshot: a row another chain commits mid-scan is no false break", async () => {
  const rows = await seedInterleavedChains();

  assert.deepEqual(rows.map((row) => [row.id, row.workspace_id]), [
    [1, "ws-y"],
    [2, "ws-x"],
    [3, "ws-y"],
    [4, "ws-x"],
    [5, "ws-y"],
  ]);

  // Row 3 (chain Y) took its id but has not committed when the scan starts;
  // row 4 (chain X) already has. Once the first page is read, row 3 commits
  // and chain Y's writer appends row 5 (prev_hash = row 3's hash).
  const stage = () => {
    const database = createSnapshotDatabase(rows, { visible: [1, 2, 4] });
    let first = true;

    database.onRead(async () => {
      if (first) {
        first = false;
        database.commit(3, 5);
      }
    });

    return database;
  };

  // The control, as audit:verify paged before: a statement (and a snapshot)
  // per page. Page 1 ends at row 4, so row 3 is never read, and row 5 looks
  // like it does not follow chain Y's head.
  const paged = stage();
  const pagedStore = createSnapshotStore(paged);
  const pagedReport = await verifyAdminAuditStoreChains(
    { describe: pagedStore.describe, listChainRows: pagedStore.listChainRows },
    { pageSize: 3 }
  );

  assert.equal(pagedReport.status, "broken");
  assert.deepEqual(pagedReport.chains.find((chain) => chain.workspaceId === "ws-y").break, {
    eventId: "event-5",
    kind: "prev_hash_mismatch",
    rowId: 5,
  });

  // The PostgreSQL store's scan: one cursor, one snapshot. Rows 3 and 5 are
  // simply not part of it.
  const scanned = stage();
  const report = await verifyAdminAuditStoreChains(createSnapshotStore(scanned), { pageSize: 3 });

  assert.equal(report.status, "ok", JSON.stringify(report.chains));
  assert.equal(report.rowsScanned, 3);
  assert.deepEqual(scanned.statements, ["begin", "declare", "fetch 3", "fetch 3", "close", "commit"]);

  // The real command takes the same path.
  const command = stage();
  const result = await runAuditVerifyCommand(["--page-size", "3", "--json"], {
    createStore: () => createSnapshotStore(command),
    isConfigured: () => true,
    write: () => {},
  });

  assert.equal(result.status, "ok");
  assert.ok(command.statements.includes("declare"));
  assert.equal(command.statements.includes("page"), false, "no page is read outside the snapshot");
});

test("the scan passes its bounds as parameters, filters one workspace, and needs a page callback", async () => {
  const rows = await seedInterleavedChains();
  const database = createSnapshotDatabase(rows, { visible: [1, 2, 3, 4, 5] });
  const declared = [];
  const wrapped = {
    ...database,
    transaction: (callback) =>
      database.transaction((client) =>
        callback({
          query: (text, values) => {
            if (text.includes("DECLARE")) declared.push({ text: text.replace(/\s+/g, " ").trim(), values });
            return client.query(text, values);
          },
        })
      ),
  };
  const store = createSnapshotStore(wrapped);
  const pages = [];
  const result = await store.scanChainRows({
    afterId: 1,
    onPage: (page) => pages.push(page.map((row) => row.id)),
    pageSize: 1,
    workspaceId: " ws-y ",
  });

  assert.deepEqual(pages, [[3], [5]]);
  assert.deepEqual(result, { rowsRead: 2 });
  assert.deepEqual(declared[0].values, [1, "ws-y"]);
  assert.match(declared[0].text, /WHERE id > \$1 AND workspace_id = \$2 ORDER BY id$/);
  await assert.rejects(store.scanChainRows({}), /onPage/);
});

// --- Rolling upgrades ----------------------------------------------------------

// ws-a's chain as a rolling upgrade leaves it: hashed rows from the first new
// instance, and between them a row without hashes from an instance still on
// code from before migration 041.
const seedUpgradeRows = async () => {
  const rows = await (await seedStore()).listChainRows();
  const wsA = rows.filter((row) => row.workspace_id === "ws-a");
  const oldReplicaRow = {
    ...wsA[0],
    created_at: "2026-10-01T00:00:01.500Z",
    event_id: "old-replica-1",
    id: 1.5,
    prev_hash: null,
    row_hash: null,
  };

  return [...rows, oldReplicaRow].sort((left, right) => left.id - right.id);
};

const createActivationStore = (rows, appliedAt) => ({
  ...createRowStore(rows),
  readChainActivation: async () => appliedAt,
});

test("an unhashed row inside the upgrade window (migration 041's time plus the grace) is an upgrade row, not a break", async () => {
  const rows = await seedUpgradeRows();
  let text = "";
  const result = await runAuditVerifyCommand([], {
    createStore: () => createActivationStore(rows, "2026-09-30T23:59:00.000Z"),
    isConfigured: () => true,
    write: (chunk) => {
      text += chunk;
    },
  });

  assert.equal(result.status, "ok", JSON.stringify(result.chains));
  assert.equal(result.upgradeRows, 1);
  assert.deepEqual(result.upgradeWindow, {
    chainedSince: "2026-09-30T23:59:00.000Z",
    endsAt: "2026-10-01T23:59:00.000Z",
    graceHours: 24,
    source: "migration",
  });
  assert.equal(result.chains.find((chain) => chain.workspaceId === "ws-a").upgradeRows, 1);
  assert.match(text, /1 row\(s\) without hashes were written into started chains by the end of the upgrade window \(2026-10-01T23:59:00\.000Z\)/);
  assert.match(text, /OK: every chain verifies\./);
});

test("outside the window, with the window off, or without a recorded start, an unhashed row is still a break", async () => {
  const rows = await seedUpgradeRows();
  const run = async (args, store) => {
    let text = "";
    const result = await runAuditVerifyCommand(args, {
      createStore: () => store,
      isConfigured: () => true,
      write: (chunk) => {
        text += chunk;
      },
    });

    return { result, text };
  };
  const unchained = { eventId: "old-replica-1", kind: "unchained_row", rowId: 1.5 };
  const wsA = ({ result }) => result.chains.find((chain) => chain.workspaceId === "ws-a");

  // Migration 041 ran a week before the row: the window has long ended.
  const late = await run([], createActivationStore(rows, "2026-09-24T00:00:00.000Z"));

  assert.equal(late.result.status, "broken");
  assert.deepEqual(wsA(late).break, unchained);
  assert.match(late.text, /after the upgrade window \(2026-09-25T00:00:00\.000Z\) are breaks.*--upgrade-window-end/);

  const strict = await run(["--upgrade-grace-hours", "0"], createActivationStore(rows, "2026-09-30T23:59:00.000Z"));

  assert.equal(strict.result.upgradeWindow, null);
  assert.deepEqual(wsA(strict).break, unchained);
  assert.match(strict.text, /The upgrade window is off/);

  for (const store of [createRowStore(rows), createActivationStore(rows, "")]) {
    const unknown = await run([], store);

    assert.equal(unknown.result.upgradeWindow, null);
    assert.deepEqual(wsA(unknown).break, unchained);
  }

  // The operator's acknowledgement: --upgrade-window-end names the end.
  const acknowledged = await run(["--upgrade-window-end", "2026-10-01T00:00:02Z"], createRowStore(rows));

  assert.equal(acknowledged.result.status, "ok");
  assert.deepEqual(acknowledged.result.upgradeWindow, {
    chainedSince: null,
    endsAt: "2026-10-01T00:00:02.000Z",
    graceHours: null,
    source: "argument",
  });

  const tooEarly = await run(["--upgrade-window-end", "2026-10-01T00:00:01Z"], createRowStore(rows));

  assert.deepEqual(wsA(tooEarly).break, unchained, "a row written after the end it names is a break");
});
