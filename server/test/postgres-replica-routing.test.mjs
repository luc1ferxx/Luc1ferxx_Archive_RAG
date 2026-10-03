import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

import {
  TENANT_SETTINGS_TEXT,
  executedTexts,
  roundTrips,
  startFakePostgres,
} from "./postgres-replica-fake-server.mjs";

// Protocol-level checks of read routing in rag/postgres.js, against two fake
// PostgreSQL servers on OS-assigned 127.0.0.1 ports, a primary and a replica:
// the real pg client and pools connect to both, and each server records the
// frontend messages it receives. What it proves: a tenant statement marked
// read-only goes to the replica as the tenant pipeline with the freshness
// guard in the same round trip; everything else (unmarked, owner, inside a
// transaction, unset configuration) is exactly the primary path; a guard that
// fails, a replica that is down and a circuit that opens never fail the read.
// postgres-replica.integration.test.mjs proves the same on real streaming
// replication.

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const STATEMENT = "SELECT doc_id FROM rag_documents WHERE doc_id = ANY($1::text[])";
const BOOL = 16;
const ENV_KEYS = [
  "LONG_MEMORY_DATABASE_URL",
  "LONG_MEMORY_POSTGRES_SSL_ENABLED",
  "POSTGRES_DATABASE_URL",
  "POSTGRES_READ_REPLICA_CIRCUIT_COOLDOWN_MS",
  "POSTGRES_READ_REPLICA_CIRCUIT_FAILURE_THRESHOLD",
  "POSTGRES_READ_REPLICA_LAG_POLL_MS",
  "POSTGRES_READ_REPLICA_MAX_LAG_MS",
  "POSTGRES_READ_REPLICA_URLS",
  "POSTGRES_ROW_LEVEL_SECURITY",
  "POSTGRES_SSL_ENABLED",
  "POSTGRES_TENANT_ROLE",
];

let primary;
let replica;
let modules;
let savedEnv;
let clock = null;
let replicaResponder = () => undefined;

// Monitor polls answer from either server; statements fall to the responder.
const POLL_ANSWERS = {
  primary: (text) =>
    /pg_current_wal_flush_lsn/.test(text) ? { command: "SELECT 1", fields: ["lsn"], rows: [["0/3000060"]] } : undefined,
  replica: (text) =>
    /pg_last_wal_replay_lsn/.test(text)
      ? {
          command: "SELECT 1",
          fields: [{ name: "in_recovery", typeOid: BOOL }, "replay_lsn", { name: "replay_paused", typeOid: BOOL }],
          rows: [["t", "0/3000060", "f"]],
        }
      : undefined,
};
const statementRows = (text) =>
  /FROM rag_documents/.test(text) ? { command: "SELECT 1", fields: ["doc_id"], rows: [["doc-1"]] } : undefined;

before(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  primary = await startFakePostgres((text) => POLL_ANSWERS.primary(text) ?? statementRows(text));
  replica = await startFakePostgres((text) => POLL_ANSWERS.replica(text) ?? replicaResponder(text) ?? statementRows(text));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  Object.assign(process.env, {
    POSTGRES_DATABASE_URL: primary.url(),
    POSTGRES_READ_REPLICA_CIRCUIT_COOLDOWN_MS: "1000",
    POSTGRES_READ_REPLICA_CIRCUIT_FAILURE_THRESHOLD: "2",
    // One poll at the start of each test, none in the background.
    POSTGRES_READ_REPLICA_LAG_POLL_MS: "600000",
    POSTGRES_READ_REPLICA_MAX_LAG_MS: "600000",
    POSTGRES_READ_REPLICA_URLS: replica.url(),
    POSTGRES_ROW_LEVEL_SECURITY: "enforce",
    POSTGRES_TENANT_ROLE: "archive_rag_tenant",
  });

  const [postgres, replicas, tenant] = await Promise.all([
    import("../rag/postgres.js"),
    import("../rag/postgres-replicas.js"),
    import("../rag/postgres-tenant.js"),
  ]);

  modules = { postgres, replicas, tenant };
});

const allClosed = (server) => server.state.closed.size === server.state.connections;

afterEach(async () => {
  replicaResponder = () => undefined;
  clock = null;
  process.env.POSTGRES_READ_REPLICA_URLS = replica.url();
  await modules.replicas.configureReadReplicaRouting();
  await modules.postgres.resetPostgresPool();
  await new Promise((resolve) => {
    const poll = () => (allClosed(primary) && allClosed(replica) ? resolve() : setImmediate(poll));

    poll();
  });
  primary.state.messages.length = 0;
  replica.state.messages.length = 0;
});

after(async () => {
  await modules?.postgres.resetPostgresPool();
  await Promise.all([primary?.close(), replica?.close()]);

  for (const [key, value] of Object.entries(savedEnv ?? {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const asTenant = (callback) => modules.tenant.runWithDatabaseTenant(ALICE, callback);

// Messages of the read pools only: the monitor's connections are dropped.
const withoutMonitor = (server) => {
  const monitor = new Set(
    server.state.messages
      .filter((entry) => entry.type === "Query" && /pg_current_wal_flush_lsn|pg_last_wal_replay_lsn/.test(entry.text))
      .map((entry) => entry.connectionId)
  );

  return server.state.messages.filter((entry) => !monitor.has(entry.connectionId));
};

const shape = (messages) =>
  executedTexts(messages).map((text) =>
    TENANT_SETTINGS_TEXT.test(text)
      ? "<tenant settings>"
      : /read_replica:freshness_guard/.test(text)
        ? "<freshness guard>"
        : text
  );

const guard = () =>
  modules.replicas.buildDocumentFreshnessGuard({
    documents: [{ docId: "doc-1", version: 2 }],
    documentsTable: "rag_documents",
  });

// A monitor that has polled once, on the real clock or on `clock`.
const primeMonitor = async ({ fakeClock = false } = {}) => {
  if (fakeClock) {
    clock = { now: 10_000 };
    await modules.replicas.configureReadReplicaRouting({ now: () => clock.now });
  }

  await modules.replicas.pollReadReplicasNow();
  assert.equal(modules.replicas.getReplicaRoutingSnapshot().replicas[0].usable, true);
};

test("a tenant read marked read-only runs on the replica: settings, guard and statement in one round trip, nothing on the primary", async () => {
  await primeMonitor();

  const result = await asTenant(() =>
    modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: { guard: guard() } })
  );

  assert.deepEqual(result.rows, [{ doc_id: "doc-1" }], "the statement's rows, not the guard's");

  const replicaMessages = withoutMonitor(replica);

  assert.deepEqual(shape(replicaMessages), ["<tenant settings>", "<freshness guard>", STATEMENT]);
  assert.equal(roundTrips(replicaMessages), 1);
  assert.equal(replicaMessages.filter((entry) => entry.type === "Query").length, 0, "no simple-protocol text");
  assert.deepEqual(replicaMessages.find((entry) => entry.type === "Bind").values, ["archive_rag_tenant", "alice", "ws-a"]);
  assert.deepEqual(withoutMonitor(primary), [], "the primary's read pool was never used");

  const snapshot = modules.replicas.getReplicaRoutingSnapshot();

  assert.deepEqual(snapshot.reads, { primary: 0, replica: 1 });
  assert.equal(snapshot.replicas[0].reads, 1);
});

test("a prelude travels with the statement on the replica, after the guard", async () => {
  await primeMonitor();

  await asTenant(() =>
    modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], {
      prelude: [{ text: "SELECT set_config($1, $2, true)", values: ["hnsw.iterative_scan", "relaxed_order"] }],
      readOnly: { guard: guard() },
    })
  );

  assert.deepEqual(shape(withoutMonitor(replica)), [
    "<tenant settings>",
    "<freshness guard>",
    "SELECT set_config($1, $2, true)",
    STATEMENT,
  ]);
  assert.equal(roundTrips(withoutMonitor(replica)), 1);
});

test("unmarked reads, owner reads and reads inside a transaction stay on the primary", async () => {
  await primeMonitor();

  await asTenant(() => modules.postgres.queryPostgres(STATEMENT, [["doc-1"]]));
  assert.deepEqual(shape(withoutMonitor(primary)), ["<tenant settings>", STATEMENT]);

  await modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: true });
  await asTenant(() =>
    modules.postgres.withPostgresTransaction(async (client) => {
      await client.query("SELECT 1");
      // A separate pooled statement issued from inside the transaction.
      await modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: { guard: guard() } });
    })
  );

  assert.deepEqual(withoutMonitor(replica), [], "the replica's read pool was never used");

  const snapshot = modules.replicas.getReplicaRoutingSnapshot();

  assert.deepEqual(snapshot.reads, { primary: 2, replica: 0 });
  assert.deepEqual(snapshot.bypasses, { in_transaction: 1, owner: 1, registry_unverified: 0 });
  assert.ok(Object.values(snapshot.fallbacks).every((count) => count === 0));
  assert.equal(modules.postgres.canRouteReadToReplica(), false, "no tenant here");
  assert.equal(await asTenant(async () => modules.postgres.canRouteReadToReplica()), true);
  assert.equal(
    await asTenant(() => modules.postgres.withPostgresTransaction(async () => modules.postgres.canRouteReadToReplica())),
    false
  );
});

test("a request whose registry refresh failed reads only from the primary", async () => {
  await primeMonitor();

  await asTenant(() =>
    modules.postgres.runWithPrimaryReads(async () => {
      assert.equal(modules.postgres.canRouteReadToReplica(), false);
      await modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: { guard: guard() } });
    })
  );

  assert.deepEqual(withoutMonitor(replica), [], "the replica's read pool was never used");
  assert.deepEqual(shape(withoutMonitor(primary)), ["<tenant settings>", STATEMENT]);

  const snapshot = modules.replicas.getReplicaRoutingSnapshot();

  assert.deepEqual(snapshot.reads, { primary: 1, replica: 0 });
  assert.equal(snapshot.bypasses.registry_unverified, 1);
});

test("a replica behind the guard skips the read and the primary answers it, counted as version_behind", async () => {
  await primeMonitor();
  replicaResponder = (text) =>
    /read_replica:freshness_guard/.test(text)
      ? {
          error: {
            code: "22P02",
            message: `invalid input syntax for type integer: "${modules.replicas.REPLICA_BEHIND_SENTINEL}"`,
          },
        }
      : undefined;

  const result = await asTenant(() =>
    modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: { guard: guard() } })
  );

  assert.deepEqual(result.rows, [{ doc_id: "doc-1" }]);

  const replicaMessages = withoutMonitor(replica);

  assert.deepEqual(shape(replicaMessages), ["<tenant settings>", "<freshness guard>"], "the read never ran there");
  assert.ok(replicaMessages.some((entry) => entry.type === "skipped"));
  assert.deepEqual(shape(withoutMonitor(primary)), ["<tenant settings>", STATEMENT], "no guard on the primary");

  const snapshot = modules.replicas.getReplicaRoutingSnapshot();

  assert.deepEqual(snapshot.reads, { primary: 1, replica: 0 });
  assert.equal(snapshot.fallbacks.version_behind, 1);
  assert.equal(snapshot.replicas[0].circuit.state, "closed", "a guard failure is an answer, not an outage");
});

test("any other replica error falls back too, and the error never reaches the caller", async () => {
  await primeMonitor();
  replicaResponder = (text) =>
    text === STATEMENT ? { error: { code: "42P01", message: 'relation "rag_documents" does not exist' } } : undefined;

  const result = await asTenant(() => modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: true }));

  assert.deepEqual(result.rows, [{ doc_id: "doc-1" }]);
  assert.equal(modules.replicas.getReplicaRoutingSnapshot().fallbacks.replica_error, 1);
});

test("a replica that goes down never fails a read: fallbacks, then an open circuit, then a probe once it is back", async () => {
  await primeMonitor({ fakeClock: true });
  await replica.stop();

  const read = () => asTenant(() => modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: { guard: guard() } }));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual((await read()).rows, [{ doc_id: "doc-1" }]);
  }

  let snapshot = modules.replicas.getReplicaRoutingSnapshot();

  assert.equal(snapshot.fallbacks.replica_unavailable, 2, "the threshold");
  assert.equal(snapshot.fallbacks.circuit_open, 1, "then the circuit keeps reads off it");
  assert.equal(snapshot.replicas[0].circuit.state, "open");
  assert.deepEqual(snapshot.reads, { primary: 3, replica: 0 });

  await replica.restart();
  clock.now += 1000;
  assert.deepEqual((await read()).rows, [{ doc_id: "doc-1" }]);

  snapshot = modules.replicas.getReplicaRoutingSnapshot();
  assert.equal(snapshot.replicas[0].circuit.state, "closed", "the probe succeeded");
  assert.deepEqual(snapshot.reads, { primary: 3, replica: 1 });
});

test("with POSTGRES_READ_REPLICA_URLS unset a marked read is exactly the primary's tenant pipeline", async () => {
  delete process.env.POSTGRES_READ_REPLICA_URLS;

  await asTenant(() => modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: { guard: guard() } }));
  await modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: true });

  assert.deepEqual(shape(primary.state.messages), ["<tenant settings>", STATEMENT, STATEMENT]);
  assert.equal(roundTrips(primary.state.messages), 2, "one round trip each, as without the mark");
  assert.equal(replica.state.messages.length, 0, "the replica was never contacted");
  assert.deepEqual(modules.replicas.getReplicaRoutingSnapshot(), { enabled: false });
});

test("an invalid replica configuration fails marked reads loudly and leaves unmarked ones alone", async () => {
  process.env.POSTGRES_READ_REPLICA_URLS = "http://not-postgres";

  await assert.rejects(
    asTenant(() => modules.postgres.queryPostgres(STATEMENT, [["doc-1"]], { readOnly: true })),
    /POSTGRES_READ_REPLICA_URLS entry 1/
  );
  assert.deepEqual((await asTenant(() => modules.postgres.queryPostgres(STATEMENT, [["doc-1"]]))).rows, [{ doc_id: "doc-1" }]);
});
