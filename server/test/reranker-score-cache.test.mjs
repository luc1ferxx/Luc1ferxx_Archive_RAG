import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CROSS_ENCODER_SCORE_CACHE_MAX_ENTRIES,
  configureCrossEncoderProvider,
  rerankResultsWithProvider,
  resetCrossEncoderProvider,
} from "../rag/reranker.js";

// The cross-encoder score cache (rag/reranker.js): a passage is scored once
// per (transport, model, score scale, query) in this process, only misses are
// sent, and a cached run orders exactly like an uncached one.

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
