import { QdrantClient } from "@qdrant/js-client-rest";
import {
  getKeywordWeight,
  getQdrantApiKey,
  getQdrantCollection,
  getQdrantDistance,
  getQdrantUrl,
  getVectorWeight,
} from "./config.js";
import { embedTexts } from "./openai.js";
import {
  buildTermFrequencyMap,
  buildTermSet,
  extractMeaningfulTokens,
} from "./text-utils.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const QDRANT_DENSE_VECTOR_NAME = "dense";
const QDRANT_SPARSE_VECTOR_NAME = "sparse";
const QDRANT_SCROLL_PAGE_SIZE = 256;
const QDRANT_UPDATE_BATCH_SIZE = 128;

let qdrantClient = null;
let qdrantClientFactory = null;
let collectionChecked = false;
let collectionReady = false;
let sparseStateLoaded = false;
let sparseState = null;

const getClient = () => {
  if (qdrantClient) {
    return qdrantClient;
  }

  if (qdrantClientFactory) {
    qdrantClient = qdrantClientFactory();
    return qdrantClient;
  }

  const apiKey = getQdrantApiKey().trim();
  qdrantClient = new QdrantClient({
    url: getQdrantUrl(),
    apiKey: apiKey || undefined,
  });

  return qdrantClient;
};

const resetCollectionState = () => {
  collectionChecked = false;
  collectionReady = false;
  sparseStateLoaded = false;
  sparseState = null;
};

export const configureQdrantClientFactory = (factory) => {
  qdrantClientFactory = typeof factory === "function" ? factory : null;
  qdrantClient = null;
  resetCollectionState();
};

export const resetQdrantClientFactory = () => {
  configureQdrantClientFactory(null);
};

const buildSearchableText = ({ pageContent = "", metadata = {} } = {}) =>
  [metadata.fileName, metadata.sectionHeading, pageContent].filter(Boolean).join("\n");

const buildKeywordScore = (queryTerms, payload) => {
  if (queryTerms.size === 0) {
    return null;
  }

  const entryTerms = buildTermSet(
    buildSearchableText({
      pageContent: payload?.pageContent ?? "",
      metadata: payload,
    })
  );

  if (entryTerms.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const term of queryTerms) {
    if (entryTerms.has(term)) {
      overlap += 1;
    }
  }

  return overlap / queryTerms.size;
};

const buildCombinedScore = (vectorScore, keywordScore) => {
  if (keywordScore === null) {
    return vectorScore;
  }

  const weightedScore = vectorScore * getVectorWeight() + keywordScore * getKeywordWeight();

  return Math.max(vectorScore, keywordScore, weightedScore);
};

const buildDenseResultScore = ({ vectorScore, keywordScore, scoringMode }) =>
  scoringMode === "dense"
    ? vectorScore
    : buildCombinedScore(vectorScore, keywordScore);

const buildPointId = (document) => String(document.id);

const buildPointPayload = (document) => ({
  docId: document.metadata?.docId ?? "",
  fileName: document.metadata?.fileName ?? "Unknown document",
  filePath: document.metadata?.filePath ?? "",
  publicFilePath: document.metadata?.publicFilePath ?? "",
  pageNumber: document.metadata?.pageNumber ?? null,
  chunkIndex: document.metadata?.chunkIndex ?? null,
  sectionHeading: document.metadata?.sectionHeading ?? null,
  pageContent: document.pageContent,
});

const buildMetadataFromPayload = (payload = {}) => ({
  docId: payload.docId ?? "",
  fileName: payload.fileName ?? "Unknown document",
  filePath: payload.filePath ?? "",
  publicFilePath: payload.publicFilePath ?? "",
  pageNumber: payload.pageNumber ?? null,
  chunkIndex: payload.chunkIndex ?? null,
  sectionHeading: payload.sectionHeading ?? null,
});

const toDenseSearchResult = (point, keywordScore, scoringMode) => {
  const payload = point.payload ?? {};
  const vectorScore = Number(point.score ?? 0);

  return {
    document: {
      id: String(point.id),
      pageContent: String(payload.pageContent ?? ""),
      metadata: buildMetadataFromPayload(payload),
    },
    score: buildDenseResultScore({
      vectorScore,
      keywordScore,
      scoringMode,
    }),
    vectorScore,
    keywordScore,
  };
};

const toSparseSearchResult = (point, keywordScore) => {
  const payload = point.payload ?? {};
  const sparseScore = Number(point.score ?? 0);

  return {
    document: {
      id: String(point.id),
      pageContent: String(payload.pageContent ?? ""),
      metadata: buildMetadataFromPayload(payload),
    },
    score: sparseScore,
    sparseScore,
    keywordScore,
  };
};

const buildDocIdFilter = (docIds) => {
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return undefined;
  }

  if (docIds.length === 1) {
    return {
      must: [
        {
          key: "docId",
          match: {
            value: docIds[0],
          },
        },
      ],
    };
  }

  return {
    should: docIds.map((docId) => ({
      key: "docId",
      match: {
        value: docId,
      },
    })),
  };
};

const isDenseVectorConfigCompatible = (vectorsConfig = null) => {
  if (!vectorsConfig || Array.isArray(vectorsConfig)) {
    return false;
  }

  if (typeof vectorsConfig.size === "number") {
    return false;
  }

  return Boolean(vectorsConfig?.[QDRANT_DENSE_VECTOR_NAME]);
};

const isSparseVectorConfigCompatible = (sparseVectorsConfig = null) =>
  Boolean(sparseVectorsConfig?.[QDRANT_SPARSE_VECTOR_NAME]);

const ensureCompatibleCollectionSchema = async () => {
  const collectionInfo = await getClient().getCollection(getQdrantCollection());
  const params = collectionInfo?.config?.params ?? {};
  const vectorsConfig = params.vectors ?? null;
  const sparseVectorsConfig = params.sparse_vectors ?? null;

  if (
    isDenseVectorConfigCompatible(vectorsConfig) &&
    isSparseVectorConfigCompatible(sparseVectorsConfig)
  ) {
    return true;
  }

  throw new Error(
    [
      "The configured Qdrant collection schema is incompatible with this app.",
      `Expected a named dense vector '${QDRANT_DENSE_VECTOR_NAME}' and a named sparse vector '${QDRANT_SPARSE_VECTOR_NAME}'.`,
      `Use a fresh collection name or clear the existing '${getQdrantCollection()}' collection before ingesting again.`,
    ].join(" ")
  );
};

const ensureCollection = async (vectorSize = null) => {
  if (collectionReady) {
    return true;
  }

  const client = getClient();

  if (!collectionChecked) {
    const existence = await client.collectionExists(getQdrantCollection());
    collectionChecked = true;
    collectionReady = Boolean(existence?.exists);

    if (collectionReady) {
      await ensureCompatibleCollectionSchema();
      return true;
    }
  }

  if (collectionReady) {
    return true;
  }

  if (!vectorSize) {
    return false;
  }

  await client.createCollection(getQdrantCollection(), {
    vectors: {
      [QDRANT_DENSE_VECTOR_NAME]: {
        size: vectorSize,
        distance: getQdrantDistance(),
      },
    },
    sparse_vectors: {
      [QDRANT_SPARSE_VECTOR_NAME]: {},
    },
  });

  collectionReady = true;
  collectionChecked = true;
  sparseStateLoaded = false;
  return true;
};

const chunkArray = (values, size) => {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const buildSparseEntry = ({ id, payload = {} }) => {
  const pageContent = String(payload.pageContent ?? "");
  const metadata = buildMetadataFromPayload(payload);
  const termFrequencies = buildTermFrequencyMap(
    buildSearchableText({
      pageContent,
      metadata,
    })
  );
  const terms = [...termFrequencies.keys()];

  return {
    id: String(id),
    payload: {
      ...metadata,
      pageContent,
    },
    pageContent,
    metadata,
    termFrequencies,
    termSet: new Set(terms),
    documentLength: [...termFrequencies.values()].reduce((sum, value) => sum + value, 0),
  };
};

const buildSparseState = (entries) => {
  const documentFrequencyByTerm = new Map();
  const allTerms = new Set();
  let totalDocumentLength = 0;

  for (const entry of entries) {
    totalDocumentLength += entry.documentLength;

    for (const term of entry.termSet) {
      allTerms.add(term);
      documentFrequencyByTerm.set(term, (documentFrequencyByTerm.get(term) ?? 0) + 1);
    }
  }

  const sortedTerms = [...allTerms].sort((left, right) => left.localeCompare(right));
  const termIndexByTerm = new Map(
    sortedTerms.map((term, index) => [term, index])
  );

  return {
    entries,
    documentFrequencyByTerm,
    averageDocumentLength:
      entries.length > 0 ? totalDocumentLength / entries.length : 0,
    termIndexByTerm,
  };
};

const getInverseDocumentFrequency = (term, state) => {
  const documentCount = state.entries.length;

  if (documentCount === 0) {
    return 0;
  }

  const documentFrequency = state.documentFrequencyByTerm.get(term) ?? 0;

  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
};

const buildSparseVectorForEntry = (entry, state) => {
  if (!entry || entry.documentLength === 0 || state.entries.length === 0) {
    return null;
  }

  const averageLength = state.averageDocumentLength || 1;
  const components = [];

  for (const [term, termFrequency] of entry.termFrequencies.entries()) {
    const index = state.termIndexByTerm.get(term);

    if (index === undefined || termFrequency <= 0) {
      continue;
    }

    const idf = getInverseDocumentFrequency(term, state);
    const denominator =
      termFrequency +
      BM25_K1 * (1 - BM25_B + BM25_B * (entry.documentLength / averageLength));
    const value = idf * ((termFrequency * (BM25_K1 + 1)) / denominator);

    if (value > 0) {
      components.push([index, value]);
    }
  }

  if (components.length === 0) {
    return null;
  }

  components.sort((left, right) => left[0] - right[0]);

  return {
    indices: components.map(([index]) => index),
    values: components.map(([, value]) => value),
  };
};

const buildSparseQuery = (queryText, state) => {
  const queryTerms = [...new Set(extractMeaningfulTokens(queryText))];
  const indices = [];
  const values = [];

  for (const term of queryTerms) {
    const index = state.termIndexByTerm.get(term);

    if (index === undefined) {
      continue;
    }

    indices.push(index);
    values.push(1);
  }

  if (indices.length === 0) {
    return null;
  }

  return {
    queryTerms,
    sparseVector: {
      indices,
      values,
    },
  };
};

const scrollAllQdrantPoints = async ({ filter } = {}) => {
  const ready = await ensureCollection();

  if (!ready) {
    return [];
  }

  const points = [];
  let offset = undefined;

  while (true) {
    const response = await getClient().scroll(getQdrantCollection(), {
      limit: QDRANT_SCROLL_PAGE_SIZE,
      offset,
      filter,
      with_payload: true,
      with_vector: false,
    });
    const batch = response?.points ?? [];

    points.push(...batch);
    offset = response?.next_page_offset;

    if (!offset || batch.length === 0) {
      break;
    }
  }

  return points;
};

const refreshSparseStateFromQdrant = async () => {
  const points = await scrollAllQdrantPoints();

  sparseState = buildSparseState(
    points.map((point) =>
      buildSparseEntry({
        id: point.id,
        payload: point.payload ?? {},
      })
    )
  );
  sparseStateLoaded = true;
  return sparseState;
};

const ensureSparseState = async () => {
  if (sparseStateLoaded) {
    return sparseState ?? buildSparseState([]);
  }

  return refreshSparseStateFromQdrant();
};

const deleteDocumentsByDocIds = async ({ docIds }) => {
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return;
  }

  await getClient().delete(getQdrantCollection(), {
    wait: true,
    filter: buildDocIdFilter(docIds),
  });
};

const updateSparseVectorsForEntries = async (entries, state) => {
  const updates = entries
    .map((entry) => {
      const sparseVector = buildSparseVectorForEntry(entry, state);

      if (!sparseVector) {
        return null;
      }

      return {
        id: entry.id,
        vector: {
          [QDRANT_SPARSE_VECTOR_NAME]: sparseVector,
        },
      };
    })
    .filter(Boolean);

  for (const batch of chunkArray(updates, QDRANT_UPDATE_BATCH_SIZE)) {
    await getClient().updateVectors(getQdrantCollection(), {
      wait: true,
      points: batch,
    });
  }
};

export const addDocumentsToQdrantIndex = async ({ documents }) => {
  if (!Array.isArray(documents) || documents.length === 0) {
    return;
  }

  const denseVectors = await embedTexts(documents.map((document) => document.pageContent));

  if (denseVectors.length === 0) {
    return;
  }

  await ensureCollection(denseVectors[0]?.length ?? null);

  const replacementDocIds = [
    ...new Set(documents.map((document) => document.metadata?.docId).filter(Boolean)),
  ];

  if (replacementDocIds.length > 0) {
    await deleteDocumentsByDocIds({
      docIds: replacementDocIds,
    });
  }

  const currentState = await refreshSparseStateFromQdrant();
  const nextEntries = documents.map((document) =>
    buildSparseEntry({
      id: buildPointId(document),
      payload: buildPointPayload(document),
    })
  );
  const combinedState = buildSparseState([...currentState.entries, ...nextEntries]);

  await getClient().upsert(getQdrantCollection(), {
    wait: true,
    points: documents.map((document, index) => ({
      id: buildPointId(document),
      vector: {
        [QDRANT_DENSE_VECTOR_NAME]: denseVectors[index],
        [QDRANT_SPARSE_VECTOR_NAME]: buildSparseVectorForEntry(nextEntries[index], combinedState),
      },
      payload: buildPointPayload(document),
    })),
  });

  await updateSparseVectorsForEntries(currentState.entries, combinedState);

  sparseState = combinedState;
  sparseStateLoaded = true;
};

export const removeDocumentsFromQdrantIndex = async ({ docIds }) => {
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return;
  }

  const ready = await ensureCollection();

  if (!ready) {
    return;
  }

  await deleteDocumentsByDocIds({
    docIds,
  });

  const nextState = await refreshSparseStateFromQdrant();

  if (nextState.entries.length > 0) {
    await updateSparseVectorsForEntries(nextState.entries, nextState);
  }
};

export const clearQdrantVectorIndex = async () => {
  const ready = await ensureCollection();

  if (!ready) {
    resetCollectionState();
    return;
  }

  await getClient().deleteCollection(getQdrantCollection(), {
    timeout: 30,
  });
  resetCollectionState();
};

export const searchQdrantDocuments = async ({
  queryVector,
  queryText = "",
  docIds,
  topK,
  scoringMode = "combined",
}) => {
  const ready = await ensureCollection();

  if (!ready) {
    return [];
  }

  const response = await getClient().query(getQdrantCollection(), {
    query: queryVector,
    using: QDRANT_DENSE_VECTOR_NAME,
    filter: buildDocIdFilter(docIds),
    limit: topK,
    with_payload: true,
  });
  const queryTerms = buildTermSet(queryText);

  return (response?.points ?? [])
    .map((point) =>
      toDenseSearchResult(
        point,
        buildKeywordScore(queryTerms, point.payload ?? {}),
        scoringMode
      )
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.vectorScore - left.vectorScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    );
};

export const searchQdrantSparseDocuments = async ({
  queryText = "",
  docIds,
  topK,
}) => {
  const ready = await ensureCollection();

  if (!ready) {
    return [];
  }

  const state = await ensureSparseState();
  const sparseQuery = buildSparseQuery(queryText, state);

  if (!sparseQuery) {
    return [];
  }

  const queryTerms = new Set(sparseQuery.queryTerms);
  const response = await getClient().query(getQdrantCollection(), {
    query: sparseQuery.sparseVector,
    using: QDRANT_SPARSE_VECTOR_NAME,
    filter: buildDocIdFilter(docIds),
    limit: topK,
    with_payload: true,
  });

  return (response?.points ?? [])
    .map((point) =>
      toSparseSearchResult(
        point,
        buildKeywordScore(queryTerms, point.payload ?? {})
      )
    )
    .sort(
      (left, right) =>
        right.sparseScore - left.sparseScore ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    );
};

export const searchQdrantDocumentsPerDocument = async ({
  queryVector,
  queryText = "",
  docIds,
  topKPerDoc,
  scoringMode = "combined",
}) => {
  const perDocumentResults = new Map();

  for (const docId of docIds) {
    perDocumentResults.set(
      docId,
      await searchQdrantDocuments({
        queryVector,
        queryText,
        docIds: [docId],
        topK: topKPerDoc,
        scoringMode,
      })
    );
  }

  return perDocumentResults;
};

export const resetQdrantVectorStore = () => {
  qdrantClient = null;
  resetCollectionState();
};
