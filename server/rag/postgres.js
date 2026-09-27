import pg from "pg";
import {
  getPostgresDatabaseUrl,
  getPostgresRowLevelSecurityMode,
  getPostgresTenantRole,
  isLongMemoryEnabled,
  isPostgresSslEnabled,
} from "./config.js";
import { getActiveDatabaseTenant } from "./postgres-tenant.js";

const { Pool } = pg;

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
// acting as a tenant.
const TENANT_SETTINGS_SQL = `
  SELECT
    set_config('role', $1, true),
    set_config('archive_rag.user_id', $2, true),
    set_config('archive_rag.workspace_id', $3, true)
`;

export const getEnforcedDatabaseTenant = () =>
  getPostgresRowLevelSecurityMode() === "enforce" ? getActiveDatabaseTenant() : null;

const applyTenantSettings = (client, tenant) =>
  client.query(TENANT_SETTINGS_SQL, [
    getPostgresTenantRole(),
    tenant.userId,
    tenant.workspaceId,
  ]);

const withPooledClient = async (callback) => {
  const client = await getPostgresPool().connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
};

// BEGIN, the tenant settings when there is a tenant, the work, COMMIT; ROLLBACK
// on any throw. The rollback is best-effort because a client that already
// failed may not accept it, and the original error is the one worth reporting.
const runInTransaction = async (client, tenant, callback) => {
  await client.query("BEGIN");

  let result;

  try {
    if (tenant) {
      await applyTenantSettings(client, tenant);
    }

    result = await callback(client);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original error.
    }

    throw error;
  }

  await client.query("COMMIT");
  return result;
};

/**
 * One statement. Unscoped it goes straight to the pool; for a tenant it runs in
 * its own short transaction so the tenant role and settings apply to it and to
 * nothing after it.
 */
export const queryPostgres = async (queryText, values = []) => {
  const tenant = getEnforcedDatabaseTenant();

  if (!tenant) {
    return getPostgresPool().query(queryText, values);
  }

  return withPooledClient((client) =>
    runInTransaction(client, tenant, () => client.query(queryText, values))
  );
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

  return withPooledClient(callback);
};

/**
 * Runs `callback` inside one BEGIN/COMMIT on a single pooled client and rolls
 * back on any throw. The pgvector ingest path uses it so the document row and
 * every chunk row land together or not at all. Under a tenant the whole
 * transaction runs as the tenant role.
 */
export const withPostgresTransaction = async (callback) => {
  const tenant = getEnforcedDatabaseTenant();

  return withPooledClient((client) => runInTransaction(client, tenant, callback));
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
