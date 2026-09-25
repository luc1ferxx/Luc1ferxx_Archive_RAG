import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  RESILIENCE_SCENARIOS,
  runResilienceScenario,
  startFaultInjectingServer,
} from "../evaluation/run-llm-resilience-eval.mjs";
import { createChatClient, parseRetryAfterMs } from "../rag/openai-client.js";
import { completeTextWithMetadata, computeRetryDelayMs } from "../rag/openai.js";

const withEnv = (t, values) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const scenario = (id) => RESILIENCE_SCENARIOS.find((candidate) => candidate.id === id);

const headers = (entries) => new Headers(entries);

test("Retry-After is read from retry-after-ms, then seconds, then an HTTP date", () => {
  const now = Date.parse("2026-09-25T00:00:00Z");

  // A missing retry-after-ms must not read as 0 ("retry now") and mask the
  // seconds header; that bug made a coarse Retry-After: 1 look like no wait.

  assert.equal(parseRetryAfterMs(headers({ "retry-after-ms": "340", "retry-after": "5" }), now), 340);
  assert.equal(parseRetryAfterMs(headers({ "retry-after": "2" }), now), 2000);
  assert.equal(parseRetryAfterMs(headers({ "retry-after": "Fri, 25 Sep 2026 00:00:03 GMT" }), now), 3000);
  assert.equal(parseRetryAfterMs(headers({}), now), null);
  assert.equal(parseRetryAfterMs(headers({ "retry-after": "soon" }), now), null);
});

test("backoff keeps half of each window and never shortens a Retry-After", () => {
  const low = () => 0;
  const high = () => 0.999;

  assert.equal(computeRetryDelayMs({ attempt: 0, random: low }), 250);
  assert.ok(computeRetryDelayMs({ attempt: 0, random: high }) < 500);
  assert.equal(computeRetryDelayMs({ attempt: 10, random: low }), 2000);
  // The server's wait is a floor, spread over up to half its length again.
  assert.equal(computeRetryDelayMs({ attempt: 0, random: low, retryAfterMs: 1000 }), 1000);
  assert.ok(computeRetryDelayMs({ attempt: 0, random: high, retryAfterMs: 1000 }) < 1500);
});

test("a request that never answers times out as a retriable error", async (t) => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  withEnv(t, {
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    RAG_LLM_REQUEST_TIMEOUT_MS: "50",
  });

  await assert.rejects(
    createChatClient({ apiKey: "test", model: "m" }).invoke("hi"),
    (error) => error.code === "ETIMEDOUT" && /timed out after 50 ms/.test(error.message)
  );
});

const withFaultServer = async (t, { fallback = "resilience-fallback" } = {}) => {
  const server = await startFaultInjectingServer();
  t.after(() => server.close());
  withEnv(t, {
    OPENAI_API_KEY: "test",
    OPENAI_BASE_URL: server.baseUrl,
    OPENAI_CHAT_FALLBACK_MODEL: fallback,
    OPENAI_CHAT_MODEL: "resilience-primary",
    RAG_LLM_REQUEST_TIMEOUT_MS: "2000",
  });
  return server;
};

test("a down primary model fails over and the route names the model that answered", async (t) => {
  const server = await withFaultServer(t);
  server.setScenario(scenario("primary_model_down"), 1);

  const completion = await completeTextWithMetadata("ping");

  assert.equal(completion.text, "pong");
  assert.equal(completion.modelRoute.modelId, "openai.chat.fallback");
  assert.equal(completion.modelRoute.status, "failover");
  // Four tries on the primary (one plus three retries), then the fallback.
  assert.deepEqual(server.stats().byModel, { "resilience-fallback": 1, "resilience-primary": 4 });
});

test("without a fallback model a down primary still fails after its retries", async (t) => {
  const server = await withFaultServer(t, { fallback: "" });
  server.setScenario(scenario("primary_model_down"), 1);

  await assert.rejects(completeTextWithMetadata("ping"), /Chat completion failed\. The model resilience-primary is overloaded/);
  assert.deepEqual(server.stats().byModel, { "resilience-primary": 4 });
});

test("a client error never fails over: it would fail the same way on any model", async (t) => {
  const bodies = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(JSON.parse(body).model);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid schema." } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  withEnv(t, {
    OPENAI_API_KEY: "test",
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    OPENAI_CHAT_FALLBACK_MODEL: "resilience-fallback",
    OPENAI_CHAT_MODEL: "resilience-primary",
  });

  await assert.rejects(completeTextWithMetadata("ping"), /Invalid schema/);
  assert.deepEqual(bodies, ["resilience-primary"]);
});

test("an empty completion is retried once, then returned as empty text as before", async (t) => {
  const server = await withFaultServer(t, { fallback: "" });
  server.setScenario({ faults: { emptyRate: 1 } }, 1);

  const completion = await completeTextWithMetadata("ping");

  assert.equal(completion.text, "");
  assert.equal(server.stats().requests, 2);
});

test("the resilience eval measures a scenario end to end", async (t) => {
  const server = await withFaultServer(t);

  const result = await runResilienceScenario({
    calls: 4,
    complete: (prompt) => completeTextWithMetadata(prompt),
    concurrency: 2,
    scenario: scenario("flaky_5xx"),
    server,
    sloMs: 10000,
  });

  assert.equal(result.id, "flaky_5xx");
  assert.equal(result.calls, 4);
  assert.equal(result.successRate, 1);
  assert.ok(result.requestsPerCall >= 1);
  assert.ok(Number.isFinite(result.latencyMs.p95));
});
