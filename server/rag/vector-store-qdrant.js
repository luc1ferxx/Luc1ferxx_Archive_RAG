import { randomUUID } from "crypto";
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
import { buildTermSet } from "./text-utils.js";

let qdrantClient = null;
let collectionChecked = false;
let collectionReady = false;

const getClient = () => {
  if (qdrantClient) {
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
};

const buildKeywordScore = (queryTerms, payload) => {
  if (queryTerms.size === 0) {
    return null;
  }

  const searchableText = [
    payload?.fileName,
    payload?.sectionHeading,
    payload?.pageContent,
  ]
    .filter(Boolean)
    .join("\n");
  const entryTerms = buildTermSet(searchableText);

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

const buildResultScore = ({ vectorScore, keywordScore, scoringMode }) =>
  scoringMode === "dense"
    ? vectorScore
    : buildCombinedScore(vectorScore, keywordScore);

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

const toSearchResult = (point, keywordScore, scoringMode) => {
  const payload = point.payload ?? {};
  const vectorScore = Number(point.score ?? 0);

  return {
    document: {
      id: String(point.id),
      pageContent: String(payload.pageContent ?? ""),
      metadata: buildMetadataFromPayload(payload),
    },
    score: buildResultScore({
      vectorScore,
      keywordScore,
      scoringMode,
    }),
    vectorScore,
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

const ensureCollection = async (vectorSize = null) => {
  if (collectionReady) {
    return true;
  }

  const client = getClient();

  if (!collectionChecked) {
    const existence = await client.collectionExists(getQdrantCollection());
    collectionChecked = true;
    collectionReady = Boolean(existence?.exists);
  }

  if (collectionReady) {
    return true;
  }

  if (!vectorSize) {
    return false;
  }

  await client.createCollection(getQdrantCollection(), {
    vectors: {
      size: vectorSize,
      distance: getQdrantDistance(),
    },
  });

  collectionReady = true;
  collectionChecked = true;
  return true;
};

export const addDocumentsToQdrantIndex = async ({ documents }) => {
  if (!Array.isArray(documents) || documents.length === 0) {
    return;
  }

  const vectors = await embedTexts(documents.map((document) => document.pageContent));

  if (vectors.length === 0) {
    return;
  }

  await ensureCollection(vectors[0]?.length ?? null);
  await removeDocumentsFromQdrantIndex({
    docIds: [...new Set(documents.map((document) => document.metadata?.docId).filter(Boolean))],
  });

  await getClient().upsert(getQdrantCollection(), {
    wait: true,
    points: documents.map((document, index) => ({
      id: randomUUID(),
      vector: vectors[index],
      payload: buildPointPayload(document),
    })),
  });
};

export const removeDocumentsFromQdrantIndex = async ({ docIds }) => {
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return;
  }

  const ready = await ensureCollection();

  if (!ready) {
    return;
  }

  await getClient().delete(getQdrantCollection(), {
    wait: true,
    filter: buildDocIdFilter(docIds),
  });
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
    filter: buildDocIdFilter(docIds),
    limit: topK,
    with_payload: true,
  });
  const queryTerms = buildTermSet(queryText);

  return (response?.points ?? [])
    .map((point) =>
      toSearchResult(
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
