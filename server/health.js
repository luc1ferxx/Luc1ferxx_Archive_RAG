import { constants as fsConstants } from "fs";
import { access, mkdir } from "fs/promises";

import {
  getAdminAuditEventsPostgresTable,
  getAdminAuditRetentionDays,
  getAdminAuditStoreProvider,
  getAgentRunEventsPostgresTable,
  getAgentRunRecoveryModeConfigStatus,
  getAgentRunsPostgresTable,
  getAgentRunStoreProvider,
  getApiAuthConfigStatus,
  getAgentExperienceMemoryConfigStatus,
  getChatModel,
  getDocumentChunksPostgresTable,
  getDocumentsPostgresTable,
  getDocumentStoreProvider,
  getEmbeddingModel,
  getHybridFusionMethod,
  getLongMemoryConfigStatus,
  getLongMemoryPostgresTable,
  getPostgresRowLevelSecurityMode,
  getPostgresTenantRole,
  getQdrantCollection,
  getQdrantUrl,
  getSessionMemoryPostgresTable,
  getSessionMemoryStoreProvider,
  getTaskEventsPostgresTable,
  getTaskStoreProvider,
  getTasksPostgresTable,
  getVectorStoreProviderConfigStatus,
  getWorkspaceArtifactStoreConfigStatus,
  getWorkspaceArtifactsPostgresTable,
  isHybridRetrievalEnabled,
  isStartupHealthStrict,
} from "./rag/config.js";
import { describeVectorStoreRuntime } from "./rag/vector-store.js";
import { describePgvectorStatus } from "./rag/vector-store-pgvector.js";
import { runPostgresMigrations } from "./rag/db-migrations.js";
import { PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS } from "./rag/db-migrations.js";
import {
  checkLongMemoryPostgresHealth,
  checkPostgresHealth,
  isPostgresConfigured,
  queryPostgres,
} from "./rag/postgres.js";
import { runWithDatabaseTenant } from "./rag/postgres-tenant.js";
import { getOpenAIApiKey } from "./rag/openai.js";
import { getRagDataDirectory } from "./rag/storage.js";

const buildEntry = (status, details = {}) => ({
  status,
  ...details,
});

const isErrorStatus = (status) => status === "error";

// A filesystem backend can fail in exactly one interesting way: the directory is
// not writable. Reporting "ok" without checking would make the health surface
// useless for the zero-infrastructure setup, which is the one where the operator
// has no database logs to fall back on.
const checkRagDataDirectoryHealth = async ({ message, provider }) => {
  const directory = getRagDataDirectory();

  try {
    await mkdir(directory, {
      recursive: true,
    });
    await access(directory, fsConstants.W_OK);

    return buildEntry("ok", {
      backend: "filesystem",
      provider,
      directory,
      message,
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "filesystem",
      provider,
      directory,
      message:
        error instanceof Error
          ? `${directory} is not writable: ${error.message}`
          : `${directory} is not writable.`,
    });
  }
};

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
  const configStatus = getApiAuthConfigStatus();

  if (!configStatus.enabled) {
    return buildEntry("disabled", {
      message: "API authentication is disabled.",
    });
  }

  if (configStatus.jwtEnabled && !configStatus.jwtSecretConfigured) {
    return buildEntry("error", {
      modes: configStatus.modes,
      workspaceRequired: configStatus.workspaceRequired,
      message:
        "API authentication JWT mode is enabled, but API_AUTH_JWT_HS256_SECRET or API_AUTH_JWT_SECRET is missing.",
    });
  }

  if (configStatus.status !== "ok") {
    return buildEntry("error", {
      modes: configStatus.modes,
      workspaceRequired: configStatus.workspaceRequired,
      message:
        "API authentication is enabled, but no API_AUTH_TOKEN, API_AUTH_TOKENS, or configured JWT auth method is available.",
    });
  }

  return buildEntry("ok", {
    header: "x-api-key or Authorization: Bearer <token>",
    modes: configStatus.modes,
    workspaceRequired: configStatus.workspaceRequired,
    message: "API authentication is enabled.",
  });
};

const buildRetrievalSummary = () => ({
  hybridEnabled: isHybridRetrievalEnabled(),
  hybridFusion: getHybridFusionMethod(),
});

const checkQdrantHealth = async () => {
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

/**
 * pgvector is the default provider, so this check has to answer the operator's
 * real questions: is PostgreSQL reachable, is the extension installed, do the
 * chunk table and its indexes exist, does the column width match the current
 * embedding model, and is the index actually populated for the documents the
 * registry holds. Any "no" is an error, never a silent downgrade.
 */
/**
 * Pure status -> problems mapping, exported so the pgvector health branches
 * (including the ANN access-method checks that need a real catalogue) can be
 * unit-tested without a database. `checkPgvectorHealth` builds the status and
 * the entry around this; everything DB-specific stays in describePgvectorStatus.
 */
export const derivePgvectorHealthProblems = (status) => {
  // The embedding (ANN) index is handled on its own below via status.annIndex,
  // which reads the *actual* access method from the catalogue. Excluding it here
  // avoids a duplicate, less specific "missing index" line and avoids a false
  // alarm when the configured embedding is too wide to carry an ANN index at all.
  const missingIndexes = Object.entries(status.indexes ?? {})
    .filter(([name, present]) => !present && name !== "embedding")
    .map(([name]) => name);
  const annIndex = status.annIndex ?? {};
  const annSupported =
    status.annDimensionsSupported !== false && annIndex.supported !== false;
  const problems = [];

  if (!status.configured || !status.reachable) {
    problems.push(status.message ?? "PostgreSQL is not reachable.");
    return problems;
  }

  if (!status.extension.installed) {
    problems.push(
      "The PostgreSQL `vector` extension is not installed. Use pgvector/pgvector:pg16 or run CREATE EXTENSION vector."
    );
  }

  if (!status.table.exists) {
    problems.push(`Chunk table ${status.table.name} does not exist.`);
  } else if (missingIndexes.length > 0) {
    problems.push(`Missing pgvector/FTS indexes: ${missingIndexes.join(", ")}.`);
  }

  if (status.table.exists) {
    if (!annSupported) {
      // Fail-closed, reported not hidden: a vector column past the pgvector
      // ceiling cannot carry an hnsw/ivfflat index, so dense retrieval would
      // degrade to a sequential scan. Surface it rather than letting an
      // absent ANN index read as a benign "missing index".
      problems.push(
        `The configured embedding is ${status.embedding.configuredDimensions}-dimensional, above the pgvector vector-type ANN limit of ${PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS}. No ${annIndex.configured} index can be built and dense retrieval would run as a sequential scan. Configure an embedding at or below ${PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS} dimensions (e.g. text-embedding-3-small at 1536).`
      );
    } else if (annIndex.present && !annIndex.matches) {
      problems.push(
        `The ${status.table.name} embedding index is a ${annIndex.actual} index, but the configured ANN method is ${annIndex.configured}. Drop it and run npm run vector:reindex -- --apply to rebuild the correct index.`
      );
    } else if (!annIndex.present && status.chunkCount > 0) {
      problems.push(
        `The ${status.table.name} ${annIndex.configured} embedding index is missing while ${status.chunkCount} chunk(s) are stored (partial migration). Dense retrieval runs as a sequential scan until it is rebuilt: run npm run vector:reindex -- --apply.`
      );
    }
  }

  if (status.table.exists && !status.embedding.matches) {
    problems.push(
      `Embedding column is vector(${status.embedding.columnDimensions}) with stored models ${
        status.embedding.storedModels
          .map((entry) => `${entry.model}/${entry.dimensions}`)
          .join(", ") || "none"
      }, but the configured model is ${status.embedding.model}/${status.embedding.configuredDimensions}. Run npm run vector:reindex -- --apply.`
    );
  }

  if (status.indexEmptyWithDocuments) {
    problems.push(
      `${status.documentCount} document(s) are registered but the pgvector index holds no chunks. Run npm run vector:reindex -- --apply so retrieval does not run against an empty index.`
    );
  }

  return problems;
};

const checkPgvectorHealth = async () => {
  let status;

  try {
    // Migrations create the table and indexes; running them here means a fresh
    // database reports "ok" after the first health check instead of "missing".
    if (isPostgresConfigured()) {
      await runPostgresMigrations();
    }

    status = await describePgvectorStatus();
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      provider: "pgvector",
      retrieval: buildRetrievalSummary(),
      message:
        error instanceof Error ? error.message : "pgvector health check failed.",
    });
  }

  const problems = derivePgvectorHealthProblems(status);

  return buildEntry(problems.length > 0 ? "error" : "ok", {
    backend: "postgresql",
    provider: "pgvector",
    table: status.table.name,
    extension: status.extension,
    indexes: status.indexes,
    indexType: status.indexType,
    annIndex: status.annIndex,
    annDimensionsSupported: status.annDimensionsSupported,
    textSearchConfig: status.textSearchConfig,
    embedding: status.embedding,
    chunkCount: status.chunkCount,
    documentCount: status.documentCount,
    retrieval: buildRetrievalSummary(),
    message:
      problems.length > 0
        ? problems.join(" ")
        : "pgvector extension, chunk table, indexes and embedding dimensions are ready.",
  });
};

const checkVectorStoreHealth = async () => {
  const providerStatus = getVectorStoreProviderConfigStatus();
  const retrieval = buildRetrievalSummary();

  if (!providerStatus.valid) {
    return buildEntry("error", {
      provider: null,
      configuredValue: providerStatus.rawValue,
      allowedProviders: providerStatus.allowedProviders,
      retrieval,
      message: `VECTOR_STORE_PROVIDER "${providerStatus.rawValue}" is not allowed (expected one of ${providerStatus.allowedProviders.join(
        ", "
      )}). Retrieval is disabled rather than falling back to another provider.`,
    });
  }

  const activeProvider = describeVectorStoreRuntime().vectorStoreProvider;

  if (activeProvider !== providerStatus.provider) {
    return buildEntry("error", {
      provider: providerStatus.provider,
      activeProvider,
      retrieval,
      message: `Configured vector store provider ${providerStatus.provider} does not match the active provider ${activeProvider}.`,
    });
  }

  const entry =
    providerStatus.provider === "qdrant"
      ? await checkQdrantHealth()
      : providerStatus.provider === "local"
        ? await checkRagDataDirectoryHealth({
            message:
              "Local JSON vector index is the active provider (explicit opt-in; single-process, not shared).",
            provider: "local",
          })
        : await checkPgvectorHealth();

  return {
    ...entry,
    provider: providerStatus.provider,
    providerSource: providerStatus.reason,
    providerMatchesConfig: true,
    retrieval: entry.retrieval ?? retrieval,
  };
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
  const provider = getDocumentStoreProvider();

  if (provider === "filesystem") {
    return checkRagDataDirectoryHealth({
      message: "Document registry is using file storage.",
      provider,
    });
  }

  const postgres = await checkPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      table: getDocumentsPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      provider,
      table: getDocumentsPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message: "PostgreSQL document storage is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      table: getDocumentsPostgresTable(),
      message:
        error instanceof Error ? error.message : "Document storage migration failed.",
    });
  }
};

const checkSessionMemoryHealth = async () => {
  const provider = getSessionMemoryStoreProvider();

  if (provider === "memory") {
    return buildEntry("ok", {
      backend: "memory",
      provider,
      message: "Session memory is in-process and resets when the server restarts.",
    });
  }

  const postgres = await checkPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      table: getSessionMemoryPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      provider,
      table: getSessionMemoryPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message: "PostgreSQL session memory storage is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
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

const checkAdminAuditStoreHealth = async () => {
  const provider = getAdminAuditStoreProvider();

  if (provider === "memory" || (provider === "auto" && !isPostgresConfigured())) {
    return buildEntry("ok", {
      backend: "memory",
      provider,
      message: "Admin audit store is using in-memory storage.",
    });
  }

  const postgres = await checkPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      retentionDays: getAdminAuditRetentionDays(),
      table: getAdminAuditEventsPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      provider,
      retentionDays: getAdminAuditRetentionDays(),
      table: getAdminAuditEventsPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message: "PostgreSQL admin audit storage is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      provider,
      retentionDays: getAdminAuditRetentionDays(),
      table: getAdminAuditEventsPostgresTable(),
      message:
        error instanceof Error ? error.message : "Admin audit storage migration failed.",
    });
  }
};

const checkWorkspaceArtifactStoreHealth = async () => {
  const configStatus = getWorkspaceArtifactStoreConfigStatus();

  if (configStatus.backend === "memory") {
    return buildEntry("ok", {
      backend: "memory",
      persistent: false,
      provider: configStatus.provider,
      reason: configStatus.reason,
      message: "Workspace artifacts are using in-memory storage.",
    });
  }

  const postgres = await checkPostgresHealth();

  if (isErrorStatus(postgres.status)) {
    return buildEntry("error", {
      backend: "postgresql",
      persistent: true,
      provider: configStatus.provider,
      table: getWorkspaceArtifactsPostgresTable(),
      message: postgres.message,
    });
  }

  try {
    const migrations = await runPostgresMigrations();

    return buildEntry("ok", {
      backend: "postgresql",
      persistent: true,
      provider: configStatus.provider,
      reason: configStatus.reason,
      table: getWorkspaceArtifactsPostgresTable(),
      appliedMigrations: migrations.appliedMigrations,
      message:
        "PostgreSQL workspace artifact storage is reachable and migrations are applied.",
    });
  } catch (error) {
    return buildEntry("error", {
      backend: "postgresql",
      persistent: true,
      provider: configStatus.provider,
      table: getWorkspaceArtifactsPostgresTable(),
      message:
        error instanceof Error
          ? error.message
          : "Workspace artifact storage migration failed.",
    });
  }
};

// The tables migration 013 puts under the tenant_isolation policy.
const getRowLevelSecurityTables = () => [
  getDocumentsPostgresTable(),
  getDocumentChunksPostgresTable(),
  getTasksPostgresTable(),
  getTaskEventsPostgresTable(),
  getAgentRunsPostgresTable(),
  getAgentRunEventsPostgresTable(),
  `${getAgentRunsPostgresTable()}_approval_snapshots`,
  getWorkspaceArtifactsPostgresTable(),
  getLongMemoryPostgresTable(),
];

const ROW_LEVEL_SECURITY_PROBE_TENANT = Object.freeze({ userId: "__health_probe__" });

// Probes as a tenant rather than reading configuration: the check passes only
// when the login role can really switch into the tenant role and every covered
// table really carries the policy, which is what a scoped request relies on.
const checkRowLevelSecurityHealth = async () => {
  const mode = getPostgresRowLevelSecurityMode();

  if (!isPostgresConfigured()) {
    return buildEntry("disabled", {
      mode,
      message: "PostgreSQL is not configured; no row-level security applies.",
    });
  }

  if (mode === "off") {
    return buildEntry("disabled", {
      mode,
      message:
        "POSTGRES_ROW_LEVEL_SECURITY=off: scoped queries run as the owner role and bypass the tenant policies.",
    });
  }

  const tables = getRowLevelSecurityTables();

  try {
    const role = getPostgresTenantRole();

    await runPostgresMigrations();

    const probe = await runWithDatabaseTenant(ROW_LEVEL_SECURITY_PROBE_TENANT, () =>
      queryPostgres(
        `
          SELECT
            current_user AS role,
            ARRAY(
              SELECT c.relname::text
              FROM pg_class c
              JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
              WHERE c.relrowsecurity
                AND c.relnamespace = current_schema()::regnamespace
                AND c.relname = ANY($1::text[])
            ) AS protected_tables
        `,
        [tables]
      )
    );
    const row = probe.rows[0] ?? {};
    const protectedTables = new Set(row.protected_tables ?? []);
    const unprotectedTables = tables.filter((table) => !protectedTables.has(table));

    if (row.role !== role || unprotectedTables.length > 0) {
      return buildEntry("error", {
        mode,
        role,
        unprotectedTables,
        message:
          row.role !== role
            ? `Scoped queries run as "${row.role}" instead of the tenant role "${role}".`
            : `Tables without the tenant_isolation policy: ${unprotectedTables.join(", ")}.`,
      });
    }

    return buildEntry("ok", {
      mode,
      role,
      protectedTableCount: tables.length,
      message: "Scoped queries run as the tenant role and every tenant table carries its policy.",
    });
  } catch (error) {
    return buildEntry("error", {
      mode,
      message:
        error instanceof Error ? error.message : "Row-level security probe failed.",
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
    adminAuditStore,
    workspaceArtifactStore,
    rowLevelSecurity,
  ] = await Promise.all([
    checkApiAuthHealth(),
    checkOpenAIHealth(),
    checkVectorStoreHealth(),
    checkDocumentStoreHealth(),
    checkSessionMemoryHealth(),
    checkLongMemoryHealth(),
    checkAgentExperienceMemoryHealth(),
    checkTaskStoreHealth(),
    checkAgentRunStoreHealth(),
    checkAdminAuditStoreHealth(),
    checkWorkspaceArtifactStoreHealth(),
    checkRowLevelSecurityHealth(),
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
    adminAuditStore,
    workspaceArtifactStore,
    rowLevelSecurity,
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
