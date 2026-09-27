// run-api-load-bench.mjs
//
// API load test of the real Express app: throughput, latency percentiles and
// error rate for POST /chat (single-document QA through the full agent path)
// and for a cheap endpoint (GET /documents by default) at several concurrency
// levels.
//
// What is measured is the system, not a model. A fake OpenAI-compatible server
// in this process answers /v1/embeddings with deterministic hashed term vectors
// of the configured width and /v1/chat/completions with the first sentence of
// the prompt's Source 1 evidence plus "[Source 1]", after an artificial delay.
// Each latency profile (default 0 ms and 800 ms per chat completion) runs every
// /chat concurrency level: 0 ms is the app's own overhead; 800 ms shows how it
// behaves while waiting on a model, including the per-endpoint model
// concurrency cap RAG_LLM_MAX_CONCURRENCY (rag/model-call-guard.js). The fake
// server records how many model requests each scenario sent and the peak number
// of chat completions in flight at once, so the cap is observed, not assumed.
//
// The app runs in a child process built the way server.js builds it
// (createApp() with the real services), on an ephemeral 127.0.0.1 port, so its
// event loop is not shared with the load generator. Before any request it
// ingests a synthetic corpus (default 20 documents x 4 pages) through
// ingestDocumentPages, the same indexing path the upload route ends in. Two
// storage modes:
//   pgvector  VECTOR_STORE_PROVIDER=pgvector with POSTGRES_DATABASE_URL and
//             LONG_MEMORY_DATABASE_URL set to --database-url: the default
//             production path (registry, chunks, sessions, agent runs and
//             long-term memory in PostgreSQL). Point it only at a disposable
//             database; scripts/run-load-test-pgvector.sh creates one.
//   local     the standalone profile (standalone-profile.js): local JSON
//             vector index, file registry, in-memory stores, no PostgreSQL.
//
// Load model: closed loop. Each of C virtual users sends its next request as
// soon as the previous response arrives, until the level's fixed request count
// is reached; a short warm-up at the same concurrency runs first and is
// discarded. Closed-loop numbers describe latency at that concurrency, not at a
// fixed arrival rate (a slow response delays the next request, so queueing
// behind a stall is under-represented). Every virtual user keeps one sessionId
// per scenario, as the frontend does.
//
// Percentiles use the nearest-rank method over successful (2xx) responses:
// p = the value at rank ceil(p/100 * n) of the sorted latencies (rank 1 for
// p = 0). With fewer than 100 samples p99 is the maximum. Throughput is
// completed requests (any status) per second of the level's wall time;
// goodput counts 2xx only. Error rate counts non-2xx statuses, timeouts and
// connection errors.
//
// Defaults kept on purpose: API auth and rate limiting stay disabled (the app's
// defaults); --auth enables API_AUTH_TOKEN auth (the client sends x-api-key) and
// --rate-limit enables RATE_LIMIT_ENABLED with the app's default limits (30
// /chat requests per minute), which will show up as 429s in the error rate.
// Agent planning is pinned to the deterministic planners by default, so a /chat
// request costs one query embedding plus the answer completion; the production
// default (AGENT_PLANNER_ROLLOUT=llm) adds planner completions per request.
// --planner llm keeps that production setting; the fake's replies are not
// valid plans, so the planners fall back to the deterministic plan after
// paying for the call -- the call count and model wait are realistic, the plan
// is not. The claim judge stays off (its default). The query embedding cache
// stays on (its default); the question pool (one question per page) repeats
// once it is exhausted, so after the first pass over the pool every request
// hits the cache (with the defaults only the first /chat level embeds any
// query) -- the "Embedding calls/req" column shows it, and
// --no-embedding-cache turns it off. GET /documents reads the in-process
// registry and never reaches PostgreSQL, in either storage mode.
//
// The load generator, fake model and app share one machine; treat the numbers
// as this machine's, and compare runs made on the same host.
//
// Several instances (--instances N, pgvector only): N app processes on their
// own ports against the one database, sharing the temp data and upload
// directories. Only the first migrates the (fresh) database and ingests the
// seed corpus; the others start afterwards and load its registry. The load
// generator balances client-side: request i goes to instance i mod N. The
// report keeps the per-level totals and adds per-instance request counts and
// CPU; the fake model's peak in flight counts every instance together, so
// --shared-state redis (RAG_SHARED_STATE=redis, a Redis key prefix per run)
// shows RAG_LLM_MAX_CONCURRENCY as one cap for the cluster, and memory as a
// cap per process.
//
// Ingest scenario (--scenario ingest): generated text PDFs (load-bench-pdf.mjs)
// go through POST /upload at each --upload-concurrency level while a
// background /chat load (--chat-concurrency) runs over the seed corpus. Per
// level: upload latency, time until searchable (sync: the 201; async: GET
// /ingest-jobs/:jobId reports succeeded and GET /documents lists the document
// on another instance than the one that took it), documents/s, errors, and the
// background chat latency during the window next to the same load for the same
// time with nothing being ingested. --ingest-mode async sets RAG_INGEST_MODE;
// --ingest-workers K adds K processes running server/ingest-worker.mjs and
// turns the API processes' own worker loop off. Embeddings cost
// --embedding-latency-ms per request (200 ms by default in this scenario).
// A discarded warm-up asks every seed question once on every instance (each
// has its own query embedding cache) and uploads one document per instance.
//
// Usage:
//   node evaluation/run-api-load-bench.mjs
//     [--storage local|pgvector|local,pgvector]  default: local, or
//                                   pgvector,local when --database-url is given,
//                                   pgvector with --instances > 1 or --ingest-workers
//     [--database-url <disposable pgvector PostgreSQL URL>]
//     [--instances 1] [--shared-state memory|redis] [--redis-url <disposable Redis URL>]
//     [--scenario chat|ingest]
//     [--concurrency 1,4,16,32] [--requests 128] [--cheap-requests 1000]
//     [--warmup 8] [--model-latency-ms 0,800] [--embedding-latency-ms 0]
//     [--llm-max-concurrency 8] [--embedding-dimensions 1536]
//     [--documents 20] [--pages 4] [--cheap-path /documents]
//     [--request-timeout-ms 120000] [--planner deterministic|llm]
//     [--auth] [--rate-limit] [--no-embedding-cache]
//     [--latest-name latest-load-test] [--verbose]
//   ingest scenario only:
//     [--ingest-mode sync|async] [--ingest-workers 0] [--ingest-worker-concurrency N]
//     [--uploads 16] [--upload-concurrency 4] [--ingest-pages 4]
//     [--chat-concurrency 4] [--poll-interval-ms 250] [--searchable-timeout-ms 120000]
//     (--latest-name defaults to latest-load-test-ingest)
//
// Full run against a throwaway PostgreSQL (created and removed by the script;
// --with-redis also starts a throwaway Redis and passes --shared-state redis):
//   bash scripts/run-load-test-pgvector.sh [--with-redis] [extra flags]

import { execFileSync, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIngestDocuments } from "./load-bench-pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const resultsDirectory = path.join(__dirname, "results");

export const LOAD_TEST_REPORT_TYPE = "load-test";
export const LOAD_TEST_REPORT_VERSION = "1.1.0";
export const PERCENTILE_METHOD = "nearest-rank";

const FAKE_CHAT_MODEL = "load-test-chat";
const FAKE_EMBEDDING_MODEL = "text-embedding-3-small";

export const DEFAULT_LOAD_TEST_OPTIONS = Object.freeze({
  auth: false,
  chatConcurrency: 4,
  cheapPath: "/documents",
  cheapRequests: 1000,
  concurrency: Object.freeze([1, 4, 16, 32]),
  databaseUrl: "",
  documents: 20,
  embeddingCache: true,
  embeddingDimensions: 1536,
  embeddingLatencyMs: 0,
  ingestMode: "sync",
  ingestPages: 4,
  ingestWorkerConcurrency: null,
  ingestWorkers: 0,
  instances: 1,
  latestName: "latest-load-test",
  llmMaxConcurrency: 8,
  modelLatencyMs: Object.freeze([0, 800]),
  pages: 4,
  planner: "deterministic",
  pollIntervalMs: 250,
  rateLimit: false,
  redisUrl: "",
  requestTimeoutMs: 120000,
  requests: 128,
  scenario: "chat",
  searchableTimeoutMs: 120000,
  sharedState: "memory",
  storage: null,
  uploadConcurrency: Object.freeze([4]),
  uploads: 16,
  verbose: false,
  warmup: 8,
});

// The ingest scenario measures what an upload costs, so its embeddings are not
// free unless --embedding-latency-ms says so; the chat scenario keeps 0.
export const DEFAULT_INGEST_EMBEDDING_LATENCY_MS = 200;
export const DEFAULT_INGEST_LATEST_NAME = "latest-load-test-ingest";

const STORAGE_MODES = new Set(["local", "pgvector"]);
const PLANNER_MODES = new Set(["deterministic", "llm"]);
const SCENARIOS = new Set(["chat", "ingest"]);
const INGEST_MODES = new Set(["sync", "async"]);
const SHARED_STATE_MODES = new Set(["memory", "redis"]);
const INGEST_ONLY_FLAGS = Object.freeze([
  "chat-concurrency",
  "ingest-mode",
  "ingest-pages",
  "ingest-worker-concurrency",
  "ingest-workers",
  "poll-interval-ms",
  "searchable-timeout-ms",
  "upload-concurrency",
  "uploads",
]);

const round = (value, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));

const toIntegerList = (raw, name) => {
  const values = String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number);

  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} expects a comma-separated list of non-negative integers, got "${raw}".`);
  }

  return values;
};

const toPositiveInteger = (raw, name, { allowZero = false } = {}) => {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${name} expects a ${allowZero ? "non-negative" : "positive"} integer, got "${raw}".`);
  }

  return value;
};

/** Parses CLI flags into a complete options object (defaults filled in). */
export const parseLoadTestArgs = (argv = []) => {
  const raw = {};
  const flags = new Set(["auth", "no-embedding-cache", "rate-limit", "verbose", "serve", "serve-worker"]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);

    if (flags.has(name)) {
      raw[name] = true;
    } else if (inlineValue !== undefined) {
      raw[name] = inlineValue;
    } else {
      if (index + 1 >= argv.length) throw new Error(`--${name} needs a value.`);
      raw[name] = argv[++index];
    }
  }

  const options = { ...DEFAULT_LOAD_TEST_OPTIONS };
  const known = new Set([
    ...flags,
    ...INGEST_ONLY_FLAGS,
    "cheap-path",
    "cheap-requests",
    "concurrency",
    "database-url",
    "documents",
    "embedding-dimensions",
    "embedding-latency-ms",
    "instances",
    "latest-name",
    "llm-max-concurrency",
    "model-latency-ms",
    "pages",
    "planner",
    "redis-url",
    "request-timeout-ms",
    "requests",
    "scenario",
    "shared-state",
    "storage",
    "warmup",
  ]);

  for (const name of Object.keys(raw)) {
    if (!known.has(name)) throw new Error(`Unknown flag --${name}.`);
  }

  if (raw.auth) options.auth = true;
  if (raw["no-embedding-cache"]) options.embeddingCache = false;
  if (raw["rate-limit"]) options.rateLimit = true;
  if (raw.verbose) options.verbose = true;
  if (raw["cheap-path"]) {
    if (!String(raw["cheap-path"]).startsWith("/")) throw new Error("--cheap-path must start with /.");
    options.cheapPath = String(raw["cheap-path"]);
  }
  if (raw["cheap-requests"] !== undefined)
    options.cheapRequests = toPositiveInteger(raw["cheap-requests"], "--cheap-requests");
  if (raw.concurrency !== undefined) {
    options.concurrency = toIntegerList(raw.concurrency, "--concurrency");
    if (options.concurrency.includes(0)) throw new Error("--concurrency levels must be at least 1.");
  }
  if (raw["database-url"] !== undefined) options.databaseUrl = String(raw["database-url"]).trim();
  if (raw.documents !== undefined) options.documents = toPositiveInteger(raw.documents, "--documents");
  if (raw["embedding-dimensions"] !== undefined)
    options.embeddingDimensions = toPositiveInteger(raw["embedding-dimensions"], "--embedding-dimensions");
  if (raw["embedding-latency-ms"] !== undefined)
    options.embeddingLatencyMs = toPositiveInteger(raw["embedding-latency-ms"], "--embedding-latency-ms", {
      allowZero: true,
    });
  if (raw["latest-name"]) options.latestName = String(raw["latest-name"]);
  if (raw["llm-max-concurrency"] !== undefined)
    options.llmMaxConcurrency = toPositiveInteger(raw["llm-max-concurrency"], "--llm-max-concurrency", {
      allowZero: true,
    });
  if (raw["model-latency-ms"] !== undefined)
    options.modelLatencyMs = toIntegerList(raw["model-latency-ms"], "--model-latency-ms");
  if (raw.pages !== undefined) options.pages = toPositiveInteger(raw.pages, "--pages");
  if (raw.planner !== undefined) {
    if (!PLANNER_MODES.has(raw.planner)) throw new Error(`--planner must be deterministic or llm.`);
    options.planner = raw.planner;
  }
  if (raw["request-timeout-ms"] !== undefined)
    options.requestTimeoutMs = toPositiveInteger(raw["request-timeout-ms"], "--request-timeout-ms");
  if (raw.requests !== undefined) options.requests = toPositiveInteger(raw.requests, "--requests");
  if (raw.warmup !== undefined) options.warmup = toPositiveInteger(raw.warmup, "--warmup", { allowZero: true });
  if (raw.instances !== undefined) options.instances = toPositiveInteger(raw.instances, "--instances");

  if (raw.scenario !== undefined) {
    if (!SCENARIOS.has(raw.scenario)) throw new Error("--scenario must be chat or ingest.");
    options.scenario = raw.scenario;
  }
  if (options.scenario !== "ingest") {
    const misplaced = INGEST_ONLY_FLAGS.filter((name) => raw[name] !== undefined);
    if (misplaced.length > 0) {
      throw new Error(`${misplaced.map((name) => `--${name}`).join(", ")} only apply to --scenario ingest.`);
    }
  } else {
    if (raw["ingest-mode"] !== undefined) {
      if (!INGEST_MODES.has(raw["ingest-mode"])) throw new Error("--ingest-mode must be sync or async.");
      options.ingestMode = raw["ingest-mode"];
    }
    if (raw["ingest-workers"] !== undefined)
      options.ingestWorkers = toPositiveInteger(raw["ingest-workers"], "--ingest-workers", { allowZero: true });
    if (raw["ingest-worker-concurrency"] !== undefined)
      options.ingestWorkerConcurrency = toPositiveInteger(
        raw["ingest-worker-concurrency"],
        "--ingest-worker-concurrency"
      );
    if (raw["ingest-pages"] !== undefined) options.ingestPages = toPositiveInteger(raw["ingest-pages"], "--ingest-pages");
    if (raw.uploads !== undefined) options.uploads = toPositiveInteger(raw.uploads, "--uploads");
    if (raw["upload-concurrency"] !== undefined) {
      options.uploadConcurrency = toIntegerList(raw["upload-concurrency"], "--upload-concurrency");
      if (options.uploadConcurrency.includes(0)) throw new Error("--upload-concurrency levels must be at least 1.");
    }
    if (raw["chat-concurrency"] !== undefined)
      options.chatConcurrency = toPositiveInteger(raw["chat-concurrency"], "--chat-concurrency", { allowZero: true });
    if (raw["poll-interval-ms"] !== undefined)
      options.pollIntervalMs = toPositiveInteger(raw["poll-interval-ms"], "--poll-interval-ms");
    if (raw["searchable-timeout-ms"] !== undefined)
      options.searchableTimeoutMs = toPositiveInteger(raw["searchable-timeout-ms"], "--searchable-timeout-ms");
    if (raw["embedding-latency-ms"] === undefined) options.embeddingLatencyMs = DEFAULT_INGEST_EMBEDDING_LATENCY_MS;
    if (!raw["latest-name"]) options.latestName = DEFAULT_INGEST_LATEST_NAME;
    if (options.ingestWorkers > 0 && options.ingestMode !== "async") {
      throw new Error("--ingest-workers needs --ingest-mode async: sync uploads are ingested by the API process itself.");
    }
    if (options.ingestWorkerConcurrency !== null && options.ingestMode !== "async") {
      throw new Error("--ingest-worker-concurrency needs --ingest-mode async.");
    }
  }

  if (raw["redis-url"] !== undefined) options.redisUrl = String(raw["redis-url"]).trim();
  if (raw["shared-state"] !== undefined) {
    if (!SHARED_STATE_MODES.has(raw["shared-state"])) throw new Error("--shared-state must be memory or redis.");
    options.sharedState = raw["shared-state"];
  } else if (options.redisUrl) {
    options.sharedState = "redis";
  }
  if (options.sharedState === "redis" && !options.redisUrl) {
    throw new Error(
      "--shared-state redis needs --redis-url pointing at a disposable Redis (scripts/run-load-test-pgvector.sh --with-redis starts one)."
    );
  }
  if (options.sharedState === "memory" && options.redisUrl) {
    throw new Error("--redis-url only applies with --shared-state redis.");
  }

  // Several instances only make sense over one shared store: standalone
  // instances each keep their own registry and vector index on local disk, and
  // their in-memory ingest queues are invisible to each other.
  const multiProcess = options.instances > 1 || options.ingestWorkers > 0;
  const storage = raw.storage
    ? String(raw.storage)
        .split(",")
        .map((mode) => mode.trim())
        .filter(Boolean)
    : multiProcess
      ? ["pgvector"]
      : options.databaseUrl
        ? ["pgvector", "local"]
        : ["local"];

  for (const mode of storage) {
    if (!STORAGE_MODES.has(mode)) throw new Error(`--storage accepts local and pgvector, got "${mode}".`);
  }
  if (storage.includes("pgvector") && !options.databaseUrl) {
    throw new Error(
      `${raw.storage ? "--storage pgvector" : multiProcess ? "--instances > 1 and --ingest-workers" : "--storage pgvector"} needs --database-url pointing at a disposable pgvector PostgreSQL (scripts/run-load-test-pgvector.sh creates one).`
    );
  }
  if (multiProcess && storage.includes("local")) {
    throw new Error(
      "--instances > 1 and --ingest-workers need --storage pgvector: standalone (local) processes share no document registry, vector index or ingest queue."
    );
  }

  options.storage = [...new Set(storage)];
  options.serve = Boolean(raw.serve);
  options.serveWorker = Boolean(raw["serve-worker"]);

  return options;
};

// ---------------------------------------------------------------------------
// Statistics

/**
 * Nearest-rank percentile: sort ascending and take the value at 1-based rank
 * ceil(p/100 * n); p = 0 gives the minimum. Returns null for no samples.
 */
export const percentile = (values, p) => {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile expects p in [0, 100], got ${p}.`);
  }

  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);

  if (sorted.length === 0) return null;

  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));

  return sorted[Math.min(sorted.length, rank) - 1];
};

/** count/min/mean/p50/p95/p99/max of latencies in ms, one decimal. */
export const summarizeLatencies = (latencies = []) => {
  const values = latencies.filter(Number.isFinite);

  if (values.length === 0) {
    return { count: 0, max: null, mean: null, min: null, p50: null, p95: null, p99: null };
  }

  return {
    count: values.length,
    max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    min: round(Math.min(...values)),
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
  };
};

export const EVENT_LOOP_SAMPLING_MS = 10;

/**
 * monitorEventLoopDelay records the whole interval between its timer's
 * callbacks, sampling interval included: an idle loop sampled every 10 ms
 * reports about 10 ms. The report keeps only the excess over the interval
 * (never below 0), in ms with one decimal.
 */
export const eventLoopExcessDelayMs = (recordedNs, samplingMs = EVENT_LOOP_SAMPLING_MS) =>
  Number.isFinite(recordedNs) ? round(Math.max(0, recordedNs / 1e6 - samplingMs)) : null;

const isSuccess = (result) => Number.isInteger(result?.status) && result.status >= 200 && result.status < 300;

/**
 * Summarizes one measured level: results are { status, latencyMs, error?,
 * agentMode?, grounded? } per request; wallMs is the level's wall time.
 */
export const summarizeLevel = ({ results = [], wallMs = 0 } = {}) => {
  const completed = results.filter(Boolean);
  const ok = completed.filter(isSuccess);
  const statusCounts = {};
  const errorCounts = {};

  for (const result of completed) {
    const key = result.status ? String(result.status) : "no_response";
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;

    if (!isSuccess(result)) {
      const reason = result.error ?? `http_${result.status}`;
      errorCounts[reason] = (errorCounts[reason] ?? 0) + 1;
    }
  }

  const agentModes = {};
  for (const result of ok) {
    if (result.agentMode) agentModes[result.agentMode] = (agentModes[result.agentMode] ?? 0) + 1;
  }
  const withGrounding = ok.filter((result) => typeof result.grounded === "boolean");
  const seconds = wallMs > 0 ? wallMs / 1000 : null;

  return {
    requests: completed.length,
    ok: ok.length,
    errors: completed.length - ok.length,
    errorRate: completed.length > 0 ? round((completed.length - ok.length) / completed.length, 4) : null,
    throughputRps: seconds ? round(completed.length / seconds, 2) : null,
    goodputRps: seconds ? round(ok.length / seconds, 2) : null,
    wallMs: round(wallMs),
    latencyMs: summarizeLatencies(ok.map((result) => result.latencyMs)),
    statusCounts,
    errorCounts,
    ...(Object.keys(agentModes).length > 0 ? { agentModes } : {}),
    ...(withGrounding.length > 0
      ? { groundedAnswers: withGrounding.filter((result) => result.grounded).length }
      : {}),
  };
};

/**
 * Closed-loop driver: `concurrency` workers each send their next request as
 * soon as the previous one settles, until `requests` have been sent. `send`
 * receives { index, workerIndex } and resolves to a result object; a thrown
 * error becomes { status: 0, error }. Latency is measured around `send`.
 */
export const runClosedLoop = async ({ concurrency, requests, send, now = () => performance.now() }) => {
  const results = new Array(requests);
  let nextIndex = 0;
  const startedAt = now();

  const worker = async (workerIndex) => {
    while (nextIndex < requests) {
      const index = nextIndex;
      nextIndex += 1;
      const requestStartedAt = now();
      let outcome;

      try {
        outcome = await send({ index, workerIndex });
      } catch (error) {
        outcome = { error: String(error?.code ?? error?.message ?? error), status: 0 };
      }

      results[index] = { ...outcome, latencyMs: now() - requestStartedAt };
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, requests)) }, (_, workerIndex) => worker(workerIndex))
  );

  return { results, wallMs: now() - startedAt };
};

/**
 * Closed loop without a request count: `concurrency` workers keep sending
 * until `shouldStop()` returns true, checked before each request; requests
 * already in flight finish and are kept. Used for the background /chat load
 * of the ingest scenario, which lasts exactly as long as the ingest window.
 */
export const runClosedLoopUntil = async ({ concurrency, send, shouldStop, now = () => performance.now() }) => {
  const results = [];
  const startedAt = now();

  const worker = async (workerIndex) => {
    while (!shouldStop()) {
      const index = results.length;
      results.push(null);
      const requestStartedAt = now();
      let outcome;

      try {
        outcome = await send({ index, workerIndex });
      } catch (error) {
        outcome = { error: String(error?.code ?? error?.message ?? error), status: 0 };
      }

      results[index] = { ...outcome, latencyMs: now() - requestStartedAt };
    }
  };

  await Promise.all(Array.from({ length: Math.max(0, concurrency) }, (_, workerIndex) => worker(workerIndex)));

  return { results, wallMs: now() - startedAt };
};

/**
 * Client-side load balancing: request `index` goes to instance index mod
 * `count`, so every instance gets the same share of each level (to within
 * one request) whatever the concurrency.
 */
export const roundRobinIndex = (index, count) => {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`roundRobinIndex needs count >= 1, got ${count}.`);
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`roundRobinIndex needs index >= 0, got ${index}.`);

  return index % count;
};

/** Requests and errors per instance, from results tagged with `instance`. */
export const countByInstance = (results = [], count = 1) => {
  const counts = Array.from({ length: count }, () => ({ errors: 0, requests: 0 }));

  for (const result of results) {
    const entry = Number.isInteger(result?.instance) ? counts[result.instance] : null;
    if (!entry) continue;
    entry.requests += 1;
    if (!isSuccess(result)) entry.errors += 1;
  }

  return counts;
};

/**
 * Sums CPU and memory over the app processes of one level and keeps the worst
 * event-loop delay; with one process the fields equal that process's own.
 * `units` (requests or documents) turns total CPU into a per-unit cost.
 */
export const combineServerStats = (statsList = [], units = 0) => {
  const sum = (name) => round(statsList.reduce((total, stats) => total + (stats?.[name] ?? 0), 0));
  const worst = (name) => {
    const values = statsList.map((stats) => stats?.[name]).filter(Number.isFinite);
    return values.length > 0 ? Math.max(...values) : null;
  };
  const cpuUserMs = sum("cpuUserMs");
  const cpuSystemMs = sum("cpuSystemMs");

  return {
    cpuSystemMs,
    cpuUserMs,
    eventLoopDelayMaxMs: worst("eventLoopDelayMaxMs"),
    eventLoopDelayP99Ms: worst("eventLoopDelayP99Ms"),
    rssMb: sum("rssMb"),
    cpuMsPerUnit: units > 0 ? round((cpuUserMs + cpuSystemMs) / units, 2) : null,
  };
};

/**
 * Summarizes one ingest level. Each upload result is { instance, status,
 * acceptedMs, ingestedMs?, searchableMs?, listedOnOtherInstance?, error? }:
 * acceptedMs is the upload request itself (201 in sync mode, 202 in async
 * mode). In sync mode the 201 is also ingestedMs and searchableMs. In async
 * mode ingestedMs runs from the upload's start to the first poll that saw the
 * job succeed, and searchableMs to the first GET /documents on the checking
 * instance (another one when there are several) that listed the document.
 * listedOnOtherInstance is what another instance's GET /documents showed:
 * one look right after a sync 201, the polled result in async mode.
 * Throughput is searchable documents per second of the window, which ends
 * when the last document settled.
 */
export const summarizeIngestLevel = ({ results = [], wallMs = 0 } = {}) => {
  const completed = results.filter(Boolean);
  const accepted = completed.filter(isSuccess);
  const searchable = completed.filter((result) => Number.isFinite(result.searchableMs));
  const statusCounts = {};
  const errorCounts = {};

  for (const result of completed) {
    const key = result.status ? String(result.status) : "no_response";
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;

    if (!Number.isFinite(result.searchableMs)) {
      const reason = result.error ?? (isSuccess(result) ? "not_searchable" : `http_${result.status}`);
      errorCounts[reason] = (errorCounts[reason] ?? 0) + 1;
    }
  }

  const seconds = wallMs > 0 ? wallMs / 1000 : null;
  const crossChecked = completed.filter((result) => typeof result.listedOnOtherInstance === "boolean");

  return {
    uploads: completed.length,
    accepted: accepted.length,
    searchable: searchable.length,
    ...(crossChecked.length > 0
      ? {
          crossInstanceChecks: crossChecked.length,
          listedOnOtherInstance: crossChecked.filter((result) => result.listedOnOtherInstance).length,
        }
      : {}),
    errors: completed.length - searchable.length,
    errorRate: completed.length > 0 ? round((completed.length - searchable.length) / completed.length, 4) : null,
    throughputDocsPerSecond: seconds ? round(searchable.length / seconds, 2) : null,
    wallMs: round(wallMs),
    uploadLatencyMs: summarizeLatencies(accepted.map((result) => result.acceptedMs)),
    ingestedMs: summarizeLatencies(searchable.map((result) => result.ingestedMs)),
    searchableMs: summarizeLatencies(searchable.map((result) => result.searchableMs)),
    statusCounts,
    errorCounts,
  };
};

// ---------------------------------------------------------------------------
// Synthetic corpus and fake model

const PROJECT_NAMES = Object.freeze([
  "Aster", "Birch", "Cedar", "Dahlia", "Elm", "Fennel", "Garnet", "Hazel", "Iris", "Juniper",
  "Kestrel", "Linden", "Maple", "Nettle", "Onyx", "Poplar", "Quartz", "Rowan", "Sorrel", "Tamarack",
]);
const TEAMS = Object.freeze(["Northwind", "Harbor", "Summit", "Meridian", "Lakeside", "Beacon", "Granite"]);
const REGIONS = Object.freeze(["eu-west", "us-east", "ap-south", "sa-east", "ca-central"]);
const FILLER = Object.freeze([
  "Change requests are reviewed weekly by the steering group before release.",
  "Operational metrics are exported nightly to the shared reporting warehouse.",
  "Access to production systems requires an approved ticket and a second reviewer.",
  "Incident reviews are written within five business days of resolution.",
  "Vendors must renew their security questionnaires every twelve months.",
  "The runbook lists escalation contacts for every on-call rotation.",
  "Capacity plans are revisited at the start of each fiscal quarter.",
  "Archived records are stored in encrypted object storage with versioning enabled.",
]);

const projectName = (index) =>
  index < PROJECT_NAMES.length
    ? PROJECT_NAMES[index]
    : `${PROJECT_NAMES[index % PROJECT_NAMES.length]}${Math.floor(index / PROJECT_NAMES.length) + 1}`;

// One fact per page; the question is answerable from that page alone.
const PAGE_FACTS = Object.freeze([
  (name, index) => ({
    fact: `The retention period for Project ${name} records is ${30 + ((index * 7) % 60)} days.`,
    question: `What is the retention period for Project ${name} records?`,
  }),
  (name, index) => ({
    fact: `The budget owner of Project ${name} is the ${TEAMS[index % TEAMS.length]} operations team.`,
    question: `Who is the budget owner of Project ${name}?`,
  }),
  (name, index) => ({
    fact: `Project ${name} stores customer data in the ${REGIONS[index % REGIONS.length]} region.`,
    question: `Which region stores customer data for Project ${name}?`,
  }),
  (name, index) => ({
    fact: `The launch review for Project ${name} is scheduled for week ${10 + (index % 40)} of the year.`,
    question: `When is the launch review for Project ${name} scheduled?`,
  }),
]);

/**
 * Deterministic corpus: `documents` documents of `pages` pages, each page one
 * answerable fact plus filler text, and one question per page.
 */
export const buildSyntheticCorpus = ({ documents = 20, pages = 4, docIdPrefix = "load-doc" } = {}) => {
  const docs = [];
  const questions = [];

  for (let docIndex = 0; docIndex < documents; docIndex += 1) {
    const name = projectName(docIndex);
    const docId = `${docIdPrefix}-${String(docIndex + 1).padStart(3, "0")}`;
    const docPages = [];

    for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
      const { fact, question } = PAGE_FACTS[pageIndex % PAGE_FACTS.length](name, docIndex + pageIndex);
      const filler = Array.from(
        { length: 10 },
        (_, sentence) => FILLER[(docIndex + pageIndex + sentence) % FILLER.length]
      );
      docPages.push({
        pageNumber: pageIndex + 1,
        text: [`Project ${name} handbook, section ${pageIndex + 1}.`, fact, ...filler].join(" "),
      });
      questions.push({ docId, question });
    }

    docs.push({ docId, fileName: `project-${name.toLowerCase()}-handbook.pdf`, pages: docPages });
  }

  return { documents: docs, questions };
};

// FNV-1a, so a token always lands in the same bucket.
const hashToken = (token) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

/**
 * Deterministic hashed term-frequency embedding, L2-normalized: shared words
 * give related texts a positive cosine, so retrieval is meaningful without a
 * model. Plumbing only; it says nothing about embedding quality.
 */
export const hashEmbedding = (text, dimensions) => {
  const vector = new Array(dimensions).fill(0);
  const tokens = String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

  for (const token of tokens) {
    const hash = hashToken(token);
    vector[hash % dimensions] += hash & 0x80000000 ? -1 : 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }

  return vector.map((value) => value / norm);
};

const messageText = (message) =>
  typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part) => part?.text ?? "").join("\n")
      : "";

/**
 * The fake model's reply: the first sentence of the prompt's Source 1 evidence
 * cited as [Source 1], i.e. a short grounded answer the claim check accepts.
 * Without a Source 1 block (planner prompts and the like) it returns a fixed
 * sentence, or "{}" when the request asked for JSON.
 */
export const buildFakeChatAnswer = ({ messages = [], response_format: responseFormat } = {}) => {
  const prompt = messages.map(messageText).join("\n\n");
  const match = prompt.match(/(?:^|\n)Source 1\n(?:[^\n]*\n)*?Evidence:\n([\s\S]*?)(?=\n\s*\nSource \d+\n|\n\s*\n|$)/);

  if (match) {
    const evidence = match[1].replace(/\s+/g, " ").trim();
    const sentences = evidence.match(/[^.!?]+[.!?]/g) ?? [evidence];
    // Skip a heading-like first sentence ("Project X handbook, section 1.").
    const sentence =
      sentences.find((candidate) => !/handbook, section \d+\.$/i.test(candidate.trim())) ?? sentences[0];

    return `${sentence.trim().slice(0, 400)} [Source 1]`;
  }

  if (responseFormat && responseFormat.type && responseFormat.type !== "text") {
    return "{}";
  }

  return "The provided documents do not contain enough information to answer.";
};

/**
 * A zero-latency fake replies in the same tick it reads the request body, so
 * its in-flight count cannot exceed 1 however many requests the app has open:
 * that peak is not an observation and is reported as null.
 */
export const observedPeakInFlight = ({ latencyMs, peak }) =>
  Number.isFinite(latencyMs) && latencyMs > 0 ? peak : null;

/**
 * Local OpenAI-compatible server: /v1/embeddings and /v1/chat/completions with
 * artificial latency, counting requests and the peak in flight per kind.
 */
export const startFakeModelServer = async ({
  chatLatencyMs = 0,
  dimensions = DEFAULT_LOAD_TEST_OPTIONS.embeddingDimensions,
  embeddingLatencyMs = 0,
} = {}) => {
  const latency = { chat: chatLatencyMs, embeddings: embeddingLatencyMs };
  const freshStats = () => ({
    chat: { inFlight: 0, peakInFlight: 0, requests: 0 },
    embeddings: { inFlight: 0, inputs: 0, peakInFlight: 0, requests: 0 },
    other: { requests: 0 },
  });
  let stats = freshStats();

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = request.url ?? "";
      const kind = url.endsWith("/embeddings") ? "embeddings" : url.endsWith("/chat/completions") ? "chat" : null;
      const send = (status, json) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };

      if (!kind) {
        stats.other.requests += 1;
        send(url.endsWith("/models") ? 200 : 404, url.endsWith("/models") ? { data: [], object: "list" } : {
          error: { message: `No fake route for ${url}` },
        });
        return;
      }

      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        send(400, { error: { message: "Invalid JSON." } });
        return;
      }

      const bucket = stats[kind];
      bucket.requests += 1;
      bucket.inFlight += 1;
      bucket.peakInFlight = Math.max(bucket.peakInFlight, bucket.inFlight);
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          bucket.inFlight -= 1;
        }
      };
      response.on("close", settle);

      const reply = () => {
        settle();
        if (kind === "embeddings") {
          const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];
          bucket.inputs += inputs.length;
          send(200, {
            data: inputs.map((input, index) => ({
              embedding: hashEmbedding(input, dimensions),
              index,
              object: "embedding",
            })),
            model: payload.model,
            object: "list",
            usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
          });
          return;
        }

        send(200, {
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              message: { content: buildFakeChatAnswer(payload), role: "assistant" },
            },
          ],
          id: `load-test-${stats.chat.requests}`,
          model: payload.model,
          object: "chat.completion",
          usage: { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 },
        });
      };

      const delay = latency[kind];
      if (delay > 0) setTimeout(reply, delay);
      else reply();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    resetStats: () => {
      const inFlight = { chat: stats.chat.inFlight, embeddings: stats.embeddings.inFlight };
      stats = freshStats();
      stats.chat.inFlight = inFlight.chat;
      stats.embeddings.inFlight = inFlight.embeddings;
    },
    setLatency: ({ chatMs, embeddingMs } = {}) => {
      if (Number.isFinite(chatMs)) latency.chat = chatMs;
      if (Number.isFinite(embeddingMs)) latency.embeddings = embeddingMs;
    },
    snapshot: () => ({
      chat: { peakInFlight: stats.chat.peakInFlight, requests: stats.chat.requests },
      embeddings: {
        inputs: stats.embeddings.inputs,
        peakInFlight: stats.embeddings.peakInFlight,
        requests: stats.embeddings.requests,
      },
      other: { requests: stats.other.requests },
    }),
  };
};

// ---------------------------------------------------------------------------
// App environment and child process

/**
 * Refuses a --database-url the app has already run against. The pgvector run
 * writes documents, chunks, sessions, agent runs and long-term memory and never
 * deletes them, and createApp() migrates the database and runs startup recovery
 * on the agent runs it finds, so it must only ever see a fresh database (the
 * one scripts/run-load-test-pgvector.sh creates). Every app start creates the
 * schema_migrations ledger, so its presence marks a database in use. `query`
 * is queryPostgres (or a stand-in) and runs before the app is imported.
 */
export const assertFreshLoadTestDatabase = async (query) => {
  const result = await query("SELECT to_regclass('schema_migrations') AS ledger");

  if (result?.rows?.[0]?.ledger) {
    throw new Error(
      "Refusing --database-url: it already holds the app's schema_migrations table, so it is not a disposable database. " +
        "The load test writes into it and never cleans up; use scripts/run-load-test-pgvector.sh, which creates and deletes a throwaway cluster."
    );
  }
};

/**
 * Environment for the app child. Every database, model and store setting the
 * app reads is set explicitly, so nothing is inherited from a developer's .env
 * or shell (this script never loads dotenv).
 */
export const buildAppEnvironment = ({
  baseEnvironment = process.env,
  databaseUrl = "",
  modelBaseUrl,
  options,
  storage,
  tempRoot,
  authToken = "",
  role = "api",
  runId = "",
}) => {
  const environment = { ...baseEnvironment };

  // Anything that could point the app at another database, model or cache.
  for (const name of Object.keys(environment)) {
    if (
      /^(OPENAI_|POSTGRES_|LONG_MEMORY_|PGVECTOR_|QDRANT_|REDIS_|RAG_|AGENT_|API_AUTH|RATE_LIMIT|OTEL_|DOCCOMPARE_|VECTOR_STORE_|DOCUMENT_STORE_|SESSION_MEMORY_STORE_|TASK_STORE_|WORKSPACE_ARTIFACT_STORE_|ADMIN_AUDIT_STORE_|AGENT_RUN_STORE_|UPLOADS_DIRECTORY|FRONTEND_BUILD_DIRECTORY|ALLOWED_ORIGINS|SERPAPI_|PG|DOTENV_|PDF_PARSER|DOCLING_)/.test(
        name
      )
    ) {
      delete environment[name];
    }
  }

  Object.assign(environment, {
    NODE_ENV: "production",
    OPENAI_API_KEY: "load-test",
    OPENAI_BASE_URL: modelBaseUrl,
    OPENAI_CHAT_MODEL: FAKE_CHAT_MODEL,
    OPENAI_EMBEDDING_MODEL: FAKE_EMBEDDING_MODEL,
    RAG_EMBEDDING_DIMENSIONS: String(options.embeddingDimensions),
    RAG_LLM_MAX_CONCURRENCY: String(options.llmMaxConcurrency),
    RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
    UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
    RAG_OBSERVABILITY_ENABLED: "false",
    RAG_CLAIM_JUDGE: "off",
    RAG_EMBEDDING_CACHE_ENABLED: options.embeddingCache ? "true" : "false",
    STARTUP_HEALTH_STRICT: "false",
    API_AUTH_ENABLED: options.auth ? "true" : "false",
    RATE_LIMIT_ENABLED: options.rateLimit ? "true" : "false",
    AGENT_PLANNER_ROLLOUT: options.planner === "llm" ? "llm" : "deterministic",
    AGENT_INTENT_PLANNER: options.planner,
    AGENT_EXECUTION_PLANNER: options.planner,
    LOAD_TEST_STORAGE: storage,
    LOAD_TEST_TEMP_ROOT: tempRoot,
    LOAD_TEST_ROLE: role,
    // The dedicated ingest worker entry loads dotenv like server.js does; an
    // empty file keeps a developer's server/.env from refilling what was
    // cleared above.
    DOTENV_CONFIG_PATH: path.join(tempRoot, "empty.env"),
    DOTENV_CONFIG_QUIET: "true",
    PDF_PARSER: "pdfjs",
    RAG_INGEST_MODE: options.ingestMode ?? "sync",
    RAG_SHARED_STATE: options.sharedState === "redis" ? "redis" : "memory",
  });

  if (options.auth) environment.API_AUTH_TOKEN = authToken;

  if (options.sharedState === "redis") {
    // A prefix of its own per run: the instances share their model call guard
    // with each other and with nothing else on that Redis.
    environment.REDIS_URL = options.redisUrl;
    environment.RAG_SHARED_STATE_PREFIX = `archive_rag_load_test:${runId || "run"}:`;
  }

  // Dedicated worker processes take every job, so the API processes stop
  // running their own worker loop; otherwise the app default (a loop in every
  // API process) stays.
  if (role === "worker") {
    environment.RAG_INGEST_WORKER_ENABLED = "true";
  } else if ((options.ingestWorkers ?? 0) > 0) {
    environment.RAG_INGEST_WORKER_ENABLED = "false";
  }
  if (Number.isInteger(options.ingestWorkerConcurrency)) {
    environment.RAG_INGEST_WORKER_CONCURRENCY = String(options.ingestWorkerConcurrency);
  }

  if (storage === "pgvector") {
    Object.assign(environment, {
      LONG_MEMORY_DATABASE_URL: databaseUrl,
      POSTGRES_DATABASE_URL: databaseUrl,
      VECTOR_STORE_PROVIDER: "pgvector",
    });
  } else {
    environment.DOCCOMPARE_STANDALONE = "1";
  }

  return environment;
};

const startAppProcess = async ({ environment, role = "api", verbose }) => {
  const child = fork(__filename, [role === "worker" ? "--serve-worker" : "--serve"], {
    cwd: serverDirectory,
    env: environment,
    execArgv: [],
    stdio: verbose ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "pipe", "pipe", "ipc"],
  });
  const logTail = [];
  const keepTail = (chunk) => {
    logTail.push(...String(chunk).split("\n").filter(Boolean));
    logTail.splice(0, Math.max(0, logTail.length - 40));
  };
  child.stdout?.on("data", keepTail);
  child.stderr?.on("data", keepTail);

  const pending = new Map();
  let exited = false;
  child.on("message", (message) => {
    const waiter = pending.get(message?.type);
    if (waiter) {
      pending.delete(message.type);
      waiter.resolve(message);
    } else if (message?.type === "error") {
      for (const entry of pending.values()) entry.reject(new Error(message.message));
      pending.clear();
    }
  });
  child.on("exit", (code) => {
    exited = true;
    for (const entry of pending.values()) {
      entry.reject(new Error(`App process exited with code ${code}.\n${logTail.join("\n")}`));
    }
    pending.clear();
  });

  const request = (message, replyType, timeoutMs = 600000) =>
    new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error(`App process is not running.\n${logTail.join("\n")}`));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(replyType);
        reject(new Error(`App process did not answer "${message.type}" within ${timeoutMs} ms.\n${logTail.join("\n")}`));
      }, timeoutMs);
      pending.set(replyType, {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      child.send(message);
    });

  return {
    logTail,
    start: (documents, { primary = true } = {}) => request({ documents, primary, type: "start" }, "ready"),
    stats: () => request({ type: "stats" }, "stats", 30000),
    stop: async () => {
      if (exited) return;
      const exitPromise = new Promise((resolve) => child.once("exit", resolve));
      child.send({ type: "shutdown" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      await exitPromise;
      clearTimeout(timer);
    },
  };
};

export const INGEST_WORKER_ENTRY = path.join(serverDirectory, "ingest-worker.mjs");

/**
 * The ingest worker loop an API process runs next to the app in async mode
 * unless RAG_INGEST_WORKER_ENABLED=false, built from the app's own services
 * exactly as server.js builds it. Sync mode never loads the worker module.
 */
const startInProcessIngestWorker = async (app) => {
  if (process.env.RAG_INGEST_MODE !== "async") return null;

  const { getVectorStoreProviderConfigStatus, isRagIngestWorkerEnabled } = await import(
    "../rag/config.js"
  );
  const { createIngestWorker, resolveApiIngestWorkerPlan } = await import(
    "../rag/ingest-worker.js"
  );
  const plan = resolveApiIngestWorkerPlan({
    storeBackend: app.locals.services.ingestJobStore?.backend,
    vectorStoreProvider: getVectorStoreProviderConfigStatus().provider,
    workerEnabled: isRagIngestWorkerEnabled(),
  });
  if (!plan.start) return null;

  const worker = createIngestWorker({
    ragService: app.locals.services.ragService,
    store: app.locals.services.ingestJobStore,
    tempDirectory: app.locals.services.uploadsDirectory,
  });
  worker.start();

  return worker;
};

// Child side, shared by both roles: CPU, event-loop and memory since the last
// stats message, and an exit on shutdown.
const handleChildMessages = (onStart) => {
  const loopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_SAMPLING_MS });
  let cpuMark = process.cpuUsage();
  let stop = null;

  const fail = (error) => {
    process.send?.({ message: String(error?.stack ?? error), type: "error" });
    process.exit(1);
  };

  process.on("message", async (message) => {
    try {
      if (message?.type === "start") {
        const { reply, shutdown } = await onStart(message);
        stop = shutdown;
        loopDelay.enable();
        cpuMark = process.cpuUsage();
        process.send({ ...reply, type: "ready" });
      } else if (message?.type === "stats") {
        const cpu = process.cpuUsage(cpuMark);
        cpuMark = process.cpuUsage();
        const reply = {
          cpuSystemMs: round(cpu.system / 1000),
          cpuUserMs: round(cpu.user / 1000),
          eventLoopDelayMaxMs: eventLoopExcessDelayMs(loopDelay.max),
          eventLoopDelayP99Ms: eventLoopExcessDelayMs(loopDelay.percentile(99)),
          rssMb: round(process.memoryUsage().rss / 1024 / 1024),
          type: "stats",
        };
        loopDelay.reset();
        process.send(reply);
      } else if (message?.type === "shutdown") {
        await Promise.race([
          Promise.resolve(stop?.()).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        process.exit(0);
      }
    } catch (error) {
      fail(error);
    }
  });
  process.on("disconnect", () => process.exit(0));
};

// API instance: build the app like server.js, ingest the seed corpus (primary
// instance only), start the in-process ingest worker when async ingestion
// wants one, listen.
const serve = async () => {
  const tempRoot = process.env.LOAD_TEST_TEMP_ROOT;
  const storage = process.env.LOAD_TEST_STORAGE;

  handleChildMessages(async (message) => {
    let server = null;

    if (storage === "local") {
      const { applyStandaloneProfile } = await import("../standalone-profile.js");
      applyStandaloneProfile();
    } else if (message.primary) {
      // Only the first instance can see a fresh database: it migrates it, and
      // the others start against the schema it created.
      const { queryPostgres } = await import("../rag/postgres.js");
      await assertFreshLoadTestDatabase(queryPostgres);
    }

    const { createApp } = await import("../app.js");
    const rag = await import("../chat.js");
    const app = await createApp({
      uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
      uploadsDirectory: path.join(tempRoot, "uploads"),
    });
    const sourceDirectory = path.join(tempRoot, "sources");
    await mkdir(sourceDirectory, { recursive: true });

    const ingestStartedAt = performance.now();
    let chunkCount = 0;
    for (const doc of message.documents) {
      const filePath = path.join(sourceDirectory, `${doc.docId}.txt`);
      await writeFile(filePath, doc.pages.map((page) => page.text).join("\n\n"), "utf8");
      const registered = await rag.ingestDocumentPages({
        docId: doc.docId,
        fileName: doc.fileName,
        filePath,
        pages: doc.pages,
      });
      chunkCount += Number(registered?.chunkCount ?? 0);
    }
    const ingestMs = performance.now() - ingestStartedAt;
    const { describeVectorStoreRuntime } = await import("../rag/vector-store.js");
    let databaseChunkRows = null;
    if (storage === "pgvector" && message.primary) {
      // Proof the chunks are in PostgreSQL, not a config claim. Counted as
      // the owner role, like the startup loads.
      const { queryPostgres } = await import("../rag/postgres.js");
      const { getDocumentChunksPostgresTable } = await import("../rag/config.js");
      const { runAsDatabaseSystem } = await import("../rag/postgres-tenant.js");
      const result = await runAsDatabaseSystem(() =>
        queryPostgres(`SELECT count(*)::int AS rows FROM ${getDocumentChunksPostgresTable()}`)
      );
      databaseChunkRows = result.rows[0]?.rows ?? null;
    }

    const worker = await startInProcessIngestWorker(app);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
      reply: {
        chunkCount,
        databaseChunkRows,
        documentCount: message.documents.length,
        ingestMs: round(ingestMs),
        ingestWorker: Boolean(worker),
        pid: process.pid,
        port: server.address().port,
        vectorStore: describeVectorStoreRuntime(),
      },
      shutdown: async () => {
        server?.closeAllConnections?.();
        server?.close();
        await worker?.stop?.();
      },
    };
  });
};

// Dedicated ingest worker: runs the real entry's runIngestWorkerProcess()
// (server/ingest-worker.mjs, what `npm run worker:ingest` starts) inside this
// process, so the parent can read its CPU like an API instance's.
const serveWorker = async () => {
  handleChildMessages(async () => {
    const { runIngestWorkerProcess } = await import(pathToFileURL(INGEST_WORKER_ENTRY).href);
    // This process exits by itself once the worker has stopped.
    const started = await runIngestWorkerProcess({ exit: () => {} });

    if (!started) throw new Error("The dedicated ingest worker refused to start (see its log above).");

    return {
      reply: { pid: process.pid, port: null, workerId: started.worker.workerId },
      shutdown: () => started.shutdown("shutdown"),
    };
  });
};

// ---------------------------------------------------------------------------
// Load generation

const sendHttpRequest = ({
  agent,
  baseUrl,
  body = null,
  headers = {},
  method,
  path: requestPath,
  parse,
  rawBody = null,
  timeoutMs,
}) =>
  new Promise((resolve) => {
    const payload = rawBody ?? (body === null ? null : JSON.stringify(body));
    const request = http.request(
      `${baseUrl}${requestPath}`,
      {
        agent,
        headers: {
          ...(payload && !rawBody ? { "content-type": "application/json" } : {}),
          ...headers,
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
        method,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const result = { status: response.statusCode };
          if (parse) {
            try {
              Object.assign(result, parse(JSON.parse(Buffer.concat(chunks).toString("utf8")), response.statusCode));
            } catch {
              result.error = "invalid_json";
              result.status = result.status >= 200 && result.status < 300 ? 0 : result.status;
            }
          }
          resolve(result);
        });
        response.on("error", (error) => resolve({ error: String(error.code ?? error.message), status: 0 }));
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
    request.on("error", (error) => resolve({ error: String(error.code ?? error.message), status: 0 }));
    if (payload) request.write(payload);
    request.end();
  });

/** Pulls the fields the report keeps from a /chat body. */
export const readChatOutcome = (body = {}) => {
  const answer = String(body.agentAnswer ?? body.ragAnswer ?? "");
  const citations = Array.isArray(body.ragSources) ? body.ragSources.length : 0;

  return {
    agentMode: typeof body.agentMode === "string" ? body.agentMode : null,
    grounded: citations > 0 || /\[Source \d+\]/.test(answer),
  };
};

/** multipart/form-data body with one file part, as a browser sends it. */
export const buildMultipartFileBody = ({ boundary, content, contentType = "application/pdf", fieldName = "file", fileName }) =>
  Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      "utf8"
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

const createChatSender = ({ agent, baseUrls, headers, options, questions, sessionTag, offset = 0 }) =>
  ({ index, workerIndex }) => {
    const instance = roundRobinIndex(index, baseUrls.length);
    const question = questions[(offset + index) % questions.length];
    return sendHttpRequest({
      agent,
      baseUrl: baseUrls[instance],
      body: {
        docIds: [question.docId],
        question: question.question,
        sessionId: `${sessionTag}-u${workerIndex}`,
      },
      headers,
      method: "POST",
      parse: (body, status) => (status >= 200 && status < 300 ? readChatOutcome(body) : {}),
      path: "/chat",
      timeoutMs: options.requestTimeoutMs,
    }).then((result) => ({ ...result, instance }));
  };

const runLevel = async ({ baseUrls, concurrency, headers, options, requests, target, sessionTag }) => {
  // One agent for every instance: maxSockets applies per origin.
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const send =
    target.kind === "chat"
      ? createChatSender({ agent, baseUrls, headers, options, offset: target.offset, questions: target.questions, sessionTag })
      : ({ index }) => {
          const instance = roundRobinIndex(index, baseUrls.length);
          return sendHttpRequest({
            agent,
            baseUrl: baseUrls[instance],
            headers,
            method: "GET",
            path: target.path,
            timeoutMs: options.requestTimeoutMs,
          }).then((result) => ({ ...result, instance }));
        };

  try {
    return await runClosedLoop({ concurrency, requests, send });
  } finally {
    agent.destroy();
  }
};

const collectStats = (processes) => Promise.all(processes.map((child) => child.stats()));

/**
 * Per-instance view of one level: port, requests (and uploads for the ingest
 * scenario) the load generator sent there, and that process's own CPU,
 * event-loop delay and memory.
 */
const describeInstances = ({ instances, stats, counts, uploads = null }) =>
  instances.map((instance, index) => {
    const { type: _type, ...fields } = stats[index] ?? {};
    return {
      index,
      port: instance.port,
      requests: counts[index]?.requests ?? 0,
      errors: counts[index]?.errors ?? 0,
      ...(uploads ? { uploads: uploads[index]?.requests ?? 0 } : {}),
      ...fields,
    };
  });

const runScenario = async ({ apps, baseUrls, fakeModel, headers, instances, options, profile, runId, target }) => {
  const levels = [];

  for (const concurrency of options.concurrency) {
    const requests = target.kind === "chat" ? options.requests : options.cheapRequests;
    const sessionTag = `load-${runId}-${target.kind}-${profile ?? "na"}-c${concurrency}`;
    const warmupRequests = options.warmup > 0 ? Math.max(options.warmup, concurrency) : 0;

    if (warmupRequests > 0) {
      await runLevel({ baseUrls, concurrency, headers, options, requests: warmupRequests, sessionTag: `${sessionTag}-warm`, target });
      target.offset += warmupRequests;
    }

    fakeModel.resetStats();
    await collectStats(apps);
    const { results, wallMs } = await runLevel({ baseUrls, concurrency, headers, options, requests, sessionTag, target });
    target.offset += requests;
    const serverStats = await collectStats(apps);
    const model = fakeModel.snapshot();
    const summary = summarizeLevel({ results, wallMs });
    const perRequest = (value) => (summary.requests > 0 ? round(value / summary.requests, 2) : null);
    const { cpuMsPerUnit, ...serverFields } = combineServerStats(serverStats, summary.requests);

    levels.push({
      concurrency,
      warmupRequests,
      ...summary,
      model: {
        chatCompletionsPerRequest: perRequest(model.chat.requests),
        embeddingRequestsPerRequest: perRequest(model.embeddings.requests),
        peakChatInFlight: observedPeakInFlight({
          latencyMs: target.kind === "chat" ? profile : 0,
          peak: model.chat.peakInFlight,
        }),
        peakEmbeddingsInFlight: observedPeakInFlight({
          latencyMs: target.kind === "chat" ? options.embeddingLatencyMs : 0,
          peak: model.embeddings.peakInFlight,
        }),
        ...model,
      },
      server: { ...serverFields, cpuMsPerRequest: cpuMsPerUnit },
      ...(apps.length > 1
        ? { instances: describeInstances({ counts: countByInstance(results, apps.length), instances, stats: serverStats }) }
        : {}),
    });

    const spread =
      apps.length > 1 ? `  per instance ${countByInstance(results, apps.length).map((count) => count.requests).join("/")}` : "";
    console.log(
      `  ${target.label.padEnd(26)} c=${String(concurrency).padStart(3)}  ${String(summary.throughputRps).padStart(8)} req/s  p50 ${summary.latencyMs.p50} ms  p95 ${summary.latencyMs.p95} ms  p99 ${summary.latencyMs.p99} ms  errors ${summary.errors}/${summary.requests}${target.kind === "chat" ? `  peak model in flight ${model.chat.peakInFlight}` : ""}${spread}`
    );
  }

  return {
    endpoint: target.kind === "chat" ? "POST /chat" : `GET ${target.path}`,
    kind: target.kind,
    levels,
    modelLatencyMs: target.kind === "chat" ? profile : null,
    embeddingLatencyMs: target.kind === "chat" ? options.embeddingLatencyMs : null,
  };
};

// ---------------------------------------------------------------------------
// Ingest scenario

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Public job fields only; a failed job's error is a short message by contract.
const readIngestJob = (body = {}) => ({
  attemptCount: Number.isInteger(body.attemptCount) ? body.attemptCount : null,
  jobError: typeof body.error === "string" ? body.error.slice(0, 200) : null,
  jobStatus: typeof body.status === "string" ? body.status : null,
});

/**
 * Polls GET /ingest-jobs/:jobId until the job succeeded or failed, or the
 * deadline passed. A 404 is a failure, not a retry: the job was accepted by
 * this deployment, so every instance must find it.
 */
const waitForIngestJob = async ({ agent, baseUrl, deadline, headers, jobId, options }) => {
  let polls = 0;
  let last = null;

  while (performance.now() < deadline) {
    polls += 1;
    last = await sendHttpRequest({
      agent,
      baseUrl,
      headers,
      method: "GET",
      parse: (body) => readIngestJob(body),
      path: `/ingest-jobs/${encodeURIComponent(jobId)}`,
      timeoutMs: options.requestTimeoutMs,
    });

    if (last.status === 200 && (last.jobStatus === "succeeded" || last.jobStatus === "failed")) {
      return { ...last, polls };
    }
    if (last.status !== 200 && last.status !== 429 && last.status !== 503) {
      return { ...last, jobStatus: null, polls };
    }
    await sleep(options.pollIntervalMs);
  }

  return { ...last, jobStatus: "timeout", polls };
};

/** One GET /documents: does this instance list `docId` right now? */
const isDocumentListed = async ({ agent, baseUrl, docId, headers, options }) => {
  const response = await sendHttpRequest({
    agent,
    baseUrl,
    headers,
    method: "GET",
    parse: (body) => ({ listed: Array.isArray(body) && body.some((document) => document?.docId === docId) }),
    path: "/documents",
    timeoutMs: options.requestTimeoutMs,
  });

  return Boolean(response.listed);
};

/** Polls GET /documents until it lists `docId`; false when the deadline passed. */
const waitForDocumentListed = async ({ agent, baseUrl, deadline, docId, headers, options }) => {
  while (performance.now() < deadline) {
    if (await isDocumentListed({ agent, baseUrl, docId, headers, options })) return true;
    await sleep(options.pollIntervalMs);
  }

  return false;
};

/**
 * The instance that confirms a document is searchable: the next one after
 * the instance that took the upload, so with several instances visibility is
 * proven on a process that did not ingest it.
 */
export const visibilityCheckInstance = (uploadInstance, count) => (count > 1 ? (uploadInstance + 1) % count : uploadInstance);

/**
 * Uploads one PDF and follows it until it is searchable. The upload request
 * resolves the returned promise's `accepted` part as soon as the 201/202
 * arrives, so the uploader's closed loop moves on while the async job is
 * still being tracked in `settled`.
 */
const uploadAndTrack = async ({ agent, baseUrls, document, headers, index, options, startedAt }) => {
  const instance = roundRobinIndex(index, baseUrls.length);
  const boundary = `----archive-load-test-${randomBytes(8).toString("hex")}`;
  const response = await sendHttpRequest({
    agent,
    baseUrl: baseUrls[instance],
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    method: "POST",
    parse: (body, status) =>
      status === 201 || status === 202
        ? { docId: body.docId ?? null, jobId: body.jobId ?? null }
        : { serverError: typeof body.error === "string" ? body.error.slice(0, 200) : null },
    path: "/upload",
    rawBody: buildMultipartFileBody({ boundary, content: document.pdf, fileName: document.fileName }),
    timeoutMs: options.requestTimeoutMs,
  });
  const acceptedMs = performance.now() - startedAt;
  const result = { acceptedMs, docId: response.docId ?? null, instance, status: response.status };

  if (response.error) result.error = response.error;
  if (!isSuccess(response)) {
    if (response.serverError) result.serverError = response.serverError;
    return { accepted: result, settled: Promise.resolve(result) };
  }
  // A mode mismatch means the app is not the one the run describes; the
  // level's numbers would be about the other mode, so the run stops.
  if (options.ingestMode === "async" && response.status === 201) {
    throw Object.assign(
      new Error(
        "The app answered POST /upload with 201 under RAG_INGEST_MODE=async: this checkout does not implement asynchronous ingestion."
      ),
      { fatal: true }
    );
  }
  if (options.ingestMode === "sync" && response.status === 202) {
    throw Object.assign(new Error("The app answered POST /upload with 202 under RAG_INGEST_MODE=sync."), { fatal: true });
  }

  const settled = (async () => {
    const deadline = startedAt + options.searchableTimeoutMs;
    const checkInstance = visibilityCheckInstance(instance, baseUrls.length);

    if (response.status === 201) {
      // Sync: the 201 is the document, registered and indexed by the process
      // that answered. Whether another instance lists it too is one look, not
      // a wait: in sync mode nothing tells the other processes about it.
      result.ingestedMs = acceptedMs;
      result.searchableMs = acceptedMs;
      if (baseUrls.length > 1) {
        result.checkInstance = checkInstance;
        result.listedOnOtherInstance = await isDocumentListed({
          agent,
          baseUrl: baseUrls[checkInstance],
          docId: result.docId,
          headers,
          options,
        });
      }
      return result;
    }

    const job = await waitForIngestJob({ agent, baseUrl: baseUrls[instance], deadline, headers, jobId: response.jobId, options });
    result.jobId = response.jobId;
    result.jobPolls = job.polls;
    result.attemptCount = job.attemptCount;
    if (job.jobStatus !== "succeeded") {
      result.error =
        job.jobStatus === "failed"
          ? "job_failed"
          : job.jobStatus === "timeout"
            ? "job_timeout"
            : job.error ?? `job_http_${job.status}`;
      if (job.jobError) result.jobError = job.jobError;
      return result;
    }

    // Async: the job succeeded somewhere; searchable once an instance other
    // than the one that took the upload lists it.
    result.ingestedMs = performance.now() - startedAt;
    result.checkInstance = checkInstance;
    const listed = await waitForDocumentListed({
      agent,
      baseUrl: baseUrls[checkInstance],
      deadline,
      docId: result.docId,
      headers,
      options,
    });

    if (listed) {
      result.searchableMs = performance.now() - startedAt;
      if (baseUrls.length > 1) result.listedOnOtherInstance = true;
    } else {
      result.error = baseUrls.length > 1 ? "not_listed_on_other_instance" : "not_listed";
      if (baseUrls.length > 1) result.listedOnOtherInstance = false;
    }
    return result;
  })();

  return { accepted: result, settled };
};

const runIngestLevel = async ({ baseUrls, documents, headers, options, questions, sessionTag, uploadConcurrency }) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: uploadConcurrency + options.chatConcurrency + 64 });
  const trackers = [];
  let ingestDone = false;
  let fatalError = null;

  try {
    const chat = runClosedLoopUntil({
      concurrency: options.chatConcurrency,
      send: createChatSender({ agent, baseUrls, headers, options, questions, sessionTag }),
      shouldStop: () => ingestDone,
    });
    const windowStartedAt = performance.now();
    const uploads = await runClosedLoop({
      concurrency: uploadConcurrency,
      requests: documents.length,
      send: async ({ index }) => {
        if (fatalError) return { error: "skipped", status: 0 };
        try {
          const { accepted, settled } = await uploadAndTrack({
            agent,
            baseUrls,
            document: documents[index],
            headers,
            index,
            options,
            startedAt: performance.now(),
          });
          trackers[index] = settled;
          return accepted;
        } catch (error) {
          if (error?.fatal) fatalError = error;
          throw error;
        }
      },
    });
    if (fatalError) throw fatalError;
    // A send that threw left no tracker; its closed-loop result stands in.
    const results = await Promise.all(
      Array.from({ length: documents.length }, (_, index) => trackers[index] ?? uploads.results[index])
    );
    const wallMs = performance.now() - windowStartedAt;
    ingestDone = true;
    const chatDuring = await chat;

    return { chat: chatDuring, results, wallMs };
  } finally {
    ingestDone = true;
    agent.destroy();
  }
};

const runChatWindow = async ({ baseUrls, durationMs, headers, options, questions, sessionTag }) => {
  if (options.chatConcurrency <= 0 || durationMs <= 0) return null;
  const agent = new http.Agent({ keepAlive: true, maxSockets: options.chatConcurrency });
  const startedAt = performance.now();

  try {
    return await runClosedLoopUntil({
      concurrency: options.chatConcurrency,
      send: createChatSender({ agent, baseUrls, headers, options, questions, sessionTag }),
      shouldStop: () => performance.now() - startedAt >= durationMs,
    });
  } finally {
    agent.destroy();
  }
};

/**
 * Discarded warm-up before the first ingest level: every seed question once
 * on every instance (each keeps its own query embedding cache, so the
 * background chat pays the same embedding cost in the ingest window and in
 * its baseline), then one upload per instance followed until searchable
 * (first-use costs such as loading pdf.js). Runs at 0 ms model latency.
 */
const warmUpIngestScenario = async ({ baseUrls, headers, options, questions, runId }) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(1, options.chatConcurrency) + baseUrls.length });

  try {
    if (options.chatConcurrency > 0) {
      for (const [instance, baseUrl] of baseUrls.entries()) {
        await runClosedLoop({
          concurrency: options.chatConcurrency,
          requests: questions.length,
          send: createChatSender({
            agent,
            baseUrls: [baseUrl],
            headers,
            options,
            questions,
            sessionTag: `load-${runId}-ingest-warm-i${instance}`,
          }),
        });
      }
    }

    const documents = buildIngestDocuments({ documents: baseUrls.length, pages: 1, tag: "warm" });
    const tracked = await Promise.all(
      documents.map((document, index) =>
        uploadAndTrack({ agent, baseUrls, document, headers, index, options, startedAt: performance.now() })
      )
    );
    const settled = await Promise.all(tracked.map((entry) => entry.settled));
    const failed = settled.filter((result) => !Number.isFinite(result.searchableMs));

    if (failed.length > 0) {
      throw new Error(
        `Warm-up upload did not become searchable: ${failed
          .map((result) => result.jobError ?? result.serverError ?? result.error ?? `http_${result.status}`)
          .join("; ")}`
      );
    }
  } finally {
    agent.destroy();
  }
};

const runIngestScenario = async ({ apps, baseUrls, corpus, fakeModel, headers, instances, options, profile, runId, workers }) => {
  const levels = [];

  for (const [levelIndex, uploadConcurrency] of options.uploadConcurrency.entries()) {
    const tag = `p${profile}c${uploadConcurrency}l${levelIndex + 1}`;
    const documents = buildIngestDocuments({ documents: options.uploads, pages: options.ingestPages, tag });
    const sessionTag = `load-${runId}-ingest-${tag}`;

    fakeModel.resetStats();
    await collectStats([...apps, ...workers]);
    const { chat, results, wallMs } = await runIngestLevel({
      baseUrls,
      documents,
      headers,
      options,
      questions: corpus.questions,
      sessionTag,
      uploadConcurrency,
    });
    const apiStats = await collectStats(apps);
    const workerStats = await collectStats(workers);
    const model = fakeModel.snapshot();
    const ingest = summarizeIngestLevel({ results, wallMs });
    const { cpuMsPerUnit: apiCpuMsPerDocument, ...apiFields } = combineServerStats(apiStats, ingest.searchable);
    const workerCombined = workers.length > 0 ? combineServerStats(workerStats, ingest.searchable) : null;

    // The same chat load for as long as the ingest window lasted, with nothing
    // being ingested: the comparison row for the chat latency above.
    const baseline = await runChatWindow({
      baseUrls,
      durationMs: wallMs,
      headers,
      options,
      questions: corpus.questions,
      sessionTag: `${sessionTag}-baseline`,
    });
    const chatDuring = options.chatConcurrency > 0 ? summarizeLevel(chat) : null;
    const chatBaseline = baseline ? summarizeLevel(baseline) : null;

    levels.push({
      uploadConcurrency,
      documentPages: options.ingestPages,
      pdfBytesMean: round(documents.reduce((sum, document) => sum + document.pdf.length, 0) / documents.length),
      visibilityCheck: baseUrls.length > 1 ? "other_instance" : "same_instance",
      ...ingest,
      chat: { baseline: chatBaseline, concurrency: options.chatConcurrency, duringIngest: chatDuring },
      model: {
        peakChatInFlight: observedPeakInFlight({ latencyMs: profile, peak: model.chat.peakInFlight }),
        peakEmbeddingsInFlight: observedPeakInFlight({
          latencyMs: options.embeddingLatencyMs,
          peak: model.embeddings.peakInFlight,
        }),
        ...model,
      },
      server: { ...apiFields, cpuMsPerDocument: apiCpuMsPerDocument },
      workers: workerCombined
        ? (({ cpuMsPerUnit, ...fields }) => ({
            ...fields,
            count: workers.length,
            cpuMsPerDocument: cpuMsPerUnit,
            perProcess: workerStats.map(({ type: _type, ...stats }, index) => ({ index, ...stats })),
          }))(workerCombined)
        : null,
      ...(apps.length > 1
        ? {
            instances: describeInstances({
              counts: countByInstance(chat?.results ?? [], apps.length),
              instances,
              stats: apiStats,
              uploads: countByInstance(results, apps.length),
            }),
          }
        : {}),
      failures: results
        .filter((result) => result && !Number.isFinite(result.searchableMs))
        .slice(0, 5)
        .map((result) => ({
          error: result.error ?? null,
          instance: result.instance,
          jobError: result.jobError ?? null,
          serverError: result.serverError ?? null,
          status: result.status,
        })),
    });

    console.log(
      `  POST /upload (${options.ingestMode}) c=${String(uploadConcurrency).padStart(3)}  ${ingest.searchable}/${ingest.uploads} searchable  ${ingest.throughputDocsPerSecond} docs/s  upload p50 ${ingest.uploadLatencyMs.p50} ms  searchable p50 ${ingest.searchableMs.p50} ms p95 ${ingest.searchableMs.p95} ms  chat p95 ${chatDuring?.latencyMs.p95 ?? "-"} ms (baseline ${chatBaseline?.latencyMs.p95 ?? "-"} ms)`
    );
  }

  return {
    chatConcurrency: options.chatConcurrency,
    embeddingLatencyMs: options.embeddingLatencyMs,
    endpoint: "POST /upload",
    ingestMode: options.ingestMode,
    ingestWorkers: options.ingestWorkers,
    kind: "ingest",
    levels,
    modelLatencyMs: profile,
  };
};

// ---------------------------------------------------------------------------
// Report

const readGit = (args) => {
  try {
    return execFileSync("git", args, { cwd: serverDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const formatVectorStore = (runtime) =>
  runtime
    ? `${runtime.vectorStoreProvider} (dense ${runtime.denseBackend}, sparse ${runtime.sparseBackend ?? "off"}${
        runtime.hybridFusion ? `, ${runtime.hybridFusion} fusion` : ""
      })`
    : "unknown";

const cell = (value) => (value === null || value === undefined ? "-" : String(value));

const joinPerInstance = (values) => values.map((value) => cell(value)).join(" / ");

const formatErrorCounts = (errorCounts = {}) =>
  Object.entries(errorCounts)
    .map(([reason, count]) => `${reason} x${count}`)
    .join(", ");

const formatIngestScenario = (lines, scenario, multiInstance) => {
  lines.push(
    `| Upload concurrency | Uploads | Searchable | Errors | Upload p50 ms | Upload p95 ms | Searchable p50 ms | Searchable p95 ms | Searchable max ms | Docs/s |${multiInstance ? " Listed on another instance |" : ""} Embedding requests (inputs) | Peak embeddings in flight | API CPU ms/doc | Worker CPU ms/doc |`,
    `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |${multiInstance ? " ---: |" : ""} ---: | ---: | ---: | ---: |`
  );
  for (const level of scenario.levels) {
    const listed = multiInstance
      ? ` ${Number.isInteger(level.crossInstanceChecks) ? `${level.listedOnOtherInstance}/${level.crossInstanceChecks}` : "-"} |`
      : "";
    lines.push(
      `| ${level.uploadConcurrency} | ${level.uploads} | ${level.searchable} | ${level.errors} | ${cell(level.uploadLatencyMs.p50)} | ${cell(level.uploadLatencyMs.p95)} | ${cell(level.searchableMs.p50)} | ${cell(level.searchableMs.p95)} | ${cell(level.searchableMs.max)} | ${cell(level.throughputDocsPerSecond)} |${listed} ${cell(level.model?.embeddings?.requests)} (${cell(level.model?.embeddings?.inputs)}) | ${cell(level.model?.peakEmbeddingsInFlight)} | ${cell(level.server?.cpuMsPerDocument)} | ${cell(level.workers?.cpuMsPerDocument)} |`
    );
  }

  const withChat = scenario.levels.filter((level) => level.chat?.duringIngest);
  if (withChat.length > 0) {
    lines.push(
      "",
      `Background POST /chat at concurrency ${scenario.chatConcurrency} during the ingest window, and the same load for the same duration with nothing being ingested (baseline):`,
      "",
      "| Upload concurrency | Chat requests (ingest / baseline) | Chat errors (ingest / baseline) | p50 ms (ingest / baseline) | p95 ms (ingest / baseline) | p99 ms (ingest / baseline) | Peak chat in flight | API event-loop p99 ms |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const level of withChat) {
      const during = level.chat.duringIngest;
      const baseline = level.chat.baseline;
      const pair = (read) => `${cell(read(during))} / ${cell(baseline ? read(baseline) : null)}`;
      lines.push(
        `| ${level.uploadConcurrency} | ${pair((row) => row.requests)} | ${pair((row) => row.errors)} | ${pair((row) => row.latencyMs.p50)} | ${pair((row) => row.latencyMs.p95)} | ${pair((row) => row.latencyMs.p99)} | ${cell(level.model?.peakChatInFlight)} | ${cell(level.server?.eventLoopDelayP99Ms)} |`
      );
    }
  }

  if (multiInstance) {
    lines.push("", "Per instance (uploads taken / background chat requests / CPU ms during the ingest window):");
    for (const level of scenario.levels) {
      lines.push(
        `- c=${level.uploadConcurrency}: ${(level.instances ?? [])
          .map(
            (instance) =>
              `#${instance.index} ${cell(instance.uploads)} / ${cell(instance.requests)} / ${cell(round((instance.cpuUserMs ?? 0) + (instance.cpuSystemMs ?? 0)))}`
          )
          .join("; ")}`
      );
    }
  }

  const errorLevels = scenario.levels.filter((level) => level.errors > 0);
  if (errorLevels.length > 0) {
    lines.push("", "Errors:");
    for (const level of errorLevels) {
      const detail = (level.failures ?? [])
        .map((failure) => failure.jobError ?? failure.serverError)
        .filter(Boolean);
      lines.push(
        `- c=${level.uploadConcurrency}: ${formatErrorCounts(level.errorCounts)}${detail.length > 0 ? ` (first messages: ${[...new Set(detail)].join(" | ")})` : ""}`
      );
    }
  }
};

/** Markdown report: config, then one table per storage mode and scenario. */
export const formatLoadTestMarkdown = (report) => {
  const { config } = report;
  const scenarioKind = config.scenario ?? "chat";
  const instanceCount = config.instances ?? 1;
  const multiInstance = instanceCount > 1;
  const lines = [
    "# API load test",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Config",
    "",
    "| Setting | Value |",
    "| --- | --- |",
    `| Git SHA | ${cell(config.gitSha)}${config.gitDirty ? " (dirty worktree)" : ""} |`,
    `| Node | ${cell(config.nodeVersion)} |`,
    `| Host | ${cell(config.platform)}, ${cell(config.cpuCount)} CPUs (${cell(config.cpuModel)}), ${cell(config.totalMemoryGb)} GB RAM |`,
    `| Storage modes | ${config.storage.join(", ")} |`,
    `| Scenario | ${scenarioKind} |`,
    `| App instances | ${instanceCount}${multiInstance ? " (client-side round robin, one database)" : ""} |`,
    `| Shared state (model call guard) | ${config.sharedState ?? "memory"}${config.sharedState === "redis" ? " (RAG_LLM_MAX_CONCURRENCY is one cap for all instances)" : multiInstance ? " (RAG_LLM_MAX_CONCURRENCY applies per instance)" : ""} |`,
    `| Model latency profiles (chat completion) | ${config.modelLatencyMs.map((ms) => `${ms} ms`).join(", ")} |`,
    `| Embedding latency | ${config.embeddingLatencyMs} ms |`,
    `| RAG_LLM_MAX_CONCURRENCY | ${config.llmMaxConcurrency} |`,
  ];

  if (scenarioKind === "ingest") {
    lines.push(
      `| Ingest mode | ${config.ingestMode}${config.ingestMode === "async" ? `, ${config.ingestWorkers ? `${config.ingestWorkers} dedicated worker process(es), API instances without a worker loop` : "worker loop in every API instance"}${Number.isInteger(config.ingestWorkerConcurrency) ? `, RAG_INGEST_WORKER_CONCURRENCY=${config.ingestWorkerConcurrency}` : ""}` : ""} |`,
      `| Uploads | ${config.uploads} PDFs of ${config.ingestPages} pages per level; upload concurrency ${config.uploadConcurrency.join(", ")} |`,
      `| Background chat | concurrency ${config.chatConcurrency}; seed corpus ${config.documents} documents x ${config.pages} pages |`,
      `| Poll interval / searchable timeout | ${config.pollIntervalMs} ms / ${config.searchableTimeoutMs} ms |`
    );
  } else {
    lines.push(
      `| Concurrency levels | ${config.concurrency.join(", ")} |`,
      `| Requests per level | /chat ${config.requests}, ${config.cheapPath} ${config.cheapRequests} (after a warm-up of max(${config.warmup}, concurrency)) |`,
      `| Corpus | ${config.documents} documents x ${config.pages} pages, ${config.questions} questions |`
    );
  }

  lines.push(
    `| Planner | ${config.planner} |`,
    `| Auth / rate limit | ${config.auth ? "enabled" : "disabled"} / ${config.rateLimit ? "enabled" : "disabled"} |`,
    `| Embedding dimensions / query embedding cache | ${config.embeddingDimensions} / ${config.embeddingCache ? "on" : "off"} |`,
    "",
    `Percentiles: ${report.method.percentile}. ${report.method.notes.join(" ")}`,
    ""
  );

  for (const run of report.runs) {
    lines.push(
      `## Storage: ${run.storage}`,
      "",
      `${scenarioKind === "ingest" ? "Seed corpus ingest" : "Ingest"}: ${run.ingest.documentCount} documents, ${run.ingest.chunkCount} chunks in ${run.ingest.ingestMs} ms.`,
      `Vector store in the app process: ${formatVectorStore(run.ingest.vectorStore)}${
        Number.isInteger(run.ingest.databaseChunkRows)
          ? `; ${run.ingest.databaseChunkRows} chunk rows counted in PostgreSQL after ingest`
          : ""
      }.`
    );
    if (Array.isArray(run.instances) && (run.instances.length > 1 || run.ingestWorkers > 0)) {
      lines.push(
        `Processes: ${run.instances.length} API instance(s) on ports ${run.instances.map((instance) => instance.port).join(", ")}${
          run.ingestWorkers > 0 ? `, ${run.ingestWorkers} dedicated ingest worker(s)` : ""
        }.`
      );
    }
    lines.push("");

    for (const scenario of run.scenarios) {
      const heading =
        scenario.kind === "ingest"
          ? `### ${scenario.endpoint} (${scenario.ingestMode} ingest), chat model latency ${scenario.modelLatencyMs} ms, embedding latency ${scenario.embeddingLatencyMs} ms`
          : scenario.kind === "chat"
            ? `### ${scenario.endpoint}, model latency ${scenario.modelLatencyMs} ms`
            : `### ${scenario.endpoint}`;
      lines.push(heading, "");

      if (scenario.kind === "ingest") {
        formatIngestScenario(lines, scenario, multiInstance);
        lines.push("");
        continue;
      }

      const instanceHeader = multiInstance ? " Requests per instance | Server CPU ms per instance |" : "";
      const instanceRule = multiInstance ? " ---: | ---: |" : "";
      const instanceCells = (level) =>
        multiInstance
          ? ` ${joinPerInstance((level.instances ?? []).map((instance) => instance.requests))} | ${joinPerInstance(
              (level.instances ?? []).map((instance) => round((instance.cpuUserMs ?? 0) + (instance.cpuSystemMs ?? 0)))
            )} |`
          : "";

      if (scenario.kind === "chat") {
        lines.push(
          `| Concurrency | Requests | Errors | Error rate | Req/s | p50 ms | p95 ms | p99 ms | Max ms | Chat calls/req | Embedding calls/req | Peak chat in flight | Server CPU ms/req | Event-loop p99 ms | Answers (mode, cited) |${instanceHeader}`,
          `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |${instanceRule}`
        );
        for (const level of scenario.levels) {
          const modes = [
            ...Object.entries(level.agentModes ?? {}).map(([mode, count]) => `${mode} ${count}`),
            ...(Number.isInteger(level.groundedAnswers) ? [`cited ${level.groundedAnswers}`] : []),
          ].join(", ");
          lines.push(
            `| ${level.concurrency} | ${level.requests} | ${level.errors} | ${cell(level.errorRate)} | ${cell(level.throughputRps)} | ${cell(level.latencyMs.p50)} | ${cell(level.latencyMs.p95)} | ${cell(level.latencyMs.p99)} | ${cell(level.latencyMs.max)} | ${cell(level.model.chatCompletionsPerRequest)} | ${cell(level.model.embeddingRequestsPerRequest)} | ${cell(level.model.peakChatInFlight)} | ${cell(level.server.cpuMsPerRequest)} | ${cell(level.server.eventLoopDelayP99Ms)} | ${modes || "-"} |${instanceCells(level)}`
          );
        }
      } else {
        lines.push(
          `| Concurrency | Requests | Errors | Error rate | Req/s | p50 ms | p95 ms | p99 ms | Max ms | Server CPU ms/req | Event-loop p99 ms |${instanceHeader}`,
          `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |${instanceRule}`
        );
        for (const level of scenario.levels) {
          lines.push(
            `| ${level.concurrency} | ${level.requests} | ${level.errors} | ${cell(level.errorRate)} | ${cell(level.throughputRps)} | ${cell(level.latencyMs.p50)} | ${cell(level.latencyMs.p95)} | ${cell(level.latencyMs.p99)} | ${cell(level.latencyMs.max)} | ${cell(level.server.cpuMsPerRequest)} | ${cell(level.server.eventLoopDelayP99Ms)} |${instanceCells(level)}`
          );
        }
      }

      const errorLevels = scenario.levels.filter((level) => level.errors > 0);
      if (errorLevels.length > 0) {
        lines.push("", "Errors:");
        for (const level of errorLevels) {
          lines.push(`- c=${level.concurrency}: ${formatErrorCounts(level.errorCounts)}`);
        }
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
};

export const LOAD_TEST_METHOD_NOTES = Object.freeze([
  "Closed loop: each virtual user sends its next request when the previous response arrives; results describe latency at that concurrency, not at a fixed arrival rate.",
  "Latency percentiles cover 2xx responses; with fewer than 100 samples p99 equals the maximum.",
  "Req/s counts every completed request over the level's wall time; errors are non-2xx, timeouts and connection failures.",
  "The model is a local fake (hashed term embeddings, first-sentence grounded answers); model calls and peak in-flight chat completions are counted by the fake server.",
  "Peak in flight is counted by the fake only when its latency is above 0 ms: a zero-latency fake answers in the same tick it reads the request, so its count cannot exceed 1 and is shown as -.",
  "With the query embedding cache on, the question pool (one question per page) repeats, so once every question has been asked a /chat request reuses the cached query embedding and makes no embedding call; the Embedding calls/req column shows which levels paid for query embeddings, and a level with 0 there excludes that cost.",
  "In sync ingest mode GET /documents lists the app's in-process document registry and sends no database query in either storage mode; it measures the HTTP stack, auth and scope filtering, not storage. In async ingest mode each GET /documents first re-reads the requesting tenant's rows of the documents table (every row when auth is off), so that documents another process ingested are listed; that is one PostgreSQL query per request.",
  "Load generator, fake model and app run on one host; the app runs in its own process.",
  `Event-loop p99 is the app process's delay beyond the ${EVENT_LOOP_SAMPLING_MS} ms sampling interval of monitorEventLoopDelay (an idle loop shows about 0); stalls shorter than the interval can be missed.`,
  "Server CPU ms/req is the app process's user+system CPU over the level divided by its requests; it counts everything the process did during the level (timers and GC included), not request handling alone.",
]);

export const MULTI_INSTANCE_METHOD_NOTES = Object.freeze([
  "Several instances: separate app processes on one host and one PostgreSQL database, sharing the temp data and upload directories; the load generator sends request i to instance i mod N (client-side round robin, no proxy). Server CPU sums every instance, event-loop delay is the worst instance, and the fake model's peak in flight counts all of them together.",
  "With --shared-state memory the model call guard is per process, so RAG_LLM_MAX_CONCURRENCY caps each instance and N instances may reach N times the cap; with redis every instance draws from one cap.",
]);

export const INGEST_METHOD_NOTES = Object.freeze([
  "Ingest scenario: generated text PDFs (one sentence per line, one distinct fact per page) are uploaded through POST /upload by a closed loop at the upload concurrency; an uploader moves on as soon as its 201 or 202 arrives, and each document is then followed on its own.",
  "Upload latency is the POST /upload request. In sync mode the 201 carries the indexed document, so searchable time is the upload latency. In async mode searchable time runs from the upload's start until GET /documents lists the document on the next instance after the one that took the upload (the same instance when there is one), checked once GET /ingest-jobs/:jobId reports succeeded; both are polled, so they are late by up to one poll interval.",
  "Listed on another instance (several instances only): in sync mode one GET /documents on the next instance right after the 201; in async mode the polled check above. A sync count below the upload count means a document is only listed by the process that ingested it.",
  "Docs/s is searchable documents over the ingest window, which ends when the last document became searchable or failed. A document that failed, timed out or never appeared counts as an error.",
  "Embedding requests and inputs count every call the fake received during the window, including the background chat's query embeddings. CPU ms/doc divides the processes' CPU over the window by searchable documents; API CPU includes the background chat.",
  "The baseline row repeats the background chat load for as long as the ingest window lasted, right after it, with no uploads running.",
]);

/** Method notes for this run's settings: the common ones plus those that apply. */
export const buildMethodNotes = (options = {}) => [
  ...LOAD_TEST_METHOD_NOTES,
  ...((options.instances ?? 1) > 1 || (options.ingestWorkers ?? 0) > 0 ? MULTI_INSTANCE_METHOD_NOTES : []),
  ...(options.scenario === "ingest" ? INGEST_METHOD_NOTES : []),
];

/**
 * Fails fast when --redis-url does not answer: the app treats Redis as an
 * optimization and silently falls back to per-process state, which would turn
 * a "cluster-wide cap" run into a per-instance one without any error.
 */
const assertRedisReachable = async (url) => {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(url, { connectTimeout: 2000, lazyConnect: true, maxRetriesPerRequest: 0 });
  redis.on("error", () => {});

  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`unexpected PING reply ${pong}`);
  } catch (error) {
    throw new Error(`--redis-url ${url} is not reachable (${error?.message ?? error}); --shared-state redis needs a running Redis.`);
  } finally {
    redis.disconnect();
  }
};

// Children are pushed into `apps` as they start, so the caller can stop the
// ones already running when a later one fails.
const startInstances = async ({ apps, corpus, environmentFor, options, storage }) => {
  const instances = [];

  // One at a time: the first migrates the database and ingests the seed
  // corpus; the rest start against that schema and load its registry.
  for (let index = 0; index < options.instances; index += 1) {
    const app = await startAppProcess({ environment: environmentFor("api"), verbose: options.verbose });
    apps.push(app);
    const ready = await app.start(index === 0 ? corpus.documents : [], { primary: index === 0 });
    instances.push({ ...ready, index });
    console.log(
      index === 0
        ? `[${storage}] instance 0: ${ready.chunkCount} chunks ingested in ${ready.ingestMs} ms; on port ${ready.port}${ready.ingestWorker ? " (with ingest worker)" : ""}`
        : `[${storage}] instance ${index}: on port ${ready.port}${ready.ingestWorker ? " (with ingest worker)" : ""}`
    );
  }

  return instances;
};

const startIngestWorkers = async ({ environmentFor, options, storage, workers }) => {

  for (let index = 0; index < options.ingestWorkers; index += 1) {
    const worker = await startAppProcess({ environment: environmentFor("worker"), role: "worker", verbose: options.verbose });
    workers.push(worker);
    await worker.start([]);
  }
  if (workers.length > 0) console.log(`[${storage}] ${workers.length} dedicated ingest worker process(es) started`);
};

const main = async () => {
  const options = parseLoadTestArgs(process.argv.slice(2));

  if (options.serve) {
    await serve();
    return;
  }
  if (options.serveWorker) {
    await serveWorker();
    return;
  }
  if (options.ingestWorkers > 0 && !existsSync(INGEST_WORKER_ENTRY)) {
    throw new Error(
      `--ingest-workers needs the dedicated ingest worker entry ${path.relative(serverDirectory, INGEST_WORKER_ENTRY)} (asynchronous ingestion), which this checkout does not have.`
    );
  }
  if (options.sharedState === "redis") await assertRedisReachable(options.redisUrl);

  const runId = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const corpus = buildSyntheticCorpus({
    docIdPrefix: `load-${runId}`,
    documents: options.documents,
    pages: options.pages,
  });
  const authToken = options.auth ? randomBytes(24).toString("hex") : "";
  const headers = options.auth ? { "x-api-key": authToken } : {};
  const fakeModel = await startFakeModelServer({ dimensions: options.embeddingDimensions });
  const runs = [];

  console.log(
    options.scenario === "ingest"
      ? `Load test (ingest, ${options.ingestMode}): storage ${options.storage.join(", ")}; ${options.instances} instance(s), ${options.ingestWorkers} worker process(es); upload concurrency ${options.uploadConcurrency.join(", ")}; ${options.uploads} uploads per level; embedding latency ${options.embeddingLatencyMs} ms; shared state ${options.sharedState}`
      : `Load test: storage ${options.storage.join(", ")}; ${options.instances} instance(s); concurrency ${options.concurrency.join(", ")}; model latency ${options.modelLatencyMs.join(", ")} ms; RAG_LLM_MAX_CONCURRENCY=${options.llmMaxConcurrency}; shared state ${options.sharedState}`
  );

  try {
    for (const storage of options.storage) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), `load-test-${storage}-`));
      await writeFile(path.join(tempRoot, "empty.env"), "");
      // Every process of the run shares the temp root: data, uploads and
      // upload-session directories are the same, as on one host.
      const environmentFor = (role) =>
        buildAppEnvironment({
          authToken,
          databaseUrl: options.databaseUrl,
          modelBaseUrl: fakeModel.baseUrl,
          options,
          role,
          runId,
          storage,
          tempRoot,
        });
      const apps = [];
      const workers = [];

      try {
        fakeModel.setLatency({ chatMs: 0, embeddingMs: 0 });
        console.log(`[${storage}] starting ${options.instances} app instance(s) and ingesting ${corpus.documents.length} documents...`);
        const instances = await startInstances({ apps, corpus, environmentFor, options, storage });
        await startIngestWorkers({ environmentFor, options, storage, workers });
        const baseUrls = instances.map((instance) => `http://127.0.0.1:${instance.port}`);
        const primary = instances[0];
        const scenarios = [];

        if (options.scenario === "ingest") {
          if (options.warmup > 0) {
            await warmUpIngestScenario({ baseUrls, headers, options, questions: corpus.questions, runId });
          }
          for (const profile of options.modelLatencyMs) {
            fakeModel.setLatency({ chatMs: profile, embeddingMs: options.embeddingLatencyMs });
            scenarios.push(
              await runIngestScenario({ apps, baseUrls, corpus, fakeModel, headers, instances, options, profile, runId, workers })
            );
          }
        } else {
          scenarios.push(
            await runScenario({
              apps,
              baseUrls,
              fakeModel,
              headers,
              instances,
              options,
              profile: null,
              runId,
              target: { kind: "cheap", label: `GET ${options.cheapPath}`, offset: 0, path: options.cheapPath },
            })
          );

          for (const profile of options.modelLatencyMs) {
            fakeModel.setLatency({ chatMs: profile, embeddingMs: options.embeddingLatencyMs });
            scenarios.push(
              await runScenario({
                apps,
                baseUrls,
                fakeModel,
                headers,
                instances,
                options,
                profile,
                runId,
                target: {
                  kind: "chat",
                  label: `POST /chat @${profile}ms`,
                  offset: 0,
                  questions: corpus.questions,
                },
              })
            );
          }
        }

        runs.push({
          ingest: {
            chunkCount: primary.chunkCount,
            databaseChunkRows: primary.databaseChunkRows,
            documentCount: primary.documentCount,
            ingestMs: primary.ingestMs,
            vectorStore: primary.vectorStore,
          },
          instances: instances.map((instance) => ({
            index: instance.index,
            ingestWorker: Boolean(instance.ingestWorker),
            port: instance.port,
          })),
          ingestWorkers: workers.length,
          scenarios,
          sharedState: options.sharedState,
          storage,
        });
      } catch (error) {
        for (const [index, child] of [...apps, ...workers].entries()) {
          if (!options.verbose && child.logTail.length > 0) {
            console.error(`[${storage}] last log lines of process ${index}:\n${child.logTail.join("\n")}`);
          }
        }
        throw error;
      } finally {
        await Promise.all([...workers, ...apps].map((child) => child.stop()));
        await rm(tempRoot, { force: true, recursive: true });
      }
    }
  } finally {
    await fakeModel.close();
  }

  const cpus = os.cpus();
  const report = {
    reportType: LOAD_TEST_REPORT_TYPE,
    reportVersion: LOAD_TEST_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    config: {
      auth: options.auth,
      chatConcurrency: options.scenario === "ingest" ? options.chatConcurrency : null,
      cheapPath: options.cheapPath,
      cheapRequests: options.cheapRequests,
      concurrency: options.concurrency,
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model ?? null,
      documents: options.documents,
      embeddingCache: options.embeddingCache,
      embeddingDimensions: options.embeddingDimensions,
      embeddingLatencyMs: options.embeddingLatencyMs,
      gitDirty: (readGit(["status", "--porcelain"]) ?? "") !== "",
      gitSha: readGit(["rev-parse", "HEAD"]),
      ingestMode: options.scenario === "ingest" ? options.ingestMode : null,
      ingestPages: options.scenario === "ingest" ? options.ingestPages : null,
      ingestWorkerConcurrency: options.ingestWorkerConcurrency,
      ingestWorkers: options.ingestWorkers,
      instances: options.instances,
      llmMaxConcurrency: options.llmMaxConcurrency,
      modelLatencyMs: options.modelLatencyMs,
      nodeVersion: process.version,
      pages: options.pages,
      planner: options.planner,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      pollIntervalMs: options.scenario === "ingest" ? options.pollIntervalMs : null,
      questions: corpus.questions.length,
      rateLimit: options.rateLimit,
      requestTimeoutMs: options.requestTimeoutMs,
      requests: options.requests,
      scenario: options.scenario,
      searchableTimeoutMs: options.scenario === "ingest" ? options.searchableTimeoutMs : null,
      sharedState: options.sharedState,
      storage: options.storage,
      totalMemoryGb: round(os.totalmem() / 1024 ** 3),
      uploadConcurrency: options.scenario === "ingest" ? options.uploadConcurrency : null,
      uploads: options.scenario === "ingest" ? options.uploads : null,
      warmup: options.warmup,
    },
    method: { notes: buildMethodNotes(options), percentile: PERCENTILE_METHOD },
    runs,
  };

  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, `${options.latestName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDirectory, `${options.latestName}.md`), formatLoadTestMarkdown(report));
  console.log(`Wrote ${path.join("evaluation", "results", `${options.latestName}.{json,md}`)}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
