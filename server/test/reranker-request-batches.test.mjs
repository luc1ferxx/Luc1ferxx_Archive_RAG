import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  requestCrossEncoderScores,
  rerankResultsOrKeepOrder,
  resetCrossEncoderProvider,
  scoreTextsWithCrossEncoderBackend,
} from "../rag/reranker.js";

// A rerank longer than Hugging Face TEI's default --max-client-batch-size (32)
// goes out in several requests (requestCrossEncoderScores). The stand-in
// service refuses a longer request and answers as TEI does: a bare array
// sorted by score, each entry indexed within its own request.

const TEI_MAX_CLIENT_BATCH = 32;
const scoreOf = (text) => (Number(text.split(" ")[1]) * 7) % 241;
const passages = (count) => Array.from({ length: count }, (_, index) => `passage ${index}`);

const startService = async (t, { delayMs = 0, failRequest = 0 } = {}) => {
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { texts } = JSON.parse(body);

      sent.push(texts);

      if (texts.length > TEI_MAX_CLIENT_BATCH || sent.length === failRequest) {
        res.writeHead(texts.length > TEI_MAX_CLIENT_BATCH ? 422 : 500).end();
        return;
      }

      const ranks = texts
        .map((text, index) => ({ index, score: scoreOf(text) }))
        .sort((left, right) => right.score - left.score);

      setTimeout(() => res.end(JSON.stringify(ranks)), delayMs);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return { endpoint: `http://127.0.0.1:${server.address().port}/rerank`, sent };
};

const withEnv = (t, values) => {
  const previous = Object.keys(values).map((key) => [key, process.env[key]]);

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

for (const [count, sizes] of [
  [32, [32]],
  [33, [32, 1]],
  [90, [32, 32, 26]],
  [240, [32, 32, 32, 32, 32, 32, 32, 16]],
]) {
  test(`${count} texts go out as ${sizes.join("+")}, and each score returns to its own text`, async (t) => {
    const { endpoint, sent } = await startService(t);
    const texts = passages(count);
    const scores = await requestCrossEncoderScores({ endpoint, queryText: "q", texts });

    assert.deepEqual(sent.map((batch) => batch.length), sizes);
    assert.deepEqual(sent.flat(), texts);
    assert.deepEqual(scores, texts.map(scoreOf));
  });
}

test("the model gateway's backend call is split the same way", async (t) => {
  const { endpoint, sent } = await startService(t);
  const texts = passages(39);
  const { scores } = await scoreTextsWithCrossEncoderBackend({
    dispatch: ({ request }) => request(endpoint),
    queryText: "q",
    texts,
  });

  assert.deepEqual(sent.map((batch) => batch.length), [32, 7]);
  assert.deepEqual(scores, texts.map(scoreOf));
});

test("one timeout covers all of a rerank's requests", { timeout: 15_000 }, async (t) => {
  // Four requests of 200 ms: each well inside 500 ms, together over it.
  const { endpoint, sent } = await startService(t, { delayMs: 200 });

  withEnv(t, { RAG_CROSS_ENCODER_TIMEOUT_MS: "500" });

  await assert.rejects(requestCrossEncoderScores({ endpoint, queryText: "q", texts: passages(128) }), {
    code: "ETIMEDOUT",
  });
  assert.ok(sent.length < 4, "the last request never went out");
});

test("a failed later request keeps the whole fused order and caches none of the call's scores", async (t) => {
  const { endpoint, sent } = await startService(t, { failRequest: 2 });

  withEnv(t, {
    MODEL_GATEWAY_URL: undefined,
    RAG_CROSS_ENCODER_ENDPOINT: endpoint,
    RAG_RERANK_ENABLED: "true",
    RAG_RERANK_PROVIDER: "cross-encoder",
  });
  t.mock.method(console, "warn", () => {});
  resetCrossEncoderProvider();
  t.after(resetCrossEncoderProvider);

  const results = passages(40).map((pageContent, index) => ({
    document: { id: `chunk-${index}`, pageContent, metadata: {} },
    score: 1 - index / 100,
  }));
  const rerank = () => rerankResultsOrKeepOrder({ queryText: "q", results, topK: 20 });

  assert.deepEqual(await rerank(), results.slice(0, 20));

  const recovered = await rerank();

  assert.deepEqual(sent.map((batch) => batch.length), [32, 8, 32, 8]);
  assert.ok(recovered.every((result) => typeof result.crossEncoderScore === "number"));
});
