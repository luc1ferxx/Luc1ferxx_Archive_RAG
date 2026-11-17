// GET /health and /ready answer anyone ahead of rate limiting and auth (the
// system router is mounted first), and one report runs about fifteen checks,
// several of them a database round trip. So the router shares one build among
// the probes that arrive while it runs, answers with the last report it built
// for HEALTH_REPORT_REUSE_MS after that build finished, and never serves a
// build that threw to anyone but the probes that waited on it.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import test, { describe } from "node:test";

import express from "express";

import { createSystemRouter, HEALTH_REPORT_REUSE_MS } from "../routes/system.js";

// Everything that changes what canReadHealthDetails decides or what /livez
// names, cleared so the shell's exports do not leak in.
const ENV_KEYS = ["API_AUTH_ENABLED", "API_AUTH_TOKEN", "API_AUTH_TOKENS", "ARCHIVE_RAG_ROLE"];

const withEnv = async (values, run) => {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return await run();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const OK_REPORT = Object.freeze({ checks: { database: { status: "ok" } }, status: "ok" });
const FAILING_REPORT = Object.freeze({
  checks: { database: { message: "connection refused", status: "error" } },
  status: "error",
});

const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

// The system router alone over a stub health service, on a clock the test
// moves. untilArrivals(n) resolves once n more requests have reached the
// router and joined (or started) the build.
const startRouter = async (healthService, clock = { now: 0 }) => {
  const app = express();
  let arrived = 0;
  let expected = null;

  app.use((req, res, next) => {
    arrived += 1;

    if (expected && arrived >= expected.count) {
      // With auth off the handler reaches the build without I/O, so one
      // macrotask later the last request is waiting on it too.
      setImmediate(expected.resolve);
      expected = null;
    }

    next();
  });
  app.use(createSystemRouter({ healthService }, { now: () => clock.now }));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    clock,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
    get: async (requestPath, headers = {}) => {
      const response = await fetch(`${baseUrl}${requestPath}`, { headers });

      return {
        body: await response.json(),
        cacheControl: response.headers.get("cache-control"),
        status: response.status,
      };
    },
    untilArrivals: (count) =>
      new Promise((resolve) => {
        expected = { count: arrived + count, resolve };
      }),
  };
};

describe("GET /health and /ready share one health report", () => {
  test("50 concurrent probes of /ready, /health or both run one build", { timeout: 20_000 }, async () => {
    await withEnv({}, async () => {
      for (const paths of [["/ready"], ["/health"], ["/ready", "/health"]]) {
        let builds = 0;
        const gate = deferred();
        const router = await startRouter({
          buildHealthReport: async () => {
            builds += 1;
            await gate.promise;
            return structuredClone(OK_REPORT);
          },
        });

        try {
          // The build finishes only after all 50 have arrived, so the memo
          // cannot be what answers them: they share the one in flight.
          router.untilArrivals(50).then(gate.resolve);
          const responses = await Promise.all(
            Array.from({ length: 50 }, (_, index) => router.get(paths[index % paths.length]))
          );

          assert.equal(builds, 1, paths.join(" + "));
          for (const response of responses) {
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, OK_REPORT);
          }
        } finally {
          await router.close();
        }
      }
    });
  });

  test("the last report answers for HEALTH_REPORT_REUSE_MS, then a new one is built", async () => {
    await withEnv({}, async () => {
      let builds = 0;
      let report = OK_REPORT;
      const router = await startRouter({
        buildHealthReport: async () => {
          builds += 1;
          return structuredClone(report);
        },
      });

      try {
        // /livez checks nothing and builds no report.
        assert.deepEqual((await router.get("/livez")).body, { role: "all", status: "ok" });
        assert.equal(builds, 0);

        let ready = await router.get("/ready");
        assert.equal(ready.status, 200);
        assert.equal(builds, 1);

        report = FAILING_REPORT;
        router.clock.now += HEALTH_REPORT_REUSE_MS - 1;
        ready = await router.get("/ready");
        const health = await router.get("/health");
        assert.equal(ready.status, 200);
        assert.deepEqual(ready.body, OK_REPORT);
        assert.equal(health.status, 200);
        assert.deepEqual(health.body, OK_REPORT);
        assert.equal(builds, 1);

        router.clock.now += 1;
        ready = await router.get("/ready");
        assert.equal(ready.status, 503);
        assert.deepEqual(ready.body, FAILING_REPORT);
        assert.equal(builds, 2);

        // A failing report is still a report: it is reused, and /health
        // answers it with 200 as before.
        const failingHealth = await router.get("/health");
        assert.equal(failingHealth.status, 200);
        assert.deepEqual(failingHealth.body, FAILING_REPORT);
        assert.equal(builds, 2);
      } finally {
        await router.close();
      }
    });
  });

  test("the window starts when the build finishes, so a slow build is still reused", async () => {
    await withEnv({}, async () => {
      const clock = { now: 0 };
      let builds = 0;
      const router = await startRouter(
        {
          buildHealthReport: async () => {
            builds += 1;
            clock.now += 5 * HEALTH_REPORT_REUSE_MS;
            return structuredClone(OK_REPORT);
          },
        },
        clock
      );

      try {
        await router.get("/ready");
        clock.now += HEALTH_REPORT_REUSE_MS - 1;
        assert.equal((await router.get("/ready")).status, 200);
        assert.equal(builds, 1);
      } finally {
        await router.close();
      }
    });
  });

  test("a build that threw answers the probes that waited on it and is never served again", { timeout: 20_000 }, async () => {
    await withEnv({}, async () => {
      let builds = 0;
      let fail = false;
      let gate = Promise.resolve();
      const router = await startRouter({
        buildHealthReport: async () => {
          builds += 1;
          await gate;

          if (fail) {
            throw new Error("database unreachable");
          }

          return structuredClone(OK_REPORT);
        },
      });

      try {
        assert.equal((await router.get("/ready")).status, 200);
        assert.equal(builds, 1);

        // The report above has run out; its rebuild fails. Everyone waiting on
        // that build gets the failure, none the older report.
        router.clock.now += HEALTH_REPORT_REUSE_MS;
        fail = true;
        const held = deferred();
        gate = held.promise;
        router.untilArrivals(10).then(held.resolve);
        const responses = await Promise.all(
          Array.from({ length: 10 }, (_, index) => router.get(index % 2 ? "/health" : "/ready"))
        );

        assert.equal(builds, 2);
        for (const [index, response] of responses.entries()) {
          assert.equal(response.status, index % 2 ? 500 : 503);
          assert.deepEqual(response.body, { error: "database unreachable", status: "error" });
        }

        // The same instant: only because the failure is not kept does the next
        // probe build again.
        fail = false;
        const ready = await router.get("/ready");
        assert.equal(ready.status, 200);
        assert.deepEqual(ready.body, OK_REPORT);
        assert.equal(builds, 3);
      } finally {
        await router.close();
      }
    });
  });

  test("a build that throws synchronously does not stay in flight", async () => {
    await withEnv({}, async () => {
      let builds = 0;
      const router = await startRouter({
        buildHealthReport: () => {
          builds += 1;
          throw new Error("not configured");
        },
      });

      try {
        const health = await router.get("/health");
        const ready = await router.get("/ready");

        assert.equal(health.status, 500);
        assert.deepEqual(health.body, { error: "not configured", status: "error" });
        assert.equal(ready.status, 503);
        assert.equal(builds, 2);
      } finally {
        await router.close();
      }
    });
  });

  test("auth on: the shared report still answers each caller with only what it may see", async () => {
    const token = crypto.randomBytes(24).toString("hex");

    await withEnv({ API_AUTH_ENABLED: "true", API_AUTH_TOKEN: token }, async () => {
      let builds = 0;
      const router = await startRouter({
        buildHealthReport: async () => {
          builds += 1;
          return structuredClone(FAILING_REPORT);
        },
      });

      try {
        // The first caller sees only the status, yet the memo keeps the whole
        // report for the operator after it.
        const anonymousReady = await router.get("/ready");
        const operatorReady = await router.get("/ready", { "x-api-key": token });
        const anonymousHealth = await router.get("/health");
        const operatorHealth = await router.get("/health", { authorization: `Bearer ${token}` });

        assert.equal(builds, 1);
        assert.equal(anonymousReady.status, 503);
        assert.deepEqual(anonymousReady.body, { status: "error" });
        assert.equal(operatorReady.status, 503);
        assert.deepEqual(operatorReady.body, FAILING_REPORT);
        assert.equal(anonymousHealth.status, 200);
        assert.deepEqual(anonymousHealth.body, { status: "error" });
        assert.equal(operatorHealth.status, 200);
        assert.deepEqual(operatorHealth.body, FAILING_REPORT);

        for (const response of [anonymousReady, operatorReady, anonymousHealth, operatorHealth]) {
          assert.equal(response.cacheControl, "no-store");
        }
      } finally {
        await router.close();
      }
    });
  });
});
