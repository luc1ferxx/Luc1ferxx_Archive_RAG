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

// PDF text extraction. `pdfjs` (default) reads the content stream in-process;
// `docling` sends the file to a docling-serve instance for layout-aware
// parsing (reading order across columns, tables as cell grids; see
// docling-parser.js). Any other value fails at ingest rather than silently
// parsing with something else.
export const PDF_PARSERS = Object.freeze(["pdfjs", "docling"]);

export const getPdfParser = () => {
  const value = String(process.env.PDF_PARSER ?? "pdfjs").trim().toLowerCase() || "pdfjs";

  if (!PDF_PARSERS.includes(value)) {
    throw new Error(`PDF_PARSER must be one of ${PDF_PARSERS.join(", ")}; got "${process.env.PDF_PARSER}".`);
  }

  return value;
};

// docling-serve listens on 5001 inside its container, the backend's own
// default port, so the documented local mapping is 5010.
export const getDoclingServeUrl = () =>
  String(process.env.DOCLING_SERVE_URL || "http://127.0.0.1:5010").replace(/\/+$/, "");

export const getDoclingTimeoutMs = () =>
  Math.floor(toPositiveNumber(process.env.DOCLING_TIMEOUT_MS, 300000));

// Born-digital PDFs carry their text; OCR is for scans and costs minutes.
export const isDoclingOcrEnabled = () => toBoolean(process.env.DOCLING_OCR, false);

// When docling-serve fails: `pdfjs` (default) parses the file in-process and
// logs why; `none` fails the upload.
export const getDoclingFallback = () =>
  String(process.env.DOCLING_FALLBACK ?? "pdfjs").trim().toLowerCase() === "none" ? "none" : "pdfjs";

// Task prefixes some embedding models are trained with and documented as
// required. They are part of the model's input contract, so they apply to the
// real embedding client only, never to a configured stand-in provider. On
// QASPER, nomic-embed-text with its prefixes put the evidence paragraph among
// the QA candidates for 6 more questions in 100 (docs/evaluation.md).
// RAG_EMBEDDING_QUERY_PREFIX / RAG_EMBEDDING_DOCUMENT_PREFIX override the
// table; an empty value turns a prefix off.
const EMBEDDING_TASK_PREFIXES = Object.freeze([
  { document: "search_document: ", pattern: /nomic-embed-text/i, query: "search_query: " },
]);

const findEmbeddingTaskPrefixes = () =>
  EMBEDDING_TASK_PREFIXES.find((entry) => entry.pattern.test(getEmbeddingModel())) ?? null;

export const getEmbeddingQueryPrefix = () =>
  process.env.RAG_EMBEDDING_QUERY_PREFIX ?? findEmbeddingTaskPrefixes()?.query ?? "";

export const getEmbeddingDocumentPrefix = () =>
  process.env.RAG_EMBEDDING_DOCUMENT_PREFIX ?? findEmbeddingTaskPrefixes()?.document ?? "";

// What a stored vector was embedded under: the model, plus the document
// prefix when there is one ("nomic-embed-text#search_document:"). Stores
// record it with each chunk and refuse to rank chunks from another identity,
// the same way they treat another model.
export const getEmbeddingIndexIdentity = () => {
  const prefix = getEmbeddingDocumentPrefix().trim();

  return prefix ? `${getEmbeddingModel()}#${prefix}` : getEmbeddingModel();
};

// A chunk stored before identities were recorded has none; it was embedded
// without a prefix, so it is current only while no prefix applies.
export const isEmbeddingIdentityCurrent = (storedIdentity) =>
  typeof storedIdentity === "string" && storedIdentity
    ? storedIdentity === getEmbeddingIndexIdentity()
    : getEmbeddingIndexIdentity() === getEmbeddingModel();

export const getChatModel = () => process.env.OPENAI_CHAT_MODEL || "gpt-5";

// A second chat model the chat and planner routes fail over to when the primary
// keeps failing with a retriable error. Unset means no failover.
export const getChatFallbackModel = () =>
  String(process.env.OPENAI_CHAT_FALLBACK_MODEL ?? "").trim();

// Per-request timeout for model calls. A timed-out request is retried like a 5xx.
export const getLlmRequestTimeoutMs = () => {
  const parsed = Number(process.env.RAG_LLM_REQUEST_TIMEOUT_MS);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120000;
};

// Client-side protection per model endpoint (see model-call-guard.js).
// Requests in flight per endpoint and model; 0 means no cap.
export const getLlmMaxConcurrency = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_LLM_MAX_CONCURRENCY, 8));

// Consecutive unavailable errors (5xx, timeouts, connection failures) that open
// the circuit; 0 turns the breaker off.
export const getLlmCircuitFailureThreshold = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_LLM_CIRCUIT_FAILURE_THRESHOLD, 5));

export const getLlmCircuitCooldownMs = () =>
  toPositiveNumber(process.env.RAG_LLM_CIRCUIT_COOLDOWN_MS, 30000);

// Where the circuit breakers, the model concurrency cap and the claim-judge
// cache keep their state. "memory" is per process, right for one instance;
// "redis" shares it across every instance that points at the same REDIS_URL.
export const getSharedStateProvider = () =>
  toChoice(process.env.RAG_SHARED_STATE, "memory", ["memory", "redis"]);

export const getRedisUrl = () =>
  String(process.env.REDIS_URL ?? "").trim() || "redis://127.0.0.1:6379";

// Namespaces the keys so several deployments (or test runs) can share one Redis.
export const getSharedStatePrefix = () =>
  String(process.env.RAG_SHARED_STATE_PREFIX ?? "").trim() || "archive_rag:";

// Per-run ceilings on model usage (see run-usage.js). 0 turns one off; an empty
// value keeps the default, so a blank line in .env cannot silently remove it.
const readRunLimit = (name, fallbackValue) => {
  const rawValue = process.env[name];

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return fallbackValue;
  }

  return toNonNegativeNumber(rawValue, fallbackValue);
};

export const getAgentRunMaxTokens = () =>
  Math.floor(readRunLimit("AGENT_RUN_MAX_TOKENS", 100000));

export const getAgentRunMaxCostUsd = () =>
  readRunLimit("AGENT_RUN_MAX_COST_USD", 0.5);

export const getAgentRunMaxDurationMs = () =>
  Math.floor(readRunLimit("AGENT_RUN_MAX_DURATION_MS", 300000));

// Second opinion on claims the lexical claim check rejects (see
// self-check/claim-judge.js). `off` keeps the lexical verdict alone; `llm` asks
// the chat model, behind deterministic citation and number guards.
// The deterministic prompt-injection screen over retrieved text, file names
// and web results (rag/prompt-injection-screen.js). "off" is a kill switch for
// a false positive in production; an unrecognized value keeps it on.
export const getPromptInjectionScreenMode = () =>
  toChoice(process.env.RAG_INJECTION_SCREEN, "on", ["off", "on"]);

export const getClaimJudgeMode = () =>
  toChoice(process.env.RAG_CLAIM_JUDGE, "off", ["llm", "off"]);

// Planner calls send a JSON Schema response_format. Turn it off only for an
// OpenAI-compatible endpoint that rejects the parameter; the planners then fall
// back to prompt-only JSON and their tolerant parsers.
export const isStructuredOutputEnabled = () =>
  toBoolean(process.env.RAG_STRUCTURED_OUTPUT_ENABLED, true);

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

// Which executor runs the custom_skills stage. The typed DAG (`guarded`) is the
// default; the V1 chain stays as the fallback for a graph rejected before any
// node ran, and as an explicit operator opt-out (`off`). Who plans the graph is
// a separate dial: the DAG planner follows AGENT_EXECUTION_PLANNER, and a failed
// LLM plan falls back to the deterministic graph rather than straight to the
// chain.
//
// An unrecognized value resolves to `off`, not to the default: an operator who
// touched this dial and mistyped it was most likely trying to leave the graph,
// and the chain is the narrower path.
export const getAgentSkillGraphRollout = () => {
  const rawValue = process.env.AGENT_SKILL_GRAPH_ROLLOUT;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "guarded";
  }

  return toChoice(rawValue, "off", ["guarded", "off", "shadow"]);
};

// --- AGENT track: heterogeneous v3 unified graph rollout ---------------------
// `off` (default) keeps the V1 outer order. `shadow` plans and validates a v3
// graph beside the V1 answer without executing it. `guarded` executes an
// admitted v3 graph (document primary, evidence check, conditional follow-up,
// Web, built-in and custom Skills, and one approval-gated Capability that
// pauses the graph at its gate) on the same run store, validator/scheduler,
// budget reservation, replay matrix, and finalizer; a graph that breaks an
// admission rule (agent-unified-graph-admission.js) is rejected whole before
// any node runs and the request takes the V1 path instead. An approval
// decision continues the same graph, and startup recovery resumes or
// finalizes a v3 graph, only under `guarded`; with any other value such runs
// wait for an operator. Any unrecognized value still fails closed to `off`.
export const getAgentUnifiedGraphRollout = () =>
  toChoice(process.env.AGENT_UNIFIED_GRAPH_ROLLOUT, "off", [
    "guarded",
    "off",
    "shadow",
  ]);

// Capabilities a v3 graph may call directly (comma-separated ids, default
// none). A trusted operator allowlist, never planner input: each id must also
// be a registered Capability with an explicit graph contract, and an
// approval-gated one still pauses at its gate.
export const getAgentUnifiedGraphCapabilityIds = () =>
  String(process.env.AGENT_UNIFIED_GRAPH_CAPABILITIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
// --- end AGENT track block -------------------------------------------------

export const getChunkStrategy = () =>
  (process.env.RAG_CHUNK_STRATEGY || "structured").trim().toLowerCase();

// Document RAG runs two independent retrieval routes by default -- pgvector
// cosine search and PostgreSQL full-text search -- and fuses their ranks with
// RRF. `weighted` remains available as an explicit choice; turning hybrid off
// leaves the dense route alone, which is an opt-out, not the baseline.
export const isHybridRetrievalEnabled = () =>
  toBoolean(process.env.RAG_HYBRID_ENABLED, true);

export const getHybridFusionMethod = () =>
  toChoice(process.env.RAG_HYBRID_FUSION, "rrf", ["weighted", "rrf"]);

export const getRrfK = () =>
  toNonNegativeNumber(process.env.RAG_RRF_K, 60);

export const getRetrievalScoringMode = () =>
  (process.env.RAG_RETRIEVAL_SCORING_MODE || "combined").trim().toLowerCase();

// Retrieval route selector. The default, `hybrid`, defers to the hybrid/dense
// behaviour above so the documented production path is byte-for-byte unchanged.
// `dense` and `sparse` force a single route and exist so the evaluation harness
// can measure each arm in isolation (dense-only / sparse-only / hybrid). Unlike a
// fusion or weight knob, mislabelling the route silently corrupts a comparison
// table, so an unknown value fails closed instead of falling back to the default.
export const RETRIEVAL_ROUTE_CHOICES = Object.freeze(["hybrid", "dense", "sparse"]);

export const getRetrievalRoute = () => {
  const rawValue = process.env.RAG_RETRIEVAL_ROUTE;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "hybrid";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!RETRIEVAL_ROUTE_CHOICES.includes(normalizedValue)) {
    throw new Error(
      `RAG_RETRIEVAL_ROUTE must be one of ${RETRIEVAL_ROUTE_CHOICES.join(", ")}. ` +
        `Received "${rawValue}". Refusing to fall back to a different route.`
    );
  }

  return normalizedValue;
};

export const VECTOR_STORE_PROVIDERS = Object.freeze({
  local: "local",
  pgvector: "pgvector",
  qdrant: "qdrant",
});

export const DEFAULT_VECTOR_STORE_PROVIDER = VECTOR_STORE_PROVIDERS.pgvector;

const VECTOR_STORE_PROVIDER_ALLOWLIST = Object.freeze(
  Object.values(VECTOR_STORE_PROVIDERS)
);

/**
 * The vector store provider is a strict allowlist and fails closed. An unknown
 * value used to fall through to the local JSON index, which meant a typo in
 * production quietly moved every chunk into a file on one machine. Now it is a
 * configuration error that health, ingest and search all surface the same way.
 */
export const getVectorStoreProviderConfigStatus = () => {
  const rawValue = process.env.VECTOR_STORE_PROVIDER;
  const configured = hasEnvValue(rawValue);
  const normalizedValue = configured ? rawValue.trim().toLowerCase() : "";
  const valid = !configured || VECTOR_STORE_PROVIDER_ALLOWLIST.includes(normalizedValue);

  return {
    allowedProviders: [...VECTOR_STORE_PROVIDER_ALLOWLIST],
    configured,
    provider: valid
      ? configured
        ? normalizedValue
        : DEFAULT_VECTOR_STORE_PROVIDER
      : null,
    rawValue: configured ? rawValue.trim() : "",
    reason: !valid
      ? "invalid_provider"
      : configured
        ? "env_configured"
        : "default",
    valid,
  };
};

export class VectorStoreProviderConfigError extends Error {
  constructor(status) {
    super(
      `VECTOR_STORE_PROVIDER must be one of ${status.allowedProviders.join(
        ", "
      )}. Received "${status.rawValue}". Refusing to fall back to another provider.`
    );
    this.name = "VectorStoreProviderConfigError";
    this.code = "VECTOR_STORE_PROVIDER_INVALID";
    this.status = 500;
    this.rawValue = status.rawValue;
    this.allowedProviders = status.allowedProviders;
  }
}

export const getVectorStoreProvider = () => {
  const status = getVectorStoreProviderConfigStatus();

  if (!status.valid) {
    throw new VectorStoreProviderConfigError(status);
  }

  return status.provider;
};

export const getDocumentChunksPostgresTable = () =>
  (process.env.DOCUMENT_CHUNKS_POSTGRES_TABLE || "rag_document_chunks").trim();

const KNOWN_EMBEDDING_DIMENSIONS = Object.freeze({
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
});

export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

let embeddingDimensionsOverride = null;

/**
 * Lets an injected embedding provider declare its own dimensionality (the
 * deterministic evaluation provider embeds into 64 dimensions). It is a
 * process-level override so pgvector's fixed-width column and the migration
 * that creates it see the same number the provider actually produces.
 */
export const configureEmbeddingDimensions = (dimensions) => {
  const parsed = Number(dimensions);

  embeddingDimensionsOverride =
    Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const getEmbeddingDimensionsConfigStatus = () => {
  if (embeddingDimensionsOverride) {
    return {
      dimensions: embeddingDimensionsOverride,
      source: "provider_override",
    };
  }

  const rawValue = process.env.RAG_EMBEDDING_DIMENSIONS;

  if (hasEnvValue(rawValue)) {
    const parsed = Number(rawValue);

    if (Number.isInteger(parsed) && parsed > 0) {
      return {
        dimensions: parsed,
        source: "env",
      };
    }
  }

  const modelDimensions = KNOWN_EMBEDDING_DIMENSIONS[getEmbeddingModel()];

  return modelDimensions
    ? {
        dimensions: modelDimensions,
        source: "model",
      }
    : {
        dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
        source: "default",
      };
};

export const getEmbeddingDimensions = () =>
  getEmbeddingDimensionsConfigStatus().dimensions;

// `simple` on purpose: chunk text is pre-tokenized by the same tokenizer the
// local sparse store uses (per-character CJK, lowercase ASCII words, stop words
// removed), so a language-specific stemmer would only diverge the two routes.
export const getPgvectorTextSearchConfig = () =>
  (process.env.RAG_PGVECTOR_TEXT_SEARCH_CONFIG || "simple").trim();

// --- Sparse route scoring (pgvector BM25, migration 029) ---------------------
// `ts_rank_cd` is PostgreSQL's cover-density rank and is never called BM25;
// `bm25` is Okapi BM25 over per-version, per-scope statistics
// (rag/vector-store-pgvector-sparse.js). An unknown value fails closed rather
// than silently scoring with the other one.
export const SPARSE_SCORING_CHOICES = Object.freeze(["ts_rank_cd", "bm25"]);
export const DEFAULT_SPARSE_SCORING = "ts_rank_cd";

export const getSparseScoring = () => {
  const rawValue = process.env.RAG_SPARSE_SCORING;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return DEFAULT_SPARSE_SCORING;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!SPARSE_SCORING_CHOICES.includes(normalizedValue)) {
    throw new Error(
      `RAG_SPARSE_SCORING must be one of ${SPARSE_SCORING_CHOICES.join(", ")}. Received "${rawValue}".`
    );
  }

  return normalizedValue;
};

// k1 >= 0 (0 ignores term frequency), b in [0, 1]; Robertson's defaults, the
// same the local sparse store (rag/sparse-store.js) scores with.
export const getBm25K1 = () => toNonNegativeNumber(process.env.RAG_BM25_K1, 1.2);

export const getBm25B = () => {
  const value = toNonNegativeNumber(process.env.RAG_BM25_B, 0.75);

  return value <= 1 ? value : 0.75;
};

// Common-term pruning, for either scoring, on searches whose documents hold
// more than 1000 chunks: candidates come from the query terms whose document
// frequency is at most this share of the scope's chunks, and every query term
// still scores them (migration 030). `off`, 0 or a value >= 1 scores every
// chunk that matches any term (exhaustive).
export const DEFAULT_SPARSE_PRUNE_DF_FRACTION = 0.1;

export const getSparsePruneDfFraction = () => {
  const rawValue = String(process.env.RAG_SPARSE_PRUNE_DF_FRACTION ?? "").trim().toLowerCase();

  if (rawValue === "") {
    return DEFAULT_SPARSE_PRUNE_DF_FRACTION;
  }

  if (rawValue === "off" || rawValue === "false") {
    return null;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value)) {
    return DEFAULT_SPARSE_PRUNE_DF_FRACTION;
  }

  return value > 0 && value < 1 ? value : null;
};

// With pruning, a query whose every term is common (one word, or several)
// scores at most this many candidates per pass: the chunks holding every
// common term, then those holding any, each in physical order. `off` or 0
// scores all of them (exhaustive for such a query).
export const DEFAULT_SPARSE_COMMON_TERM_CAP = 2000;

export const getSparseCommonTermCap = () => {
  const rawValue = String(process.env.RAG_SPARSE_COMMON_TERM_CAP ?? "").trim().toLowerCase();

  if (rawValue === "") {
    return DEFAULT_SPARSE_COMMON_TERM_CAP;
  }

  if (rawValue === "off" || rawValue === "false") {
    return null;
  }

  const value = Math.floor(Number(rawValue));

  if (!Number.isFinite(value)) {
    return DEFAULT_SPARSE_COMMON_TERM_CAP;
  }

  return value > 0 ? value : null;
};

export const getPgvectorIndexType = () =>
  toChoice(process.env.RAG_PGVECTOR_INDEX_TYPE, "hnsw", ["hnsw", "ivfflat"]);

// pgvector 0.8+ iterative HNSW scans. The dense route filters by document after
// the index returns its ef_search candidates, so without them a filtered query
// the planner sends through HNSW can come back with fewer than topK rows.
// relaxed_order is the mode pgvector documents for best recall; the store
// restores strict distance order itself. `off` keeps the pre-0.8 statement.
export const PGVECTOR_ITERATIVE_SCAN_MODES = Object.freeze([
  "relaxed_order",
  "strict_order",
  "off",
]);

export const getPgvectorIterativeScan = () =>
  toChoice(
    process.env.RAG_PGVECTOR_ITERATIVE_SCAN,
    "relaxed_order",
    PGVECTOR_ITERATIVE_SCAN_MODES
  );

export const getPgvectorIvfflatLists = () =>
  Math.floor(toPositiveNumber(process.env.RAG_PGVECTOR_IVFFLAT_LISTS, 100));

export const getPgvectorHnswM = () =>
  Math.floor(toPositiveNumber(process.env.RAG_PGVECTOR_HNSW_M, 16));

export const getPgvectorHnswEfConstruction = () =>
  Math.floor(toPositiveNumber(process.env.RAG_PGVECTOR_HNSW_EF_CONSTRUCTION, 64));

/**
 * The retrieval architecture as one public record, used by evaluation reports
 * and health so that "what actually ran" is written down next to the metrics.
 */
export const getRetrievalArchitectureConfig = () => {
  const providerStatus = getVectorStoreProviderConfigStatus();

  return {
    hybridEnabled: isHybridRetrievalEnabled(),
    hybridFusion: getHybridFusionMethod(),
    vectorStoreProvider: providerStatus.valid ? providerStatus.provider : null,
    vectorStoreProviderValid: providerStatus.valid,
  };
};

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

export const getCrossEncoderTimeoutMs = () =>
  toPositiveNumber(process.env.RAG_CROSS_ENCODER_TIMEOUT_MS, 30_000);

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

// Query-term coverage floor for comparison answers (see rag/confidence.js,
// which also lets dense similarity bypass it there).
export const getMinQueryTermCoverage = () =>
  Math.min(1, toPositiveNumber(process.env.RAG_MIN_QUERY_TERM_COVERAGE, 0.51));

// The same floor for single-document QA, split out so a deployment can set it
// on its own. On QASPER (evaluation/run-abstention-gate-analysis.mjs) it
// rejects answerable and unanswerable questions at nearly the same rate,
// because a question worded differently from the paper fails a lexical test
// whether or not the paper answers it, and lowering it to 0.2 would cut the
// expected cost there by a third. The default stays 0.51 anyway: every value
// at or below 0.5 also admits the adjacent-topic chunks the behaviour tests
// guard against ("parental leave" answered from an annual-leave clause,
// "amber ceiling" citing the cobalt one). See docs/evaluation.md.
export const DEFAULT_MIN_QA_QUERY_TERM_COVERAGE = 0.51;

export const getMinQaQueryTermCoverage = () =>
  Math.min(
    1,
    toPositiveNumber(process.env.RAG_MIN_QA_QUERY_TERM_COVERAGE, DEFAULT_MIN_QA_QUERY_TERM_COVERAGE)
  );

// The QA answer model's own abstention (answer-verdict.js): the QA prompt asks
// it to open with NOT_IN_EVIDENCE: when the evidence does not answer, and the
// reply becomes an abstention. Off by default: with qwen2.5:7b, even with the
// deeper-retrieval retry, QASPER dev caught fewer unanswerable questions (85%
// -> 70%) at flat answer F1, which fails the pre-declared cost rule. See
// docs/evaluation.md.
export const isQaAnswerVerdictEnabled = () =>
  toBoolean(process.env.RAG_QA_ANSWER_VERDICT, false);

// ---------------------------------------------------------------------------
// Semantic answer cache (rag/semantic-cache.js). Opt-in: RAG_SEMANTIC_CACHE=on
// serves a stored document RAG answer to a later question of the same tenant,
// doc set, document versions, index version, query adapter, prompts, chat
// model and answer mode whose query embedding clears
// RAG_SEMANTIC_CACHE_THRESHOLD and whose words match almost exactly
// (rag/semantic-cache-guard.js). Any other value keeps it off.
// ---------------------------------------------------------------------------
export const DEFAULT_SEMANTIC_CACHE_THRESHOLD = 0.97;

export const isSemanticCacheEnabled = () =>
  ["1", "true", "on", "yes", "memory"].includes(
    String(process.env.RAG_SEMANTIC_CACHE ?? "").trim().toLowerCase()
  );

// Cosine similarity of the query embeddings, in (0, 1]; anything else falls
// back to the default rather than admitting every question.
export const getSemanticCacheThreshold = () => {
  const value = Number(process.env.RAG_SEMANTIC_CACHE_THRESHOLD);

  return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_SEMANTIC_CACHE_THRESHOLD;
};

export const getSemanticCacheMaxEntries = () =>
  Math.floor(toPositiveNumber(process.env.RAG_SEMANTIC_CACHE_MAX_ENTRIES, 500)) || 500;

// Bytes of stored responses (their JSON), least recently used out first; an
// answer larger than the whole budget is not stored.
export const DEFAULT_SEMANTIC_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export const getSemanticCacheMaxBytes = () =>
  Math.floor(toPositiveNumber(process.env.RAG_SEMANTIC_CACHE_MAX_BYTES, DEFAULT_SEMANTIC_CACHE_MAX_BYTES)) ||
  DEFAULT_SEMANTIC_CACHE_MAX_BYTES;

// 0 keeps an entry until the LRU bound or an invalidation removes it.
export const getSemanticCacheTtlMs = () =>
  String(process.env.RAG_SEMANTIC_CACHE_TTL_MS ?? "").trim() === ""
    ? 60 * 60 * 1000
    : Math.floor(toNonNegativeNumber(process.env.RAG_SEMANTIC_CACHE_TTL_MS, 60 * 60 * 1000));

// With the verdict on, single-document QA also admits a chunk whose coverage
// lies between this floor and the one above, unless a query term was replaced
// in it by a rival on the same head word ("parental leave" -> "annual leave");
// see findQueryTermSubstitution in confidence.js. The band admits chunks the
// lexical gate cannot vouch for, so it opens only when the answer model can
// refuse. A value at or above the QA coverage floor turns it off.
export const DEFAULT_QA_PARTIAL_COVERAGE_FLOOR = 0.3;

// With cross-encoder reranking on, single-document QA decides whether to
// answer from the reranker's relevance probability instead of query-term
// coverage (confidence.js). "0" or "off" keeps the lexical gate. Applies only
// to results that carry a cross-encoder score, so without the reranker, or
// when a rerank failed, the lexical gate decides as before.
//
// 0.02 is what the lexical floor's pre-declared rule (a wrong answer costs
// three refusals, lowest cost within 0.01, most conservative) picked on
// QASPER train (bge-reranker-v2-m3; reranker AUC 0.64 against coverage 0.59).
// On dev it cut refused answerable questions 37.8% -> 13.9% at unchanged
// answer F1 (+0.005 [-0.039, +0.048]), but caught 45% of unanswerable
// questions instead of 80%. See docs/evaluation.md.
export const DEFAULT_QA_MIN_RERANK_PROBABILITY = 0.02;

export const getQaMinRerankProbability = () => {
  const rawValue = process.env.RAG_QA_MIN_RERANK_PROBABILITY;

  if (rawValue === undefined || String(rawValue).trim() === "") {
    return DEFAULT_QA_MIN_RERANK_PROBABILITY;
  }

  const value = Number(rawValue);

  return Number.isFinite(value) && value > 0 && value <= 1 ? value : null;
};

// What the rerank service returns: raw `logits` (this repo's endpoint, the
// sentence-transformers model output) or `probabilities` (Hugging Face TEI's
// default). The gate compares a probability.
export const getCrossEncoderScoreScale = () =>
  String(process.env.RAG_CROSS_ENCODER_SCORES ?? "").trim().toLowerCase() === "probabilities"
    ? "probabilities"
    : "logits";

// With the verdict on, a NOT_IN_EVIDENCE reply triggers one more retrieval
// this deep; the chunks the model has not seen yet that pass the gate get one
// more answer attempt. The model mostly refuses when the retrieved context
// lacks the evidence (70% of its QASPER refusals), not when the paper does.
// 0 turns the retry off.
export const DEFAULT_QA_VERDICT_RETRY_TOP_K = 18;

export const getQaVerdictRetryTopK = () => {
  const rawValue = process.env.RAG_QA_VERDICT_RETRY_TOP_K;

  return rawValue === undefined || String(rawValue).trim() === ""
    ? DEFAULT_QA_VERDICT_RETRY_TOP_K
    : Math.floor(toNonNegativeNumber(rawValue, DEFAULT_QA_VERDICT_RETRY_TOP_K));
};

export const getQaPartialCoverageFloor = () =>
  Math.min(
    1,
    toPositiveNumber(process.env.RAG_QA_PARTIAL_COVERAGE_FLOOR, DEFAULT_QA_PARTIAL_COVERAGE_FLOOR)
  );

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

const getLlmOpsMaxTokensPerEvent = () => {
  const value = toNonNegativeNumber(
    process.env.RAG_LLMOPS_MAX_TOKENS_PER_EVENT,
    null
  );

  return value === null ? null : Math.floor(value);
};

export const getLlmOpsPolicy = () => ({
  alerts: {
    budgetExceeded: toBoolean(
      process.env.RAG_LLMOPS_ALERT_BUDGET_EXCEEDED,
      true
    ),
    errorStatus: toBoolean(process.env.RAG_LLMOPS_ALERT_ERRORS, true),
    estimatedUsage: toBoolean(
      process.env.RAG_LLMOPS_ALERT_ESTIMATED_USAGE,
      false
    ),
    latencySloBreach: toBoolean(
      process.env.RAG_LLMOPS_ALERT_LATENCY_SLO,
      true
    ),
    pricingUnavailable: toBoolean(
      process.env.RAG_LLMOPS_ALERT_PRICING_UNAVAILABLE,
      false
    ),
  },
  budget: {
    maxEstimatedCostUsdPerEvent: toNonNegativeNumber(
      process.env.RAG_LLMOPS_MAX_COST_USD_PER_EVENT,
      null
    ),
    maxTotalTokensPerEvent: getLlmOpsMaxTokensPerEvent(),
  },
  enabled: toBoolean(process.env.RAG_LLMOPS_POLICY_ENABLED, true),
  enforcementMode: toChoice(process.env.RAG_LLMOPS_ENFORCEMENT_MODE, "record", [
    "block",
    "record",
  ]),
});

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

// Row-level security: "enforce" runs every query issued for a scoped request or
// task under the tenant role, so PostgreSQL rejects rows outside the caller's
// user/workspace even when a query forgets its WHERE clause. "off" keeps the
// owner connection (policies stay installed but the owner bypasses them). An
// unrecognized value fails closed to "enforce".
export const getPostgresRowLevelSecurityMode = () =>
  toChoice(process.env.POSTGRES_ROW_LEVEL_SECURITY, "enforce", ["enforce", "off"]);

const POSTGRES_ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export const getPostgresTenantRole = () => {
  const role = String(process.env.POSTGRES_TENANT_ROLE ?? "").trim() || "archive_rag_tenant";

  if (!POSTGRES_ROLE_NAME_PATTERN.test(role)) {
    throw new Error(
      `POSTGRES_TENANT_ROLE must be a lowercase PostgreSQL identifier of at most 63 bytes. Received "${role}".`
    );
  }

  return role;
};

export const getLongMemoryDatabaseUrl = () =>
  getPostgresDatabaseUrl();

export const getLongMemoryPostgresTable = () =>
  (process.env.LONG_MEMORY_POSTGRES_TABLE || "long_memory_items").trim();

export const isLongMemoryPostgresSslEnabled = () =>
  isPostgresSslEnabled();

export const getDocumentsPostgresTable = () =>
  (process.env.DOCUMENTS_POSTGRES_TABLE || "rag_documents").trim();

// Upload ingestion. `sync` (default) parses, embeds and indexes inside the
// upload request, which answers 201 with the document. `async` validates the
// upload, stores its bytes in an ingest job and answers 202; a worker claims the
// job and runs the same ingest (rag/ingest-worker.js). An unknown value keeps
// the synchronous behaviour, which the frontend handles either way.
export const RAG_INGEST_MODES = Object.freeze(["sync", "async"]);

export const getRagIngestMode = () =>
  toChoice(process.env.RAG_INGEST_MODE, "sync", RAG_INGEST_MODES);

export const isRagIngestAsync = () => getRagIngestMode() === "async";

// Every API process also runs a worker loop unless this is false, which is how
// ingestion moves to dedicated `npm run worker:ingest` processes.
export const isRagIngestWorkerEnabled = () =>
  toBoolean(process.env.RAG_INGEST_WORKER_ENABLED, true);

export const getRagIngestWorkerConcurrency = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_WORKER_CONCURRENCY, 2)) || 1;

// How long an idle worker loop sleeps before it looks at the queue again. An
// enqueue wakes idle loops at once (in this process directly, in other worker
// processes through PostgreSQL NOTIFY), so this only bounds how late a job is
// picked up when that wake-up is lost: a dropped LISTEN connection, a retry
// whose backoff has run out, a lease that expired.
export const getRagIngestWorkerPollMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_WORKER_POLL_MS, 1000)) || 1000;

// Renewed while a job runs; a worker that stops renewing loses the job to the
// next claim once the lease has expired.
export const getRagIngestJobLeaseMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_JOB_LEASE_MS, 60000)) || 60000;

export const getRagIngestJobMaxAttempts = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_JOB_MAX_ATTEMPTS, 3)) || 3;

// A 202 costs the client about a second, so without a cap one tenant could
// queue unbounded bytes. Counted over the tenant's queued and running jobs;
// an upload over either cap answers 429. 0 disables a cap.
export const getRagIngestMaxPendingJobsPerTenant = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT, 50));

export const getRagIngestMaxPendingBytesPerTenant = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_INGEST_MAX_PENDING_BYTES_PER_TENANT, 1024 * 1024 * 1024)
  );

// Succeeded and failed jobs (their bytes are already gone) are deleted by the
// workers' housekeeping once they are this old. 0 keeps them forever.
export const getRagIngestJobRetentionMs = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_INGEST_JOB_RETENTION_MS, 7 * 24 * 60 * 60 * 1000)
  );

export const getIngestJobsPostgresTable = () =>
  (process.env.INGEST_JOBS_POSTGRES_TABLE || "rag_ingest_jobs").trim();

// Deliberately no "auto" and defaulting to postgres, unlike the task/agent-run
// providers. The document registry store is *injected*
// (configureDocumentRegistryStore), not selected by config, so there is nothing
// to auto-detect -- and a health check that guessed "filesystem" from the absence
// of a database URL would report a backend that nothing had actually installed.
// Only server/standalone-profile.js sets this, and it sets it alongside injecting
// the matching store, so the two cannot disagree.
export const getDocumentStoreProvider = () =>
  toChoice(process.env.DOCUMENT_STORE_PROVIDER, "postgres", [
    "filesystem",
    "postgres",
  ]);

export const getSessionMemoryPostgresTable = () =>
  (process.env.SESSION_MEMORY_POSTGRES_TABLE || "rag_session_memory").trim();

export const getSessionMemoryStoreProvider = () =>
  toChoice(process.env.SESSION_MEMORY_STORE_PROVIDER, "postgres", [
    "memory",
    "postgres",
  ]);

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

export const getWorkspaceArtifactStoreProvider = () =>
  toChoice(process.env.WORKSPACE_ARTIFACT_STORE_PROVIDER, "auto", [
    "auto",
    "memory",
    "postgres",
  ]);

export const getWorkspaceArtifactStoreConfigStatus = ({
  postgresConfigured = isPostgresDatabaseConfigured(),
  provider = getWorkspaceArtifactStoreProvider(),
} = {}) => {
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

export const getWorkspaceArtifactsPostgresTable = () =>
  (
    process.env.WORKSPACE_ARTIFACTS_POSTGRES_TABLE ||
    "rag_workspace_artifacts"
  ).trim();

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

export const getApiAuthTokens = () => process.env.API_AUTH_TOKENS || "";

export const isApiAuthJwtEnabled = () =>
  toBoolean(process.env.API_AUTH_JWT_ENABLED, false);

export const getApiAuthJwtSecret = () =>
  process.env.API_AUTH_JWT_HS256_SECRET || process.env.API_AUTH_JWT_SECRET || "";

export const getApiAuthJwtIssuer = () =>
  (process.env.API_AUTH_JWT_ISSUER || "").trim();

export const getApiAuthJwtAudience = () =>
  (process.env.API_AUTH_JWT_AUDIENCE || "").trim();

export const getApiAuthJwtUserClaim = () =>
  (process.env.API_AUTH_JWT_USER_CLAIM || "sub").trim();

export const getApiAuthJwtWorkspaceClaim = () =>
  (process.env.API_AUTH_JWT_WORKSPACE_CLAIM || "workspace_id").trim();

export const getApiAuthJwtWorkspacesClaim = () =>
  (process.env.API_AUTH_JWT_WORKSPACES_CLAIM || "workspaces").trim();

export const getApiAuthJwtRolesClaim = () =>
  (process.env.API_AUTH_JWT_ROLES_CLAIM || "roles").trim();

export const getApiAuthJwtPermissionsClaim = () =>
  (process.env.API_AUTH_JWT_PERMISSIONS_CLAIM || "permissions").trim();

export const getApiAuthRevokedTokenHashes = () =>
  (process.env.API_AUTH_REVOKED_TOKEN_HASHES || "").trim();

export const getApiAuthRevokedJtis = () =>
  (process.env.API_AUTH_REVOKED_JTIS || "").trim();

export const isApiAuthWorkspaceRequired = () =>
  toBoolean(process.env.API_AUTH_REQUIRE_WORKSPACE, false);

export const getApiAuthConfigStatus = () => {
  const enabled = isApiAuthEnabled();
  const jwtEnabled = isApiAuthJwtEnabled();
  const jwtSecretConfigured = Boolean(getApiAuthJwtSecret().trim());
  const staticTokenConfigured = Boolean(
    getApiAuthToken().trim() || getApiAuthTokens().trim()
  );
  const status = !enabled
    ? "disabled"
    : jwtEnabled && !jwtSecretConfigured
      ? "error"
      : staticTokenConfigured || (jwtEnabled && jwtSecretConfigured)
        ? "ok"
        : "error";

  return {
    enabled,
    jwtEnabled,
    jwtSecretConfigured,
    staticTokenConfigured,
    workspaceRequired: isApiAuthWorkspaceRequired(),
    modes: [
      ...(staticTokenConfigured ? ["static_token"] : []),
      ...(jwtEnabled ? ["jwt"] : []),
    ],
    status,
  };
};

export const isStartupHealthStrict = () =>
  toBoolean(process.env.STARTUP_HEALTH_STRICT, false);

// ---------------------------------------------------------------------------
// DATA track: pgvector index versions
// (rag/vector-store-pgvector-versions.js, rag/vector-store-pgvector-version-builder.js,
// vector-index.mjs). Nothing above this line belongs to this block.
// ---------------------------------------------------------------------------

// The versions registry (migration 016). Its pointer and build-progress tables
// are derived from this name (`<name>_pointer`, `<name>_build_progress`).
export const getIndexVersionsPostgresTable = () =>
  (process.env.INDEX_VERSIONS_POSTGRES_TABLE || "rag_index_versions").trim();

// How long an API process trusts the active-version pointer it read. A switch
// is picked up by every instance within this time without a restart; the old
// version keeps receiving every write for the dual-write grace period, so a
// search on a pointer read just before the switch still sees a complete index.
export const getIndexVersionPointerTtlMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_POINTER_TTL_MS, 2000)) || 2000;

// After an activation the previous version keeps receiving every ingest,
// delete and clear for this long, so a rollback inside the window loses
// nothing. The versions module never lets it drop below twice the pointer TTL.
export const getIndexVersionDualWriteGraceMs = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS, 24 * 60 * 60 * 1000)
  );

// A builder renews its lease with every document it writes; another builder
// may take over a building version only once the lease has expired.
export const getIndexVersionBuildLeaseMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_BUILD_LEASE_MS, 60000)) || 60000;

// Documents a builder reads, embeds and writes per batch.
export const getIndexVersionBuildBatchSize = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_BUILD_BATCH_SIZE, 16)) || 16;

// Documents a builder has in flight at once (read, parsed, embedded through
// the cross-document embedding batcher, written). Each is still written in its
// own transaction with its progress row, fenced on the same lease.
export const getIndexVersionBuildConcurrency = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_BUILD_CONCURRENCY, 4)) || 4;

// The per-process query embedding cache (rag/embedding-cache.js). Entries are
// keyed by embedding space and text, so a process serving an index version
// pinned to another model than its configuration caches that version's query
// vectors in the same cache, under the same size bound.
export const isQueryEmbeddingCacheEnabled = () =>
  !["0", "false", "no", "off"].includes(String(process.env.RAG_EMBEDDING_CACHE_ENABLED ?? "").trim().toLowerCase());

export const getQueryEmbeddingCacheMaxEntries = () =>
  Math.floor(toPositiveNumber(process.env.RAG_EMBEDDING_CACHE_MAX, 256)) || 256;

export const getQueryEmbeddingCacheTtlMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_EMBEDDING_CACHE_TTL_MS, 10 * 60 * 1000)) || 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// ADAPTER track: query-side linear embedding adapter (rag/query-adapter.js).
// ---------------------------------------------------------------------------

// Path of a trained adapter file (evaluation/train-query-adapter.py); a
// relative path resolves against the working directory. Empty, "off", "none"
// or "false" (the default) leaves query vectors exactly as the model returns
// them. It is applied only where it was measured: single-document QA
// retrieval on the hybrid route, for a query the embedding model embedded in
// the space the file was trained in (rag/query-adapter.js). Anything else
// searches unadapted; checks.queryAdapter reports an unreadable file as an
// error and a space or route it would never apply to as a warning. The file
// must be readable by the server process: evaluation/generated/ is neither
// committed nor copied into the Docker image, so mount or copy it there.
export const getEmbeddingQueryAdapterPath = () => {
  const value = String(process.env.RAG_EMBEDDING_QUERY_ADAPTER ?? "").trim();

  return ["", "0", "false", "no", "off", "none"].includes(value.toLowerCase()) ? "" : value;
};

// Retire drops a version table whose foreign key points at the documents
// table, which needs an AccessExclusiveLock on documents; while that request
// waits, every new reader of documents waits behind it. Each drop attempt
// therefore waits at most RAG_INDEX_VERSION_RETIRE_LOCK_TIMEOUT_MS for the
// lock, and retire makes up to RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS of them,
// RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS apart (jittered), before it reports
// the drop as pending.
export const getIndexVersionRetireLockTimeoutMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_RETIRE_LOCK_TIMEOUT_MS, 200)) || 200;

export const getIndexVersionRetireDropAttempts = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS, 25)) || 25;

export const getIndexVersionRetireRetryDelayMs = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS, 400));

// The task prefixes and the known width of an arbitrary model, for a version
// built under another model than the configured one. The environment overrides
// (RAG_EMBEDDING_*_PREFIX, RAG_EMBEDDING_DIMENSIONS) describe the configured
// model only, so they do not apply here.
export const getEmbeddingTaskPrefixesForModel = (model) => {
  const entry = EMBEDDING_TASK_PREFIXES.find((candidate) => candidate.pattern.test(String(model ?? "")));

  return { document: entry?.document ?? "", query: entry?.query ?? "" };
};

export const getKnownEmbeddingDimensionsForModel = (model) =>
  KNOWN_EMBEDDING_DIMENSIONS[String(model ?? "")] ?? null;

// The same identity rule as getEmbeddingIndexIdentity, for any model/prefix.
export const buildEmbeddingIndexIdentity = ({ model, documentPrefix = "" } = {}) => {
  const prefix = String(documentPrefix ?? "").trim();
  const modelName = String(model ?? "").trim();

  return prefix ? `${modelName}#${prefix}` : modelName;
};

// ---------------------------------------------------------------------------
// DATA track: staged ingestion pipeline
// (rag/ingest-pipeline.js, rag/ingest-embedding-batcher.js,
// rag/ingest-job-store.js, rag/ingest-worker.js, ingest-jobs.mjs).
// ---------------------------------------------------------------------------

// The stages an async ingest job runs, in order. Each stage persists its
// output before the next one starts, so a retry resumes where it failed.
export const RAG_INGEST_STAGES = Object.freeze(["parse", "chunk", "embed", "index"]);

// Default retry backoff of every stage (the one-step job's backoff before the
// pipeline was staged).
const INGEST_STAGE_RETRY_BASE_MS = 5000;
const INGEST_STAGE_RETRY_MAX_MS = 5 * 60 * 1000;

const readIngestStageSetting = (stage, suffix) =>
  process.env[`RAG_INGEST_${String(stage).toUpperCase()}_${suffix}`];

/**
 * Attempts and backoff of one stage. RAG_INGEST_<STAGE>_MAX_ATTEMPTS,
 * RAG_INGEST_<STAGE>_RETRY_BASE_MS and RAG_INGEST_<STAGE>_RETRY_MAX_MS
 * (STAGE = PARSE, CHUNK, EMBED or INDEX) override the defaults, which are the
 * job's RAG_INGEST_JOB_MAX_ATTEMPTS and the 5 s doubling backoff up to 5 min
 * every job had before. A stage that exhausts its attempts moves the job to
 * dead_letter.
 */
export const getRagIngestStageRetryPolicy = (stage) => {
  const maxAttempts =
    Math.floor(
      toPositiveNumber(readIngestStageSetting(stage, "MAX_ATTEMPTS"), getRagIngestJobMaxAttempts())
    ) || getRagIngestJobMaxAttempts();
  const baseDelayMs = Math.floor(
    toNonNegativeNumber(readIngestStageSetting(stage, "RETRY_BASE_MS"), INGEST_STAGE_RETRY_BASE_MS)
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    Math.floor(
      toNonNegativeNumber(readIngestStageSetting(stage, "RETRY_MAX_MS"), INGEST_STAGE_RETRY_MAX_MS)
    )
  );

  return { baseDelayMs, maxAttempts, maxDelayMs };
};

// Largest serialized output (parsed pages, chunks, embeddings) one stage may
// persist. A document whose output is larger fails with a 413 instead of
// filling the jobs table; 0 disables the bound.
export const getRagIngestStageOutputMaxBytes = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_INGEST_STAGE_OUTPUT_MAX_BYTES, 64 * 1024 * 1024)
  );

// Cross-document embedding batcher: embed-stage work of concurrent jobs in one
// process goes out as one embeddings request of at most this many inputs and
// (estimated) tokens, after waiting at most the linger window for more work.
// 512 inputs is also the request size of rag/openai-client.js.
export const getRagIngestEmbedBatchMaxItems = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_EMBED_BATCH_MAX_ITEMS, 512)) || 512;

export const getRagIngestEmbedBatchMaxTokens = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_EMBED_BATCH_MAX_TOKENS, 240000)) || 240000;

export const getRagIngestEmbedBatchLingerMs = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_INGEST_EMBED_BATCH_LINGER_MS, 25));

// RAG_INGEST_EMBED_BATCHING=false bypasses that batcher: each job's embed
// stage sends its own chunks as one request per embedding space, as a
// synchronous upload does. On by default; the switch exists so the batcher's
// effect can be measured against the unbatched path and turned off if a
// provider misbehaves on large mixed batches.
export const isRagIngestEmbedBatchingEnabled = () =>
  toBoolean(process.env.RAG_INGEST_EMBED_BATCHING, true);

// Identical bytes uploaded again by the same tenant (same owner and workspace)
// return the existing document instead of ingesting a copy. On by default;
// RAG_INGEST_DEDUP=false ingests every upload.
export const isRagIngestDedupEnabled = () => toBoolean(process.env.RAG_INGEST_DEDUP, true);

// Where each job's stage outputs live (migration 017): `<jobs table>_outputs`.
export const getIngestJobOutputsPostgresTable = () => `${getIngestJobsPostgresTable()}_outputs`;
