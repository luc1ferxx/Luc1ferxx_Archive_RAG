// run-llm-resilience-eval.mjs
//
// Fault-injection eval for the chat completion path (completeTextWithMetadata).
// A local OpenAI-compatible server injects the failures a hosted model actually
// produces -- rate limiting with Retry-After, intermittent 503s, requests that
// never answer, empty completions, and a primary model that is down -- and the
// eval measures what a caller experiences: how many calls succeed within a
// latency SLO, how many upstream requests each call cost, and p50/p95 latency.
//
// Fault decisions come from a seeded generator, so a scenario injects the same
// fault mix on every run. Request interleaving under concurrency still varies,
// so treat small differences between runs as noise.
//
// The eval sets RAG_LLM_REQUEST_TIMEOUT_MS and OPENAI_CHAT_FALLBACK_MODEL for
// every scenario; code that predates those settings ignores them, which is
// exactly what a before/after comparison should show.
//
// Usage:
//   node evaluation/run-llm-resilience-eval.mjs [--calls 24] [--concurrency 8]
//     [--slo-ms 15000] [--scenarios healthy,rate_limited,...] [--latest-name <name>]
//     [--no-fallback]   offer no fallback model (failover ablation)

import "dotenv/config";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

const PRIMARY_MODEL = "resilience-primary";
const FALLBACK_MODEL = "resilience-fallback";

export const RESILIENCE_SCENARIOS = Object.freeze([
  { id: "healthy", description: "No faults; the latency floor.", faults: {} },
  {
    id: "rate_limited",
    description:
      "Token bucket of 4 requests/s; excess requests get 429 with a precise retry-after-ms (the time until the next token), as OpenAI sends.",
    faults: { rateLimitPerSecond: 4 },
  },
  {
    id: "rate_limited_coarse",
    description:
      "Same bucket, but the 429 only says Retry-After: 1 (whole seconds), longer than the bucket actually needs.",
    faults: { coarseRetryAfter: true, rateLimitPerSecond: 4 },
  },
  {
    id: "flaky_5xx",
    description: "40% of requests fail with 503.",
    faults: { errorRate: 0.4 },
  },
  {
    id: "hanging",
    description: "20% of requests never answer.",
    faults: { hangRate: 0.2 },
  },
  {
    id: "empty_completion",
    description: "30% of completions come back with empty content.",
    faults: { emptyRate: 0.3 },
  },
  {
    id: "primary_model_down",
    description: "Every request for the primary model fails with 503; the fallback model is healthy.",
    faults: { downModels: [PRIMARY_MODEL] },
  },
]);

// mulberry32, so a scenario injects the same fault sequence on every run.
const createSeededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, rank)]);
};

// A fake OpenAI-compatible chat endpoint whose faults are swapped per scenario.
export const startFaultInjectingServer = async () => {
  let faults = {};
  let random = createSeededRandom(1);
  let bucket = { tokens: 0, refilledAt: 0 };
  const stats = { requests: 0, byModel: {} };
  const hangingResponses = new Set();

  // Returns 0 when a token was taken, else the milliseconds until one refills.
  const takeRateLimitToken = (perSecond) => {
    const now = Date.now();
    const refill = ((now - bucket.refilledAt) / 1000) * perSecond;
    bucket = { tokens: Math.min(perSecond, bucket.tokens + refill), refilledAt: now };
    if (bucket.tokens < 1) return Math.ceil(((1 - bucket.tokens) / perSecond) * 1000);
    bucket.tokens -= 1;
    return 0;
  };

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = body ? JSON.parse(body) : {};
      stats.requests += 1;
      stats.byModel[payload.model] = (stats.byModel[payload.model] ?? 0) + 1;
      const roll = random();
      const send = (status, json, headers = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(json));
      };

      if ((faults.downModels ?? []).includes(payload.model)) {
        send(503, { error: { message: `The model ${payload.model} is overloaded.` } });
        return;
      }
      const waitMs = faults.rateLimitPerSecond ? takeRateLimitToken(faults.rateLimitPerSecond) : 0;
      if (waitMs > 0) {
        send(
          429,
          { error: { message: "Rate limit reached." } },
          faults.coarseRetryAfter
            ? { "retry-after": "1" }
            : { "retry-after": String(Math.ceil(waitMs / 1000)), "retry-after-ms": String(waitMs) }
        );
        return;
      }
      if (faults.errorRate && roll < faults.errorRate) {
        send(503, { error: { message: "Service unavailable." } });
        return;
      }
      if (faults.hangRate && roll < faults.hangRate) {
        hangingResponses.add(response);
        response.on("close", () => hangingResponses.delete(response));
        return;
      }
      const content = faults.emptyRate && roll < faults.emptyRate ? "" : "pong";
      setTimeout(
        () =>
          send(200, {
            choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
            model: payload.model,
            usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
          }),
        20
      );
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    setScenario: (scenario, seed) => {
      faults = scenario.faults ?? {};
      random = createSeededRandom(seed);
      bucket = { tokens: faults.rateLimitPerSecond ?? 0, refilledAt: Date.now() };
      stats.requests = 0;
      stats.byModel = {};
    },
    stats: () => ({ ...stats, byModel: { ...stats.byModel } }),
    close: async () => {
      for (const hanging of hangingResponses) hanging.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const runCall = async ({ complete, sloMs }) => {
  const started = performance.now();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "slo_exceeded" }), sloMs);
  });
  const attempt = complete("Reply with pong.").then(
    (result) => ({ outcome: normalizeText(result?.text) ? "ok" : "empty" }),
    (error) => ({ outcome: "error", error: String(error?.message ?? error).slice(0, 160) })
  );
  const result = await Promise.race([attempt, deadline]);
  clearTimeout(timer);
  return { ...result, latencyMs: performance.now() - started };
};

const normalizeText = (value) => String(value ?? "").trim();

export const runResilienceScenario = async ({
  calls = 24,
  complete,
  concurrency = 8,
  scenario,
  seed = 1,
  server,
  sloMs = 15000,
}) => {
  server.setScenario(scenario, seed);
  const results = [];
  let next = 0;

  const worker = async () => {
    while (next < calls) {
      next += 1;
      results.push(await runCall({ complete, sloMs }));
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, calls) }, worker));
  const stats = server.stats();
  const succeeded = results.filter((result) => result.outcome === "ok");
  const outcomes = results.reduce((counts, result) => {
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    return counts;
  }, {});

  return {
    id: scenario.id,
    description: scenario.description,
    calls,
    successRate: Number((succeeded.length / calls).toFixed(4)),
    outcomes,
    upstreamRequests: stats.requests,
    requestsPerCall: Number((stats.requests / calls).toFixed(2)),
    requestsByModel: stats.byModel,
    latencyMs: {
      p50: percentile(results.map((result) => result.latencyMs), 50),
      p95: percentile(results.map((result) => result.latencyMs), 95),
    },
    sampleError: results.find((result) => result.error)?.error ?? null,
  };
};

const renderMarkdown = (report) =>
  [
    "# LLM call resilience (fault injection)",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Calls per scenario: ${report.config.calls}, concurrency ${report.config.concurrency}, SLO ${report.config.sloMs} ms`,
    `- Per-request timeout offered: ${report.config.requestTimeoutMs} ms; fallback model offered: ${report.config.fallbackOffered ? `\`${FALLBACK_MODEL}\` (behind the same rate limiter: the worst case for failover)` : "none"}`,
    "- Success = non-empty completion within the SLO. Latency covers every call, capped at the SLO.",
    "",
    "| Scenario | Success | Requests/call | p50 ms | p95 ms | Outcomes |",
    "|---|---|---|---|---|---|",
    ...report.scenarios.map(
      (scenario) =>
        `| ${scenario.id} | ${(scenario.successRate * 100).toFixed(1)}% | ${scenario.requestsPerCall} | ${scenario.latencyMs.p50} | ${scenario.latencyMs.p95} | ${Object.entries(scenario.outcomes).map(([key, count]) => `${key}: ${count}`).join(", ")} |`
    ),
    "",
    ...report.scenarios.map((scenario) => `- **${scenario.id}**: ${scenario.description}`),
    "",
  ].join("\n");

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--no-fallback") {
      args.noFallback = true;
      continue;
    }
    if (argv[index].startsWith("--")) {
      args[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const calls = Number(args.calls) > 0 ? Number(args.calls) : 24;
  const concurrency = Number(args.concurrency) > 0 ? Number(args.concurrency) : 8;
  const sloMs = Number(args["slo-ms"]) > 0 ? Number(args["slo-ms"]) : 15000;
  const requestTimeoutMs = 3000;
  const wanted = args.scenarios ? new Set(args.scenarios.split(",")) : null;
  const latestName = args["latest-name"] ?? "latest-llm-resilience";

  const server = await startFaultInjectingServer();
  Object.assign(process.env, {
    OPENAI_API_KEY: "resilience-eval",
    OPENAI_BASE_URL: server.baseUrl,
    OPENAI_CHAT_MODEL: PRIMARY_MODEL,
    OPENAI_CHAT_FALLBACK_MODEL: args.noFallback ? "" : FALLBACK_MODEL,
    RAG_LLM_REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
  });
  delete process.env.OPENAI_API_BASE;

  const { completeTextWithMetadata } = await import("../rag/openai.js");
  const scenarios = [];

  try {
    for (const [index, scenario] of RESILIENCE_SCENARIOS.entries()) {
      if (wanted && !wanted.has(scenario.id)) continue;
      const result = await runResilienceScenario({
        calls,
        complete: (prompt) => completeTextWithMetadata(prompt),
        concurrency,
        scenario,
        seed: index + 1,
        server,
        sloMs,
      });
      scenarios.push(result);
      console.log(
        `${result.id.padEnd(20)} success ${(result.successRate * 100).toFixed(1).padStart(5)}%  requests/call ${String(result.requestsPerCall).padStart(5)}  p50 ${result.latencyMs.p50}ms  p95 ${result.latencyMs.p95}ms`
      );
    }
  } finally {
    await server.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    reportType: "llm-resilience",
    config: { calls, concurrency, fallbackOffered: !args.noFallback, requestTimeoutMs, sloMs },
    scenarios,
  };
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, `${latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDirectory, `${latestName}.md`), renderMarkdown(report));
  // Calls still stuck on a hanging request would otherwise hold the process open.
  process.exit(0);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
