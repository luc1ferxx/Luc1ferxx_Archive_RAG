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
  getApiAuthTokens,
  getAgentExperienceMemoryConfigStatus,
  getChatModel,
  getDocumentChunksPostgresTable,
  getDocumentsPostgresTable,
  getIngestJobOutputsPostgresTable,
  getIngestJobsPostgresTable,
  getRagIngestMode,
  getDocumentStoreProvider,
  getEmbeddingModel,
  getFeedbackPostgresTable,
  getHybridFusionMethod,
  getLongMemoryConfigStatus,
  getLongMemoryPostgresTable,
  getPostgresRowLevelSecurityMode,
  getPostgresSystemRole,
  getPostgresTenantRole,
  getRetrievalRoute,
  getQdrantCollection,
  getQdrantUrl,
  getSessionMemoryPostgresTable,
  getSessionMemoryStoreProvider,
  getTaskEventsPostgresTable,
  getTaskStoreProvider,
  getTasksPostgresTable,
  getTenantUsagePostgresTable,
  getVectorStoreProviderConfigStatus,
  getWorkspaceArtifactStoreConfigStatus,
  getWorkspaceArtifactsPostgresTable,
  getWorkspaceMembersPostgresTable,
  getWorkspacesPostgresTable,
  isApiAuthEnabled,
  isHybridRetrievalEnabled,
  isPostgresRoleSplitEnabled,
  isPostgresRowLevelSecurityOffConfirmed,
  isStartupHealthStrict,
} from "./rag/config.js";
import { describeVectorStoreRuntime, supportsDenseScoreVector } from "./rag/vector-store.js";
import { describeQueryAdapterHealth } from "./rag/query-adapter.js";
import {
  describePgvectorSparseRowLevelSecurityTargets,
  describePgvectorStatus,
  getActivePgvectorSparseRankFunctionName,
  getPgvectorSparseRankFunctionName,
  listLivePgvectorVersionTables,
} from "./rag/vector-store-pgvector.js";
import {
  getIndexVersionRegistryTableNames,
  runPostgresMigrations,
} from "./rag/db-migrations.js";
import { PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS } from "./rag/db-migrations.js";
import {
  checkLongMemoryPostgresHealth,
  checkPostgresHealth,
  checkPostgresTlsHealth,
  isPostgresConfigured,
  queryPostgres,
} from "./rag/postgres.js";
import { runAsDatabaseSystem, runWithDatabaseTenant } from "./rag/postgres-tenant.js";
import { createPostgresIngestJobStore } from "./rag/ingest-job-store.js";
import { checkReadReplicaHealth } from "./rag/postgres-replicas.js";
import { checkSharedStateHealth } from "./rag/shared-state.js";
import { probeDoclingServe } from "./rag/docling-parser.js";
import { resolvePdfAutoRoutingConfig } from "./rag/pdf-page-router.js";
import {
  getDoclingFallback,
  getDoclingMaxConcurrency,
  getDoclingPageBatchSize,
  getPdfParser,
  getTenantEncryptionMode,
} from "./rag/config.js";
import { getTenantKmsProvider } from "./rag/kms/index.js";
import { getOpenAIApiKey } from "./rag/openai.js";
import { getRagDataDirectory } from "./rag/storage.js";
import { AGENT_SERVICE_PING_PATH } from "./rag/agent-service/contract.js";
import { createServiceClient } from "./rag/service-client.js";
import {
  describeServiceTopology,
  getServiceUrls,
  isModelGatewayEnabled,
  isRemoteAgentEnabled,
  isRemoteRetrievalEnabled,
  SERVICE_TIERS,
} from "./rag/service-topology.js";

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

const readSafely = (read, fallback) => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

const checkOpenAIHealth = async ({ env = process.env } = {}) => {
  // Behind MODEL_GATEWAY_URL the provider key is the gateway's, not this
  // process's; the gateway reports its own backends.
  if (readSafely(() => isModelGatewayEnabled(env), false)) {
    return buildEntry("ok", {
      chatModel: getChatModel(),
      embeddingModel: getEmbeddingModel(),
      gateway: true,
      message: "Model calls go through MODEL_GATEWAY_URL.",
    });
  }

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

  // Index versions (migration 016): only what stops the active version from
  // being served is a problem. A stalled build, a version out of its
  // dual-write window or drift are warnings on the entry.
  for (const problem of status.indexVersions?.problems ?? []) {
    problems.push(`Index versions: ${problem}`);
  }

  return problems;
};

// The index-version part of the pgvector health entry: which version serves,
// what is building and how far it got, and any drift between the active
// version and the versions it dual-writes.
const summarizeIndexVersions = (indexVersions) => {
  if (!indexVersions || indexVersions.registry !== "present") {
    return indexVersions ? { registry: indexVersions.registry } : null;
  }

  return {
    active: indexVersions.active,
    building: indexVersions.building,
    drift: indexVersions.drift,
    generation: indexVersions.generation,
    pointerTtlMs: indexVersions.pointerTtlMs,
    previousVersionId: indexVersions.previousVersionId,
    registry: indexVersions.registry,
    switchedAt: indexVersions.switchedAt,
    versions: indexVersions.versions.map((version) => ({
      chunkCount: version.chunkCount,
      chunkTable: version.chunkTable,
      dualWriteUntil: version.dualWriteUntil,
      embedding: version.embedding,
      isActive: version.isActive,
      status: version.status,
      versionId: version.versionId,
    })),
    warnings: indexVersions.warnings,
  };
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
    activeVersion: status.activeVersion ?? null,
    indexVersions: summarizeIndexVersions(status.indexVersions),
    retrieval: buildRetrievalSummary(),
    message:
      problems.length > 0
        ? problems.join(" ")
        : "pgvector extension, chunk table, indexes and embedding dimensions are ready.",
  });
};

// The local and Qdrant stores scope a search only by the docIds the caller
// passes (the registry's documents for the request's access scope): an
// application filter, with no tenant boundary in the store itself, where
// pgvector has row-level security under it. With one principal (auth off, or
// the single shared API_AUTH_TOKEN) that is all a deployment needs. With
// several (API_AUTH_TOKENS, JWT or OIDC) tenants share one index behind that
// filter alone, which this store is not supported for: a warning, never an
// error, because the store itself works. Returns null when nothing to say.
const SINGLE_TENANT_VECTOR_STORES = new Set(["local", "qdrant"]);

const describeSingleTenantVectorStoreUse = (provider) => {
  if (!SINGLE_TENANT_VECTOR_STORES.has(provider)) {
    return null;
  }

  const auth = getApiAuthConfigStatus();

  if (!auth.enabled) {
    return null;
  }

  const principalSources = [
    ...(getApiAuthTokens().trim() ? ["api_auth_tokens"] : []),
    ...(auth.jwtEnabled ? ["jwt"] : []),
    ...(auth.oidcEnabled ? ["oidc"] : []),
  ];

  if (principalSources.length === 0) {
    return null;
  }

  return {
    message: `VECTOR_STORE_PROVIDER=${provider} relies on application filters only (the caller's document ids) and is supported for single-tenant use; multi-principal API auth is configured (${principalSources.join(", ")}), so use pgvector, the multi-tenant store with row-level security.`,
    principalSources,
  };
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
  const singleTenantUse = describeSingleTenantVectorStoreUse(providerStatus.provider);

  return {
    ...entry,
    // Only ever ok -> warning: a store that is down stays an error, and the
    // tenancy note never makes a working store one.
    ...(singleTenantUse
      ? {
          message: `${entry.message} ${singleTenantUse.message}`,
          multiPrincipalAuth: singleTenantUse.principalSources,
          status: entry.status === "ok" ? "warning" : entry.status,
          tenancy: "single_tenant",
          warnings: ["single_tenant_vector_store"],
        }
      : {}),
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

// The tables migrations 013, 015, 017, 031, 032, 034, 036 and 037 put under the
// tenant_isolation policy (17; migrations 038-042 add columns, functions and
// grants, no table). The probe adds every live index version's chunk table and
// the BM25 statistics tables of each (migration 030).
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
  getIngestJobsPostgresTable(),
  // Migration 017: the staged ingest's outputs hold tenant document text.
  getIngestJobOutputsPostgresTable(),
  // Migration 031: session memory rows carry their tenant.
  getSessionMemoryPostgresTable(),
  // Migration 032: admin audit events, read per workspace, append-only.
  getAdminAuditEventsPostgresTable(),
  // Migration 034: answer feedback, the exact (user, workspace) pair.
  getFeedbackPostgresTable(),
  // Migration 036: the tenant registry, read-only for the tenant role (its
  // own workspace row and its own membership rows).
  getWorkspacesPostgresTable(),
  getWorkspaceMembersPostgresTable(),
  // Migration 037: the tenant usage ledger, read-only for the exact pair.
  getTenantUsagePostgresTable(),
];

const ROW_LEVEL_SECURITY_PROBE_TENANT = Object.freeze({ userId: "__health_probe__" });

// Tables the tenant role may read without a tenant_isolation policy: migration
// 016's index version registry and pointer (SELECT only; they name chunk tables
// and embedding spaces, never tenant data). Every other table the tenant role
// holds a privilege on must carry the policy.
const getTenantReadableSystemTables = () => {
  const { pointerTable, versionsTable } = getIndexVersionRegistryTableNames();

  return [versionsTable, pointerTable];
};

// Without the role split (POSTGRES_MIGRATION_DATABASE_URL unset) every
// statement that is not a tenant's runs as the login itself, the role that
// runs the migrations and owns every table: a chain that lost its tenant
// context reads every tenant. Reported as a warning inside the entry only; it
// never changes the entry's status or the report's.
const describeOwnerLoginRoleSplit = () => ({
  enabled: false,
  status: "warning",
  message:
    "POSTGRES_DATABASE_URL logs in as the role that runs the migrations and owns every table, so a statement that loses its tenant context runs as the owner and bypasses row-level security. Set POSTGRES_MIGRATION_DATABASE_URL to that owner login and POSTGRES_DATABASE_URL to a runtime login that owns nothing to split the roles.",
});

// The relations of the schema that are application tables (not an
// extension's), as a SQL fragment over `c` (pg_class).
const APPLICATION_RELATION_FILTER = `
  c.relnamespace = current_schema()::regnamespace
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
  )
`;

// With the role split on, probes as the system role (system work switches
// into it) and inspects the runtime login it switched from (session_user):
// the login must not be able to bypass or own anything, nor use a table or a
// search function without switching role -- otherwise a statement that lost
// its context would not fail closed -- and the system role must carry its
// system_access policy on every covered table. `tables` are the tables the
// tenant probe covers, `functions` the search functions it checks.
const probeRoleSplit = async ({ functions, tables }) => {
  const systemRole = getPostgresSystemRole();
  let row;

  try {
    const probe = await runAsDatabaseSystem(() =>
      queryPostgres(
        `
          SELECT
            current_user AS role,
            session_user AS login,
            COALESCE((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user), false)
              AS login_superuser,
            COALESCE((SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = session_user), false)
              AS login_bypass_rls,
            COALESCE((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user), false)
              AS role_superuser,
            -- A member of a table owner may act as the owner (SET ROLE, or
            -- its privileges when it inherits them).
            ARRAY(
              SELECT c.relname::text FROM pg_class c
              WHERE ${APPLICATION_RELATION_FILTER}
                AND pg_has_role(session_user, c.relowner, 'MEMBER')
              ORDER BY 1
            ) AS login_owned_tables,
            -- What the login reaches without switching role: a direct grant,
            -- a grant to PUBLIC, or one it inherits from the tenant or system
            -- role (granted WITH INHERIT TRUE, or before PostgreSQL 16 to a
            -- login without NOINHERIT).
            ARRAY(
              SELECT c.relname::text FROM pg_class c
              WHERE ${APPLICATION_RELATION_FILTER}
                AND has_table_privilege(session_user, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
              ORDER BY 1
            ) AS login_usable_tables,
            ARRAY(
              SELECT f.signature FROM unnest($2::text[]) AS f(signature)
              WHERE to_regprocedure(f.signature) IS NOT NULL
                AND has_function_privilege(session_user, to_regprocedure(f.signature)::oid, 'EXECUTE')
              ORDER BY 1
            ) AS login_executable_functions,
            ARRAY(
              SELECT c.relname::text FROM pg_class c
              WHERE ${APPLICATION_RELATION_FILTER}
                AND pg_has_role(current_user, c.relowner, 'MEMBER')
              ORDER BY 1
            ) AS role_owned_tables,
            ARRAY(
              SELECT t.name FROM unnest($1::text[]) AS t(name)
              WHERE NOT EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'system_access'
                WHERE c.relnamespace = current_schema()::regnamespace
                  AND c.relname = t.name
                  AND c.relrowsecurity
                  AND (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) = ANY (p.polroles)
              )
              ORDER BY 1
            ) AS missing_system_policies
        `,
        [tables, functions]
      )
    );

    row = probe.rows[0] ?? {};
  } catch (error) {
    return {
      enabled: true,
      status: "error",
      systemRole,
      message: `System work could not switch into the system role "${systemRole}": ${
        error instanceof Error ? error.message : String(error)
      }. The migrations grant it to the runtime login; check POSTGRES_SYSTEM_ROLE and that migration 035 ran.`,
    };
  }

  const login = String(row.login ?? "");
  const loginAttributes = {
    bypassRls: row.login_bypass_rls === true,
    superuser: row.login_superuser === true,
  };
  const loginOwnedTables = row.login_owned_tables ?? [];
  const loginUsableTables = row.login_usable_tables ?? [];
  const loginExecutableFunctions = row.login_executable_functions ?? [];
  const systemRoleOwnedTables = row.role_owned_tables ?? [];
  const missingSystemPolicies = row.missing_system_policies ?? [];
  const failure =
    row.role !== systemRole
      ? `System statements run as "${row.role}" instead of the system role "${systemRole}".`
      : loginAttributes.superuser || loginAttributes.bypassRls
        ? `The runtime login "${login}" (POSTGRES_DATABASE_URL) is ${loginAttributes.superuser ? "a superuser" : "BYPASSRLS"}, so a statement that loses its tenant context still bypasses row-level security. Use a NOSUPERUSER NOBYPASSRLS login that owns nothing.`
        : loginOwnedTables.length > 0
          ? `The runtime login "${login}" is a member of the owner of ${loginOwnedTables.join(", ")}, so it can act as the owner and bypass their policies. Use a login that owns nothing and is not a member of the owner role; the owner logs in only through POSTGRES_MIGRATION_DATABASE_URL.`
          : loginUsableTables.length > 0
            ? `The runtime login "${login}" can use ${loginUsableTables.join(", ")} without switching into the tenant or system role, so a statement that loses its tenant context does not fail closed. Revoke the direct grants and grant the tenant and system roles WITH INHERIT FALSE (PostgreSQL 16+), or make the login NOINHERIT.`
            : loginExecutableFunctions.length > 0
              ? `The runtime login "${login}" can execute ${loginExecutableFunctions.join(", ")} without switching role, and called that way they rank every tenant's chunks. Grant the tenant and system roles WITH INHERIT FALSE (PostgreSQL 16+), or make the login NOINHERIT.`
              : row.role_superuser === true || systemRoleOwnedTables.length > 0
                ? `The system role "${systemRole}" ${row.role_superuser === true ? "is a superuser" : `has the privileges of the owner of ${systemRoleOwnedTables.join(", ")}`}; it must own nothing, since DDL belongs to the migration login.`
                : missingSystemPolicies.length > 0
                  ? `Tables without the system role's system_access policy: ${missingSystemPolicies.join(", ")}, so system work sees none of their rows. Run the migrations (035).`
                  : null;

  return {
    enabled: true,
    status: failure ? "error" : "ok",
    login,
    loginAttributes,
    systemRole,
    ...(failure
      ? {
          loginExecutableFunctions,
          loginOwnedTables,
          loginUsableTables,
          missingSystemPolicies,
          systemRoleOwnedTables,
        }
      : {}),
    message:
      failure ??
      `The runtime login "${login}" owns and reaches nothing by itself; system work runs as "${systemRole}" and DDL on the migration login.`,
  };
};

// Probes as a tenant rather than reading configuration: the check passes only
// when the login role can really switch into the tenant role and every covered
// table really carries the policy, which is what a scoped request relies on.
// With the role split on it also probes as the system role and checks the
// runtime login (probeRoleSplit); without it the entry carries a warning that
// the login is the owner (describeOwnerLoginRoleSplit).
// Exported for the RLS-off branch's unit tests (test/health-access.test.mjs),
// which run without a database.
export const checkRowLevelSecurityHealth = async () => {
  const mode = getPostgresRowLevelSecurityMode();

  if (!isPostgresConfigured()) {
    return buildEntry("disabled", {
      mode,
      message: "PostgreSQL is not configured; no row-level security applies.",
    });
  }

  if (mode === "off") {
    // Auth off has no tenants to separate (every caller may act as any user),
    // so RLS off is only an unused safety net there. With API auth on, the
    // policies are what keeps a query that forgets its tenant filter from
    // reading another tenant's rows, so turning them off is an error until the
    // operator says it is deliberate.
    if (!isApiAuthEnabled()) {
      return buildEntry("disabled", {
        mode,
        message:
          "POSTGRES_ROW_LEVEL_SECURITY=off: scoped queries run as the owner role and bypass the tenant policies.",
      });
    }

    if (!isPostgresRowLevelSecurityOffConfirmed()) {
      return buildEntry("error", {
        mode,
        message:
          "POSTGRES_ROW_LEVEL_SECURITY=off while API_AUTH_ENABLED=true: scoped queries run as the owner role and bypass the tenant policies, so only the application's own filters keep tenants apart. Set POSTGRES_ROW_LEVEL_SECURITY=enforce, or POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED=true if running without row-level security is deliberate.",
      });
    }

    return buildEntry("disabled", {
      acknowledged: true,
      mode,
      message:
        "POSTGRES_ROW_LEVEL_SECURITY=off by operator decision (POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED=true): scoped queries run as the owner role and bypass the tenant policies; only the application's own filters keep tenants apart.",
    });
  }

  let tables = getRowLevelSecurityTables();
  // Multi-document full-text search as a tenant goes through this owner-run
  // function (migration 014), so a missing function or grant breaks it.
  let sparseRankFunction = getPgvectorSparseRankFunctionName();
  // BM25 and pruned multi-document searches go through migration 030's
  // search function instead; null when neither is configured.
  let sparseSearchFunction = null;

  try {
    const role = getPostgresTenantRole();

    await runPostgresMigrations();

    // Every live index version has its own chunk table under the same policy,
    // and a tenant's search calls the active version's own function.
    try {
      tables = [...new Set([...tables, ...(await listLivePgvectorVersionTables())])];
      sparseRankFunction = await getActivePgvectorSparseRankFunctionName();

      // Migration 030: every live version's statistics tables carry the
      // policy, and the search function needs the tenant's EXECUTE grant.
      const sparseTargets = await describePgvectorSparseRowLevelSecurityTargets();

      tables = [...new Set([...tables, ...sparseTargets.statisticsTables])];
      sparseSearchFunction = sparseTargets.searchFunctionUsed ? sparseTargets.searchFunction : null;
    } catch (error) {
      console.error("Could not read the index version registry for the row-level security probe.", error);
    }

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
            ) AS protected_tables,
            COALESCE(has_function_privilege(to_regprocedure($2)::oid, 'EXECUTE'), false)
              AS sparse_rank_executable,
            CASE WHEN $3::text IS NULL THEN true
                 ELSE COALESCE(has_function_privilege(to_regprocedure($3::text)::oid, 'EXECUTE'), false)
            END AS sparse_search_executable,
            -- A superuser or BYPASSRLS tenant role skips every policy, and a
            -- tenant role with the privileges of a table's owner skips that
            -- table's policy (ENABLE, not FORCE, ROW LEVEL SECURITY).
            COALESCE((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user), false)
              AS role_superuser,
            COALESCE((SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false)
              AS role_bypass_rls,
            ARRAY(
              SELECT c.relname::text
              FROM pg_class c
              WHERE c.relnamespace = current_schema()::regnamespace
                AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND pg_has_role(current_user, c.relowner, 'USAGE')
                AND NOT EXISTS (
                  SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
                )
              ORDER BY 1
            ) AS owned_tables,
            -- Every relation the tenant role may read or write in the schema
            -- that has no tenant_isolation policy (or row-level security off),
            -- whether the privilege was granted to it or to PUBLIC. Relations
            -- an extension owns are left out: pg_stat_statements, for one,
            -- grants its views to PUBLIC, and they hold no tenant rows.
            ARRAY(
              SELECT c.relname::text
              FROM pg_class c
              WHERE c.relnamespace = current_schema()::regnamespace
                AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND NOT EXISTS (
                  SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
                )
                AND has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
                AND NOT (
                  c.relrowsecurity
                  AND EXISTS (
                    SELECT 1 FROM pg_policy p
                    WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'
                  )
                )
                AND c.relname <> ALL($4::text[])
              ORDER BY 1
            ) AS ungated_tables
        `,
        [
          tables,
          `${sparseRankFunction}(tsquery, text[], integer)`,
          sparseSearchFunction,
          getTenantReadableSystemTables(),
        ]
      )
    );
    const row = probe.rows[0] ?? {};
    const protectedTables = new Set(row.protected_tables ?? []);
    const unprotectedTables = tables.filter((table) => !protectedTables.has(table));
    const sparseRankExecutable = row.sparse_rank_executable === true;
    const sparseSearchExecutable = row.sparse_search_executable === true;
    const roleAttributes = {
      bypassRls: row.role_bypass_rls === true,
      superuser: row.role_superuser === true,
    };
    const ownedTables = row.owned_tables ?? [];
    const ungatedTables = row.ungated_tables ?? [];
    const failure =
      row.role !== role
        ? `Scoped queries run as "${row.role}" instead of the tenant role "${role}".`
        : roleAttributes.superuser || roleAttributes.bypassRls
          ? `The tenant role "${role}" is ${roleAttributes.superuser ? "a superuser" : "BYPASSRLS"}, so row-level security does not apply to scoped queries. Set POSTGRES_TENANT_ROLE to a dedicated NOLOGIN role without SUPERUSER or BYPASSRLS.`
          : ownedTables.length > 0
            ? `The tenant role "${role}" has the privileges of the owner of ${ownedTables.join(", ")}, so their policies do not apply to it. Use a tenant role that owns nothing and is not a member of the owner role.`
            : unprotectedTables.length > 0
              ? `Tables without the tenant_isolation policy: ${unprotectedTables.join(", ")}.`
              : ungatedTables.length > 0
                ? `The tenant role can use tables without the tenant_isolation policy: ${ungatedTables.join(", ")}. Add a policy or revoke the grant.`
                : !sparseRankExecutable
                  ? `The tenant role cannot execute ${sparseRankFunction} (migration 014), so every multi-document full-text search a tenant makes would fail. Run the migrations.`
                  : !sparseSearchExecutable
                    ? `The tenant role cannot execute ${sparseSearchFunction} (migration 030), so every BM25 or pruned multi-document sparse search a tenant makes would fail. Run the migrations.`
                    : null;

    const roleSplit = isPostgresRoleSplitEnabled()
      ? await probeRoleSplit({
          functions: [`${sparseRankFunction}(tsquery, text[], integer)`, sparseSearchFunction].filter(Boolean),
          tables,
        })
      : describeOwnerLoginRoleSplit();

    if (failure) {
      return buildEntry("error", {
        mode,
        role,
        roleAttributes,
        ownedTables,
        sparseRankExecutable,
        sparseSearchExecutable,
        ungatedTables,
        unprotectedTables,
        roleSplit,
        message: failure,
      });
    }

    if (roleSplit.status === "error") {
      return buildEntry("error", {
        mode,
        role,
        roleAttributes,
        sparseRankExecutable,
        sparseSearchExecutable,
        protectedTableCount: tables.length,
        roleSplit,
        message: roleSplit.message,
      });
    }

    return buildEntry("ok", {
      mode,
      role,
      roleAttributes,
      sparseRankExecutable,
      sparseSearchExecutable,
      protectedTableCount: tables.length,
      roleSplit,
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

// PDF_PARSER=docling depends on a docling-serve instance. Uploads still parse
// with pdf.js when it is down (DOCLING_FALLBACK=pdfjs), so like shared state
// this reports the configured dependency as broken rather than the app.
// PDF_PARSER=auto depends on it only for the pages it routes there, and only
// with a route enabled; an invalid PDF_AUTO_* setting fails every PDF upload.
export const checkPdfParserHealth = async ({ fetchImpl } = {}) => {
  let parser;

  try {
    parser = getPdfParser();
  } catch (error) {
    return buildEntry("error", { message: error.message });
  }

  if (parser === "pdfjs") {
    return buildEntry("ok", { parser, message: "PDFs are parsed in-process with pdf.js." });
  }

  const docling = {
    doclingMaxConcurrency: getDoclingMaxConcurrency(),
    doclingPageBatchSize: getDoclingPageBatchSize(),
  };
  let routes = null;

  if (parser === "auto") {
    try {
      ({ routes } = resolvePdfAutoRoutingConfig());
    } catch (error) {
      return buildEntry("error", { parser, message: error.message });
    }

    if (routes.length === 0) {
      return buildEntry("ok", {
        parser,
        routes: [...routes],
        ...docling,
        message: "PDF_AUTO_ROUTES=none: every page keeps its pdf.js text; docling-serve is not used.",
      });
    }
  }

  const probe = await probeDoclingServe({ fetchImpl });
  const autoDetails = routes ? { routes: [...routes] } : {};

  if (probe.reachable) {
    return buildEntry("ok", { parser, ...autoDetails, ...docling, url: probe.url, message: "docling-serve is reachable." });
  }

  const unreachable = `docling-serve at ${probe.url} is unreachable${probe.error ? ` (${probe.error})` : ""}`;
  const fallback = getDoclingFallback();

  return buildEntry("error", {
    parser,
    ...autoDetails,
    ...docling,
    url: probe.url,
    fallback,
    message: routes
      ? `${unreachable}; pages routed to ${routes.join(" or ")} ${
          fallback === "none" ? "make their uploads fail" : "fall back to their pdf.js text"
        }.`
      : `${unreachable}; uploads ${fallback === "none" ? "will fail" : "fall back to pdf.js"}.`,
  });
};

// RAG_EMBEDDING_QUERY_ADAPTER (rag/query-adapter.js): a configured file that
// cannot be read or parsed is an error, so STARTUP_HEALTH_STRICT refuses to
// start rather than serve every query unadapted; a trained space other than
// the configured one, a non-hybrid route or non-RRF fusion, or a store that
// cannot keep the model's cosine are warnings (the adapter is then not
// applied there).
const checkQueryAdapterHealth = async () => {
  try {
    let supportsScoreVector = false;

    try {
      supportsScoreVector = supportsDenseScoreVector();
    } catch {
      // An unknown provider is the vector store check's error.
    }

    // Already a { status, ...details } entry.
    return describeQueryAdapterHealth({
      fusion: getHybridFusionMethod(),
      hybrid: getRetrievalRoute() === "hybrid" && isHybridRetrievalEnabled(),
      supportsScoreVector,
    });
  } catch (error) {
    return buildEntry("error", { message: error instanceof Error ? error.message : "Query adapter check failed." });
  }
};

// The ingest queue (rag/ingest-job-store.js): jobs per status over every
// tenant. Dead-letter jobs ran out of attempts at one stage and wait for an
// operator (`npm run ingest:jobs -- dead-letter list`, POST
// /admin/ingest-jobs/:jobId/requeue); they are a warning, not an error, since
// every other upload keeps being served. Without PostgreSQL the queue lives in
// the API process's memory and there is nothing shared to count.
const checkIngestJobsHealth = async ({ createStore = createPostgresIngestJobStore } = {}) => {
  const mode = getRagIngestMode();

  if (!isPostgresConfigured()) {
    return buildEntry("disabled", {
      mode,
      message: "Without PostgreSQL the ingest queue lives in the API process's memory.",
    });
  }

  try {
    await runPostgresMigrations();

    const counts = await createStore({ logger: { error() {}, log() {}, warn() {} } }).countByStatus();
    const deadLetterCount = Number(counts.dead_letter) || 0;

    return buildEntry("ok", {
      counts,
      deadLetterCount,
      mode,
      message:
        deadLetterCount > 0
          ? `${deadLetterCount} ingest job(s) ran out of attempts and wait in dead_letter; list them with npm run ingest:jobs -- dead-letter list and requeue them once the cause is fixed.`
          : "No ingest job is waiting in dead_letter.",
      ...(deadLetterCount > 0 ? { warnings: ["dead_letter_jobs"] } : {}),
    });
  } catch (error) {
    return buildEntry("error", {
      mode,
      message: error instanceof Error ? error.message : "Ingest queue health check failed.",
    });
  }
};

// Encryption at rest (TENANT_ENCRYPTION=on, rag/tenant-encryption.js): the
// KMS provider's own status (rag/kms/). Reads only: a keystore or master key
// that does not exist yet is fine (the first encrypted write creates them);
// tenant keys without a usable master key, a damaged key file, or a master
// key other users can read is an error, because every read of an encrypted
// file would fail. Reported only with the setting on (an invalid value is
// reported too), so the default report keeps its checks and their order.
const checkTenantEncryptionHealth = async (mode) => {
  if (mode !== "on") {
    return buildEntry("error", {
      code: "TENANT_ENCRYPTION_MODE_INVALID",
      message: "TENANT_ENCRYPTION is invalid; it must be on or off.",
    });
  }

  try {
    const status = await getTenantKmsProvider().status();

    return buildEntry(status.status, {
      errors: status.errors,
      keystore: status.keystore,
      masterKey: status.masterKey,
      message:
        status.status === "error"
          ? "Encrypted tenant files cannot be read with this keystore."
          : status.masterKey.state === "absent"
            ? "No tenant key yet; the first encrypted write creates the master key and the keystore."
            : "The keystore and its master key are readable.",
      mode,
      provider: status.provider,
      warnings: status.warnings,
    });
  } catch (error) {
    return buildEntry("error", {
      code: error?.code ?? "ERROR",
      message: error instanceof Error ? error.message : "Tenant encryption check failed.",
      mode,
    });
  }
};

// --- Split deployment (ARCHIVE_RAG_ROLE, rag/service-topology.js) ----------
//
// A process reports only the checks of the tiers it runs, so a tier never
// fails its health on a dependency another tier owns: the agent tier does not
// authenticate public callers or drain the ingest queue, the edge embeds no
// queries, and neither needs the provider key behind MODEL_GATEWAY_URL. The
// monolith (role all, no service URLs) runs every check, as before.
const HEALTH_CHECKS_BY_TIER = Object.freeze({
  // Public routes, uploads and their ingestion, documents, memory, feedback,
  // artifacts, and admin status (which reads the task and run stores).
  api: [
    "apiAuth",
    "openai",
    "vectorStore",
    "documentStore",
    "sessionMemory",
    "longMemory",
    "agentExperienceMemory",
    "taskStore",
    "agentRunStore",
    "adminAuditStore",
    "workspaceArtifactStore",
    "rowLevelSecurity",
    "sharedState",
    "pdfParser",
    "ingestJobs",
  ],
  // Agent runs, tasks (arXiv imports ingest PDFs), memory, artifacts, and the
  // admin actions forwarded from the edge.
  agent: [
    "openai",
    "vectorStore",
    "documentStore",
    "sessionMemory",
    "longMemory",
    "agentExperienceMemory",
    "taskStore",
    "agentRunStore",
    "adminAuditStore",
    "workspaceArtifactStore",
    "rowLevelSecurity",
    "sharedState",
    "pdfParser",
  ],
  // Query embedding and search, wherever they run.
  retrieval: [
    "openai",
    "vectorStore",
    "documentStore",
    "rowLevelSecurity",
    "sharedState",
    "queryAdapter",
  ],
  "model-gateway": ["openai", "sharedState"],
});

const describeHealthTiers = (env) => {
  const topology = describeServiceTopology(env);
  const { role } = topology;

  if (role === "invalid") {
    // Report everything; the serviceTopology check carries the error.
    return { split: true, tiers: Object.keys(HEALTH_CHECKS_BY_TIER), topology };
  }

  const remoteAgent = readSafely(() => isRemoteAgentEnabled(env), false);
  const remoteRetrieval = readSafely(() => isRemoteRetrievalEnabled(env), false);
  const runsAgent = role === "agent" || (role === "all" && !remoteAgent);
  const tiers = new Set();

  if (role === "all" || role === "api") {
    tiers.add("api");
  }

  if (runsAgent) {
    tiers.add("agent");
  }

  if (role === "retrieval" || (runsAgent && !remoteRetrieval)) {
    tiers.add("retrieval");
  }

  if (role === "model-gateway") {
    tiers.add("model-gateway");
  }

  const split =
    role !== "all" ||
    Object.values(topology.remotes).some((remote) => remote.enabled);

  return { remoteAgent, split, tiers: [...tiers], topology };
};

const AGENT_PROBE_TIMEOUT_MS = 2000;

// One agent replica, probed with a system token: a 200 proves it is reachable
// and accepts this process's signing key.
const probeAgentReplica = async ({ env, url }) => {
  try {
    const client = createServiceClient({
      audience: SERVICE_TIERS.agent,
      env,
      timeoutMs: AGENT_PROBE_TIMEOUT_MS,
      urls: [url],
    });
    const answer = await client.request({
      path: AGENT_SERVICE_PING_PATH,
      system: true,
      timeoutMs: AGENT_PROBE_TIMEOUT_MS,
    });

    return answer.status === 200
      ? { ok: true, url }
      : { code: answer.json?.code ?? `HTTP_${answer.status}`, ok: false, url };
  } catch (error) {
    return {
      causeCode: error?.causeCode ?? null,
      code: error?.code ?? "PROBE_FAILED",
      ok: false,
      url,
    };
  }
};

// The edge forwards chat, tasks and agent runs to AGENT_SERVICE_URL. An agent
// tier that does not answer is a warning, not an error: /ready stays 200, so
// the edge stays in rotation and keeps serving documents and uploads while the
// agent routes answer 503.
const checkAgentServiceHealth = async ({ env = process.env } = {}) => {
  let urls;

  try {
    urls = getServiceUrls(SERVICE_TIERS.agent, env);
  } catch {
    return buildEntry("warning", {
      message: "AGENT_SERVICE_URL is invalid; see the serviceTopology check.",
    });
  }

  const replicas = await Promise.all(urls.map((url) => probeAgentReplica({ env, url })));
  const reachableReplicas = replicas.filter((replica) => replica.ok).length;

  return buildEntry(reachableReplicas === replicas.length ? "ok" : "warning", {
    message:
      reachableReplicas === replicas.length
        ? "Every agent replica answered."
        : reachableReplicas > 0
          ? `${replicas.length - reachableReplicas} of ${replicas.length} agent replicas did not answer; the others take the agent routes.`
          : "No agent replica answered: chat, tasks and agent runs answer 503 until one does; documents and uploads keep working.",
    reachableReplicas,
    replicas,
  });
};

const buildServiceTopologyEntry = (topology) =>
  buildEntry(topology.status, {
    errors: topology.errors,
    message:
      topology.status === "error"
        ? "The split-deployment topology cannot work as configured."
        : `This process runs role ${topology.role}.`,
    role: topology.role,
    warnings: topology.warnings,
  });

export const buildHealthReport = async ({ env = process.env } = {}) => {
  const { remoteAgent, split, tiers, topology } = describeHealthTiers(env);
  const runnable = {
    apiAuth: () => checkApiAuthHealth(),
    openai: () => checkOpenAIHealth({ env }),
    vectorStore: () => checkVectorStoreHealth(),
    documentStore: () => checkDocumentStoreHealth(),
    sessionMemory: () => checkSessionMemoryHealth(),
    longMemory: () => checkLongMemoryHealth(),
    agentExperienceMemory: () => checkAgentExperienceMemoryHealth(),
    taskStore: () => checkTaskStoreHealth(),
    agentRunStore: () => checkAgentRunStoreHealth(),
    adminAuditStore: () => checkAdminAuditStoreHealth(),
    workspaceArtifactStore: () => checkWorkspaceArtifactStoreHealth(),
    rowLevelSecurity: () => checkRowLevelSecurityHealth(),
    sharedState: () => checkSharedStateHealth(),
    pdfParser: () => checkPdfParserHealth(),
    ingestJobs: () => checkIngestJobsHealth(),
    queryAdapter: () => checkQueryAdapterHealth(),
  };
  const selected = new Set(tiers.flatMap((tier) => HEALTH_CHECKS_BY_TIER[tier]));
  const names = Object.keys(runnable).filter((name) => selected.has(name));
  const [results, agentService, readReplicas] = await Promise.all([
    Promise.all(names.map((name) => runnable[name]())),
    remoteAgent ? checkAgentServiceHealth({ env }) : null,
    // Only where searches run, and only with POSTGRES_READ_REPLICA_URLS set:
    // lag, a down replica or an open circuit is a warning (the primary takes
    // the reads), never an error that takes the process out of rotation.
    tiers.includes("retrieval") ? checkReadReplicaHealth() : null,
  ]);
  const checks = Object.fromEntries(names.map((name, index) => [name, results[index]]));

  if (split) {
    checks.serviceTopology = buildServiceTopologyEntry(topology);
  }

  if (agentService) {
    checks.agentService = agentService;
  }

  if (readReplicas) {
    checks.readReplicas = readReplicas;
  }

  // Only with POSTGRES_SSL_ENABLED on (or an invalid POSTGRES_SSL_MODE):
  // no-verify is a warning, a connection TLS would refuse is an error.
  const postgresTls = isPostgresConfigured() ? checkPostgresTlsHealth() : null;

  if (postgresTls) {
    checks.postgresTls = postgresTls;
  }

  // Only with TENANT_ENCRYPTION on (or invalid), and only where tenant file
  // bytes are written or read: the edge and the agent tier.
  const tenantEncryptionMode = readSafely(() => getTenantEncryptionMode(), "invalid");

  if (tenantEncryptionMode !== "off" && (tiers.includes("api") || tiers.includes("agent"))) {
    checks.tenantEncryption = await checkTenantEncryptionHealth(tenantEncryptionMode);
  }

  const hasErrors = Object.values(checks).some((entry) => isErrorStatus(entry.status));

  return {
    status: hasErrors ? "error" : "ok",
    checkedAt: new Date().toISOString(),
    checks,
    // Secret-free: the role, the tiers this process hosts and calls, and key
    // ids (never secrets).
    service: topology,
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
