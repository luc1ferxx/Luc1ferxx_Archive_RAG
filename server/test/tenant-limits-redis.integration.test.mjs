import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Real-Redis checks for the per-tenant rate limit (TENANT_RATE_LIMIT_ENABLED
// with RAG_SHARED_STATE=redis): two "instances" are two limiters with their
// own in-process counters over the same Redis keys, which is what separate
// processes share. Runs only when REDIS_TEST_URL points at a Redis it may
// write to under a throwaway key prefix; otherwise it is reported as skipped,
// never passed.

const redisUrl = String(process.env.REDIS_TEST_URL ?? "").trim();

if (!redisUrl) {
  test("tenant rate limit Redis integration suite", {
    skip: "REDIS_TEST_URL is not set; point it at a disposable Redis to run the tenant rate-limit suite",
  }, () => {});
} else {
  const prefix = `archive-rag-test:${randomBytes(4).toString("hex")}:`;

  process.env.RAG_SHARED_STATE = "redis";
  process.env.REDIS_URL = redisUrl;
  process.env.RAG_SHARED_STATE_PREFIX = prefix;

  const [shared, limits] = await Promise.all([
    import("../rag/shared-state.js"),
    import("../rag/tenant-limits.js"),
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

  const LIMITS = { chat: 3, default: 10, destructive: 1, ingest: 5 };

  test("two instances share one tenant's window, and other tenants keep theirs", async () => {
    const nowMs = 60_000 * 1_000 + 12_000;
    const first = limits.createTenantRateLimiter({
      enabled: true,
      limits: LIMITS,
      now: () => nowMs,
      windowMs: 60_000,
    });
    const second = limits.createTenantRateLimiter({
      enabled: true,
      limits: LIMITS,
      now: () => nowMs,
      windowMs: 60_000,
    });

    assert.equal(first.describe().shared.provider, "redis");
    assert.deepEqual(await first.admit("chat", "workspace:acme"), { ok: true });
    assert.deepEqual(await second.admit("chat", "workspace:acme"), { ok: true });
    assert.deepEqual(await first.admit("chat", "workspace:acme"), { ok: true });

    const refused = await second.admit("chat", "workspace:acme");

    assert.equal(refused.ok, false);
    assert.equal(refused.retryAfterMs, 48_000);
    assert.deepEqual(await second.admit("chat", "workspace:globex"), { ok: true });
    assert.deepEqual(await first.admit("default", "workspace:acme"), { ok: true });

    // Keys are hashed and expire after their window.
    const keys = await redis.keys(`${prefix}tenant_rate:*`);

    assert.equal(keys.length, 3);
    for (const key of keys) {
      assert.doesNotMatch(key, /acme|globex/u);
      const ttl = await redis.pttl(key);
      assert.ok(ttl > 0 && ttl <= 48_000 + 60_000, `ttl ${ttl}`);
    }

    assert.equal(first.describe().shared.fallbacks, 0);
    assert.equal(second.describe().shared.fallbacks, 0);
  });

  test("a refused request is not counted in Redis", async () => {
    const nowMs = 60_000 * 2_000 + 1_000;
    const limiter = limits.createTenantRateLimiter({
      enabled: true,
      limits: { ...LIMITS, destructive: 1 },
      now: () => nowMs,
      windowMs: 60_000,
    });

    assert.deepEqual(await limiter.admit("destructive", "workspace:initech"), { ok: true });
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await limiter.admit("destructive", "workspace:initech")).ok, false);
    }

    const keys = await redis.keys(`${prefix}tenant_rate:*`);
    const values = await Promise.all(keys.map((key) => redis.get(key)));

    // The other test's counters plus this one's, which stayed at 1.
    assert.ok(values.includes("1"));
    assert.ok(values.every((value) => Number(value) <= LIMITS.chat));
  });
}
