import { runPostgresMigrations } from "./db-migrations.js";
import {
  checkPostgresHealth,
  isPostgresConfigured,
  queryPostgres,
  withPostgresOwnerTransaction,
  withPostgresTransaction,
} from "./postgres.js";

// The database seam every pgvector module shares: the store
// (vector-store-pgvector.js), the version registry
// (vector-store-pgvector-versions.js) and the version lifecycle
// (vector-store-pgvector-version-lifecycle.js).
//
// Test injection point, in the same spirit as configureOpenAIProvider and
// configureQdrantClientFactory: unit tests hand in a scripted query function
// and a no-op migration runner so the SQL these modules emit can be checked
// without a database. `now` lets a test move the pointer cache's clock.
// Production never calls configurePgvectorRuntime.

let runtimeOverrides = null;
const resetListeners = new Set();

export const configurePgvectorRuntime = (overrides = null) => {
  runtimeOverrides = overrides && typeof overrides === "object" ? overrides : null;

  // Cached verdicts (schema verification, the active-version pointer) were
  // read through the previous runtime and say nothing about this one.
  for (const listener of resetListeners) {
    listener();
  }
};

export const resetPgvectorRuntime = () => {
  configurePgvectorRuntime(null);
};

export const onPgvectorRuntimeReset = (listener) => {
  resetListeners.add(listener);
};

// A scripted query override without its own transaction hook gets one that
// hands the callback that same query function, so tests see every statement.
const getTransactionRunner = () => {
  if (typeof runtimeOverrides?.withTransaction === "function") {
    return runtimeOverrides.withTransaction;
  }

  if (typeof runtimeOverrides?.query === "function") {
    const query = runtimeOverrides.query;

    return (callback) => callback({ query });
  }

  return withPostgresTransaction;
};

// The transaction DDL runs in (creating and dropping index version tables, an
// empty table's resize): the owner pool under the role split
// (POSTGRES_MIGRATION_DATABASE_URL), withPostgresTransaction without it. A
// scripted runtime without its own owner hook runs it like any other
// transaction, so tests see every statement in one log.
const getOwnerTransactionRunner = () => {
  if (typeof runtimeOverrides?.withOwnerTransaction === "function") {
    return runtimeOverrides.withOwnerTransaction;
  }

  if (typeof runtimeOverrides?.withTransaction === "function" || typeof runtimeOverrides?.query === "function") {
    return getTransactionRunner();
  }

  return withPostgresOwnerTransaction;
};

export const getPgvectorRuntime = () => ({
  checkHealth: runtimeOverrides?.checkPostgresHealth ?? checkPostgresHealth,
  isConfigured: runtimeOverrides?.isPostgresConfigured ?? isPostgresConfigured,
  now: runtimeOverrides?.now ?? Date.now,
  query: runtimeOverrides?.query ?? queryPostgres,
  runMigrations: runtimeOverrides?.runMigrations ?? runPostgresMigrations,
  withOwnerTransaction: getOwnerTransactionRunner(),
  withTransaction: getTransactionRunner(),
});

/** The caller's transaction client when it has one, the pool otherwise. */
export const getPgvectorQuery = (client) =>
  client && typeof client.query === "function"
    ? (sql, values = []) => client.query(sql, values)
    : getPgvectorRuntime().query;
