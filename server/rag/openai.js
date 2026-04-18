import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { getChatModel, getEmbeddingModel } from "./config.js";

let embeddingsInstance = null;
let chatModelInstance = null;
let customProvider = null;

const RETRY_DELAYS_MS = [250, 750, 1500];

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const isRetriableError = (error) => {
  const status = Number(error?.status);
  const code = String(error?.code ?? error?.cause?.code ?? "").toUpperCase();

  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
  ].includes(code);
};

const withRetry = async (operation, failureMessage) => {
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetriableError(error) || attempt === RETRY_DELAYS_MS.length) {
        break;
      }

      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  if (lastError instanceof Error && failureMessage) {
    lastError.message = `${failureMessage} ${lastError.message}`.trim();
  }

  throw lastError;
};

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
  if (customProvider?.getEmbeddings) {
    return customProvider.getEmbeddings();
  }

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
  if (customProvider?.getChatModel) {
    return customProvider.getChatModel();
  }

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

const getPromptMessageType = (message) => {
  if (typeof message?.getType === "function") {
    return message.getType();
  }

  if (typeof message?._getType === "function") {
    return message._getType();
  }

  if (typeof message?.type === "string") {
    return message.type;
  }

  if (typeof message?.role === "string") {
    return message.role;
  }

  return "message";
};

const renderPromptMessages = (messages) =>
  messages
    .map((message) => {
      const role = getPromptMessageType(message).toUpperCase();
      const content = normalizeContent(message?.content);

      return content ? `${role}:\n${content}` : role;
    })
    .join("\n\n");

const renderPromptInput = (prompt) => {
  if (typeof prompt === "string") {
    return prompt;
  }

  if (Array.isArray(prompt)) {
    return renderPromptMessages(prompt);
  }

  if (typeof prompt?.toChatMessages === "function") {
    return renderPromptMessages(prompt.toChatMessages());
  }

  if (Array.isArray(prompt?.messages)) {
    return renderPromptMessages(prompt.messages);
  }

  return normalizeContent(prompt?.content ?? prompt);
};

export const configureOpenAIProvider = (provider) => {
  customProvider = provider ?? null;
  embeddingsInstance = null;
  chatModelInstance = null;
};

export const resetOpenAIProvider = () => {
  configureOpenAIProvider(null);
};

export const embedTexts = async (texts) => {
  if (customProvider?.embedTexts) {
    return customProvider.embedTexts(texts);
  }

  return withRetry(
    async () => getEmbeddings().embedDocuments(texts),
    "Embedding request failed."
  );
};

export const embedQuery = async (query) => {
  if (customProvider?.embedQuery) {
    return customProvider.embedQuery(query);
  }

  return withRetry(
    async () => getEmbeddings().embedQuery(query),
    "Query embedding request failed."
  );
};

export const completeText = async (prompt) => {
  if (customProvider?.completeText) {
    return customProvider.completeText(renderPromptInput(prompt));
  }

  const response = await withRetry(
    async () => getChatModelInstance().invoke(prompt),
    "Chat completion failed."
  );
  return normalizeContent(response.content);
};
