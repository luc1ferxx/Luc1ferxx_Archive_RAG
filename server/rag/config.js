const toPositiveNumber = (rawValue, fallbackValue) => {
  const parsedValue = Number(rawValue);

  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallbackValue;
};

export const getEmbeddingModel = () =>
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

export const getChatModel = () => process.env.OPENAI_CHAT_MODEL || "gpt-5";

export const getChunkSize = () =>
  toPositiveNumber(process.env.RAG_CHUNK_SIZE, 900);

export const getChunkOverlap = () =>
  toPositiveNumber(process.env.RAG_CHUNK_OVERLAP, 180);

export const getRetrievalTopK = () =>
  Math.floor(toPositiveNumber(process.env.RAG_RETRIEVAL_TOP_K, 6));

export const getComparisonTopKPerDoc = () =>
  Math.floor(toPositiveNumber(process.env.RAG_COMPARE_TOP_K_PER_DOC, 3));

export const getMaxComparisonSources = () =>
  Math.floor(toPositiveNumber(process.env.RAG_MAX_COMPARISON_SOURCES, 8));

export const getMinRelevanceScore = () =>
  toPositiveNumber(process.env.RAG_MIN_RELEVANCE_SCORE, 0.32);

export const getVectorWeight = () =>
  toPositiveNumber(process.env.RAG_VECTOR_WEIGHT, 0.82);

export const getKeywordWeight = () =>
  toPositiveNumber(process.env.RAG_KEYWORD_WEIGHT, 0.18);
