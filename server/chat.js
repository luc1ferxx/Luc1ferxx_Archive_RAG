import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings, ChatOpenAI } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { PromptTemplate } from "@langchain/core/prompts";
import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import path from "path";

const documentStore = new Map();

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const RETRIEVAL_TOP_K = 6;
const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-5";

let embeddingsInstance = null;
let globalVectorStorePromise = null;

const normalizeDocIds = (docIds) => {
  if (Array.isArray(docIds)) {
    return [...new Set(docIds.map((docId) => docId?.trim()).filter(Boolean))];
  }

  if (typeof docIds === "string") {
    return [
      ...new Set(
        docIds
          .split(",")
          .map((docId) => docId.trim())
          .filter(Boolean)
      ),
    ];
  }

  return [];
};

const getOpenAIApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not configured.");
    error.status = 500;
    throw error;
  }

  return apiKey;
};

const getEmbeddings = () => {
  if (embeddingsInstance) {
    return embeddingsInstance;
  }

  embeddingsInstance = new OpenAIEmbeddings({
    apiKey: getOpenAIApiKey(),
    model: EMBEDDING_MODEL,
  });

  return embeddingsInstance;
};

const getGlobalVectorStore = async () => {
  if (!globalVectorStorePromise) {
    globalVectorStorePromise = MemoryVectorStore.fromExistingIndex(
      getEmbeddings()
    );
  }

  return globalVectorStorePromise;
};

const getPageNumber = (metadata = {}) =>
  metadata.loc?.pageNumber ?? metadata.page ?? metadata.pageNumber ?? null;

const buildPublicFilePath = (filePath = "") =>
  filePath ? `uploads/${path.basename(filePath).replace(/\\/g, "/")}` : "";

const cleanExcerpt = (text) =>
  text.replace(/\s+/g, " ").trim().slice(0, 220);

const buildCitation = (document, score, rank) => ({
  rank,
  score: Number(score.toFixed(4)),
  docId: document.metadata?.docId ?? null,
  fileName: document.metadata?.fileName ?? "Unknown document",
  filePath: document.metadata?.publicFilePath ?? "",
  pageNumber: getPageNumber(document.metadata),
  chunkIndex: document.metadata?.chunkIndex ?? null,
  excerpt: cleanExcerpt(document.pageContent),
});

const buildContextSection = (document, score, rank) => {
  const citation = buildCitation(document, score, rank);

  return [
    `Source ${rank}`,
    `File: ${citation.fileName}`,
    citation.pageNumber ? `Page: ${citation.pageNumber}` : null,
    `Similarity: ${citation.score}`,
    document.pageContent,
  ]
    .filter(Boolean)
    .join("\n");
};

export const ingestDocument = async ({ docId, filePath, fileName }) => {
  const loader = new PDFLoader(filePath);
  const data = await loader.load();

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const splitDocs = await textSplitter.splitDocuments(data);
  const enrichedDocs = splitDocs.map(
    (doc, index) =>
      new Document({
        id: `${docId}:${index}`,
        pageContent: doc.pageContent,
        metadata: {
          ...doc.metadata,
          docId,
          fileName,
          filePath,
          publicFilePath: buildPublicFilePath(filePath),
          chunkIndex: index,
        },
      })
  );

  const vectorStore = await getGlobalVectorStore();
  await vectorStore.addDocuments(enrichedDocs);

  documentStore.set(docId, {
    docId,
    fileName,
    filePath,
    publicFilePath: buildPublicFilePath(filePath),
    chunkCount: enrichedDocs.length,
    pageCount: data.length,
    uploadedAt: new Date().toISOString(),
  });

  return getDocument(docId);
};

export const getDocument = (docId) => {
  const document = documentStore.get(docId);

  if (!document) {
    return null;
  }

  return {
    docId: document.docId,
    fileName: document.fileName,
    filePath: document.filePath,
    publicFilePath: document.publicFilePath,
    chunkCount: document.chunkCount,
    pageCount: document.pageCount,
    uploadedAt: document.uploadedAt,
  };
};

export const getDocuments = (docIds) =>
  normalizeDocIds(docIds)
    .map((docId) => getDocument(docId))
    .filter(Boolean);

const chat = async (docIds, query) => {
  const normalizedDocIds = normalizeDocIds(docIds);

  if (normalizedDocIds.length === 0) {
    const error = new Error("At least one document is required.");
    error.status = 404;
    throw error;
  }

  const missingDocId = normalizedDocIds.find((docId) => !documentStore.has(docId));

  if (missingDocId) {
    const error = new Error(
      `Document not found for docId ${missingDocId}. Upload the PDF again and use the latest docId.`
    );
    error.status = 404;
    throw error;
  }

  const vectorStore = await getGlobalVectorStore();
  const queryEmbedding = await getEmbeddings().embedQuery(query);
  const searchResults = await vectorStore.similaritySearchVectorWithScore(
    queryEmbedding,
    RETRIEVAL_TOP_K,
    (document) => normalizedDocIds.includes(document.metadata?.docId)
  );

  if (searchResults.length === 0) {
    return {
      text: "I couldn't find relevant context in the uploaded documents.",
      citations: [],
    };
  }

  const citations = searchResults.map(([document, score], index) =>
    buildCitation(document, score, index + 1)
  );
  const context = searchResults
    .map(([document, score], index) =>
      buildContextSection(document, score, index + 1)
    )
    .join("\n\n");

  const model = new ChatOpenAI({
    model: CHAT_MODEL,
    apiKey: getOpenAIApiKey(),
  });

  const template = `Use the following retrieved context from the uploaded documents to answer the question.
If the context is insufficient, say so directly.
Keep the answer concise, at most four sentences.
When the answer relies on specific evidence, refer to the source labels (for example: Source 1, Source 2).

{context}

Question: {question}
Helpful Answer:`;

  const prompt = PromptTemplate.fromTemplate(template);
  const formattedPrompt = await prompt.format({
    context,
    question: query,
  });
  const response = await model.invoke(formattedPrompt);

  return {
    text: response.content,
    citations,
  };
};

export default chat;
