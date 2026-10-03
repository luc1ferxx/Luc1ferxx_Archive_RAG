import assert from "node:assert/strict";
import test from "node:test";

import { getMetricsRegistry, setMetricsEnabled } from "../rag/metrics.js";
import { createServiceClient } from "../rag/service-client.js";
import { parseExposition, sampleValue } from "./metrics-exposition.mjs";

// archive_rag_service_client_failovers_total counts attempts that moved to
// another replica. When a failed attempt leaves the call no budget (the
// caller's deadline or the client timeout), no further attempt is made, so
// nothing moved and nothing is counted.

const env = { ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_KEYS: `k1:${"f".repeat(48)}` };
const URLS = ["http://127.0.0.1:1", "http://127.0.0.1:2"];
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const answered = () =>
  new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" }, status: 200 });

const failovers = () =>
  sampleValue(parseExposition(getMetricsRegistry().render()), "archive_rag_service_client_failovers_total", {
    tier: "retrieval",
  });

test("a failed attempt that leaves no budget counts no failover; one followed by another attempt counts one", async (t) => {
  setMetricsEnabled(true);
  t.after(() => setMetricsEnabled(null));

  // Every attempt takes 5 s on a clock the client reads, against a 1 s budget.
  let clock = 0;
  const outOfTime = createServiceClient({
    audience: "retrieval",
    env,
    fetch: async () => {
      clock += 5_000;
      throw refused();
    },
    now: () => clock,
    timeoutMs: 1_000,
    urls: URLS,
  });
  const beforeTimeout = failovers();

  await assert.rejects(outOfTime.request({ path: "/x", system: true }), (error) => error.code === "SERVICE_TIMEOUT");
  assert.equal(failovers() - beforeTimeout, 0);

  // The control: the first replica refuses, the second answers in time.
  const inTime = createServiceClient({
    audience: "retrieval",
    env,
    fetch: async (url) => {
      if (String(url).startsWith(URLS[0])) {
        throw refused();
      }

      return answered();
    },
    urls: URLS,
  });
  const beforeFailover = failovers();

  assert.equal((await inTime.request({ path: "/x", system: true })).status, 200);
  assert.equal(failovers() - beforeFailover, 1);
});
