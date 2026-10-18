import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import {
  getPostgresConnectionTimeoutMs,
  getPostgresDatabaseUrl,
  getPostgresIdleInTransactionTimeoutMs,
  getPostgresMigrationDatabaseUrl,
  getPostgresPoolMax,
  getPostgresRowLevelSecurityMode,
  getPostgresStatementTimeoutMs,
  getPostgresSystemRole,
  getPostgresTenantContextMode,
  getPostgresTenantRole,
  isLongMemoryEnabled,
  isPostgresRoleSplitEnabled,
} from "./config.js";
import { rethrowPostgresError } from "./metrics-postgres.js";
import { buildPostgresSslOption, describePostgresTlsHealth } from "./postgres-tls.js";
import {
  acquireReadReplica,
  hasReadReplicaConfiguration,
  isReadReplicaRoutingEnabled,
  parseReadReplicaUrls,
  recordPrimaryRead,
  resetReadReplicas,
} from "./postgres-replicas.js";
import {
  DATABASE_TENANT_CONTEXTS,
  getActiveDatabaseTenant,
  getDatabaseTenantContext,
} from "./postgres-tenant.js";

const { DatabaseError, Pool, Query } = pg;
const { prepareValue } = pg.utils;

let postgresPool = null;
// The owner pool of the role split (POSTGRES_MIGRATION_DATABASE_URL); null
// while the split is off, when the one pool above logs in as the owner.
let migrationPool = null;

const getConnectionString = () => getPostgresDatabaseUrl().trim();

export const isPostgresConfigured = () =>
  Boolean(getConnectionString());

const getConnectionConfig = () => {
  const connectionString = getConnectionString();

  if (!connectionString) {
    throw new Error(
      "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is required when PostgreSQL-backed storage is enabled."
    );
  }

  return {
    connectionString,
    // POSTGRES_SSL_ENABLED / POSTGRES_SSL_MODE / POSTGRES_SSL_CA_FILE, read
    // here, when a pool or dedicated client is built (rag/postgres-tls.js).
    ssl: buildPostgresSslOption({ connectionString, label: "POSTGRES_DATABASE_URL" }),
  };
};

// POSTGRES_POOL_MAX and POSTGRES_CONNECTION_TIMEOUT_MS, read when the pool is
// created (resetPostgresPool makes the next call read them again). Their
// defaults are node-pg's own (10 connections; 0 = wait for a connection, or
// for a free slot of a busy pool, without a bound), so an unset environment
// builds the same pool as before they existed.
export const getPostgresPoolOptions = () => ({
  ...getConnectionConfig(),
  connectionTimeoutMillis: getPostgresConnectionTimeoutMs(),
  max: getPostgresPoolMax(),
});

// pg-pool re-emits an idle client's error (the server restarted, failed over or
// ended the session) on the pool, and an EventEmitter without an 'error'
// listener throws, which ended the process. The pool has already discarded
// that client, so the next statement opens a fresh connection; the error is
// only logged. Leased clients are covered by withPooledClient's own listener.
const watchIdleClientErrors = (pool, name) => {
  pool.on("error", (error) => {
    console.warn(
      `[postgres] idle ${name} connection closed: ${error?.code ?? error?.message ?? "unknown error"}`
    );
  });

  return pool;
};

export const getPostgresPool = () => {
  if (postgresPool) {
    return postgresPool;
  }

  postgresPool = watchIdleClientErrors(new Pool(getPostgresPoolOptions()), "runtime");

  return postgresPool;
};

// Owner work is short and sequential (one migration, one version table's
// DDL, one drop attempt at a time), so the owner pool stays small; idle owner
// sessions close after node-pg's idle timeout instead of staying open next to
// the runtime pool.
const MIGRATION_POOL_MAX = 2;

/**
 * The owner pool's options: POSTGRES_MIGRATION_DATABASE_URL with the runtime
 * pool's SSL and connect-timeout settings.
 */
export const getPostgresMigrationPoolOptions = () => ({
  connectionString: getPostgresMigrationDatabaseUrl(),
  connectionTimeoutMillis: getPostgresConnectionTimeoutMs(),
  max: MIGRATION_POOL_MAX,
  ssl: buildPostgresSslOption({
    connectionString: getPostgresMigrationDatabaseUrl(),
    label: "POSTGRES_MIGRATION_DATABASE_URL",
  }),
});

const getPostgresMigrationPool = () => {
  if (migrationPool) {
    return migrationPool;
  }

  migrationPool = watchIdleClientErrors(new Pool(getPostgresMigrationPoolOptions()), "owner");

  return migrationPool;
};

/** The pool if one exists, without creating it (rag/metrics-postgres.js). */
export const peekPostgresPool = () => postgresPool;

/**
 * A connection of its own, outside the pool, for a session that has to stay
 * open between statements (LISTEN). It logs in with POSTGRES_DATABASE_URL --
 * the owner without the role split, the runtime login with it (LISTEN needs
 * no privilege, and the session never switches role) -- and never carries a
 * tenant, so it may not be created under one: nothing it runs is scoped by
 * row-level security. The caller connects it, owns it and ends it. TCP
 * keepalive lets a connection whose peer vanished fail instead of idling
 * silently forever.
 */
export const createDedicatedPostgresClient = () => {
  assertDatabaseContextBound("createDedicatedPostgresClient");

  if (getEnforcedDatabaseTenant()) {
    throw new Error(
      "createDedicatedPostgresClient cannot run under a database tenant; a dedicated session always acts as the owner."
    );
  }

  return new pg.Client({
    ...getConnectionConfig(),
    // The pool's bound on connecting (0 = none), so a LISTEN session to an
    // unreachable server fails into its reconnect backoff.
    connectionTimeoutMillis: getPostgresConnectionTimeoutMs(),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
};

// The tenant settings the row-level security policies read (migration 013).
// Setting `role` through set_config is SET LOCAL ROLE: it lasts until the
// transaction ends, so a pooled connection never leaves the transaction still
// acting as a tenant. The role and the ids travel as bind parameters, never in
// the SQL text.
//
// The same step sets the tenant work's limits, transaction-locally as well:
// statement_timeout (POSTGRES_STATEMENT_TIMEOUT_MS) bounds every statement of
// the tenant transaction, idle_in_transaction_session_timeout
// (POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS) ends a tenant transaction whose
// caller stopped sending statements while holding it open. They are bind
// parameters too, so the text never changes; a limit that is off goes out as
// NULL and its setting is set to its own current value, which leaves whatever
// the server, database or login role configured in force. No round trip is
// added: this is the step that already carried the tenant settings.
const TENANT_SETTINGS_SQL = `
  SELECT
    set_config('role', $1, true),
    set_config('archive_rag.user_id', $2, true),
    set_config('archive_rag.workspace_id', $3, true),
    set_config('statement_timeout', COALESCE($4::text, current_setting('statement_timeout')), true),
    set_config(
      'idle_in_transaction_session_timeout',
      COALESCE($5::text, current_setting('idle_in_transaction_session_timeout')),
      true
    )
`;

// With the role split on, system and unscoped work switches into the system
// role (POSTGRES_SYSTEM_ROLE, migration 035) the same way: SET LOCAL ROLE
// through set_config, the role as a bind parameter, in the same round trip as
// the statement. Nothing else is set: system work never gets the tenant ids
// (the system_access policies do not read them) nor the tenant work's limits
// (owner work never had them either).
const SYSTEM_SETTINGS_SQL = "SELECT set_config('role', $1, true)";

// ReadyForQuery transaction status: idle, in a transaction block, in a failed
// transaction block.
const TRANSACTION_IDLE = "I";
const TRANSACTION_IN_BLOCK = "T";

export const TENANT_PIPELINE_STATUS_ERROR_CODE = "ARCHIVE_RAG_TENANT_PIPELINE_STATUS";
export const TENANT_CONTEXT_MISSING_ERROR_CODE = "ARCHIVE_RAG_TENANT_CONTEXT_MISSING";

export const getEnforcedDatabaseTenant = () =>
  getPostgresRowLevelSecurityMode() === "enforce" ? getActiveDatabaseTenant() : null;

/**
 * POSTGRES_TENANT_CONTEXT=strict with row-level security enforced: a database
 * call whose chain is bound to nothing (rag/postgres-tenant.js) throws instead
 * of running as the owner. A request is bound by bindDatabaseTenant, a stored
 * record's work by runWithDatabaseTenant, system work by runAsDatabaseSystem;
 * a call that arrives unbound skipped all three or lost its async context on
 * the way, and on the owner path it would see every tenant's rows. Every
 * refusal is logged with its stack, the only pointer to the call site that
 * lost the context. Lenient (the default) and RLS off keep the owner path.
 */
const assertDatabaseContextBound = (operation) => {
  if (getPostgresTenantContextMode() !== "strict" || getPostgresRowLevelSecurityMode() !== "enforce") {
    return;
  }

  if (getDatabaseTenantContext() !== DATABASE_TENANT_CONTEXTS.unbound) {
    return;
  }

  const error = new Error(
    `${operation} ran with no database tenant context while POSTGRES_TENANT_CONTEXT=strict; bind the request with bindDatabaseTenant, a record's work with runWithDatabaseTenant, or system work with runAsDatabaseSystem.`
  );

  error.code = TENANT_CONTEXT_MISSING_ERROR_CODE;
  console.error(`[postgres] ${TENANT_CONTEXT_MISSING_ERROR_CODE}: ${error.stack}`);
  throw error;
};

// A limit as its set_config value: milliseconds as text, or null for "leave
// the current value" (see TENANT_SETTINGS_SQL).
const toTimeoutSetting = (milliseconds) => (milliseconds > 0 ? String(milliseconds) : null);

const getTenantSettingsValues = (tenant) => [
  getPostgresTenantRole(),
  tenant.userId,
  tenant.workspaceId,
  toTimeoutSetting(getPostgresStatementTimeoutMs()),
  toTimeoutSetting(getPostgresIdleInTransactionTimeoutMs()),
];

/**
 * Several statements in one round trip over the extended query protocol: a
 * Parse, Bind and Execute for each statement and one Sync after the last.
 * PostgreSQL runs everything before a Sync in one transaction: an implicit
 * one that the Sync commits, or rolls back at the first error (the statements
 * after it are skipped), unless a statement opened an explicit block (BEGIN),
 * which then stays open. SET LOCAL and set_config(..., true) last until that
 * transaction ends either way, so a tenant setting made by the first statement
 * applies to the next ones and to nothing after the Sync.
 *
 * The leading statements run for their effect: their rows and command tags are
 * dropped, and the result is the last statement's, the same object
 * client.query returns. Every value is serialized before the first message is
 * written, so a value that cannot be serialized fails the query before any of
 * it is sent, never after part of the pipeline went out without its Sync.
 *
 * The ReadyForQuery that answers the Sync carries the transaction status; a
 * successful pipeline whose status is not `expectedTransactionStatus` fails
 * with TENANT_PIPELINE_STATUS_ERROR_CODE (a statement text of BEGIN would
 * otherwise leave the connection inside a transaction as the tenant). The
 * status is recorded on the error path too: pg reports a server error at the
 * ErrorResponse, before the ReadyForQuery, so `settled` resolves with the
 * status once it arrives (null if the connection ends first), and
 * runPipeline waits for it before deciding whether the connection is reused.
 * It relies on pg's Submittable interface (submit plus the handle* callbacks
 * the client dispatches), which pg-cursor and pg-query-stream use too.
 */
class PipelinedQuery extends Query {
  constructor({ callback, expectedTransactionStatus, prelude, text, values }) {
    super({ callback, text, values });
    this.prelude = prelude;
    this.pendingPreludeResults = prelude.length;
    this.expectedTransactionStatus = expectedTransactionStatus;
    this.transactionStatus = null;
    // True once any message may have been written: from then on the server,
    // not the client, decides how the pipeline ends.
    this.sent = false;
    this.settled = null;
  }

  submit(connection) {
    if (typeof this.text !== "string" || !this.text) {
      return new Error("A pipelined query needs SQL text.");
    }

    if (!Array.isArray(this.values)) {
      return new Error("Query values must be an array");
    }

    let prelude;

    try {
      prelude = this.prelude.map((step) => ({
        text: step.text,
        values: (step.values ?? []).map((value) => prepareValue(value)),
      }));
      this.values = this.values.map((value) => prepareValue(value));
    } catch (error) {
      return error;
    }

    let settle;

    this.settled = new Promise((resolve) => {
      settle = resolve;
    });

    const onEnd = () => {
      connection.removeListener("readyForQuery", onReadyForQuery);
      settle(null);
    };
    // Prepended so it records the status before the client hands the
    // ReadyForQuery to handleReadyForQuery.
    const onReadyForQuery = (message) => {
      connection.removeListener("end", onEnd);
      this.transactionStatus = message?.status ?? null;
      settle(this.transactionStatus);
    };

    connection.prependOnceListener("readyForQuery", onReadyForQuery);
    connection.once("end", onEnd);
    this.sent = true;
    connection.stream?.cork?.();

    try {
      for (const step of prelude) {
        connection.parse({ name: "", text: step.text, types: [] });
        connection.bind({ portal: "", statement: "", values: step.values });
        connection.execute({ portal: "", rows: 0 });
      }

      // Parse, Bind, Describe, Execute and the Sync of the last statement.
      this.prepare(connection);
    } finally {
      connection.stream?.uncork?.();
    }

    return null;
  }

  handleRowDescription(message) {
    if (this.pendingPreludeResults > 0) {
      return;
    }

    super.handleRowDescription(message);
  }

  handleDataRow(message) {
    if (this.pendingPreludeResults > 0) {
      return;
    }

    super.handleDataRow(message);
  }

  handleCommandComplete(message, connection) {
    if (this.pendingPreludeResults > 0) {
      this.pendingPreludeResults -= 1;
      return;
    }

    super.handleCommandComplete(message, connection);
  }

  handleReadyForQuery(connection) {
    if (!this._canceledDueToError && this.transactionStatus !== this.expectedTransactionStatus) {
      const error = new Error(
        `A pipelined statement group ended with transaction status ${JSON.stringify(
          this.transactionStatus
        )} instead of ${JSON.stringify(this.expectedTransactionStatus)}; the connection is discarded.`
      );

      error.code = TENANT_PIPELINE_STATUS_ERROR_CODE;
      this._canceledDueToError = error;
    }

    super.handleReadyForQuery(connection);
  }
}

// pg's JavaScript client exposes the protocol connection the pipeline writes
// to; the native bindings do not, and keep the statement-per-round-trip path.
const canPipeline = (client) =>
  typeof client?.connection?.parse === "function" &&
  typeof client?.connection?.prependOnceListener === "function";

// The transaction status a failed pipeline left its connection in, or null
// when it cannot be known. Nothing sent: unchanged. A server error: the
// ReadyForQuery that answers the Sync follows it. A failure pg reports at the
// ReadyForQuery (a row it could not parse, an unexpected status): recorded.
// Any other failure after the pipeline went out (pg's client-side
// query_timeout, a lost socket): unknown.
const transactionStatusAfterFailure = async (query, error) => {
  if (!query.sent) {
    return query.expectedTransactionStatus;
  }

  if (query.transactionStatus !== null) {
    return query.transactionStatus;
  }

  return error instanceof DatabaseError ? query.settled : null;
};

// With a `lease`, a failed pipeline marks its connection for discarding
// unless it provably ended in `expectedTransactionStatus`, so a connection
// left inside a block (open or failed) or with an unfinished pipeline never
// returns to the pool. Without one, the caller cleans up (ROLLBACK).
const runPipeline = (client, { expectedTransactionStatus, lease = null, prelude, text, values }) =>
  new Promise((resolve, reject) => {
    const query = new PipelinedQuery({
      callback: (error, result) => {
        if (!error) {
          resolve(result);
          return;
        }

        if (!lease) {
          reject(error);
          return;
        }

        transactionStatusAfterFailure(query, error).then((status) => {
          if (status !== expectedTransactionStatus) {
            lease.discard = true;
          }

          reject(error);
        });
      },
      expectedTransactionStatus,
      prelude,
      text,
      values,
    });

    client.query(query);
  });

const tenantSettingsStep = (tenant) => ({
  text: TENANT_SETTINGS_SQL,
  values: getTenantSettingsValues(tenant),
});

const systemSettingsStep = () => ({
  text: SYSTEM_SETTINGS_SQL,
  values: [getPostgresSystemRole()],
});

/**
 * Who the current chain's statements run as, and the settings step that makes
 * them so (null: the login itself, no step).
 *
 *   enforced tenant   the tenant role and settings, with or without the split.
 *   split off         everything else runs as the login, which is the owner:
 *                     the statement counts and wire messages from before the
 *                     split existed.
 *   split on, bound   system and unscoped chains (and, with row-level security
 *                     off, tenant chains too: RLS off means no tenant role)
 *                     switch into the system role.
 *   split on, unbound the runtime login itself, which holds no table
 *                     privilege: the statement fails with a permission error
 *                     instead of reading every tenant (strict mode throws its
 *                     own error before).
 */
const resolveStatementRole = () => {
  const tenant = getEnforcedDatabaseTenant();

  if (tenant) {
    return { step: tenantSettingsStep(tenant), tenant };
  }

  if (!isPostgresRoleSplitEnabled() || getDatabaseTenantContext() === DATABASE_TENANT_CONTEXTS.unbound) {
    return { step: null, tenant: null };
  }

  return { step: systemSettingsStep(), tenant: null };
};

const withPooledClient = async (callback, getPool = getPostgresPool) => {
  const client = await getPool().connect().catch(rethrowPostgresError);
  // Set when the connection may still be inside a transaction or a pipeline
  // (a failed ROLLBACK, a pipeline that did not provably end idle): the pool
  // then destroys it instead of handing it to the next caller.
  const lease = { discard: false };
  // pg-pool listens for errors on idle clients only. A session the server ends
  // while a caller holds it between statements -- a tenant transaction past
  // POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS, pg_terminate_backend, a restart --
  // makes the checked-out client emit 'error' with no listener, which would
  // end the process. The lease listens instead: the connection is discarded
  // and the caller's next statement fails with pg's own error.
  const onClientError = () => {
    lease.discard = true;
  };

  client.on("error", onClientError);

  try {
    return await callback(client, lease);
  } catch (error) {
    rethrowPostgresError(error);
  } finally {
    client.removeListener("error", onClientError);
    client.release(
      lease.discard ? new Error("PostgreSQL connection discarded after an unfinished transaction.") : undefined
    );
  }
};

// The same lease rules on a read replica's pool. A failure there is the
// router's to judge (the read falls back to the primary), so it is not counted
// as a statement error.
const withReplicaClient = async (pool, callback) => {
  const client = await pool.connect();
  const lease = { discard: false };

  try {
    return await callback(client, lease);
  } finally {
    client.release(
      lease.discard ? new Error("PostgreSQL connection discarded after an unfinished transaction.") : undefined
    );
  }
};

const noteDiscard = (lease, error) => {
  if (error?.code === TENANT_PIPELINE_STATUS_ERROR_CODE) {
    lease.discard = true;
  }
};

// Best-effort because a client that already failed may not accept it, and the
// original error is the one worth reporting; a connection whose ROLLBACK
// failed is not reused.
const rollbackQuietly = async (client, lease) => {
  try {
    await client.query("ROLLBACK");
  } catch {
    lease.discard = true;
  }
};

// BEGIN, and the role's settings step (the tenant settings, or the system role
// under the split) when there is one. With the JavaScript client both go out
// in one round trip (the explicit block stays open after the Sync); otherwise
// BEGIN and the settings are two. A failure rolls back.
// The isolation levels withPostgresTransaction may name. The level must be
// part of BEGIN itself: the settings step that follows takes the snapshot, and
// changing the level after that fails (25001).
const TRANSACTION_ISOLATION_LEVELS = new Map([
  ["read committed", "BEGIN ISOLATION LEVEL READ COMMITTED"],
  ["repeatable read", "BEGIN ISOLATION LEVEL REPEATABLE READ"],
  ["serializable", "BEGIN ISOLATION LEVEL SERIALIZABLE"],
]);

const resolveBeginText = (isolationLevel) => {
  if (isolationLevel === undefined || isolationLevel === null) {
    return "BEGIN";
  }

  const text = TRANSACTION_ISOLATION_LEVELS.get(String(isolationLevel).trim().toLowerCase());

  if (!text) {
    throw new TypeError(`Unknown transaction isolation level "${String(isolationLevel)}".`);
  }

  return text;
};

const beginTransaction = async (client, lease, step, beginText = "BEGIN") => {
  if (!step) {
    await client.query(beginText);
    return;
  }

  if (!canPipeline(client)) {
    await client.query(beginText);

    try {
      await client.query(step.text, step.values);
    } catch (error) {
      await rollbackQuietly(client, lease);
      throw error;
    }

    return;
  }

  try {
    await runPipeline(client, {
      expectedTransactionStatus: TRANSACTION_IN_BLOCK,
      prelude: [{ text: beginText, values: [] }],
      ...step,
    });
  } catch (error) {
    noteDiscard(lease, error);
    await rollbackQuietly(client, lease);
    throw error;
  }
};

// BEGIN (with the role's settings step when there is one), the work, COMMIT;
// ROLLBACK on any throw.
const runInTransaction = async (client, lease, step, callback, beginText = "BEGIN") => {
  await beginTransaction(client, lease, step, beginText);

  let result;

  try {
    result = await callback(client);
  } catch (error) {
    await rollbackQuietly(client, lease);
    throw error;
  }

  await client.query("COMMIT");
  return result;
};

/**
 * One statement. Unscoped and without a prelude it goes straight to the pool.
 * For a tenant it runs in a transaction of its own, so the tenant role and
 * settings apply to it and to nothing after it: the settings and the
 * statement go out together in one round trip, in the implicit transaction
 * that the Sync ends (commit, or rollback when either fails). With the role
 * split on (POSTGRES_MIGRATION_DATABASE_URL), system and unscoped statements
 * take the same path with the system role's step instead, and only an unbound
 * one goes straight to the pool, as the runtime login (resolveStatementRole).
 * Under the split a system statement therefore always uses the extended
 * protocol, as a tenant statement does: one call carries one statement.
 *
 * `prelude` ({ text, values } statements) runs first in that same implicit
 * transaction and round trip, for its effect only: a row lock taken there
 * (SELECT ... FOR NO KEY UPDATE) is held until the Sync, and in READ COMMITTED
 * the statement takes its snapshot only after the prelude finished, so it sees
 * every transaction that held the lock before. The owner path with a prelude
 * borrows a connection for that one round trip.
 *
 * Commit semantics are those of pool.query on the owner path: the Sync commits
 * a statement that succeeded on the server. A client-side failure after the
 * pipeline went out (pg's client-side query_timeout, a lost socket) therefore
 * does not mean rollback: the outcome is unknown to the caller, exactly as for
 * a lost COMMIT reply. Work that must not commit behind a client-side error
 * belongs in withPostgresTransaction. A connection that failed without
 * provably ending idle (such a client-side failure, a block left open by the
 * statement, or one it inherited) is discarded, never pooled.
 *
 * `readOnly` (true, or { guard: { text, values } }) marks a statement a read
 * replica may answer (POSTGRES_READ_REPLICA_URLS, rag/postgres-replicas.js).
 * It is honoured only for an enforced tenant outside withPostgresTransaction;
 * everything else, and every read the router cannot place or a replica fails,
 * runs here on the primary exactly as without the mark. On a replica the
 * tenant settings, the guard (a freshness check that fails while the replica
 * is behind what the caller expects), the prelude and the statement share one
 * round trip. Mark only statements that read, and give a guard to any read
 * that must see a write the caller knows of: without one the read is only as
 * fresh as POSTGRES_READ_REPLICA_MAX_LAG_MS.
 */
export const queryPostgres = async (queryText, values = [], { prelude = [], readOnly = null } = {}) => {
  assertDatabaseContextBound("queryPostgres");

  const role = resolveStatementRole();

  if (readOnly && isReadReplicaRoutingEnabled()) {
    const replicated = await queryReadReplica({
      guard: readOnly.guard ?? null,
      prelude,
      queryText,
      tenant: role.tenant,
      values,
    });

    if (replicated) {
      return replicated.result;
    }
  }

  const steps = [...(role.step ? [role.step] : []), ...prelude];

  if (steps.length === 0) {
    return getPostgresPool().query(queryText, values).catch(rethrowPostgresError);
  }

  return withPooledClient(async (client, lease) => {
    if (!canPipeline(client) || typeof queryText !== "string") {
      return runInTransaction(client, lease, role.step, async () => {
        for (const step of prelude) {
          await client.query(step.text, step.values ?? []);
        }

        return client.query(queryText, values);
      });
    }

    return runPipeline(client, {
      expectedTransactionStatus: TRANSACTION_IDLE,
      lease,
      prelude: steps,
      text: queryText,
      values,
    });
  });
};

// Set while a withPostgresTransaction callback runs (with replicas
// configured), so a read-only statement issued from inside it stays on the
// primary like the rest of the transaction's work.
const transactionScope = new AsyncLocalStorage();

// Set for the rest of a request whose document registry refresh failed: the
// replica freshness guard compares the replica with the versions this
// process's registry holds, and a registry that missed a replacement or a
// delete would let a lagging replica pass it. Such a request reads only from
// the primary.
const primaryReadScope = new AsyncLocalStorage();

export const runWithPrimaryReads = (callback) => primaryReadScope.run(true, callback);

/**
 * Whether a statement marked readOnly here and now could go to a replica:
 * replicas configured, an enforced tenant, no transaction. The pgvector dense
 * search asks before choosing its one-round-trip form.
 */
export const canRouteReadToReplica = () =>
  isReadReplicaRoutingEnabled() &&
  Boolean(getEnforcedDatabaseTenant()) &&
  !transactionScope.getStore() &&
  !primaryReadScope.getStore();

// The tenant pipeline on a replica: settings, guard (as the tenant), prelude
// and statement, one Sync. A hot standby runs it unchanged; its row policies
// are the primary's, replayed.
const runOnReplica = (pool, { guard, prelude, queryText, tenant, values }) =>
  withReplicaClient(pool, async (client, lease) => {
    const reads = [...(guard ? [guard] : []), ...prelude];

    if (!canPipeline(client) || typeof queryText !== "string") {
      return runInTransaction(client, lease, tenantSettingsStep(tenant), async () => {
        for (const step of reads) {
          await client.query(step.text, step.values ?? []);
        }

        return client.query(queryText, values);
      });
    }

    return runPipeline(client, {
      expectedTransactionStatus: TRANSACTION_IDLE,
      lease,
      prelude: [tenantSettingsStep(tenant), ...reads],
      text: queryText,
      values,
    });
  });

// { result } from a replica, or null when the primary must answer: the read
// is not eligible (no tenant, inside a transaction), no replica is usable, or
// the replica failed (behind the guard, unreachable, any error). Each case is
// counted by reason; a replica error never reaches the caller.
const queryReadReplica = async ({ guard, prelude, queryText, tenant, values }) => {
  if (!tenant) {
    recordPrimaryRead("owner");
    return null;
  }

  if (transactionScope.getStore()) {
    recordPrimaryRead("in_transaction");
    return null;
  }

  if (primaryReadScope.getStore()) {
    recordPrimaryRead("registry_unverified");
    return null;
  }

  const lease = acquireReadReplica();

  if (!lease.replica) {
    recordPrimaryRead(lease.reason, { fallback: true });
    return null;
  }

  try {
    const result = await runOnReplica(lease.replica.pool, { guard, prelude, queryText, tenant, values });

    lease.succeeded();
    return { result };
  } catch (error) {
    recordPrimaryRead(lease.failed(error), { fallback: true });
    return null;
  }
};

export const ROLE_SPLIT_RAW_SESSION_ERROR_CODE = "ARCHIVE_RAG_ROLE_SPLIT_RAW_SESSION";
export const OWNER_WORK_CONTEXT_ERROR_CODE = "ARCHIVE_RAG_OWNER_WORK_CONTEXT";

/**
 * A raw pooled session for work that manages its own transactions. It cannot
 * carry a tenant: settings made outside a transaction would outlive the
 * callback on a pooled connection. Under a tenant it throws rather than
 * silently running as the owner.
 *
 * With the role split on it refuses outright. A raw runtime session either
 * runs as the runtime login, which can do nothing, or would have to switch
 * into the system role at session level (SET ROLE) for the callback's own
 * BEGIN/COMMITs and switch back before release: a callback that changes the
 * role itself, or a reset that fails on a broken connection, would return a
 * pooled connection still acting as the system, and the next borrower's
 * unbound statement would then read every tenant instead of failing closed.
 * On the runtime pool a role is therefore only ever set transaction-locally
 * (queryPostgres, withPostgresTransaction). Owner work that needs a raw
 * session (the migrator) takes one from the owner pool through
 * withPostgresOwnerClient.
 */
export const withPostgresClient = async (callback) => {
  assertDatabaseContextBound("withPostgresClient");

  if (getEnforcedDatabaseTenant()) {
    throw new Error(
      "withPostgresClient cannot run under a database tenant; use withPostgresTransaction for tenant-scoped work or runAsDatabaseSystem for system work."
    );
  }

  if (isPostgresRoleSplitEnabled()) {
    const error = new Error(
      "withPostgresClient hands out no raw session while the database role split is on (POSTGRES_MIGRATION_DATABASE_URL): a session-level role switch could outlive the callback on a pooled connection. Use withPostgresTransaction, or withPostgresOwnerClient for owner work."
    );

    error.code = ROLE_SPLIT_RAW_SESSION_ERROR_CODE;
    throw error;
  }

  return withPooledClient((client) => callback(client));
};

/**
 * Runs `callback` inside one BEGIN/COMMIT on a single pooled client and rolls
 * back on any throw. The pgvector ingest path uses it so the document row and
 * every chunk row land together or not at all. Under a tenant the whole
 * transaction runs as the tenant role; with the role split on, system and
 * unscoped work runs as the system role (SET LOCAL ROLE in BEGIN's round
 * trip), unbound work as the runtime login.
 */
export const withPostgresTransaction = async (callback, { isolationLevel } = {}) => {
  assertDatabaseContextBound("withPostgresTransaction");

  // `isolationLevel` ("read committed", "repeatable read", "serializable")
  // pins the level in BEGIN itself; without it the session default applies,
  // with exactly the messages it always sent.
  const beginText = resolveBeginText(isolationLevel);
  const { step } = resolveStatementRole();
  const run = () =>
    withPooledClient((client, lease) => runInTransaction(client, lease, step, callback, beginText));

  return hasReadReplicaConfiguration() ? transactionScope.run(true, run) : run();
};

// ---------------------------------------------------------------------------
// Owner work (the role split)
// ---------------------------------------------------------------------------
//
// Migrations and every DDL the application runs need the tables' owner. With
// the split off the one pool logs in as the owner and these helpers are the
// ordinary system-context calls (queryPostgres, withPostgresClient,
// withPostgresTransaction), with the same messages on the wire. With it on they
// use the owner pool on POSTGRES_MIGRATION_DATABASE_URL, without any role
// switch, and only for system work: a tenant, unscoped or unbound chain never
// gets an owner session, whatever code it reaches.

const assertOwnerWork = (operation) => {
  assertDatabaseContextBound(operation);

  if (getDatabaseTenantContext() !== DATABASE_TENANT_CONTEXTS.system) {
    const error = new Error(
      `${operation} runs as the owner login (POSTGRES_MIGRATION_DATABASE_URL) and only for system work; run it inside runAsDatabaseSystem.`
    );

    error.code = OWNER_WORK_CONTEXT_ERROR_CODE;
    throw error;
  }
};

/** One owner statement (the migrator's bookkeeping). */
export const queryPostgresAsOwner = async (queryText, values = []) => {
  if (!isPostgresRoleSplitEnabled()) {
    return queryPostgres(queryText, values);
  }

  assertOwnerWork("queryPostgresAsOwner");

  return getPostgresMigrationPool().query(queryText, values).catch(rethrowPostgresError);
};

/** A raw owner session for work that manages its own transactions (the migrator). */
export const withPostgresOwnerClient = async (callback) => {
  if (!isPostgresRoleSplitEnabled()) {
    return withPostgresClient(callback);
  }

  assertOwnerWork("withPostgresOwnerClient");

  return withPooledClient((client) => callback(client), getPostgresMigrationPool);
};

/**
 * One owner transaction: BEGIN, the callback's statements on the client it is
 * handed, COMMIT; ROLLBACK on any throw. The index version lifecycle creates
 * and drops version tables in it.
 */
export const withPostgresOwnerTransaction = async (callback) => {
  if (!isPostgresRoleSplitEnabled()) {
    return withPostgresTransaction(callback);
  }

  assertOwnerWork("withPostgresOwnerTransaction");

  return withPooledClient(
    (client, lease) => runInTransaction(client, lease, null, callback),
    getPostgresMigrationPool
  );
};

/**
 * The role POSTGRES_DATABASE_URL logs in as, read from the database itself
 * (session_user on a runtime connection, no role switch, no privilege needed)
 * rather than parsed from the URL, which may be a key/value string, leave the
 * user to PGUSER, or pass through a proxy. The migrator grants the tenant and
 * system roles to it under the split.
 */
export const readPostgresRuntimeLogin = async () => {
  const result = await getPostgresPool()
    .query("SELECT session_user::text AS login")
    .catch(rethrowPostgresError);

  return String(result.rows?.[0]?.login ?? "");
};

/**
 * The `postgresTls` health entry (rag/postgres-tls.js): null while TLS is off
 * and POSTGRES_SSL_MODE is valid or unset, so the report keeps its shape then.
 * It checks every URL the process connects with: the runtime login, the owner
 * login of the role split, and each read replica (an invalid replica list is
 * the readReplicas entry's error, not this one's).
 */
export const checkPostgresTlsHealth = () => {
  const connectionStrings = [{ connectionString: getConnectionString(), label: "POSTGRES_DATABASE_URL" }];

  if (isPostgresRoleSplitEnabled()) {
    connectionStrings.push({
      connectionString: getPostgresMigrationDatabaseUrl(),
      label: "POSTGRES_MIGRATION_DATABASE_URL",
    });
  }

  if (hasReadReplicaConfiguration()) {
    try {
      parseReadReplicaUrls(process.env.POSTGRES_READ_REPLICA_URLS).forEach((replica, index) =>
        connectionStrings.push({
          connectionString: replica.url,
          label: `POSTGRES_READ_REPLICA_URLS entry ${index + 1}`,
        })
      );
    } catch {
      // Reported by checks.readReplicas.
    }
  }

  return describePostgresTlsHealth({ connectionStrings });
};

export const checkPostgresHealth = async () => {
  if (!isPostgresConfigured()) {
    return {
      status: "error",
      message: "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is missing.",
    };
  }

  try {
    await queryPostgres("SELECT 1 AS ok");

    return {
      status: "ok",
      message: "PostgreSQL is reachable.",
    };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error ? error.message : "PostgreSQL health check failed.",
    };
  }
};

export const resetPostgresPool = async () => {
  await resetReadReplicas();

  if (migrationPool) {
    const pool = migrationPool;

    migrationPool = null;
    await pool.end();
  }

  if (!postgresPool) {
    return;
  }

  await postgresPool.end();
  postgresPool = null;
};

export const isLongMemoryPostgresConfigured = () => isPostgresConfigured();

export const getLongMemoryPostgresPool = () => getPostgresPool();

export const queryLongMemoryPostgres = async (queryText, values = []) =>
  queryPostgres(queryText, values);

export const withLongMemoryPostgresClient = async (callback) =>
  withPostgresClient(callback);

export const checkLongMemoryPostgresHealth = async () => {
  if (!isLongMemoryEnabled()) {
    return {
      status: "disabled",
      message: "Long-term memory is disabled.",
    };
  }

  return checkPostgresHealth();
};

export const resetLongMemoryPostgresPool = async () => resetPostgresPool();
