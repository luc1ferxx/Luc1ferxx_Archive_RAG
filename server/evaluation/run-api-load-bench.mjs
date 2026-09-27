// run-api-load-bench.mjs
//
// API load test of the real Express app: throughput, latency percentiles and
// error rate for POST /chat (single-document QA through the full agent path)
// and for a cheap endpoint (GET /documents by default) at several concurrency
// levels.
//
// What is measured is the system, not a model. A fake OpenAI-compatible server
// in this process answers /v1/embeddings with deterministic hashed term vectors
// of the configured width and /v1/chat/completions with the evidence sentence
// that shares the most words with the question, cited as "[Source k]" of the
// source it came from, after an artificial delay.
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
// soon as the previous response arrives. A level is one continuous loop: the
// first max(--warmup, C) requests are a discarded warm-up, the next N are
// measured, and the loop keeps all C users busy until every measured request
// has returned (those cool-down requests are discarded too), so every measured
// request ran with C requests in flight and none of them carries the start of
// the loop or its drain. N is max(--requests, C x --min-requests-per-client).
// Closed-loop numbers describe latency at that concurrency, not at a fixed
// arrival rate (a slow response delays the next request, so queueing behind a
// stall is under-represented); in a closed loop the mean latency is C divided
// by the throughput (Little's law), which the report keeps next to the
// percentiles. Every virtual user keeps one sessionId per scenario, as the
// frontend does.
//
// Percentiles use the nearest-rank method over successful (2xx) responses:
// p = the value at rank ceil(p/100 * n) of the sorted latencies (rank 1 for
// p = 0), so p95 is the maximum below 20 samples and p99 below 100; every
// percentile is reported with its n. The measurement window runs from the
// sending of the first measured request to the sending of the first cool-down
// request; a closed loop sends a request exactly when one returns, so exactly
// N requests return inside it. Throughput is N (any status) per second of the
// window and the counters read over it (CPU, model calls, queries) divided by
// N are per-request costs, with no edge effect from the requests in flight
// when it opens or closes. Goodput counts 2xx only. Error rate counts non-2xx
// statuses, timeouts and connection errors.
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
// stays on (its default) and every instance's cache is warmed before the first
// measured /chat level (every question of the pool once on every instance);
// the harness raises the cache's TTL above the run and its size above the pool
// so no entry expires or is evicted mid-run, so measured levels make no query
// embedding call -- the "Embedding calls/req" column shows it, and
// --no-embedding-cache turns the cache off. GET /documents reads the
// in-process registry with local storage; with pgvector the registry is
// PostgreSQL, which other instances and ingest workers write too, so in either
// ingest mode GET /documents and POST /chat first re-read the requesting
// tenant's documents rows (the whole table with auth off). The "DB
// queries/req" column is what the report says about it, not an assumption.
//
// Access scope: by default no request names a tenant, so PostgreSQL
// statements run as the owner on the pool, outside row-level security (the
// unscoped owner path). --tenant sends x-user-id / x-workspace-id on every
// request and ingests the seed corpus as that tenant's, so each scoped
// statement runs in a tenant transaction under row-level security, as an
// authenticated per-tenant deployment runs it.
//
// The question is independent of the instance: each instance walks the whole
// question pool with a cursor of its own, whichever instance the balancer
// picks, so every instance answers every kind of question.
//
// The load generator, fake model and app share one machine; treat the numbers
// as this machine's, and compare runs made on the same host. The report
// records the host's CPU core tiers where the OS reports them (Apple silicon):
// CPU time per request is time, not work, and grows once busy threads spill
// from the fastest cores onto slower ones.
//
// Every process's CPU and PostgreSQL round trips (pg client.query calls,
// BEGIN/SET/COMMIT included) are counted per level. Before the first measured
// level the processes sit idle for --idle-ms; their idle CPU and queries per
// second give the "net of idle" columns (level total minus idle rate x level
// duration, per process). At the same window marks the harness samples the
// host's CPU, its own, and with --postgres-pid-file (the wrapper passes the
// cluster's) the PostgreSQL postmaster and its children, so the report holds
// the database's CPU per level too. With --shared-state redis each instance
// also counts the shared cap's acquire scripts.
//
// Several instances (--instances N, pgvector only): N app processes on their
// own ports against the one database, sharing the temp data and upload
// directories. Only the first migrates the (fresh) database and ingests the
// seed corpus; the others start afterwards and load its registry. The load
// generator balances client-side (--balance): least-outstanding (default, what
// nginx least_conn and Envoy LEAST_REQUEST do) sends each request to the
// instance with the fewest requests in flight from this generator, ties in
// rotation; round-robin sends request i to instance i mod N. The report keeps
// the per-level totals and adds per-instance requests, latency percentiles,
// mean and CPU; the fake model's peak in flight counts every instance
// together, so --shared-state redis (RAG_SHARED_STATE=redis, a Redis key prefix
// per run) shows RAG_LLM_MAX_CONCURRENCY as one cap for the cluster, and memory
// as a cap per process.
//
// Ingest scenario (--scenario ingest): generated text PDFs (load-bench-pdf.mjs)
// go through POST /upload at each --upload-concurrency level while a
// background /chat load (--chat-concurrency) runs over the seed corpus. A
// document is searchable, in both ingest modes, once POST /chat on an instance
// other than the one that took the upload (the same one when there is one)
// answers the document's probe question (one page's fact) with docIds
// [docId], the fact in the answer and a citation of that document. The check
// starts when the ingest reports done (sync: the 201; async: GET
// /ingest-jobs/:jobId reports succeeded, polled every --poll-interval-ms) and
// repeats every --poll-interval-ms while the document is not found. Every
// document of a level is offered when the window opens, and the times the
// modes are compared on run from there: to indexed (the 201, or the job's
// finishedAt) and to searchable; docs/s uses the indexed times. Async jobs
// also report queue wait (startedAt - createdAt) and processing (finishedAt -
// startedAt) from the job's own timestamps. Job polls and searchable checks
// are balanced apart from the workload (uploads and background chat). Per
// level: those times, documents/s, the upload split per instance, errors, the
// harness's own polling load, and the background chat latency during the
// window next to the same load with nothing being ingested for --baseline-ms
// before and after the window; --repeat N runs each level N times and adds a
// mean with a 95% t-interval.
// --ingest-mode async sets RAG_INGEST_MODE; --ingest-workers K adds K
// processes running server/ingest-worker.mjs and turns the API processes' own
// worker loop off; --ingest-worker-concurrency sets the loops per worker
// process, which is how async matches sync's parallelism (sync ingests one
// document per in-flight upload). Embeddings cost --embedding-latency-ms per
// request (200 ms by default in this scenario). A discarded warm-up asks every
// seed question once on every instance and uploads one document per instance.
//
// Usage:
//   node evaluation/run-api-load-bench.mjs
//     [--storage local|pgvector|local,pgvector]  default: local, or
//                                   pgvector,local when --database-url is given,
//                                   pgvector with --instances > 1 or --ingest-workers
//     [--database-url <disposable pgvector PostgreSQL URL>]
//     [--instances 1] [--balance least-outstanding|round-robin]
//     [--shared-state memory|redis] [--redis-url <disposable Redis URL>]
//     [--scenario chat|ingest]
//     [--concurrency 1,4,16,32] [--requests 128] [--min-requests-per-client 8]
//     [--cheap-requests 1000] [--warmup 8] [--idle-ms 3000]
//     [--model-latency-ms 0,800] [--embedding-latency-ms 0]
//     [--llm-max-concurrency 8] [--embedding-dimensions 1536]
//     [--documents 20] [--pages 4] [--cheap-path /documents]
//     [--request-timeout-ms 120000] [--planner deterministic|llm]
//     [--auth] [--rate-limit] [--no-embedding-cache] [--tenant] [--no-analyze]
//     [--postgres-pid-file <postmaster.pid>]
//     [--latest-name latest-load-test] [--verbose]
//   ingest scenario only:
//     [--ingest-mode sync|async] [--ingest-workers 0] [--ingest-worker-concurrency N]
//     [--ingest-worker-poll-ms N] [--ingest-max-pending-jobs N]
//     [--uploads 16] [--upload-concurrency 4]
//     [--ingest-pages 4] [--chat-concurrency 4] [--baseline-ms 10000]
//     [--poll-interval-ms 1000] [--searchable-timeout-ms 120000] [--repeat 1]
//     (--latest-name defaults to latest-load-test-ingest)
//
// A report is named by --latest-name and a rerun overwrites it: give each side
// of a before/after comparison its own name, and keep both.
//
// Full run against a throwaway PostgreSQL (created and removed by the script;
// --with-redis also starts a throwaway Redis and passes --shared-state redis):
//   bash scripts/run-load-test-pgvector.sh [--with-redis] [extra flags]

import { execFile, execFileSync, fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
export const LOAD_TEST_REPORT_VERSION = "1.2.0";
export const PERCENTILE_METHOD = "nearest-rank";

const FAKE_CHAT_MODEL = "load-test-chat";
const FAKE_EMBEDDING_MODEL = "text-embedding-3-small";

export const DEFAULT_LOAD_TEST_OPTIONS = Object.freeze({
  analyze: true,
  auth: false,
  balance: "least-outstanding",
  baselineMs: 10000,
  chatConcurrency: 4,
  cheapPath: "/documents",
  cheapRequests: 1000,
  concurrency: Object.freeze([1, 4, 16, 32]),
  databaseUrl: "",
  documents: 20,
  embeddingCache: true,
  embeddingDimensions: 1536,
  embeddingLatencyMs: 0,
  idleMs: 3000,
  ingestMode: "sync",
  ingestPages: 4,
  ingestWorkerConcurrency: null,
  ingestMaxPendingJobs: null,
  ingestWorkerPollMs: null,
  ingestWorkers: 0,
  instances: 1,
  latestName: "latest-load-test",
  llmMaxConcurrency: 8,
  minRequestsPerClient: 8,
  modelLatencyMs: Object.freeze([0, 800]),
  pages: 4,
  planner: "deterministic",
  postgresPidFile: "",
  // The frontend's first poll interval (src/components/PdfUploader.jsx); the
  // frontend then backs off, the harness keeps the interval fixed.
  pollIntervalMs: 1000,
  rateLimit: false,
  redisUrl: "",
  repeat: 1,
  requestTimeoutMs: 120000,
  requests: 128,
  scenario: "chat",
  searchableTimeoutMs: 120000,
  sharedState: "memory",
  storage: null,
  tenant: false,
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
export const BALANCE_MODES = Object.freeze(["least-outstanding", "round-robin"]);
// The tenant every request acts for with --tenant (x-user-id / x-workspace-id
// headers; the seed corpus is ingested as its documents).
export const LOAD_TEST_TENANT = Object.freeze({ userId: "load-test-user", workspaceId: "load-test-workspace" });

const INGEST_ONLY_FLAGS = Object.freeze([
  "baseline-ms",
  "chat-concurrency",
  "ingest-max-pending-jobs",
  "ingest-mode",
  "ingest-pages",
  "ingest-worker-concurrency",
  "ingest-worker-poll-ms",
  "ingest-workers",
  "poll-interval-ms",
  "repeat",
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
  const flags = new Set(["auth", "no-analyze", "no-embedding-cache", "rate-limit", "tenant", "verbose", "serve", "serve-worker"]);

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
    "balance",
    "cheap-path",
    "cheap-requests",
    "concurrency",
    "database-url",
    "documents",
    "embedding-dimensions",
    "embedding-latency-ms",
    "idle-ms",
    "instances",
    "latest-name",
    "llm-max-concurrency",
    "min-requests-per-client",
    "model-latency-ms",
    "pages",
    "planner",
    "postgres-pid-file",
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
  if (raw["no-analyze"]) options.analyze = false;
  if (raw.tenant) options.tenant = true;
  if (raw["postgres-pid-file"] !== undefined) options.postgresPidFile = String(raw["postgres-pid-file"]).trim();
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
  if (raw.balance !== undefined) {
    if (!BALANCE_MODES.includes(raw.balance)) throw new Error(`--balance must be ${BALANCE_MODES.join(" or ")}.`);
    options.balance = raw.balance;
  }
  if (raw["min-requests-per-client"] !== undefined)
    options.minRequestsPerClient = toPositiveInteger(raw["min-requests-per-client"], "--min-requests-per-client", {
      allowZero: true,
    });
  if (raw["idle-ms"] !== undefined) options.idleMs = toPositiveInteger(raw["idle-ms"], "--idle-ms", { allowZero: true });

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
    if (raw["ingest-worker-poll-ms"] !== undefined)
      options.ingestWorkerPollMs = toPositiveInteger(raw["ingest-worker-poll-ms"], "--ingest-worker-poll-ms");
    // RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT (0 = no cap): the harness is one
    // tenant, so a burst above the app's default cap is answered with 429s.
    if (raw["ingest-max-pending-jobs"] !== undefined)
      options.ingestMaxPendingJobs = toPositiveInteger(raw["ingest-max-pending-jobs"], "--ingest-max-pending-jobs", {
        allowZero: true,
      });
    if (raw["baseline-ms"] !== undefined)
      options.baselineMs = toPositiveInteger(raw["baseline-ms"], "--baseline-ms", { allowZero: true });
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
    // Each upload concurrency level runs this many times in a row (with its
    // own baselines), so the report can put an interval on its numbers.
    if (raw.repeat !== undefined) options.repeat = toPositiveInteger(raw.repeat, "--repeat");
    if (raw["embedding-latency-ms"] === undefined) options.embeddingLatencyMs = DEFAULT_INGEST_EMBEDDING_LATENCY_MS;
    if (!raw["latest-name"]) options.latestName = DEFAULT_INGEST_LATEST_NAME;
    if (options.ingestWorkers > 0 && options.ingestMode !== "async") {
      throw new Error("--ingest-workers needs --ingest-mode async: sync uploads are ingested by the API process itself.");
    }
    if (options.ingestWorkerConcurrency !== null && options.ingestMode !== "async") {
      throw new Error(
        "--ingest-worker-concurrency needs --ingest-mode async (sync mode ingests one document per in-flight upload, so its parallelism is the upload concurrency)."
      );
    }
    if (options.ingestWorkerPollMs !== null && options.ingestMode !== "async") {
      throw new Error("--ingest-worker-poll-ms needs --ingest-mode async.");
    }
    if (options.ingestMaxPendingJobs !== null && options.ingestMode !== "async") {
      throw new Error("--ingest-max-pending-jobs needs --ingest-mode async (only queued uploads count against it).");
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

/**
 * The smallest sample count at which the nearest-rank p-th percentile is not
 * the maximum: 20 for p95, 100 for p99, 2 for p50. Below it the percentile is
 * the largest sample, which the report's small-sample note says.
 */
export const minSamplesBelowMaximum = (p) => {
  if (!Number.isFinite(p) || p < 0 || p >= 100) {
    throw new RangeError(`minSamplesBelowMaximum expects p in [0, 100), got ${p}.`);
  }

  let count = 1;
  while (Math.max(1, Math.ceil((p / 100) * count)) >= count) count += 1;

  return count;
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

/**
 * Little's law for a closed loop: with C requests always in flight and a
 * throughput of X requests per second, the mean latency is C / X. A measured
 * mean far from it means the loop was not in steady state.
 */
export const littleLawMeanMs = (concurrency, throughputRps) =>
  Number.isFinite(concurrency) && concurrency > 0 && Number.isFinite(throughputRps) && throughputRps > 0
    ? round((concurrency / throughputRps) * 1000)
    : null;

/** Measured requests of one level: at least --min-requests-per-client per virtual user. */
export const measuredRequestsForLevel = ({ concurrency, minRequestsPerClient = 0, requests }) =>
  Math.max(requests, concurrency * minRequestsPerClient);

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
 * agentMode?, grounded? } per request; wallMs is the measurement window
 * (runClosedLoop), so throughput is results per second of it.
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
 * soon as the previous one settles. The first `warmup` requests are
 * discarded, the next `requests` are measured; with `steadyState` the workers
 * keep sending (discarded cool-down requests) until every measured request has
 * settled, so each measured request ran with `concurrency` requests in flight.
 * Without it exactly warmup + requests are sent. `send` receives { index,
 * workerIndex, phase } (index counts every request sent, phase is warmup,
 * measured or cooldown) and resolves to a result object; a thrown error
 * becomes { status: 0, error }. Latency is measured around `send`.
 *
 * The measurement window opens when the first measured request is sent
 * (onMeasureStart) and, with `steadyState`, closes when the first cool-down
 * request is sent (onMeasureEnd); without it, when the last measured request
 * settled. A closed loop sends a request exactly when one settles, so between
 * two sends bounding the measured ones exactly `requests` requests return:
 * throughput is requests over wallMs (the window), and counters read over the
 * window (CPU, model calls, queries) divided by `requests` are per-request
 * costs, with no edge effect from the requests in flight when it opens or
 * closes, whether they run in lockstep or not. Measured requests that return
 * after the window still count for latency. windowCompletions (and per
 * instance, for results tagged with one) counts the requests that returned
 * inside the window.
 */
export const runClosedLoop = async ({
  concurrency,
  requests,
  send,
  warmup = 0,
  steadyState = false,
  onMeasureStart = null,
  onMeasureEnd = null,
  now = () => performance.now(),
}) => {
  const results = new Array(requests);
  let sent = 0;
  let measuredSettled = 0;
  let cooldownRequests = 0;
  let windowCompletions = 0;
  const windowCompletionsByInstance = [];
  let measureStartedAt = null;
  let measureEndedAt = null;

  if (requests === 0) {
    measureStartedAt = now();
    measureEndedAt = measureStartedAt;
  }
  const closeWindow = () => {
    if (measureEndedAt !== null) return;
    measureEndedAt = now();
    onMeasureEnd?.();
  };

  const worker = async (workerIndex) => {
    for (;;) {
      const index = sent;
      const measuredIndex = index - warmup;
      const phase = measuredIndex < 0 ? "warmup" : measuredIndex < requests ? "measured" : "cooldown";

      if (phase === "cooldown" && (!steadyState || measuredSettled >= requests)) return;

      sent += 1;
      if (phase === "cooldown") {
        cooldownRequests += 1;
        closeWindow();
      }
      if (phase === "measured" && measuredIndex === 0) {
        measureStartedAt = now();
        onMeasureStart?.();
      }

      const requestStartedAt = now();
      let outcome;

      try {
        outcome = await send({ index, phase, workerIndex });
      } catch (error) {
        outcome = { error: String(error?.code ?? error?.message ?? error), status: 0 };
      }

      if (measureStartedAt !== null && measureEndedAt === null) {
        windowCompletions += 1;
        if (Number.isInteger(outcome?.instance)) {
          windowCompletionsByInstance[outcome.instance] = (windowCompletionsByInstance[outcome.instance] ?? 0) + 1;
        }
      }
      if (phase === "measured") {
        results[measuredIndex] = { ...outcome, latencyMs: now() - requestStartedAt };
        measuredSettled += 1;
        if (measuredSettled === requests) closeWindow();
      }
    }
  };

  const total = warmup + requests;
  await Promise.all(
    Array.from({ length: Math.max(1, steadyState ? concurrency : Math.min(concurrency, total)) }, (_, workerIndex) =>
      worker(workerIndex)
    )
  );

  return {
    cooldownRequests,
    results,
    wallMs: measureStartedAt === null || measureEndedAt === null ? 0 : measureEndedAt - measureStartedAt,
    warmupRequests: Math.min(warmup, sent),
    windowCompletions,
    windowCompletionsByInstance: Array.from(windowCompletionsByInstance, (count) => count ?? 0),
  };
};

/**
 * Closed loop without a request count: `concurrency` workers keep sending
 * until `shouldStop()` returns true, checked before each request; requests
 * already in flight finish and are kept. Used for the background /chat load
 * of the ingest scenario, which lasts exactly as long as its window.
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
 * Client-side load balancer over `count` instances. It counts the requests
 * this generator has in flight per instance (acquire before sending, release
 * when the response settled); every request goes through it, including ones
 * pinned to an instance, so the counts are what a proxy in front of the
 * instances would see from this client.
 *   least-outstanding  the instance with the fewest requests in flight, ties
 *                      in rotation (nginx least_conn, Envoy LEAST_REQUEST
 *                      with full scan)
 *   round-robin        instances in turn, whatever they have in flight
 */
export const createInstanceBalancer = ({ count, mode = "least-outstanding" } = {}) => {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`createInstanceBalancer needs count >= 1, got ${count}.`);
  if (!BALANCE_MODES.includes(mode)) throw new RangeError(`Unknown balance mode "${mode}".`);

  const outstanding = new Array(count).fill(0);
  let cursor = 0;

  const pick = () => {
    let chosen = cursor;

    if (mode === "least-outstanding") {
      for (let step = 1; step < count; step += 1) {
        const candidate = (cursor + step) % count;
        if (outstanding[candidate] < outstanding[chosen]) chosen = candidate;
      }
    }
    cursor = (chosen + 1) % count;

    return chosen;
  };

  return {
    acquire: (instance = null) => {
      const chosen = instance === null || instance === undefined ? pick() : instance;
      if (!Number.isInteger(chosen) || chosen < 0 || chosen >= count) {
        throw new RangeError(`No instance ${chosen} among ${count}.`);
      }
      outstanding[chosen] += 1;
      return chosen;
    },
    count,
    mode,
    outstanding: () => [...outstanding],
    release: (instance) => {
      outstanding[instance] = Math.max(0, outstanding[instance] - 1);
    },
  };
};

/**
 * The question for a request depends on the instance that serves it, not on
 * the request's index: each instance walks the whole pool with a cursor of its
 * own, starting a fraction of the pool apart, so every instance cycles every
 * question (and every kind of question) whichever way requests are balanced.
 */
export const createQuestionPicker = ({ instanceCount = 1, questions }) => {
  if (!Array.isArray(questions) || questions.length === 0) throw new TypeError("createQuestionPicker needs questions.");

  const cursors = Array.from({ length: instanceCount }, (_, instance) =>
    Math.floor((instance * questions.length) / instanceCount)
  );

  return (instance) => {
    const question = questions[cursors[instance] % questions.length];
    cursors[instance] += 1;
    return question;
  };
};

/**
 * Per instance: requests, errors and latency (2xx) of the results tagged with
 * `instance`.
 */
export const summarizeByInstance = (results = [], count = 1) => {
  const buckets = Array.from({ length: count }, () => ({ errors: 0, latencies: [], requests: 0 }));

  for (const result of results) {
    const bucket = Number.isInteger(result?.instance) ? buckets[result.instance] : null;
    if (!bucket) continue;
    bucket.requests += 1;
    if (isSuccess(result)) bucket.latencies.push(result.latencyMs);
    else bucket.errors += 1;
  }

  return buckets.map(({ errors, latencies, requests }) => ({
    errors,
    latencyMs: summarizeLatencies(latencies),
    requests,
  }));
};

/**
 * Idle rates of one process from a stats reply taken over an idle window:
 * CPU ms and PostgreSQL queries per second of that window.
 */
export const idleRatesFromStats = (stats = {}) => {
  const seconds = Number.isFinite(stats?.windowMs) && stats.windowMs > 0 ? stats.windowMs / 1000 : null;

  return {
    cpuMsPerSecond: seconds ? round(((stats.cpuUserMs ?? 0) + (stats.cpuSystemMs ?? 0)) / seconds, 2) : null,
    dbQueriesPerSecond: seconds && Number.isFinite(stats.dbQueries) ? round(stats.dbQueries / seconds, 2) : null,
    windowMs: Number.isFinite(stats?.windowMs) ? round(stats.windowMs) : null,
  };
};

/** A process's total over a window minus its idle rate times that window, never below 0. */
export const subtractIdle = ({ ratePerSecond, total, windowMs }) =>
  Number.isFinite(total) && Number.isFinite(ratePerSecond) && Number.isFinite(windowMs)
    ? Math.max(0, total - (ratePerSecond * windowMs) / 1000)
    : null;

const processCpuMs = (stats) => (stats?.cpuUserMs ?? 0) + (stats?.cpuSystemMs ?? 0);

/**
 * Sums CPU, PostgreSQL queries and memory over the processes of one level and
 * keeps the worst event-loop delay; with one process the fields equal that
 * process's own. `units` (requests or documents) turns totals into per-unit
 * costs; `idle` (per process, from idleRatesFromStats, same order) adds the
 * net-of-idle cost. Cores busy is CPU time over each process's own window,
 * summed: how many cores the processes kept busy on average.
 */
export const combineServerStats = (statsList = [], units = 0, { idle = null } = {}) => {
  const sum = (read) => round(statsList.reduce((total, stats) => total + (read(stats) ?? 0), 0));
  const worst = (name) => {
    const values = statsList.map((stats) => stats?.[name]).filter(Number.isFinite);
    return values.length > 0 ? Math.max(...values) : null;
  };
  const cpuUserMs = sum((stats) => stats?.cpuUserMs);
  const cpuSystemMs = sum((stats) => stats?.cpuSystemMs);
  const withWindow = statsList.filter((stats) => Number.isFinite(stats?.windowMs) && stats.windowMs > 0);
  const countsQueries = statsList.some((stats) => Number.isFinite(stats?.dbQueries));
  const dbQueries = countsQueries ? sum((stats) => stats?.dbQueries) : null;
  const countsAcquires = statsList.some((stats) => Number.isFinite(stats?.sharedSlotAcquireCalls));
  const perUnit = (value) => (units > 0 && Number.isFinite(value) ? round(value / units, 2) : null);
  const netOf = (read, rate) => {
    if (!Array.isArray(idle) || idle.length !== statsList.length) return null;
    let total = 0;
    for (const [index, stats] of statsList.entries()) {
      const net = subtractIdle({ ratePerSecond: idle[index]?.[rate], total: read(stats), windowMs: stats?.windowMs });
      if (net === null) return null;
      total += net;
    }
    return total;
  };

  return {
    coresBusy:
      withWindow.length > 0
        ? round(
            withWindow.reduce((total, stats) => total + processCpuMs(stats) / stats.windowMs, 0),
            2
          )
        : null,
    cpuSystemMs,
    cpuUserMs,
    dbQueries,
    eventLoopDelayMaxMs: worst("eventLoopDelayMaxMs"),
    eventLoopDelayP99Ms: worst("eventLoopDelayP99Ms"),
    rssMb: sum((stats) => stats?.rssMb),
    sharedSlotAcquireCalls: countsAcquires ? sum((stats) => stats?.sharedSlotAcquireCalls) : null,
    sharedSlotsAcquired: countsAcquires ? sum((stats) => stats?.sharedSlotsAcquired) : null,
    cpuMsPerUnit: perUnit(cpuUserMs + cpuSystemMs),
    cpuMsPerUnitNetOfIdle: perUnit(netOf(processCpuMs, "cpuMsPerSecond")),
    dbQueriesPerUnit: perUnit(dbQueries),
    dbQueriesPerUnitNetOfIdle: countsQueries ? perUnit(netOf((stats) => stats?.dbQueries, "dbQueriesPerSecond")) : null,
  };
};

/**
 * Server-side ingest timings from a job's public timestamps (ISO strings, one
 * clock: the job store's): queue wait from creation to the start of the last
 * attempt (earlier attempts and their retry delays included), processing from
 * that start to the finish. Null where a timestamp is missing.
 */
export const jobTimingsMs = ({ createdAt, finishedAt, startedAt } = {}) => {
  const parse = (value) => (typeof value === "string" && value ? Date.parse(value) : Number.NaN);
  const created = parse(createdAt);
  const started = parse(startedAt);
  const finished = parse(finishedAt);

  return {
    processingMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null,
    queueWaitMs: Number.isFinite(created) && Number.isFinite(started) ? Math.max(0, started - created) : null,
  };
};

/**
 * Summarizes one ingest level. Each upload result is { instance, status,
 * acceptedMs, indexedAtMs?, searchableMs?, searchableAtMs?, queueWaitMs?,
 * processingMs?, checkInstance?, error? }: acceptedMs is the upload request
 * itself (201 in sync mode, 202 in async mode); searchableMs runs from the
 * upload's start to the sending of the POST /chat that first returned a
 * grounded answer.
 *
 * Every document of a level is offered at the start of the window (a burst,
 * as a user dropping a batch into the uploader), so the comparable times run
 * from there in both modes: indexedAtMs is when the document was indexed
 * (sync: its 201 arrived; async: its job's finishedAt), searchableAtMs when
 * the POST /chat that confirmed it was sent. A sync upload waiting for a free
 * uploader and an async job waiting in the queue both count. sinceSent
 * (searchableMs) is kept, but it starts when the closed-loop uploader sent the
 * request, so it leaves out sync's client-side backlog. Docs/s divides the
 * searchable documents by the time until the last of them was indexed, which
 * the probe's poll interval does not quantize. A level is comparable with
 * another mode only when every upload was accepted and became searchable.
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

  const lastSearchableAtMs = searchable.reduce(
    (latest, result) => (Number.isFinite(result.searchableAtMs) ? Math.max(latest, result.searchableAtMs) : latest),
    0
  );
  const indexed = searchable.filter((result) => Number.isFinite(result.indexedAtMs));
  const lastIndexedAtMs = indexed.reduce((latest, result) => Math.max(latest, result.indexedAtMs), 0);
  const checkedElsewhere = searchable.filter(
    (result) => Number.isInteger(result.checkInstance) && result.checkInstance !== result.instance
  );

  return {
    uploads: completed.length,
    accepted: accepted.length,
    searchable: searchable.length,
    searchableOnOtherInstance: checkedElsewhere.length,
    errors: completed.length - searchable.length,
    errorRate: completed.length > 0 ? round((completed.length - searchable.length) / completed.length, 4) : null,
    comparable: completed.length > 0 && accepted.length === completed.length && searchable.length === completed.length,
    throughputDocsPerSecond: lastSearchableAtMs > 0 ? round(searchable.length / (lastSearchableAtMs / 1000), 2) : null,
    lastSearchableAtMs: lastSearchableAtMs > 0 ? round(lastSearchableAtMs) : null,
    indexedDocsPerSecond:
      indexed.length === searchable.length && lastIndexedAtMs > 0
        ? round(searchable.length / (lastIndexedAtMs / 1000), 2)
        : null,
    lastIndexedAtMs: lastIndexedAtMs > 0 ? round(lastIndexedAtMs) : null,
    offeredToIndexedMs: summarizeLatencies(indexed.map((result) => result.indexedAtMs)),
    offeredToSearchableMs: summarizeLatencies(searchable.map((result) => result.searchableAtMs)),
    wallMs: round(wallMs),
    uploadLatencyMs: summarizeLatencies(accepted.map((result) => result.acceptedMs)),
    queueWaitMs: summarizeLatencies(completed.map((result) => result.queueWaitMs)),
    processingMs: summarizeLatencies(completed.map((result) => result.processingMs)),
    searchableMs: summarizeLatencies(searchable.map((result) => result.searchableMs)),
    statusCounts,
    errorCounts,
  };
};

/** Above this share of the mean, a level's per-instance upload split is flagged. */
export const UPLOAD_IMBALANCE_THRESHOLD = 1.25;

/**
 * How the accepted uploads of a level spread over the instances: count per
 * instance, the largest count over the mean, and whether that exceeds
 * UPLOAD_IMBALANCE_THRESHOLD (only with several instances).
 */
export const summarizeUploadSplit = (results = [], count = 1) => {
  const perInstance = new Array(Math.max(1, count)).fill(0);

  for (const result of results) {
    if (result && isSuccess(result) && Number.isInteger(result.instance) && result.instance < perInstance.length) {
      perInstance[result.instance] += 1;
    }
  }

  const total = perInstance.reduce((sum, value) => sum + value, 0);
  const mean = total / perInstance.length;
  const maxOverMean = mean > 0 ? round(Math.max(...perInstance) / mean, 2) : null;

  return {
    imbalanced: perInstance.length > 1 && maxOverMean !== null && maxOverMean > UPLOAD_IMBALANCE_THRESHOLD,
    maxOverMean,
    perInstance,
  };
};

// Two-sided 95% Student t quantiles by degrees of freedom (1..30); 1.96 above.
const T_95 = [
  null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131,
  2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/**
 * Mean and 95% t-interval of repeated measurements (null values dropped); no
 * interval below two values.
 */
export const meanWithInterval = (values = []) => {
  const samples = values.filter(Number.isFinite);
  const n = samples.length;
  if (n === 0) return { ci95: null, mean: null, n: 0, sd: null };

  const mean = samples.reduce((sum, value) => sum + value, 0) / n;
  if (n < 2) return { ci95: null, mean: round(mean, 2), n, sd: null };

  const sd = Math.sqrt(samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1));
  const half = (T_95[n - 1] ?? 1.96) * (sd / Math.sqrt(n));

  return { ci95: [round(mean - half, 2), round(mean + half, 2)], mean: round(mean, 2), n, sd: round(sd, 2) };
};

/**
 * Background chat interference of one level: p95 and mean during the window
 * minus the mean of the idle baselines before and after it. Null without a
 * during row or without any baseline.
 */
export const chatInterference = (chat = {}) => {
  const during = chat?.duringIngest?.latencyMs;
  const baselines = [chat?.baselineBefore?.latencyMs, chat?.baselineAfter?.latencyMs].filter(Boolean);
  const baselineOf = (field) => {
    const values = baselines.map((latency) => latency?.[field]).filter(Number.isFinite);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const delta = (field) =>
    Number.isFinite(during?.[field]) && baselineOf(field) !== null ? round(during[field] - baselineOf(field)) : null;

  return during ? { meanDeltaMs: delta("mean"), p95DeltaMs: delta("p95") } : null;
};

/**
 * The repeats of each upload concurrency level: mean and 95% t-interval of
 * time to indexed and to searchable (p50 from the offer), indexed docs/s and
 * the background chat's interference, over the comparable repeats only (every
 * upload accepted and searchable). Modes whose intervals overlap are not
 * ranked by that number.
 */
export const summarizeIngestRepeats = (levels = []) => {
  const groups = new Map();

  for (const level of levels) {
    const key = level.uploadConcurrency;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(level);
  }

  return [...groups.entries()].map(([uploadConcurrency, group]) => {
    const comparable = group.filter((level) => level.comparable);
    const pick = (read) => meanWithInterval(comparable.map(read));

    return {
      uploadConcurrency,
      repeats: group.length,
      comparableRepeats: comparable.length,
      chatDuringP95Ms: pick((level) => level.chat?.duringIngest?.latencyMs?.p95),
      chatP95DeltaMs: pick((level) => chatInterference(level.chat)?.p95DeltaMs),
      chatMeanDeltaMs: pick((level) => chatInterference(level.chat)?.meanDeltaMs),
      indexedDocsPerSecond: pick((level) => level.indexedDocsPerSecond),
      offeredToIndexedP50Ms: pick((level) => level.offeredToIndexedMs?.p50),
      offeredToSearchableP50Ms: pick((level) => level.offeredToSearchableMs?.p50),
    };
  });
};

// ---------------------------------------------------------------------------
// Host, harness and PostgreSQL CPU

/**
 * A `ps` CPU time ("[dd-][hh:]mm:ss[.ff]": macOS prints minutes:seconds with
 * hundredths, Linux [dd-]hh:mm:ss) in ms; null when it does not parse.
 */
export const parsePsCpuTime = (text) => {
  const match = String(text ?? "").trim().match(/^(?:(\d+)-)?(\d+(?::\d+)*(?:\.\d+)?)$/);
  if (!match) return null;

  const parts = match[2].split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;

  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round(((Number(match[1] ?? 0) * 86400) + seconds) * 1000);
};

/**
 * CPU time per process of a PostgreSQL cluster, from one `ps -A` listing
 * (`psOutput`: "pid ppid time" lines): the postmaster and every process whose
 * parent it is (backends, background workers). Null without the postmaster.
 */
export const readPostgresProcessCpuFromPs = (psOutput, postmasterPid) => {
  const processes = new Map();
  let found = false;

  for (const line of String(psOutput ?? "").split("\n")) {
    const [pidText, ppidText, time] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const cpuMs = parsePsCpuTime(time);

    if (!Number.isInteger(pid) || cpuMs === null) continue;
    if (pid === postmasterPid) found = true;
    if (pid === postmasterPid || ppid === postmasterPid) processes.set(pid, cpuMs);
  }

  return found ? processes : null;
};

/**
 * CPU of processes over a window from two samples (Map pid -> CPU ms): the
 * difference for processes in both, all of it for a process that started in
 * the window. A process that exited in the window takes its window CPU with
 * it; `exited` counts them, so a sum that misses some says so.
 */
export const diffProcessCpu = (start, end) => {
  if (!(start instanceof Map) || !(end instanceof Map)) return null;
  let cpuMs = 0;
  let started = 0;

  for (const [pid, value] of end) {
    if (start.has(pid)) cpuMs += Math.max(0, value - start.get(pid));
    else {
      cpuMs += value;
      started += 1;
    }
  }

  const exited = [...start.keys()].filter((pid) => !end.has(pid)).length;
  return { cpuMs, exited, processes: end.size, started };
};

/** Busy and total CPU ms summed over the host's logical CPUs (os.cpus()). */
const readHostCpuTimes = () =>
  os.cpus().reduce(
    (total, cpu) => {
      const { idle = 0, irq = 0, nice = 0, sys = 0, user = 0 } = cpu.times ?? {};
      total.busyMs += user + nice + sys + irq;
      total.totalMs += user + nice + sys + irq + idle;
      return total;
    },
    { busyMs: 0, totalMs: 0 }
  );

/** The postmaster pid: the first line of its postmaster.pid file; null otherwise. */
export const readPostmasterPid = async (pidFile) => {
  if (!pidFile) return null;
  try {
    const pid = Number(String(await readFile(pidFile, "utf8")).split("\n")[0].trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const listProcessCpu = () =>
  new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,time="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout)
    );
  });

/**
 * Samples at a window's marks what the app processes do not report
 * themselves: host CPU (every process on the machine), this harness process
 * (load generator and fake model), and the PostgreSQL cluster's processes
 * when the postmaster pid is known (scripts/run-load-test-pgvector.sh passes
 * --postgres-pid-file). `mark()` reads the host and harness counters at once
 * and the PostgreSQL ones from a `ps` listing started right after; `diff`
 * turns two marks into the level's `host` block.
 */
export const createHostSampler = ({ postmasterPid = null, listProcesses = listProcessCpu } = {}) => ({
  mark: async () => {
    const atMs = performance.now();
    const host = readHostCpuTimes();
    const harness = process.cpuUsage();

    if (!Number.isInteger(postmasterPid)) return { atMs, harness, host, postgres: null, postgresAtMs: null };

    // ps reads the counters somewhere while it runs: the midpoint of the call
    // stands for the moment of that listing.
    const listedFrom = performance.now();
    const postgres = readPostgresProcessCpuFromPs(await listProcesses(), postmasterPid);

    return { atMs, harness, host, postgres, postgresAtMs: (listedFrom + performance.now()) / 2 };
  },
  diff: (start, end, { units = 0 } = {}) => summarizeHostWindow(start, end, { units }),
});

/**
 * One window's host block from two marks: cores busy on the whole host, CPU
 * of the harness process and of PostgreSQL (with per-unit costs when `units`
 * is given), each over the time between the marks (PostgreSQL's between its
 * two listings, which run a few ms after the marks; a window of a few ms is
 * too short for them).
 */
export const summarizeHostWindow = (start, end, { units = 0 } = {}) => {
  if (!start || !end) return null;
  const windowMs = end.atMs - start.atMs;
  if (!(windowMs > 0)) return null;
  const perUnit = (value) => (units > 0 && Number.isFinite(value) ? round(value / units, 2) : null);
  const harnessCpuMs =
    start.harness && end.harness
      ? (end.harness.user - start.harness.user + end.harness.system - start.harness.system) / 1000
      : null;
  const hostBusyMs = start.host && end.host ? end.host.busyMs - start.host.busyMs : null;
  const postgres = diffProcessCpu(start.postgres, end.postgres);
  const postgresWindowMs =
    Number.isFinite(start.postgresAtMs) && Number.isFinite(end.postgresAtMs) && end.postgresAtMs > start.postgresAtMs
      ? end.postgresAtMs - start.postgresAtMs
      : windowMs;

  return {
    windowMs: round(windowMs),
    hostCoresBusy: Number.isFinite(hostBusyMs) ? round(hostBusyMs / windowMs, 2) : null,
    harnessCpuMs: round(harnessCpuMs),
    harnessCoresBusy: Number.isFinite(harnessCpuMs) ? round(harnessCpuMs / windowMs, 2) : null,
    postgresCpuMs: postgres ? round(postgres.cpuMs) : null,
    postgresCoresBusy: postgres ? round(postgres.cpuMs / postgresWindowMs, 2) : null,
    postgresCpuMsPerUnit: postgres ? perUnit(postgres.cpuMs) : null,
    postgresProcesses: postgres ? postgres.processes : null,
    postgresProcessesExited: postgres ? postgres.exited : null,
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

const QUESTION_STOPWORDS = new Set([
  "a", "an", "and", "are", "does", "do", "for", "how", "in", "is", "it", "of", "on", "the", "to", "what",
  "when", "where", "which", "who",
]);

const wordsOf = (text) => String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The evidence blocks of an answer prompt, in source order. A block runs from
 * its "Evidence:" line to the next "Source N" header, the prompt's closing
 * "Grounded Answer:" / "Write the answer" line, or the end; blank lines inside
 * it are the chunker's paragraph breaks, not its end.
 */
const readPromptSources = (prompt) => {
  const sources = [];
  const pattern =
    /(?:^|\n)Source (\d+)\n(?:[^\n]*\n)*?Evidence:\n([\s\S]*?)(?=\n\s*\nSource \d+\n|\n\s*\n(?:Grounded Answer:|Write the answer)|$)/g;

  for (const match of prompt.matchAll(pattern)) {
    sources.push({ evidence: match[2].replace(/\s+/g, " ").trim(), label: Number(match[1]) });
  }

  return sources;
};

/**
 * The fake model's reply: the evidence sentence that shares the most content
 * words with the question (the "User Question:" block of the answer prompt),
 * cited as [Source k] of the source it came from; ties go to the lower source
 * and the earlier sentence. Heading-like sentences ("... handbook, section
 * 1.", "... operating manual, part 2.") only win when nothing else matches,
 * and without a question the first other sentence of Source 1 is the answer.
 * So the answer is a short grounded sentence the claim check accepts, and it
 * names the page's fact even when that page was not retrieved first. Without
 * any Source block (planner prompts and the like) it returns a fixed
 * sentence, or "{}" when the request asked for JSON.
 */
export const buildFakeChatAnswer = ({ messages = [], response_format: responseFormat } = {}) => {
  const prompt = messages.map(messageText).join("\n\n");
  const sources = readPromptSources(prompt);

  if (sources.length > 0) {
    const question = prompt.match(/(?:^|\n)(?:User )?Question:[ \t]*\n?([^\n]+)/)?.[1] ?? "";
    const questionWords = new Set(wordsOf(question).filter((word) => !QUESTION_STOPWORDS.has(word)));
    const isHeading = (sentence) => /(?:handbook, section|operating manual, part) \d+\.$/i.test(sentence);
    let best = null;

    for (const source of sources) {
      const sentences = (source.evidence.match(/[^.!?]+[.!?]/g) ?? [source.evidence]).map((sentence) => sentence.trim());

      for (const sentence of sentences) {
        if (!sentence) continue;
        const words = new Set(wordsOf(sentence));
        const overlap = [...questionWords].filter((word) => words.has(word)).length;
        const score = overlap * 2 + (isHeading(sentence) ? 0 : 1);
        if (!best || score > best.score) best = { label: source.label, score, sentence };
      }
    }

    return `${best.sentence.slice(0, 400)} [Source ${best.label}]`;
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
  // In flight is one count for the server's life: a request that arrived
  // before a reset still leaves it when it is answered. Each stats window
  // starts its peak at what is in flight when it opens.
  const inFlight = { chat: 0, embeddings: 0 };
  const freshStats = () => ({
    chat: { peakInFlight: inFlight.chat, requests: 0 },
    embeddings: { inputs: 0, peakInFlight: inFlight.embeddings, requests: 0 },
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
      inFlight[kind] += 1;
      bucket.peakInFlight = Math.max(bucket.peakInFlight, inFlight[kind]);
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          inFlight[kind] -= 1;
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
      stats = freshStats();
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

export const LOAD_TEST_EMBEDDING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cache entries per question: a /chat request embeds each distinct retrieval
 * query of its plan (the question, rewrites, gap-filling queries), about two
 * per question on the synthetic corpus; the bound leaves room for more.
 */
export const QUERY_EMBEDDINGS_PER_QUESTION = 8;

/**
 * Query embedding cache entries the app gets: the app's default 256, or room
 * for every retrieval query of the seed question pool plus the ingest
 * scenario's probe questions when larger, so the warmed pool is never evicted
 * (the cache evicts least recently used). Sized per question, an instance that
 * ran many probe checks evicted seed queries and its background chat paid for
 * query embeddings again after the ingest window.
 */
export const embeddingCacheEntriesFor = (options = {}) => {
  const pool = (options.documents ?? 0) * (options.pages ?? 0);
  const probes =
    options.scenario === "ingest"
      ? (options.uploads ?? 0) * (options.uploadConcurrency?.length ?? 1) * (options.modelLatencyMs?.length ?? 1)
      : 0;

  return Math.max(256, (pool + probes) * QUERY_EMBEDDINGS_PER_QUESTION + 64);
};

/**
 * Headers every request of the run carries: the API key with --auth, and with
 * --tenant the tenant's x-user-id / x-workspace-id, which the app takes as the
 * request's access scope when the principal names none (auth off, or the
 * single API_AUTH_TOKEN). Without --tenant a request has no tenant: PostgreSQL
 * statements run as the owner on the pool, row-level security does not apply
 * and no statement is wrapped in a tenant transaction.
 */
export const buildRequestHeaders = ({ authToken = "", options = {} } = {}) => ({
  ...(options.auth ? { "x-api-key": authToken } : {}),
  ...(options.tenant ? { "x-user-id": LOAD_TEST_TENANT.userId, "x-workspace-id": LOAD_TEST_TENANT.workspaceId } : {}),
});

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
    // Warmed once before the first measured level, the query cache must keep
    // every question for the whole run: a TTL above any run and room for the
    // whole pool (the app's defaults are 10 minutes and 256 entries).
    RAG_EMBEDDING_CACHE_TTL_MS: String(LOAD_TEST_EMBEDDING_CACHE_TTL_MS),
    RAG_EMBEDDING_CACHE_MAX: String(embeddingCacheEntriesFor(options)),
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
  // The seed corpus belongs to the tenant the requests act for.
  if (options.tenant) {
    environment.LOAD_TEST_TENANT_USER_ID = LOAD_TEST_TENANT.userId;
    environment.LOAD_TEST_TENANT_WORKSPACE_ID = LOAD_TEST_TENANT.workspaceId;
  }

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
  if (Number.isInteger(options.ingestWorkerPollMs)) {
    environment.RAG_INGEST_WORKER_POLL_MS = String(options.ingestWorkerPollMs);
  }
  if (Number.isInteger(options.ingestMaxPendingJobs)) {
    environment.RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT = String(options.ingestMaxPendingJobs);
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

  // Waiters per reply type, oldest first: IPC keeps message order, so two
  // stats requests in flight (a level's start and end marks) are answered in
  // the order they were sent.
  const pending = new Map();
  const rejectAll = (error) => {
    for (const queue of pending.values()) for (const entry of queue) entry.reject(error);
    pending.clear();
  };
  let exited = false;
  child.on("message", (message) => {
    const queue = pending.get(message?.type);
    if (queue?.length > 0) {
      const waiter = queue.shift();
      if (queue.length === 0) pending.delete(message.type);
      waiter.resolve(message);
    } else if (message?.type === "error") {
      rejectAll(new Error(message.message));
    }
  });
  child.on("exit", (code) => {
    exited = true;
    rejectAll(new Error(`App process exited with code ${code}.\n${logTail.join("\n")}`));
  });

  const request = (message, replyType, timeoutMs = 600000) =>
    new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error(`App process is not running.\n${logTail.join("\n")}`));
        return;
      }
      const queue = pending.get(replyType) ?? [];
      pending.set(replyType, queue);
      const entry = {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      const timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        reject(new Error(`App process did not answer "${message.type}" within ${timeoutMs} ms.\n${logTail.join("\n")}`));
      }, timeoutMs);
      queue.push(entry);
      child.send(message);
    });

  return {
    logTail,
    start: (documents, { primary = true } = {}) => request({ documents, primary, type: "start" }, "ready"),
    analyze: () => request({ type: "analyze" }, "analyzed", 120000),
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

/**
 * What a process running an ingest worker reports about it: the loops it runs
 * (RAG_INGEST_WORKER_CONCURRENCY, read the way the worker reads it) and how
 * long an idle loop sleeps, from the worker itself where it says so, else from
 * RAG_INGEST_WORKER_POLL_MS where this checkout has that setting. Null
 * without a worker.
 */
const describeIngestWorkerSettings = async (worker) => {
  if (!worker) return null;
  const config = await import("../rag/config.js");
  const idlePollMs = Number.isFinite(worker.pollIntervalMs)
    ? worker.pollIntervalMs
    : typeof config.getRagIngestWorkerPollMs === "function"
      ? config.getRagIngestWorkerPollMs()
      : null;

  return { concurrency: config.getRagIngestWorkerConcurrency(), idlePollMs };
};

/**
 * Counts every statement this process sends to PostgreSQL: each pg
 * client.query call (pooled or dedicated; the BEGIN, SET and COMMIT around a
 * tenant-scoped statement count too). Installed on the pg module the app
 * imports, before the app is loaded; a process without PostgreSQL counts 0.
 */
const installPostgresQueryCounter = async (counter) => {
  const { default: pg } = await import("pg");
  const original = pg.Client.prototype.query;

  if (original.__loadTestCounted) return;
  const counted = function countedQuery(...args) {
    counter.queries += 1;
    return original.apply(this, args);
  };
  counted.__loadTestCounted = true;
  pg.Client.prototype.query = counted;
};

// The model call guard's shared-cap counters of this process (the module the
// app loaded: same URL, same instance); zeros where this checkout has none.
const readGuardTotals = async () => {
  const guard = await import("../rag/model-call-guard.js");
  return typeof guard.getModelCallGuardTotals === "function"
    ? guard.getModelCallGuardTotals()
    : { sharedSlotAcquireCalls: 0, sharedSlotsAcquired: 0 };
};

// Child side, shared by both roles: CPU, PostgreSQL queries, shared-cap
// acquire scripts, event-loop and memory since the last stats message (with
// the window's length), and an exit on shutdown.
const handleChildMessages = (onStart) => {
  const loopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_SAMPLING_MS });
  const postgres = { queries: 0 };
  const counterReady = installPostgresQueryCounter(postgres);
  let cpuMark = process.cpuUsage();
  let queryMark = 0;
  let guardMark = { sharedSlotAcquireCalls: 0, sharedSlotsAcquired: 0 };
  let windowStartedAt = performance.now();
  let stop = null;

  const fail = (error) => {
    process.send?.({ message: String(error?.stack ?? error), type: "error" });
    process.exit(1);
  };
  const resetMarks = (guardTotals = guardMark) => {
    cpuMark = process.cpuUsage();
    queryMark = postgres.queries;
    guardMark = guardTotals;
    windowStartedAt = performance.now();
  };

  process.on("message", async (message) => {
    try {
      if (message?.type === "start") {
        await counterReady;
        const { reply, shutdown } = await onStart(message);
        stop = shutdown;
        loopDelay.enable();
        resetMarks(await readGuardTotals());
        process.send({ ...reply, type: "ready" });
      } else if (message?.type === "stats") {
        const cpu = process.cpuUsage(cpuMark);
        const guardTotals = await readGuardTotals();
        const reply = {
          cpuSystemMs: round(cpu.system / 1000),
          cpuUserMs: round(cpu.user / 1000),
          dbQueries: postgres.queries - queryMark,
          sharedSlotAcquireCalls: guardTotals.sharedSlotAcquireCalls - guardMark.sharedSlotAcquireCalls,
          sharedSlotsAcquired: guardTotals.sharedSlotsAcquired - guardMark.sharedSlotsAcquired,
          eventLoopDelayMaxMs: eventLoopExcessDelayMs(loopDelay.max),
          eventLoopDelayP99Ms: eventLoopExcessDelayMs(loopDelay.percentile(99)),
          rssMb: round(process.memoryUsage().rss / 1024 / 1024),
          type: "stats",
          windowMs: round(performance.now() - windowStartedAt),
        };
        resetMarks(guardTotals);
        loopDelay.reset();
        process.send(reply);
      } else if (message?.type === "analyze") {
        // Planner statistics for the whole (fresh) database, as the owner.
        const startedAt = performance.now();
        const { queryPostgres } = await import("../rag/postgres.js");
        const { runAsDatabaseSystem } = await import("../rag/postgres-tenant.js");
        await runAsDatabaseSystem(() => queryPostgres("ANALYZE"));
        process.send({ ms: round(performance.now() - startedAt), type: "analyzed" });
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
        ownerUserId: process.env.LOAD_TEST_TENANT_USER_ID ?? "",
        pages: doc.pages,
        workspaceId: process.env.LOAD_TEST_TENANT_WORKSPACE_ID ?? "",
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
        ingestWorker: await describeIngestWorkerSettings(worker),
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
      reply: {
        ingestWorker: await describeIngestWorkerSettings(started.worker),
        pid: process.pid,
        port: null,
        workerId: started.worker.workerId,
      },
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wall-clock (epoch) ms of a performance.now() reading. */
export const epochMsOf = (performanceMs) => performance.timeOrigin + performanceMs;

/**
 * Sends one request through the balancer: `instance` pins it (the request
 * still counts as in flight there), otherwise the balancer picks. Resolves to
 * the response result tagged with the instance that served it.
 */
const sendBalanced = async ({ balancer, baseUrls, instance = null, request }) => {
  const chosen = balancer.acquire(instance);

  try {
    const result = await sendHttpRequest({ ...request, baseUrl: baseUrls[chosen] });
    return { ...result, instance: chosen };
  } finally {
    balancer.release(chosen);
  }
};

/**
 * POST /chat sender for a closed loop: the balancer picks the instance (or
 * `instance` pins every request), then the picker gives that instance its next
 * question, so the question never follows from the request's index.
 */
export const createChatSender = ({
  agent,
  balancer,
  baseUrls,
  headers = {},
  instance = null,
  options,
  picker,
  sessionTag,
}) =>
  async ({ workerIndex }) => {
    const chosen = balancer.acquire(instance);

    try {
      const question = picker(chosen);
      const result = await sendHttpRequest({
        agent,
        baseUrl: baseUrls[chosen],
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
      });
      return { ...result, docId: question.docId, instance: chosen, question: question.question };
    } finally {
      balancer.release(chosen);
    }
  };

const collectStats = (processes) => Promise.all(processes.map((child) => child.stats()));

/**
 * Per-instance view of one level: port, requests (and uploads for the ingest
 * scenario) the load generator sent there with their latency percentiles and
 * mean, and that process's own CPU, PostgreSQL queries, event-loop delay and
 * memory (net of its idle rate when one was measured). CPU per request divides
 * by `completions[index]` when given (requests that completed there during the
 * stats window), else by the measured requests.
 */
export const describeInstances = ({ instances, stats, perInstance, uploads = null, idle = null, completions = null }) =>
  instances.map((instance, index) => {
    const { type: _type, ...fields } = stats[index] ?? {};
    const requests = perInstance[index]?.requests ?? 0;
    const divisor = Array.isArray(completions) ? completions[index] ?? 0 : requests;
    const cpuMs = (fields.cpuUserMs ?? 0) + (fields.cpuSystemMs ?? 0);
    const netCpuMs = subtractIdle({
      ratePerSecond: idle?.[index]?.cpuMsPerSecond,
      total: cpuMs,
      windowMs: fields.windowMs,
    });

    return {
      index,
      port: instance.port,
      requests,
      errors: perInstance[index]?.errors ?? 0,
      latencyMs: perInstance[index]?.latencyMs ?? summarizeLatencies([]),
      ...(uploads ? { uploads: uploads[index]?.requests ?? 0 } : {}),
      ...fields,
      coresBusy: Number.isFinite(fields.windowMs) && fields.windowMs > 0 ? round(cpuMs / fields.windowMs, 2) : null,
      cpuMsPerRequest: divisor > 0 ? round(cpuMs / divisor, 2) : null,
      cpuMsPerRequestNetOfIdle: divisor > 0 && netCpuMs !== null ? round(netCpuMs / divisor, 2) : null,
    };
  });

/**
 * Every question of the pool once on every instance, pinned there: each
 * process keeps its own query embedding cache, so after this no measured
 * level pays for a query embedding (with the cache on). Discarded; returns
 * the non-2xx count so a failed warm-up is visible.
 */
const warmQueryCaches = async ({ baseUrls, concurrency, headers, options, questions, sessionTag }) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(1, concurrency) });
  const balancer = createInstanceBalancer({ count: baseUrls.length, mode: options.balance });
  let failures = 0;

  try {
    for (const instance of baseUrls.keys()) {
      const { results } = await runClosedLoop({
        concurrency: Math.max(1, concurrency),
        requests: questions.length,
        send: createChatSender({
          agent,
          balancer,
          baseUrls,
          headers,
          instance,
          options,
          picker: createQuestionPicker({ instanceCount: baseUrls.length, questions }),
          sessionTag: `${sessionTag}-i${instance}`,
        }),
      });
      failures += results.filter((result) => !isSuccess(result)).length;
    }
  } finally {
    agent.destroy();
  }

  return failures;
};

/**
 * The processes' idle cost: nothing is sent for `idleMs`, then each process
 * reports its CPU and PostgreSQL queries over that window. Null when idleMs
 * is 0.
 */
const measureIdle = async ({ idleMs, processes }) => {
  if (!(idleMs > 0) || processes.length === 0) return null;

  await collectStats(processes);
  await sleep(idleMs);
  const stats = await collectStats(processes);

  return stats.map((entry) => idleRatesFromStats(entry));
};

/**
 * ANALYZE on the run's fresh database, once, after the warm-up and before
 * anything is measured: a database in service has planner statistics
 * (autovacuum analyzes within its first naptime), a table created seconds ago
 * does not. Returns the time it took, or null without PostgreSQL.
 */
const analyzeDatabase = async ({ options, primary, storage }) => {
  if (storage !== "pgvector" || !primary || options?.analyze === false) return null;
  const { ms } = await primary.analyze();
  console.log(`[${storage}] ANALYZE after the warm-up: ${ms} ms`);
  return ms;
};

const runLevel = async ({ balancer, baseUrls, concurrency, headers, options, requests, target, sessionTag, warmup, hooks }) => {
  // One agent for every instance: maxSockets applies per origin.
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const send =
    target.kind === "chat"
      ? createChatSender({ agent, balancer, baseUrls, headers, options, picker: target.picker, sessionTag })
      : () =>
          sendBalanced({
            balancer,
            baseUrls,
            request: { agent, headers, method: "GET", path: target.path, timeoutMs: options.requestTimeoutMs },
          });

  try {
    return await runClosedLoop({
      concurrency,
      onMeasureEnd: hooks.onMeasureEnd,
      onMeasureStart: hooks.onMeasureStart,
      requests,
      send,
      steadyState: true,
      warmup,
    });
  } finally {
    agent.destroy();
  }
};

/**
 * The shared-cap polling of a window as a rate: acquire scripts per second of
 * the window (their cost is per second of waiting, not per request) and per
 * model call that took a slot. Null without shared state.
 */
export const describeSharedLimiter = ({ acquireCalls, acquired, wallMs }) =>
  Number.isFinite(acquireCalls) && acquireCalls > 0
    ? {
        acquireCalls,
        acquireCallsPerSecond: wallMs > 0 ? round(acquireCalls / (wallMs / 1000), 1) : null,
        acquireCallsPerSlot: Number.isFinite(acquired) && acquired > 0 ? round(acquireCalls / acquired, 2) : null,
        slotsAcquired: Number.isFinite(acquired) ? acquired : null,
      }
    : null;

const runScenario = async ({ apps, baseUrls, fakeModel, headers, hostSampler, idle, instances, options, profile, runId, target }) => {
  const levels = [];
  const balancer = createInstanceBalancer({ count: baseUrls.length, mode: options.balance });

  for (const concurrency of options.concurrency) {
    const requests = measuredRequestsForLevel({
      concurrency,
      minRequestsPerClient: options.minRequestsPerClient,
      requests: target.kind === "chat" ? options.requests : options.cheapRequests,
    });
    const sessionTag = `load-${runId}-${target.kind}-${profile ?? "na"}-c${concurrency}`;
    const warmup = options.warmup > 0 ? Math.max(options.warmup, concurrency) : 0;
    let statsAtStart = null;
    let statsAtEnd = null;
    let hostAtStart = null;
    let hostAtEnd = null;
    let model = null;

    // Marks taken inside the loop, when the first measured request and the
    // first cool-down request are sent (runClosedLoop's window): exactly the
    // measured count of requests returns between them.
    const hooks = {
      onMeasureEnd: () => {
        model = fakeModel.snapshot();
        statsAtEnd = collectStats(apps);
        hostAtEnd = hostSampler?.mark() ?? null;
      },
      onMeasureStart: () => {
        fakeModel.resetStats();
        statsAtStart = collectStats(apps);
        hostAtStart = hostSampler?.mark() ?? null;
      },
    };
    const { cooldownRequests, results, wallMs, windowCompletions, windowCompletionsByInstance } = await runLevel({
      balancer,
      baseUrls,
      concurrency,
      headers,
      hooks,
      options,
      requests,
      sessionTag,
      target,
      warmup,
    });
    await statsAtStart;
    const serverStats = await statsAtEnd;
    const summary = summarizeLevel({ results, wallMs });
    const host = hostSampler ? hostSampler.diff(await hostAtStart, await hostAtEnd, { units: summary.requests }) : null;
    // Exactly `requests` requests return inside the window (runClosedLoop), so
    // counters read over it divide by that.
    const perRequest = (value) => (summary.requests > 0 ? round(value / summary.requests, 2) : null);
    const combined = combineServerStats(serverStats, summary.requests, { idle });
    const perInstance = summarizeByInstance(results, apps.length);

    levels.push({
      concurrency,
      warmupRequests: warmup,
      cooldownRequests,
      windowCompletions,
      ...summary,
      littleLawMeanMs: littleLawMeanMs(concurrency, summary.throughputRps),
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
      server: {
        coresBusy: combined.coresBusy,
        cpuMsPerRequest: combined.cpuMsPerUnit,
        cpuMsPerRequestNetOfIdle: combined.cpuMsPerUnitNetOfIdle,
        cpuSystemMs: combined.cpuSystemMs,
        cpuUserMs: combined.cpuUserMs,
        dbQueries: combined.dbQueries,
        dbQueriesPerRequest: combined.dbQueriesPerUnit,
        eventLoopDelayMaxMs: combined.eventLoopDelayMaxMs,
        eventLoopDelayP99Ms: combined.eventLoopDelayP99Ms,
        rssMb: combined.rssMb,
        sharedLimiter: describeSharedLimiter({
          acquireCalls: combined.sharedSlotAcquireCalls,
          acquired: combined.sharedSlotsAcquired,
          wallMs,
        }),
      },
      host,
      ...(apps.length > 1
        ? {
            instances: describeInstances({
              completions: windowCompletionsByInstance,
              idle,
              instances,
              perInstance,
              stats: serverStats,
            }),
          }
        : {}),
    });

    const spread =
      apps.length > 1
        ? `  per instance ${perInstance.map((entry) => `${entry.requests} (mean ${entry.latencyMs.mean} ms)`).join(" / ")}`
        : "";
    console.log(
      `  ${target.label.padEnd(26)} c=${String(concurrency).padStart(3)}  ${String(summary.throughputRps).padStart(8)} req/s  mean ${summary.latencyMs.mean} ms  p50 ${summary.latencyMs.p50} ms  p95 ${summary.latencyMs.p95} ms  p99 ${summary.latencyMs.p99} ms (n=${summary.latencyMs.count})  errors ${summary.errors}/${summary.requests}${target.kind === "chat" ? `  peak model in flight ${model.chat.peakInFlight}` : ""}${spread}`
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

// Public job fields only; a failed job's error is a short message by contract.
export const readIngestJob = (body = {}) => ({
  attemptCount: Number.isInteger(body.attemptCount) ? body.attemptCount : null,
  createdAt: typeof body.createdAt === "string" ? body.createdAt : null,
  finishedAt: typeof body.finishedAt === "string" ? body.finishedAt : null,
  jobError: typeof body.error === "string" ? body.error.slice(0, 200) : null,
  jobStatus: typeof body.status === "string" ? body.status : null,
  startedAt: typeof body.startedAt === "string" ? body.startedAt : null,
});

/** A poll or check that says nothing about the document yet and is retried. */
const isRetryableStatus = (status) => status === 0 || status === 408 || status === 429 || status >= 500;

const countStatus = (counts, status) => {
  const key = status ? String(status) : "no_response";
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Fresh counters for the harness's own polling during one window. */
export const createPollingCounters = () => ({ jobPolls: 0, jobPollStatuses: {}, searchChecks: 0, searchCheckStatuses: {} });

/**
 * Polls GET /ingest-jobs/:jobId every poll interval, like the frontend
 * (PdfUploader waits one interval before its first poll), until the job
 * succeeded or failed or the deadline passed. The balancer picks the instance,
 * as a proxy would. A 404 is a failure, not a retry: the job was accepted by
 * this deployment, so every instance must find it.
 */
const waitForIngestJob = async ({ agent, balancer, baseUrls, deadline, headers, jobId, options, polling }) => {
  let polls = 0;
  let last = null;

  while (performance.now() < deadline) {
    await sleep(options.pollIntervalMs);
    polls += 1;
    polling.jobPolls += 1;
    last = await sendBalanced({
      balancer,
      baseUrls,
      request: {
        agent,
        headers,
        method: "GET",
        parse: (body) => readIngestJob(body),
        path: `/ingest-jobs/${encodeURIComponent(jobId)}`,
        timeoutMs: options.requestTimeoutMs,
      },
    });
    countStatus(polling.jobPollStatuses, last.status);

    if (last.status === 200 && (last.jobStatus === "succeeded" || last.jobStatus === "failed")) {
      return { ...last, polls };
    }
    if (last.status !== 200 && !isRetryableStatus(last.status)) {
      return { ...last, jobStatus: null, polls };
    }
  }

  return { ...last, jobStatus: "timeout", polls };
};

const normalizeForMatch = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Whether `text` contains `phrase` as whole words (case and spacing ignored). */
export const containsPhrase = (text, phrase) => {
  const needle = normalizeForMatch(phrase);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u").test(normalizeForMatch(text));
};

/**
 * Whether a POST /chat body shows the uploaded document is searchable: the
 * answer states the probe's expected fact and at least one citation
 * (ragSources) names the document. Both are required; an answer that cites
 * the document without the fact, or states it without citing it, is not.
 */
export const readSearchableAnswer = (body = {}, { docId, expected }) => {
  const answer = String(body?.agentAnswer ?? body?.ragAnswer ?? "");
  const sources = Array.isArray(body?.ragSources) ? body.ragSources : [];
  const hasFact = containsPhrase(answer, expected);
  const cited = sources.some((source) => source?.docId === docId);

  return {
    cited,
    hasFact,
    searchable: hasFact && cited,
    ...(hasFact && cited ? {} : { answerExcerpt: answer.replace(/\s+/g, " ").trim().slice(0, 160) }),
  };
};

/**
 * Asks POST /chat on `checkInstance` the document's probe question with
 * docIds [docId] until the answer is grounded (readSearchableAnswer), every
 * poll interval while the document is not found (404) or the server is busy
 * or unavailable. A 2xx without the fact or the citation, or another client
 * error, ends the check: the document is there and the answer is wrong. The
 * searchable moment is when the successful request was sent.
 */
const waitUntilSearchable = async ({
  agent,
  balancer,
  baseUrls,
  checkInstance,
  deadline,
  docId,
  headers,
  options,
  polling,
  probe,
  sessionTag,
}) => {
  let checks = 0;
  let lastStatus = null;

  for (;;) {
    if (performance.now() >= deadline) {
      return { checks, error: "searchable_timeout", lastStatus };
    }
    checks += 1;
    polling.searchChecks += 1;
    const sentAt = performance.now();
    const response = await sendBalanced({
      balancer,
      baseUrls,
      instance: checkInstance,
      request: {
        agent,
        body: { docIds: [docId], question: probe.question, sessionId: `${sessionTag}-probe-${docId}` },
        headers,
        method: "POST",
        parse: (body, status) =>
          status >= 200 && status < 300 ? readSearchableAnswer(body, { docId, expected: probe.expected }) : {},
        path: "/chat",
        timeoutMs: options.requestTimeoutMs,
      },
    });
    const latencyMs = performance.now() - sentAt;
    lastStatus = response.status;
    countStatus(polling.searchCheckStatuses, response.status);

    if (isSuccess(response)) {
      return response.searchable
        ? { checks, latencyMs, sentAt }
        : {
            answerExcerpt: response.answerExcerpt ?? null,
            checks,
            error: response.hasFact ? "answer_without_citation" : response.cited ? "answer_without_fact" : "answer_not_grounded",
            lastStatus,
          };
    }
    if (response.status !== 404 && !isRetryableStatus(response.status)) {
      return { checks, error: response.error ?? `search_http_${response.status}`, lastStatus };
    }
    await sleep(options.pollIntervalMs);
  }
};

/**
 * The instance that confirms a document is searchable: the next one after
 * the instance that took the upload, so with several instances searchability
 * is proven on a process that did not ingest it.
 */
export const visibilityCheckInstance = (uploadInstance, count) => (count > 1 ? (uploadInstance + 1) % count : uploadInstance);

/**
 * Uploads one PDF and follows it until it is searchable. The upload request
 * resolves the returned promise's `accepted` part as soon as the 201/202
 * arrives, so the uploader's closed loop moves on while the document is
 * still being followed in `settled`. `instance` pins the upload (the balancer
 * picks otherwise) and `checkInstance` the searchable check (the next
 * instance otherwise).
 */
const uploadAndTrack = async ({
  agent,
  balancer,
  baseUrls,
  checkInstance = null,
  document,
  headers,
  instance = null,
  measurementBalancer = balancer,
  options,
  polling,
  sessionTag,
  startedAt,
  windowStartedAt = startedAt,
}) => {
  const boundary = `----archive-load-test-${randomBytes(8).toString("hex")}`;
  const response = await sendBalanced({
    balancer,
    baseUrls,
    instance,
    request: {
      agent,
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      method: "POST",
      parse: (body, status) =>
        status === 201 || status === 202
          ? { docId: body.docId ?? null, jobId: body.jobId ?? null }
          : { serverError: typeof body.error === "string" ? body.error.slice(0, 200) : null },
      path: "/upload",
      rawBody: buildMultipartFileBody({ boundary, content: document.pdf, fileName: document.fileName }),
      timeoutMs: options.requestTimeoutMs,
    },
  });
  const acceptedAt = performance.now();
  const acceptedMs = acceptedAt - startedAt;
  const result = { acceptedMs, docId: response.docId ?? null, instance: response.instance, status: response.status };

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
    result.checkInstance = checkInstance ?? visibilityCheckInstance(response.instance, baseUrls.length);

    if (response.status === 202) {
      // Async: the job reports done first, with its own timestamps.
      const job = await waitForIngestJob({
        agent,
        balancer: measurementBalancer,
        baseUrls,
        deadline,
        headers,
        jobId: response.jobId,
        options,
        polling,
      });
      result.jobId = response.jobId;
      result.jobPolls = job.polls;
      result.attemptCount = job.attemptCount;
      Object.assign(result, jobTimingsMs(job));
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
      result.ingestedMs = performance.now() - startedAt;
      // Indexed when the job finished, by the job's own clock (the job
      // store's, on this host), not when a poll happened to see it.
      const finishedAt = typeof job.finishedAt === "string" ? Date.parse(job.finishedAt) : Number.NaN;
      if (Number.isFinite(finishedAt)) result.indexedAtMs = finishedAt - epochMsOf(windowStartedAt);
    } else {
      // Sync: the 201 is the ingest done.
      result.ingestedMs = acceptedMs;
      result.indexedAtMs = acceptedAt - windowStartedAt;
    }

    const check = await waitUntilSearchable({
      agent,
      balancer: measurementBalancer,
      baseUrls,
      checkInstance: result.checkInstance,
      deadline,
      docId: result.docId,
      headers,
      options,
      polling,
      probe: document.probe,
      sessionTag,
    });
    result.searchChecks = check.checks;
    if (Number.isFinite(check.sentAt)) {
      result.searchableMs = check.sentAt - startedAt;
      result.searchableAtMs = check.sentAt - windowStartedAt;
      result.searchCheckLatencyMs = check.latencyMs;
    } else {
      result.error = check.error;
      if (check.lastStatus !== null) result.lastCheckStatus = check.lastStatus;
      if (check.answerExcerpt) result.answerExcerpt = check.answerExcerpt;
    }
    return result;
  })();

  return { accepted: result, settled };
};

// Uploads and the background chat are the workload and share `balancer`, as
// behind one proxy. The harness's own job polls and searchable checks go
// through `measurementBalancer`, so their requests in flight (a probe waits
// on its query embedding) never steer where the workload goes.
export const runIngestLevel = async ({
  balancer,
  baseUrls,
  documents,
  headers,
  measurementBalancer,
  options,
  picker,
  sessionTag,
  uploadConcurrency,
  hooks,
}) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: uploadConcurrency + options.chatConcurrency + 64 });
  const trackers = [];
  const polling = createPollingCounters();
  let ingestDone = false;
  let fatalError = null;

  try {
    hooks.onWindowStart();
    const windowStartedAt = performance.now();
    const chat = runClosedLoopUntil({
      concurrency: options.chatConcurrency,
      send: createChatSender({ agent, balancer, baseUrls, headers, options, picker, sessionTag }),
      shouldStop: () => ingestDone,
    });
    const uploads = await runClosedLoop({
      concurrency: uploadConcurrency,
      requests: documents.length,
      send: async ({ index }) => {
        if (fatalError) return { error: "skipped", status: 0 };
        try {
          const { accepted, settled } = await uploadAndTrack({
            agent,
            balancer,
            baseUrls,
            document: documents[index],
            headers,
            measurementBalancer,
            options,
            polling,
            sessionTag,
            startedAt: performance.now(),
            windowStartedAt,
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
    hooks.onWindowEnd();
    const chatDuring = await chat;

    return { chat: chatDuring, polling, results, wallMs };
  } finally {
    ingestDone = true;
    agent.destroy();
  }
};

const runChatWindow = async ({ balancer, baseUrls, durationMs, headers, options, picker, sessionTag }) => {
  if (options.chatConcurrency <= 0 || durationMs <= 0) return null;
  const agent = new http.Agent({ keepAlive: true, maxSockets: options.chatConcurrency });
  const startedAt = performance.now();

  try {
    return await runClosedLoopUntil({
      concurrency: options.chatConcurrency,
      send: createChatSender({ agent, balancer, baseUrls, headers, options, picker, sessionTag }),
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
 * its baselines), then one upload per instance, pinned there and checked on
 * that same instance (first-use costs such as loading pdf.js and the probe's
 * /chat path). Runs at 0 ms model latency.
 */
const warmUpIngestScenario = async ({ baseUrls, headers, options, questions, runId }) => {
  if (options.chatConcurrency > 0) {
    await warmQueryCaches({
      baseUrls,
      concurrency: options.chatConcurrency,
      headers,
      options,
      questions,
      sessionTag: `load-${runId}-ingest-warm`,
    });
  }

  const agent = new http.Agent({ keepAlive: true, maxSockets: baseUrls.length * 2 + 4 });
  const balancer = createInstanceBalancer({ count: baseUrls.length, mode: options.balance });

  try {
    const documents = buildIngestDocuments({ documents: baseUrls.length, pages: 1, tag: "warm" });
    const tracked = await Promise.all(
      documents.map((document, instance) =>
        uploadAndTrack({
          agent,
          balancer,
          baseUrls,
          checkInstance: instance,
          document,
          headers,
          instance,
          options,
          polling: createPollingCounters(),
          sessionTag: `load-${runId}-ingest-warm`,
          startedAt: performance.now(),
        })
      )
    );
    const settled = await Promise.all(tracked.map((entry) => entry.settled));
    const failed = settled.filter((result) => !Number.isFinite(result.searchableMs));

    if (failed.length > 0) {
      throw new Error(
        `Warm-up upload did not become searchable on the instance that took it: ${failed
          .map(
            (result) =>
              `${result.jobError ?? result.serverError ?? result.error ?? `http_${result.status}`}${result.answerExcerpt ? ` (answer: "${result.answerExcerpt}")` : ""}`
          )
          .join("; ")}`
      );
    }
  } finally {
    agent.destroy();
  }
};

/** Polling the harness did during a window, as its own load. */
export const summarizePolling = (polling, wallMs) => {
  const requests = (polling?.jobPolls ?? 0) + (polling?.searchChecks ?? 0);

  return {
    jobPolls: polling?.jobPolls ?? 0,
    jobPollStatuses: polling?.jobPollStatuses ?? {},
    requests,
    requestsPerSecond: wallMs > 0 ? round(requests / (wallMs / 1000), 2) : null,
    searchChecks: polling?.searchChecks ?? 0,
    searchCheckStatuses: polling?.searchCheckStatuses ?? {},
  };
};

/**
 * Ingest parallelism: how many documents the deployment can ingest at once.
 * Sync mode ingests inside the upload request, so up to the upload
 * concurrency; async mode runs `workerLoops` claim loops (worker processes, or
 * API processes with a worker, times RAG_INGEST_WORKER_CONCURRENCY). Matched
 * parallelism means async loops equal to the sync upload concurrency.
 */
export const describeIngestParallelism = ({ ingestMode, uploadConcurrency, workerLoops }) =>
  ingestMode === "async"
    ? { documentsAtOnce: workerLoops, source: "worker loops" }
    : { documentsAtOnce: uploadConcurrency, source: "in-flight uploads" };

/**
 * API CPU the searchable checks cost during the window, estimated from the
 * baselines: each check is a POST /chat, so checks times the baselines' API
 * CPU per chat request (mean of before and after). The share is of the
 * window's API CPU. Null without a baseline CPU figure.
 */
export const estimateProbeCpu = ({ baselineCpuMsPerChat, searchChecks, windowCpuMs }) =>
  Number.isFinite(baselineCpuMsPerChat) && Number.isFinite(searchChecks)
    ? {
        cpuMs: round(searchChecks * baselineCpuMsPerChat),
        shareOfApiCpu:
          Number.isFinite(windowCpuMs) && windowCpuMs > 0 ? round((searchChecks * baselineCpuMsPerChat) / windowCpuMs, 3) : null,
      }
    : null;

// A baseline window with the API processes' CPU over it (the stats calls
// reset every process's marks, so the ingest window's own marks follow).
const runBaselineWindow = async ({ apps, ...window }) => {
  if (window.options.chatConcurrency <= 0 || window.durationMs <= 0) return null;
  await collectStats(apps);
  const run = await runChatWindow(window);
  const stats = await collectStats(apps);
  const summary = summarizeLevel(run);
  const combined = combineServerStats(stats, summary.requests);

  return { ...summary, server: { coresBusy: combined.coresBusy, cpuMsPerRequest: combined.cpuMsPerUnit } };
};

const runIngestScenario = async ({ apps, baseUrls, corpus, fakeModel, headers, hostSampler, idle, instances, options, profile, runId, workerLoops, workers }) => {
  const levels = [];
  // The workload (uploads and background chat) and the harness's own
  // measurement traffic (job polls and searchable checks) are balanced
  // separately; see runIngestLevel.
  const balancer = createInstanceBalancer({ count: baseUrls.length, mode: options.balance });
  const measurementBalancer = createInstanceBalancer({ count: baseUrls.length, mode: options.balance });
  const picker = createQuestionPicker({ instanceCount: baseUrls.length, questions: corpus.questions });
  const processes = [...apps, ...workers];
  const runs = options.uploadConcurrency.flatMap((uploadConcurrency, levelIndex) =>
    Array.from({ length: options.repeat ?? 1 }, (_, repeatIndex) => ({ levelIndex, repeatIndex, uploadConcurrency }))
  );

  for (const { levelIndex, repeatIndex, uploadConcurrency } of runs) {
    const tag = `p${profile}c${uploadConcurrency}l${levelIndex + 1}r${repeatIndex + 1}`;
    const documents = buildIngestDocuments({ documents: options.uploads, pages: options.ingestPages, tag });
    const sessionTag = `load-${runId}-ingest-${tag}`;

    // The same chat load with nothing being ingested, before and after the
    // window: the database grows during the window, so both sides are kept.
    const baselineBefore = await runBaselineWindow({
      apps,
      balancer,
      baseUrls,
      durationMs: options.baselineMs,
      headers,
      options,
      picker,
      sessionTag: `${sessionTag}-before`,
    });

    let statsAtStart = null;
    let statsAtEnd = null;
    let hostAtStart = null;
    let hostAtEnd = null;
    let model = null;
    const { chat, polling, results, wallMs } = await runIngestLevel({
      balancer,
      baseUrls,
      documents,
      headers,
      hooks: {
        onWindowEnd: () => {
          model = fakeModel.snapshot();
          statsAtEnd = collectStats(processes);
          hostAtEnd = hostSampler?.mark() ?? null;
        },
        onWindowStart: () => {
          fakeModel.resetStats();
          statsAtStart = collectStats(processes);
          hostAtStart = hostSampler?.mark() ?? null;
        },
      },
      measurementBalancer,
      options,
      picker,
      sessionTag,
      uploadConcurrency,
    });
    await statsAtStart;
    const allStats = await statsAtEnd;
    const apiStats = allStats.slice(0, apps.length);
    const workerStats = allStats.slice(apps.length);
    const apiIdle = idle ? idle.slice(0, apps.length) : null;
    const workerIdle = idle ? idle.slice(apps.length) : null;
    const ingest = summarizeIngestLevel({ results, wallMs });
    const apiCombined = combineServerStats(apiStats, ingest.searchable, { idle: apiIdle });
    const workerCombined = workers.length > 0 ? combineServerStats(workerStats, ingest.searchable, { idle: workerIdle }) : null;
    const host = hostSampler ? hostSampler.diff(await hostAtStart, await hostAtEnd, { units: ingest.searchable }) : null;

    const baselineAfter = await runBaselineWindow({
      apps,
      balancer,
      baseUrls,
      durationMs: options.baselineMs,
      headers,
      options,
      picker,
      sessionTag: `${sessionTag}-after`,
    });
    const chatDuring = options.chatConcurrency > 0 ? summarizeLevel(chat) : null;
    const serverFields = (combined) => ({
      coresBusy: combined.coresBusy,
      cpuMsPerDocument: combined.cpuMsPerUnit,
      cpuMsPerDocumentNetOfIdle: combined.cpuMsPerUnitNetOfIdle,
      cpuSystemMs: combined.cpuSystemMs,
      cpuUserMs: combined.cpuUserMs,
      dbQueries: combined.dbQueries,
      dbQueriesPerDocument: combined.dbQueriesPerUnit,
      eventLoopDelayMaxMs: combined.eventLoopDelayMaxMs,
      eventLoopDelayP99Ms: combined.eventLoopDelayP99Ms,
      rssMb: combined.rssMb,
    });
    const baselineCpu = [baselineBefore, baselineAfter]
      .map((row) => row?.server?.cpuMsPerRequest)
      .filter(Number.isFinite);
    const pollingSummary = summarizePolling(polling, wallMs);
    const chatRows = {
      baselineAfter,
      baselineBefore,
      concurrency: options.chatConcurrency,
      duringIngest: chatDuring,
    };

    levels.push({
      uploadConcurrency,
      repeat: repeatIndex + 1,
      documentPages: options.ingestPages,
      pdfBytesMean: round(documents.reduce((sum, document) => sum + document.pdf.length, 0) / documents.length),
      visibilityCheck: baseUrls.length > 1 ? "other_instance" : "same_instance",
      ingestParallelism: describeIngestParallelism({ ingestMode: options.ingestMode, uploadConcurrency, workerLoops }),
      ...ingest,
      uploadSplit: summarizeUploadSplit(results, apps.length),
      polling: {
        ...pollingSummary,
        estimatedProbeApiCpu: estimateProbeCpu({
          baselineCpuMsPerChat:
            baselineCpu.length > 0 ? baselineCpu.reduce((sum, value) => sum + value, 0) / baselineCpu.length : null,
          searchChecks: pollingSummary.searchChecks,
          windowCpuMs: (apiCombined.cpuUserMs ?? 0) + (apiCombined.cpuSystemMs ?? 0),
        }),
      },
      chat: { ...chatRows, interference: chatInterference(chatRows) },
      model: {
        peakChatInFlight: observedPeakInFlight({ latencyMs: profile, peak: model.chat.peakInFlight }),
        peakEmbeddingsInFlight: observedPeakInFlight({
          latencyMs: options.embeddingLatencyMs,
          peak: model.embeddings.peakInFlight,
        }),
        ...model,
      },
      server: serverFields(apiCombined),
      host,
      workers: workerCombined
        ? {
            ...serverFields(workerCombined),
            count: workers.length,
            perProcess: workerStats.map(({ type: _type, ...stats }, index) => ({ index, ...stats })),
          }
        : null,
      ...(apps.length > 1
        ? {
            instances: describeInstances({
              idle: apiIdle,
              instances,
              perInstance: summarizeByInstance(chat?.results ?? [], apps.length),
              stats: apiStats,
              uploads: summarizeByInstance(results, apps.length),
            }),
          }
        : {}),
      failures: results
        .filter((result) => result && !Number.isFinite(result.searchableMs))
        .slice(0, 5)
        .map((result) => ({
          error: result.error ?? null,
          instance: result.instance,
          checkInstance: result.checkInstance ?? null,
          answerExcerpt: result.answerExcerpt ?? null,
          jobError: result.jobError ?? null,
          lastCheckStatus: result.lastCheckStatus ?? null,
          serverError: result.serverError ?? null,
          status: result.status,
        })),
    });

    const level = levels.at(-1);
    console.log(
      `  POST /upload (${options.ingestMode}) c=${String(uploadConcurrency).padStart(3)} r${repeatIndex + 1}  ${ingest.searchable}/${ingest.uploads} searchable${ingest.comparable ? "" : " (not comparable)"}  from offer: indexed p50 ${ingest.offeredToIndexedMs.p50} ms, searchable p50 ${ingest.offeredToSearchableMs.p50} ms  ${ingest.indexedDocsPerSecond} docs/s  uploads per instance ${level.uploadSplit.perInstance.join("/")}${level.uploadSplit.imbalanced ? " (imbalanced)" : ""}${options.ingestMode === "async" ? `  queue wait p50 ${ingest.queueWaitMs.p50} ms  processing p50 ${ingest.processingMs.p50} ms` : ""}  polling ${pollingSummary.requestsPerSecond} req/s  chat p95 ${chatDuring?.latencyMs.p95 ?? "-"} ms (idle ${baselineBefore?.latencyMs.p95 ?? "-"}/${baselineAfter?.latencyMs.p95 ?? "-"})`
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
    repeats: summarizeIngestRepeats(levels),
  };
};

// ---------------------------------------------------------------------------
// Report

const readGit = (args, { cwd = serverDirectory, trim = true } = {}) => {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return trim ? output.trim() : output;
  } catch {
    return null;
  }
};

/** Paths of `git status --porcelain` lines (the new path of a rename). */
export const parseGitStatusPaths = (porcelain = "") =>
  String(porcelain)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 3)
    .map((line) => {
      const pathPart = line.slice(3);
      const arrow = pathPart.indexOf(" -> ");
      return arrow >= 0 ? pathPart.slice(arrow + 4) : pathPart;
    });

/**
 * One hash for the measured working tree on top of its commit: the binary
 * diff of tracked files against HEAD plus the path and content hash of every
 * untracked (not ignored) file. Equal hashes on the same SHA mean the same
 * code; the report keeps it next to the dirty flag.
 */
export const hashWorktreeState = ({ diff = "", untracked = [] } = {}) => {
  const hash = createHash("sha256");
  hash.update("tracked-diff\0");
  hash.update(diff);

  for (const entry of [...untracked].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    hash.update(`\0untracked\0${entry.path}\0${entry.contentSha256}`);
  }

  return hash.digest("hex");
};

export const MAX_REPORTED_CHANGED_FILES = 200;

/**
 * The code a run measures, read once before any app process starts: HEAD,
 * whether the worktree is dirty, and for a dirty one the worktree hash and
 * the changed paths (relative to the repository root). Every git command runs
 * from the repository root whatever `cwd` is inside it: `git ls-files` prints
 * paths relative to its working directory and lists only files under it, so
 * from server/ it would miss untracked files elsewhere and name the rest
 * relative to server/. An untracked file that cannot be read fails the run
 * rather than being hashed by name only.
 */
export const readWorktreeState = async ({ cwd = serverDirectory } = {}) => {
  const root = readGit(["rev-parse", "--show-toplevel"], { cwd });
  const gitSha = root ? readGit(["rev-parse", "HEAD"], { cwd: root }) : null;
  const porcelain = gitSha
    ? readGit(["status", "--porcelain", "--untracked-files=all"], { cwd: root, trim: false }) ?? ""
    : "";
  const changedFiles = parseGitStatusPaths(porcelain);

  if (!gitSha || changedFiles.length === 0) {
    return { gitChangedFiles: [], gitDiffSha256: null, gitDirty: false, gitSha };
  }

  const diff = readGit(["diff", "HEAD", "--binary"], { cwd: root, trim: false }) ?? "";
  const untrackedPaths = (readGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, trim: false }) ?? "")
    .split("\0")
    .filter(Boolean);
  const untracked = [];
  for (const relativePath of untrackedPaths) {
    let content;
    try {
      content = await readFile(path.join(root, relativePath));
    } catch (error) {
      throw new Error(
        `Cannot read the untracked file ${relativePath} for the worktree hash (${error?.code ?? error?.message ?? error}); the report could not say which code it measured.`
      );
    }
    untracked.push({ contentSha256: createHash("sha256").update(content).digest("hex"), path: relativePath });
  }

  return {
    gitChangedFiles: changedFiles.slice(0, MAX_REPORTED_CHANGED_FILES),
    gitChangedFileCount: changedFiles.length,
    gitDiffSha256: hashWorktreeState({ diff, untracked }),
    gitDirty: true,
    gitSha,
  };
};

/**
 * sha256 of this harness file as it is on disk when the run starts: which
 * harness revision wrote a report, whatever else in the worktree changed.
 */
export const readHarnessSha256 = async (filePath = __filename) =>
  createHash("sha256").update(await readFile(filePath)).digest("hex");

const readSysctl = (name) => {
  try {
    return execFileSync("sysctl", ["-n", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/**
 * CPU core tiers where the OS reports them (macOS hw.perflevelN: Apple
 * silicon's fastest tier first); null elsewhere or on one tier.
 */
const readCpuTopology = () => {
  if (os.platform() !== "darwin") return null;
  const levels = Number(readSysctl("hw.nperflevels"));
  if (!Number.isInteger(levels) || levels < 2) return null;

  return Array.from({ length: levels }, (_, level) => ({
    logicalCpus: Number(readSysctl(`hw.perflevel${level}.logicalcpu`)) || null,
    name: readSysctl(`hw.perflevel${level}.name`) || `level ${level}`,
  }));
};

/** "5 Super + 10 Performance" (fastest tier first), or null. */
export const formatCpuTopology = (topology) =>
  Array.isArray(topology) && topology.length > 0
    ? topology.map((tier) => `${cell(tier.logicalCpus)} ${tier.name}`).join(" + ")
    : null;

const formatVectorStore = (runtime) =>
  runtime
    ? `${runtime.vectorStoreProvider} (dense ${runtime.denseBackend}, sparse ${runtime.sparseBackend ?? "off"}${
        runtime.hybridFusion ? `, ${runtime.hybridFusion} fusion` : ""
      })`
    : "unknown";

const cell = (value) => (value === null || value === undefined ? "-" : String(value));

const formatErrorCounts = (errorCounts = {}) =>
  Object.entries(errorCounts)
    .map(([reason, count]) => `${reason} x${count}`)
    .join(", ");

const formatStatusCounts = (statusCounts = {}) =>
  Object.entries(statusCounts)
    .map(([status, count]) => `${status} x${count}`)
    .join(", ") || "-";

/** Latency cells: n, mean, p50, p95, p99, max. */
const latencyCells = (latency = {}) =>
  [latency.count ?? 0, latency.mean, latency.p50, latency.p95, latency.p99, latency.max].map(cell).join(" | ");

const LATENCY_HEADER = "n | Mean ms | p50 ms | p95 ms | p99 ms | Max ms";
const LATENCY_RULE = "---: | ---: | ---: | ---: | ---: | ---:";

const formatIngestParallelism = (parallelism) =>
  parallelism ? `${cell(parallelism.documentsAtOnce)} (${parallelism.source})` : "-";

const formatInterval = (stat) =>
  stat && Number.isFinite(stat.mean)
    ? `${stat.mean}${Array.isArray(stat.ci95) ? ` [${stat.ci95[0]}, ${stat.ci95[1]}]` : ""} (n=${stat.n})`
    : "-";

// Host, harness and PostgreSQL CPU of each row's window (createHostSampler).
const formatHostRows = (lines, rows, { label, unit }) => {
  const withHost = rows.filter((row) => row.host);
  if (withHost.length === 0) return;

  lines.push(
    "",
    `Host CPU over each window (all processes on the host; harness = load generator and fake model; PostgreSQL = the postmaster and its children, sampled with ps at the window marks):`,
    "",
    `| ${label} | Window ms | Host cores busy | Harness cores busy | PostgreSQL cores busy | PostgreSQL CPU ms/${unit} | PostgreSQL processes (exited in window) |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const row of withHost) {
    const host = row.host;
    lines.push(
      `| ${row.key} | ${cell(host.windowMs)} | ${cell(host.hostCoresBusy)} | ${cell(host.harnessCoresBusy)} | ${cell(host.postgresCoresBusy)} | ${cell(host.postgresCpuMsPerUnit)} | ${host.postgresProcesses === null || host.postgresProcesses === undefined ? "-" : `${host.postgresProcesses} (${cell(host.postgresProcessesExited)})`} |`
    );
  }
};

const formatIngestScenario = (lines, scenario, multiInstance) => {
  const async = scenario.ingestMode === "async";
  const levelKey = (level) => `${level.uploadConcurrency}${Number.isInteger(level.repeat) ? ` r${level.repeat}` : ""}`;

  lines.push(
    `Searchable: POST /chat on ${multiInstance ? "another instance than the one that took the upload" : "the instance"} answers the document's probe question with its fact and a citation of the document (docIds [docId]).`,
    "",
    "From the offer: every document of a level is offered when the window opens (a batch dropped into the uploader), so these times include a sync upload's wait for a free uploader and an async job's wait in the queue alike. Indexed = the 201 (sync) or the job's finishedAt (async); searchable = the confirming POST /chat was sent. Docs/s = searchable documents / time until the last was indexed. Only comparable rows (every upload accepted and searchable) compare across modes.",
    "",
    "| Upload concurrency | Ingest parallelism | Accepted / uploads | Searchable | Comparable | Indexed n | Indexed p50 ms | Indexed p95 ms | Last indexed ms | Searchable p50 ms | Searchable p95 ms | Docs/s |",
    "| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const level of scenario.levels) {
    lines.push(
      `| ${levelKey(level)} | ${formatIngestParallelism(level.ingestParallelism)} | ${cell(level.accepted)} / ${cell(level.uploads)} | ${cell(level.searchable)} | ${level.comparable === false ? "no" : level.comparable ? "yes" : "-"} | ${cell(level.offeredToIndexedMs?.count ?? 0)} | ${cell(level.offeredToIndexedMs?.p50)} | ${cell(level.offeredToIndexedMs?.p95)} | ${cell(level.lastIndexedAtMs)} | ${cell(level.offeredToSearchableMs?.p50)} | ${cell(level.offeredToSearchableMs?.p95)} | ${cell(level.indexedDocsPerSecond)} |`
    );
  }

  lines.push(
    "",
    "Per request, from when the closed-loop uploader sent it (sync's client-side backlog is not in these; kept for comparison with older reports):",
    "",
    `| Upload concurrency | Upload n | Upload p50 ms | Upload p95 ms | Searchable n | Searchable p50 ms | Searchable p95 ms | Searchable max ms | Docs/s (probe time) |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`
  );
  for (const level of scenario.levels) {
    lines.push(
      `| ${levelKey(level)} | ${cell(level.uploadLatencyMs?.count ?? 0)} | ${cell(level.uploadLatencyMs?.p50)} | ${cell(level.uploadLatencyMs?.p95)} | ${cell(level.searchableMs?.count ?? 0)} | ${cell(level.searchableMs?.p50)} | ${cell(level.searchableMs?.p95)} | ${cell(level.searchableMs?.max)} | ${cell(level.throughputDocsPerSecond)} |`
    );
  }

  if (async) {
    lines.push(
      "",
      "Server-side job timings (job store timestamps: queue wait = startedAt - createdAt, processing = finishedAt - startedAt):",
      "",
      "| Upload concurrency | Queue wait n | Queue wait p50 ms | Queue wait p95 ms | Queue wait max ms | Processing n | Processing p50 ms | Processing p95 ms | Processing max ms |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const level of scenario.levels) {
      const queue = level.queueWaitMs ?? {};
      const processing = level.processingMs ?? {};
      lines.push(
        `| ${levelKey(level)} | ${cell(queue.count ?? 0)} | ${cell(queue.p50)} | ${cell(queue.p95)} | ${cell(queue.max)} | ${cell(processing.count ?? 0)} | ${cell(processing.p50)} | ${cell(processing.p95)} | ${cell(processing.max)} |`
      );
    }
  }

  lines.push(
    "",
    "Cost over the ingest window (net of idle: minus each process's idle rate times the window):",
    "",
    "| Upload concurrency | Embedding requests (inputs) | Peak embeddings in flight | API CPU ms/doc | API CPU ms/doc net of idle | API cores busy | API DB queries/doc | Worker CPU ms/doc | Worker CPU ms/doc net of idle | Worker cores busy |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const level of scenario.levels) {
    lines.push(
      `| ${levelKey(level)} | ${cell(level.model?.embeddings?.requests)} (${cell(level.model?.embeddings?.inputs)}) | ${cell(level.model?.peakEmbeddingsInFlight)} | ${cell(level.server?.cpuMsPerDocument)} | ${cell(level.server?.cpuMsPerDocumentNetOfIdle)} | ${cell(level.server?.coresBusy)} | ${cell(level.server?.dbQueriesPerDocument)} | ${cell(level.workers?.cpuMsPerDocument)} | ${cell(level.workers?.cpuMsPerDocumentNetOfIdle)} | ${cell(level.workers?.coresBusy)} |`
    );
  }

  formatHostRows(
    lines,
    scenario.levels.map((level) => ({ host: level.host, key: levelKey(level) })),
    { label: "Upload concurrency", unit: "doc" }
  );

  lines.push(
    "",
    "Harness measurement traffic during the window (job polls and searchable checks, balanced apart from the workload; the probe CPU is the checks times the baselines' API CPU per chat request):",
    "",
    "| Upload concurrency | Window ms | GET /ingest-jobs polls | POST /chat searchable checks | Polling req/s | Estimated probe API CPU ms (share of API CPU) | Check statuses |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |"
  );
  for (const level of scenario.levels) {
    const probe = level.polling?.estimatedProbeApiCpu;
    lines.push(
      `| ${levelKey(level)} | ${cell(level.wallMs)} | ${cell(level.polling?.jobPolls)} | ${cell(level.polling?.searchChecks)} | ${cell(level.polling?.requestsPerSecond)} | ${probe ? `${cell(probe.cpuMs)} (${cell(probe.shareOfApiCpu)})` : "-"} | ${formatStatusCounts(level.polling?.searchCheckStatuses)} |`
    );
  }

  const withChat = scenario.levels.filter((level) => level.chat?.duringIngest);
  if (withChat.length > 0) {
    lines.push(
      "",
      `Background POST /chat at concurrency ${scenario.chatConcurrency}: idle before the window, during it, and idle after it (API CPU per chat request from the idle windows):`,
      "",
      `| Upload concurrency | Phase | Duration ms | Requests | Errors | ${LATENCY_HEADER} | API CPU ms/req |`,
      `| --- | --- | ---: | ---: | ---: | ${LATENCY_RULE} | ---: |`
    );
    for (const level of withChat) {
      for (const [label, row] of [
        ["idle before", level.chat.baselineBefore],
        ["during ingest", level.chat.duringIngest],
        ["idle after", level.chat.baselineAfter],
      ]) {
        if (!row) continue;
        lines.push(
          `| ${levelKey(level)} | ${label} | ${cell(row.wallMs)} | ${cell(row.requests)} | ${cell(row.errors)} | ${latencyCells(row.latencyMs)} | ${cell(row.server?.cpuMsPerRequest)} |`
        );
      }
    }
  }

  if (Array.isArray(scenario.repeats) && scenario.repeats.some((entry) => entry.repeats > 1)) {
    lines.push(
      "",
      "Repeats (mean [95% t-interval] over the comparable repeats; do not rank modes on a number whose intervals overlap):",
      "",
      "| Upload concurrency | Repeats (comparable) | Indexed p50 ms | Searchable p50 ms | Docs/s | Chat p95 during ms | Chat p95 minus idle ms | Chat mean minus idle ms |",
      "| ---: | ---: | --- | --- | --- | --- | --- | --- |"
    );
    for (const entry of scenario.repeats) {
      lines.push(
        `| ${entry.uploadConcurrency} | ${entry.repeats} (${entry.comparableRepeats}) | ${formatInterval(entry.offeredToIndexedP50Ms)} | ${formatInterval(entry.offeredToSearchableP50Ms)} | ${formatInterval(entry.indexedDocsPerSecond)} | ${formatInterval(entry.chatDuringP95Ms)} | ${formatInterval(entry.chatP95DeltaMs)} | ${formatInterval(entry.chatMeanDeltaMs)} |`
      );
    }
  }

  if (multiInstance) {
    lines.push(
      "",
      `Per instance during the window (uploads flagged when one instance took more than ${UPLOAD_IMBALANCE_THRESHOLD}x the mean):`,
      "",
      `| Upload concurrency | Instance | Uploads taken | Chat requests | Chat errors | Chat ${LATENCY_HEADER} | CPU ms | Cores busy | DB queries |`,
      `| --- | ---: | ---: | ---: | ---: | ${LATENCY_RULE} | ---: | ---: | ---: |`
    );
    for (const level of scenario.levels) {
      for (const instance of level.instances ?? []) {
        lines.push(
          `| ${levelKey(level)}${level.uploadSplit?.imbalanced ? " (imbalanced)" : ""} | ${instance.index} | ${cell(instance.uploads)} | ${cell(instance.requests)} | ${cell(instance.errors)} | ${latencyCells(instance.latencyMs)} | ${cell(round((instance.cpuUserMs ?? 0) + (instance.cpuSystemMs ?? 0)))} | ${cell(instance.coresBusy)} | ${cell(instance.dbQueries)} |`
        );
      }
    }
  }

  const errorLevels = scenario.levels.filter((level) => level.errors > 0);
  if (errorLevels.length > 0) {
    lines.push("", "Errors:");
    for (const level of errorLevels) {
      const detail = (level.failures ?? [])
        .map(
          (failure) =>
            failure.jobError ??
            failure.serverError ??
            (failure.answerExcerpt ? `answer "${failure.answerExcerpt}"` : null) ??
            (failure.lastCheckStatus ? `last check HTTP ${failure.lastCheckStatus}` : null)
        )
        .filter(Boolean);
      lines.push(
        `- c=${levelKey(level)}: ${formatErrorCounts(level.errorCounts)}${detail.length > 0 ? ` (first details: ${[...new Set(detail)].join(" | ")})` : ""}`
      );
    }
  }
};

const formatRequestScenario = (lines, scenario, multiInstance, balance) => {
  const chat = scenario.kind === "chat";
  lines.push(
    `| Concurrency | Requests | Errors | Req/s | ${LATENCY_HEADER} |${chat ? " Chat calls/req | Embedding calls/req | Peak chat in flight |" : ""} CPU ms/req | CPU ms/req net of idle | Cores busy | DB queries/req | Event-loop p99 ms |${chat ? " Answers (mode, cited) |" : ""}`,
    `| ---: | ---: | ---: | ---: | ${LATENCY_RULE} |${chat ? " ---: | ---: | ---: |" : ""} ---: | ---: | ---: | ---: | ---: |${chat ? " --- |" : ""}`
  );
  for (const level of scenario.levels) {
    const modes = [
      ...Object.entries(level.agentModes ?? {}).map(([mode, count]) => `${mode} ${count}`),
      ...(Number.isInteger(level.groundedAnswers) ? [`cited ${level.groundedAnswers}`] : []),
    ].join(", ");
    const chatCells = chat
      ? ` ${cell(level.model?.chatCompletionsPerRequest)} | ${cell(level.model?.embeddingRequestsPerRequest)} | ${cell(level.model?.peakChatInFlight)} |`
      : "";
    lines.push(
      `| ${level.concurrency} | ${level.requests} | ${level.errors} | ${cell(level.throughputRps)} | ${latencyCells(level.latencyMs)} |${chatCells} ${cell(level.server?.cpuMsPerRequest)} | ${cell(level.server?.cpuMsPerRequestNetOfIdle)} | ${cell(level.server?.coresBusy)} | ${cell(level.server?.dbQueriesPerRequest)} | ${cell(level.server?.eventLoopDelayP99Ms)} |${chat ? ` ${modes || "-"} |` : ""}`
    );
  }

  formatHostRows(
    lines,
    scenario.levels.map((level) => ({ host: level.host, key: String(level.concurrency) })),
    { label: "Concurrency", unit: "req" }
  );

  const withLimiter = scenario.levels.filter((level) => level.server?.sharedLimiter);
  if (withLimiter.length > 0) {
    lines.push(
      "",
      "Shared model concurrency cap (Redis): acquire scripts the instances ran. Each waiting instance polls on its own schedule, so this cost is per second of waiting, not per request; compare CPU per request between shared-state modes only at equal throughput.",
      "",
      "| Concurrency | Acquire scripts | Per second | Slots taken | Scripts per slot |",
      "| ---: | ---: | ---: | ---: | ---: |"
    );
    for (const level of withLimiter) {
      const limiter = level.server.sharedLimiter;
      lines.push(
        `| ${level.concurrency} | ${cell(limiter.acquireCalls)} | ${cell(limiter.acquireCallsPerSecond)} | ${cell(limiter.slotsAcquired)} | ${cell(limiter.acquireCallsPerSlot)} |`
      );
    }
  }

  if (multiInstance) {
    lines.push(
      "",
      `Per instance (${balance ?? "round-robin"} balancing; the mean is what Little's law ties to throughput, the percentiles show how evenly the instances served):`,
      "",
      `| Concurrency | Instance | Requests | Errors | ${LATENCY_HEADER} | CPU ms/req | CPU ms/req net of idle | Cores busy | DB queries |`,
      `| ---: | ---: | ---: | ---: | ${LATENCY_RULE} | ---: | ---: | ---: | ---: |`
    );
    for (const level of scenario.levels) {
      for (const instance of level.instances ?? []) {
        lines.push(
          `| ${level.concurrency} | ${instance.index} | ${cell(instance.requests)} | ${cell(instance.errors)} | ${latencyCells(instance.latencyMs)} | ${cell(instance.cpuMsPerRequest)} | ${cell(instance.cpuMsPerRequestNetOfIdle)} | ${cell(instance.coresBusy)} | ${cell(instance.dbQueries)} |`
        );
      }
    }
  }

  const errorLevels = scenario.levels.filter((level) => level.errors > 0);
  if (errorLevels.length > 0) {
    lines.push("", "Errors:");
    for (const level of errorLevels) {
      lines.push(`- c=${level.concurrency}: ${formatErrorCounts(level.errorCounts)}`);
    }
  }
};

const formatIdle = (run) => {
  if (!Array.isArray(run.idle) || run.idle.length === 0) return null;
  const labels = [
    ...(run.instances ?? []).map((instance) => `API #${instance.index}`),
    ...Array.from({ length: run.ingestWorkers ?? 0 }, (_, index) => `worker #${index}`),
  ];

  return `Idle for ${cell(run.idleMs)} ms before the first measured level (nothing sent): ${run.idle
    .map(
      (rates, index) =>
        `${labels[index] ?? `process #${index}`} ${cell(rates?.cpuMsPerSecond)} CPU ms/s, ${cell(rates?.dbQueriesPerSecond)} DB queries/s`
    )
    .join("; ")}.`;
};

const formatWorkerSettings = (settings) =>
  settings
    ? `${cell(settings.concurrency)} loop(s), idle poll ${settings.idlePollMs === null || settings.idlePollMs === undefined ? "not configurable in this checkout" : `${settings.idlePollMs} ms`}`
    : null;

/** How the report names its requests' access scope. */
export const formatAccessScope = (accessScope) =>
  accessScope?.tenant
    ? `tenant ${accessScope.userId} / ${accessScope.workspaceId} (x-user-id / x-workspace-id; PostgreSQL statements run in tenant transactions under row-level security)`
    : "none: unscoped owner path (PostgreSQL statements run as the owner on the pool, row-level security bypassed); --tenant measures the tenant path";

/** Markdown report: config, then the tables of every storage mode and scenario. */
export const formatLoadTestMarkdown = (report) => {
  const { config } = report;
  const scenarioKind = config.scenario ?? "chat";
  const instanceCount = config.instances ?? 1;
  const multiInstance = instanceCount > 1;
  const topology = formatCpuTopology(config.cpuTopology);
  const changedFiles = Array.isArray(config.gitChangedFiles) ? config.gitChangedFiles : [];
  const changedCount = config.gitChangedFileCount ?? changedFiles.length;
  const lines = [
    "# API load test",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Config",
    "",
    "| Setting | Value |",
    "| --- | --- |",
    `| Git SHA | ${cell(config.gitSha)}${
      config.gitDirty
        ? ` (dirty worktree${config.gitDiffSha256 ? `, worktree sha256 ${config.gitDiffSha256.slice(0, 16)}` : ""}, ${changedCount} changed file(s))`
        : ""
    } |`,
    ...(config.gitDirty && changedFiles.length > 0
      ? [
          `| Changed files | ${changedFiles.slice(0, 30).join(", ")}${changedCount > 30 ? `, ... (${changedCount - 30} more in the JSON report)` : ""} |`,
        ]
      : []),
    ...(config.harnessSha256 ? [`| Harness sha256 | ${config.harnessSha256.slice(0, 16)} (evaluation/run-api-load-bench.mjs as run) |`] : []),
    `| Node | ${cell(config.nodeVersion)} |`,
    `| Host | ${cell(config.platform)}, ${cell(config.cpuCount)} CPUs (${cell(config.cpuModel)}${topology ? `; core tiers ${topology}` : ""}), ${cell(config.totalMemoryGb)} GB RAM |`,
    `| Storage modes | ${config.storage.join(", ")} |`,
    `| Scenario | ${scenarioKind} |`,
    `| App instances | ${instanceCount}${multiInstance ? ` (client-side ${config.balance ?? "round-robin"} balancing, one database)` : ""} |`,
    `| Shared state (model call guard) | ${config.sharedState ?? "memory"}${config.sharedState === "redis" ? " (RAG_LLM_MAX_CONCURRENCY is one cap for all instances)" : multiInstance ? " (RAG_LLM_MAX_CONCURRENCY applies per instance)" : ""} |`,
    `| Model latency profiles (chat completion) | ${config.modelLatencyMs.map((ms) => `${ms} ms`).join(", ")} |`,
    `| Embedding latency | ${config.embeddingLatencyMs} ms |`,
    `| RAG_LLM_MAX_CONCURRENCY | ${config.llmMaxConcurrency} |`,
  ];

  if (scenarioKind === "ingest") {
    const workerSettings = [
      Number.isInteger(config.ingestWorkerConcurrency) ? `RAG_INGEST_WORKER_CONCURRENCY=${config.ingestWorkerConcurrency}` : null,
      Number.isInteger(config.ingestWorkerPollMs) ? `RAG_INGEST_WORKER_POLL_MS=${config.ingestWorkerPollMs}` : null,
      Number.isInteger(config.ingestMaxPendingJobs)
        ? `RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT=${config.ingestMaxPendingJobs}`
        : null,
    ].filter(Boolean);
    lines.push(
      `| Ingest mode | ${config.ingestMode}${
        config.ingestMode === "async"
          ? `, ${config.ingestWorkers ? `${config.ingestWorkers} dedicated worker process(es), API instances without a worker loop` : "worker loop in every API instance"}${workerSettings.length > 0 ? `, ${workerSettings.join(", ")}` : ""}`
          : " (each upload is ingested inside its own request)"
      } |`,
      `| Uploads | ${config.uploads} PDFs of ${config.ingestPages} pages per level; upload concurrency ${config.uploadConcurrency.join(", ")} |`,
      `| Background chat | concurrency ${config.chatConcurrency}; seed corpus ${config.documents} documents x ${config.pages} pages; idle baseline of ${cell(config.baselineMs)} ms before and after each window |`,
      `| Poll interval / searchable timeout | ${config.pollIntervalMs} ms / ${config.searchableTimeoutMs} ms |`,
      `| Repeats per level | ${cell(config.repeat ?? 1)} |`
    );
  } else {
    lines.push(
      `| Concurrency levels | ${config.concurrency.join(", ")} |`,
      `| Measured requests per level | /chat max(${config.requests}, ${cell(config.minRequestsPerClient ?? 0)} x concurrency), ${config.cheapPath} max(${config.cheapRequests}, ${cell(config.minRequestsPerClient ?? 0)} x concurrency); warm-up of max(${config.warmup}, concurrency) and cool-down in the same loop |`,
      `| Corpus | ${config.documents} documents x ${config.pages} pages, ${config.questions} questions |`
    );
  }

  lines.push(
    `| Planner | ${config.planner} |`,
    `| Auth / rate limit | ${config.auth ? "enabled" : "disabled"} / ${config.rateLimit ? "enabled" : "disabled"} |`,
    `| Access scope | ${formatAccessScope(config.accessScope)} |`,
    ...(Array.isArray(config.storage) && config.storage.includes("pgvector")
      ? [
          `| ANALYZE after the warm-up | ${config.analyze === false ? "no (--no-analyze): the fresh database has no planner statistics" : "yes"} |`,
          `| PostgreSQL CPU sampled | ${config.postgresCpuSampled ? "yes (postmaster and its children, ps at the window marks)" : "no (no --postgres-pid-file)"} |`,
        ]
      : []),
    `| Embedding dimensions / query embedding cache | ${config.embeddingDimensions} / ${
      config.embeddingCache
        ? `on, warmed on every instance before the first measured level${
            Number.isFinite(config.embeddingCacheMaxEntries) ? ` (${config.embeddingCacheMaxEntries} entries, TTL ${cell(config.embeddingCacheTtlMs)} ms)` : ""
          }`
        : "off"
    } |`,
    `| Idle measurement | ${config.idleMs > 0 ? `${config.idleMs} ms, nothing sent, before the first measured level` : "off"} |`,
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
    const workerProcesses = [
      ...(run.instances ?? []).filter((instance) => instance.ingestWorker).map((instance) => `API #${instance.index} ${formatWorkerSettings(instance.ingestWorker)}`),
      ...(run.workerProcesses ?? []).map((worker, index) => `worker #${index} ${formatWorkerSettings(worker.ingestWorker)}`),
    ];
    if (workerProcesses.length > 0) {
      lines.push(`Ingest worker loops: ${workerProcesses.join("; ")} (${cell(run.ingestWorkerLoops)} in total).`);
    }
    if (Number.isFinite(run.databaseAnalyzeMs)) {
      lines.push(`Planner statistics: ANALYZE ran on the database after the warm-up, before the idle measurement (${run.databaseAnalyzeMs} ms).`);
    }
    const idle = formatIdle(run);
    if (idle) lines.push(idle);
    lines.push("");

    for (const scenario of run.scenarios) {
      const heading =
        scenario.kind === "ingest"
          ? `### ${scenario.endpoint} (${scenario.ingestMode} ingest), chat model latency ${scenario.modelLatencyMs} ms, embedding latency ${scenario.embeddingLatencyMs} ms`
          : scenario.kind === "chat"
            ? `### ${scenario.endpoint}, model latency ${scenario.modelLatencyMs} ms`
            : `### ${scenario.endpoint}`;
      lines.push(heading, "");

      if (scenario.kind === "ingest") formatIngestScenario(lines, scenario, multiInstance);
      else formatRequestScenario(lines, scenario, multiInstance, config.balance);
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
};

export const LOAD_TEST_METHOD_NOTES = Object.freeze([
  "Closed loop: each virtual user sends its next request when the previous response arrives; results describe latency at that concurrency, not at a fixed arrival rate. A level's warm-up, measured requests and cool-down run in one loop, so every measured request ran with the level's concurrency in flight. The measurement window runs from the sending of the first measured request to the sending of the first cool-down request; since a closed loop sends a request exactly when one returns, exactly the measured count returns inside it, so the requests in flight at its edges do not bias throughput or per-request counts.",
  `Latency percentiles cover 2xx responses and n is their count. Nearest rank: p95 equals the maximum below ${minSamplesBelowMaximum(95)} samples and p99 below ${minSamplesBelowMaximum(99)}. In a closed loop the mean equals concurrency / throughput (Little's law); the mean, not p50, is what the throughput implies.`,
  "Req/s is measured requests per second of the measurement window; per-request costs (model calls, CPU, queries) are the window's counts divided by the measured requests. Latency is each measured request's own, including those that return after the window; errors are non-2xx, timeouts and connection failures.",
  "The model is a local fake (hashed term embeddings; the answer is the evidence sentence sharing the most words with the question, cited); model calls and peak in-flight chat completions are counted by the fake server.",
  "Peak in flight is counted by the fake only when its latency is above 0 ms: a zero-latency fake answers in the same tick it reads the request, so its count cannot exceed 1 and is shown as -.",
  "With the query embedding cache on, every instance asked every question of the pool once before the first measured level and the cache keeps them for the run, so measured /chat requests make no query embedding call (Embedding calls/req shows it).",
  "Load generator, fake model and app run on one host; each app instance runs in its own process.",
  `Event-loop p99 is the worst app process's delay beyond the ${EVENT_LOOP_SAMPLING_MS} ms sampling interval of monitorEventLoopDelay (an idle loop shows about 0); stalls shorter than the interval can be missed.`,
  "CPU ms/req is CPU time of the app processes over the measured phase divided by its requests: time, not work. It counts everything the processes did (timers, GC, background loops); the net-of-idle column subtracts each process's idle CPU rate times the phase. Cores busy is that CPU time over the phase, summed over processes. On a host with core tiers of different speeds (see Host) the same work costs more CPU time once busy threads spill from the fastest tier, so compare CPU ms/req only between levels with similar cores busy.",
  "DB queries/req counts pg client.query calls (round trips) of the app processes over the measured phase, divided by its completed requests: a tenant-scoped statement with its tenant settings is one pipelined call, a tenant transaction adds BEGIN with the settings as one call and COMMIT as another; 0 means the process sent nothing to PostgreSQL. It is a raw windowed count, not an exact per-request figure: it includes the processes' background queries and, above concurrency 1, requests in flight across the window edges, so a per-request statement count needs two runs of different lengths differenced (the difference in calls over the difference in requests).",
]);

/** GET /documents: what it reads depends on the storage mode, not on assumptions. */
export const buildDocumentsEndpointNote = (storage = []) =>
  [
    storage.includes("local")
      ? "With local storage GET /documents lists the in-process registry and sends no database query."
      : null,
    storage.includes("pgvector")
      ? "With pgvector storage the registry is PostgreSQL, which other API instances and ingest workers write too, so in either ingest mode GET /documents and POST /chat first re-read the requesting tenant's rows of the documents table (concurrent requests of one tenant share a listing that starts after they arrived; with auth off every request is one tenant, the whole table): GET /documents is not an in-memory read on pgvector, and its DB queries/req column is the observation, not an assumption."
      : null,
  ]
    .filter(Boolean)
    .join(" ");

export const buildMultiInstanceNotes = ({ balance = "least-outstanding", sharedState = "memory" } = {}) => [
  "Several instances: separate app processes on one host and one PostgreSQL database, sharing the temp data and upload directories. Level CPU and queries sum every process, event-loop delay is the worst instance, and the fake model's peak in flight counts all of them together; the per-instance tables split requests, latency and CPU by instance.",
  balance === "least-outstanding"
    ? "Balancing (client-side, no proxy): least outstanding requests, like nginx least_conn or Envoy LEAST_REQUEST: each request goes to the instance with the fewest of this generator's requests in flight, ties in rotation, so a slower instance receives fewer requests instead of a queue."
    : "Balancing (client-side, no proxy): round robin, request i to instance i mod N whatever it has in flight. In a closed loop a slower instance then holds most virtual users, each waiting for its own request there, so p50 comes from the faster instances and the tail from the slower one: multi-instance percentiles are specific to round robin; read the per-instance rows and the mean.",
  sharedState === "redis"
    ? "Shared state redis: every instance draws from one RAG_LLM_MAX_CONCURRENCY cap. Each instance's waiting head runs the acquire script every 10 ms while its ticket is among the next `limit` in the shared queue, which with at most one ticket per instance and a cap above the instance count is always; the scripts are counted per level (per second and per slot taken), because that cost is per second of waiting and dividing it by a throughput the cap itself lowers overstates its per-request cost. The fairness the ticket queue gives is in request counts and mean latency per instance; the tails can still differ by one model round."
    : "Shared state memory: the model call guard is per process, so RAG_LLM_MAX_CONCURRENCY caps each instance and N instances may reach N times the cap.",
];

export const buildIngestNotes = ({ ingestMode = "sync", pollIntervalMs = DEFAULT_LOAD_TEST_OPTIONS.pollIntervalMs } = {}) => [
  "Ingest scenario: generated text PDFs (one sentence per line, one distinct fact per page) are uploaded through POST /upload by a closed loop at the upload concurrency; an uploader moves on as soon as its 201 or 202 arrives, and each document is then followed on its own.",
  "Offered load: every document of a level is offered when the window opens (a batch dropped into the uploader), and the comparable times run from there in both modes: time to indexed (sync: its 201 arrived; async: its job's finishedAt, by the job store's clock on this host) and time to searchable. A sync upload's wait for a free uploader and an async job's wait in the queue both count, which timing each upload from when the closed-loop uploader sent it would not: in sync mode that leaves the backlog in the client. Docs/s is searchable documents over the time until the last of them was indexed. Only rows where every upload was accepted and became searchable compare across modes; a row with 429s measured fewer documents.",
  "Searchable, the same in both ingest modes: POST /chat with docIds [docId] asking the document's probe question (the fact of one page) returns 2xx with that fact in the answer and a citation of the document, on the next instance after the one that took the upload (the same instance when there is one). The check confirms the indexed document can be found; a 404 (document not known there yet) is retried every poll interval, a 2xx without fact or citation is an error.",
  ingestMode === "async"
    ? `Async mode: the 202 only stores the file in a job. GET /ingest-jobs/:jobId is polled every ${pollIntervalMs} ms (first poll one interval after the 202, as the frontend does) until the job succeeded, then the searchable check starts, so time to searchable is late by up to one interval; time to indexed is not, it is the job's finishedAt. Queue wait (startedAt - createdAt) and processing (finishedAt - startedAt) come from the job's own timestamps; queue wait includes a worker loop's idle sleep when no enqueue woke it (RAG_INGEST_WORKER_POLL_MS where the checkout has it) and, for a retried job, the earlier attempts.`
    : "Sync mode: the upload request parses, embeds and indexes the document before its 201, so upload latency is the ingest itself and there is no job: queue wait and processing are not reported. The searchable check starts right after the 201.",
  ingestMode === "async"
    ? "Ingest parallelism: async runs RAG_INGEST_WORKER_CONCURRENCY claim loops per worker process (API instances with a worker loop, or --ingest-workers processes); sync ingests one document per in-flight upload, up to the upload concurrency. Compare the modes at matched parallelism, e.g. sync at upload concurrency 8 against async with --ingest-worker-concurrency 4 on 2 worker processes."
    : "Ingest parallelism: sync ingests one document per in-flight upload, up to the upload concurrency; to compare with async, give async as many worker loops (--ingest-worker-concurrency times worker processes).",
  `Measurement traffic: the harness polls at a fixed ${pollIntervalMs} ms (the frontend's first interval; the frontend then backs off to 5 s). Its job polls and searchable checks go through a balancer of their own, apart from the workload (uploads and background chat, which share one): a check pinned to one instance waits on its query embedding while holding a request there, and counted with the workload it would steer uploads and chat to the other instance. The upload split per instance is reported and flagged above ${UPLOAD_IMBALANCE_THRESHOLD}x the mean. The checks are POST /chat requests on the API processes; their API CPU is estimated as checks times the idle windows' API CPU per chat request.`,
  "Background chat interference: the same chat load runs with nothing being ingested for the baseline duration right before and right after the window (the database holds more documents after it). Chat latency during the window includes the measurement traffic's CPU on the API processes, so keep the background load below saturation (about one request in flight per API process) and repeat each level (--repeat); the repeats table gives the mean and a 95% t-interval, and modes whose intervals overlap are not ranked.",
  "Embedding requests and inputs count every call the fake received during the window, including the background chat's and the searchable checks' query embeddings. CPU ms/doc divides the processes' CPU over the window by searchable documents; API CPU includes the background chat and the checks.",
];

export const DATABASE_STATISTICS_NOTE =
  "PostgreSQL planner statistics: the run's database is created for it, and autovacuum (1 min naptime by default) may analyze none of its tables within a short run. Without statistics the planner looked agent runs up through the (user_id, workspace_id, status, updated_at) index and filtered on run_id, reading every run of the (user, workspace) pair per lookup; the harness sends every request as one pair (the empty one without --tenant), so it read every run of the run so far and PostgreSQL CPU per request grew during a level. A deployment with many tenants spreads its runs over many pairs. The harness therefore runs ANALYZE once after the warm-up and before the idle measurement, as a database in service has statistics (--no-analyze skips it, for a before/after pair on one tree); the runs written during the measured levels are not re-analyzed.";

/** Which PostgreSQL path the requests take, from --tenant. */
export const buildAccessScopeNote = ({ tenant = false } = {}) =>
  tenant
    ? `Access scope: every request acts for tenant ${LOAD_TEST_TENANT.userId} / ${LOAD_TEST_TENANT.workspaceId} (x-user-id / x-workspace-id headers) and the seed corpus is that tenant's, so each scoped PostgreSQL statement runs in its own transaction as the tenant role under row-level security, as an authenticated per-tenant deployment runs it: the tenant settings (SET LOCAL ROLE and the tenant ids through set_config) and the statement go out in one round trip whose Sync ends that transaction, and a multi-statement tenant transaction sends BEGIN with the settings, its statements and COMMIT. DB queries/req counts those round trips.`
    : "Access scope: none. Without a tenant (auth off and no x-user-id / x-workspace-id headers, or the single API_AUTH_TOKEN) every PostgreSQL statement runs as the owner straight on the pool: row-level security does not apply and no statement is wrapped in a tenant transaction. The numbers describe that unscoped owner path, not an authenticated per-tenant deployment; --tenant measures the latter.";

export const HOST_CPU_NOTE =
  "Host CPU: at each window's marks the harness reads the host's CPU counters (all processes), its own CPU (load generator and fake model) and, when the postmaster's pid file is given (the wrapper passes it), the CPU of the PostgreSQL postmaster and its children from one ps listing. PostgreSQL CPU is the difference per process; a backend that exited inside the window takes its window CPU with it and is counted as exited, and ps reports CPU in 10 ms steps on macOS.";

/** Method notes for this run's settings: the common ones plus those that apply. */
export const buildMethodNotes = (options = {}) => {
  const storage = Array.isArray(options.storage) ? options.storage : [];
  const scenario = options.scenario ?? "chat";

  return [
    ...LOAD_TEST_METHOD_NOTES,
    buildAccessScopeNote({ tenant: options.tenant }),
    HOST_CPU_NOTE,
    ...(scenario === "chat" && storage.length > 0 ? [buildDocumentsEndpointNote(storage)] : []),
    ...(storage.includes("pgvector") ? [DATABASE_STATISTICS_NOTE] : []),
    ...((options.instances ?? 1) > 1 || (options.ingestWorkers ?? 0) > 0
      ? buildMultiInstanceNotes({ balance: options.balance, sharedState: options.sharedState })
      : []),
    ...(scenario === "ingest"
      ? buildIngestNotes({ ingestMode: options.ingestMode, pollIntervalMs: options.pollIntervalMs })
      : []),
  ];
};

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
    const worker = ready.ingestWorker ? ` (with ingest worker, ${formatWorkerSettings(ready.ingestWorker)})` : "";
    console.log(
      index === 0
        ? `[${storage}] instance 0: ${ready.chunkCount} chunks ingested in ${ready.ingestMs} ms; on port ${ready.port}${worker}`
        : `[${storage}] instance ${index}: on port ${ready.port}${worker}`
    );
  }

  return instances;
};

const startIngestWorkers = async ({ environmentFor, options, storage, workers }) => {
  const ready = [];

  for (let index = 0; index < options.ingestWorkers; index += 1) {
    const worker = await startAppProcess({ environment: environmentFor("worker"), role: "worker", verbose: options.verbose });
    workers.push(worker);
    ready.push(await worker.start([]));
  }
  if (workers.length > 0) {
    console.log(
      `[${storage}] ${workers.length} dedicated ingest worker process(es) started: ${ready
        .map((entry) => formatWorkerSettings(entry.ingestWorker))
        .join("; ")}`
    );
  }

  return ready.map((entry) => ({ ingestWorker: entry.ingestWorker ?? null, pid: entry.pid }));
};

/** Claim loops across every process that runs an ingest worker. */
export const countIngestWorkerLoops = (processes = []) =>
  processes.reduce((total, entry) => total + (Number.isInteger(entry?.ingestWorker?.concurrency) ? entry.ingestWorker.concurrency : 0), 0);

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

  // The code measured is what is on disk now, before any app process loads it.
  const worktree = await readWorktreeState();
  const harnessSha256 = await readHarnessSha256();
  const postmasterPid = await readPostmasterPid(options.postgresPidFile);
  if (options.postgresPidFile && !postmasterPid) {
    console.warn(`--postgres-pid-file ${options.postgresPidFile} names no running postmaster; PostgreSQL CPU is not sampled.`);
  }
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const corpus = buildSyntheticCorpus({
    docIdPrefix: `load-${runId}`,
    documents: options.documents,
    pages: options.pages,
  });
  const authToken = options.auth ? randomBytes(24).toString("hex") : "";
  const headers = buildRequestHeaders({ authToken, options });
  const fakeModel = await startFakeModelServer({ dimensions: options.embeddingDimensions });
  const runs = [];

  console.log(
    options.scenario === "ingest"
      ? `Load test (ingest, ${options.ingestMode}): storage ${options.storage.join(", ")}; ${options.instances} instance(s), ${options.ingestWorkers} worker process(es), ${options.balance} balancing; upload concurrency ${options.uploadConcurrency.join(", ")}; ${options.uploads} uploads per level; embedding latency ${options.embeddingLatencyMs} ms; shared state ${options.sharedState}`
      : `Load test: storage ${options.storage.join(", ")}; ${options.instances} instance(s), ${options.balance} balancing; concurrency ${options.concurrency.join(", ")}; model latency ${options.modelLatencyMs.join(", ")} ms; RAG_LLM_MAX_CONCURRENCY=${options.llmMaxConcurrency}; shared state ${options.sharedState}`
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
      // The cluster's CPU belongs to the pgvector run only.
      const hostSampler = createHostSampler({ postmasterPid: storage === "pgvector" ? postmasterPid : null });

      try {
        fakeModel.setLatency({ chatMs: 0, embeddingMs: 0 });
        console.log(`[${storage}] starting ${options.instances} app instance(s) and ingesting ${corpus.documents.length} documents...`);
        const instances = await startInstances({ apps, corpus, environmentFor, options, storage });
        const workerProcesses = await startIngestWorkers({ environmentFor, options, storage, workers });
        const workerLoops = countIngestWorkerLoops([...instances, ...workerProcesses]);
        const baseUrls = instances.map((instance) => `http://127.0.0.1:${instance.port}`);
        const primary = instances[0];
        const scenarios = [];
        let databaseAnalyzeMs = null;
        let idle = null;

        if (options.scenario === "ingest") {
          if (options.warmup > 0) {
            await warmUpIngestScenario({ baseUrls, headers, options, questions: corpus.questions, runId });
          }
          databaseAnalyzeMs = await analyzeDatabase({ options, primary: apps[0], storage });
          idle = await measureIdle({ idleMs: options.idleMs, processes: [...apps, ...workers] });
          for (const profile of options.modelLatencyMs) {
            fakeModel.setLatency({ chatMs: profile, embeddingMs: options.embeddingLatencyMs });
            scenarios.push(
              await runIngestScenario({
                apps,
                baseUrls,
                corpus,
                fakeModel,
                headers,
                hostSampler,
                idle,
                instances,
                options,
                profile,
                runId,
                workerLoops,
                workers,
              })
            );
          }
        } else {
          if (options.warmup > 0) {
            // Every instance's query embedding cache, before any measured level.
            const failures = await warmQueryCaches({
              baseUrls,
              concurrency: Math.min(8, Math.max(...options.concurrency)),
              headers,
              options,
              questions: corpus.questions,
              sessionTag: `load-${runId}-chat-warm`,
            });
            if (failures > 0) console.warn(`[${storage}] query cache warm-up: ${failures} request(s) failed`);
          }
          databaseAnalyzeMs = await analyzeDatabase({ options, primary: apps[0], storage });
          idle = await measureIdle({ idleMs: options.idleMs, processes: apps });
          scenarios.push(
            await runScenario({
              apps,
              baseUrls,
              fakeModel,
              headers,
              hostSampler,
              idle,
              instances,
              options,
              profile: null,
              runId,
              target: { kind: "cheap", label: `GET ${options.cheapPath}`, path: options.cheapPath },
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
                hostSampler,
                idle,
                instances,
                options,
                profile,
                runId,
                target: {
                  kind: "chat",
                  label: `POST /chat @${profile}ms`,
                  picker: createQuestionPicker({ instanceCount: baseUrls.length, questions: corpus.questions }),
                },
              })
            );
          }
        }

        runs.push({
          databaseAnalyzeMs,
          idle,
          idleMs: options.idleMs,
          ingest: {
            chunkCount: primary.chunkCount,
            databaseChunkRows: primary.databaseChunkRows,
            documentCount: primary.documentCount,
            ingestMs: primary.ingestMs,
            vectorStore: primary.vectorStore,
          },
          instances: instances.map((instance) => ({
            index: instance.index,
            ingestWorker: instance.ingestWorker ?? null,
            port: instance.port,
          })),
          ingestWorkerLoops: workerLoops,
          ingestWorkers: workers.length,
          scenarios,
          sharedState: options.sharedState,
          storage,
          workerProcesses,
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
  const ingest = options.scenario === "ingest";
  const report = {
    reportType: LOAD_TEST_REPORT_TYPE,
    reportVersion: LOAD_TEST_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    config: {
      accessScope: options.tenant ? { tenant: true, ...LOAD_TEST_TENANT } : { tenant: false },
      analyze: options.analyze,
      auth: options.auth,
      balance: options.balance,
      baselineMs: ingest ? options.baselineMs : null,
      chatConcurrency: ingest ? options.chatConcurrency : null,
      cheapPath: options.cheapPath,
      cheapRequests: options.cheapRequests,
      concurrency: options.concurrency,
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model ?? null,
      cpuTopology: readCpuTopology(),
      documents: options.documents,
      embeddingCache: options.embeddingCache,
      embeddingCacheMaxEntries: options.embeddingCache ? embeddingCacheEntriesFor(options) : null,
      embeddingCacheTtlMs: options.embeddingCache ? LOAD_TEST_EMBEDDING_CACHE_TTL_MS : null,
      embeddingDimensions: options.embeddingDimensions,
      embeddingLatencyMs: options.embeddingLatencyMs,
      ...worktree,
      harnessSha256,
      idleMs: options.idleMs,
      ingestMode: ingest ? options.ingestMode : null,
      ingestPages: ingest ? options.ingestPages : null,
      ingestWorkerConcurrency: options.ingestWorkerConcurrency,
      ingestMaxPendingJobs: options.ingestMaxPendingJobs,
      ingestWorkerPollMs: options.ingestWorkerPollMs,
      ingestWorkers: options.ingestWorkers,
      instances: options.instances,
      llmMaxConcurrency: options.llmMaxConcurrency,
      minRequestsPerClient: options.minRequestsPerClient,
      modelLatencyMs: options.modelLatencyMs,
      nodeVersion: process.version,
      pages: options.pages,
      planner: options.planner,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      pollIntervalMs: ingest ? options.pollIntervalMs : null,
      postgresCpuSampled: Boolean(postmasterPid),
      questions: corpus.questions.length,
      rateLimit: options.rateLimit,
      repeat: ingest ? options.repeat : null,
      requestTimeoutMs: options.requestTimeoutMs,
      requests: options.requests,
      scenario: options.scenario,
      searchableTimeoutMs: ingest ? options.searchableTimeoutMs : null,
      sharedState: options.sharedState,
      storage: options.storage,
      totalMemoryGb: round(os.totalmem() / 1024 ** 3),
      uploadConcurrency: ingest ? options.uploadConcurrency : null,
      uploads: ingest ? options.uploads : null,
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
