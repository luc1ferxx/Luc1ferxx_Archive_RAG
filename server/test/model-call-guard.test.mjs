import assert from "node:assert/strict";
import test from "node:test";
import {
  CIRCUIT_OPEN_CODE,
  CIRCUIT_STATES,
  createCircuitBreaker,
  createConcurrencyLimiter,
  getModelCallGuardSnapshot,
  guardModelCall,
  isUnavailableError,
  resetModelCallGuards,
} from "../rag/model-call-guard.js";

const withEnv = (t, values) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
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

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test("only errors that say the endpoint is down count against the circuit", () => {
  assert.equal(isUnavailableError(httpError(503)), true);
  assert.equal(isUnavailableError(httpError(500)), true);
  assert.equal(isUnavailableError(httpError(408)), true);
  assert.equal(isUnavailableError(Object.assign(new Error("t"), { code: "ETIMEDOUT" })), true);
  assert.equal(
    isUnavailableError(Object.assign(new Error("r"), { cause: { code: "ECONNREFUSED" } })),
    true
  );
  // Up, and asking us to slow down: backoff handles it.
  assert.equal(isUnavailableError(httpError(429)), false);
  assert.equal(isUnavailableError(httpError(400)), false);
  assert.equal(isUnavailableError(Object.assign(new Error("e"), { code: "EMPTY_COMPLETION" })), false);
});

test("the limiter never exceeds its cap and hands slots out in arrival order", async () => {
  const limiter = createConcurrencyLimiter(2);
  const order = [];
  const first = await limiter.acquire();
  const second = await limiter.acquire();
  const third = limiter.acquire().then((release) => {
    order.push("third");
    return release;
  });
  const fourth = limiter.acquire().then((release) => {
    order.push("fourth");
    return release;
  });

  assert.deepEqual(limiter.snapshot(), { inFlight: 2, limit: 2, waiting: 2 });

  first();
  first(); // a double release must not free a second slot
  const releaseThird = await third;
  assert.deepEqual(limiter.snapshot(), { inFlight: 2, limit: 2, waiting: 1 });

  second();
  const releaseFourth = await fourth;
  assert.deepEqual(order, ["third", "fourth"]);

  releaseThird();
  releaseFourth();
  assert.deepEqual(limiter.snapshot(), { inFlight: 0, limit: 2, waiting: 0 });

  const unlimited = createConcurrencyLimiter(0);
  await Promise.all(Array.from({ length: 50 }, () => unlimited.acquire()));
  assert.equal(unlimited.snapshot().inFlight, 50);
});

test("the breaker opens on consecutive failures, probes once, and closes on success", () => {
  let now = 0;
  const breaker = createCircuitBreaker({
    cooldownMs: 1000,
    failureThreshold: 3,
    now: () => now,
  });

  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordSuccess(); // a success in between resets the count
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.snapshot().state, CIRCUIT_STATES.closed);

  breaker.recordFailure();
  assert.equal(breaker.snapshot().state, CIRCUIT_STATES.open);
  assert.equal(breaker.isRejecting(), true);
  assert.equal(breaker.admit(), false);

  now = 1000;
  assert.equal(breaker.isRejecting(), false);
  assert.equal(breaker.admit(), true, "one probe after the cooldown");
  assert.equal(breaker.snapshot().state, CIRCUIT_STATES.halfOpen);
  assert.equal(breaker.admit(), false, "only one probe at a time");
  assert.equal(breaker.isRejecting(), true);

  // A failed probe reopens for a fresh cooldown.
  breaker.recordFailure();
  assert.equal(breaker.snapshot().state, CIRCUIT_STATES.open);
  now = 1500;
  assert.equal(breaker.admit(), false);

  now = 2000;
  assert.equal(breaker.admit(), true);
  breaker.recordSuccess();
  assert.deepEqual(breaker.snapshot(), { consecutiveFailures: 0, state: CIRCUIT_STATES.closed });
});

test("a threshold of 0 turns the breaker off", () => {
  const breaker = createCircuitBreaker({ cooldownMs: 1000, failureThreshold: 0 });

  for (let index = 0; index < 20; index += 1) {
    breaker.recordFailure();
  }

  assert.equal(breaker.isRejecting(), false);
  assert.equal(breaker.admit(), true);
});

test("guarded calls trip the circuit on 503s but not on 429s", async (t) => {
  withEnv(t, {
    RAG_LLM_CIRCUIT_COOLDOWN_MS: "60000",
    RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "2",
    RAG_LLM_MAX_CONCURRENCY: "4",
  });
  resetModelCallGuards();
  const key = "http://model.test|m";
  const fail = (status) => () => Promise.reject(httpError(status));

  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(guardModelCall(key, fail(429)), /HTTP 429/);
  }
  assert.equal(getModelCallGuardSnapshot(key).breaker.state, CIRCUIT_STATES.closed);

  await assert.rejects(guardModelCall(key, fail(503)), /HTTP 503/);
  await assert.rejects(guardModelCall(key, fail(503)), /HTTP 503/);

  let sent = false;
  await assert.rejects(
    guardModelCall(key, async () => {
      sent = true;
    }),
    (error) => error.code === CIRCUIT_OPEN_CODE && error.status === 503
  );
  assert.equal(sent, false, "an open circuit sends nothing");
  // The rejected call never held a slot.
  assert.equal(getModelCallGuardSnapshot(key).limiter.inFlight, 0);
  // Another endpoint or model has its own circuit.
  assert.equal(await guardModelCall("http://model.test|other", async () => "ok"), "ok");
});

test("requests queued behind the ones that trip the circuit are not sent", async (t) => {
  withEnv(t, {
    RAG_LLM_CIRCUIT_COOLDOWN_MS: "60000",
    RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1",
    RAG_LLM_MAX_CONCURRENCY: "1",
  });
  resetModelCallGuards();
  const key = "http://model.test|queued";
  const inFlight = deferred();
  let queuedSent = false;

  const first = guardModelCall(key, () => inFlight.promise);
  const queued = guardModelCall(key, async () => {
    queuedSent = true;
  });

  // The breaker check is awaited (it may be a Redis round trip), so the second
  // call joins the queue a tick later.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getModelCallGuardSnapshot(key).limiter.waiting, 1);
  inFlight.reject(httpError(503));

  await assert.rejects(first, /HTTP 503/);
  await assert.rejects(queued, (error) => error.code === CIRCUIT_OPEN_CODE);
  assert.equal(queuedSent, false);
});
