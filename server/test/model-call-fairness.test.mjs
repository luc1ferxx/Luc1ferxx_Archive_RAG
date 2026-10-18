import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  buildModelCallGuardKey,
  CIRCUIT_OPEN_CODE,
  CIRCUIT_STATES,
  createConcurrencyLimiter,
  createSharedConcurrencyLimiter,
  createTenantFairQueue,
  describeModelCallTenantRef,
  getModelCallGuardSnapshot,
  guardModelCall,
  listModelCallGuardSnapshots,
  MODEL_CALL_LANES,
  MODEL_CALL_QUEUE_FULL_CODE,
  resetModelCallGuards,
  resolveModelCallLane,
  runWithModelCallAttribution,
} from "../rag/model-call-guard.js";
import { toGuardModelLabel } from "../rag/metrics-model.js";
import { createEmbeddingsClient } from "../rag/openai-client.js";
import { runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { RequestCancelledError } from "../rag/request-deadline.js";

// Fairness of the model-call guard's wait queue: per tenant, the tenant served
// longest ago first, FIFO within a tenant; a waiter that aborts leaves; an
// optional per-tenant bound; which tenants opened a circuit; and the ingest
// lane that keeps document embeddings off the query embeddings' slots. Order
// is checked with deferred promises and settled ticks, never with timing.

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const BOB = { userId: "bob", workspaceId: "ws-b" };
const CAROL = { userId: "carol", workspaceId: "ws-c" };

const GUARD_ENV = {
  RAG_LLM_CIRCUIT_COOLDOWN_MS: "60000",
  RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "5",
  RAG_LLM_INGEST_MAX_CONCURRENCY: undefined,
  RAG_LLM_MAX_CONCURRENCY: "1",
  RAG_LLM_MAX_QUEUE: undefined,
  RAG_SHARED_STATE: "memory",
};

const withEnv = (t, values) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  resetModelCallGuards();
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetModelCallGuards();
  });
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

// Lets every pending microtask run: guardModelCall awaits the breaker before
// it joins the queue.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

const call = (tenant, key, send, options) =>
  tenant ? runWithDatabaseTenant(tenant, () => guardModelCall(key, send, options)) : guardModelCall(key, send, options);

test("a tenant that arrives behind another tenant's burst runs after at most one of that tenant's calls", async (t) => {
  withEnv(t, GUARD_ENV);
  const key = "http://fair.test|m";
  const order = [];
  const holder = deferred();
  const first = call(ALICE, key, () => holder.promise);

  await settle();
  const burst = Array.from({ length: 20 }, (_, index) =>
    call(ALICE, key, async () => {
      order.push(`alice-${index}`);
    })
  );

  await settle();
  assert.equal(getModelCallGuardSnapshot(key).limiter.waiting, 20);

  const bob = call(BOB, key, async () => {
    order.push("bob-0");
  });

  await settle();
  assert.equal(getModelCallGuardSnapshot(key).limiter.waiting, 21);

  holder.resolve("held");
  await Promise.all([first, bob, ...burst]);

  assert.ok(order.indexOf("bob-0") <= 1, `bob ran at position ${order.indexOf("bob-0")}: ${order.join(", ")}`);
  assert.deepEqual(
    order.filter((name) => name.startsWith("alice")),
    Array.from({ length: 20 }, (_, index) => `alice-${index}`),
    "within a tenant the order is FIFO"
  );
  assert.deepEqual(getModelCallGuardSnapshot(key).limiter, { inFlight: 0, limit: 1, waiting: 0 });
});

test("backlogged tenants take turns, one slot each, and calls without a tenant share one queue", async (t) => {
  withEnv(t, GUARD_ENV);
  const key = "http://turns.test|m";
  const order = [];
  const holder = deferred();
  const first = call(ALICE, key, () => holder.promise);

  await settle();
  const queued = [];

  for (const [name, tenant] of [["alice", ALICE], ["bob", BOB], ["carol", CAROL], ["system", null]]) {
    for (let index = 0; index < 3; index += 1) {
      queued.push(
        call(tenant, key, async () => {
          order.push(name);
        })
      );
    }
  }

  await settle();
  holder.resolve();
  await Promise.all([first, ...queued]);

  // Every window of four consecutive grants serves each queue once.
  for (let start = 0; start < order.length; start += 4) {
    assert.deepEqual(
      [...order.slice(start, start + 4)].sort(),
      ["alice", "bob", "carol", "system"],
      `grants ${start}..${start + 3}: ${order.join(", ")}`
    );
  }
});

test("a waiter whose signal aborts leaves the queue at once, is never sent, and passes its turn on", async (t) => {
  withEnv(t, GUARD_ENV);
  const key = "http://abort.test|m";
  const sent = [];
  const holder = deferred();
  const first = call(ALICE, key, () => holder.promise);
  const controller = new AbortController();
  const cancelled = new RequestCancelledError("client_cancelled");

  await settle();
  const abandoned = call(ALICE, key, async () => sent.push("abandoned"), { signal: controller.signal });
  const next = call(BOB, key, async () => sent.push("next"));

  await settle();
  assert.equal(getModelCallGuardSnapshot(key).limiter.waiting, 2);

  controller.abort(cancelled);
  await assert.rejects(abandoned, (error) => error === cancelled);
  assert.equal(getModelCallGuardSnapshot(key).limiter.waiting, 1, "the aborted waiter left the queue");

  holder.resolve();
  await Promise.all([first, next]);
  assert.deepEqual(sent, ["next"]);

  // A signal that has already aborted is refused before it queues or sends,
  // even with a free slot; nothing reaches the circuit.
  await assert.rejects(
    call(ALICE, key, async () => sent.push("late"), { signal: AbortSignal.abort(cancelled) }),
    (error) => error === cancelled
  );
  assert.deepEqual(sent, ["next"]);
  assert.deepEqual(getModelCallGuardSnapshot(key).breaker, { consecutiveFailures: 0, state: CIRCUIT_STATES.closed });
  assert.deepEqual(getModelCallGuardSnapshot(key).limiter, { inFlight: 0, limit: 1, waiting: 0 });

  // The limiter on its own: an abort without a reason still rejects.
  const limiter = createConcurrencyLimiter(1);
  const release = await limiter.acquire();
  const plain = new AbortController();
  const waiting = limiter.acquire({ queueKey: "tenant:x", signal: plain.signal });

  plain.abort();
  await assert.rejects(waiting, (error) => error?.name === "AbortError");
  release();
  assert.deepEqual(limiter.snapshot(), { inFlight: 0, limit: 1, waiting: 0 });
});

test("RAG_LLM_MAX_QUEUE bounds each tenant's waiting calls with a 429 that never counts against the circuit", async (t) => {
  withEnv(t, { ...GUARD_ENV, RAG_LLM_MAX_QUEUE: "2" });
  const key = "http://bounded.test|m";
  const holder = deferred();
  const first = call(ALICE, key, () => holder.promise);

  await settle();
  const admitted = [call(ALICE, key, async () => "a1"), call(ALICE, key, async () => "a2")];

  await settle();
  await assert.rejects(call(ALICE, key, async () => "a3"), (error) => {
    assert.equal(error.code, MODEL_CALL_QUEUE_FULL_CODE);
    assert.equal(error.status, 429);
    assert.deepEqual(error.gatewayError, { code: MODEL_CALL_QUEUE_FULL_CODE, status: 429 });
    return true;
  });

  // Another tenant has its own bound.
  const bob = call(BOB, key, async () => "b1");

  await settle();
  assert.deepEqual(getModelCallGuardSnapshot(key).limiter, {
    inFlight: 1,
    limit: 1,
    maxQueue: 2,
    queueRejections: 1,
    waiting: 3,
  });
  assert.deepEqual(getModelCallGuardSnapshot(key).breaker, { consecutiveFailures: 0, state: CIRCUIT_STATES.closed });

  holder.resolve();
  assert.deepEqual(await Promise.all([...admitted, bob]), ["a1", "a2", "b1"]);
  await first;
});

test("an open circuit names the tenants whose failures opened it, by hash only, until it closes", async (t) => {
  withEnv(t, { ...GUARD_ENV, RAG_LLM_CIRCUIT_COOLDOWN_MS: "50", RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "3", RAG_LLM_MAX_CONCURRENCY: "4" });
  const key = "http://openers.test|m";
  const fail = () => Promise.reject(httpError(503));
  const aliceRef = describeModelCallTenantRef(ALICE);
  const bobRef = describeModelCallTenantRef(BOB);

  assert.match(aliceRef, /^tenant:[0-9a-f]{16}$/);
  assert.notEqual(aliceRef, bobRef);
  assert.equal(describeModelCallTenantRef(null), "system");

  await assert.rejects(call(ALICE, key, fail), /HTTP 503/);
  await assert.rejects(call(BOB, key, fail), /HTTP 503/);
  // Closed: no openers are reported, only the count (unchanged shape).
  assert.deepEqual(getModelCallGuardSnapshot(key).breaker, { consecutiveFailures: 2, state: CIRCUIT_STATES.closed });
  await assert.rejects(call(ALICE, key, fail), /HTTP 503/);

  const opened = getModelCallGuardSnapshot(key).breaker;

  assert.equal(opened.state, CIRCUIT_STATES.open);
  assert.deepEqual(opened.openedBy, [
    { failures: 2, tenant: aliceRef },
    { failures: 1, tenant: bobRef },
  ]);
  assert.doesNotMatch(JSON.stringify(listModelCallGuardSnapshots()), /alice|ws-a|bob|ws-b/);
  await assert.rejects(call(BOB, key, async () => "never"), (error) => error.code === CIRCUIT_OPEN_CODE);

  // A failed half-open probe reopens it on the probe's tenant alone.
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(call(null, key, fail), /HTTP 503/);
  assert.deepEqual(getModelCallGuardSnapshot(key).breaker.openedBy, [{ failures: 1, tenant: "system" }]);

  // A successful probe closes it and the openers go.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await call(BOB, key, async () => "ok"), "ok");
  assert.deepEqual(getModelCallGuardSnapshot(key).breaker, { consecutiveFailures: 0, state: CIRCUIT_STATES.closed });

  // A call made for several tenants at once (a merged ingest batch) waits in
  // the system queue and is recorded against every tenant it carried.
  const batchKey = "http://openers.test|batch";

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(runWithModelCallAttribution([ALICE, BOB, null], () => guardModelCall(batchKey, fail)), /HTTP 503/);
  }

  assert.deepEqual(getModelCallGuardSnapshot(batchKey).breaker.openedBy, [
    { failures: 3, tenant: "system" },
    { failures: 3, tenant: aliceRef },
    { failures: 3, tenant: bobRef },
  ].sort((left, right) => (left.tenant < right.tenant ? -1 : 1)));
});

test("document embeddings wait in their own lane: a saturated ingest lane never holds a query embedding back", async (t) => {
  withEnv(t, { ...GUARD_ENV, RAG_LLM_INGEST_MAX_CONCURRENCY: "2", RAG_LLM_MAX_CONCURRENCY: "1" });
  const key = "http://lanes.test|embed-model";
  const ingestKey = buildModelCallGuardKey(key, MODEL_CALL_LANES.ingest);
  const holders = [deferred(), deferred()];
  const ingest = [
    ...holders.map((holder) => call(ALICE, key, () => holder.promise, { lane: MODEL_CALL_LANES.ingest })),
    ...Array.from({ length: 5 }, () =>
      call(ALICE, key, () => Promise.reject(httpError(503)), { lane: MODEL_CALL_LANES.ingest })
    ),
  ];

  await settle();
  assert.deepEqual(getModelCallGuardSnapshot(ingestKey).limiter, { inFlight: 2, limit: 2, waiting: 5 });

  // The query lane is free.
  assert.equal(await call(BOB, key, async () => "query"), "query");
  assert.deepEqual(getModelCallGuardSnapshot(key).limiter, { inFlight: 0, limit: 1, waiting: 0 });

  // The lane goes in front of the key, so metrics still label it by model.
  assert.equal(ingestKey, `ingest|${key}`);
  assert.equal(buildModelCallGuardKey(key), key);
  assert.equal(toGuardModelLabel(ingestKey), "embed-model");

  // Failures of the ingest lane open its circuit only.
  holders.forEach((holder) => holder.reject(httpError(503)));
  await Promise.allSettled(ingest);
  assert.equal(getModelCallGuardSnapshot(ingestKey).breaker.state, CIRCUIT_STATES.open);
  assert.deepEqual(getModelCallGuardSnapshot(key).breaker, { consecutiveFailures: 0, state: CIRCUIT_STATES.closed });
  assert.equal(await call(BOB, key, async () => "query again"), "query again");
});

test("the embeddings client sends document batches through the ingest lane and queries through the default lane", async (t) => {
  const server = http.createServer((req, res) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const { input } = JSON.parse(raw);
      const texts = Array.isArray(input) ? input : [input];

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: texts.map((text, index) => ({ embedding: [text.length, index], index })) }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  withEnv(t, { ...GUARD_ENV, OPENAI_API_BASE: undefined, OPENAI_BASE_URL: baseUrl, RAG_LLM_INGEST_MAX_CONCURRENCY: "4" });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = createEmbeddingsClient({ apiKey: "test", model: "lane-embed" });

  assert.deepEqual(await client.embedDocuments(["ab", "c"]), [
    [2, 0],
    [1, 1],
  ]);
  assert.deepEqual(await client.embedQuery("query"), [5, 0]);

  const keys = listModelCallGuardSnapshots().map(([guardKey]) => guardKey).sort();

  assert.deepEqual(keys, [`${baseUrl}|lane-embed`, `ingest|${baseUrl}|lane-embed`].sort());

  // Unset, document batches share the endpoint's one guard (the withEnv
  // above restores the variable after the test).
  delete process.env.RAG_LLM_INGEST_MAX_CONCURRENCY;
  resetModelCallGuards();
  await client.embedDocuments(["ab"]);
  await client.embedQuery("query");
  assert.deepEqual(listModelCallGuardSnapshots().map(([guardKey]) => guardKey), [`${baseUrl}|lane-embed`]);
});

test("without RAG_LLM_INGEST_MAX_CONCURRENCY the ingest lane shares the endpoint's cap and circuit", async (t) => {
  // An endpoint sized to RAG_LLM_MAX_CONCURRENCY=1 never sees a document
  // embedding and a query embedding in flight at once.
  withEnv(t, { ...GUARD_ENV, RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "2", RAG_LLM_MAX_CONCURRENCY: "1" });
  const key = "http://shared-lane.test|embed-model";
  const holder = deferred();
  const order = [];
  const ingest = call(ALICE, key, () => holder.promise, { lane: MODEL_CALL_LANES.ingest });

  await settle();
  const query = call(BOB, key, async () => {
    order.push("query");
    return "query";
  });

  await settle();
  assert.equal(resolveModelCallLane(MODEL_CALL_LANES.ingest), MODEL_CALL_LANES.default);
  assert.deepEqual(listModelCallGuardSnapshots().map(([guardKey]) => guardKey), [key]);
  assert.deepEqual(getModelCallGuardSnapshot(key).limiter, { inFlight: 1, limit: 1, waiting: 1 });
  assert.deepEqual(order, [], "the query waits for the document embedding's slot");

  holder.resolve("ingested");
  assert.equal(await ingest, "ingested");
  assert.equal(await query, "query");

  // One circuit sees both lanes' failures.
  await assert.rejects(call(ALICE, key, () => Promise.reject(httpError(503)), { lane: MODEL_CALL_LANES.ingest }));
  await assert.rejects(call(BOB, key, () => Promise.reject(httpError(503))));
  assert.equal(getModelCallGuardSnapshot(key).breaker.state, CIRCUIT_STATES.open);
  await assert.rejects(
    call(ALICE, key, async () => "never sent", { lane: MODEL_CALL_LANES.ingest }),
    (error) => error.code === CIRCUIT_OPEN_CODE
  );

  // An empty or non-numeric value is unset too; any number (0 = no cap) opts in.
  for (const value of ["", "   ", "many"]) {
    assert.equal(resolveModelCallLane(MODEL_CALL_LANES.ingest, { RAG_LLM_INGEST_MAX_CONCURRENCY: value }), "default");
  }

  for (const value of ["0", "3", " 8 "]) {
    assert.equal(resolveModelCallLane(MODEL_CALL_LANES.ingest, { RAG_LLM_INGEST_MAX_CONCURRENCY: value }), "ingest");
  }

  assert.equal(resolveModelCallLane(MODEL_CALL_LANES.default, { RAG_LLM_INGEST_MAX_CONCURRENCY: "3" }), "default");
});

test("a tenant that makes one call at a time stays served when it comes back, so a tenant's second waiting call is not starved", async () => {
  // Cap 1. Tenant x holds a slot and queues a second call. Three tenants each
  // make one call at a time and queue the next as soon as the last returns,
  // so between their calls they hold nothing and wait for nothing. Were their
  // turns forgotten while idle, each would come back as a newcomer (turn 0),
  // always ahead of x's second call, and x would wait until they stopped.
  const limiter = createConcurrencyLimiter(1);
  const order = [];
  const releaseFirst = await limiter.acquire({ queueKey: "tenant:x" });

  order.push("x-1");

  const second = limiter.acquire({ queueKey: "tenant:x" }).then((release) => {
    order.push("x-2");
    release();
  });
  const cycle = async (name, rounds) => {
    for (let round = 0; round < rounds; round += 1) {
      const release = await limiter.acquire({ queueKey: `tenant:${name}` });

      order.push(name);
      await settle();
      release();
    }
  };
  const light = ["a", "b", "c"].map((name) => cycle(name, 10));

  await settle();
  assert.equal(limiter.snapshot().waiting, 4);
  releaseFirst();
  await Promise.all([second, ...light]);

  // Each light tenant, never served before, goes once ahead of x's second
  // call (x was served last); then x's turn is the oldest.
  assert.deepEqual(order.slice(0, 5), ["x-1", "a", "b", "c", "x-2"], order.join(", "));
  assert.equal(order.length, 32);
  assert.deepEqual(limiter.snapshot(), { inFlight: 0, limit: 1, waiting: 0 });
});

test("a fair queue remembers a bounded number of idle tenants' turns", () => {
  const queue = createTenantFairQueue({ maxTrackedTenants: 2 });
  const waiter = (queueKey) => ({ queueKey });

  // a, b, c served in that order and idle again; only b and c are remembered.
  for (const key of ["a", "b", "c"]) {
    queue.started(key);
    queue.finished(key);
  }

  ["c", "b", "a", "d"].forEach((key) => queue.push(waiter(key)));

  // a's turn was dropped, so it sorts with d, never served (turn 0, arrival
  // order between them); b and c keep the order they were served in.
  assert.deepEqual(queue.drain().map((entry) => entry.queueKey), ["a", "d", "b", "c"]);
});

test("the shared cap's local queue is fair per tenant and lets an aborted waiter go", async () => {
  // A stand-in for the Redis scripts: no slot until the test opens the gate,
  // then one slot per poll.
  const gate = { slots: 0 };
  const redis = {
    archiveSlotAcquire: async () => {
      if (gate.slots > 0) {
        gate.slots -= 1;
        return [1, 0];
      }

      return [0, 0];
    },
    zrem: async () => 1,
  };
  const limiter = createSharedConcurrencyLimiter({
    key: "fair-shared",
    leaseMs: 1000,
    limit: 1,
    local: createConcurrencyLimiter(1),
    maxPollMs: 1,
    pollMs: 1,
    redis,
  });
  const order = [];
  const take = (queueKey, name, options = {}) =>
    limiter.acquire({ queueKey, ...options }).then((release) => {
      order.push(name);
      return release;
    });
  const alice = [1, 2, 3].map((index) => take("tenant:alice", `alice-${index}`));
  const bob = take("tenant:bob", "bob-1");
  const controller = new AbortController();
  const abandoned = take("tenant:carol", "carol-1", { signal: controller.signal });

  assert.equal(limiter.snapshot().waiting, 5);
  controller.abort(new Error("caller left"));
  await assert.rejects(abandoned, /caller left/);
  assert.equal(limiter.snapshot().waiting, 4);

  gate.slots = 4;
  const releases = await Promise.all([...alice, bob]);

  assert.deepEqual(order, ["alice-1", "bob-1", "alice-2", "alice-3"]);
  releases.forEach((release) => release());
  assert.equal(limiter.snapshot().waiting, 0);
});
