import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  configureRerankMetricsCollector,
  rerankResultsWithProvider,
  resetCrossEncoderProvider,
  resetCustomRerankProvider,
  resetRerankMetricsCollector,
} from "../rag/reranker.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

const withEnv = async (overrides, callback) => {
  const originalValues = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, originalValue] of originalValues) {
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
};

const makeRerankResults = () => [
  {
    document: {
      id: "semantic",
      pageContent: "Semantic similarity chunk",
      metadata: { fileName: "sem.pdf" },
    },
    score: 0.9,
  },
  {
    document: {
      id: "keyword",
      pageContent: "Keyword overlap chunk",
      metadata: { fileName: "kw.pdf" },
    },
    score: 0.8,
  },
];

afterEach(() => {
  resetCrossEncoderProvider();
  resetCustomRerankProvider();
  resetRerankMetricsCollector();
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

test("http cross-encoder fetch passes AbortSignal to fetch", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
      RAG_CROSS_ENCODER_TIMEOUT_MS: "15000",
    },
    async () => {
      const capturedOptions = [];

      globalThis.fetch = async (_url, options) => {
        capturedOptions.push(options);

        return {
          ok: true,
          status: 200,
          json: async () => [0.9, 0.1],
        };
      };

      await rerankResultsWithProvider({
        queryText: "semantic search",
        results: makeRerankResults(),
        topK: 1,
      });

      assert.equal(capturedOptions.length, 1);
      assert.ok(capturedOptions[0].signal, "signal must be passed to fetch");
      assert.ok(
        capturedOptions[0].signal instanceof AbortSignal,
        "signal must be an AbortSignal"
      );
    }
  );
});

test("http cross-encoder wraps TimeoutError with descriptive message", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
      RAG_CROSS_ENCODER_TIMEOUT_MS: "5000",
    },
    async () => {
      globalThis.fetch = async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      };

      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "semantic search",
          results: makeRerankResults(),
          topK: 1,
        }),
        (error) => {
          assert.match(error.message, /Cross-encoder request timed out after 5000ms/);
          return true;
        }
      );
    }
  );
});

test("http cross-encoder wraps AbortError with descriptive message", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
      RAG_CROSS_ENCODER_TIMEOUT_MS: "12000",
    },
    async () => {
      globalThis.fetch = async () => {
        const err = new DOMException("signal is aborted", "AbortError");
        throw err;
      };

      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "semantic search",
          results: makeRerankResults(),
          topK: 1,
        }),
        (error) => {
          assert.match(error.message, /Cross-encoder request timed out after 12000ms/);
          return true;
        }
      );
    }
  );
});

test("http cross-encoder timeout error is recorded by metrics collector", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
      RAG_CROSS_ENCODER_TIMEOUT_MS: "3000",
    },
    async () => {
      const metrics = [];
      configureRerankMetricsCollector((metric) => {
        metrics.push(metric);
      });

      globalThis.fetch = async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      };

      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "semantic search",
          results: makeRerankResults(),
          topK: 1,
        }),
        (error) => {
          assert.match(error.message, /timed out/);
          return true;
        }
      );

      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].status, "error");
      assert.match(metrics[0].errorMessage, /timed out/);
    }
  );
});

test("http cross-encoder uses default 30000ms timeout when env var is not set", async () => {
  await withEnv(
    {
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_PROVIDER: "cross-encoder",
      RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
      RAG_CROSS_ENCODER_TIMEOUT_MS: undefined,
    },
    async () => {
      globalThis.fetch = async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      };

      await assert.rejects(
        rerankResultsWithProvider({
          queryText: "semantic search",
          results: makeRerankResults(),
          topK: 1,
        }),
        (error) => {
          assert.match(error.message, /Cross-encoder request timed out after 30000ms/);
          return true;
        }
      );
    }
  );
});
