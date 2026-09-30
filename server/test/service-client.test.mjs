import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import express from "express";

import { bindDatabaseTenant } from "../auth.js";
import { startTracing } from "../otel.js";
import { getActiveDatabaseTenant } from "../rag/postgres-tenant.js";
import {
  bindServiceTraceContext,
  createServiceClient,
  describeServiceClients,
  getServiceClient,
  resetServiceClients,
  SERVICE_CLIENT_ERROR_CODES,
  ServiceTimeoutError,
  ServiceUnavailableError,
} from "../rag/service-client.js";
import {
  getServiceDeadlineRemainingMs,
  requireServiceIdentity,
  SERVICE_DEADLINE_HEADER,
  SERVICE_REQUEST_ID_HEADER,
  SERVICE_TOKEN_HEADER,
  verifyServiceToken,
} from "../rag/service-identity.js";
import { withSpan } from "../rag/tracing.js";

const SECRET = "c".repeat(20) + "-client-secret-0123456789";
const ENV = { ARCHIVE_RAG_ROLE: "api", INTERNAL_SERVICE_KEYS: `k1:${SECRET}` };
const ALICE = { authenticated: true, userId: "alice", workspaceId: "ws-1" };

const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// A replica on an OS-assigned port that records each request's headers and
// body. `handler(req, res, hit)` answers; `waitForHits(n)` is a barrier.
const startReplica = async (name, handler = (req, res) => sendJson(res, 200, { replica: name })) => {
  const hits = [];
  const waiters = [];
  const openResponses = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    openResponses.add(res);
    res.on("close", () => openResponses.delete(res));
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const hit = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
        method: req.method,
        path: req.url,
      };
      hits.push(hit);
      waiters.filter((waiter) => hits.length >= waiter.count).forEach((waiter) => waiter.resolve());
      handler(req, res, hit);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    close: async () => {
      openResponses.forEach((res) => res.destroy());
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
    hits,
    name,
    url: `http://127.0.0.1:${server.address().port}`,
    waitForHits: (count) => {
      if (hits.length >= count) return Promise.resolve();
      const waiter = { count, ...deferred() };
      waiters.push(waiter);
      return waiter.promise;
    },
  };
};

// A URL nothing listens on: bound once to get a free port, then closed.
const closedUrl = async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  return `http://127.0.0.1:${port}`;
};

const makeClient = (urls, options = {}) =>
  createServiceClient({ audience: "agent", env: ENV, issuer: "api", urls, ...options });

const replicaOf = (result) => result.json?.replica;

test("the least busy replica is chosen and ties rotate", async (t) => {
  const gate = deferred();
  const a = await startReplica("a", async (req, res) => {
    if (req.url === "/hold") await gate.promise;
    sendJson(res, 200, { replica: "a" });
  });
  const b = await startReplica("b");
  t.after(() => Promise.all([a.close(), b.close()]));
  const client = makeClient([a.url, b.url]);

  const held = client.request({ accessScope: ALICE, path: "/hold" });
  await a.waitForHits(1);

  assert.deepEqual(
    client.snapshot().replicas.map((replica) => replica.outstanding),
    [1, 0]
  );

  for (let index = 0; index < 3; index += 1) {
    assert.equal(replicaOf(await client.request({ accessScope: ALICE, path: "/fast" })), "b");
  }

  gate.resolve();
  assert.equal(replicaOf(await held), "a");

  const order = [];
  for (let index = 0; index < 4; index += 1) {
    order.push(replicaOf(await client.request({ accessScope: ALICE, path: "/fast" })));
  }

  assert.deepEqual(order, ["a", "b", "a", "b"]);
  assert.deepEqual(
    client.snapshot().replicas.map(({ failures, healthy, outstanding, requests }) => ({
      failures,
      healthy,
      outstanding,
      requests,
    })),
    [
      { failures: 0, healthy: true, outstanding: 0, requests: 3 },
      { failures: 0, healthy: true, outstanding: 0, requests: 5 },
    ]
  );
});

test("idempotent calls fail over once per replica and mark the failed one unhealthy", async (t) => {
  const a = await startReplica("a", (req, res) => sendJson(res, 503, { error: "overloaded" }));
  const b = await startReplica("b");
  t.after(() => Promise.all([a.close(), b.close()]));
  const client = makeClient([a.url, b.url]);

  const result = await client.request({ accessScope: ALICE, path: "/agent-runs/run-1" });

  assert.equal(result.status, 200);
  assert.equal(replicaOf(result), "b");
  assert.equal(a.hits.length, 1);
  assert.equal(a.hits[0].headers[SERVICE_REQUEST_ID_HEADER], b.hits[0].headers[SERVICE_REQUEST_ID_HEADER]);
  assert.notEqual(a.hits[0].headers[SERVICE_TOKEN_HEADER], b.hits[0].headers[SERVICE_TOKEN_HEADER]);

  const [failed, healthy] = client.snapshot().replicas;

  assert.equal(failed.healthy, false);
  assert.equal(failed.lastFailureCode, "HTTP_503");
  assert.ok(failed.lastFailureAgeMs >= 0);
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.lastFailureAgeMs, null);

  // While a cools down, rotation does not send work back to it.
  assert.equal(replicaOf(await client.request({ accessScope: ALICE, path: "/x" })), "b");
  assert.equal(a.hits.length, 1);

  const closed = await closedUrl();
  const allDown = makeClient([a.url, closed]);

  await assert.rejects(allDown.request({ accessScope: ALICE, path: "/x" }), (error) => {
    assert.ok(error instanceof ServiceUnavailableError);
    assert.equal(error.attempts, 2);
    return true;
  });
  assert.equal(a.hits.length, 2);
});

test("a non-idempotent call is never repeated once bytes were sent", async (t) => {
  const a = await startReplica("a", (req, res) => sendJson(res, 503, { error: "overloaded" }));
  const reset = await startReplica("reset", (req) => req.socket.destroy());
  const b = await startReplica("b");
  t.after(() => Promise.all([a.close(), reset.close(), b.close()]));

  await assert.rejects(
    makeClient([a.url, b.url]).request({ accessScope: ALICE, body: { question: "q" }, method: "POST", path: "/chat" }),
    (error) => {
      assert.ok(error instanceof ServiceUnavailableError);
      assert.equal(error.status, 503);
      assert.equal(error.code, SERVICE_CLIENT_ERROR_CODES.unavailable);
      assert.equal(error.service, "agent");
      assert.equal(error.remoteStatus, 503);
      assert.deepEqual(error.remoteBody, { error: "overloaded" });
      assert.ok(!error.message.includes("127.0.0.1"));
      assert.deepEqual(error.toResponseBody(), {
        code: "SERVICE_UNAVAILABLE",
        error: "The agent service is unavailable.",
        service: "agent",
      });
      return true;
    }
  );
  assert.equal(b.hits.length, 0);

  await assert.rejects(
    makeClient([reset.url, b.url]).request({ accessScope: ALICE, body: {}, method: "POST", path: "/chat" }),
    (error) => {
      assert.equal(error.code, SERVICE_CLIENT_ERROR_CODES.unreachable);
      assert.ok(!error.message.includes("127.0.0.1"));
      assert.ok(error.causeCode);
      return true;
    }
  );
  assert.equal(b.hits.length, 0);

  // The same reset on an idempotent call moves on.
  assert.equal(replicaOf(await makeClient([reset.url, b.url]).request({ accessScope: ALICE, path: "/x" })), "b");

  // A refused connection sent nothing, so even a POST moves on.
  const refusedThenB = makeClient([await closedUrl(), b.url]);
  const posted = await refusedThenB.request({ accessScope: ALICE, body: { question: "q" }, method: "POST", path: "/chat" });

  assert.equal(replicaOf(posted), "b");
  assert.equal(refusedThenB.snapshot().replicas[0].lastFailureCode, "ECONNREFUSED");
  // An explicit idempotent flag lets a POST fail over after a 503.
  assert.equal(
    replicaOf(await makeClient([a.url, b.url]).request({ accessScope: ALICE, body: {}, idempotent: true, method: "POST", path: "/search" })),
    "b"
  );
});

test("the budget times out locally, is sent as a deadline, and the caller can abort", async (t) => {
  const slow = await startReplica("slow", () => {});
  t.after(() => slow.close());
  const client = makeClient([slow.url]);

  await assert.rejects(client.request({ accessScope: ALICE, path: "/slow", timeoutMs: 150 }), (error) => {
    assert.ok(error instanceof ServiceTimeoutError);
    assert.ok(error instanceof ServiceUnavailableError);
    assert.equal(error.code, SERVICE_CLIENT_ERROR_CODES.timeout);
    assert.equal(error.status, 504);
    return true;
  });

  const deadline = Number(slow.hits[0].headers[SERVICE_DEADLINE_HEADER]);

  assert.ok(deadline > 0 && deadline <= 150, `deadline ${deadline}`);
  assert.deepEqual(
    client.snapshot().replicas.map(({ healthy, outstanding }) => ({ healthy, outstanding })),
    [{ healthy: true, outstanding: 0 }]
  );

  const controller = new AbortController();
  const reason = new Error("caller gave up");
  const pending = client.request({ accessScope: ALICE, path: "/slow", signal: controller.signal });

  await slow.waitForHits(2);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(client.snapshot().replicas[0].outstanding, 0);
  assert.equal(client.snapshot().replicas[0].healthy, true);
});

test("answers pass through and the client alone sets internal headers", async (t) => {
  const replica = await startReplica("r", (req, res) =>
    req.url === "/missing" ? sendJson(res, 404, { error: "Run not found." }) : sendJson(res, 200, { ok: true })
  );
  t.after(() => replica.close());
  const client = makeClient([replica.url], { timeoutMs: 30_000 });

  const missing = await client.request({ accessScope: ALICE, path: "/missing" });

  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: "Run not found." });
  assert.equal(missing.headers["content-type"], "application/json");

  await client.request({
    accessScope: { ...ALICE, token: "public-token" },
    body: { question: "q" },
    claims: { runId: "run-1" },
    headers: {
      Connection: "close",
      "X-Archive-Service-Deadline-Ms": "1",
      "X-Archive-Service-Request-Id": "forged",
      "x-archive-service-token": "forged",
      "x-request-id": "public-1",
    },
    method: "POST",
    path: "/chat",
    requestId: "req-1",
  });

  const { body, headers, method } = replica.hits[1];
  const identity = verifyServiceToken(headers[SERVICE_TOKEN_HEADER], { audience: "agent", env: ENV });

  assert.equal(method, "POST");
  assert.deepEqual(JSON.parse(body), { question: "q" });
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(identity.accessScope, ALICE);
  assert.equal(identity.issuer, "api");
  assert.deepEqual(identity.claims, { runId: "run-1" });
  assert.equal(headers[SERVICE_REQUEST_ID_HEADER], "req-1");
  assert.equal(headers["x-request-id"], "public-1");
  assert.ok(Number(headers[SERVICE_DEADLINE_HEADER]) > 1000);
  assert.equal(headers.traceparent, undefined, "no trace context without a tracing SDK");

  await client.request({ path: "/health", system: true });
  assert.equal(
    verifyServiceToken(replica.hits[2].headers[SERVICE_TOKEN_HEADER], { audience: "agent", env: ENV }).system,
    true
  );

  await assert.rejects(client.request({ path: "/chat" }), TypeError);
  await assert.rejects(client.request({ accessScope: ALICE, path: "http://elsewhere/x" }), TypeError);
  await assert.rejects(client.request({ accessScope: ALICE, path: "//elsewhere/x" }), TypeError);
  assert.equal(replica.hits.length, 3);
});

test("streams pass through and keep the replica busy until the body ends", async (t) => {
  const gate = deferred();
  const replica = await startReplica("s", async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    await gate.promise;
    res.end("data: two\n\n");
  });
  t.after(() => replica.close());
  const client = makeClient([replica.url], { timeoutMs: 5000 });

  const response = await client.stream({ accessScope: ALICE, body: {}, method: "POST", path: "/chat/stream" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(replica.hits[0].headers[SERVICE_DEADLINE_HEADER], undefined);
  assert.equal(client.snapshot().replicas[0].outstanding, 1);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (!text.includes("one")) {
    const { value } = await reader.read();
    text += decoder.decode(value, { stream: true });
  }

  assert.equal(client.snapshot().replicas[0].outstanding, 1);
  gate.resolve();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  assert.equal(text, "data: one\n\ndata: two\n\n");
  assert.equal(client.snapshot().replicas[0].outstanding, 0);

  const cancelled = await client.stream({ accessScope: ALICE, deadlineMs: 4000, method: "POST", path: "/chat/stream" });
  const deadline = Number(replica.hits[1].headers[SERVICE_DEADLINE_HEADER]);

  assert.ok(deadline > 0 && deadline <= 4000, `deadline ${deadline}`);
  assert.equal(client.snapshot().replicas[0].outstanding, 1);
  await cancelled.body.cancel();
  assert.equal(client.snapshot().replicas[0].outstanding, 0);
});

test("configuration errors are typed and never leak URLs", async () => {
  await assert.rejects(makeClient([]).request({ accessScope: ALICE, path: "/chat" }), (error) => {
    assert.ok(error instanceof ServiceUnavailableError);
    assert.equal(error.code, SERVICE_CLIENT_ERROR_CODES.notConfigured);
    return true;
  });
  assert.throws(() => makeClient(["http://user:secret@agent:5001"]), (error) => !error.message.includes("secret"));
  assert.throws(() => createServiceClient({ env: ENV, urls: [] }), TypeError);
});

test("the process-wide registry follows the configured URLs", async (t) => {
  const replica = await startReplica("r");
  t.after(() => {
    resetServiceClients();
    return replica.close();
  });
  const env = { ...ENV, ARCHIVE_RAG_ROLE: "agent", RETRIEVAL_SERVICE_URL: replica.url };
  const client = getServiceClient("retrieval", { env });

  assert.equal(getServiceClient("retrieval", { env }), client);
  assert.equal(client.audience, "retrieval");

  await client.request({ accessScope: ALICE, path: "/retrieve" });
  const identity = verifyServiceToken(replica.hits[0].headers[SERVICE_TOKEN_HEADER], { audience: "retrieval", env });

  assert.equal(identity.issuer, "agent");
  assert.deepEqual(Object.keys(describeServiceClients()), ["retrieval"]);
  assert.equal(describeServiceClients().retrieval.replicas[0].requests, 1);
  assert.notEqual(getServiceClient("retrieval", { env: { ...env, RETRIEVAL_SERVICE_URL: `${replica.url}/v2` } }), client);
  await assert.rejects(getServiceClient("model-gateway", { env }).request({ accessScope: ALICE, path: "/v1/embeddings" }), (error) =>
    error.code === SERVICE_CLIENT_ERROR_CODES.notConfigured
  );
  assert.throws(() => getServiceClient("web", { env }), TypeError);
});

// Registers a global tracer provider, so it runs last in this file.
test("a receiving tier joins the caller's trace and tenant", async (t) => {
  const exporter = new InMemorySpanExporter();
  const provider = startTracing({ batch: false, exporters: [exporter] });
  t.after(() => provider.shutdown());

  const app = express();
  app.use(requireServiceIdentity({ audience: "agent", env: ENV }));
  app.use(bindDatabaseTenant);
  app.use(bindServiceTraceContext);
  app.get("/whoami", (req, res) =>
    withSpan("receiver", {}, async (span) =>
      res.json({
        accessScope: req.accessScope,
        remainingMs: getServiceDeadlineRemainingMs(req),
        tenant: getActiveDatabaseTenant(),
        traceId: span.spanContext().traceId,
      })
    )
  );
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = makeClient([`http://127.0.0.1:${server.address().port}`], { timeoutMs: 20_000 });

  const { callerTraceId, result } = await withSpan("caller", {}, async () => ({
    callerTraceId: trace.getActiveSpan().spanContext().traceId,
    result: await client.request({ accessScope: ALICE, path: "/whoami" }),
  }));

  assert.equal(result.status, 200);
  assert.deepEqual(result.json.accessScope, ALICE);
  assert.deepEqual(result.json.tenant, { userId: "alice", workspaceId: "ws-1" });
  assert.ok(result.json.remainingMs > 0 && result.json.remainingMs <= 20_000);
  assert.equal(result.json.traceId, callerTraceId);

  const refused = await fetch(`http://127.0.0.1:${server.address().port}/whoami`);

  assert.equal(refused.status, 401);
});
