import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEstimatedLlmOpsTokenUsage,
  buildLlmOpsRouteContext,
  buildLlmOpsUsageMetric,
  estimateLlmOpsCost,
  estimateTokenCountFromCharacters,
  extractLlmOpsTokenUsageFromResponse,
  normalizeLlmOpsPricing,
  normalizeLlmOpsTokenUsage,
} from "../rag/llmops-usage.js";

test("LLMOps usage extracts actual token metadata from common provider response shapes", () => {
  assert.deepEqual(
    extractLlmOpsTokenUsageFromResponse({
      usage_metadata: {
        input_tokens: 28,
        output_tokens: 5,
        total_tokens: 33,
      },
    }),
    {
      inputTokens: 28,
      outputTokens: 5,
      tokenSource: "actual",
      totalTokens: 33,
    }
  );

  assert.deepEqual(
    extractLlmOpsTokenUsageFromResponse({
      response_metadata: {
        tokenUsage: {
          completionTokens: 4,
          promptTokens: 10,
          totalTokens: 14,
        },
      },
    }),
    {
      inputTokens: 10,
      outputTokens: 4,
      tokenSource: "actual",
      totalTokens: 14,
    }
  );

  assert.deepEqual(
    extractLlmOpsTokenUsageFromResponse({
      llmOutput: {
        estimatedTokenUsage: {
          completionTokens: 3,
          promptTokens: 9,
        },
      },
    }),
    {
      inputTokens: 9,
      outputTokens: 3,
      tokenSource: "estimated",
      totalTokens: 12,
    }
  );

  assert.equal(extractLlmOpsTokenUsageFromResponse({ content: "answer" }), null);
});

test("LLMOps usage estimates tokens from character counts when provider usage is absent", () => {
  assert.equal(estimateTokenCountFromCharacters(0), 0);
  assert.equal(estimateTokenCountFromCharacters(1), 1);
  assert.equal(estimateTokenCountFromCharacters(16), 4);
  assert.equal(estimateTokenCountFromCharacters(17), 5);

  assert.deepEqual(
    buildEstimatedLlmOpsTokenUsage({
      inputCharacters: 16,
      outputCharacters: 8,
    }),
    {
      inputTokens: 4,
      outputTokens: 2,
      tokenSource: "estimated",
      totalTokens: 6,
    }
  );
});

test("LLMOps usage estimates USD cost from normalized model-contract pricing", () => {
  assert.deepEqual(
    normalizeLlmOpsPricing({
      currency: "usd",
      inputPerMillionTokens: "1.25",
      outputPerMillionTokens: 5,
    }),
    {
      currency: "USD",
      inputPerMillionTokens: 1.25,
      outputPerMillionTokens: 5,
    }
  );

  assert.deepEqual(
    estimateLlmOpsCost({
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 3,
      },
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        tokenSource: "estimated",
        totalTokens: 6,
      },
    }),
    {
      costCurrency: "USD",
      estimatedCostUsd: 0.00001,
      pricingSource: "model_contract",
    }
  );

  assert.deepEqual(
    estimateLlmOpsCost({
      pricing: {
        currency: "USD",
        inputPerMillionTokens: null,
        outputPerMillionTokens: 3,
      },
      usage: {
        inputTokens: 4,
        outputTokens: 2,
      },
    }),
    {
      costCurrency: "USD",
      estimatedCostUsd: null,
      pricingSource: "unavailable",
    }
  );
});

test("LLMOps usage metric prefers actual provider usage and keeps cost estimation centralized", () => {
  assert.deepEqual(
    buildLlmOpsUsageMetric({
      inputCharacters: 1000,
      outputCharacters: 1000,
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
      },
      response: {
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
        },
      },
    }),
    {
      costCurrency: "USD",
      estimatedCostUsd: 0.00002,
      inputTokens: 10,
      outputTokens: 5,
      pricingSource: "model_contract",
      tokenSource: "actual",
      totalTokens: 15,
    }
  );

  assert.deepEqual(
    normalizeLlmOpsTokenUsage({
      inputTokens: "bad",
      outputTokens: 2.9,
      tokenSource: "unknown",
    }),
    {
      inputTokens: null,
      outputTokens: 2,
      tokenSource: "unavailable",
      totalTokens: 2,
    }
  );
});

test("LLMOps route context derives report-only SLO and pricing inputs from selected model", () => {
  assert.deepEqual(
    buildLlmOpsRouteContext({
      selectedModel: {
        latency: {
          timeoutMs: 4500.8,
        },
        pricing: {
          currency: "usd",
          inputPerMillionTokens: 0.25,
          outputPerMillionTokens: 1.5,
        },
      },
    }),
    {
      latencySloMs: 4500,
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 0.25,
        outputPerMillionTokens: 1.5,
      },
    }
  );

  assert.deepEqual(buildLlmOpsRouteContext(), {
    latencySloMs: null,
    pricing: {
      currency: "USD",
      inputPerMillionTokens: null,
      outputPerMillionTokens: null,
    },
  });
});
