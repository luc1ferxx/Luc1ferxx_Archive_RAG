import pg from "pg";
import {
  getPostgresDatabaseUrl,
  getPostgresRowLevelSecurityMode,
  getPostgresTenantRole,
  isLongMemoryEnabled,
  isPostgresSslEnabled,
} from "./config.js";
import { getActiveDatabaseTenant } from "./postgres-tenant.js";

const { DatabaseError, Pool, Query } = pg;
const { prepareValue } = pg.utils;

let postgresPool = null;

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
    ssl: isPostgresSslEnabled()
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
  };
};

export const getPostgresPool = () => {
  if (postgresPool) {
    return postgresPool;
  }

  postgresPool = new Pool(getConnectionConfig());

  return postgresPool;
};

/**
 * A connection of its own, outside the pool, for a session that has to stay
 * open between statements (LISTEN). It logs in as the configured owner user and
 * never carries a tenant, so it may not be created under one: nothing it runs
 * is scoped by row-level security. The caller connects it, owns it and ends it.
 * TCP keepalive lets a connection whose peer vanished fail instead of idling
 * silently forever.
 */
export const createDedicatedPostgresClient = () => {
  if (getEnforcedDatabaseTenant()) {
    throw new Error(
      "createDedicatedPostgresClient cannot run under a database tenant; a dedicated session always acts as the owner."
    );
  }

  return new pg.Client({
    ...getConnectionConfig(),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
};

// The tenant settings the row-level security policies read (migration 013).
// Setting `role` through set_config is SET LOCAL ROLE: it lasts until the
// transaction ends, so a pooled connection never leaves the transaction still
// acting as a tenant. The role and the ids travel as bind parameters, never in
// the SQL text.
const TENANT_SETTINGS_SQL = `
  SELECT
    set_config('role', $1, true),
    set_config('archive_rag.user_id', $2, true),
    set_config('archive_rag.workspace_id', $3, true)
`;

// ReadyForQuery transaction status: idle, in a transaction block, in a failed
// transaction block.
const TRANSACTION_IDLE = "I";
const TRANSACTION_IN_BLOCK = "T";

export const TENANT_PIPELINE_STATUS_ERROR_CODE = "ARCHIVE_RAG_TENANT_PIPELINE_STATUS";

export const getEnforcedDatabaseTenant = () =>
  getPostgresRowLevelSecurityMode() === "enforce" ? getActiveDatabaseTenant() : null;

const getTenantSettingsValues = (tenant) => [
  getPostgresTenantRole(),
  tenant.userId,
  tenant.workspaceId,
];

const applyTenantSettings = (client, tenant) =>
  client.query(TENANT_SETTINGS_SQL, getTenantSettingsValues(tenant));

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

const withPooledClient = async (callback) => {
  const client = await getPostgresPool().connect();
  // Set when the connection may still be inside a transaction or a pipeline
  // (a failed ROLLBACK, a pipeline that did not provably end idle): the pool
  // then destroys it instead of handing it to the next caller.
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

// BEGIN, and for a tenant the tenant settings. With the JavaScript client both
// go out in one round trip (the explicit block stays open after the Sync);
// otherwise BEGIN and the settings are two. A failure rolls back.
const beginTransaction = async (client, lease, tenant) => {
  if (!tenant) {
    await client.query("BEGIN");
    return;
  }

  if (!canPipeline(client)) {
    await client.query("BEGIN");

    try {
      await applyTenantSettings(client, tenant);
    } catch (error) {
      await rollbackQuietly(client, lease);
      throw error;
    }

    return;
  }

  try {
    await runPipeline(client, {
      expectedTransactionStatus: TRANSACTION_IN_BLOCK,
      prelude: [{ text: "BEGIN", values: [] }],
      ...tenantSettingsStep(tenant),
    });
  } catch (error) {
    noteDiscard(lease, error);
    await rollbackQuietly(client, lease);
    throw error;
  }
};

// BEGIN (with the tenant settings when there is a tenant), the work, COMMIT;
// ROLLBACK on any throw.
const runInTransaction = async (client, lease, tenant, callback) => {
  await beginTransaction(client, lease, tenant);

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
 * that the Sync ends (commit, or rollback when either fails).
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
 */
export const queryPostgres = async (queryText, values = [], { prelude = [] } = {}) => {
  const tenant = getEnforcedDatabaseTenant();
  const steps = [...(tenant ? [tenantSettingsStep(tenant)] : []), ...prelude];

  if (steps.length === 0) {
    return getPostgresPool().query(queryText, values);
  }

  return withPooledClient(async (client, lease) => {
    if (!canPipeline(client) || typeof queryText !== "string") {
      return runInTransaction(client, lease, tenant, async () => {
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

/**
 * A raw pooled session for work that manages its own transactions (the
 * migrator). It cannot carry a tenant: settings made outside a transaction
 * would outlive the callback on a pooled connection. Under a tenant it throws
 * rather than silently running as the owner.
 */
export const withPostgresClient = async (callback) => {
  if (getEnforcedDatabaseTenant()) {
    throw new Error(
      "withPostgresClient cannot run under a database tenant; use withPostgresTransaction for tenant-scoped work or runAsDatabaseSystem for system work."
    );
  }

  return withPooledClient((client) => callback(client));
};

/**
 * Runs `callback` inside one BEGIN/COMMIT on a single pooled client and rolls
 * back on any throw. The pgvector ingest path uses it so the document row and
 * every chunk row land together or not at all. Under a tenant the whole
 * transaction runs as the tenant role.
 */
export const withPostgresTransaction = async (callback) => {
  const tenant = getEnforcedDatabaseTenant();

  return withPooledClient((client, lease) => runInTransaction(client, lease, tenant, callback));
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
