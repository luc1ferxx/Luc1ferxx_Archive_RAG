import pg from "pg";
import {
  getPostgresDatabaseUrl,
  isLongMemoryEnabled,
  isPostgresSslEnabled,
} from "./config.js";

const { Pool } = pg;

let postgresPool = null;

const getConnectionString = () => getPostgresDatabaseUrl().trim();

export const isPostgresConfigured = () =>
  Boolean(getConnectionString());

export const getPostgresPool = () => {
  if (postgresPool) {
    return postgresPool;
  }

  const connectionString = getConnectionString();

  if (!connectionString) {
    throw new Error(
      "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is required when PostgreSQL-backed storage is enabled."
    );
  }

  postgresPool = new Pool({
    connectionString,
    ssl: isPostgresSslEnabled()
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
  });

  return postgresPool;
};

export const queryPostgres = async (queryText, values = []) =>
  getPostgresPool().query(queryText, values);

export const withPostgresClient = async (callback) => {
  const client = await getPostgresPool().connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
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
