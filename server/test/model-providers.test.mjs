import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  MODEL_CAPABILITIES,
  MODEL_ROUTE_IDS,
  OPENAI_CHAT_MODEL_ID,
  OPENAI_EMBEDDING_MODEL_ID,
  OPENAI_MODEL_PROVIDER_ID,
  createBuiltInModelProviders,
  createModelProviderRegistry,
  createOpenAIModelProviderSpec,
  resetModelProviderRegistry,
  resolveModelRouteForRuntime,
  validateModelProviderSpec,
} from "../rag/model-providers/index.js";

afterEach(() => {
  resetModelProviderRegistry();
});

const createFallbackProviderSpec = () => ({
  ...createOpenAIModelProviderSpec({
    chatModel: "primary-chat",
    embeddingModel: "primary-embedding",
  }),
  models: [
    ...createOpenAIModelProviderSpec({
      chatModel: "primary-chat",
      embeddingModel: "primary-embedding",
    }).models,
    {
      capabilities: [MODEL_CAPABILITIES.chat],
      id: "openai.chat_fallback",
      label: "Fallback chat",
      latency: {
        tier: "remote",
        timeoutMs: 4500,
      },
      modelName: "fallback-chat",
      policy: {
        workspacePolicyTags: ["remote_llm", "chat"],
      },
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 0.25,
        outputPerMillionTokens: 1.5,
      },
    },
  ],
  routes: [
    {
      capability: MODEL_CAPABILITIES.chat,
      fallbackModelIds: ["openai.chat_fallback"],
      id: "chat.with_fallback",
      label: "Chat with fallback",
      primaryModelId: OPENAI_CHAT_MODEL_ID,
    },
  ],
});

test("OpenAI model provider spec validates chat, embedding, and planner routes", () => {
  const validation = validateModelProviderSpec(
    createOpenAIModelProviderSpec({
      chatModel: "gpt-test",
      embeddingModel: "text-embedding-test",
    })
  );

  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.spec.id, OPENAI_MODEL_PROVIDER_ID);
  assert.equal(validation.spec.type, "model_provider");
  assert.deepEqual(
    validation.spec.models.map((model) => [model.id, model.modelName]),
    [
      [OPENAI_CHAT_MODEL_ID, "gpt-test"],
      [OPENAI_EMBEDDING_MODEL_ID, "text-embedding-test"],
    ]
  );
  assert.deepEqual(
    validation.spec.routes.map((route) => [route.id, route.capability]),
    [
      [MODEL_ROUTE_IDS.chatDefault, MODEL_CAPABILITIES.chat],
      [MODEL_ROUTE_IDS.embeddingDefault, MODEL_CAPABILITIES.embedding],
      [MODEL_ROUTE_IDS.intentPlannerDefault, MODEL_CAPABILITIES.intentPlanner],
      [
        MODEL_ROUTE_IDS.executionPlannerDefault,
        MODEL_CAPABILITIES.executionPlanner,
      ],
    ]
  );
  assert.doesNotThrow(() => JSON.stringify(validation.spec));
});

test("model provider registry resolves default routes without exposing mutable state", () => {
  const registry = createModelProviderRegistry({
    providers: [
      createOpenAIModelProviderSpec({
        chatModel: "gpt-test",
        embeddingModel: "text-embedding-test",
      }),
    ],
  });
  const selectedRoute = registry.resolveRoute({
    capability: MODEL_CAPABILITIES.intentPlanner,
  });

  assert.equal(selectedRoute.status, "selected");
  assert.equal(selectedRoute.selectedModel.id, OPENAI_CHAT_MODEL_ID);
  assert.equal(selectedRoute.selectedModel.modelName, "gpt-test");
  assert.equal(selectedRoute.selectedProvider.id, OPENAI_MODEL_PROVIDER_ID);

  selectedRoute.selectedModel.modelName = "mutated";

  assert.equal(
    registry.getModel(OPENAI_CHAT_MODEL_ID).modelName,
    "gpt-test"
  );
  assert.deepEqual(
    registry.listRoutes({ capability: MODEL_CAPABILITIES.embedding }).map(
      (route) => route.id
    ),
    [MODEL_ROUTE_IDS.embeddingDefault]
  );
  assert.deepEqual(
    createBuiltInModelProviders({
      openai: {
        chatModel: "built-in-chat",
      },
    }).map((provider) => provider.id),
    [OPENAI_MODEL_PROVIDER_ID]
  );
});

test("model route resolution applies workspace policy to primary and fallback models", () => {
  const registry = createModelProviderRegistry({
    providers: [createFallbackProviderSpec()],
  });
  const fallbackRoute = registry.resolveRoute({
    routeId: "chat.with_fallback",
    workspacePolicy: {
      blockedModelIds: [OPENAI_CHAT_MODEL_ID],
    },
  });

  assert.equal(fallbackRoute.status, "selected");
  assert.equal(fallbackRoute.selectedModel.id, "openai.chat_fallback");
  assert.deepEqual(fallbackRoute.rejectedModelIds, [OPENAI_CHAT_MODEL_ID]);

  const blockedRoute = registry.resolveRoute({
    routeId: "chat.with_fallback",
    workspacePolicy: {
      allowedModelIds: ["not-registered"],
    },
  });

  assert.equal(blockedRoute.status, "blocked_by_workspace_policy");
  assert.equal(blockedRoute.selectedModel, null);
  assert.deepEqual(blockedRoute.rejectedModelIds, [
    OPENAI_CHAT_MODEL_ID,
    "openai.chat_fallback",
  ]);
});

test("runtime model route exposes model name internally but only public ids externally", () => {
  const registry = createModelProviderRegistry({
    providers: [createFallbackProviderSpec()],
  });
  const route = resolveModelRouteForRuntime({
    registry,
    routeId: "chat.with_fallback",
    workspacePolicy: {
      blockedModelIds: [OPENAI_CHAT_MODEL_ID],
    },
  });

  assert.equal(route.modelName, "fallback-chat");
  assert.deepEqual(route.resolvedRoute.selectedModel.latency, {
    tier: "remote",
    timeoutMs: 4500,
  });
  assert.deepEqual(route.resolvedRoute.selectedModel.pricing, {
    currency: "USD",
    inputPerMillionTokens: 0.25,
    outputPerMillionTokens: 1.5,
  });
  assert.equal(route.publicRoute.status, "selected");
  assert.equal(route.publicRoute.routeId, "chat.with_fallback");
  assert.equal(route.publicRoute.modelId, "openai.chat_fallback");
  assert.equal(route.publicRoute.providerId, OPENAI_MODEL_PROVIDER_ID);
  assert.deepEqual(route.publicRoute.rejectedModelIds, [OPENAI_CHAT_MODEL_ID]);
  assert.equal(route.publicRoute.modelName, undefined);
  assert.equal(route.publicRoute.pricing, undefined);
  assert.equal(route.publicRoute.latency, undefined);
  assert.equal(route.publicRoute.transport, undefined);
  assert.equal(route.publicRoute.secretRef, undefined);
});

test("model provider validation rejects malformed routes and duplicate registry ids", () => {
  const invalidProvider = createOpenAIModelProviderSpec();

  invalidProvider.models[0].capabilities = ["unknown_capability"];
  invalidProvider.routes[0].primaryModelId = OPENAI_EMBEDDING_MODEL_ID;

  const validation = validateModelProviderSpec(invalidProvider);

  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => /unsupported capability/.test(error)),
    validation.errors.join("\n")
  );

  assert.throws(
    () =>
      createModelProviderRegistry({
        providers: [
          createOpenAIModelProviderSpec(),
          createOpenAIModelProviderSpec(),
        ],
      }),
    /Duplicate model provider id/
  );

  assert.throws(
    () =>
      createModelProviderRegistry({
        providers: [
          {
            ...createOpenAIModelProviderSpec(),
            routes: [
              {
                capability: MODEL_CAPABILITIES.rerank,
                id: "bad.rerank",
                primaryModelId: OPENAI_CHAT_MODEL_ID,
              },
            ],
          },
        ],
      }),
    /requires rerank/
  );
});
