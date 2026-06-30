import test from "node:test";
import assert from "node:assert/strict";

import {
  LLMOPS_METRIC_EVENT_TYPE,
  LLMOPS_METRIC_VERSION,
  LLMOPS_OPERATIONS,
  LLMOPS_TRACE_TYPE,
  normalizeLlmOpsMetricEvent,
  recordLlmOpsMetric,
  runWithLlmOpsMetric,
} from "../rag/llmops-metrics.js";

test("LLMOps metric contract normalizes public fields only", () => {
  const event = normalizeLlmOpsMetricEvent({
    inputCharacters: 123.9,
    inputTokens: 12.9,
    latencyMs: 12.34567,
    latencySloMs: 10.9,
    modelRoute: {
      candidateModelIds: ["openai.chat"],
      capability: "chat",
      fallbackModelIds: [],
      modelId: "openai.chat",
      modelName: "gpt-private-name",
      providerId: "openai",
      rejectedModelIds: ["blocked-model"],
      routeId: "chat.default",
      secretRef: "OPENAI_API_KEY",
      status: "selected",
      transport: {
        type: "openai",
      },
    },
    operation: LLMOPS_OPERATIONS.completion,
    outputCharacters: 42,
    outputTokens: 4,
    pricing: {
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 5,
    },
    pricingSource: "model_contract",
    prompt: "do not serialize prompt text",
    stage: "complete_text",
    status: "ok",
    timestamp: "2026-06-29T00:00:00.000Z",
    totalTokens: 17,
    tokenSource: "actual",
    estimatedCostUsd: 0.000012345,
  });

  assert.equal(event.traceType, LLMOPS_TRACE_TYPE);
  assert.equal(event.eventType, LLMOPS_METRIC_EVENT_TYPE);
  assert.equal(event.version, LLMOPS_METRIC_VERSION);
  assert.equal(event.latencyMs, 12.346);
  assert.equal(event.latencySloMs, 10);
  assert.equal(event.latencySloStatus, "breach");
  assert.equal(event.inputCharacters, 123);
  assert.equal(event.outputCharacters, 42);
  assert.equal(event.inputTokens, 12);
  assert.equal(event.outputTokens, 4);
  assert.equal(event.totalTokens, 17);
  assert.equal(event.tokenSource, "actual");
  assert.equal(event.estimatedCostUsd, 0.00001234);
  assert.equal(event.pricingSource, "model_contract");
  assert.equal(event.costCurrency, null);
  assert.equal(event.pricing, undefined);
  assert.equal(event.prompt, undefined);
  assert.equal(event.modelRoute.modelName, undefined);
  assert.equal(event.modelRoute.secretRef, undefined);
  assert.equal(event.modelRoute.transport, undefined);
  assert.deepEqual(event.modelRoute, {
    candidateModelIds: ["openai.chat"],
    capability: "chat",
    fallbackModelIds: [],
    modelId: "openai.chat",
    providerId: "openai",
    rejectedModelIds: ["blocked-model"],
    routeId: "chat.default",
    status: "selected",
  });
});

test("recordLlmOpsMetric writes normalized events through the injected recorder", async () => {
  const recordedEvents = [];
  const event = await recordLlmOpsMetric(
    {
      itemCount: 2,
      operation: LLMOPS_OPERATIONS.embedding,
      stage: "embed_documents",
      status: "ok",
    },
    {
      now: () => "2026-06-29T01:00:00.000Z",
      recorder: async (recordedEvent) => {
        recordedEvents.push(recordedEvent);
      },
    }
  );

  assert.equal(recordedEvents.length, 1);
  assert.equal(recordedEvents[0], event);
  assert.equal(event.timestamp, "2026-06-29T01:00:00.000Z");
  assert.equal(event.operation, LLMOPS_OPERATIONS.embedding);
  assert.equal(event.itemCount, 2);
});

test("runWithLlmOpsMetric records success and error outcomes", async () => {
  const recordedEvents = [];
  const recorder = async (event) => {
    recordedEvents.push(event);
  };
  const result = await runWithLlmOpsMetric({
    action: async () => "answer",
    metric: {
      inputCharacters: 10,
      operation: LLMOPS_OPERATIONS.completion,
      stage: "complete_text",
    },
    now: () => "2026-06-29T02:00:00.000Z",
    recorder,
    successMetric: (text) => ({
      outputCharacters: text.length,
    }),
  });

  assert.equal(result, "answer");
  assert.equal(recordedEvents[0].status, "ok");
  assert.equal(recordedEvents[0].outputCharacters, 6);
  assert.ok(recordedEvents[0].latencyMs >= 0);

  await assert.rejects(
    runWithLlmOpsMetric({
      action: async () => {
        throw new TypeError("provider failed");
      },
      metric: {
        operation: LLMOPS_OPERATIONS.rerank,
        stage: "cross_encoder_score",
      },
      now: () => "2026-06-29T03:00:00.000Z",
      recorder,
    }),
    /provider failed/
  );

  assert.equal(recordedEvents[1].status, "error");
  assert.equal(recordedEvents[1].errorName, "TypeError");
  assert.equal(recordedEvents[1].errorMessage, "provider failed");
});
