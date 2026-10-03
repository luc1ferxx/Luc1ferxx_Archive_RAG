import { AsyncResource } from "node:async_hooks";
import pg from "pg";

import { getPostgresDatabaseUrl, isPostgresSslEnabled } from "./config.js";

// Read replicas (POSTGRES_READ_REPLICA_URLS, off by default): which streaming
// replica may answer a read, how far behind each one is, and what happened to
// every read the caller marked read-only. rag/postgres.js runs the statement;
// this module decides where and keeps the counts.
//
// What may go to a replica is decided by the caller and by rag/postgres.js,
// never here: only a statement explicitly marked read-only, run for an
// enforced database tenant (the tenant pipeline, so row-level security is the
// replica's own, replayed policies), outside any transaction. Writes,
// migrations, LISTEN, advisory locks, the index-version pointer and every
// owner/system statement stay on the primary.
//
// Consistency has two independent guards.
//
// Freshness, per statement: a caller that knows which rows its read depends
// on hands rag/postgres.js a guard statement (buildDocumentFreshnessGuard).
// It runs on the replica in the same implicit transaction and round trip,
// just before the read, and fails with REPLICA_BEHIND_SENTINEL when the
// replica does not yet hold what the primary held when the caller looked
// (each document at least at the content version this process's registry
// read from the primary). Replay only moves forward, so the read after a
// passing guard sees at least that state. A failing guard costs one replica
// round trip and the read goes to the primary.
//
// Bounded staleness, per replica: a poller samples the primary's flushed WAL
// position every POSTGRES_READ_REPLICA_LAG_POLL_MS and each replica's replay
// position. A replica's lag is the age of the newest primary sample it has
// replayed past: every transaction that committed before that sample was
// taken is visible on the replica, so nothing older is missing. On an idle
// primary the samples keep their LSN and only their time moves, so the lag
// stays near one poll interval, which pg_last_xact_replay_timestamp() (it
// grows while nothing commits) cannot tell apart from a stuck replica. A
// replica that has replayed past no sample at all (it was behind before the
// first one) has no measured lag and is not used. Replicas past
// POSTGRES_READ_REPLICA_MAX_LAG_MS, unreachable, not in recovery, with an
// open circuit, or with POSTGRES_READ_REPLICA_POOL_MAX reads in flight are
// skipped; the read then goes to the primary. A replica never fails a
// request: every replica error falls back to the primary.

const { DatabaseError, Pool } = pg;

export const READ_REPLICA_URLS_ENV = "POSTGRES_READ_REPLICA_URLS";

const DEFAULTS = Object.freeze({
  circuitCooldownMs: 5000,
  circuitFailureThreshold: 3,
  connectTimeoutMs: 2000,
  maxLagMs: 2000,
  pollMs: 500,
  poolMax: 10,
});

const CONFIG_VARIABLES = Object.freeze({
  circuitCooldownMs: ["POSTGRES_READ_REPLICA_CIRCUIT_COOLDOWN_MS", 1],
  circuitFailureThreshold: ["POSTGRES_READ_REPLICA_CIRCUIT_FAILURE_THRESHOLD", 1],
  connectTimeoutMs: ["POSTGRES_READ_REPLICA_CONNECT_TIMEOUT_MS", 1],
  maxLagMs: ["POSTGRES_READ_REPLICA_MAX_LAG_MS", 0],
  pollMs: ["POSTGRES_READ_REPLICA_LAG_POLL_MS", 10],
  poolMax: ["POSTGRES_READ_REPLICA_POOL_MAX", 1],
});

/**
 * Why a read went to the primary although a replica could have answered it
 * (`fallbacks`), and why a read marked read-only never could (`bypasses`).
 * Every key is always present in a snapshot, so a metric never appears late.
 */
export const READ_REPLICA_FALLBACK_REASONS = Object.freeze([
  // The freshness guard: the replica's rows predate what the caller expects.
  "version_behind",
  // No replica within POSTGRES_READ_REPLICA_MAX_LAG_MS.
  "lag_exceeded",
  // No lag measured yet, or the replica is behind every primary sample.
  "lag_unknown",
  "circuit_open",
  // The last poll could not reach it, or it is not in recovery.
  "replica_down",
  // Every usable replica already has POSTGRES_READ_REPLICA_POOL_MAX reads.
  "replica_saturated",
  // The statement could not connect or lost its connection (counts toward
  // the circuit).
  "replica_unavailable",
  // Cancelled on the standby by a recovery conflict.
  "recovery_conflict",
  // Any other error the replica answered with.
  "replica_error",
]);

export const READ_REPLICA_BYPASS_REASONS = Object.freeze([
  // No enforced tenant: owner and system statements stay on the primary.
  "owner",
  // Inside withPostgresTransaction.
  "in_transaction",
  // Inside runWithPrimaryReads: this request's document registry could not be
  // refreshed, so the freshness guard would check versions that may be stale.
  "registry_unverified",
]);

export const REPLICA_BEHIND_SENTINEL = "archive_rag_replica_behind";

const INVALID_TEXT_REPRESENTATION = "22P02";
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- configuration ---------------------------------------------------------

const readInteger = (env, [name, minimum], fallback) => {
  const raw = String(env[name] ?? "").trim();

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }

  return value;
};

/**
 * The replicas named by POSTGRES_READ_REPLICA_URLS (comma-separated
 * PostgreSQL URLs). Each gets a stable id by position; `endpoint` is host and
 * port only. A URL never appears in an error, a snapshot or a log line: it
 * may carry a password.
 */
export const parseReadReplicaUrls = (value) => {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  // Set but naming nothing (",", " , "): an invalid configuration like a bad
  // entry, not "unset", or the variable would turn routing off silently.
  if (entries.length === 0 && String(value ?? "").trim()) {
    throw new Error(`${READ_REPLICA_URLS_ENV} is set but names no replica URL.`);
  }

  return entries.map((entry, index) => {
    let url;

    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${READ_REPLICA_URLS_ENV} entry ${index + 1} is not a URL.`);
    }

    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
      throw new Error(`${READ_REPLICA_URLS_ENV} entry ${index + 1} must be a postgres:// or postgresql:// URL with a host.`);
    }

    return { endpoint: `${url.hostname}:${url.port || "5432"}`, id: `replica-${index}`, url: entry };
  });
};

const configCache = { key: null, value: null };

/** The parsed configuration; throws on an invalid value (never a silent default). */
export const getReadReplicaConfig = (env = process.env) => {
  const key = JSON.stringify([
    env[READ_REPLICA_URLS_ENV] ?? "",
    ...Object.values(CONFIG_VARIABLES).map(([name]) => env[name] ?? ""),
  ]);

  if (env === process.env && configCache.key === key) {
    return configCache.value;
  }

  const value = {
    replicas: parseReadReplicaUrls(env[READ_REPLICA_URLS_ENV]),
    ...Object.fromEntries(
      Object.entries(CONFIG_VARIABLES).map(([field, variable]) => [field, readInteger(env, variable, DEFAULTS[field])])
    ),
  };

  if (env === process.env) {
    configCache.key = key;
    configCache.value = value;
  }

  return value;
};

/** Whether POSTGRES_READ_REPLICA_URLS is set at all (no parsing, never throws). */
export const hasReadReplicaConfiguration = (env = process.env) => String(env[READ_REPLICA_URLS_ENV] ?? "").trim() !== "";

/** Whether reads may be routed to replicas; throws on an invalid configuration. */
export const isReadReplicaRoutingEnabled = () =>
  hasReadReplicaConfiguration() && getReadReplicaConfig().replicas.length > 0;

// --- LSNs --------------------------------------------------------------------

/** A pg_lsn text ("16/B374D848") as a BigInt, or null. */
export const parseLsn = (text) => {
  const match = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/iu.exec(String(text ?? "").trim());

  return match ? (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`) : null;
};

const formatLsn = (lsn) =>
  lsn === null || lsn === undefined
    ? null
    : `${(lsn >> 32n).toString(16).toUpperCase()}/${(lsn & 0xffffffffn).toString(16).toUpperCase()}`;

// --- error classification ---------------------------------------------------

export const isReplicaBehindError = (error) =>
  error?.code === INVALID_TEXT_REPRESENTATION && String(error?.message ?? "").includes(REPLICA_BEHIND_SENTINEL);

// Errors that say the replica (or the way to it) is unavailable, as opposed to
// an answer from a working server: no server answer at all (refused, reset,
// timed out, a connection that ended), or a server class that means the same
// (08 connection exception, 53 insufficient resources, 57P01-57P03 shutdown /
// cannot connect now, 58 system error).
const isUnavailableError = (error) =>
  !(error instanceof DatabaseError) || /^(08|53|58|57P0[1-3])/u.test(String(error.code ?? ""));

// 40001 serialization_failure is how a standby cancels a query that conflicts
// with replay ("canceling statement due to conflict with recovery"); 57P04
// database_dropped is the same for a dropped database.
const isRecoveryConflictError = (error) =>
  (error?.code === "40001" && /conflict with recovery/iu.test(String(error?.message ?? ""))) ||
  error?.code === "57P04";

/** The fallback reason a replica statement error stands for. */
export const classifyReplicaError = (error) => {
  if (isReplicaBehindError(error)) return "version_behind";
  if (isRecoveryConflictError(error)) return "recovery_conflict";
  if (isUnavailableError(error)) return "replica_unavailable";
  return "replica_error";
};

// A stable code for a snapshot: the SQLSTATE, a Node error code, or nothing.
// Never a message (it could name a host, a role or a value).
const toErrorCode = (error) => {
  const code = error?.code;

  return typeof code === "string" && /^[0-9A-Za-z_]{1,40}$/u.test(code) ? code : "UNKNOWN";
};

// --- the freshness guard -----------------------------------------------------

const assertIdentifier = (name, label) => {
  if (!IDENTIFIER_PATTERN.test(String(name ?? ""))) {
    throw new Error(`${label} must be a simple PostgreSQL identifier.`);
  }
};

/**
 * A statement for the replica pipeline that succeeds only when the replica
 * holds every document in `documents` ({ docId, version }) at that content
 * version or later and, with `pointerTable` and `minPointerGeneration`, has
 * replayed the index-version pointer to at least that generation (so a
 * version activated after its build holds every chunk the build wrote).
 * Otherwise it fails with REPLICA_BEHIND_SENTINEL (SQLSTATE 22P02), which
 * ends the pipeline before the read runs. It runs as the tenant: the ids are
 * the tenant's own documents, which its row policy shows it.
 *
 * The pgvector ingest, replace and delete paths change a document row and
 * its chunk rows in one transaction, so a row at the expected version on the
 * replica means its chunks are there too.
 */
export const buildDocumentFreshnessGuard = ({
  documents = [],
  documentsTable,
  minPointerGeneration = null,
  pointerTable = null,
} = {}) => {
  assertIdentifier(documentsTable, "The documents table");

  const expected = new Map();

  for (const document of documents) {
    const docId = String(document?.docId ?? "").trim();

    if (docId) {
      const version = Math.max(1, Math.floor(Number(document.version) || 1));

      expected.set(docId, Math.max(version, expected.get(docId) ?? 0));
    }
  }

  const generation = Math.floor(Number(minPointerGeneration) || 0);
  const checksPointer = Boolean(pointerTable) && generation > 0;

  if (checksPointer) {
    assertIdentifier(pointerTable, "The index version pointer table");
  }

  return {
    text: `/* read_replica:freshness_guard */
      SELECT (CASE WHEN (
          SELECT count(*)
          FROM unnest($1::text[], $2::integer[]) AS expected(doc_id, content_version)
          JOIN ${documentsTable} d
            ON d.doc_id = expected.doc_id AND d.content_version >= expected.content_version
        ) = cardinality($1::text[])${
          checksPointer
            ? `
        AND EXISTS (SELECT 1 FROM ${pointerTable} p WHERE p.singleton AND p.generation >= $3::bigint)`
            : ""
        }
        THEN '1' ELSE '${REPLICA_BEHIND_SENTINEL}' END)::integer AS fresh`,
    values: [[...expected.keys()], [...expected.values()], ...(checksPointer ? [String(generation)] : [])],
  };
};

// --- runtime state -------------------------------------------------------------

// Polls and the timer run in the context this resource was created in (module
// load), never in the request that happened to start the monitor: no tenant,
// trace or deadline of that request reaches them, and none is kept alive.
const monitorScope = new AsyncResource("ArchiveRagReadReplicaMonitor");

const defaultCreatePool = (options) => {
  const pool = new Pool(options);

  // An idle connection whose server went away emits 'error' on the pool; with
  // no listener that would end the process.
  pool.on("error", () => {});
  return pool;
};

let overrides = { createPool: defaultCreatePool, now: Date.now };
let runtime = null;

const zeroCounts = (reasons) => Object.fromEntries(reasons.map((reason) => [reason, 0]));

const createRuntime = (config) => ({
  bypasses: zeroCounts(READ_REPLICA_BYPASS_REASONS),
  config,
  fallbacks: zeroCounts(READ_REPLICA_FALLBACK_REASONS),
  monitor: { inFlight: null, lastStartedAt: null, started: false, stopped: false, timer: null },
  nextReplica: 0,
  primary: { checkedAt: null, errorCode: null, flushLsn: null, pollPool: null, state: "pending" },
  reads: { primary: 0, replica: 0 },
  replicas: config.replicas.map((replica) => ({
    ...replica,
    circuit: { consecutiveFailures: 0, openedAt: null, opens: 0, probeInFlight: false, state: "closed" },
    fallbacks: zeroCounts(READ_REPLICA_FALLBACK_REASONS),
    inFlight: 0,
    pollPool: null,
    pool: null,
    reads: 0,
    status: { checkedAt: null, errorCode: null, inRecovery: null, replayLsn: null, replayPaused: null, state: "pending" },
  })),
  // Primary flush LSN samples, oldest first; equal LSNs share one entry whose
  // time is the newest. See computeReplicaLag.
  samples: [],
  truncatedAt: null,
});

// A new configuration, or another primary, starts over: new pools, new
// samples, new counts.
const runtimeKey = (config) =>
  JSON.stringify({
    ...config,
    primary: getPostgresDatabaseUrl().trim(),
    replicas: config.replicas.map((replica) => replica.url),
  });

const endPools = (state) =>
  Promise.all(
    [state.primary.pollPool, ...state.replicas.flatMap((replica) => [replica.pool, replica.pollPool])]
      .filter(Boolean)
      .map((pool) => pool.end().catch(() => {}))
  );

const stopMonitor = (state) => {
  state.monitor.stopped = true;

  if (state.monitor.timer) {
    clearTimeout(state.monitor.timer);
    state.monitor.timer = null;
  }
};

const getRuntime = () => {
  const config = getReadReplicaConfig();
  const key = runtimeKey(config);

  if (runtime?.key !== key) {
    if (runtime) {
      const previous = runtime.state;

      stopMonitor(previous);
      void Promise.resolve(previous.monitor.inFlight)
        .catch(() => {})
        .then(() => endPools(previous));
    }

    runtime = { key, state: createRuntime(config) };
  }

  return runtime.state;
};

const sslOption = () => (isPostgresSslEnabled() ? { rejectUnauthorized: false } : undefined);

const replicaPoolOptions = (url, config, { max }) => ({
  connectionString: url,
  connectionTimeoutMillis: config.connectTimeoutMs,
  keepAlive: true,
  max,
  ssl: sslOption(),
});

const getReplicaPool = (state, replica) => {
  if (!replica.pool) {
    replica.pool = overrides.createPool(replicaPoolOptions(replica.url, state.config, { max: state.config.poolMax }));
  }

  return replica.pool;
};

// One connection per node for the poller, apart from the read pools, with a
// client-side bound on each poll and a name pg_stat_activity shows.
export const READ_REPLICA_MONITOR_APPLICATION_NAME = "archive-rag-replica-monitor";

const pollPoolOptions = (url, config) => ({
  ...replicaPoolOptions(url, config, { max: 1 }),
  application_name: READ_REPLICA_MONITOR_APPLICATION_NAME,
  query_timeout: config.connectTimeoutMs,
});

const pollQuery = async (pool, text) => {
  const client = await pool.connect();

  try {
    const result = await client.query(text);

    client.release();
    return result;
  } catch (error) {
    client.release(error);
    throw error;
  }
};

// --- lag -------------------------------------------------------------------------

const addPrimarySample = (state, lsn, at) => {
  const last = state.samples.at(-1);

  if (last && lsn === last.lsn) {
    // An unchanged position only refreshes the newest time it was the
    // primary's.
    last.at = at;
    return;
  }

  if (last && lsn < last.lsn) {
    // A primary's flushed position never moves back: this is another server
    // (a failover), and the old samples say nothing about it.
    state.samples = [];
    state.truncatedAt = null;
  }

  state.samples.push({ at, lsn });
};

// Index of the newest sample at or below `replayLsn`, or -1.
const findReplayedSample = (samples, replayLsn) => {
  let low = 0;
  let high = samples.length - 1;
  let found = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (samples[middle].lsn <= replayLsn) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
};

/**
 * { lagMs, behindSince } for one replica at `now`. lagMs is now minus the time
 * of the newest primary sample the replica has replayed past, null when it has
 * replayed past none (unknown, unless samples it might have passed were
 * dropped, in which case it is at least as old as the oldest one kept).
 * behindSince is when the primary was first seen past the replica's replay
 * position (null when it is not behind any sample).
 */
export const computeReplicaLag = ({ now, replayLsn, samples, truncatedAt = null }) => {
  if (replayLsn === null || replayLsn === undefined || samples.length === 0) {
    return { behindSince: null, lagMs: null };
  }

  const index = findReplayedSample(samples, replayLsn);
  const behindSince = index + 1 < samples.length ? samples[index + 1].at : null;

  if (index >= 0) {
    return { behindSince, lagMs: Math.max(0, now - samples[index].at) };
  }

  return { behindSince, lagMs: truncatedAt === null ? null : Math.max(0, now - truncatedAt) };
};

// Samples older than the newest one every replica has replayed past are of no
// further use. The rest are capped so a replica that stays far behind cannot
// grow the list without bound; the cap covers several lag windows, so a
// replica whose sample was dropped is already well past the limit.
const pruneSamples = (state) => {
  const { samples } = state;
  let keepFrom = samples.length;

  for (const replica of state.replicas) {
    const index =
      replica.status.replayLsn === null ? 0 : Math.max(0, findReplayedSample(samples, replica.status.replayLsn));

    keepFrom = Math.min(keepFrom, index);
  }

  if (keepFrom > 0) {
    samples.splice(0, keepFrom);
  }

  const cap = 4 * Math.ceil((state.config.maxLagMs + state.config.pollMs) / state.config.pollMs) + 16;

  if (samples.length > cap) {
    const dropped = samples.splice(0, samples.length - cap);

    state.truncatedAt = dropped.at(-1).at;
  }
};

const pollPrimary = async (state) => {
  const url = getPostgresDatabaseUrl().trim();

  if (!url) {
    state.primary = { ...state.primary, errorCode: "NOT_CONFIGURED", state: "error" };
    return;
  }

  const at = overrides.now();

  try {
    state.primary.pollPool ??= overrides.createPool(pollPoolOptions(url, state.config));

    const result = await pollQuery(state.primary.pollPool, "SELECT pg_current_wal_flush_lsn()::text AS lsn");
    const lsn = parseLsn(result?.rows?.[0]?.lsn);

    if (lsn === null) {
      throw Object.assign(new Error("The primary reported no WAL position."), { code: "NO_LSN" });
    }

    addPrimarySample(state, lsn, at);
    state.primary = { ...state.primary, checkedAt: at, errorCode: null, flushLsn: lsn, state: "ok" };
  } catch (error) {
    state.primary = { ...state.primary, checkedAt: at, errorCode: toErrorCode(error), state: "error" };
  }
};

const pollReplica = async (state, replica) => {
  const at = overrides.now();

  try {
    replica.pollPool ??= overrides.createPool(pollPoolOptions(replica.url, state.config));

    const result = await pollQuery(
      replica.pollPool,
      `SELECT pg_is_in_recovery() AS in_recovery,
              pg_last_wal_replay_lsn()::text AS replay_lsn,
              CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused() END AS replay_paused`
    );
    const row = result?.rows?.[0] ?? {};
    const inRecovery = row.in_recovery === true;
    const replayLsn = parseLsn(row.replay_lsn);

    replica.status = {
      checkedAt: at,
      errorCode: null,
      inRecovery,
      replayLsn: inRecovery ? replayLsn : null,
      replayPaused: inRecovery ? row.replay_paused === true : null,
      // A server that is not in recovery (a promoted replica, or the primary
      // itself) receives none of the primary's writes.
      state: !inRecovery ? "not_standby" : row.replay_paused === true ? "paused" : "streaming",
    };
  } catch (error) {
    replica.status = { ...replica.status, checkedAt: at, errorCode: toErrorCode(error), state: "unreachable" };
  }
};

// The primary first: a replica position read after a primary sample can only
// be further along.
const pollOnce = async (state) => {
  await pollPrimary(state);
  await Promise.all(state.replicas.map((replica) => pollReplica(state, replica)));
  pruneSamples(state);
};

// Joins the poll in flight, or starts one unless the last one started less
// than a poll interval ago: primary samples are then at least that far apart,
// however often health asks, which is what lets the sample cap (pruneSamples)
// cover several lag windows.
const runPoll = (state) => {
  if (state.monitor.inFlight) {
    return state.monitor.inFlight;
  }

  const now = overrides.now();

  if (state.monitor.lastStartedAt !== null && now - state.monitor.lastStartedAt < state.config.pollMs) {
    return Promise.resolve();
  }

  state.monitor.lastStartedAt = now;
  state.monitor.inFlight = pollOnce(state)
    .catch(() => {})
    .finally(() => {
      state.monitor.inFlight = null;
    });

  return state.monitor.inFlight;
};

const scheduleNextPoll = (state) => {
  if (state.monitor.stopped) {
    return;
  }

  monitorScope.runInAsyncScope(() => {
    state.monitor.timer = setTimeout(() => {
      state.monitor.timer = null;
      runPoll(state).then(() => scheduleNextPoll(state));
    }, state.config.pollMs);
    state.monitor.timer.unref?.();
  });
};

const ensureMonitor = (state) => {
  if (state.monitor.started) {
    return;
  }

  state.monitor.started = true;
  monitorScope.runInAsyncScope(() => {
    runPoll(state).then(() => scheduleNextPoll(state));
  });
};

/**
 * Polls the primary and every replica now (or joins the poll in flight, or
 * does nothing when the last poll started less than a poll interval ago) and
 * resolves once that is done. Starts the background monitor if it was not
 * running. Health and tests use it; reads never wait for a poll.
 */
export const pollReadReplicasNow = async () => {
  if (!isReadReplicaRoutingEnabled()) {
    return;
  }

  const state = getRuntime();

  ensureMonitor(state);
  await monitorScope.runInAsyncScope(() => runPoll(state));
};

// --- choosing a replica ----------------------------------------------------------

const describeLag = (state, replica, now) =>
  computeReplicaLag({ now, replayLsn: replica.status.replayLsn, samples: state.samples, truncatedAt: state.truncatedAt });

// Why `replica` cannot take a read now, or null. Moves an open circuit whose
// cooldown has passed to half-open.
const exclusionOf = (state, replica, now) => {
  const { circuit } = replica;

  if (circuit.state === "open") {
    if (now - circuit.openedAt < state.config.circuitCooldownMs) {
      return "circuit_open";
    }

    circuit.state = "half_open";
  }

  if (circuit.state === "half_open" && circuit.probeInFlight) {
    return "circuit_open";
  }

  if (replica.status.state === "unreachable" || replica.status.state === "not_standby") {
    return "replica_down";
  }

  const { lagMs } = describeLag(state, replica, now);

  if (lagMs === null) {
    return "lag_unknown";
  }

  if (lagMs > state.config.maxLagMs) {
    return "lag_exceeded";
  }

  if (replica.inFlight >= state.config.poolMax) {
    return "replica_saturated";
  }

  return null;
};

const EXCLUSION_PRIORITY = ["replica_saturated", "lag_exceeded", "lag_unknown", "circuit_open", "replica_down"];

const settle = (state, replica, outcome) => {
  replica.inFlight = Math.max(0, replica.inFlight - 1);

  const { circuit } = replica;
  const wasProbe = circuit.probeInFlight;

  circuit.probeInFlight = false;

  if (outcome === "replica_unavailable") {
    circuit.consecutiveFailures += 1;

    if (wasProbe || circuit.consecutiveFailures >= state.config.circuitFailureThreshold) {
      if (circuit.state !== "open") {
        circuit.opens += 1;
      }

      circuit.state = "open";
      circuit.openedAt = overrides.now();
    }

    return;
  }

  // Any answer from the server (rows, or an error it sent) proves the way to
  // it works.
  circuit.consecutiveFailures = 0;
  circuit.state = "closed";
  circuit.openedAt = null;
};

/**
 * A replica for one read, or why there is none: { replica: { id, pool },
 * succeeded(), failed(error) -> reason } or { reason }. The least busy usable
 * replica wins, ties in turn. `succeeded` / `failed` settle the lease exactly
 * once, update the replica's circuit and count the read; `failed` returns the
 * fallback reason (the caller counts the primary read).
 */
export const acquireReadReplica = () => {
  const state = getRuntime();
  const now = overrides.now();

  ensureMonitor(state);

  const usable = [];
  const exclusions = new Set();

  for (const replica of state.replicas) {
    const exclusion = exclusionOf(state, replica, now);

    if (exclusion) {
      exclusions.add(exclusion);
    } else {
      usable.push(replica);
    }
  }

  if (usable.length === 0) {
    return { reason: EXCLUSION_PRIORITY.find((reason) => exclusions.has(reason)) ?? "replica_down" };
  }

  const count = state.replicas.length;
  const order = (replica) => (state.replicas.indexOf(replica) - state.nextReplica + count) % count;
  const chosen = usable.reduce((best, replica) =>
    replica.inFlight < best.inFlight || (replica.inFlight === best.inFlight && order(replica) < order(best))
      ? replica
      : best
  );

  state.nextReplica = (state.replicas.indexOf(chosen) + 1) % count;
  chosen.inFlight += 1;

  if (chosen.circuit.state === "half_open") {
    chosen.circuit.probeInFlight = true;
  }

  let settled = false;

  return {
    failed: (error) => {
      const reason = classifyReplicaError(error);

      if (!settled) {
        settled = true;
        settle(state, chosen, reason);
        chosen.fallbacks[reason] += 1;
      }

      return reason;
    },
    replica: { id: chosen.id, pool: getReplicaPool(state, chosen) },
    succeeded: () => {
      if (!settled) {
        settled = true;
        settle(state, chosen, "ok");
        chosen.reads += 1;
        state.reads.replica += 1;
      }
    },
  };
};

/**
 * Counts one read-only statement the primary answers. `fallback: true` when a
 * replica could have taken it (the reason is a fallback reason), otherwise
 * the reason is a bypass reason.
 */
export const recordPrimaryRead = (reason, { fallback = false } = {}) => {
  if (!isReadReplicaRoutingEnabled()) {
    return;
  }

  const state = getRuntime();
  const counts = fallback ? state.fallbacks : state.bypasses;

  state.reads.primary += 1;

  if (Object.hasOwn(counts, reason)) {
    counts[reason] += 1;
  }
};

const toIso = (at) => (at === null || at === undefined ? null : new Date(at).toISOString());

/**
 * Counters and per-replica state for metrics and health: reads answered by a
 * replica and by the primary, fallbacks and bypasses by reason, and each
 * replica's lag, state, circuit and load. Ids and host:port only, never a URL.
 * `{ enabled: false }` when POSTGRES_READ_REPLICA_URLS is unset; throws on an
 * invalid configuration. Reading it starts the lag monitor.
 */
export const getReplicaRoutingSnapshot = () => {
  if (!isReadReplicaRoutingEnabled()) {
    return { enabled: false };
  }

  const state = getRuntime();
  const now = overrides.now();

  ensureMonitor(state);

  return {
    bypasses: { ...state.bypasses },
    config: {
      circuitCooldownMs: state.config.circuitCooldownMs,
      circuitFailureThreshold: state.config.circuitFailureThreshold,
      connectTimeoutMs: state.config.connectTimeoutMs,
      maxLagMs: state.config.maxLagMs,
      pollMs: state.config.pollMs,
      poolMax: state.config.poolMax,
    },
    enabled: true,
    fallbacks: { ...state.fallbacks },
    // Top level as well, where rag/metrics-postgres.js reads it.
    maxLagMs: state.config.maxLagMs,
    primary: {
      checkedAt: toIso(state.primary.checkedAt),
      errorCode: state.primary.errorCode,
      flushLsn: formatLsn(state.primary.flushLsn),
      // Flush positions the lag is measured against (bounded, see pruneSamples).
      samples: state.samples.length,
      state: state.primary.state,
    },
    reads: { ...state.reads },
    replicas: state.replicas.map((replica) => {
      const { behindSince, lagMs } = describeLag(state, replica, now);
      const exclusion = exclusionOf(state, replica, now);

      return {
        behindSince: toIso(behindSince),
        checkedAt: toIso(replica.status.checkedAt),
        circuit: {
          consecutiveFailures: replica.circuit.consecutiveFailures,
          openedAt: toIso(replica.circuit.openedAt),
          opens: replica.circuit.opens,
          state: replica.circuit.state,
        },
        endpoint: replica.endpoint,
        errorCode: replica.status.errorCode,
        fallbacks: { ...replica.fallbacks },
        id: replica.id,
        inFlight: replica.inFlight,
        lagMs,
        reads: replica.reads,
        replayLsn: formatLsn(replica.status.replayLsn),
        replayPaused: replica.status.replayPaused,
        state: replica.status.state,
        // Why the next read would skip it right now, or null when it would
        // take it.
        usable: exclusion === null,
        exclusion,
      };
    }),
  };
};

/**
 * The health entry: "ok" while every replica is usable, otherwise "warning",
 * never "error" for lag, a down replica or an open circuit, so a lagging
 * replica cannot take the service out of rotation (reads fall back to the
 * primary). Only an invalid configuration is an error. Null when unset.
 */
export const checkReadReplicaHealth = async () => {
  if (!hasReadReplicaConfiguration()) {
    return null;
  }

  try {
    getReadReplicaConfig();
  } catch (error) {
    return { message: error.message, status: "error" };
  }

  await pollReadReplicasNow();

  const snapshot = getReplicaRoutingSnapshot();
  const usable = snapshot.replicas.filter((replica) => replica.usable).length;

  return {
    status: usable === snapshot.replicas.length ? "ok" : "warning",
    message:
      usable === snapshot.replicas.length
        ? `Every read replica is within ${snapshot.config.maxLagMs} ms of the primary.`
        : usable > 0
          ? `${snapshot.replicas.length - usable} of ${snapshot.replicas.length} read replicas are skipped; the others and the primary take the reads.`
          : "No read replica is usable; the primary takes every read.",
    maxLagMs: snapshot.config.maxLagMs,
    primary: snapshot.primary,
    replicas: snapshot.replicas.map((replica) => ({
      circuit: replica.circuit.state,
      endpoint: replica.endpoint,
      exclusion: replica.exclusion,
      id: replica.id,
      lagMs: replica.lagMs,
      replayPaused: replica.replayPaused,
      state: replica.state,
    })),
  };
};

/**
 * Stops the monitor, ends every replica and poll pool and forgets every count.
 * rag/postgres.js calls it from resetPostgresPool.
 */
export const resetReadReplicas = async () => {
  const previous = runtime?.state ?? null;

  runtime = null;

  if (previous) {
    stopMonitor(previous);
    await previous.monitor.inFlight?.catch(() => {});
    await endPools(previous);
  }
};

/**
 * Test seam: `now` (the clock every lag and circuit decision reads) and
 * `createPool` (pool options -> pool). Resets the state; null restores both.
 */
export const configureReadReplicaRouting = async ({ createPool = null, now = null } = {}) => {
  await resetReadReplicas();
  overrides = { createPool: createPool ?? defaultCreatePool, now: now ?? Date.now };
};
