// run-shared-state-eval.mjs
//
// Several app instances against one model endpoint, with the model call guard
// (rag/model-call-guard.js) keeping its state per process (RAG_SHARED_STATE=
// memory) or in Redis (=redis). Each instance is a separate Node process
// sending real HTTP requests through completeTextWithMetadata to the same
// fault-injecting OpenAI-compatible server the resilience eval uses:
//
// - primary_model_down: every request for the primary model fails with 503;
//   the fallback model is healthy. Per-process breakers each have to see their
//   own failures before failing over; a shared breaker opens once for all.
// - saturated: a self-hosted server with 2 workers at 400 ms per request that
//   keeps processing requests the client abandoned. The cap is 8 in flight per
//   endpoint; per process, 4 instances allow 32.
//
// Each scenario and mode gets a fresh server and a fresh Redis key prefix.
//
// Usage (needs a running Redis for the redis mode):
//   node evaluation/run-shared-state-eval.mjs [--instances 4] [--calls 12]
//     [--redis-url redis://127.0.0.1:6379] [--modes memory,redis]

import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { startFaultInjectingServer } from "./run-llm-resilience-eval.mjs";

const __filename = fileURLToPath(import.meta.url);
const resultsDirectory = path.join(path.dirname(__filename), "results");
const PRIMARY_MODEL = "shared-state-primary";
const FALLBACK_MODEL = "shared-state-fallback";
const REQUEST_TIMEOUT_MS = 3000;
const SLO_MS = 15000;

const SCENARIOS = Object.freeze([
  {
    callersPerInstance: 4,
    description: "Every request for the primary model fails with 503; the fallback model is healthy.",
    faults: { downModels: [PRIMARY_MODEL] },
    id: "primary_model_down",
  },
  {
    callersPerInstance: 8,
    description:
      "2 workers at 400 ms per request; excess requests queue and abandoned requests are still processed.",
    faults: { capacity: 2, serviceMs: 400 },
    id: "saturated",
  },
]);

const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);

  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]);
};

// --- Worker: one app instance -------------------------------------------------

const runWorker = async () => {
  const { calls, callers } = JSON.parse(process.env.SHARED_STATE_EVAL_WORKER);
  const { completeTextWithMetadata } = await import("../rag/openai.js");
  const { resetSharedState } = await import("../rag/shared-state.js").catch(() => ({}));
  const results = [];
  let next = 0;

  const callOnce = async () => {
    const started = performance.now();
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ outcome: "slo_exceeded" }), SLO_MS);
    });
    const attempt = completeTextWithMetadata("Reply with pong.").then(
      (result) => ({ outcome: String(result?.text ?? "").trim() ? "ok" : "empty" }),
      (error) => ({ error: String(error?.message ?? error).slice(0, 120), outcome: "error" })
    );
    const result = await Promise.race([attempt, deadline]);

    clearTimeout(timer);
    return { ...result, latencyMs: performance.now() - started };
  };

  await Promise.all(
    Array.from({ length: callers }, async () => {
      while (next < calls) {
        next += 1;
        results.push(await callOnce());
      }
    })
  );

  process.send({ results });
  await resetSharedState?.();
  process.exit(0);
};

// --- Parent: a cluster of instances ------------------------------------------

const runCluster = async ({ calls, instances, mode, redisUrl, scenario }) => {
  const server = await startFaultInjectingServer();

  server.setScenario({ faults: scenario.faults }, 1);

  const prefix = `shared-state-eval:${randomBytes(4).toString("hex")}:`;
  const workerEnv = {
    ...process.env,
    OPENAI_API_KEY: "shared-state-eval",
    OPENAI_BASE_URL: server.baseUrl,
    OPENAI_CHAT_FALLBACK_MODEL: FALLBACK_MODEL,
    OPENAI_CHAT_MODEL: PRIMARY_MODEL,
    RAG_LLM_MAX_CONCURRENCY: "8",
    RAG_LLM_REQUEST_TIMEOUT_MS: String(REQUEST_TIMEOUT_MS),
    RAG_SHARED_STATE: mode,
    RAG_SHARED_STATE_PREFIX: prefix,
    REDIS_URL: redisUrl,
    SHARED_STATE_EVAL_WORKER: JSON.stringify({ callers: scenario.callersPerInstance, calls }),
  };

  delete workerEnv.OPENAI_API_BASE;

  try {
    const workerResults = await Promise.all(
      Array.from(
        { length: instances },
        () =>
          new Promise((resolve, reject) => {
            const child = fork(__filename, ["--worker"], { env: workerEnv, stdio: "inherit" });
            let results = null;

            child.on("message", (message) => {
              results = message.results;
            });
            child.on("exit", (code) =>
              results ? resolve(results) : reject(new Error(`instance exited with ${code}`))
            );
          })
      )
    );
    const results = workerResults.flat();
    const stats = server.stats();

    return {
      calls: results.length,
      instances,
      latencyMs: {
        p50: percentile(results.map((result) => result.latencyMs), 50),
        p95: percentile(results.map((result) => result.latencyMs), 95),
      },
      mode,
      peakServerPending: scenario.faults.capacity ? stats.peakPending : undefined,
      primaryRequests: stats.byModel[PRIMARY_MODEL] ?? 0,
      requestsPerCall: Number((stats.requests / results.length).toFixed(2)),
      scenario: scenario.id,
      successRate: Number((results.filter((result) => result.outcome === "ok").length / results.length).toFixed(4)),
      upstreamRequests: stats.requests,
    };
  } finally {
    await server.close();
  }
};

const renderMarkdown = (report) =>
  [
    "# Shared model-call state across instances",
    "",
    `Generated ${report.generatedAt}; ${report.config.instances} instances x ${report.config.callsPerInstance} calls; request timeout ${REQUEST_TIMEOUT_MS} ms, SLO ${SLO_MS} ms, cap 8 per endpoint.`,
    "",
    "| Scenario | State | Success | Requests/call | Primary requests | Peak server queue | p50 ms | p95 ms |",
    "|---|---|---|---|---|---|---|---|",
    ...report.results.map(
      (result) =>
        `| ${result.scenario} | ${result.mode} | ${(result.successRate * 100).toFixed(1)}% | ${result.requestsPerCall} | ${result.primaryRequests} | ${result.peakServerPending ?? "-"} | ${result.latencyMs.p50} | ${result.latencyMs.p95} |`
    ),
    "",
  ].join("\n");

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const instances = Math.max(1, Number(option("--instances", "4")) || 4);
  const calls = Math.max(1, Number(option("--calls", "12")) || 12);
  const redisUrl = option("--redis-url", process.env.REDIS_URL || "redis://127.0.0.1:6379");
  const modes = option("--modes", "memory,redis").split(",").filter(Boolean);
  const results = [];

  for (const scenario of SCENARIOS) {
    for (const mode of modes) {
      const result = await runCluster({ calls, instances, mode, redisUrl, scenario });

      results.push(result);
      console.log(
        `${scenario.id.padEnd(20)} ${mode.padEnd(7)} success ${(result.successRate * 100).toFixed(1)}%  requests/call ${result.requestsPerCall}  primary ${result.primaryRequests}  peak queue ${result.peakServerPending ?? "-"}  p50 ${result.latencyMs.p50}ms  p95 ${result.latencyMs.p95}ms`
      );
    }
  }

  const report = {
    config: { callsPerInstance: calls, instances, modes },
    generatedAt: new Date().toISOString(),
    reportType: "shared-state",
    results,
  };

  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, "latest-shared-state.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDirectory, "latest-shared-state.md"), renderMarkdown(report));
  process.exit(0);
};

if (process.argv.includes("--worker")) {
  await runWorker();
} else {
  await main();
}
