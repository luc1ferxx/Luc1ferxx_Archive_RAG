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

export const getChunkStrategy = () =>
  (process.env.RAG_CHUNK_STRATEGY || "structured").trim().toLowerCase();

export const isHybridRetrievalEnabled = () =>
  toBoolean(process.env.RAG_HYBRID_ENABLED, false);

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

export const isNearDuplicateGuardEnabled = () =>
  toBoolean(process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED, true);
