import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Real-Redis checks for the shared model-call state (RAG_SHARED_STATE=redis).
// Two "instances" are two breakers or limiters with their own in-process
// state over the same Redis keys, which is exactly what separate processes
// share. Runs only when REDIS_TEST_URL points at a Redis it may write to under
// a throwaway key prefix; otherwise it is reported as skipped, never passed.

const redisUrl = String(process.env.REDIS_TEST_URL ?? "").trim();

if (!redisUrl) {
  test("shared state Redis integration suite", {
    skip: "REDIS_TEST_URL is not set; point it at a disposable Redis to run the shared-state suite",
  }, () => {});
} else {
  const prefix = `archive-rag-test:${randomBytes(4).toString("hex")}:`;

  process.env.RAG_SHARED_STATE = "redis";
  process.env.REDIS_URL = redisUrl;
  process.env.RAG_SHARED_STATE_PREFIX = prefix;

  const [guard, shared, judge, evaluate, openai, tenantStore] = await Promise.all([
    import("../rag/model-call-guard.js"),
    import("../rag/shared-state.js"),
    import("../rag/self-check/claim-judge.js"),
    import("../rag/self-check/evaluate.js"),
    import("../rag/openai.js"),
    import("../rag/postgres-tenant.js"),
  ]);
  let redis;

  before(async () => {
    redis = shared.getSharedRedisClient();
    await shared.whenSharedStateReady();
  });

  after(async () => {
    const keys = await redis.keys(`${prefix}*`);

    if (keys.length > 0) {
      await redis.del(keys);
    }

    await shared.resetSharedState();
  });

  const createInstanceBreaker = ({ key, now = Date.now, probeLeaseMs = 60000 }) =>
    guard.createSharedCircuitBreaker({
      cooldownMs: 1000,
      failureThreshold: 3,
      key,
      local: guard.createCircuitBreaker({ cooldownMs: 1000, failureThreshold: 3, now }),
      now,
      probeLeaseMs,
      redis,
    });

  test("a circuit one instance opens is open for every instance, and one success closes it", async () => {
    const a = createInstanceBreaker({ key: "http://model|opens" });
    const b = createInstanceBreaker({ key: "http://model|opens" });

    for (let index = 0; index < 3; index += 1) {
      await a.recordFailure();
    }

    assert.equal(await b.isRejecting(), true, "b never saw a failure itself");
    assert.equal(await b.admit(), false);
    assert.equal(b.snapshot().state, "closed", "b's own state is untouched");

    await b.recordSuccess();
    assert.equal(await a.isRejecting(), false);
  });

  test("after the cooldown exactly one instance probes, and a dead prober's lease expires", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const a = createInstanceBreaker({ key: "http://model|probe", now, probeLeaseMs: 500 });
    const b = createInstanceBreaker({ key: "http://model|probe", now, probeLeaseMs: 500 });

    for (let index = 0; index < 3; index += 1) {
      await a.recordFailure();
    }

    clock += 1000;
    assert.equal(await a.admit(), true, "a takes the half-open probe");
    assert.equal(await b.admit(), false, "only one probe across instances");
    // a crashes without reporting; its lease runs out.
    clock += 600;
    assert.equal(await b.admit(), true);
  });

  test("the concurrency cap is one budget across instances", async () => {
    const createInstanceLimiter = () =>
      guard.createSharedConcurrencyLimiter({
        key: "http://model|slots",
        leaseMs: 60000,
        limit: 2,
        local: guard.createConcurrencyLimiter(2),
        pollMs: 5,
        redis,
      });
    const a = createInstanceLimiter();
    const b = createInstanceLimiter();
    const releaseA1 = await a.acquire();
    await a.acquire();
    let bAcquired = false;
    const bSlot = b.acquire().then((release) => {
      bAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bAcquired, false, "a holds both deployment-wide slots");

    releaseA1();
    (await bSlot)();
    assert.equal(bAcquired, true);
  });

  const waitUntil = async (condition, label) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.fail(`timed out waiting until ${label}`);
  };

  test("a freed slot goes to the instance that waited longest, not back to the one that freed it", async () => {
    const key = "http://model|fair";
    const queueKey = `${shared.buildSharedStateKey("slots", key)}:queue`;
    const createInstanceLimiter = () =>
      guard.createSharedConcurrencyLimiter({
        key,
        leaseMs: 60000,
        limit: 1,
        local: guard.createConcurrencyLimiter(1),
        maxPollMs: 20,
        pollMs: 5,
        redis,
      });
    const a = createInstanceLimiter();
    const b = createInstanceLimiter();
    const order = [];
    // Each holder keeps its slot briefly, like a model request, then frees it.
    const holdThenRelease = (name) => async (release) => {
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 15));
      release();
    };
    const releaseFirst = await a.acquire();
    const calls = [1, 2, 3].map(() => a.acquire().then(holdThenRelease("a")));

    await waitUntil(async () => (await redis.zcard(queueKey)) === 1, "a's head is queued");
    calls.push(b.acquire().then(holdThenRelease("b")));
    await waitUntil(async () => (await redis.zcard(queueKey)) === 2, "b's head is queued behind it");

    // a's release wakes a at once; before the fix a re-took every slot it
    // freed and b waited for all of a's callers.
    releaseFirst();
    await Promise.all(calls);
    assert.deepEqual(order, ["a", "b", "a", "a"]);
    assert.equal(await redis.zcard(queueKey), 0, "served tickets leave the queue");
  });

  test("a ticket its instance stopped refreshing expires instead of blocking the queue", async () => {
    let clock = 5_000_000;
    const now = () => clock;
    const key = "http://model|stale-ticket";
    const slotsKey = shared.buildSharedStateKey("slots", key);
    const createInstanceLimiter = () =>
      guard.createSharedConcurrencyLimiter({
        key,
        leaseMs: 60000,
        limit: 1,
        local: guard.createConcurrencyLimiter(1),
        maxPollMs: 10,
        now,
        pollMs: 5,
        redis,
      });
    const holder = createInstanceLimiter();
    const releaseHolder = await holder.acquire();
    // An instance queues behind the holder and dies without polling again.
    const [taken] = await redis.archiveSlotAcquire(
      slotsKey,
      `${slotsKey}:queue`,
      `${slotsKey}:queue-deadlines`,
      clock,
      1,
      60000,
      "lease-of-dead-instance",
      60000,
      "ticket-of-dead-instance",
      500
    );

    assert.equal(taken, 0);
    releaseHolder();

    let acquired = false;
    const waiter = createInstanceLimiter()
      .acquire()
      .then((release) => {
        acquired = true;
        return release;
      });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(acquired, false, "the dead instance's ticket is still ahead");

    clock += 600;
    (await waiter)();
    assert.equal(acquired, true);
  });

  test("an unreachable Redis falls back to per-process state instead of failing calls", async () => {
    const dead = shared.createSharedRedisClient("redis://127.0.0.1:1");
    const local = guard.createCircuitBreaker({ cooldownMs: 1000, failureThreshold: 1 });
    const breaker = guard.createSharedCircuitBreaker({
      cooldownMs: 1000,
      failureThreshold: 1,
      key: "http://model|dead",
      local,
      probeLeaseMs: 1000,
      redis: dead,
    });
    const limiter = guard.createSharedConcurrencyLimiter({
      key: "http://model|dead",
      leaseMs: 1000,
      limit: 1,
      local: guard.createConcurrencyLimiter(1),
      redis: dead,
    });

    try {
      assert.equal(await breaker.admit(), true);
      await breaker.recordFailure();
      assert.equal(await breaker.isRejecting(), true, "the local breaker still protects");
      assert.ok(breaker.snapshot().shared.fallbacks >= 3);

      const release = await limiter.acquire();

      assert.equal(typeof release, "function");
      release();
      assert.ok(limiter.snapshot().shared.fallbacks >= 1);
    } finally {
      dead.disconnect();
    }
  });

  test("claim-judge verdicts are shared, and a different model never reuses them", async (t) => {
    const previousJudge = process.env.RAG_CLAIM_JUDGE;
    const previousModel = process.env.OPENAI_CHAT_MODEL;
    let modelCalls = 0;

    process.env.RAG_CLAIM_JUDGE = "llm";
    process.env.OPENAI_CHAT_MODEL = "judge-model-a";
    openai.configureOpenAIProvider({
      completeText: async () => {
        modelCalls += 1;
        return JSON.stringify({ verdicts: [{ claim: 0, reason: "Restates the source.", supported: true }] });
      },
    });
    t.after(() => {
      openai.resetOpenAIProvider();
      judge.resetClaimJudgeCache();
      process.env.RAG_CLAIM_JUDGE = previousJudge ?? "";
      process.env.OPENAI_CHAT_MODEL = previousModel ?? "";
    });

    const citations = [{
      docId: "policy",
      evidenceText: "Contoso completes a verified deletion request within 30 days.",
      excerpt: "Contoso completes a verified deletion request within 30 days.",
      fileName: "policy.pdf",
      pageNumber: 1,
      rank: 1,
    }];
    const judgeOnce = async () =>
      judge.judgeClaimSupport({
        citations,
        claimSupport: evaluate.evaluateClaimSupport({
          answerText: "Deletion requests are finished inside a month by Contoso [Source 1].",
          citations,
        }),
      });

    await judgeOnce();
    assert.equal(modelCalls, 1);

    // Another instance: empty local cache, same Redis.
    judge.resetClaimJudgeCache();
    const reused = await judgeOnce();

    assert.equal(modelCalls, 1, "the second instance reused the shared verdict");
    assert.equal(reused.judge.cachedClaimCount, 1);

    judge.resetClaimJudgeCache();
    process.env.OPENAI_CHAT_MODEL = "judge-model-b";
    await judgeOnce();
    assert.equal(modelCalls, 2, "a verdict belongs to the model that produced it");
  });

  test("claim-judge verdicts in Redis are the verdict alone, and one tenant never reads another's", async (t) => {
    const previousJudge = process.env.RAG_CLAIM_JUDGE;
    let modelCalls = 0;

    process.env.RAG_CLAIM_JUDGE = "llm";
    openai.configureOpenAIProvider({
      completeText: async () => {
        modelCalls += 1;
        return JSON.stringify({
          verdicts: [{ claim: 0, reason: "Contoso finishes deletion within 30 days.", supported: true }],
        });
      },
    });
    t.after(() => {
      openai.resetOpenAIProvider();
      judge.resetClaimJudgeCache();
      process.env.RAG_CLAIM_JUDGE = previousJudge ?? "";
    });

    const citations = [{
      docId: "retention",
      evidenceText: "Contoso erases a verified account within 30 days of the request.",
      excerpt: "Contoso erases a verified account within 30 days of the request.",
      fileName: "retention.pdf",
      pageNumber: 1,
      rank: 1,
    }];
    const judgeAs = (tenant) =>
      tenantStore.runWithDatabaseTenant(tenant, () =>
        judge.judgeClaimSupport({
          citations,
          claimSupport: evaluate.evaluateClaimSupport({
            answerText: "Account erasure is done inside a month by Contoso [Source 1].",
            citations,
          }),
        })
      );
    const judgeKeys = async () => redis.keys(`${prefix}judge:*`);
    const keysBefore = new Set(await judgeKeys());

    await judgeAs({ userId: "alice", workspaceId: "acme" });
    const aliceKeys = (await judgeKeys()).filter((key) => !keysBefore.has(key));

    assert.equal(modelCalls, 1);
    assert.equal(aliceKeys.length, 1);
    assert.equal(await redis.get(aliceKeys[0]), JSON.stringify({ supported: true }));
    assert.ok(!aliceKeys[0].includes("alice") && !aliceKeys[0].includes("acme"));

    judge.resetClaimJudgeCache();
    const reused = await judgeAs({ userId: "alice", workspaceId: "acme" });
    assert.equal(modelCalls, 1, "the same tenant on another instance reuses the verdict");
    assert.equal(reused.claims[0].judge.reason, "");

    judge.resetClaimJudgeCache();
    await judgeAs({ userId: "bob", workspaceId: "globex" });
    assert.equal(modelCalls, 2, "another tenant asks the model itself");
  });

  test("within one instance the shared cap's waiters take turns per tenant", async () => {
    const limiter = guard.createSharedConcurrencyLimiter({
      key: "http://model|tenant-fair",
      leaseMs: 60000,
      limit: 1,
      local: guard.createConcurrencyLimiter(1),
      maxPollMs: 20,
      pollMs: 5,
      redis,
    });
    const order = [];
    const holdThenRelease = (name) => async (release) => {
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      release();
    };
    const releaseFirst = await limiter.acquire({ queueKey: "tenant:alice" });
    const calls = [1, 2, 3].map((index) =>
      limiter.acquire({ queueKey: "tenant:alice" }).then(holdThenRelease(`alice-${index}`))
    );

    calls.push(limiter.acquire({ queueKey: "tenant:bob" }).then(holdThenRelease("bob-1")));
    releaseFirst();
    await Promise.all(calls);
    assert.deepEqual(order, ["bob-1", "alice-1", "alice-2", "alice-3"]);
  });

  test("the in-process quota and the gateway's count one workspace quota in Redis", async () => {
    const { createWorkspaceModelQuotas } = await import("../rag/model-quotas.js");
    const { createModelGatewayQuotas } = await import("../rag/model-gateway/quotas.js");
    // A fixed instant, so both instances read the same minute window.
    const now = () => Date.UTC(2031, 0, 2, 3, 4, 5);
    const inProcess = createWorkspaceModelQuotas({ limits: { requestsPerMinute: 2 }, now, redis });
    const gateway = createModelGatewayQuotas({ limits: { requestsPerMinute: 2 }, now, redis });
    const alice = { userId: "alice", workspaceId: `quota-${randomBytes(3).toString("hex")}` };

    assert.deepEqual(await inProcess.admit(alice), { ok: true });
    assert.deepEqual(await gateway.admit(alice), { ok: true });
    assert.equal((await inProcess.admit(alice)).quota, "requests_per_minute");
    assert.equal((await gateway.admit(alice)).quota, "requests_per_minute");
    assert.deepEqual(await inProcess.admit({ userId: "bob", workspaceId: `${alice.workspaceId}-b` }), { ok: true });
    assert.equal(inProcess.describe().shared.fallbacks, 0);
  });
}
