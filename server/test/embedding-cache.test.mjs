import test, { afterEach, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import {
  describeEmbeddingCache,
  describeEmbeddingFlights,
  embedQueryCached,
  getQueryVectorEmbeddingSpace,
  resetEmbeddingCache,
} from "../rag/embedding-cache.js";
import { buildEmbeddingSpace } from "../rag/vector-store-pgvector-versions.js";
import { getActiveDatabaseTenant, runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import {
  createRequestCancellation,
  getRequestDeadline,
  getRequestSignal,
  REQUEST_CANCELLATION_REASONS,
  RequestCancelledError,
  runWithRequestCancellation,
  runWithRequestDeadline,
} from "../rag/request-deadline.js";
import { createRunUsage, getActiveRunUsage, runWithRunUsage } from "../rag/run-usage.js";
import { resetModelCallGuards } from "../rag/model-call-guard.js";

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

test("one LRU for every embedding space: keyed by space and text, bounded by RAG_EMBEDDING_CACHE_MAX, vectors tagged with their space", async () => {
  const calls = [];
  configureOpenAIProvider({
    embedQuery: async (query, options) => {
      const model = options?.embeddingSpace?.model ?? "configured";
      calls.push(`${model}:${query}`);
      return Array.from({ length: options?.embeddingSpace?.dimensions ?? 3 }, () => query.length);
    },
    embedTexts: async (texts) => texts.map(() => FAKE_VECTOR),
    completeText: async () => "answer",
  });
  const pinned = buildEmbeddingSpace({ dimensions: 2, model: "pinned-model", queryPrefix: "q: " });

  await withEnv({ OPENAI_EMBEDDING_MODEL: "configured", RAG_EMBEDDING_CACHE_MAX: "2", RAG_EMBEDDING_DIMENSIONS: "3", VECTOR_STORE_PROVIDER: "local" }, async () => {
    const configuredVector = await embedQueryCached("same text");
    const pinnedVector = await embedQueryCached("same text", { space: pinned });

    assert.deepEqual(calls, ["configured:same text", "pinned-model:same text"], "the same text in two spaces is two entries");
    assert.equal(getQueryVectorEmbeddingSpace(configuredVector).model, "configured");
    assert.equal(getQueryVectorEmbeddingSpace(pinnedVector).model, "pinned-model");
    assert.equal(getQueryVectorEmbeddingSpace([1, 2, 3]), null, "a vector from elsewhere carries no space");
    assert.deepEqual(describeEmbeddingCache(), {
      bySpace: { "configured|3": 1, "pinned-model|2": 1 },
      entries: 2,
      maxEntries: 2,
    });

    // A third entry evicts the least recently used one, whatever its space.
    await embedQueryCached("other text", { space: pinned });
    await embedQueryCached("same text", { space: pinned });
    assert.equal(calls.length, 3, "the pinned entry was still cached");
    await embedQueryCached("same text");
    assert.equal(calls.at(-1), "configured:same text", "the configured entry was evicted");
  });
});

// --- A shared in-flight call serves every caller, and belongs to none -------
//
// Two requests that embed the same text at once share one model call. That
// call must not run under the deadline, signal or run meter of the request that
// happened to start it (only its tenant, for gateway attribution), each caller
// must be able to give up on
// its own, and the call must be charged once.

const ALICE = { userId: "alice", workspaceId: "acme" };
const BOB = { userId: "bob", workspaceId: "globex" };
const NO_CEILINGS = { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 };

// Yields to the event loop until `condition()` holds; a barrier, not a timer.
const waitUntil = async (condition, label) => {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail(`timed out waiting until ${label}`);
};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

// A stand-in embedder that holds every call until released and records the
// request context each call ran in.
const createHeldProvider = () => {
  const release = createDeferred();
  const seen = [];
  const provider = {
    completeText: async () => "answer",
    embedQuery: async (query) => {
      seen.push({
        deadline: getRequestDeadline(),
        query,
        runUsage: getActiveRunUsage(),
        signal: getRequestSignal(),
        tenant: getActiveDatabaseTenant(),
      });
      await release.promise;
      return [...FAKE_VECTOR];
    },
    embedTexts: async (texts) => texts.map(() => FAKE_VECTOR),
  };

  return { provider, release: () => release.resolve(), seen };
};

// One request's whole context: its cancellation (deadline and signal), its
// database tenant and its agent run's usage meter.
const asRequest = ({ cancellation, meter, scope }, work) =>
  runWithRequestCancellation(cancellation, () =>
    runWithDatabaseTenant(scope, () => runWithRunUsage(meter, work))
  );

test("a shared in-flight embedding runs detached from its callers: A cancels, B still gets the vector", async (t) => {
  const held = createHeldProvider();
  configureOpenAIProvider(held.provider);

  const a = { cancellation: createRequestCancellation({ deadlineAt: Date.now() + 60_000 }), meter: createRunUsage({ limits: NO_CEILINGS }), scope: ALICE };
  // Another request of the same tenant: flights are shared within a tenant.
  const b = { cancellation: createRequestCancellation({ deadlineAt: Date.now() + 60_000 }), meter: createRunUsage({ limits: NO_CEILINGS }), scope: ALICE };

  t.after(() => {
    a.cancellation.dispose();
    b.cancellation.dispose();
    held.release();
  });

  const fromA = asRequest(a, () => embedQueryCached("shared text"));
  const fromB = asRequest(b, () => embedQueryCached("shared text"));

  await waitUntil(() => held.seen.length === 1, "the shared call reached the model");
  assert.deepEqual(describeEmbeddingFlights(), [{ waiters: 2 }], "one call, two callers");

  a.cancellation.cancel();
  await assert.rejects(
    fromA,
    (error) => error instanceof RequestCancelledError && error.reason === REQUEST_CANCELLATION_REASONS.clientCancelled,
    "A rejects at once with its own cancellation"
  );
  assert.deepEqual(describeEmbeddingFlights(), [{ waiters: 1 }], "the call goes on for B");

  held.release();
  assert.deepEqual(await fromB, FAKE_VECTOR);

  // The call kept the starting caller's tenant (the model gateway signs it as
  // that tenant, so quotas and the usage ledger count it) but saw no request
  // deadline or signal and no caller's run meter.
  const [context] = held.seen;
  assert.equal(held.seen.length, 1, "one model call for both callers");
  assert.deepEqual(context.tenant, ALICE);
  assert.equal(context.deadline, null);
  assert.equal(context.signal, null);
  assert.notEqual(context.runUsage, a.meter);
  assert.notEqual(context.runUsage, b.meter);

  // B, the only caller still waiting when the call succeeded, pays for it;
  // A, who left, pays nothing.
  assert.equal(a.meter.used.modelCalls, 0);
  assert.equal(a.meter.used.tokens, 0);
  assert.equal(b.meter.used.modelCalls, 1);
  assert.ok(b.meter.used.tokens > 0, "B is charged the call's tokens");

  // The vector is cached for everyone, whichever tenant asks next.
  const c = { cancellation: createRequestCancellation(), meter: createRunUsage({ limits: NO_CEILINGS }), scope: BOB };
  assert.deepEqual(await asRequest(c, () => embedQueryCached("shared text")), FAKE_VECTOR);
  assert.equal(held.seen.length, 1);
  assert.equal(c.meter.used.modelCalls, 0, "a cache hit is charged nothing");
  assert.deepEqual(describeEmbeddingFlights(), []);
});

test("a shared call is charged once, to the earliest caller still waiting; every other caller is charged like a cache hit", async (t) => {
  const held = createHeldProvider();
  configureOpenAIProvider(held.provider);

  // Three requests of one tenant (flights are shared within a tenant).
  const callers = [ALICE, ALICE, ALICE].map((scope) => ({
    cancellation: createRequestCancellation(),
    meter: createRunUsage({ limits: NO_CEILINGS }),
    scope,
  }));

  t.after(() => held.release());

  // Exactly what one caller alone is charged for the same text.
  const alone = createRunUsage({ limits: NO_CEILINGS });
  const aloneHeld = createHeldProvider();
  configureOpenAIProvider(aloneHeld.provider);
  aloneHeld.release();
  await runWithRunUsage(alone, () => embedQueryCached("charged text"));
  resetEmbeddingCache();
  configureOpenAIProvider(held.provider);

  const waiting = callers.map((caller) => asRequest(caller, () => embedQueryCached("charged text")));

  await waitUntil(() => held.seen.length === 1, "the shared call reached the model");
  held.release();
  await Promise.all(waiting);

  assert.equal(held.seen.length, 1);
  assert.deepEqual(callers[0].meter.used, alone.used, "the first caller pays what it would have paid alone");
  assert.deepEqual(callers[1].meter.used, { costUsd: 0, modelCalls: 0, tokens: 0, unpricedModelCalls: 0 });
  assert.deepEqual(callers[2].meter.used, { costUsd: 0, modelCalls: 0, tokens: 0, unpricedModelCalls: 0 });
});

test("each caller waits under its own deadline: A's deadline passes, B without one still gets the vector", async (t) => {
  const held = createHeldProvider();
  configureOpenAIProvider(held.provider);

  t.after(() => held.release());

  const fromA = runWithRequestDeadline({ deadlineAt: Date.now() + 20 }, () =>
    runWithDatabaseTenant(ALICE, () => embedQueryCached("deadline text"))
  );
  // Another request of the same tenant, without a deadline.
  const fromB = runWithDatabaseTenant(ALICE, () => embedQueryCached("deadline text"));

  await assert.rejects(
    fromA,
    (error) => error instanceof RequestCancelledError && error.reason === REQUEST_CANCELLATION_REASONS.deadlineExceeded,
    "A fails with its own deadline"
  );
  assert.deepEqual(describeEmbeddingFlights(), [{ waiters: 1 }], "A's deadline did not cut the call");

  held.release();
  assert.deepEqual(await fromB, FAKE_VECTOR);
  assert.equal(held.seen.length, 1);
  assert.equal(held.seen[0].deadline, null, "the call never had A's deadline");
});

test("a caller already cancelled neither starts nor joins a call", async () => {
  const held = createHeldProvider();
  configureOpenAIProvider(held.provider);
  held.release();

  const cancellation = createRequestCancellation();

  cancellation.cancel();
  await assert.rejects(
    runWithRequestCancellation(cancellation, () => embedQueryCached("cancelled text")),
    (error) => error instanceof RequestCancelledError && error.reason === REQUEST_CANCELLATION_REASONS.clientCancelled
  );
  assert.equal(held.seen.length, 0, "no model call was started for it");
  assert.deepEqual(describeEmbeddingFlights(), []);
});

test("the shared call stops only when its last caller has gone (real client: the request is aborted then, not before)", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  let answerAtOnce = false;

  t.after(() => {
    globalThis.fetch = originalFetch;
    resetModelCallGuards();
  });
  // An OpenAI-compatible embeddings endpoint that answers only when told to,
  // and otherwise holds the request until its signal aborts, as fetch does.
  globalThis.fetch = (_url, options) => {
    const request = { aborted: false, reason: null };

    requests.push(request);

    if (answerAtOnce) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ embedding: [0.7, 0.8, 0.9], index: 0 }] }),
      });
    }

    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          request.aborted = true;
          request.reason = options.signal.reason;
          reject(options.signal.reason);
        },
        { once: true }
      );
    });
  };

  await withEnv(
    {
      MODEL_GATEWAY_URL: undefined,
      OPENAI_API_BASE: undefined,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "http://embeddings.test/v1",
      OPENAI_EMBEDDING_MODEL: "flight-embed",
      RAG_EMBEDDING_QUERY_PREFIX: undefined,
    },
    async () => {
      resetOpenAIProvider();
      resetModelCallGuards();

      const a = createRequestCancellation();
      const b = createRequestCancellation();
      const fromA = runWithRequestCancellation(a, () => embedQueryCached("abandoned text"));
      const fromB = runWithRequestCancellation(b, () => embedQueryCached("abandoned text"));

      await waitUntil(() => requests.length === 1, "the shared request was sent");

      a.cancel();
      await assert.rejects(fromA, RequestCancelledError);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests[0].aborted, false, "A leaving does not abort the call B waits for");

      b.cancel(REQUEST_CANCELLATION_REASONS.deadlineExceeded);
      await assert.rejects(fromB, (error) => error.reason === REQUEST_CANCELLATION_REASONS.deadlineExceeded);
      await waitUntil(() => requests[0].aborted, "the abandoned request was aborted");
      assert.ok(requests[0].reason instanceof RequestCancelledError, "aborted as a cancellation, never a failure");
      assert.deepEqual(describeEmbeddingFlights(), []);

      // The next caller starts a call of its own; the abandoned one cached nothing.
      answerAtOnce = true;
      assert.deepEqual(await embedQueryCached("abandoned text"), [0.7, 0.8, 0.9]);
      assert.equal(requests.length, 2, "one abandoned request and one fresh one, no retry");
    }
  );
});

test("concurrent embeddings of one text from two tenants are two flights, so one tenant's failure never reaches the other", async (t) => {
  const held = createHeldProvider();
  configureOpenAIProvider(held.provider);

  const a = { cancellation: createRequestCancellation(), meter: createRunUsage({ limits: NO_CEILINGS }), scope: ALICE };
  const b = { cancellation: createRequestCancellation(), meter: createRunUsage({ limits: NO_CEILINGS }), scope: BOB };

  t.after(() => {
    a.cancellation.dispose();
    b.cancellation.dispose();
    held.release();
  });

  const fromA = asRequest(a, () => embedQueryCached("tenant split text"));
  const fromB = asRequest(b, () => embedQueryCached("tenant split text"));

  await waitUntil(() => held.seen.length === 2, "both tenants' calls reached the model");
  assert.deepEqual(describeEmbeddingFlights(), [{ waiters: 1 }, { waiters: 1 }]);
  assert.deepEqual(
    held.seen.map((context) => context.tenant),
    [ALICE, BOB],
    "each flight runs as its own tenant (the model gateway's identity and quota)"
  );

  held.release();
  assert.deepEqual(await fromA, FAKE_VECTOR);
  assert.deepEqual(await fromB, FAKE_VECTOR);
  assert.equal(a.meter.used.modelCalls, 1);
  assert.equal(b.meter.used.modelCalls, 1);
  assert.deepEqual(describeEmbeddingFlights(), []);
});

// RAG_EMBEDDING_CACHE_SCOPE=tenant: a cache hit answers without a model call,
// so under the shared default a tenant can time its own query to learn that
// another tenant recently asked exactly that text. The tenant scope keys the
// cached vectors by the flight's tenant partition.
describe("RAG_EMBEDDING_CACHE_SCOPE", () => {
  const embedAs = (scope, text) => runWithDatabaseTenant(scope, () => embedQueryCached(text));

  test("shared (default and blank): tenant B's identical query hits the vector tenant A cached", async () => {
    for (const value of [undefined, "", "  ", "shared", " Shared "]) {
      resetEmbeddingCache();
      const { calls, provider } = createCallTracker();
      configureOpenAIProvider(provider);

      await withEnv({ RAG_EMBEDDING_CACHE_SCOPE: value }, async () => {
        await embedAs(ALICE, "Is Acme acquiring Beta?");
        await embedAs(BOB, "Is Acme acquiring Beta?");
        await embedAs(ALICE, "Is Acme acquiring Beta?");
      });

      assert.equal(calls.length, 1, `scope ${JSON.stringify(value)}: one model call for all three`);
      assert.equal(describeEmbeddingCache().entries, 1);
    }
  });

  test("tenant: B's identical query misses (calls the model) while A's repeat and B's own repeat hit", async () => {
    const { calls, provider } = createCallTracker();
    configureOpenAIProvider(provider);

    await withEnv({ RAG_EMBEDDING_CACHE_SCOPE: "tenant" }, async () => {
      assert.deepEqual(await embedAs(ALICE, "Is Acme acquiring Beta?"), FAKE_VECTOR);
      assert.equal(calls.length, 1);

      assert.deepEqual(await embedAs(BOB, "Is Acme acquiring Beta?"), FAKE_VECTOR);
      assert.equal(calls.length, 2, "another tenant's cached vector is not served to B");

      await embedAs(ALICE, "Is Acme acquiring Beta?");
      await embedAs(BOB, "Is Acme acquiring Beta?");
      assert.equal(calls.length, 2, "each tenant's repeat is a hit");

      // The same user in another workspace is another tenant; a non-tenant
      // context (here unbound: system work, auth off) is a partition of its own.
      await embedAs({ ...ALICE, workspaceId: "globex" }, "Is Acme acquiring Beta?");
      await embedQueryCached("Is Acme acquiring Beta?");
      assert.equal(calls.length, 4);
      await embedQueryCached("Is Acme acquiring Beta?");
      assert.equal(calls.length, 4);
    });

    // The space key still leads every entry (diagnostics).
    const { bySpace, entries } = describeEmbeddingCache();

    assert.equal(entries, 4);
    assert.deepEqual(Object.values(bySpace), [4]);
  });

  test("tenant: concurrent callers of one tenant still share one flight, and the space tag survives", async (t) => {
    const held = createHeldProvider();
    configureOpenAIProvider(held.provider);
    t.after(() => held.release());

    await withEnv({ RAG_EMBEDDING_CACHE_SCOPE: "tenant" }, async () => {
      const first = embedAs(ALICE, "shared flight text");
      const second = embedAs(ALICE, "shared flight text");

      await waitUntil(() => held.seen.length === 1, "one call for one tenant");
      assert.deepEqual(describeEmbeddingFlights(), [{ waiters: 2 }]);
      held.release();

      const [vectorA, vectorB] = await Promise.all([first, second]);

      assert.equal(vectorA, vectorB);
      assert.ok(getQueryVectorEmbeddingSpace(vectorA), "the cached vector keeps its space tag");
      assert.equal(await embedAs(ALICE, "shared flight text"), vectorA, "and is then a hit");
      assert.equal(held.seen.length, 1);
    });
  });

  test("an unknown value fails the cached embedding instead of falling back to the shared cache", async () => {
    const { calls, provider } = createCallTracker();
    configureOpenAIProvider(provider);

    await withEnv({ RAG_EMBEDDING_CACHE_SCOPE: "per-tenant" }, async () => {
      await assert.rejects(
        embedAs(ALICE, "anything"),
        (error) => error.code === "RAG_EMBEDDING_CACHE_SCOPE_INVALID"
      );
    });

    assert.equal(calls.length, 0);
  });
});
