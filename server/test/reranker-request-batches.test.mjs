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

const listen = async (t, handler) => {
  const server = http.createServer(handler);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return `http://127.0.0.1:${server.address().port}/rerank`;
};

// `answerAfter`: answer nothing until that many requests are waiting, then
// answer the last of them first.
// `delayMs`: serve one request at a time, each taking that long, as the bundled
// endpoint does behind its inference lock.
const startService = async (t, { answerAfter = 0, delayMs = 0, failRequest = 0 } = {}) => {
  const sent = [];
  const waiting = [];
  let queue = Promise.resolve();
  const endpoint = await listen(t, (req, res) => {
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

      const answer = () => res.end(JSON.stringify(ranks));

      if (answerAfter) {
        waiting.push({ answer, first: Number(texts[0].split(" ")[1]) });

        if (waiting.length >= answerAfter) {
          waiting
            .splice(0)
            .sort((left, right) => right.first - left.first)
            .forEach((held, index) => setTimeout(held.answer, index * 15));
        }

        return;
      }

      queue = queue.then(() => new Promise((resolve) => setTimeout(resolve, delayMs))).then(answer);
    });
  });

  return { endpoint, sent };
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

    // They go out at once, so they may arrive in any order.
    const batches = [...sent].sort((left, right) => texts.indexOf(left[0]) - texts.indexOf(right[0]));

    assert.deepEqual(batches.map((batch) => batch.length), sizes);
    assert.deepEqual(batches.flat(), texts);
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

  assert.deepEqual(sent.map((batch) => batch.length).sort(), [32, 7].sort());
  assert.deepEqual(scores, texts.map(scoreOf));
});

test("a rerank's requests wait in the service's queue together, as one request did", { timeout: 15_000 }, async (t) => {
  // Sent one after another, each would queue again behind every other rerank
  // and overlapping reranks would time out together: this service answers
  // only once all eight are waiting, the last first, so the scores must come
  // back by position and not by arrival.
  const { endpoint, sent } = await startService(t, { answerAfter: 8 });

  withEnv(t, { RAG_CROSS_ENCODER_TIMEOUT_MS: "2000" });

  const texts = passages(240);

  assert.deepEqual(await requestCrossEncoderScores({ endpoint, queryText: "q", texts }), texts.map(scoreOf));
  assert.equal(sent.length, 8);
});

test("a failed request closes the rerank's other requests", { timeout: 10_000 }, async (t) => {
  // Two requests are held and the third refused, as TEI refuses when it has
  // no permit left. Left open, the held two would keep theirs until the timeout.
  const closed = [];
  const endpoint = await listen(t, (req, res) => {
    req.resume();
    req.on("end", () => {
      if (closed.length < 2) {
        closed.push(new Promise((resolve) => res.on("close", resolve)));
        return;
      }

      res.writeHead(429).end();
    });
  });

  withEnv(t, { RAG_CROSS_ENCODER_TIMEOUT_MS: "30000" });

  await assert.rejects(requestCrossEncoderScores({ endpoint, queryText: "q", texts: passages(90) }), { status: 429 });
  await Promise.all(closed);
});

test("a timeout while the answer's body is arriving is a timeout too", { timeout: 10_000 }, async (t) => {
  const endpoint = await listen(t, (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"scores": [');
    });
  });

  withEnv(t, { RAG_CROSS_ENCODER_TIMEOUT_MS: "300" });

  await assert.rejects(requestCrossEncoderScores({ endpoint, queryText: "q", texts: passages(1) }), {
    code: "ETIMEDOUT",
  });
});

test("one timeout covers all of a rerank's requests", { timeout: 15_000 }, async (t) => {
  // Four requests served in turn at 200 ms: each inside 500 ms, together over it.
  const { endpoint } = await startService(t, { delayMs: 200 });

  withEnv(t, { RAG_CROSS_ENCODER_TIMEOUT_MS: "500" });

  await assert.rejects(requestCrossEncoderScores({ endpoint, queryText: "q", texts: passages(128) }), {
    code: "ETIMEDOUT",
  });
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

  // Two requests each time: the failed call left nothing in the score cache.
  assert.deepEqual(sent.map((batch) => batch.length).sort(), [32, 8, 32, 8].sort());
  assert.ok(recovered.every((result) => typeof result.crossEncoderScore === "number"));
});
