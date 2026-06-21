import {
  getAgentRunEventsPostgresTable,
  getAgentRunRecoveryModeConfigStatus,
  getAgentRunsPostgresTable,
  getAgentRunStoreProvider,
  getApiAuthToken,
  getAgentExperienceMemoryConfigStatus,
  getChatModel,
  getDocumentsPostgresTable,
  getEmbeddingModel,
  getLongMemoryConfigStatus,
  getLongMemoryPostgresTable,
  getQdrantCollection,
  getQdrantUrl,
  getSessionMemoryPostgresTable,
  getTaskEventsPostgresTable,
  getTaskStoreProvider,
  getTasksPostgresTable,
  getVectorStoreProvider,
  isApiAuthEnabled,
  isStartupHealthStrict,
} from "./rag/config.js";
import { runPostgresMigrations } from "./rag/db-migrations.js";
import {
  checkLongMemoryPostgresHealth,
  checkPostgresHealth,
  isPostgresConfigured,
} from "./rag/postgres.js";
import { getOpenAIApiKey } from "./rag/openai.js";

const buildEntry = (status, details = {}) => ({
  status,
  ...details,
});

const isErrorStatus = (status) => status === "error";

const checkOpenAIHealth = async () => {
  try {
    getOpenAIApiKey();

    return buildEntry("ok", {
      chatModel: getChatModel(),
      embeddingModel: getEmbeddingModel(),
      message: "OpenAI API key is configured.",
    });
  } catch (error) {
    return buildEntry("error", {
      message: error instanceof Error ? error.message : "OpenAI health check failed.",
    });
  }
};

const checkApiAuthHealth = async () => {
  if (!isApiAuthEnabled()) {
    return buildEntry("disabled", {
      message: "API authentication is disabled.",
    });
  }

  if (!getApiAuthToken().trim()) {
    return buildEntry("error", {
      message: "API authentication is enabled, but API_AUTH_TOKEN is missing.",
    });
  }

  return buildEntry("ok", {
    header: "x-api-key or Authorization: Bearer <token>",
    message: "API authentication is enabled.",
  });
};

const checkQdrantHealth = async () => {
  if (getVectorStoreProvider() !== "qdrant") {
    return buildEntry("disabled", {
      provider: getVectorStoreProvider(),
      message: "Qdrant is not the active vector store provider.",
    });
  }

  try {
    const response = await fetch(`${getQdrantUrl().replace(/\/$/, "")}/healthz`);

    if (!response.ok) {
      return buildEntry("error", {
        provider: "qdrant",
        url: getQdrantUrl(),
        collection: getQdrantCollection(),
        message: `Qdrant health endpoint returned ${response.status}.`,
      });
    }

    return buildEntry("ok", {
      provider: "qdrant",
      url: getQdrantUrl(),
      collection: getQdrantCollection(),
      message: "Qdrant is reachable.",
    });
  } catch (error) {
    return buildEntry("error", {
      provider: "qdrant",
      url: getQdrantUrl(),
      collection: getQdrantCollection(),
      message:
        error instanceof Error ? error.message : "Qdrant health check failed.",
    });
  }
};

const checkLongMemoryHealth = async () => {
  const configStatus = getLongMemoryConfigStatus();

  if (!configStatus.enabled) {
    return buildEntry("disabled", {
      enabled: false,
      postgresConfigured: configStatus.postgresConfigured,
      reason: configStatus.reason,
      message: "Long-term memory is disabled.",
    });
  }

  const postgres = await checkLongMemoryPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      table: getLongMemoryPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      enabled: true,
      reason: configStatus.reason,
      table: getLongMemoryPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message: "PostgreSQL is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      table: getLongMemoryPostgresTable(),
      message:
        error instanceof Error ? error.message : "Long-term memory migration failed.",
    });
  }
};

const checkAgentExperienceMemoryHealth = async () => {
  const configStatus = getAgentExperienceMemoryConfigStatus();

  if (!configStatus.enabled) {
    return buildEntry("disabled", {
      enabled: false,
      longMemoryEnabled: configStatus.longMemoryEnabled,
      postgresConfigured: configStatus.postgresConfigured,
      reason: configStatus.reason,
      message: "Agent experience memory is disabled.",
    });
  }

  return buildEntry("ok", {
    backend: "long_memory",
    enabled: true,
    longMemoryEnabled: configStatus.longMemoryEnabled,
    postgresConfigured: configStatus.postgresConfigured,
    reason: configStatus.reason,
    message: "Agent experience memory is enabled for planning hints.",
  });
};

const checkDocumentStoreHealth = async () => {
  const postgres = await checkPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      table: getDocumentsPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      table: getDocumentsPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message: "PostgreSQL document storage is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      table: getDocumentsPostgresTable(),
      message:
        error instanceof Error ? error.message : "Document storage migration failed.",
    });
  }
};

const checkSessionMemoryHealth = async () => {
  const postgres = await checkPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      table: getSessionMemoryPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      table: getSessionMemoryPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message: "PostgreSQL session memory storage is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      table: getSessionMemoryPostgresTable(),
      message:
        error instanceof Error ? error.message : "Session memory migration failed.",
    });
  }
};

const checkTaskStoreHealth = async () => {
  const provider = getTaskStoreProvider();

  if (provider === "memory" || (provider === "auto" && !isPostgresConfigured())) {
    return buildEntry("ok", {
      backend: "memory",
      provider,
      message: "Task store is using in-memory storage.",
    });
  }

  const postgres = await checkPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      table: getTasksPostgresTable(),
      eventsTable: getTaskEventsPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      provider,
      table: getTasksPostgresTable(),
      eventsTable: getTaskEventsPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message: "PostgreSQL task storage is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      table: getTasksPostgresTable(),
      eventsTable: getTaskEventsPostgresTable(),
      message:
        error instanceof Error ? error.message : "Task storage migration failed.",
    });
  }
};

const checkAgentRunStoreHealth = async () => {
  const provider = getAgentRunStoreProvider();
  const recoveryMode = getAgentRunRecoveryModeConfigStatus();

  if (provider === "memory" || (provider === "auto" && !isPostgresConfigured())) {
    return buildEntry("ok", {
      backend: "memory",
      provider,
      recoveryMode: recoveryMode.mode,
      recoveryModeReason: recoveryMode.reason,
      message: "Agent run store is using in-memory storage.",
    });
  }

  const postgres = await checkPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      table: getAgentRunsPostgresTable(),
      eventsTable: getAgentRunEventsPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      provider,
      recoveryMode: recoveryMode.mode,
      recoveryModeReason: recoveryMode.reason,
      table: getAgentRunsPostgresTable(),
      eventsTable: getAgentRunEventsPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message: "PostgreSQL agent run storage is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      table: getAgentRunsPostgresTable(),
      eventsTable: getAgentRunEventsPostgresTable(),
      message:
        error instanceof Error ? error.message : "Agent run storage migration failed.",
    });
  }
};

export const buildHealthReport = async () => {
  const [
    apiAuth,
    openai,
    vectorStore,
    documentStore,
    sessionMemory,
    longMemory,
    agentExperienceMemory,
    taskStore,
    agentRunStore,
  ] = await Promise.all([
    checkApiAuthHealth(),
    checkOpenAIHealth(),
    checkQdrantHealth(),
    checkDocumentStoreHealth(),
    checkSessionMemoryHealth(),
    checkLongMemoryHealth(),
    checkAgentExperienceMemoryHealth(),
    checkTaskStoreHealth(),
    checkAgentRunStoreHealth(),
  ]);
  const checks = {
    apiAuth,
    openai,
    vectorStore,
    documentStore,
    sessionMemory,
    longMemory,
    agentExperienceMemory,
    taskStore,
    agentRunStore,
  };
  const hasErrors = Object.values(checks).some((entry) => isErrorStatus(entry.status));

  return {
    status: hasErrors ? "error" : "ok",
    checkedAt: new Date().toISOString(),
    checks,
  };
};

export const runStartupHealthChecks = async ({ logger = console } = {}) => {
  const report = await buildHealthReport();
  const summary = Object.entries(report.checks)
    .map(([name, result]) => `${name}=${result.status}`)
    .join(" ");

  if (report.status === "ok") {
    logger.log(`Startup health ok: ${summary}`);
  } else {
    logger.warn(`Startup health error: ${summary}`);
  }

  if (report.status === "error" && isStartupHealthStrict()) {
    throw new Error("Startup health checks failed.");
  }

  return report;
};
