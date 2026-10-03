import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import pg from "pg";

import {
  READ_REPLICA_BYPASS_REASONS,
  READ_REPLICA_FALLBACK_REASONS,
  READ_REPLICA_MONITOR_APPLICATION_NAME,
  REPLICA_BEHIND_SENTINEL,
  acquireReadReplica,
  buildDocumentFreshnessGuard,
  checkReadReplicaHealth,
  classifyReplicaError,
  computeReplicaLag,
  configureReadReplicaRouting,
  getReadReplicaConfig,
  getReplicaRoutingSnapshot,
  hasReadReplicaConfiguration,
  isReadReplicaRoutingEnabled,
  isReplicaBehindError,
  parseLsn,
  parseReadReplicaUrls,
  pollReadReplicasNow,
  recordPrimaryRead,
  resetReadReplicas,
} from "../rag/postgres-replicas.js";

// Database-free tests of the replica router (rag/postgres-replicas.js): its
// configuration, the lag it measures from scripted primary and replica WAL
// positions on a scripted clock, which replica a read gets, the circuit per
// replica, error classification, the freshness guard it builds and the
// counters and health it reports. The wire protocol on a replica connection
// is covered by postgres-replica-routing.test.mjs, real streaming replication
// by postgres-replica.integration.test.mjs.

const PRIMARY_URL = "postgresql://owner:primary-secret@primary.internal:5432/archive";
const REPLICA_URLS = [
  "postgresql://reader:replica-secret@replica-a.internal:6432/archive",
  "postgres://reader:replica-secret@replica-b.internal/archive",
];
const ENV_KEYS = [
  "LONG_MEMORY_DATABASE_URL",
  "POSTGRES_DATABASE_URL",
  "POSTGRES_READ_REPLICA_CIRCUIT_COOLDOWN_MS",
  "POSTGRES_READ_REPLICA_CIRCUIT_FAILURE_THRESHOLD",
  "POSTGRES_READ_REPLICA_CONNECT_TIMEOUT_MS",
  "POSTGRES_READ_REPLICA_LAG_POLL_MS",
  "POSTGRES_READ_REPLICA_MAX_LAG_MS",
  "POSTGRES_READ_REPLICA_POOL_MAX",
  "POSTGRES_READ_REPLICA_URLS",
];

const INVALID_TEXT = "22P02";

let savedEnv;
let clock;
let nodes;

const lsn = (offset) => `0/${offset.toString(16).toUpperCase()}`;

// One scripted node per URL: the primary answers its flushed position, a
// replica its recovery state and replay position. `down` refuses connections.
const createNodes = () => {
  const byUrl = new Map([
    [PRIMARY_URL, { down: false, flush: 0x1000, polls: 0 }],
    ...REPLICA_URLS.map((url) => [url, { down: false, inRecovery: true, paused: false, polls: 0, replay: 0x1000 }]),
  ]);
  const pools = [];

  const createPool = (options) => {
    const node = byUrl.get(options.connectionString);
    const pool = {
      ended: false,
      options,
      connect: async () => {
        if (node.down) {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        }

        return {
          query: async (text) => {
            node.polls += 1;

            if (/pg_current_wal_flush_lsn/.test(text)) {
              return { rows: [{ lsn: lsn(node.flush) }] };
            }

            if (/pg_last_wal_replay_lsn/.test(text)) {
              return {
                rows: [
                  {
                    in_recovery: node.inRecovery,
                    replay_lsn: node.inRecovery ? lsn(node.replay) : null,
                    replay_paused: node.inRecovery ? node.paused : null,
                  },
                ],
              };
            }

            throw new Error(`unexpected poll: ${text}`);
          },
          release: () => {},
        };
      },
      end: async () => {
        pool.ended = true;
      },
    };

    pools.push(pool);
    return pool;
  };

  return {
    createPool,
    pools,
    primary: byUrl.get(PRIMARY_URL),
    replicas: REPLICA_URLS.map((url) => byUrl.get(url)),
  };
};

// Polls once at the clock's current time (the router skips a poll that would
// start less than a poll interval after the last one, so tests step the clock).
const pollAt = async (time) => {
  clock.now = time;
  await pollReadReplicasNow();
};

const useReplicas = async ({ urls = REPLICA_URLS, ...settings } = {}) => {
  process.env.POSTGRES_READ_REPLICA_URLS = urls.join(",");
  process.env.POSTGRES_READ_REPLICA_LAG_POLL_MS = String(settings.pollMs ?? 100);
  process.env.POSTGRES_READ_REPLICA_MAX_LAG_MS = String(settings.maxLagMs ?? 1000);

  if (settings.poolMax !== undefined) process.env.POSTGRES_READ_REPLICA_POOL_MAX = String(settings.poolMax);
  if (settings.threshold !== undefined) {
    process.env.POSTGRES_READ_REPLICA_CIRCUIT_FAILURE_THRESHOLD = String(settings.threshold);
  }
  if (settings.cooldownMs !== undefined) {
    process.env.POSTGRES_READ_REPLICA_CIRCUIT_COOLDOWN_MS = String(settings.cooldownMs);
  }

  nodes = createNodes();
  await configureReadReplicaRouting({ createPool: nodes.createPool, now: () => clock.now });
};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  process.env.POSTGRES_DATABASE_URL = PRIMARY_URL;
  clock = { now: 1_000_000 };
});

afterEach(async () => {
  await configureReadReplicaRouting();

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const databaseError = (code, message = "server error") => {
  const error = new pg.DatabaseError(message, message.length, "error");

  error.code = code;
  return error;
};

// ---- configuration -----------------------------------------------------------

test("unset, routing is off and every entry point is inert", async () => {
  assert.equal(hasReadReplicaConfiguration(), false);
  assert.equal(isReadReplicaRoutingEnabled(), false);
  assert.deepEqual(getReplicaRoutingSnapshot(), { enabled: false });
  assert.equal(await checkReadReplicaHealth(), null);
  recordPrimaryRead("owner");
  await pollReadReplicasNow();
  assert.deepEqual(getReplicaRoutingSnapshot(), { enabled: false });
  await resetReadReplicas();
});

test("replica URLs get stable ids and host:port endpoints, and a bad entry never echoes the URL", () => {
  assert.deepEqual(
    parseReadReplicaUrls(` ${REPLICA_URLS[0]} ,, ${REPLICA_URLS[1]} `).map(({ endpoint, id }) => ({ endpoint, id })),
    [
      { endpoint: "replica-a.internal:6432", id: "replica-0" },
      { endpoint: "replica-b.internal:5432", id: "replica-1" },
    ]
  );
  assert.deepEqual(parseReadReplicaUrls(""), []);

  for (const bad of ["not a url secret-token", "http://user:secret-token@host/db", "postgres:///db"]) {
    assert.throws(
      () => parseReadReplicaUrls(`${REPLICA_URLS[0]},${bad}`),
      (error) => /entry 2/.test(error.message) && !error.message.includes("secret-token")
    );
  }
});

test("numeric settings default, accept integers and refuse anything else", () => {
  const env = { POSTGRES_READ_REPLICA_URLS: REPLICA_URLS[0] };
  const config = getReadReplicaConfig(env);

  assert.deepEqual(
    {
      circuitCooldownMs: config.circuitCooldownMs,
      circuitFailureThreshold: config.circuitFailureThreshold,
      connectTimeoutMs: config.connectTimeoutMs,
      maxLagMs: config.maxLagMs,
      pollMs: config.pollMs,
      poolMax: config.poolMax,
    },
    { circuitCooldownMs: 5000, circuitFailureThreshold: 3, connectTimeoutMs: 2000, maxLagMs: 2000, pollMs: 500, poolMax: 10 }
  );
  assert.equal(getReadReplicaConfig({ ...env, POSTGRES_READ_REPLICA_MAX_LAG_MS: "0" }).maxLagMs, 0);
  assert.throws(() => getReadReplicaConfig({ ...env, POSTGRES_READ_REPLICA_MAX_LAG_MS: "1.5" }), /MAX_LAG_MS/);
  assert.throws(() => getReadReplicaConfig({ ...env, POSTGRES_READ_REPLICA_POOL_MAX: "0" }), /POOL_MAX/);
  assert.throws(() => getReadReplicaConfig({ ...env, POSTGRES_READ_REPLICA_LAG_POLL_MS: "5" }), /LAG_POLL_MS/);
});

test("pg_lsn text parses to a comparable BigInt", () => {
  assert.equal(parseLsn("0/0"), 0n);
  assert.equal(parseLsn("16/B374D848"), (0x16n << 32n) + 0xb374d848n);
  assert.ok(parseLsn("1/0") > parseLsn("0/FFFFFFFF"));
  assert.equal(parseLsn(null), null);
  assert.equal(parseLsn("16-B374"), null);
});

// ---- lag ---------------------------------------------------------------------

test("lag is the age of the newest primary sample the replica replayed past", () => {
  const samples = [
    { at: 1000, lsn: 10n },
    { at: 2000, lsn: 20n },
    { at: 3000, lsn: 30n },
  ];

  assert.deepEqual(computeReplicaLag({ now: 3500, replayLsn: 30n, samples }), { behindSince: null, lagMs: 500 });
  assert.deepEqual(computeReplicaLag({ now: 3500, replayLsn: 25n, samples }), { behindSince: 3000, lagMs: 1500 });
  assert.deepEqual(computeReplicaLag({ now: 3500, replayLsn: 10n, samples }), { behindSince: 2000, lagMs: 2500 });
  // Behind every sample: unknown, not zero.
  assert.deepEqual(computeReplicaLag({ now: 3500, replayLsn: 5n, samples }), { behindSince: 1000, lagMs: null });
  // ...unless samples were dropped, which bounds it from below.
  assert.deepEqual(computeReplicaLag({ now: 3500, replayLsn: 5n, samples, truncatedAt: 400 }), {
    behindSince: 1000,
    lagMs: 3100,
  });
  assert.deepEqual(computeReplicaLag({ now: 3500, replayLsn: null, samples }), { behindSince: null, lagMs: null });
  assert.deepEqual(computeReplicaLag({ now: 3500, replayLsn: 5n, samples: [] }), { behindSince: null, lagMs: null });
});

test("a paused replica of an idle primary keeps a lag of one poll; it grows from the first write it misses", async () => {
  await useReplicas({ maxLagMs: 1000, pollMs: 100, urls: [REPLICA_URLS[0]] });

  await pollAt(1_000_000);
  nodes.replicas[0].paused = true;

  // Nothing is written for a minute: the position stays put, the lag does not grow.
  for (let step = 1; step <= 600; step += 1) {
    await pollAt(1_000_000 + step * 100);
  }

  let replica = getReplicaRoutingSnapshot().replicas[0];

  assert.equal(replica.state, "paused");
  assert.equal(replica.replayPaused, true);
  assert.equal(replica.lagMs, 0);
  assert.equal(replica.usable, true);

  // A write the replica does not replay.
  nodes.primary.flush = 0x2000;
  await pollAt(1_060_100);
  clock.now = 1_060_600;
  replica = getReplicaRoutingSnapshot().replicas[0];
  assert.equal(replica.lagMs, 600, "measured from the last sample it had replayed");
  assert.equal(replica.behindSince, new Date(1_060_100).toISOString());
  assert.equal(replica.usable, true);

  await pollAt(1_061_200);
  replica = getReplicaRoutingSnapshot().replicas[0];
  assert.equal(replica.lagMs, 1200);
  assert.equal(replica.exclusion, "lag_exceeded");
  assert.deepEqual(acquireReadReplica(), { reason: "lag_exceeded" });

  // Replay resumes and catches up.
  nodes.replicas[0].paused = false;
  nodes.replicas[0].replay = 0x2000;
  await pollAt(1_061_300);
  replica = getReplicaRoutingSnapshot().replicas[0];
  assert.equal(replica.state, "streaming");
  assert.equal(replica.lagMs, 0);
  assert.equal(replica.usable, true);
});

test("a primary whose position moves back (a failover) starts the samples over", async () => {
  await useReplicas({ urls: [REPLICA_URLS[0]] });
  nodes.primary.flush = 0x5000;
  nodes.replicas[0].replay = 0x5000;
  await pollAt(1_000_000);
  assert.equal(getReplicaRoutingSnapshot().primary.samples, 1);

  nodes.primary.flush = 0x100;
  nodes.replicas[0].replay = 0x80;
  await pollAt(1_000_100);

  const snapshot = getReplicaRoutingSnapshot();

  assert.equal(snapshot.primary.samples, 1);
  assert.equal(snapshot.replicas[0].lagMs, null, "behind the new primary's only sample: unknown");
  assert.equal(snapshot.replicas[0].exclusion, "lag_unknown");
});

test("a replica is unknown until its first poll, and unknown while behind every sample", async () => {
  await useReplicas({ urls: [REPLICA_URLS[0]] });

  assert.equal(acquireReadReplica().reason, "lag_unknown", "the first read does not wait for the first poll");
  await pollReadReplicasNow();
  assert.ok(acquireReadReplica().replica, "usable once polled");

  // A replica that was already far behind when sampling began.
  await useReplicas({ urls: [REPLICA_URLS[0]] });
  nodes.replicas[0].replay = 0x10;
  await pollAt(1_000_000);
  assert.equal(getReplicaRoutingSnapshot().replicas[0].lagMs, null);
  assert.deepEqual(acquireReadReplica(), { reason: "lag_unknown" });
});

test("the sample list stays bounded while a replica is stuck, and the lag it reports never shrinks below the limit", async () => {
  await useReplicas({ maxLagMs: 300, pollMs: 100, urls: [REPLICA_URLS[0]] });
  await pollAt(1_000_000);
  nodes.replicas[0].paused = true;

  for (let step = 1; step <= 500; step += 1) {
    nodes.primary.flush += 0x10;
    await pollAt(1_000_000 + step * 100);

    if (step > 3) {
      assert.equal(getReplicaRoutingSnapshot().replicas[0].exclusion, "lag_exceeded", `step ${step}`);
    }
  }

  const snapshot = getReplicaRoutingSnapshot();

  // 4 * ceil((300 + 100) / 100) + 16 samples at most.
  assert.ok(snapshot.primary.samples <= 32, `${snapshot.primary.samples} samples`);
  assert.ok(snapshot.replicas[0].lagMs >= 3000, "at least the span the kept samples cover");
});

test("a server that is not in recovery, or that does not answer, is skipped as down", async () => {
  await useReplicas({ urls: [REPLICA_URLS[0]] });
  nodes.replicas[0].inRecovery = false;
  await pollAt(1_000_000);

  let replica = getReplicaRoutingSnapshot().replicas[0];

  assert.equal(replica.state, "not_standby");
  assert.equal(replica.exclusion, "replica_down");

  nodes.replicas[0].inRecovery = true;
  nodes.replicas[0].down = true;
  await pollAt(1_000_200);
  replica = getReplicaRoutingSnapshot().replicas[0];
  assert.equal(replica.state, "unreachable");
  assert.equal(replica.errorCode, "ECONNREFUSED");
  assert.deepEqual(acquireReadReplica(), { reason: "replica_down" });
});

test("the poller uses its own one-connection pools, named, apart from the read pools", async () => {
  await useReplicas({ urls: [REPLICA_URLS[0]] });
  await pollReadReplicasNow();

  const lease = acquireReadReplica();

  lease.succeeded();

  const monitorPools = nodes.pools.filter((pool) => pool.options.application_name === READ_REPLICA_MONITOR_APPLICATION_NAME);
  const readPools = nodes.pools.filter((pool) => pool.options.application_name === undefined);

  assert.deepEqual(monitorPools.map((pool) => pool.options.connectionString).sort(), [PRIMARY_URL, REPLICA_URLS[0]].sort());
  assert.ok(monitorPools.every((pool) => pool.options.max === 1 && pool.options.query_timeout === 2000));
  assert.deepEqual(readPools.map((pool) => [pool.options.connectionString, pool.options.max]), [[REPLICA_URLS[0], 10]]);

  await resetReadReplicas();
  assert.ok(nodes.pools.every((pool) => pool.ended), "reset ends every pool");
});

// ---- choosing a replica ---------------------------------------------------------

test("reads go to the least busy replica, ties in turn", async () => {
  await useReplicas();
  await pollReadReplicasNow();

  const first = acquireReadReplica();
  const second = acquireReadReplica();

  assert.deepEqual([first.replica.id, second.replica.id], ["replica-0", "replica-1"]);

  const third = acquireReadReplica();

  assert.equal(third.replica.id, "replica-0", "both busy: in turn");
  second.succeeded();
  assert.equal(acquireReadReplica().replica.id, "replica-1", "replica-1 has fewer in flight");
  first.succeeded();
  third.succeeded();
});

test("a replica with POSTGRES_READ_REPLICA_POOL_MAX reads in flight is skipped as saturated", async () => {
  await useReplicas({ poolMax: 1, urls: [REPLICA_URLS[0]] });
  await pollReadReplicasNow();

  const first = acquireReadReplica();

  assert.deepEqual(acquireReadReplica(), { reason: "replica_saturated" });
  first.succeeded();
  assert.ok(acquireReadReplica().replica);
});

test("the circuit opens after consecutive unavailable errors, lets one probe through after the cooldown, and closes on an answer", async () => {
  await useReplicas({ cooldownMs: 5000, maxLagMs: 60_000, threshold: 2, urls: [REPLICA_URLS[0]] });
  await pollReadReplicasNow();

  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

  assert.equal(acquireReadReplica().failed(refused), "replica_unavailable");
  assert.equal(getReplicaRoutingSnapshot().replicas[0].circuit.state, "closed", "one failure: still closed");
  acquireReadReplica().failed(refused);

  const snapshot = getReplicaRoutingSnapshot();

  assert.equal(snapshot.replicas[0].circuit.state, "open");
  assert.equal(snapshot.replicas[0].circuit.opens, 1);
  assert.deepEqual(acquireReadReplica(), { reason: "circuit_open" });

  // Cooldown over: exactly one probe.
  clock.now += 5000;
  const probe = acquireReadReplica();

  assert.ok(probe.replica);
  assert.deepEqual(acquireReadReplica(), { reason: "circuit_open" }, "one probe at a time");
  probe.failed(refused);
  assert.equal(getReplicaRoutingSnapshot().replicas[0].circuit.opens, 2, "a failed probe reopens it");
  assert.deepEqual(acquireReadReplica(), { reason: "circuit_open" });

  clock.now += 5000;
  // A server error proves the way to the server works: closed again.
  acquireReadReplica().failed(databaseError("42P01", 'relation "x" does not exist'));
  assert.equal(getReplicaRoutingSnapshot().replicas[0].circuit.state, "closed");
  assert.ok(acquireReadReplica().replica);
});

test("replica errors are classified; only unavailability counts toward the circuit", async () => {
  const behind = databaseError(INVALID_TEXT, `invalid input syntax for type integer: "${REPLICA_BEHIND_SENTINEL}"`);

  assert.equal(isReplicaBehindError(behind), true);
  assert.equal(classifyReplicaError(behind), "version_behind");
  assert.equal(classifyReplicaError(databaseError(INVALID_TEXT, 'invalid input syntax for type integer: "x"')), "replica_error");
  assert.equal(
    classifyReplicaError(databaseError("40001", "canceling statement due to conflict with recovery")),
    "recovery_conflict"
  );
  assert.equal(classifyReplicaError(databaseError("40001", "could not serialize access")), "replica_error");
  assert.equal(classifyReplicaError(databaseError("57P04", "database dropped")), "recovery_conflict");
  assert.equal(classifyReplicaError(databaseError("57P01", "terminating connection due to administrator command")), "replica_unavailable");
  assert.equal(classifyReplicaError(databaseError("53300", "too many connections")), "replica_unavailable");
  assert.equal(classifyReplicaError(databaseError("08006", "connection failure")), "replica_unavailable");
  assert.equal(classifyReplicaError(new Error("Connection terminated unexpectedly")), "replica_unavailable");
  assert.equal(classifyReplicaError(databaseError("42501", "permission denied")), "replica_error");

  await useReplicas({ threshold: 1, urls: [REPLICA_URLS[0]] });
  await pollReadReplicasNow();

  for (const error of [behind, databaseError("40001", "conflict with recovery"), databaseError("42P01", "missing")]) {
    acquireReadReplica().failed(error);
  }

  const replica = getReplicaRoutingSnapshot().replicas[0];

  assert.equal(replica.circuit.state, "closed");
  assert.deepEqual(
    Object.fromEntries(Object.entries(replica.fallbacks).filter(([, count]) => count > 0)),
    { recovery_conflict: 1, replica_error: 1, version_behind: 1 }
  );
});

// ---- counters and health --------------------------------------------------------

test("the snapshot counts reads by target and reasons, carries every key, and names no URL or secret", async () => {
  await useReplicas();
  await pollReadReplicasNow();

  acquireReadReplica().succeeded();
  acquireReadReplica().succeeded();
  recordPrimaryRead("version_behind", { fallback: true });
  recordPrimaryRead("owner");
  recordPrimaryRead("in_transaction");

  const snapshot = getReplicaRoutingSnapshot();

  assert.equal(snapshot.enabled, true);
  assert.deepEqual(snapshot.reads, { primary: 3, replica: 2 });
  assert.deepEqual(Object.keys(snapshot.fallbacks), [...READ_REPLICA_FALLBACK_REASONS]);
  assert.deepEqual(Object.keys(snapshot.bypasses), [...READ_REPLICA_BYPASS_REASONS]);
  assert.equal(snapshot.fallbacks.version_behind, 1);
  assert.deepEqual(snapshot.bypasses, { in_transaction: 1, owner: 1, registry_unverified: 0 });
  assert.equal(snapshot.maxLagMs, 1000);
  assert.equal(snapshot.primary.state, "ok");
  assert.equal(snapshot.primary.flushLsn, "0/1000");
  assert.deepEqual(
    snapshot.replicas.map((replica) => [replica.id, replica.endpoint, replica.reads, replica.lagMs, replica.replayLsn]),
    [
      ["replica-0", "replica-a.internal:6432", 1, 0, "0/1000"],
      ["replica-1", "replica-b.internal:5432", 1, 0, "0/1000"],
    ]
  );

  const text = JSON.stringify(snapshot);

  assert.ok(!/secret|postgres(ql)?:\/\//.test(text), text);
});

test("health is ok while every replica is usable, a warning otherwise, and an error only for a bad configuration", async () => {
  await useReplicas();

  let health = await checkReadReplicaHealth();

  assert.equal(health.status, "ok");
  assert.deepEqual(health.replicas.map((replica) => replica.state), ["streaming", "streaming"]);

  nodes.replicas[1].down = true;
  clock.now += 100;
  health = await checkReadReplicaHealth();
  assert.equal(health.status, "warning");
  assert.match(health.message, /1 of 2 read replicas are skipped/);
  assert.deepEqual(health.replicas.map((replica) => replica.exclusion), [null, "replica_down"]);

  nodes.replicas[0].paused = true;
  nodes.primary.flush = 0x9000;
  clock.now += 100;
  await pollReadReplicasNow();
  clock.now += 5000;
  health = await checkReadReplicaHealth();
  assert.equal(health.status, "warning", "lag is never an error");
  assert.match(health.message, /No read replica is usable/);
  assert.ok(!JSON.stringify(health).includes("secret"));

  process.env.POSTGRES_READ_REPLICA_URLS = "http://nope";
  health = await checkReadReplicaHealth();
  assert.equal(health.status, "error");
  assert.throws(() => isReadReplicaRoutingEnabled(), /POSTGRES_READ_REPLICA_URLS/);

  // Set but naming no URL is the same bad configuration: an error entry and
  // reads that refuse, never a health report that throws or routing quietly
  // off.
  for (const empty of [",", " , ,"]) {
    process.env.POSTGRES_READ_REPLICA_URLS = empty;
    health = await checkReadReplicaHealth();
    assert.equal(health.status, "error");
    assert.match(health.message, /names no replica URL/);
    assert.throws(() => isReadReplicaRoutingEnabled(), /POSTGRES_READ_REPLICA_URLS/);
  }
});

test("a primary that cannot be polled leaves the lag growing until replicas are skipped", async () => {
  await useReplicas({ maxLagMs: 1000, urls: [REPLICA_URLS[0]] });
  await pollAt(1_000_000);
  nodes.primary.down = true;
  await pollAt(1_000_500);
  assert.equal(getReplicaRoutingSnapshot().primary.state, "error");
  assert.ok(acquireReadReplica().replica, "the last sample is 500 ms old");
  await pollAt(1_001_200);
  assert.deepEqual(acquireReadReplica(), { reason: "lag_exceeded" });
});

// ---- the freshness guard ------------------------------------------------------

test("the freshness guard checks each document's content version and the pointer generation, with ids as bind values", () => {
  const guard = buildDocumentFreshnessGuard({
    documents: [
      { docId: "doc-1", version: 3 },
      { docId: "doc-2", version: 1 },
      { docId: "doc-1", version: 2 },
      { docId: " ", version: 9 },
    ],
    documentsTable: "rag_documents",
    minPointerGeneration: 4,
    pointerTable: "rag_index_versions_pointer",
  });
  const compact = guard.text.replace(/\s+/g, " ");

  assert.deepEqual(guard.values, [["doc-1", "doc-2"], [3, 1], "4"]);
  assert.match(compact, /unnest\(\$1::text\[\], \$2::integer\[\]\)/);
  assert.match(compact, /JOIN rag_documents d ON d\.doc_id = expected\.doc_id AND d\.content_version >= expected\.content_version/);
  assert.match(compact, /= cardinality\(\$1::text\[\]\)/);
  assert.match(compact, /FROM rag_index_versions_pointer p WHERE p\.singleton AND p\.generation >= \$3::bigint/);
  assert.match(compact, new RegExp(`ELSE '${REPLICA_BEHIND_SENTINEL}' END\\)::integer`));
  assert.ok(!compact.includes("doc-1"));

  const withoutPointer = buildDocumentFreshnessGuard({
    documents: [{ docId: "doc-1", version: 1 }],
    documentsTable: "rag_documents",
    minPointerGeneration: 0,
    pointerTable: "rag_index_versions_pointer",
  });

  assert.equal(withoutPointer.values.length, 2);
  assert.ok(!/pointer/.test(withoutPointer.text));
  assert.throws(() => buildDocumentFreshnessGuard({ documentsTable: "rag_documents; DROP TABLE x" }), /identifier/);
  assert.throws(
    () => buildDocumentFreshnessGuard({ documentsTable: "rag_documents", minPointerGeneration: 2, pointerTable: "p-1" }),
    /identifier/
  );
});
