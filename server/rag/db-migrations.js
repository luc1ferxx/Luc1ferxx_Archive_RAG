import { readdir, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  getDocumentsPostgresTable,
  getAgentRunEventsPostgresTable,
  getAgentRunsPostgresTable,
  getLongMemoryPostgresTable,
  getSessionMemoryPostgresTable,
  getTaskEventsPostgresTable,
  getTasksPostgresTable,
} from "./config.js";
import {
  isPostgresConfigured,
  queryPostgres,
  withPostgresClient,
} from "./postgres.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDirectory = path.join(__dirname, "..", "db", "migrations");
const MIGRATIONS_TABLE = "schema_migrations";
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

let migrationsInitialized = false;

const ensureSimpleTableName = (tableName, envName) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `${envName} must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const getTableNames = () => ({
  longMemoryTable: ensureSimpleTableName(
    getLongMemoryPostgresTable(),
    "LONG_MEMORY_POSTGRES_TABLE"
  ),
  documentsTable: ensureSimpleTableName(
    getDocumentsPostgresTable(),
    "DOCUMENTS_POSTGRES_TABLE"
  ),
  sessionMemoryTable: ensureSimpleTableName(
    getSessionMemoryPostgresTable(),
    "SESSION_MEMORY_POSTGRES_TABLE"
  ),
  tasksTable: ensureSimpleTableName(
    getTasksPostgresTable(),
    "TASKS_POSTGRES_TABLE"
  ),
  taskEventsTable: ensureSimpleTableName(
    getTaskEventsPostgresTable(),
    "TASK_EVENTS_POSTGRES_TABLE"
  ),
  agentRunsTable: ensureSimpleTableName(
    getAgentRunsPostgresTable(),
    "AGENT_RUNS_POSTGRES_TABLE"
  ),
  agentRunEventsTable: ensureSimpleTableName(
    getAgentRunEventsPostgresTable(),
    "AGENT_RUN_EVENTS_POSTGRES_TABLE"
  ),
});

const renderMigrationSql = (sqlText) => {
  const tableNames = getTableNames();

  return sqlText
    .replaceAll("__LONG_MEMORY_TABLE__", tableNames.longMemoryTable)
    .replaceAll("__DOCUMENTS_TABLE__", tableNames.documentsTable)
    .replaceAll("__SESSION_MEMORY_TABLE__", tableNames.sessionMemoryTable)
    .replaceAll("__TASKS_TABLE__", tableNames.tasksTable)
    .replaceAll("__TASK_EVENTS_TABLE__", tableNames.taskEventsTable)
    .replaceAll("__AGENT_RUNS_TABLE__", tableNames.agentRunsTable)
    .replaceAll("__AGENT_RUN_EVENTS_TABLE__", tableNames.agentRunEventsTable);
};

const ensureMigrationsTable = async () => {
  await queryPostgres(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const listMigrationFiles = async () => {
  const fileNames = await readdir(migrationsDirectory);

  return fileNames
    .filter((fileName) => /^\d+.*\.sql$/i.test(fileName))
    .sort((left, right) => left.localeCompare(right));
};

export const runPostgresMigrations = async () => {
  if (!isPostgresConfigured()) {
    throw new Error(
      "POSTGRES_DATABASE_URL or LONG_MEMORY_DATABASE_URL is required for PostgreSQL-backed storage."
    );
  }

  if (migrationsInitialized) {
    return {
      status: "ok",
      appliedMigrations: [],
    };
  }

  await ensureMigrationsTable();

  const existingMigrations = await queryPostgres(
    `SELECT id FROM ${MIGRATIONS_TABLE}`
  );
  const appliedMigrationIds = new Set(
    existingMigrations.rows.map((row) => String(row.id))
  );
  const migrationFiles = await listMigrationFiles();
  const newlyAppliedMigrations = [];

  for (const fileName of migrationFiles) {
    if (appliedMigrationIds.has(fileName)) {
      continue;
    }

    const filePath = path.join(migrationsDirectory, fileName);
    const migrationSql = renderMigrationSql(
      await readFile(filePath, "utf8")
    );

    await withPostgresClient(async (client) => {
      await client.query("BEGIN");

      try {
        await client.query(migrationSql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($1)`,
          [fileName]
        );
        await client.query("COMMIT");
        newlyAppliedMigrations.push(fileName);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  migrationsInitialized = true;

  return {
    status: "ok",
    appliedMigrations: newlyAppliedMigrations,
  };
};

export const resetPostgresMigrations = () => {
  migrationsInitialized = false;
};
