import test, { afterEach, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { embedQueryCached, resetEmbeddingCache } from "../rag/embedding-cache.js";

const FAKE_VECTOR = [0.1, 0.2, 0.3];
const FAKE_VECTOR_B = [0.4, 0.5, 0.6];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createCallTracker = (resultFn) => {
  const calls = [];
  const provider = {
    embedQuery: async (query) => {
      calls.push(query);
      return resultFn ? resultFn(query) : FAKE_VECTOR;
    },
    embedTexts: async (texts) => texts.map(() => FAKE_VECTOR),
    completeText: async () => "answer",
  };
  return { calls, provider };
};

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
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

beforeEach(() => {
  resetEmbeddingCache();
});

afterEach(() => {
  resetEmbeddingCache();
  resetOpenAIProvider();
});

test("cache hit returns identical vector without a second provider call", async () => {
  const { calls, provider } = createCallTracker();
  configureOpenAIProvider(provider);

  const first = await embedQueryCached("hello world");
  const second = await embedQueryCached("hello world");

  assert.deepEqual(first, FAKE_VECTOR);
  assert.deepEqual(second, FAKE_VECTOR);
  assert.equal(calls.length, 1);
});

test("TTL expiry triggers re-embed", async () => {
  const { calls, provider } = createCallTracker();
  configureOpenAIProvider(provider);

  await withEnv({ RAG_EMBEDDING_CACHE_TTL_MS: "50" }, async () => {
    const first = await embedQueryCached("ttl test");
    assert.deepEqual(first, FAKE_VECTOR);
    assert.equal(calls.length, 1);

    await sleep(80);

    const second = await embedQueryCached("ttl test");
    assert.deepEqual(second, FAKE_VECTOR);
    assert.equal(calls.length, 2);
  });
});

test("LRU eviction at max size", async () => {
  const { calls, provider } = createCallTracker((query) => [query.length]);
  configureOpenAIProvider(provider);

  await withEnv({ RAG_EMBEDDING_CACHE_MAX: "2" }, async () => {
    await embedQueryCached("query-a");
    await embedQueryCached("query-b");
    assert.equal(calls.length, 2);

    await embedQueryCached("query-c");
    assert.equal(calls.length, 3, "query-c is a miss");

    calls.length = 0;
    await embedQueryCached("query-a");
    assert.equal(calls.length, 1, "query-a should have been evicted as oldest");

    calls.length = 0;
    await embedQueryCached("query-c");
    assert.equal(calls.length, 0, "query-c should still be cached");
  });
});

test("in-flight dedupe: two concurrent calls result in one provider call", async () => {
  let resolveEmbedding;
  const calls = [];
  const provider = {
    embedQuery: async (query) => {
      calls.push(query);
      return new Promise((resolve) => {
        resolveEmbedding = resolve;
      });
    },
    embedTexts: async (texts) => texts.map(() => FAKE_VECTOR),
    completeText: async () => "answer",
  };
  configureOpenAIProvider(provider);

  const promise1 = embedQueryCached("dedup test");
  const promise2 = embedQueryCached("dedup test");

  resolveEmbedding(FAKE_VECTOR);

  const [result1, result2] = await Promise.all([promise1, promise2]);

  assert.deepEqual(result1, FAKE_VECTOR);
  assert.deepEqual(result2, FAKE_VECTOR);
  assert.equal(calls.length, 1);
});

test("rejection is not cached - subsequent call retries", async () => {
  let callCount = 0;
  const provider = {
    embedQuery: async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("transient failure");
      }
      return FAKE_VECTOR;
    },
    embedTexts: async (texts) => texts.map(() => FAKE_VECTOR),
    completeText: async () => "answer",
  };
  configureOpenAIProvider(provider);

  await assert.rejects(embedQueryCached("fail test"), /transient failure/);
  assert.equal(callCount, 1);

  const result = await embedQueryCached("fail test");
  assert.deepEqual(result, FAKE_VECTOR);
  assert.equal(callCount, 2);
});

test("different model key misses cache", async () => {
  const { calls, provider } = createCallTracker();
  configureOpenAIProvider(provider);

  await withEnv({ OPENAI_EMBEDDING_MODEL: "model-alpha" }, async () => {
    await embedQueryCached("model key test");
  });
  assert.equal(calls.length, 1);

  await withEnv({ OPENAI_EMBEDDING_MODEL: "model-beta" }, async () => {
    await embedQueryCached("model key test");
  });
  assert.equal(calls.length, 2);
});

test("cache can be disabled via env var", async () => {
  const { calls, provider } = createCallTracker();
  configureOpenAIProvider(provider);

  await withEnv({ RAG_EMBEDDING_CACHE_ENABLED: "false" }, async () => {
    await embedQueryCached("disabled test");
    await embedQueryCached("disabled test");
    assert.equal(calls.length, 2, "cache disabled should call provider each time");
  });
});

test("resetEmbeddingCache clears all entries", async () => {
  const { calls, provider } = createCallTracker();
  configureOpenAIProvider(provider);

  await embedQueryCached("reset test");
  assert.equal(calls.length, 1);

  resetEmbeddingCache();

  await embedQueryCached("reset test");
  assert.equal(calls.length, 2, "after reset, should call provider again");
});

test("LRU hit refreshes entry position and prevents eviction", async () => {
  const { calls, provider } = createCallTracker((query) => [query.length]);
  configureOpenAIProvider(provider);

  await withEnv({ RAG_EMBEDDING_CACHE_MAX: "2" }, async () => {
    await embedQueryCached("query-a");
    await embedQueryCached("query-b");

    await embedQueryCached("query-a");

    await embedQueryCached("query-c");

    calls.length = 0;
    await embedQueryCached("query-a");
    assert.equal(calls.length, 0, "query-a was recently hit and should not be evicted");

    calls.length = 0;
    await embedQueryCached("query-b");
    assert.equal(calls.length, 1, "query-b should have been evicted as LRU");
  });
});
