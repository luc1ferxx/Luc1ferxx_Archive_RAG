import { getMetricsRegistry, isMetricsEnabled } from "./metrics.js";

// PostgreSQL as this process sees it:
//   - the primary pool's clients (total, idle, waiting), read on scrape and
//     only when the pool exists: a scrape never opens one.
//   - statement errors by SQLSTATE class (`23` integrity, `40` transaction
//     rollback, `57` operator intervention, `08` connection, ...), plus
//     `network`, `pool_timeout`, `client_timeout` and `tenant_pipeline` for
//     failures the server never classified. postgres.js reports what reaches
//     its pooled-client and pool.query paths; an error a caller caught and
//     retried inside its own transaction callback is not seen. Errors that are
//     not database errors (an application error thrown inside a transaction)
//     are not counted.
//   - read replicas, when rag/postgres-replicas.js exists: its
//     getReplicaRoutingSnapshot() is read on scrape (reads by target,
//     fallbacks to the primary by reason, lag per replica and the configured
//     maximum), in a process that retrieves only (collectReplicaRouting).
//     Elsewhere, and without the module, the replica families stay empty.

// SQLSTATE classes are two digits, or F0, HV, P0, XX: an application code of
// five capitals ("EPIPE", "ABORT") is not one.
const SQLSTATE_PATTERN = /^(?:[0-9]{2}|F0|HV|P0|XX)[0-9A-Z]{3}$/u;
const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);
const TENANT_PIPELINE_STATUS_ERROR_CODE = "ARCHIVE_RAG_TENANT_PIPELINE_STATUS";

const registry = getMetricsRegistry();

const poolClients = registry.gauge({
  help: "Clients of this process's primary PostgreSQL pool: total (open), idle, and waiting (callers queued for a client).",
  labelNames: ["state"],
  name: "archive_rag_postgres_pool_clients",
});
const statementErrors = registry.counter({
  help: "Failed PostgreSQL statements by SQLSTATE class (two characters), or network, pool_timeout, client_timeout, tenant_pipeline.",
  labelNames: ["sqlstate_class"],
  name: "archive_rag_postgres_statement_errors_total",
});
const reads = registry.counter({
  help: "Reads routed by the replica router, by target (from getReplicaRoutingSnapshot).",
  labelNames: ["target"],
  name: "archive_rag_postgres_reads_total",
});
const replicaFallbacks = registry.counter({
  help: "Reads the replica router sent to the primary instead of a replica, by reason.",
  labelNames: ["reason"],
  name: "archive_rag_postgres_replica_fallbacks_total",
});
const replicaLag = registry.gauge({
  help: "Replication lag of each configured read replica (the router's replica id, or its position), in seconds.",
  labelNames: ["replica"],
  name: "archive_rag_postgres_replica_lag_seconds",
});
const replicaMaxLag = registry.gauge({
  help: "The lag above which the replica router stops reading from a replica, in seconds.",
  name: "archive_rag_postgres_replica_max_lag_seconds",
});

/** The sqlstate_class label of a failed statement, or null when it is not a database failure. */
export const classifyPostgresError = (error) => {
  const code = String(error?.code ?? "").toUpperCase();

  if (code === TENANT_PIPELINE_STATUS_ERROR_CODE) {
    return "tenant_pipeline";
  }

  if (NETWORK_ERROR_CODES.has(code)) {
    return "network";
  }

  if (SQLSTATE_PATTERN.test(code)) {
    return code.slice(0, 2);
  }

  const message = String(error?.message ?? "");

  // node-postgres raises these without a code.
  if (/timeout exceeded when trying to connect/iu.test(message)) {
    return "pool_timeout";
  }

  if (/^Query read timeout$/u.test(message) || /Connection terminated/iu.test(message)) {
    return /timeout/iu.test(message) ? "client_timeout" : "network";
  }

  return null;
};

/** Counts `error` when it is a database failure; never throws. */
export const notePostgresStatementError = (error) => {
  if (!isMetricsEnabled()) {
    return;
  }

  const sqlstateClass = classifyPostgresError(error);

  if (sqlstateClass) {
    statementErrors.inc({ sqlstate_class: sqlstateClass });
  }
};

/**
 * Counts `error` (notePostgresStatementError) and throws it on: the caller
 * always sees the original error, whatever happens to the count.
 */
export const rethrowPostgresError = (error) => {
  try {
    notePostgresStatementError(error);
  } catch {
    // Counting is best effort.
  }

  throw error;
};

export const collectPostgresPool = async () => {
  const { peekPostgresPool } = await import("./postgres.js");
  const pool = typeof peekPostgresPool === "function" ? peekPostgresPool() : null;

  if (!pool) {
    poolClients.clear();
    return;
  }

  poolClients.set({ state: "total" }, Number(pool.totalCount) || 0);
  poolClients.set({ state: "idle" }, Number(pool.idleCount) || 0);
  poolClients.set({ state: "waiting" }, Number(pool.waitingCount) || 0);
};

const toSeconds = (seconds, milliseconds) => {
  const value = Number(seconds);

  if (Number.isFinite(value)) {
    return value;
  }

  const ms = Number(milliseconds);

  return Number.isFinite(ms) ? ms / 1000 : null;
};

// The router's own id (`replica-0`) when it is a plain identifier, otherwise
// the replica's position; never an endpoint or a URL.
const REPLICA_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/iu;

const toReplicaLabel = (id, index) =>
  typeof id === "string" && REPLICA_ID_PATTERN.test(id) ? id : String(index);

const countEntries = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];

/**
 * Fills the replica families from one getReplicaRoutingSnapshot() result. It
 * accepts `reads`/`readsByTarget` and `fallbacks`/`fallbacksByReason`
 * ({ name: running count }), `replicas` ([{ id, lagSeconds | lagMs }]) or a
 * single `lagSeconds`/`lagMs`, and `maxLagSeconds`/`maxLagMs`.
 */
export const applyReplicaRoutingSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") {
    return;
  }

  for (const [target, count] of countEntries(snapshot.readsByTarget ?? snapshot.reads)) {
    reads.setTotal({ target }, Number(count) || 0);
  }

  for (const [reason, count] of countEntries(snapshot.fallbacksByReason ?? snapshot.fallbacks)) {
    replicaFallbacks.setTotal({ reason }, Number(count) || 0);
  }

  replicaLag.clear();

  if (Array.isArray(snapshot.replicas)) {
    snapshot.replicas.forEach((replica, index) => {
      const lag = toSeconds(replica?.lagSeconds, replica?.lagMs);

      if (lag !== null) {
        replicaLag.set({ replica: toReplicaLabel(replica?.id, index) }, lag);
      }
    });
  } else {
    const lag = toSeconds(snapshot.lagSeconds, snapshot.lagMs);

    if (lag !== null) {
      replicaLag.set({ replica: "0" }, lag);
    }
  }

  const maxLag = toSeconds(snapshot.maxLagSeconds, snapshot.maxLagMs);

  if (maxLag !== null) {
    replicaMaxLag.set(maxLag);
  }
};

let replicaModule;

const loadReplicaModule = async () => {
  if (replicaModule === undefined) {
    try {
      replicaModule = await import("./postgres-replicas.js");
    } catch (error) {
      // Only the module itself missing counts as "no replicas in this build";
      // a broken import inside it is an error worth seeing.
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !String(error?.message ?? "").includes("postgres-replicas")) {
        throw error;
      }

      replicaModule = null;
    }
  }

  return replicaModule;
};

// Reading the router's snapshot starts its lag monitor, which polls the
// primary and every replica from then on. Only the dense search reads from a
// replica, so, like the health report's readReplicas check (health.js), only a
// process that retrieves in process reads it: role retrieval, or a process
// that runs the agent without RETRIEVAL_SERVICE_URL. A scrape of the edge, a
// remote-retrieval agent tier or the model gateway leaves the router alone.
const retrievesInProcess = async () => {
  const { getServiceRole, hostsServiceTier, isRemoteRetrievalEnabled } = await import("./service-topology.js");

  return getServiceRole() === "retrieval" || (hostsServiceTier("agent") && !isRemoteRetrievalEnabled());
};

export const collectReplicaRouting = async () => {
  if (!(await retrievesInProcess())) {
    return;
  }

  const module = await loadReplicaModule();

  if (typeof module?.getReplicaRoutingSnapshot === "function") {
    applyReplicaRoutingSnapshot(await module.getReplicaRoutingSnapshot());
  }
};

registry.addCollector("postgres_pool", collectPostgresPool);
registry.addCollector("postgres_replicas", collectReplicaRouting);
