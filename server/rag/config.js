const toPositiveNumber = (rawValue, fallbackValue) => {
  const parsedValue = Number(rawValue);

  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallbackValue;
};

const toNonNegativeNumber = (rawValue, fallbackValue) => {
  const parsedValue = Number(rawValue);

  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? parsedValue
    : fallbackValue;
};

const toBoolean = (rawValue, fallbackValue = false) => {
  if (typeof rawValue !== "string") {
    return fallbackValue;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  return fallbackValue;
};

const hasEnvValue = (rawValue) =>
  typeof rawValue === "string" && rawValue.trim() !== "";

const toChoice = (rawValue, fallbackValue, allowedValues) => {
  if (typeof rawValue !== "string") {
    return fallbackValue;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  return allowedValues.includes(normalizedValue) ? normalizedValue : fallbackValue;
};

export const getEmbeddingModel = () =>
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

export const getChatModel = () => process.env.OPENAI_CHAT_MODEL || "gpt-5";

export const getPromptVersion = () =>
  toChoice(process.env.RAG_PROMPT_VERSION, "v3", ["v1", "v2", "v3"]);

export const getAgentPlannerRollout = () =>
  toChoice(process.env.AGENT_PLANNER_ROLLOUT, "llm", [
    "configured",
    "deterministic",
    "guarded_llm",
    "llm",
    "shadow",
  ]);

export const getAgentExecutionPlanner = () =>
  toChoice(process.env.AGENT_EXECUTION_PLANNER, "llm", [
    "deterministic",
    "llm",
  ]);

export const getAgentIntentPlanner = () =>
  toChoice(process.env.AGENT_INTENT_PLANNER, "llm", [
    "deterministic",
    "llm",
  ]);

export const getChunkStrategy = () =>
  (process.env.RAG_CHUNK_STRATEGY || "structured").trim().toLowerCase();

export const isHybridRetrievalEnabled = () =>
  toBoolean(process.env.RAG_HYBRID_ENABLED, false);

export const getHybridFusionMethod = () =>
  toChoice(process.env.RAG_HYBRID_FUSION, "weighted", ["weighted", "rrf"]);

export const getRrfK = () =>
  toNonNegativeNumber(process.env.RAG_RRF_K, 60);

export const getRetrievalScoringMode = () =>
  (process.env.RAG_RETRIEVAL_SCORING_MODE || "combined").trim().toLowerCase();

export const getVectorStoreProvider = () =>
  (process.env.VECTOR_STORE_PROVIDER || "local").trim().toLowerCase();

export const getQdrantUrl = () =>
  process.env.QDRANT_URL || "http://127.0.0.1:6333";

export const getQdrantApiKey = () => process.env.QDRANT_API_KEY || "";

export const getQdrantCollection = () =>
  process.env.QDRANT_COLLECTION || "rag_chunks";

export const getQdrantDistance = () => {
  const configuredDistance = (process.env.QDRANT_DISTANCE || "Cosine").trim();
  const normalizedDistance = configuredDistance.toLowerCase();

  if (normalizedDistance === "dot") {
    return "Dot";
  }

  if (normalizedDistance === "euclid" || normalizedDistance === "euclidean") {
    return "Euclid";
  }

  if (normalizedDistance === "manhattan") {
    return "Manhattan";
  }

  return "Cosine";
};

export const getChunkSize = () =>
  toPositiveNumber(process.env.RAG_CHUNK_SIZE, 900);

export const getChunkOverlap = () =>
  toNonNegativeNumber(process.env.RAG_CHUNK_OVERLAP, 180);

export const getRetrievalTopK = () =>
  Math.floor(toPositiveNumber(process.env.RAG_RETRIEVAL_TOP_K, 6));

export const getSparseRetrievalTopK = () =>
  Math.floor(toPositiveNumber(process.env.RAG_SPARSE_TOP_K, 8));

export const getComparisonTopKPerDoc = () =>
  Math.floor(toPositiveNumber(process.env.RAG_COMPARE_TOP_K_PER_DOC, 3));

export const isRerankEnabled = () =>
  toBoolean(process.env.RAG_RERANK_ENABLED, false);

export const getRerankProvider = () =>
  toChoice(process.env.RAG_RERANK_PROVIDER, "heuristic", [
    "heuristic",
    "custom",
    "cross-encoder",
  ]);

export const getRerankCandidateMultiplier = () =>
  Math.max(
    1,
    Math.floor(toPositiveNumber(process.env.RAG_RERANK_CANDIDATE_MULTIPLIER, 3))
  );

export const getRerankWeight = () =>
  Math.min(1, toNonNegativeNumber(process.env.RAG_RERANK_WEIGHT, 0.6));

export const getCrossEncoderEndpoint = () =>
  process.env.RAG_CROSS_ENCODER_ENDPOINT || "";

export const getCrossEncoderModel = () =>
  process.env.RAG_CROSS_ENCODER_MODEL || "";

export const getMaxComparisonSources = () =>
  Math.floor(toPositiveNumber(process.env.RAG_MAX_COMPARISON_SOURCES, 8));

export const getMinRelevanceScore = () =>
  toPositiveNumber(process.env.RAG_MIN_RELEVANCE_SCORE, 0.32);

export const getVectorWeight = () =>
  toPositiveNumber(process.env.RAG_VECTOR_WEIGHT, 0.82);

export const getHybridDenseWeight = () =>
  toNonNegativeNumber(process.env.RAG_HYBRID_DENSE_WEIGHT, 0.65);

export const getHybridSparseWeight = () =>
  toNonNegativeNumber(process.env.RAG_HYBRID_SPARSE_WEIGHT, 0.35);

export const getKeywordWeight = () =>
  toPositiveNumber(process.env.RAG_KEYWORD_WEIGHT, 0.18);

export const getMinQueryTermCoverage = () =>
  Math.min(1, toPositiveNumber(process.env.RAG_MIN_QUERY_TERM_COVERAGE, 0.51));

export const isQueryDecompositionEnabled = () =>
  toBoolean(process.env.RAG_QUERY_DECOMPOSITION_ENABLED, true);

export const getMaxQueryRequirements = () =>
  Math.floor(toPositiveNumber(process.env.RAG_QUERY_DECOMPOSITION_MAX_REQUIREMENTS, 4));

export const isNearDuplicateGuardEnabled = () =>
  toBoolean(process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED, true);

export const isRagObservabilityEnabled = () =>
  toBoolean(process.env.RAG_OBSERVABILITY_ENABLED, false);

export const shouldIncludeRagObservabilityContext = () =>
  toBoolean(process.env.RAG_OBSERVABILITY_INCLUDE_CONTEXT, false);

export const getPostgresDatabaseUrl = () =>
  process.env.POSTGRES_DATABASE_URL || process.env.LONG_MEMORY_DATABASE_URL || "";

export const isPostgresDatabaseConfigured = () =>
  Boolean(getPostgresDatabaseUrl().trim());

export const getLongMemoryConfigStatus = () => {
  const postgresConfigured = isPostgresDatabaseConfigured();
  const explicitlyConfigured = hasEnvValue(process.env.RAG_LONG_MEMORY_ENABLED);
  const enabled = toBoolean(
    process.env.RAG_LONG_MEMORY_ENABLED,
    postgresConfigured
  );

  return {
    enabled,
    explicit: explicitlyConfigured,
    postgresConfigured,
    reason: enabled
      ? explicitlyConfigured
        ? "env_enabled"
        : "postgres_configured_default"
      : explicitlyConfigured
        ? "env_disabled"
        : "postgres_not_configured",
  };
};

export const isLongMemoryEnabled = () =>
  getLongMemoryConfigStatus().enabled;

export const getAgentExperienceMemoryConfigStatus = () => {
  const longMemory = getLongMemoryConfigStatus();
  const explicitlyConfigured = hasEnvValue(
    process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED
  );
  const requested = toBoolean(
    process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED,
    longMemory.enabled
  );
  const enabled = requested && longMemory.enabled;

  return {
    enabled,
    explicit: explicitlyConfigured,
    longMemoryEnabled: longMemory.enabled,
    postgresConfigured: longMemory.postgresConfigured,
    requested,
    reason: enabled
      ? explicitlyConfigured
        ? "env_enabled"
        : "postgres_configured_default"
      : explicitlyConfigured && !requested
        ? "env_disabled"
        : requested && !longMemory.enabled
          ? "long_memory_disabled"
          : longMemory.reason,
  };
};

export const isAgentExperienceMemoryEnabled = () =>
  getAgentExperienceMemoryConfigStatus().enabled;

export const isPostgresSslEnabled = () =>
  toBoolean(
    process.env.POSTGRES_SSL_ENABLED,
    toBoolean(process.env.LONG_MEMORY_POSTGRES_SSL_ENABLED, false)
  );

export const getLongMemoryDatabaseUrl = () =>
  getPostgresDatabaseUrl();

export const getLongMemoryPostgresTable = () =>
  (process.env.LONG_MEMORY_POSTGRES_TABLE || "long_memory_items").trim();

export const isLongMemoryPostgresSslEnabled = () =>
  isPostgresSslEnabled();

export const getDocumentsPostgresTable = () =>
  (process.env.DOCUMENTS_POSTGRES_TABLE || "rag_documents").trim();

export const getSessionMemoryPostgresTable = () =>
  (process.env.SESSION_MEMORY_POSTGRES_TABLE || "rag_session_memory").trim();

export const getTaskStoreProvider = () =>
  toChoice(process.env.TASK_STORE_PROVIDER, "auto", [
    "auto",
    "memory",
    "postgres",
  ]);

export const getTasksPostgresTable = () =>
  (process.env.TASKS_POSTGRES_TABLE || "rag_tasks").trim();

export const getTaskEventsPostgresTable = () =>
  (process.env.TASK_EVENTS_POSTGRES_TABLE || "rag_task_events").trim();

export const getAgentRunStoreProvider = () =>
  toChoice(process.env.AGENT_RUN_STORE_PROVIDER, "auto", [
    "auto",
    "memory",
    "postgres",
  ]);

export const getAgentRunStoreConfigStatus = ({
  provider = getAgentRunStoreProvider(),
} = {}) => {
  const postgresConfigured = isPostgresDatabaseConfigured();
  const backend =
    provider === "postgres" || (provider === "auto" && postgresConfigured)
      ? "postgres"
      : "memory";

  return {
    backend,
    persistent: backend === "postgres",
    postgresConfigured,
    provider,
    reason:
      provider === "postgres"
        ? "env_postgres"
        : provider === "memory"
          ? "env_memory"
          : postgresConfigured
            ? "postgres_configured_default"
            : "postgres_not_configured",
  };
};

const getDefaultAgentRunRecoveryMode = () =>
  getAgentRunStoreConfigStatus().persistent ? "auto" : "manual";

export const getAgentRunRecoveryModeConfigStatus = () => {
  const explicit = hasEnvValue(process.env.AGENT_RUN_RECOVERY_MODE);
  const defaultMode = getDefaultAgentRunRecoveryMode();
  const mode = toChoice(
    process.env.AGENT_RUN_RECOVERY_MODE,
    defaultMode,
    ["auto", "manual", "off"]
  );

  return {
    agentRunStore: getAgentRunStoreConfigStatus(),
    defaultMode,
    explicit,
    mode,
    reason: explicit
      ? "env_configured"
      : mode === "auto"
        ? "postgres_agent_run_store_default"
        : "non_persistent_agent_run_store_default",
  };
};

export const getAgentRunRecoveryMode = () =>
  getAgentRunRecoveryModeConfigStatus().mode;

export const getAgentRunsPostgresTable = () =>
  (process.env.AGENT_RUNS_POSTGRES_TABLE || "rag_agent_runs").trim();

export const getAgentRunEventsPostgresTable = () =>
  (process.env.AGENT_RUN_EVENTS_POSTGRES_TABLE || "rag_agent_run_events").trim();

export const getAdminAuditStoreProvider = () =>
  toChoice(process.env.ADMIN_AUDIT_STORE_PROVIDER, "auto", [
    "auto",
    "memory",
    "postgres",
  ]);

export const getAdminAuditStoreConfigStatus = ({
  provider = getAdminAuditStoreProvider(),
} = {}) => {
  const postgresConfigured = isPostgresDatabaseConfigured();
  const backend =
    provider === "postgres" || (provider === "auto" && postgresConfigured)
      ? "postgres"
      : "memory";

  return {
    backend,
    persistent: backend === "postgres",
    postgresConfigured,
    provider,
    reason:
      provider === "postgres"
        ? "env_postgres"
        : provider === "memory"
          ? "env_memory"
          : postgresConfigured
            ? "postgres_configured_default"
            : "postgres_not_configured",
  };
};

export const getAdminAuditEventsPostgresTable = () =>
  (process.env.ADMIN_AUDIT_EVENTS_POSTGRES_TABLE || "rag_admin_audit_events").trim();

export const getAdminAuditRetentionDays = () =>
  Math.floor(toNonNegativeNumber(process.env.ADMIN_AUDIT_RETENTION_DAYS, 90));

export const isApiAuthEnabled = () =>
  toBoolean(process.env.API_AUTH_ENABLED, false);

export const getApiAuthToken = () => process.env.API_AUTH_TOKEN || "";

export const isStartupHealthStrict = () =>
  toBoolean(process.env.STARTUP_HEALTH_STRICT, false);
