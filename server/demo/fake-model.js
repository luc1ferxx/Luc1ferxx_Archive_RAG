import http from "node:http";

import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";

// The deterministic OpenAI-compatible model of the tenant-isolation demo
// (`npm run demo:fake-model`, the demo-model service of compose.demo.yml, and
// test/tenant-isolation-hardened.e2e.test.mjs). It is the load bench's fake
// model: POST /v1/embeddings answers hashed term vectors of a fixed width
// (shared words give related texts a positive cosine), and POST
// /v1/chat/completions answers the evidence sentence that shares the most words
// with the question, cited as [Source k]. No key is checked and nothing leaves
// the process; it says nothing about answer quality, only that the tenant
// boundaries hold around a working retrieval and answer path.

export const DEMO_FAKE_MODEL_DEFAULT_PORT = 5199;
export const DEMO_FAKE_MODEL_DIMENSIONS = 64;

const readBody = async (req) => {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Starts the fake model on host:port (port 0 picks a free one) and resolves
 * to { server, url, requests, setChatDelayMs } once it listens; `url` is the
 * base the server's OPENAI_BASE_URL takes (ending in /v1), `requests` counts
 * calls per endpoint, and a chat delay (chatDelayMs, or setChatDelayMs later)
 * holds every chat completion that long, so concurrent requests overlap (the
 * per-tenant concurrency cap, TENANT_MAX_CONCURRENT_RUNS).
 */
export const startDemoFakeModel = async ({
  chatDelayMs = 0,
  dimensions = DEMO_FAKE_MODEL_DIMENSIONS,
  host = "127.0.0.1",
  port = DEMO_FAKE_MODEL_DEFAULT_PORT,
} = {}) => {
  const requests = { chat: 0, embeddings: 0 };
  let delayMs = Math.max(0, Number(chatDelayMs) || 0);
  const server = http.createServer(async (req, res) => {
    let payload = {};

    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The body must be JSON." } }));
      return;
    }

    if (String(req.url).endsWith("/embeddings")) {
      res.writeHead(200, { "content-type": "application/json" });
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

      requests.embeddings += 1;
      res.end(
        JSON.stringify({
          data: inputs.map((input, index) => ({
            embedding: hashEmbedding(input, dimensions),
            index,
            object: "embedding",
          })),
          model: payload.model,
          object: "list",
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
      );
      return;
    }

    requests.chat += 1;

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // POST /chat/stream asks for an OpenAI-style stream (the answer drafts of
    // rag/answer-drafts.js): the same answer, a few words per chunk, then the
    // usage chunk and [DONE].
    if (payload.stream === true) {
      const words = buildFakeChatAnswer(payload).match(/\S+\s*/gu) ?? [];
      const chunk = (fields) =>
        `data: ${JSON.stringify({ choices: [], model: payload.model, object: "chat.completion.chunk", ...fields })}\n\n`;

      res.writeHead(200, { "content-type": "text/event-stream" });

      for (let index = 0; index < words.length; index += 4) {
        res.write(
          chunk({ choices: [{ delta: { content: words.slice(index, index + 4).join("") }, finish_reason: null, index: 0 }] })
        );
      }

      res.write(chunk({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] }));
      res.write(chunk({ usage: { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 } }));
      res.end("data: [DONE]\n\n");
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", index: 0, message: { content: buildFakeChatAnswer(payload), role: "assistant" } },
        ],
        model: payload.model,
        object: "chat.completion",
        usage: { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 },
      })
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    requests,
    server,
    setChatDelayMs: (ms) => {
      delayMs = Math.max(0, Number(ms) || 0);
    },
    url: `http://${urlHost}:${address.port}/v1`,
  };
};
