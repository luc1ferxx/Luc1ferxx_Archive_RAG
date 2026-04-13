import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { getChatModel, getEmbeddingModel } from "./config.js";

let embeddingsInstance = null;
let chatModelInstance = null;

export const getOpenAIApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not configured.");
    error.status = 500;
    throw error;
  }

  return apiKey;
};

export const getEmbeddings = () => {
  if (embeddingsInstance) {
    return embeddingsInstance;
  }

  embeddingsInstance = new OpenAIEmbeddings({
    apiKey: getOpenAIApiKey(),
    model: getEmbeddingModel(),
  });

  return embeddingsInstance;
};

const getChatModelInstance = () => {
  if (chatModelInstance) {
    return chatModelInstance;
  }

  chatModelInstance = new ChatOpenAI({
    model: getChatModel(),
    apiKey: getOpenAIApiKey(),
  });

  return chatModelInstance;
};

const normalizeContent = (content) => {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (typeof part?.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
};

export const embedTexts = async (texts) => getEmbeddings().embedDocuments(texts);

export const embedQuery = async (query) => getEmbeddings().embedQuery(query);

export const completeText = async (prompt) => {
  const response = await getChatModelInstance().invoke(prompt);
  return normalizeContent(response.content);
};
