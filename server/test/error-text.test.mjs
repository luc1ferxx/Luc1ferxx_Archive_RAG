import assert from "node:assert/strict";
import test from "node:test";

import { serializeError } from "../lib/error-text.js";

const captureLog = (t) => {
  const logged = [];

  t.mock.method(console, "error", (...args) => logged.push(args));

  return logged;
};

// The model backend's own answer (rag/openai-client.js): its text names the
// endpoint and echoes the key.
const createUpstreamError = () =>
  Object.assign(new Error("Incorrect API key sk-live-0123 for https://llm.internal.example/v1"), {
    status: 401,
    upstreamStatus: 401,
  });

test("an error raised for the client keeps its message: a 4xx, or expose", (t) => {
  const logged = captureLog(t);

  assert.equal(serializeError(Object.assign(new Error("Document not found."), { status: 404 }), "x"), "Document not found.");
  assert.equal(
    serializeError(Object.assign(new Error("Document RAG budget exhausted (1/1)."), { expose: true }), "x"),
    "Document RAG budget exhausted (1/1)."
  );
  assert.deepEqual(logged, []);
});

test("anything else is the fallback, and each error is logged once", (t) => {
  const logged = captureLog(t);
  const upstream = createUpstreamError();
  const databaseError = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });
  const serverError = Object.assign(new Error("boom"), { status: 500 });
  const exposedUpstream = Object.assign(createUpstreamError(), { expose: true });

  for (const error of [upstream, upstream, databaseError, serverError, exposedUpstream, "not an error"]) {
    assert.equal(serializeError(error, "fallback"), "fallback");
  }

  assert.deepEqual(logged, [
    ["fallback", upstream],
    ["fallback", databaseError],
    ["fallback", serverError],
    ["fallback", exposedUpstream],
    ["fallback", "not an error"],
  ]);
});
