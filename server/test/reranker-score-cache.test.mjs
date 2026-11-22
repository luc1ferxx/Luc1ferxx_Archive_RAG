import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CROSS_ENCODER_SCORE_CACHE_MAX_ENTRIES,
  CROSS_ENCODER_SCORE_CACHE_TTL_MS,
  configureCrossEncoderProvider,
  rerankResultsWithProvider,
  resetCrossEncoderProvider,
} from "../rag/reranker.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";

// The cross-encoder score cache (rag/reranker.js): a passage is scored once
// per (tenant, transport, model, score scale, query) in this process, only
// misses are sent, and a cached run orders exactly like an uncached one.

const originalFetch = globalThis.fetch;

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

const CROSS_ENCODER_ENV = {
  MODEL_GATEWAY_URL: undefined,
  RAG_CROSS_ENCODER_ENDPOINT: "https://rerank.example.test/score",
  RAG_CROSS_ENCODER_MODEL: "mini-cross-encoder",
  RAG_CROSS_ENCODER_SCORES: undefined,
  RAG_RERANK_ENABLED: "true",
  RAG_RERANK_PROVIDER: "cross-encoder",
  RAG_RERANK_WEIGHT: "0.6",
};

const candidate = (id, score) => ({
  document: {
    id,
    pageContent: `Passage ${id} about the quartz capsule approval.`,
    metadata: { fileName: "capsule.pdf" },
  },
  score,
});
const CANDIDATES = {
  a: candidate("a", 0.9),
  b: candidate("b", 0.7),
  c: candidate("c", 0.5),
  d: candidate("d", 0.3),
};
// A deterministic logit per passage, whatever else is in the request.
const LOGITS = { a: -1, b: 2.5, c: 0.5, d: 4 };
const logitOf = (text) => LOGITS[/Passage (\w+)/.exec(text)[1]];

// A stand-in HTTP cross-encoder that records every request it answers.
const stubHttpCrossEncoder = () => {
  const requests = [];

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);

    requests.push({ ...body, url });
    return { json: async () => ({ scores: body.texts.map(logitOf) }), ok: true, status: 200 };
  };

  return requests;
};

const rerank = (queryText, ids) =>
  rerankResultsWithProvider({ queryText, results: ids.map((id) => CANDIDATES[id]), topK: ids.length });
const sentIds = (request) => request.texts.map((text) => /Passage (\w+)/.exec(text)[1]);

afterEach(() => {
  resetCrossEncoderProvider();
  globalThis.fetch = originalFetch;
});

test("an overlapping second rerank sends only the new candidates and orders exactly as an uncached run", async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    const requests = stubHttpCrossEncoder();

    await rerank("quartz capsule approval", ["a", "b", "c"]);
    const cached = await rerank("quartz capsule approval", ["b", "c", "d"]);

    assert.deepEqual(requests.map(sentIds), [["a", "b", "c"], ["d"]]);
    assert.equal(requests[1].query, "quartz capsule approval");
    assert.equal(requests[1].model, "mini-cross-encoder");

    resetCrossEncoderProvider();
    const uncached = await rerank("quartz capsule approval", ["b", "c", "d"]);

    assert.deepEqual(sentIds(requests[2]), ["b", "c", "d"]);
    assert.deepEqual(cached, uncached);
    assert.deepEqual(
      cached.map((result) => [result.document.id, result.crossEncoderScore]),
      [["d", 4], ["b", 2.5], ["c", 0.5]]
    );
  });
});

test("a rerank whose candidates are all cached sends no request", async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    const requests = stubHttpCrossEncoder();
    const first = await rerank("quartz capsule approval", ["a", "b"]);
    const second = await rerank("quartz capsule approval", ["a", "b"]);

    assert.equal(requests.length, 1);
    assert.deepEqual(second, first);
    assert.ok(second.every((result) => typeof result.crossEncoderScore === "number"));
  });
});

test("a cached score lives ten minutes, then the passage is scored again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });

  await withEnv(CROSS_ENCODER_ENV, async () => {
    const requests = stubHttpCrossEncoder();

    await rerank("quartz capsule approval", ["a", "b"]);
    t.mock.timers.tick(CROSS_ENCODER_SCORE_CACHE_TTL_MS - 1);
    await rerank("quartz capsule approval", ["a", "b"]);
    t.mock.timers.tick(1);
    await rerank("quartz capsule approval", ["a", "b"]);
    await rerank("quartz capsule approval", ["a", "b"]);

    assert.deepEqual(requests.map(sentIds), [["a", "b"], ["a", "b"]]);
  });
});

test("the query text, model, endpoint and score scale each key their own scores", async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    const requests = stubHttpCrossEncoder();
    const scoreAgain = async (overrides = {}, queryText = "quartz capsule approval") =>
      withEnv(overrides, () => rerank(queryText, ["a", "b"]));

    await scoreAgain();
    await scoreAgain();
    assert.equal(requests.length, 1);

    await scoreAgain({}, "who approves the quartz capsule?");
    await scoreAgain({ RAG_CROSS_ENCODER_MODEL: "other-cross-encoder" });
    await scoreAgain({ RAG_CROSS_ENCODER_ENDPOINT: "https://rerank-2.example.test/score" });
    await scoreAgain({ RAG_CROSS_ENCODER_SCORES: "probabilities" });

    assert.deepEqual(
      requests.map((request) => [request.url, request.model, request.query, sentIds(request).join("")]),
      [
        ["https://rerank.example.test/score", "mini-cross-encoder", "quartz capsule approval", "ab"],
        ["https://rerank.example.test/score", "mini-cross-encoder", "who approves the quartz capsule?", "ab"],
        ["https://rerank.example.test/score", "other-cross-encoder", "quartz capsule approval", "ab"],
        ["https://rerank-2.example.test/score", "mini-cross-encoder", "quartz capsule approval", "ab"],
        ["https://rerank.example.test/score", "mini-cross-encoder", "quartz capsule approval", "ab"],
      ]
    );

    // Every variant above is cached under its own key.
    await scoreAgain({ RAG_CROSS_ENCODER_SCORES: "probabilities" });
    await scoreAgain({ RAG_CROSS_ENCODER_MODEL: "other-cross-encoder" });
    assert.equal(requests.length, 5);
  });
});

test("each tenant has its own scores: what one tenant cached is a miss for another", async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    const requests = stubHttpCrossEncoder();
    const asTenant = (scope) => runWithDatabaseTenant(scope, () => rerank("quartz capsule approval", ["a", "b"]));

    await asTenant({ userId: "alice", workspaceId: "ws-a" });
    await asTenant({ userId: "alice", workspaceId: "ws-a" });
    assert.equal(requests.length, 1);

    // The same question over the same passage text, from another tenant, the
    // same user in another workspace, and a call bound to no tenant.
    await asTenant({ userId: "bob", workspaceId: "ws-b" });
    await asTenant({ userId: "alice", workspaceId: "ws-b" });
    await rerank("quartz capsule approval", ["a", "b"]);
    assert.equal(requests.length, 4);
  });
});

test("the key is the exact text sent: the same chunk id with new text, or another file name, is scored again", async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    const requests = stubHttpCrossEncoder();
    const { a, d } = CANDIDATES;
    const scoreOne = async (result) =>
      (await rerankResultsWithProvider({ queryText: "quartz capsule approval", results: [result], topK: 1 }))[0]
        .crossEncoderScore;

    assert.equal(await scoreOne(a), LOGITS.a);
    // A replaced document keeps its chunk ids.
    assert.equal(await scoreOne({ ...a, document: { ...a.document, pageContent: d.document.pageContent } }), LOGITS.d);
    assert.equal(await scoreOne({ ...a, document: { ...a.document, metadata: { fileName: "renamed.pdf" } } }), LOGITS.a);

    assert.deepEqual(
      requests.map((request) => request.texts),
      [
        ["capsule.pdf\nPassage a about the quartz capsule approval."],
        ["capsule.pdf\nPassage d about the quartz capsule approval."],
        ["renamed.pdf\nPassage a about the quartz capsule approval."],
      ]
    );
  });
});

test("configuring or resetting the cross-encoder provider empties the cache", async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    const calls = [];
    const provider = {
      score: async ({ pairs, queryText }) => {
        calls.push({ ids: pairs.map((pair) => pair.id), queryText });
        return pairs.map((pair) => LOGITS[pair.id]);
      },
    };

    configureCrossEncoderProvider(provider);
    await rerank("quartz capsule approval", ["a", "b"]);
    await rerank("quartz capsule approval", ["a", "b"]);
    configureCrossEncoderProvider(provider);
    await rerank("quartz capsule approval", ["a", "b"]);

    assert.deepEqual(calls, [
      { ids: ["a", "b"], queryText: "quartz capsule approval" },
      { ids: ["a", "b"], queryText: "quartz capsule approval" },
    ]);

    resetCrossEncoderProvider();
    const requests = stubHttpCrossEncoder();

    await rerank("quartz capsule approval", ["a", "b"]);
    await rerank("quartz capsule approval", ["a", "b"]);
    resetCrossEncoderProvider();
    await rerank("quartz capsule approval", ["a", "b"]);

    assert.equal(requests.length, 2);
  });
});

test("failed scores are never cached: an HTTP error, a thrown provider, a short answer", async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    let failNext = true;
    const requests = [];

    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);

      requests.push(body);

      if (failNext) {
        failNext = false;
        return { json: async () => ({}), ok: false, status: 503 };
      }

      return { json: async () => ({ scores: body.texts.map(logitOf) }), ok: true, status: 200 };
    };

    await assert.rejects(rerank("quartz capsule approval", ["a", "b"]), /HTTP 503/);
    await rerank("quartz capsule approval", ["a", "b"]);
    await rerank("quartz capsule approval", ["a", "b"]);
    assert.equal(requests.length, 2);

    const answers = [
      () => {
        throw new Error("provider down");
      },
      () => [1],
      () => [1, 2],
    ];
    let calls = 0;

    configureCrossEncoderProvider({ score: async () => answers[calls++]() });

    await assert.rejects(rerank("quartz capsule approval", ["a", "b"]), /provider down/);
    await assert.rejects(rerank("quartz capsule approval", ["a", "b"]), /returned 1 score\(s\) for 2 candidate\(s\)/);
    await rerank("quartz capsule approval", ["a", "b"]);
    await rerank("quartz capsule approval", ["a", "b"]);
    assert.equal(calls, 3);
  });
});

test(`the cache holds at most ${CROSS_ENCODER_SCORE_CACHE_MAX_ENTRIES} scores and evicts the oldest first`, async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    const sent = [];

    configureCrossEncoderProvider({
      score: async ({ pairs }) => {
        sent.push(pairs.map((pair) => pair.id));
        return pairs.map((_, index) => index);
      },
    });

    const many = Array.from({ length: CROSS_ENCODER_SCORE_CACHE_MAX_ENTRIES + 1 }, (_, index) => ({
      document: { id: `chunk-${index}`, pageContent: `chunk ${index}`, metadata: {} },
      score: 0,
    }));

    await rerankResultsWithProvider({ queryText: "q", results: many, topK: 1 });
    // The first chunk went out when the last one came in; the last is still held.
    await rerankResultsWithProvider({ queryText: "q", results: [many.at(-1)], topK: 1 });
    await rerankResultsWithProvider({ queryText: "q", results: [many[1]], topK: 1 });
    await rerankResultsWithProvider({ queryText: "q", results: [many[0]], topK: 1 });

    assert.equal(sent.length, 2);
    assert.equal(sent[0].length, CROSS_ENCODER_SCORE_CACHE_MAX_ENTRIES + 1);
    assert.deepEqual(sent[1], ["chunk-0"]);
  });
});

test("a call whose new scores evict its own cached ones still uses the cached scores", async () => {
  await withEnv(CROSS_ENCODER_ENV, async () => {
    const sent = [];

    configureCrossEncoderProvider({
      score: async ({ pairs }) => {
        sent.push(pairs.map((pair) => pair.id));
        // Every score of the nth request is n.
        return pairs.map(() => sent.length);
      },
    });

    const chunkNamed = (id) => ({ document: { id, pageContent: id, metadata: {} }, score: 0 });
    const full = Array.from({ length: CROSS_ENCODER_SCORE_CACHE_MAX_ENTRIES }, (_, index) => chunkNamed(`chunk-${index}`));
    const rerankAll = (results) => rerankResultsWithProvider({ queryText: "q", results, topK: results.length });

    await rerankAll(full);
    // chunk-0 and chunk-1 are the oldest entries: storing this call's two new
    // scores evicts them.
    const mixed = await rerankAll([full[0], full[1], chunkNamed("new-0"), chunkNamed("new-1")]);

    assert.deepEqual(sent[1], ["new-0", "new-1"]);
    assert.deepEqual(
      Object.fromEntries(mixed.map((result) => [result.document.id, result.crossEncoderScore])),
      { "chunk-0": 1, "chunk-1": 1, "new-0": 2, "new-1": 2 }
    );

    await rerankAll([full[0]]);
    assert.deepEqual(sent[2], ["chunk-0"]);
  });
});
