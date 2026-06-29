import { getChatModel, getEmbeddingModel } from "../../config.js";
import {
  MODEL_CAPABILITIES,
  MODEL_PROVIDER_SPEC_VERSION,
  MODEL_PROVIDER_TYPE,
  MODEL_ROUTE_IDS,
} from "../schema.js";

export const OPENAI_MODEL_PROVIDER_ID = "openai";
export const OPENAI_CHAT_MODEL_ID = "openai.chat";
export const OPENAI_EMBEDDING_MODEL_ID = "openai.embedding";

export const createOpenAIModelProviderSpec = ({
  chatModel = getChatModel(),
  embeddingModel = getEmbeddingModel(),
} = {}) => ({
  description:
    "Contract-only OpenAI model provider spec for chat, embeddings, and planner routing.",
  id: OPENAI_MODEL_PROVIDER_ID,
  label: "OpenAI",
  models: [
    {
      capabilities: [
        MODEL_CAPABILITIES.chat,
        MODEL_CAPABILITIES.intentPlanner,
        MODEL_CAPABILITIES.executionPlanner,
      ],
      contextWindowTokens: null,
      id: OPENAI_CHAT_MODEL_ID,
      label: "OpenAI chat model",
      latency: {
        tier: "remote",
        timeoutMs: 120000,
      },
      modelName: chatModel,
      policy: {
        allowExternalCall: true,
        dataRetention: "provider_default",
        workspacePolicyTags: ["remote_llm", "chat", "planner"],
      },
      pricing: {
        currency: "USD",
        inputPerMillionTokens: null,
        outputPerMillionTokens: null,
      },
      version: MODEL_PROVIDER_SPEC_VERSION,
    },
    {
      capabilities: [MODEL_CAPABILITIES.embedding],
      dimensions: null,
      id: OPENAI_EMBEDDING_MODEL_ID,
      label: "OpenAI embedding model",
      latency: {
        tier: "remote",
        timeoutMs: 120000,
      },
      modelName: embeddingModel,
      policy: {
        allowExternalCall: true,
        dataRetention: "provider_default",
        workspacePolicyTags: ["remote_llm", "embedding"],
      },
      pricing: {
        currency: "USD",
        inputPerMillionTokens: null,
        outputPerMillionTokens: null,
      },
      version: MODEL_PROVIDER_SPEC_VERSION,
    },
  ],
  routes: [
    {
      budgetKey: "chat",
      capability: MODEL_CAPABILITIES.chat,
      fallbackModelIds: [],
      id: MODEL_ROUTE_IDS.chatDefault,
      label: "Default chat model",
      primaryModelId: OPENAI_CHAT_MODEL_ID,
      workspacePolicyTags: ["remote_llm"],
    },
    {
      budgetKey: "embedding",
      capability: MODEL_CAPABILITIES.embedding,
      fallbackModelIds: [],
      id: MODEL_ROUTE_IDS.embeddingDefault,
      label: "Default embedding model",
      primaryModelId: OPENAI_EMBEDDING_MODEL_ID,
      workspacePolicyTags: ["remote_llm"],
    },
    {
      budgetKey: "planner",
      capability: MODEL_CAPABILITIES.intentPlanner,
      fallbackModelIds: [],
      id: MODEL_ROUTE_IDS.intentPlannerDefault,
      label: "Default intent planner model",
      primaryModelId: OPENAI_CHAT_MODEL_ID,
      workspacePolicyTags: ["remote_llm", "planner"],
    },
    {
      budgetKey: "planner",
      capability: MODEL_CAPABILITIES.executionPlanner,
      fallbackModelIds: [],
      id: MODEL_ROUTE_IDS.executionPlannerDefault,
      label: "Default execution planner model",
      primaryModelId: OPENAI_CHAT_MODEL_ID,
      workspacePolicyTags: ["remote_llm", "planner"],
    },
  ],
  transport: {
    auth: {
      mode: "secret_ref",
      secretRef: "OPENAI_API_KEY",
    },
    type: "openai",
  },
  type: MODEL_PROVIDER_TYPE,
  version: MODEL_PROVIDER_SPEC_VERSION,
});
