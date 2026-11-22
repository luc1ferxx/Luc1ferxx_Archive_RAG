import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createChatClient,
  createEmbeddingsClient,
} from "../rag/openai-client.js";

// This client is what makes DocCompare work against any OpenAI-compatible endpoint,
// not just api.openai.com. It is hand-rolled rather than the vendor SDK, so nothing
// external guarantees it keeps honouring OPENAI_BASE_URL or stays tolerant of the
// ways a compatible-but-not-identical provider differs. Hence these tests.

const ENVIRONMENT_KEYS = ["OPENAI_BASE_URL", "OPENAI_API_BASE"];

let originalFetch = null;
let originalEnvironment = null;
let requests = [];

const stubFetch = (handler) => {
  globalThis.fetch = async (url, options) => {
    requests.push({
      url: String(url),
      method: options?.method,
      headers: options?.headers ?? {},
      body: options?.body ? JSON.parse(options.body) : null,
    });
    return handler(requests.length - 1);
  };
};

const jsonResponse = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => JSON.stringify(payload),
});

const textResponse = (body, { status = 500 } = {}) => ({
  ok: false,
  status,
  text: async () => body,
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnvironment = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])
  );
  for (const key of ENVIRONMENT_KEYS) {
    delete process.env[key];
  }
  requests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("requests go to api.openai.com when no base url is configured", async () => {
  stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }));

  await createEmbeddingsClient({ apiKey: "k", model: "m" }).embedQuery("hello");

  assert.equal(requests[0].url, "https://api.openai.com/v1/embeddings");
});

test("OPENAI_BASE_URL redirects requests and tolerates a trailing slash", async () => {
  // A trailing slash is the single most likely way a user hand-copies this value,
  // and without stripping it every URL would contain a double slash -- which some
  // gateways route and others 404, making the failure look like a bad API key.
  process.env.OPENAI_BASE_URL = "https://gateway.internal/openai/v1///";
  stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));

  await createEmbeddingsClient({ apiKey: "k", model: "m" }).embedQuery("hello");

  assert.equal(requests[0].url, "https://gateway.internal/openai/v1/embeddings");
});

test("OPENAI_API_BASE is honoured, and OPENAI_BASE_URL wins when both are set", async () => {
  process.env.OPENAI_API_BASE = "https://only-legacy/v1";
  stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
  await createEmbeddingsClient({ apiKey: "k", model: "m" }).embedQuery("a");
  assert.equal(requests[0].url, "https://only-legacy/v1/embeddings");

  process.env.OPENAI_BASE_URL = "https://preferred/v1";
  await createEmbeddingsClient({ apiKey: "k", model: "m" }).embedQuery("b");
  assert.equal(requests[1].url, "https://preferred/v1/embeddings");
});

test("the base url applies to chat completions as well as embeddings", async () => {
  // Two separate call sites read the base url; a fix applied to only one of them
  // would split traffic between the gateway and OpenAI, which is both a
  // correctness and a data-egress problem.
  process.env.OPENAI_BASE_URL = "https://gateway.internal/v1";
  stubFetch(() => jsonResponse({ choices: [{ message: { content: "hi" } }] }));

  await createChatClient({ apiKey: "k", model: "m" }).invoke("hello");

  assert.equal(requests[0].url, "https://gateway.internal/v1/chat/completions");
});

test("embedDocuments batches long inputs and preserves input order", async () => {
  // Batching is invisible until an archive is large enough to cross the boundary,
  // and a provider is under no obligation to return data in request order -- the
  // client sorts by index for exactly that reason. If either broke, every vector
  // would be attached to the wrong chunk and retrieval would be quietly wrong
  // rather than broken, which is the hardest kind of bug to notice.
  const texts = Array.from({ length: 513 }, (_, index) => `chunk-${index}`);

  stubFetch((callIndex) => {
    const batch = requests[callIndex].body.input;
    const data = batch.map((text, offset) => ({
      index: offset,
      embedding: [Number(text.split("-")[1])],
    }));
    // Returned deliberately out of order.
    return jsonResponse({ data: data.slice().reverse() });
  });

  const vectors = await createEmbeddingsClient({
    apiKey: "k",
    model: "m",
  }).embedDocuments(texts);

  assert.equal(requests.length, 2, "513 inputs should split into two batches");
  assert.equal(requests[0].body.input.length, 512);
  assert.equal(requests[1].body.input.length, 1);
  assert.equal(vectors.length, 513);
  // Value equals the original index, so this catches any reordering.
  assert.deepEqual(vectors[0], [0]);
  assert.deepEqual(vectors[511], [511]);
  assert.deepEqual(vectors[512], [512]);
});

test("credentials and model are sent on every request", async () => {
  stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));

  await createEmbeddingsClient({
    apiKey: "secret-key",
    model: "text-embedding-3-large",
  }).embedQuery("hello");

  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.Authorization, "Bearer secret-key");
  assert.equal(requests[0].headers["Content-Type"], "application/json");
  assert.equal(requests[0].body.model, "text-embedding-3-large");
});

test("chat prompts are normalized from every shape the callers use", async () => {
  stubFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
  const client = createChatClient({ apiKey: "k", model: "m" });

  await client.invoke("plain string");
  assert.deepEqual(requests[0].body.messages, [
    { role: "user", content: "plain string" },
  ]);

  await client.invoke({
    messages: [
      { role: "system", content: "be brief" },
      { role: "human", content: "question" },
    ],
  });
  // "human" is LangChain's name for the user role and must not reach the API.
  assert.deepEqual(requests[1].body.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "question" },
  ]);

  await client.invoke([{ role: "human", content: "from array" }]);
  assert.deepEqual(requests[2].body.messages, [
    { role: "user", content: "from array" },
  ]);
});

test("a missing chat response yields empty content instead of throwing", async () => {
  // Compatible-but-not-identical providers are the reason this matters: an
  // unexpected response shape should surface as an empty answer the caller can
  // handle, not a TypeError from deep inside the client.
  stubFetch(() => jsonResponse({ choices: [] }));

  const result = await createChatClient({ apiKey: "k", model: "m" }).invoke("q");

  assert.equal(result.content, "");
  assert.equal(result.usage, null);
});

test("provider errors surface the provider's message and HTTP status", async () => {
  stubFetch(() =>
    jsonResponse(
      { error: { message: "model not found: gpt-5" } },
      { ok: false, status: 404 }
    )
  );

  await assert.rejects(
    createChatClient({ apiKey: "k", model: "gpt-5" }).invoke("q"),
    (error) => {
      // The provider's own wording is what tells a user their endpoint does not
      // serve the model they configured; replacing it with a generic message
      // would make an OpenAI-compatible endpoint much harder to debug.
      assert.equal(error.message, "model not found: gpt-5");
      assert.equal(error.status, 404);
      return true;
    }
  );
});

test("a non-JSON error body is passed through rather than swallowed", async () => {
  // Gateways and proxies fail with HTML or plain text. Losing that body would
  // leave the user with nothing but a status code.
  stubFetch(() => textResponse("<html>502 Bad Gateway</html>", { status: 502 }));

  await assert.rejects(
    createEmbeddingsClient({ apiKey: "k", model: "m" }).embedQuery("q"),
    (error) => {
      assert.match(error.message, /502 Bad Gateway/);
      assert.equal(error.status, 502);
      return true;
    }
  );
});

test("the request timeout survives garbage collection beside a caller's signal", { timeout: 30_000 }, async () => {
  // Before Node 22.16 (package.json allows 22.13) AbortSignal.any holds even a
  // timeout source weakly. A child process stands in such an AbortSignal.any
  // and collects garbage while the model hangs.
  const child = `
    const client = await import(${JSON.stringify(new URL("../rag/openai-client.js", import.meta.url).href)});
    AbortSignal.any = (signals) => {
      const combined = new AbortController();
      const sources = signals.map((signal) => new WeakRef(signal));
      const poll = setInterval(() => {
        const aborted = sources.map((source) => source.deref()).find((signal) => signal?.aborted);
        if (aborted) {
          clearInterval(poll);
          combined.abort(aborted.reason);
        }
      }, 10);
      return combined.signal;
    };
    globalThis.fetch = (url, { signal }) =>
      new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    setInterval(gc, 10);
    const caller = new AbortController();
    const options = { signal: caller.signal };
    const chat = client.createChatClient({ apiKey: "test", model: "chat" });
    const embeddings = client.createEmbeddingsClient({ apiKey: "test", model: "embedding" });
    const outcomes = [];
    for (const call of [
      () => chat.invoke("hi", options),
      () => chat.invokeStream("hi", options),
      () => embeddings.embedQuery("hi", options),
    ]) {
      outcomes.push(await Promise.race([
        call().catch((error) => error.code),
        new Promise((resolve) => setTimeout(() => resolve("never timed out"), 3000)),
      ]));
    }
    process.stdout.write(outcomes.join(","), () => process.exit(0));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", "--input-type=module", "--eval", child],
    {
      env: {
        OPENAI_BASE_URL: "http://model.invalid/v1",
        PATH: process.env.PATH,
        RAG_LLM_REQUEST_TIMEOUT_MS: "300",
      },
    }
  );

  assert.equal(stdout, "ETIMEDOUT,ETIMEDOUT,ETIMEDOUT");
});
