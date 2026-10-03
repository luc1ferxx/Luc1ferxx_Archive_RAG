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
// Split topology (--topology split, chat scenario, pgvector): instead of N
// monolith processes, every tier of a split deployment is its own process,
// started through the role start-up (rag/agent-service/role-server.js
// startServiceRole with ARCHIVE_RAG_ROLE set), --api / --agent / --retrieval /
// --gateway replicas of each (1 by default). The tiers are wired the way a
// deployment wires them: replica lists in AGENT_SERVICE_URL (api),
// RETRIEVAL_SERVICE_URL (agent) and MODEL_GATEWAY_URL (api, agent,
// retrieval), and one internal signing key generated for the run
// (INTERNAL_SERVICE_KEYS, never written to the report). The fake model sits
// behind the gateway (its chat and embedding upstream); every other tier
// reaches it only through the gateway, which the fake's per-caller counts
// confirm. They start in dependency order: gateways, retrieval (replica 0
// checks the database is fresh and its start-up migrates it), agents, then the
// api replicas (replica 0 ingests the seed corpus through the edge, its
// embeddings through the gateway). The balancer (--balance) sits in front of
// the api replicas; each tier's service client picks among the next tier's
// replicas. Every process reports its own CPU per level, so each level has a
// per-tier block (CPU per request, cores busy of the tier and of its busiest
// process, event-loop delay) and names the busiest tier; each process's whole-
// run CPU is read before it stops. --topology monolith (the default) is the
// run described above, unchanged.
//
// --repeat N (chat and ingest scenarios) runs each level N times in a row on
// the same processes; the chat report adds the range (min - max) per level.
//
// Usage:
//   node evaluation/run-api-load-bench.mjs
//     [--storage local|pgvector|local,pgvector]  default: local, or
//                                   pgvector,local when --database-url is given,
//                                   pgvector with --instances > 1 or --ingest-workers
//     [--database-url <disposable pgvector PostgreSQL URL>]
//     [--instances 1] [--balance least-outstanding|round-robin]
//     [--shared-state memory|redis] [--redis-url <disposable Redis URL>]
//     [--scenario chat|ingest|index-switch]
//     [--concurrency 1,4,16,32] [--requests 128] [--min-requests-per-client 8]
//     [--cheap-requests 1000] [--warmup 8] [--idle-ms 3000]
//     [--model-latency-ms 0,800] [--embedding-latency-ms 0]
//     [--llm-max-concurrency 8] [--embedding-dimensions 1536]
//     [--documents 20] [--pages 4] [--cheap-path /documents]
//     [--request-timeout-ms 120000] [--planner deterministic|llm]
//     [--auth] [--rate-limit] [--no-embedding-cache] [--tenant] [--no-analyze]
//     [--postgres-pid-file <postmaster.pid>] [--repeat 1]
//     [--read-replica-url <disposable streaming replica URL>]   (pgvector, --tenant)
//     [--latest-name latest-load-test] [--verbose]
//   split topology (chat scenario, pgvector; replaces --instances):
//     [--topology monolith|split] [--api 1] [--agent 1] [--retrieval 1] [--gateway 1]
//   ingest scenario only:
//     [--ingest-mode sync|async] [--ingest-workers 0] [--ingest-worker-concurrency N]
//     [--ingest-worker-poll-ms N] [--ingest-max-pending-jobs N]
//     [--uploads 16] [--upload-concurrency 4]
//     [--ingest-pages 4] [--chat-concurrency 4] [--baseline-ms 10000]
//     [--poll-interval-ms 1000] [--searchable-timeout-ms 120000]
//     [--embed-batching on|off] [--embed-batch-linger-ms N] [--ingest-job-lease-ms N]
//     [--crash-worker-mid-embed]   (async, 2+ dedicated workers, one level)
//     (--latest-name defaults to latest-load-test-ingest)
//   index-switch scenario only (pgvector):
//     [--switch-concurrency 8] [--switch-dimensions 768] [--switch-phase-ms 15000]
//     [--switch-build-batch-size N] [--switch-build-concurrency N] [--index-pointer-ttl-ms N]
//     (--latest-name defaults to latest-load-test-index-switch)
//   any scenario: [--embedding-latency-per-input-ms 0]
//
// Index switch scenario (--scenario index-switch): the seed corpus is
// uploaded as PDFs, a closed-loop /chat load runs for the whole run, and
// vector-index.mjs builds a version under another embedding model and width,
// activates it and rolls back, each as its own process. The report splits
// latency and errors by phase and says when each instance started searching
// each version (runIndexSwitchScenario). Per-process API keys let the fake
// model count each process's calls; --crash-worker-mid-embed kills dedicated
// worker 0 during its first embeddings request of the level and follows every
// job it held through the queue table (createCrashInjection).
//
// Read replica (--read-replica-url; the wrapper's --read-replica provisions one
// streaming replica of the disposable cluster): every app process of the
// pgvector run gets POSTGRES_READ_REPLICA_URLS, so tenant searches may run on
// the replica (rag/postgres-replicas.js). It needs --tenant, because owner
// statements never go to a replica. The chat scenario's report then carries,
// for the measured levels, pg_stat_statements counts on the primary and on the
// replica separately (searches, freshness guards, tenant settings, other reads,
// writes) and each process's routing counters, so primary offload can be read
// off. pg_stat_statements must be loaded on both nodes (the wrapper does that).
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
import { buildIngestDocuments, buildTextPdf } from "./load-bench-pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const resultsDirectory = path.join(__dirname, "results");

export const LOAD_TEST_REPORT_TYPE = "load-test";
export const LOAD_TEST_REPORT_VERSION = "1.3.0";
export const PERCENTILE_METHOD = "nearest-rank";

const FAKE_CHAT_MODEL = "load-test-chat";
const FAKE_EMBEDDING_MODEL = "text-embedding-3-small";

export const DEFAULT_LOAD_TEST_OPTIONS = Object.freeze({
  // AGENT_REQUEST_TIMEOUT_MS of every app process (null: unset, the app's
  // default of no request deadline).
  agentRequestTimeoutMs: null,
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
  crashWorkerMidEmbed: false,
  embedBatchLingerMs: null,
  embedBatching: null,
  embeddingCache: true,
  embeddingDimensions: 1536,
  embeddingLatencyMs: 0,
  embeddingLatencyPerInputMs: 0,
  idleMs: 3000,
  indexPointerTtlMs: null,
  ingestJobLeaseMs: null,
  ingestMode: "sync",
  ingestPages: 4,
  ingestWorkerConcurrency: null,
  ingestMaxPendingJobs: null,
  ingestWorkerPollMs: null,
  ingestWorkers: 0,
  instances: 1,
  latestName: "latest-load-test",
  // RAG_LLM_CIRCUIT_FAILURE_THRESHOLD of every app process (null: the app's
  // default; 0 turns the model circuit breaker off).
  llmCircuitFailureThreshold: null,
  llmMaxConcurrency: 8,
  // METRICS_ENABLED in every monolith app process (/metrics on an OS-assigned
  // port of its own, bearer token per run), scraped every metricsScrapeMs
  // (0: never) while the run lasts.
  metrics: false,
  metricsScrapeMs: 5000,
  minRequestsPerClient: 8,
  modelLatencyMs: Object.freeze([0, 800]),
  // pg_stat_statements per node over each measured /chat level (on with
  // --read-replica-url; --node-statements asks for it on the primary alone).
  nodeStatements: false,
  pages: 4,
  planner: "deterministic",
  postgresPidFile: "",
  // The frontend's first poll interval (src/components/PdfUploader.jsx); the
  // frontend then backs off, the harness keeps the interval fixed.
  pollIntervalMs: 1000,
  rateLimit: false,
  readReplicaUrl: "",
  redisUrl: "",
  repeat: 1,
  requestTimeoutMs: 120000,
  requests: 128,
  scenario: "chat",
  searchableTimeoutMs: 120000,
  sharedState: "memory",
  storage: null,
  switchBuildBatchSize: null,
  switchBuildConcurrency: null,
  switchConcurrency: 8,
  switchDimensions: 768,
  switchPhaseMs: 15000,
  tenant: false,
  topology: "monolith",
  // Processes per tier with --topology split (--api, --agent, --retrieval,
  // --gateway); a monolith run has `instances` processes of role all.
  tierReplicas: Object.freeze({ api: 1, agent: 1, retrieval: 1, "model-gateway": 1 }),
  uploadConcurrency: Object.freeze([4]),
  uploads: 16,
  verbose: false,
  warmup: 8,
});

// The ingest scenario measures what an upload costs, so its embeddings are not
// free unless --embedding-latency-ms says so; the chat scenario keeps 0.
export const DEFAULT_INGEST_EMBEDDING_LATENCY_MS = 200;
export const DEFAULT_INGEST_LATEST_NAME = "latest-load-test-ingest";
export const DEFAULT_INDEX_SWITCH_LATEST_NAME = "latest-load-test-index-switch";

const STORAGE_MODES = new Set(["local", "pgvector"]);
const PLANNER_MODES = new Set(["deterministic", "llm"]);
const SCENARIOS = new Set(["chat", "ingest", "index-switch"]);
const EMBED_BATCHING_MODES = new Set(["on", "off"]);
const INGEST_MODES = new Set(["sync", "async"]);
const SHARED_STATE_MODES = new Set(["memory", "redis"]);
export const BALANCE_MODES = Object.freeze(["least-outstanding", "round-robin"]);
export const TOPOLOGIES = Object.freeze(["monolith", "split"]);
// The tiers of a split run, in start order: each one is started once the
// tiers it calls are listening (its replica list is complete).
export const SPLIT_TIERS = Object.freeze(["model-gateway", "retrieval", "agent", "api"]);
// The order the report lists them in: the order a /chat request crosses them.
export const TIER_REPORT_ORDER = Object.freeze(["api", "agent", "retrieval", "model-gateway"]);
// CLI flag per tier replica count (--gateway is the model-gateway tier).
export const TIER_REPLICA_FLAGS = Object.freeze({
  agent: "agent",
  api: "api",
  gateway: "model-gateway",
  retrieval: "retrieval",
});
// The role name of a monolith process in per-tier reports.
export const MONOLITH_TIER = "all";
// The tenant every request acts for with --tenant (x-user-id / x-workspace-id
// headers; the seed corpus is ingested as its documents).
export const LOAD_TEST_TENANT = Object.freeze({ userId: "load-test-user", workspaceId: "load-test-workspace" });

const INGEST_ONLY_FLAGS = Object.freeze([
  "baseline-ms",
  "chat-concurrency",
  "crash-worker-mid-embed",
  "embed-batch-linger-ms",
  "embed-batching",
  "ingest-job-lease-ms",
  "ingest-max-pending-jobs",
  "ingest-mode",
  "ingest-pages",
  "ingest-worker-concurrency",
  "ingest-worker-poll-ms",
  "ingest-workers",
  "poll-interval-ms",
  "searchable-timeout-ms",
  "upload-concurrency",
  "uploads",
]);

const INDEX_SWITCH_ONLY_FLAGS = Object.freeze([
  "index-pointer-ttl-ms",
  "switch-build-batch-size",
  "switch-build-concurrency",
  "switch-concurrency",
  "switch-dimensions",
  "switch-phase-ms",
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
  const flags = new Set([
    "auth",
    "crash-worker-mid-embed",
    "metrics",
    "no-analyze",
    "node-statements",
    "no-embedding-cache",
    "rate-limit",
    "tenant",
    "verbose",
    "serve",
    "serve-tier",
    "serve-worker",
  ]);

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
    ...INDEX_SWITCH_ONLY_FLAGS,
    ...Object.keys(TIER_REPLICA_FLAGS),
    "agent-request-timeout-ms",
    "balance",
    "cheap-path",
    "cheap-requests",
    "concurrency",
    "database-url",
    "documents",
    "embedding-dimensions",
    "embedding-latency-ms",
    "embedding-latency-per-input-ms",
    "idle-ms",
    "instances",
    "latest-name",
    "llm-circuit-failure-threshold",
    "llm-max-concurrency",
    "metrics-scrape-ms",
    "min-requests-per-client",
    "model-latency-ms",
    "pages",
    "planner",
    "postgres-pid-file",
    "read-replica-url",
    "redis-url",
    "repeat",
    "request-timeout-ms",
    "requests",
    "scenario",
    "shared-state",
    "storage",
    "topology",
    "warmup",
  ]);

  for (const name of Object.keys(raw)) {
    if (!known.has(name)) throw new Error(`Unknown flag --${name}.`);
  }

  if (raw.auth) options.auth = true;
  if (raw["no-analyze"]) options.analyze = false;
  if (raw.metrics) options.metrics = true;
  if (raw["metrics-scrape-ms"] !== undefined) {
    if (!options.metrics) throw new Error("--metrics-scrape-ms needs --metrics.");
    options.metricsScrapeMs = toPositiveInteger(raw["metrics-scrape-ms"], "--metrics-scrape-ms", { allowZero: true });
  }
  if (raw["agent-request-timeout-ms"] !== undefined)
    options.agentRequestTimeoutMs = toPositiveInteger(raw["agent-request-timeout-ms"], "--agent-request-timeout-ms");
  if (raw["node-statements"]) options.nodeStatements = true;
  if (raw["llm-circuit-failure-threshold"] !== undefined)
    options.llmCircuitFailureThreshold = toPositiveInteger(
      raw["llm-circuit-failure-threshold"],
      "--llm-circuit-failure-threshold",
      { allowZero: true }
    );
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
  if (raw["read-replica-url"] !== undefined) options.readReplicaUrl = String(raw["read-replica-url"]).trim();
  if (raw.documents !== undefined) options.documents = toPositiveInteger(raw.documents, "--documents");
  if (raw["embedding-dimensions"] !== undefined)
    options.embeddingDimensions = toPositiveInteger(raw["embedding-dimensions"], "--embedding-dimensions");
  if (raw["embedding-latency-ms"] !== undefined)
    options.embeddingLatencyMs = toPositiveInteger(raw["embedding-latency-ms"], "--embedding-latency-ms", {
      allowZero: true,
    });
  if (raw["embedding-latency-per-input-ms"] !== undefined)
    options.embeddingLatencyPerInputMs = toPositiveInteger(
      raw["embedding-latency-per-input-ms"],
      "--embedding-latency-per-input-ms",
      { allowZero: true }
    );
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
    if (!SCENARIOS.has(raw.scenario)) throw new Error("--scenario must be chat, ingest or index-switch.");
    options.scenario = raw.scenario;
  }
  // Each level runs this many times in a row on the same processes (ingest:
  // with its own baselines), so the report can put an interval (ingest) or a
  // range (chat) on its numbers.
  if (raw.repeat !== undefined) {
    if (options.scenario === "index-switch") throw new Error("--repeat applies to --scenario chat and ingest.");
    options.repeat = toPositiveInteger(raw.repeat, "--repeat");
  }
  if (raw.topology !== undefined) {
    if (!TOPOLOGIES.includes(raw.topology)) throw new Error(`--topology must be ${TOPOLOGIES.join(" or ")}.`);
    options.topology = raw.topology;
  }
  const tierFlags = Object.keys(TIER_REPLICA_FLAGS).filter((name) => raw[name] !== undefined);
  if (options.topology === "split") {
    if (options.scenario !== "chat") {
      throw new Error("--topology split runs the chat scenario only (the ingest and index-switch scenarios start monolith processes).");
    }
    if (raw.instances !== undefined) {
      throw new Error("--topology split takes its api replica count from --api, not --instances.");
    }
    const tierReplicas = { ...DEFAULT_LOAD_TEST_OPTIONS.tierReplicas };
    for (const name of tierFlags) {
      tierReplicas[TIER_REPLICA_FLAGS[name]] = toPositiveInteger(raw[name], `--${name}`);
    }
    options.tierReplicas = tierReplicas;
    // The balancer and the per-instance tables count the api replicas.
    options.instances = tierReplicas.api;
  } else if (tierFlags.length > 0) {
    throw new Error(`${tierFlags.map((name) => `--${name}`).join(", ")} only apply to --topology split.`);
  }
  if (options.scenario !== "index-switch") {
    const misplaced = INDEX_SWITCH_ONLY_FLAGS.filter((name) => raw[name] !== undefined);
    if (misplaced.length > 0) {
      throw new Error(`${misplaced.map((name) => `--${name}`).join(", ")} only apply to --scenario index-switch.`);
    }
  } else {
    if (raw["switch-concurrency"] !== undefined)
      options.switchConcurrency = toPositiveInteger(raw["switch-concurrency"], "--switch-concurrency");
    if (raw["switch-dimensions"] !== undefined)
      options.switchDimensions = toPositiveInteger(raw["switch-dimensions"], "--switch-dimensions");
    if (raw["switch-phase-ms"] !== undefined)
      options.switchPhaseMs = toPositiveInteger(raw["switch-phase-ms"], "--switch-phase-ms", { allowZero: true });
    if (raw["switch-build-batch-size"] !== undefined)
      options.switchBuildBatchSize = toPositiveInteger(raw["switch-build-batch-size"], "--switch-build-batch-size");
    if (raw["switch-build-concurrency"] !== undefined)
      options.switchBuildConcurrency = toPositiveInteger(raw["switch-build-concurrency"], "--switch-build-concurrency");
    if (raw["index-pointer-ttl-ms"] !== undefined)
      options.indexPointerTtlMs = toPositiveInteger(raw["index-pointer-ttl-ms"], "--index-pointer-ttl-ms");
    if (!raw["latest-name"]) options.latestName = DEFAULT_INDEX_SWITCH_LATEST_NAME;
    // The new version must live in another embedding space than the seed's.
    if (options.switchDimensions === options.embeddingDimensions) {
      throw new Error("--switch-dimensions must differ from --embedding-dimensions: the scenario switches to another width.");
    }
    if (raw.storage !== undefined && String(raw.storage).trim() !== "pgvector") {
      throw new Error("--scenario index-switch runs on --storage pgvector only (index versions are a pgvector feature).");
    }
    raw.storage = "pgvector";
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
    if (raw["embed-batching"] !== undefined) {
      if (!EMBED_BATCHING_MODES.has(raw["embed-batching"])) throw new Error("--embed-batching must be on or off.");
      options.embedBatching = raw["embed-batching"];
    }
    if (raw["embed-batch-linger-ms"] !== undefined)
      options.embedBatchLingerMs = toPositiveInteger(raw["embed-batch-linger-ms"], "--embed-batch-linger-ms", {
        allowZero: true,
      });
    if (raw["ingest-job-lease-ms"] !== undefined)
      options.ingestJobLeaseMs = toPositiveInteger(raw["ingest-job-lease-ms"], "--ingest-job-lease-ms");
    if (raw["crash-worker-mid-embed"]) options.crashWorkerMidEmbed = true;
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
    for (const [flag, value] of [
      ["--embed-batching", options.embedBatching],
      ["--embed-batch-linger-ms", options.embedBatchLingerMs],
      ["--ingest-job-lease-ms", options.ingestJobLeaseMs],
    ]) {
      if (value !== null && options.ingestMode !== "async") {
        throw new Error(`${flag} needs --ingest-mode async (the staged pipeline runs async jobs only).`);
      }
    }
    if (options.crashWorkerMidEmbed) {
      if (options.ingestMode !== "async" || options.ingestWorkers < 2) {
        throw new Error(
          "--crash-worker-mid-embed needs --ingest-mode async and --ingest-workers 2 or more: one dedicated worker is killed, another resumes its jobs."
        );
      }
      if (options.uploadConcurrency.length !== 1 || options.repeat !== 1) {
        throw new Error("--crash-worker-mid-embed runs one level once: give one --upload-concurrency and no --repeat.");
      }
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
  const split = options.topology === "split";
  const multiProcess = options.instances > 1 || options.ingestWorkers > 0 || split;
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
      `${raw.storage ? "--storage pgvector" : split ? "--topology split" : multiProcess ? "--instances > 1 and --ingest-workers" : "--storage pgvector"} needs --database-url pointing at a disposable pgvector PostgreSQL (scripts/run-load-test-pgvector.sh creates one).`
    );
  }
  if (split && storage.includes("local")) {
    throw new Error(
      "--topology split needs --storage pgvector: its tiers share the document registry and the index through PostgreSQL, and the retrieval tier refuses a local index."
    );
  }
  if (multiProcess && storage.includes("local")) {
    throw new Error(
      "--instances > 1 and --ingest-workers need --storage pgvector: standalone (local) processes share no document registry, vector index or ingest queue."
    );
  }

  if (options.readReplicaUrl && !storage.includes("pgvector")) {
    throw new Error("--read-replica-url needs --storage pgvector: only the pgvector run reads PostgreSQL.");
  }
  if (options.readReplicaUrl && !options.tenant) {
    throw new Error(
      "--read-replica-url needs --tenant: only tenant reads may go to a replica; owner statements always stay on the primary."
    );
  }

  if (options.readReplicaUrl) options.nodeStatements = true;
  if (options.nodeStatements && !storage.includes("pgvector")) {
    throw new Error("--node-statements needs --storage pgvector: it reads pg_stat_statements on the run's database.");
  }
  if (options.metrics && options.topology === "split") {
    throw new Error("--metrics applies to monolith processes (the split tiers start their listener through startServiceRole, which the harness does not scrape).");
  }

  options.storage = [...new Set(storage)];
  options.serve = Boolean(raw.serve);
  options.serveWorker = Boolean(raw["serve-worker"]);
  options.serveTier = Boolean(raw["serve-tier"]);

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

// Beyond the 20 base names a name compounds base names by the index's base-20
// digits, lowest first ("Asterbirch" for 20), never with a digit: a file name
// with a digit (project-aster2-handbook.pdf) counts as a document identity
// label to the claim attribution (rag/self-check/attribution.js), and every
// answer about such a document ended in a clarification, so a corpus above
// 20 documents measured clarifications instead of answers. The base names are
// a prefix-free set, so every compound is unique.
export const projectName = (index) => {
  const base = PROJECT_NAMES.length;
  if (index < base) return PROJECT_NAMES[index];
  let name = PROJECT_NAMES[index % base];
  for (let rest = Math.floor(index / base); rest > 0; rest = Math.floor(rest / base)) {
    name += PROJECT_NAMES[rest % base].toLowerCase();
  }
  return name;
};

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

/**
 * PDF bytes of one synthetic corpus document (load-bench-pdf.mjs), one line
 * per sentence, so the registry holds real PDF bytes an index version build
 * can parse again (--scenario index-switch seeds the corpus this way).
 */
export const buildSeedPdf = (doc) =>
  buildTextPdf({
    pages: doc.pages.map((page) => {
      const sentences = (String(page.text).match(/[^.!?]+[.!?]+/g) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
      return sentences.length > 0 ? sentences : [String(page.text)];
    }),
    title: doc.fileName,
  });

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
 * The embedding model an index version is built under in --scenario
 * index-switch: `load-test-embedding-<width>`. The fake answers such a model
 * with vectors of that width, any other model with the server's default.
 */
export const SWITCH_EMBEDDING_MODEL_PREFIX = "load-test-embedding-";
export const switchEmbeddingModel = (dimensions) => `${SWITCH_EMBEDDING_MODEL_PREFIX}${dimensions}`;
export const fakeEmbeddingWidth = (model, fallback) => {
  const text = String(model ?? "");
  const width = text.startsWith(SWITCH_EMBEDDING_MODEL_PREFIX) ? Number(text.slice(SWITCH_EMBEDDING_MODEL_PREFIX.length)) : Number.NaN;

  return Number.isInteger(width) && width > 0 ? width : fallback;
};

/**
 * Who sent a model request: every process of a run gets its own API key
 * (buildAppEnvironment's callerTag, "load-test-api-0", "load-test-worker-1",
 * "load-test-cli"), so the fake can split its counts by process. "unknown"
 * without a bearer key.
 */
export const fakeModelCaller = (authorization) => {
  const match = /^Bearer\s+(\S+)/i.exec(String(authorization ?? ""));
  return match ? match[1] : "unknown";
};

/** The seed or upload documents an embeddings request's texts belong to (by their program/project name). */
export const documentNamesInTexts = (texts = []) => [
  ...new Set(
    texts.flatMap((text) => [...String(text ?? "").matchAll(/\b(?:Program|Project) ([A-Z][A-Za-z]*-[a-z0-9]+-\d+|[A-Z][A-Za-z]+(?:-\d+)?)\b/g)].map((match) => match[1]))
  ),
];

/**
 * Local OpenAI-compatible server: /v1/embeddings and /v1/chat/completions with
 * artificial latency, counting requests and the peak in flight per kind, and
 * per caller (the request's API key) and embedding model. An embeddings
 * request's latency is `embeddingLatencyMs` plus `embeddingLatencyPerInputMs`
 * per input. holdNextEmbedding({ caller }) makes the next embeddings request
 * of that caller hang unanswered and resolves with what it carried: the crash
 * injection kills the process that sent it while it waits (mid-embed).
 */
export const startFakeModelServer = async ({
  chatLatencyMs = 0,
  dimensions = DEFAULT_LOAD_TEST_OPTIONS.embeddingDimensions,
  embeddingLatencyMs = 0,
  embeddingLatencyPerInputMs = 0,
} = {}) => {
  const latency = { chat: chatLatencyMs, embeddings: embeddingLatencyMs, embeddingsPerInput: embeddingLatencyPerInputMs };
  // In flight is one count for the server's life: a request that arrived
  // before a reset still leaves it when it is answered. Each stats window
  // starts its peak at what is in flight when it opens.
  const inFlight = { chat: 0, embeddings: 0 };
  const freshStats = () => ({
    byCaller: {},
    chat: { aborted: 0, peakInFlight: inFlight.chat, requests: 0 },
    embeddings: { aborted: 0, inputs: 0, peakInFlight: inFlight.embeddings, requests: 0 },
    embeddingsByModel: {},
    other: { requests: 0 },
  });
  let stats = freshStats();
  // First embeddings request per caller and model, epoch ms, for the server's life.
  const firstEmbeddingAt = {};
  const holds = [];
  const countCall = (caller, kind, model, inputs) => {
    const entry = (stats.byCaller[caller] ??= { chat: 0, embeddingInputs: 0, embeddings: 0 });
    if (kind === "chat") {
      entry.chat += 1;
      return;
    }
    entry.embeddings += 1;
    entry.embeddingInputs += inputs;
    const byModel = (stats.embeddingsByModel[model] ??= { inputs: 0, requests: 0 });
    byModel.requests += 1;
    byModel.inputs += inputs;
    firstEmbeddingAt[`${caller}|${model}`] ??= Date.now();
  };

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
      // Closed by the caller before the reply was sent: a call the app gave
      // up on (a deadline or cancellation), counted as aborted.
      let replied = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          inFlight[kind] -= 1;
        }
      };
      response.on("close", () => {
        if (!replied) bucket.aborted += 1;
        settle();
      });
      const caller = fakeModelCaller(request.headers.authorization);
      const inputs = kind === "embeddings" ? (Array.isArray(payload.input) ? payload.input : [payload.input ?? ""]) : [];
      countCall(caller, kind, String(payload.model ?? ""), inputs.length);

      if (kind === "embeddings") {
        const holdIndex = holds.findIndex((hold) => hold.caller === caller);
        if (holdIndex >= 0) {
          // Never answered: the caller is killed while it waits.
          const [hold] = holds.splice(holdIndex, 1);
          bucket.inputs += inputs.length;
          hold.resolve({
            at: Date.now(),
            caller,
            documents: documentNamesInTexts(inputs),
            inputs: inputs.length,
            model: String(payload.model ?? ""),
          });
          return;
        }
      }

      const reply = () => {
        replied = true;
        settle();
        if (kind === "embeddings") {
          const width = fakeEmbeddingWidth(payload.model, dimensions);
          bucket.inputs += inputs.length;
          send(200, {
            data: inputs.map((input, index) => ({
              embedding: hashEmbedding(input, width),
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

      const delay = kind === "embeddings" ? latency.embeddings + latency.embeddingsPerInput * inputs.length : latency[kind];
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
    firstEmbeddingAt: () => ({ ...firstEmbeddingAt }),
    // Requests whose caller is still connected, now.
    inFlightNow: () => ({ ...inFlight }),
    holdNextEmbedding: ({ caller }) =>
      new Promise((resolve) => {
        holds.push({ caller, resolve });
      }),
    resetStats: () => {
      stats = freshStats();
    },
    setLatency: ({ chatMs, embeddingMs, embeddingPerInputMs } = {}) => {
      if (Number.isFinite(chatMs)) latency.chat = chatMs;
      if (Number.isFinite(embeddingMs)) latency.embeddings = embeddingMs;
      if (Number.isFinite(embeddingPerInputMs)) latency.embeddingsPerInput = embeddingPerInputMs;
    },
    snapshot: () => ({
      byCaller: Object.fromEntries(Object.entries(stats.byCaller).map(([caller, entry]) => [caller, { ...entry }])),
      chat: { aborted: stats.chat.aborted, peakInFlight: stats.chat.peakInFlight, requests: stats.chat.requests },
      embeddings: {
        aborted: stats.embeddings.aborted,
        inputs: stats.embeddings.inputs,
        peakInFlight: stats.embeddings.peakInFlight,
        requests: stats.embeddings.requests,
      },
      embeddingsByModel: Object.fromEntries(Object.entries(stats.embeddingsByModel).map(([model, entry]) => [model, { ...entry }])),
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
  callerTag = "",
  metricsToken = "",
  role = "api",
  runId = "",
}) => {
  const environment = { ...baseEnvironment };

  // Anything that could point the app at another database, model or cache,
  // or turn it into one tier of a split deployment (a role, service URLs or
  // internal keys from the shell): a monolith child is a monolith, and a tier
  // child gets its wiring from buildTierEnvironment only.
  for (const name of Object.keys(environment)) {
    if (
      /^(OPENAI_|POSTGRES_|LONG_MEMORY_|PGVECTOR_|QDRANT_|REDIS_|RAG_|AGENT_|API_AUTH|RATE_LIMIT|OTEL_|DOCCOMPARE_|VECTOR_STORE_|DOCUMENT_STORE_|SESSION_MEMORY_STORE_|TASK_STORE_|WORKSPACE_ARTIFACT_STORE_|ADMIN_AUDIT_STORE_|AGENT_RUN_STORE_|UPLOADS_DIRECTORY|FRONTEND_BUILD_DIRECTORY|ALLOWED_ORIGINS|SERPAPI_|PG|DOTENV_|PDF_PARSER|DOCLING_|ARCHIVE_RAG_|INTERNAL_SERVICE_|RETRIEVAL_SERVICE_|MODEL_GATEWAY_|SERVICE_SHUTDOWN_|METRICS_|PORT$)/.test(
        name
      )
    ) {
      delete environment[name];
    }
  }

  Object.assign(environment, {
    NODE_ENV: "production",
    // One key per process (callerTag), so the fake model splits its counts by
    // process: a worker's embeddings requests are its documents' only.
    OPENAI_API_KEY: callerTag ? `load-test-${callerTag}` : "load-test",
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
  // --metrics: what a deployment sets to serve /metrics, on a port the OS
  // picks (each process names it in its ready reply) and the run's token.
  if (options.metrics) {
    Object.assign(environment, {
      METRICS_ENABLED: "true",
      METRICS_HOST: "127.0.0.1",
      METRICS_PORT: "0",
      ...(metricsToken ? { METRICS_TOKEN: metricsToken } : {}),
    });
  }
  if (Number.isInteger(options.agentRequestTimeoutMs)) {
    environment.AGENT_REQUEST_TIMEOUT_MS = String(options.agentRequestTimeoutMs);
  }
  if (Number.isInteger(options.llmCircuitFailureThreshold)) {
    environment.RAG_LLM_CIRCUIT_FAILURE_THRESHOLD = String(options.llmCircuitFailureThreshold);
  }
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
  // The staged pipeline's cross-document embedding batcher (app default on)
  // and the job lease (app default 60 s), set only when the run names them.
  if (options.embedBatching === "on" || options.embedBatching === "off") {
    environment.RAG_INGEST_EMBED_BATCHING = options.embedBatching === "on" ? "true" : "false";
  }
  if (Number.isInteger(options.embedBatchLingerMs)) {
    environment.RAG_INGEST_EMBED_BATCH_LINGER_MS = String(options.embedBatchLingerMs);
  }
  if (Number.isInteger(options.ingestJobLeaseMs)) {
    environment.RAG_INGEST_JOB_LEASE_MS = String(options.ingestJobLeaseMs);
  }
  // How long each API process trusts the index version pointer (app default 2 s).
  if (Number.isInteger(options.indexPointerTtlMs)) {
    environment.RAG_INDEX_VERSION_POINTER_TTL_MS = String(options.indexPointerTtlMs);
  }

  if (storage === "pgvector") {
    Object.assign(environment, {
      LONG_MEMORY_DATABASE_URL: databaseUrl,
      POSTGRES_DATABASE_URL: databaseUrl,
      VECTOR_STORE_PROVIDER: "pgvector",
    });
    // Tenant searches may then run on the streaming replica.
    if (options.readReplicaUrl) environment.POSTGRES_READ_REPLICA_URLS = options.readReplicaUrl;
  } else {
    environment.DOCCOMPARE_STANDALONE = "1";
  }

  return environment;
};

/** The fake model's caller tag of a tier process ("gateway-0", "agent-1"). */
export const tierCallerTag = (tier, index) => `${tier === "model-gateway" ? "gateway" : tier}-${index}`;

/** The key the fake model sees from a gateway process: its caller tag's API key. */
export const GATEWAY_CALLER_PREFIX = "load-test-gateway-";

// Drain window of a tier process when the harness stops it: nothing is in
// flight by then, and the harness waits at most 5 s for a child to exit.
export const TIER_SHUTDOWN_GRACE_MS = 1000;

/**
 * One internal signing key for the run, `<kid>:<secret>` as
 * INTERNAL_SERVICE_KEYS takes it: every tier signs and verifies with it, and
 * nothing outside the run's processes knows it. The key id names the run.
 */
export const createRunServiceKeys = ({ runId, secret = randomBytes(32).toString("hex") } = {}) =>
  `load-test-${runId || "run"}:${secret}`;

/**
 * Environment for one process of the split topology: the monolith child's
 * (buildAppEnvironment, which clears anything a shell could add), plus the
 * role and its wiring, exactly what a deployment sets per tier:
 *   api            AGENT_SERVICE_URL and MODEL_GATEWAY_URL (the seed ingest's
 *                  embeddings)
 *   agent          RETRIEVAL_SERVICE_URL and MODEL_GATEWAY_URL
 *   retrieval      MODEL_GATEWAY_URL (query embeddings)
 *   model-gateway  the fake model as its chat and embedding upstream, and no
 *                  database (the gateway keeps none)
 * `urls` holds each tier's replica base URLs. Every process keeps its own
 * OPENAI_API_KEY caller tag, so a model call that bypassed the gateway would
 * show up in the fake's per-caller counts under another tier's name.
 */
export const buildTierEnvironment = ({ index = 0, serviceKeys, tier, urls = {}, ...appEnvironment }) => {
  if (!SPLIT_TIERS.includes(tier)) throw new RangeError(`Unknown tier "${tier}".`);
  if (!serviceKeys) throw new TypeError("buildTierEnvironment needs the run's internal service keys.");

  const environment = buildAppEnvironment({ ...appEnvironment, callerTag: tierCallerTag(tier, index), role: tier });
  const list = (name) => (urls[name] ?? []).join(",");

  Object.assign(environment, {
    ARCHIVE_RAG_ROLE: tier,
    INTERNAL_SERVICE_KEYS: serviceKeys,
    SERVICE_SHUTDOWN_GRACE_MS: String(TIER_SHUTDOWN_GRACE_MS),
  });

  if (tier === "model-gateway") {
    environment.MODEL_GATEWAY_CHAT_UPSTREAMS = appEnvironment.modelBaseUrl;
    environment.MODEL_GATEWAY_EMBEDDING_UPSTREAMS = appEnvironment.modelBaseUrl;
    for (const name of ["POSTGRES_DATABASE_URL", "LONG_MEMORY_DATABASE_URL"]) delete environment[name];
    return environment;
  }

  environment.MODEL_GATEWAY_URL = list("model-gateway");
  if (tier === "api") environment.AGENT_SERVICE_URL = list("agent");
  if (tier === "agent") environment.RETRIEVAL_SERVICE_URL = list("retrieval");

  return environment;
};

// The child entry per process kind: a monolith API instance, a dedicated
// ingest worker, or one tier of the split topology.
const CHILD_ENTRY_FLAGS = Object.freeze({ api: "--serve", tier: "--serve-tier", worker: "--serve-worker" });

const startAppProcess = async ({ environment, role = "api", verbose }) => {
  const child = fork(__filename, [CHILD_ENTRY_FLAGS[role] ?? "--serve"], {
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
    get exited() {
      return exited;
    },
    // The crash injection: SIGKILL, resolved once the process is gone.
    kill: async () => {
      if (exited) return;
      const exitPromise = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exitPromise;
    },
    pid: child.pid,
    start: (documents, { assertFresh = false, primary = true, seedFormat = "text" } = {}) =>
      request({ assertFresh, documents, primary, seedFormat, type: "start" }, "ready"),
    analyze: () => request({ type: "analyze" }, "analyzed", 120000),
    replicaRouting: () => request({ type: "replicaRouting" }, "replicaRouting", 30000),
    searchTables: () => request({ type: "searchTables" }, "searchTables", 30000),
    stats: () => request({ type: "stats" }, "stats", 30000),
    totals: () => request({ type: "totals" }, "totals", 30000),
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
 * Which chunk table a retrieval statement reads, from its SQL text: the dense
 * route orders by `embedding <=> $1::vector`, the sparse route ranks with
 * ts_rank_cd or calls a version's `<table>_sparse_rank` function. Null for
 * any other statement. Index versions are separate tables
 * (rag_document_chunks, rag_document_chunks_v2, ...), so this says which
 * version a search went to without asking the app.
 */
export const readSearchedChunkTable = (text) => {
  const sql = String(text ?? "");
  const route = sql.includes("<=> $1::vector") ? "dense" : /ts_rank_cd|_sparse_rank\(/.test(sql) ? "sparse" : null;
  if (!route) return null;
  const source = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1];
  if (!source) return null;

  return { route, table: source.replace(/_sparse_rank$/, "") };
};

/** Bounded record of the transitions kept per process (index-switch scenario). */
export const MAX_SEARCH_TRANSITIONS = 500;

/**
 * Per chunk table and route: searches, first and last (epoch ms), plus every
 * change of the table the dense route read from one search to the next. The
 * first transition to a new version's table after a switch is when this
 * process started searching it.
 */
export const createSearchTableTracker = ({ now = () => Date.now() } = {}) => {
  const tables = {};
  const transitions = [];
  let lastDenseTable = null;

  return {
    observe: (text) => {
      const searched = readSearchedChunkTable(text);
      if (!searched) return;
      const at = now();
      const key = `${searched.route}:${searched.table}`;
      const entry = (tables[key] ??= { count: 0, firstAt: at, lastAt: at, route: searched.route, table: searched.table });
      entry.count += 1;
      entry.lastAt = at;
      if (searched.route === "dense" && searched.table !== lastDenseTable) {
        if (transitions.length < MAX_SEARCH_TRANSITIONS) transitions.push({ at, from: lastDenseTable, to: searched.table });
        lastDenseTable = searched.table;
      }
    },
    snapshot: () => ({
      tables: Object.fromEntries(Object.entries(tables).map(([key, entry]) => [key, { ...entry }])),
      transitions: transitions.map((entry) => ({ ...entry })),
      transitionsTruncated: transitions.length >= MAX_SEARCH_TRANSITIONS,
    }),
  };
};

/**
 * Counts every statement this process sends to PostgreSQL: each pg
 * client.query call (pooled or dedicated; the BEGIN, SET and COMMIT around a
 * tenant-scoped statement count too). Installed on the pg module the app
 * imports, before the app is loaded; a process without PostgreSQL counts 0.
 * `counter.searches` (a createSearchTableTracker) also sees each statement's
 * text, to record which chunk table the retrieval statements read.
 */
const installPostgresQueryCounter = async (counter) => {
  const { default: pg } = await import("pg");
  const original = pg.Client.prototype.query;

  if (original.__loadTestCounted) return;
  const counted = function countedQuery(...args) {
    counter.queries += 1;
    const first = args[0];
    counter.searches?.observe(typeof first === "string" ? first : first?.text);
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
  const postgres = { queries: 0, searches: createSearchTableTracker() };
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
      } else if (message?.type === "totals") {
        // Whole-life CPU of this process (start-up, seed ingest and every
        // level), read once before it stops.
        const cpu = process.cpuUsage();
        process.send({
          cpuSystemMs: round(cpu.system / 1000),
          cpuUserMs: round(cpu.user / 1000),
          dbQueries: postgres.queries,
          maxRssMb: round(process.resourceUsage().maxRSS / 1024),
          pid: process.pid,
          type: "totals",
          uptimeMs: round(process.uptime() * 1000),
        });
      } else if (message?.type === "searchTables") {
        process.send({ ...postgres.searches.snapshot(), type: "searchTables" });
      } else if (message?.type === "replicaRouting") {
        // This process's read replica counters (rag/postgres-replicas.js).
        const replicas = await import("../rag/postgres-replicas.js").catch(() => null);
        process.send({
          snapshot: typeof replicas?.getReplicaRoutingSnapshot === "function" ? replicas.getReplicaRoutingSnapshot() : null,
          type: "replicaRouting",
        });
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

// The seed corpus, ingested by the process that received it (the monolith's
// primary instance, or the split topology's primary api replica) through the
// rag service's own ingest, as the tenant the requests act for. With
// `countRows` the chunk rows are then counted in PostgreSQL.
const ingestSeedCorpus = async ({ countRows = false, documents = [], seedFormat = "text", tempRoot }) => {
  const rag = await import("../chat.js");
  const sourceDirectory = path.join(tempRoot, "sources");
  await mkdir(sourceDirectory, { recursive: true });

  const ingestStartedAt = performance.now();
  let chunkCount = 0;
  for (const doc of documents) {
    const owner = {
      ownerUserId: process.env.LOAD_TEST_TENANT_USER_ID ?? "",
      workspaceId: process.env.LOAD_TEST_TENANT_WORKSPACE_ID ?? "",
    };
    let registered;
    if (seedFormat === "pdf") {
      // Real PDF bytes in the registry, through the upload route's own
      // ingest (parse, chunk, embed, index): an index version build
      // re-reads them, so the rebuilt chunks equal the stored ones.
      const filePath = path.join(sourceDirectory, `${doc.docId}.pdf`);
      await writeFile(filePath, buildSeedPdf(doc));
      registered = await rag.ingestDocument({ docId: doc.docId, fileName: doc.fileName, filePath, ...owner });
    } else {
      const filePath = path.join(sourceDirectory, `${doc.docId}.txt`);
      await writeFile(filePath, doc.pages.map((page) => page.text).join("\n\n"), "utf8");
      registered = await rag.ingestDocumentPages({
        docId: doc.docId,
        fileName: doc.fileName,
        filePath,
        pages: doc.pages,
        ...owner,
      });
    }
    chunkCount += Number(registered?.chunkCount ?? 0);
  }
  const ingestMs = performance.now() - ingestStartedAt;
  let databaseChunkRows = null;
  if (countRows) {
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

  return { chunkCount, databaseChunkRows, ingestMs };
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
    const app = await createApp({
      uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
      uploadsDirectory: path.join(tempRoot, "uploads"),
    });
    const { chunkCount, databaseChunkRows, ingestMs } = await ingestSeedCorpus({
      countRows: storage === "pgvector" && message.primary,
      documents: message.documents,
      seedFormat: message.seedFormat,
      tempRoot,
    });
    const { describeVectorStoreRuntime } = await import("../rag/vector-store.js");

    const worker = await startInProcessIngestWorker(app);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    // What server.js does once it listens: with METRICS_ENABLED unset this is
    // null and changes nothing; with it, the app server's requests are
    // recorded and /metrics listens on a port of its own.
    const { startMetricsFromEnv } = await import("../rag/metrics-server.js");
    const metrics = await startMetricsFromEnv({
      httpServer: server,
      ingestJobStore: process.env.RAG_INGEST_MODE === "async" ? (app.locals?.services?.ingestJobStore ?? null) : null,
    });

    return {
      reply: {
        chunkCount,
        databaseChunkRows,
        documentCount: message.documents.length,
        ingestMs: round(ingestMs),
        ingestWorker: await describeIngestWorkerSettings(worker),
        metricsPort: metrics?.port ?? null,
        pid: process.pid,
        port: server.address().port,
        vectorStore: describeVectorStoreRuntime(),
      },
      shutdown: async () => {
        server?.closeAllConnections?.();
        server?.close();
        await metrics?.close();
        await worker?.stop?.();
      },
    };
  });
};

// One process of the split topology (--topology split): the role's own
// start-up, what `ARCHIVE_RAG_ROLE=<role> node server.js` runs
// (startServiceRole: topology validation, the role's app, listen), on an
// ephemeral port, without signal handlers (the harness stops it over IPC).
// The first process to touch the fresh database (retrieval replica 0, whose
// start-up health check migrates it) refuses one in use first; the primary api
// replica then ingests the seed corpus through the edge's ingest path, whose
// embeddings go through the model gateway.
const serveTier = async () => {
  const tempRoot = process.env.LOAD_TEST_TEMP_ROOT;
  const role = process.env.ARCHIVE_RAG_ROLE;

  handleChildMessages(async (message) => {
    if (message.assertFresh) {
      const { queryPostgres } = await import("../rag/postgres.js");
      await assertFreshLoadTestDatabase(queryPostgres);
    }

    const { startServiceRole } = await import("../rag/agent-service/role-server.js");
    const started = await startServiceRole({
      // The edge and the agent tier build the monolith's services, over the
      // run's shared directories.
      appOptions:
        role === "api" || role === "agent"
          ? {
              uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
              uploadsDirectory: path.join(tempRoot, "uploads"),
            }
          : {},
      exit: () => {},
      handleSignals: false,
      host: "127.0.0.1",
      port: 0,
      role,
    });
    const seed = message.primary
      ? await ingestSeedCorpus({
          countRows: true,
          documents: message.documents,
          seedFormat: message.seedFormat,
          tempRoot,
        })
      : { chunkCount: 0, databaseChunkRows: null, ingestMs: 0 };
    const { describeVectorStoreRuntime } = await import("../rag/vector-store.js");

    return {
      reply: {
        chunkCount: seed.chunkCount,
        databaseChunkRows: seed.databaseChunkRows,
        documentCount: message.documents.length,
        ingestMs: round(seed.ingestMs),
        ingestWorker: null,
        pid: process.pid,
        port: started.port,
        role,
        vectorStore: role === "model-gateway" ? null : describeVectorStoreRuntime(),
      },
      shutdown: () => started.shutdown("shutdown"),
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

// A process the crash injection killed reports nothing (null).
const collectStats = (processes) => Promise.all(processes.map((child) => (child.exited ? null : child.stats())));

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

// ---------------------------------------------------------------------------
// Read replica (--read-replica-url)

// What a pgvector run's statements are, per node, for --read-replica-url: the
// retrieval searches, the replica freshness guard and the tenant settings
// (what a replica can take), other reads, transaction control, writes and
// utility statements (the primary's alone), and the replica monitor's polls.
export const NODE_STATEMENT_KINDS = Object.freeze([
  "search",
  "guard",
  "tenantSettings",
  "otherRead",
  "transaction",
  "writeOrUtility",
  "monitor",
]);

/** The kind of one pg_stat_statements entry (its normalized query text). */
export const classifyNodeStatement = (query) => {
  const text = String(query ?? "");

  // pg_stat_statements keeps no leading comment, so the guard is known by its
  // shape (rag/postgres-replicas.js buildDocumentFreshnessGuard).
  if (/AS expected\(doc_id, content_version\)/u.test(text)) return "guard";
  if (/pg_last_wal_replay_lsn|pg_current_wal_flush_lsn/u.test(text)) return "monitor";
  // rag/postgres.js's tenant settings: three set_config calls in one SELECT
  // (pg_stat_statements shows their literals as $n).
  if (/set_config\([^)]*\),\s*set_config\([^)]*\),\s*set_config\(/u.test(text)) return "tenantSettings";
  if (/AS vector_score|AS sparse_score|_sparse_search\(|_sparse_rank\(/u.test(text)) return "search";
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|START|SAVEPOINT|RELEASE)\b/iu.test(text)) return "transaction";
  if (
    /\b(INSERT|UPDATE|DELETE|MERGE)\b/iu.test(text) ||
    /^\s*(\/\*[\s\S]*?\*\/\s*)*(CREATE|ALTER|DROP|TRUNCATE|ANALYZE|VACUUM|LOCK|GRANT|REVOKE|SET|LISTEN|UNLISTEN|NOTIFY|DO|CALL)\b/iu.test(text)
  ) {
    return "writeOrUtility";
  }
  return "otherRead";
};

/** Calls per kind over pg_stat_statements rows ({ query, calls }), plus `total`. */
export const summarizeNodeStatements = (rows = []) => {
  const counts = Object.fromEntries(NODE_STATEMENT_KINDS.map((kind) => [kind, 0]));

  for (const row of rows) {
    // The harness's own reads of the view.
    if (/pg_stat_statements/u.test(String(row?.query ?? ""))) continue;
    counts[classifyNodeStatement(row?.query)] += Number(row?.calls) || 0;
  }

  return { ...counts, total: NODE_STATEMENT_KINDS.reduce((sum, kind) => sum + counts[kind], 0) };
};

/** `after` minus `before` per kind, never below 0 (an entry pg_stat_statements evicted). */
export const diffNodeStatements = (before, after) =>
  Object.fromEntries(
    [...NODE_STATEMENT_KINDS, "total"].map((kind) => [kind, Math.max(0, (Number(after?.[kind]) || 0) - (Number(before?.[kind]) || 0))])
  );

/** `after` minus `before` for every count of two sumReplicaRouting results. */
export const diffReplicaRouting = (before, after) => {
  const diff = (left = {}, right = {}) =>
    Object.fromEntries(Object.keys(right).map((key) => [key, (Number(right[key]) || 0) - (Number(left[key]) || 0)]));

  return {
    bypasses: diff(before?.bypasses, after?.bypasses),
    fallbacks: diff(before?.fallbacks, after?.fallbacks),
    processes: after?.processes ?? 0,
    reads: diff(before?.reads, after?.reads),
  };
};

/** Read replica counters summed over the app processes' getReplicaRoutingSnapshot(). */
export const sumReplicaRouting = (snapshots = []) => {
  const total = { bypasses: {}, fallbacks: {}, processes: 0, reads: { primary: 0, replica: 0 } };
  const add = (into, from) => {
    for (const [key, value] of Object.entries(from ?? {})) into[key] = (into[key] ?? 0) + (Number(value) || 0);
  };

  for (const snapshot of snapshots) {
    if (!snapshot?.enabled) continue;
    total.processes += 1;
    add(total.reads, snapshot.reads);
    add(total.fallbacks, snapshot.fallbacks);
    add(total.bypasses, snapshot.bypasses);
  }

  return total;
};

const withNodeClient = async (url, callback) => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });

  await client.connect();

  try {
    return await callback(client);
  } finally {
    await client.end();
  }
};

/** Refuses a --read-replica-url that is not a hot standby. */
const assertReadReplica = async (url) => {
  const inRecovery = await withNodeClient(url, async (client) => (await client.query("SELECT pg_is_in_recovery() AS standby")).rows[0]?.standby);

  if (inRecovery !== true) {
    throw new Error("--read-replica-url must point at a hot standby (pg_is_in_recovery() is false there).");
  }
};

// The run database's pg_stat_statements on one node, or null without it.
const readNodeStatements = async (url) => {
  try {
    return await withNodeClient(url, async (client) =>
      summarizeNodeStatements(
        (
          await client.query(
            `SELECT s.query, s.calls::bigint AS calls
             FROM pg_stat_statements s
             JOIN pg_database d ON d.oid = s.dbid
             WHERE d.datname = current_database()`
          )
        ).rows
      )
    );
  } catch (error) {
    console.warn(`[pgvector] pg_stat_statements is not readable on ${new URL(url).host} (${error?.code ?? error?.message}); per-node statements are not counted.`);
    return null;
  }
};

const readRoutingSnapshots = (processes) =>
  Promise.all(
    processes.map((child) => (typeof child.replicaRouting === "function" ? child.replicaRouting().then((reply) => reply.snapshot) : null))
  );

// Per-node statements and every process's routing counters, at one mark.
const readReplicaStatementMark = async ({ options, processes }) => ({
  primary: await readNodeStatements(options.databaseUrl),
  replica: await readNodeStatements(options.readReplicaUrl),
  routing: sumReplicaRouting(await readRoutingSnapshots(processes)),
});

/**
 * What the measured levels of a --read-replica-url run did: statements per
 * node (pg_stat_statements) and the app processes' routing counters, both
 * over the window since `before`, plus each process's replica state at the
 * end. Host and port only, never a URL.
 */
const collectReadReplicaReport = async ({ before, options, processes }) => {
  const after = await readReplicaStatementMark({ options, processes });
  const snapshots = await readRoutingSnapshots(processes);

  return {
    endpoint: new URL(options.readReplicaUrl).host,
    routing: {
      // Each process's own counters at the end, since it started (warm-up
      // included), and its replica's state then.
      processesAtEnd: snapshots.map((snapshot) =>
        snapshot?.enabled
          ? {
              bypasses: snapshot.bypasses,
              fallbacks: snapshot.fallbacks,
              reads: snapshot.reads,
              replicas: (snapshot.replicas ?? []).map((replica) => ({
                circuit: replica.circuit?.state ?? null,
                id: replica.id,
                lagMs: replica.lagMs,
                state: replica.state,
              })),
            }
          : null
      ),
      total: diffReplicaRouting(before.routing, after.routing),
    },
    statements:
      before.primary && before.replica && after.primary && after.replica
        ? {
            primary: diffNodeStatements(before.primary, after.primary),
            replica: diffNodeStatements(before.replica, after.replica),
          }
        : null,
  };
};

// pg_stat_statements on the primary (and the replica, with one) and the
// processes' routing counters, read at one of a level's window marks; the two
// nodes are read at once so the marks line up.
const readNodeMark = async ({ options, processes }) => {
  const [primary, replica, routing] = await Promise.all([
    readNodeStatements(options.databaseUrl),
    options.readReplicaUrl ? readNodeStatements(options.readReplicaUrl) : null,
    options.readReplicaUrl ? readRoutingSnapshots(processes).then(sumReplicaRouting) : null,
  ]);

  return { primary, replica, routing };
};

/**
 * One measured level's statements per node and routing counters (end mark
 * minus start mark), per request, and the share of marked reads the replica
 * served. "Net of monitor" leaves out the replica lag monitor's polls, which
 * run on a timer, not per request. Null when a node was not readable.
 */
export const describeNodeLevel = ({ end, requests, start }) => {
  if (!start?.primary || !end?.primary) return null;

  const per = (value) => (requests > 0 ? round(value / requests, 2) : null);
  const primary = diffNodeStatements(start.primary, end.primary);
  const replica = start.replica && end.replica ? diffNodeStatements(start.replica, end.replica) : null;
  const routing = start.routing && end.routing ? diffReplicaRouting(start.routing, end.routing) : null;
  const markedReads = routing ? (routing.reads.primary ?? 0) + (routing.reads.replica ?? 0) : 0;

  return {
    perRequest: {
      primary: per(primary.total),
      primaryNetOfMonitor: per(primary.total - primary.monitor),
      replica: replica ? per(replica.total) : null,
      replicaNetOfMonitor: replica ? per(replica.total - replica.monitor) : null,
    },
    primary,
    replica,
    replicaReadShare: markedReads > 0 ? round(routing.reads.replica / markedReads, 3) : null,
    routing,
  };
};

/**
 * Samples every process's replica lag (getReplicaRoutingSnapshot, which the
 * lag monitor refreshes every POSTGRES_READ_REPLICA_LAG_POLL_MS) while a level
 * is measured, keeping the largest. A replica whose lag is unknown counts as
 * an unknown sample.
 */
const createLagSampler = (processes, intervalMs = 500) => {
  let timer = null;
  let reading = false;
  const seen = { maxLagMs: null, samples: 0, unknownSamples: 0, unusableSamples: 0 };
  const sample = async () => {
    if (reading) return;
    reading = true;
    try {
      for (const snapshot of await readRoutingSnapshots(processes)) {
        for (const replica of snapshot?.replicas ?? []) {
          seen.samples += 1;
          if (Number.isFinite(replica.lagMs)) seen.maxLagMs = Math.max(seen.maxLagMs ?? 0, replica.lagMs);
          else seen.unknownSamples += 1;
          if (replica.usable === false) seen.unusableSamples += 1;
        }
      }
    } catch {
      // A missed sample; the next one reads again.
    } finally {
      reading = false;
    }
  };

  return {
    describe: () => ({ intervalMs, ...seen }),
    start: () => {
      sample();
      timer = setInterval(sample, intervalMs);
    },
    stop: () => {
      clearInterval(timer);
      timer = null;
    },
  };
};

export const formatReadReplica = (readReplica) => {
  if (!readReplica) return [];

  const { routing, statements } = readReplica;
  const total = routing?.total ?? { fallbacks: {}, reads: {} };
  const fallbacks = Object.entries(total.fallbacks ?? {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`);
  const lines = [
    "",
    `Read replica: one streaming replica at ${readReplica.endpoint} (POSTGRES_READ_REPLICA_URLS in every app process). Over the measured levels the app processes sent ${cell(total.reads?.replica)} read(s) to the replica and ${cell(total.reads?.primary)} marked read(s) to the primary${fallbacks.length > 0 ? ` (fallbacks: ${fallbacks.join(", ")})` : " (no fallbacks)"}.`,
  ];

  if (statements) {
    lines.push(
      "",
      "| Node | Searches | Freshness guards | Tenant settings | Other reads | Transaction control | Writes / utility | Replica monitor | Total |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...["primary", "replica"].map(
        (node) =>
          `| ${node} | ${NODE_STATEMENT_KINDS.map((kind) => cell(statements[node]?.[kind])).join(" | ")} | ${cell(statements[node]?.total)} |`
      ),
      "",
      "Statement calls per node from pg_stat_statements over the measured levels (cheap path and /chat), on each node separately."
    );
  } else {
    lines.push("Per-node statement counts: not available (pg_stat_statements was not readable on both nodes).");
  }

  return lines;
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

// ---------------------------------------------------------------------------
// Topology: per-tier accounting

/**
 * The run's topology as the config records it: the process count per tier and
 * in total. A monolith run is `instances` processes of role all (plus its
 * dedicated ingest workers); a split run is its tier replicas.
 */
export const describeTopologyConfig = (options = {}) => {
  const tierReplicas =
    options.topology === "split"
      ? Object.fromEntries(TIER_REPORT_ORDER.map((tier) => [tier, options.tierReplicas?.[tier] ?? 1]))
      : {
          [MONOLITH_TIER]: options.instances ?? 1,
          ...((options.ingestWorkers ?? 0) > 0 ? { "ingest-worker": options.ingestWorkers } : {}),
        };

  return {
    topology: options.topology === "split" ? "split" : "monolith",
    tierReplicas,
    totalProcesses: Object.values(tierReplicas).reduce((total, count) => total + count, 0),
  };
};

const coresBusyOf = (stats) =>
  Number.isFinite(stats?.windowMs) && stats.windowMs > 0 ? processCpuMs(stats) / stats.windowMs : null;

/**
 * Per tier of one window: the stats of that tier's processes combined
 * (combineServerStats, with their idle rates in the same order), the cores
 * busy of the tier's busiest process and the tier's share of all the app
 * processes' CPU in the window. `processTiers[i]` names the tier of
 * `stats[i]`; tiers keep the order they first appear in. A process that
 * reported nothing (null stats) counts in `processes`, not in `reporting`.
 */
export const summarizeTierStats = ({ idle = null, processTiers = [], stats = [], units = 0 } = {}) => {
  const totalCpuMs = stats.reduce((total, entry) => total + processCpuMs(entry), 0);

  return Object.fromEntries(
    [...new Set(processTiers)].map((tier) => {
      const indexes = processTiers.flatMap((name, index) => (name === tier ? [index] : []));
      const tierStats = indexes.map((index) => stats[index] ?? null);
      const combined = combineServerStats(tierStats, units, {
        idle: Array.isArray(idle) ? indexes.map((index) => idle[index] ?? null) : null,
      });
      const cpuMs = (combined.cpuUserMs ?? 0) + (combined.cpuSystemMs ?? 0);
      const processCores = tierStats.map(coresBusyOf).filter(Number.isFinite);

      return [
        tier,
        {
          processes: indexes.length,
          reporting: tierStats.filter(Boolean).length,
          cpuUserMs: combined.cpuUserMs,
          cpuSystemMs: combined.cpuSystemMs,
          cpuMs: round(cpuMs),
          cpuMsPerRequest: combined.cpuMsPerUnit,
          cpuMsPerRequestNetOfIdle: combined.cpuMsPerUnitNetOfIdle,
          coresBusy: combined.coresBusy,
          maxProcessCoresBusy: processCores.length > 0 ? round(Math.max(...processCores), 2) : null,
          shareOfCpu: totalCpuMs > 0 ? round(cpuMs / totalCpuMs, 3) : null,
          dbQueries: combined.dbQueries,
          dbQueriesPerRequest: combined.dbQueriesPerUnit,
          eventLoopDelayMaxMs: combined.eventLoopDelayMaxMs,
          eventLoopDelayP99Ms: combined.eventLoopDelayP99Ms,
          rssMb: combined.rssMb,
        },
      ];
    })
  );
};

/**
 * The tier whose busiest process kept the most cores busy in the window (ties:
 * the worse event-loop delay): the tier to scale first. A Node process runs
 * its JavaScript on one thread, so a process close to one core busy, with its
 * event-loop delay rising, is saturated. Null without CPU data.
 */
export const pickBusiestTier = (tiers = {}) => {
  let busiest = null;

  for (const [tier, entry] of Object.entries(tiers ?? {})) {
    if (!Number.isFinite(entry?.maxProcessCoresBusy)) continue;
    const loop = Number.isFinite(entry.eventLoopDelayP99Ms) ? entry.eventLoopDelayP99Ms : -1;
    if (
      !busiest ||
      entry.maxProcessCoresBusy > busiest.maxProcessCoresBusy ||
      (entry.maxProcessCoresBusy === busiest.maxProcessCoresBusy && loop > (busiest.eventLoopDelayP99Ms ?? -1))
    ) {
      busiest = {
        eventLoopDelayP99Ms: entry.eventLoopDelayP99Ms ?? null,
        maxProcessCoresBusy: entry.maxProcessCoresBusy,
        tier,
      };
    }
  }

  return busiest;
};

/**
 * Model calls the fake received from anything but a gateway process in a
 * window (from its per-caller counts): 0 when every tier of a split run
 * reached the model through the gateway.
 */
export const countDirectModelCalls = (byCaller = {}, gatewayPrefix = GATEWAY_CALLER_PREFIX) =>
  Object.entries(byCaller ?? {}).reduce(
    (total, [caller, entry]) =>
      caller.startsWith(gatewayPrefix) ? total : total + (entry?.chat ?? 0) + (entry?.embeddings ?? 0),
    0
  );

/** min / max / mean (and n) of the finite values; null without any. */
export const rangeOf = (values = []) => {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;

  return {
    max: Math.max(...finite),
    mean: round(finite.reduce((total, value) => total + value, 0) / finite.length, 2),
    min: Math.min(...finite),
    n: finite.length,
  };
};

/**
 * The range of each level's numbers over its repeats (levels carry
 * `concurrency` and, with --repeat, `repeat`): throughput, the latency mean
 * and percentiles, CPU per request of all app processes and of each tier, and
 * how often each tier was the busiest. One row per concurrency, in order.
 */
export const summarizeLevelRepeats = (levels = []) => {
  const byConcurrency = new Map();
  for (const level of levels) {
    if (!byConcurrency.has(level.concurrency)) byConcurrency.set(level.concurrency, []);
    byConcurrency.get(level.concurrency).push(level);
  }

  return [...byConcurrency.entries()].map(([concurrency, runs]) => {
    const tierNames = [...new Set(runs.flatMap((level) => Object.keys(level.tiers ?? {})))];
    const busiestTiers = {};
    for (const level of runs) {
      const tier = level.busiestTier?.tier;
      if (tier) busiestTiers[tier] = (busiestTiers[tier] ?? 0) + 1;
    }

    return {
      concurrency,
      runs: runs.length,
      errors: runs.reduce((total, level) => total + (level.errors ?? 0), 0),
      throughputRps: rangeOf(runs.map((level) => level.throughputRps)),
      latencyMeanMs: rangeOf(runs.map((level) => level.latencyMs?.mean)),
      latencyP50Ms: rangeOf(runs.map((level) => level.latencyMs?.p50)),
      latencyP95Ms: rangeOf(runs.map((level) => level.latencyMs?.p95)),
      latencyP99Ms: rangeOf(runs.map((level) => level.latencyMs?.p99)),
      cpuMsPerRequest: rangeOf(runs.map((level) => level.server?.cpuMsPerRequest)),
      tiers: Object.fromEntries(
        tierNames.map((tier) => [
          tier,
          {
            cpuMsPerRequest: rangeOf(runs.map((level) => level.tiers?.[tier]?.cpuMsPerRequest)),
            maxProcessCoresBusy: rangeOf(runs.map((level) => level.tiers?.[tier]?.maxProcessCoresBusy)),
          },
        ])
      ),
      busiestTiers,
    };
  });
};

/**
 * Whole-run CPU per process and per tier, from each process's totals reply
 * (read once before it stops; start-up, seed ingest and every level
 * included). `processes[i]` is { tier, index, port } of `totals[i]`; a
 * process that was gone (null) is listed without numbers.
 */
export const summarizeProcessTotals = ({ processes = [], totals = [] } = {}) => {
  const rows = processes.map((entry, position) => {
    const reply = totals[position];
    return {
      tier: entry.tier,
      index: entry.index,
      port: entry.port ?? null,
      pid: reply?.pid ?? entry.pid ?? null,
      cpuUserMs: reply ? reply.cpuUserMs : null,
      cpuSystemMs: reply ? reply.cpuSystemMs : null,
      cpuMs: reply ? round((reply.cpuUserMs ?? 0) + (reply.cpuSystemMs ?? 0)) : null,
      dbQueries: reply ? reply.dbQueries ?? null : null,
      maxRssMb: reply ? reply.maxRssMb ?? null : null,
      uptimeMs: reply ? reply.uptimeMs ?? null : null,
    };
  });
  const totalCpuMs = rows.reduce((total, row) => total + (row.cpuMs ?? 0), 0);
  const byTier = {};
  for (const row of rows) {
    const entry = (byTier[row.tier] ??= { processes: 0, reporting: 0, cpuUserMs: 0, cpuSystemMs: 0, cpuMs: 0 });
    entry.processes += 1;
    if (row.cpuMs === null) continue;
    entry.reporting += 1;
    entry.cpuUserMs = round(entry.cpuUserMs + row.cpuUserMs);
    entry.cpuSystemMs = round(entry.cpuSystemMs + row.cpuSystemMs);
    entry.cpuMs = round(entry.cpuMs + row.cpuMs);
  }
  for (const entry of Object.values(byTier)) {
    entry.shareOfCpu = totalCpuMs > 0 ? round(entry.cpuMs / totalCpuMs, 3) : null;
  }

  return { byTier, processes: rows, totalCpuMs: round(totalCpuMs) };
};

/**
 * Warm-up passes a split run may make: query embeddings run in the retrieval
 * tier, one cache per replica, and the agent tier's client picks the replica,
 * so one pass over the question pool need not reach every replica with every
 * question. Passes repeat until one sends no embeddings request, at most this
 * many.
 */
export const splitWarmUpPassLimit = (retrievalReplicas = 1) => 2 + 4 * Math.max(1, retrievalReplicas);

/**
 * One scenario's levels. `apps` are the processes the load generator sends to
 * (monolith instances, or the split topology's api replicas); `processes` is
 * every app process whose stats a level reads (the api replicas first, so the
 * per-instance rows line up) and `processTiers` their tiers. Each level runs
 * --repeat times in a row.
 */
const runScenario = async ({
  apps,
  baseUrls,
  fakeModel,
  headers,
  hostSampler,
  idle,
  instances,
  options,
  processes = apps,
  processTiers = apps.map(() => MONOLITH_TIER),
  profile,
  runId,
  target,
}) => {
  const levels = [];
  const balancer = createInstanceBalancer({ count: baseUrls.length, mode: options.balance });
  const repeat = options.repeat ?? 1;
  const split = options.topology === "split";
  const runs = options.concurrency.flatMap((concurrency) =>
    Array.from({ length: repeat }, (_, index) => ({ concurrency, run: index + 1 }))
  );

  for (const { concurrency, run } of runs) {
    const requests = measuredRequestsForLevel({
      concurrency,
      minRequestsPerClient: options.minRequestsPerClient,
      requests: target.kind === "chat" ? options.requests : options.cheapRequests,
    });
    const sessionTag = `load-${runId}-${target.kind}-${profile ?? "na"}-c${concurrency}${repeat > 1 ? `-r${run}` : ""}`;
    const warmup = options.warmup > 0 ? Math.max(options.warmup, concurrency) : 0;
    let statsAtStart = null;
    let statsAtEnd = null;
    let hostAtStart = null;
    let hostAtEnd = null;
    let model = null;
    // --node-statements / --read-replica-url: per-node statements of /chat levels.
    const nodeMarks = target.kind === "chat" && options.nodeStatements;
    let nodeAtStart = null;
    let nodeAtEnd = null;
    const lagSampler = nodeMarks && options.readReplicaUrl ? createLagSampler(processes) : null;

    // Marks taken inside the loop, when the first measured request and the
    // first cool-down request are sent (runClosedLoop's window): exactly the
    // measured count of requests returns between them.
    const hooks = {
      onMeasureEnd: () => {
        model = fakeModel.snapshot();
        statsAtEnd = collectStats(processes);
        hostAtEnd = hostSampler?.mark() ?? null;
        if (nodeMarks) nodeAtEnd = readNodeMark({ options, processes });
        lagSampler?.stop();
      },
      onMeasureStart: () => {
        fakeModel.resetStats();
        statsAtStart = collectStats(processes);
        hostAtStart = hostSampler?.mark() ?? null;
        if (nodeMarks) nodeAtStart = readNodeMark({ options, processes });
        lagSampler?.start();
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
    // Model calls the app still holds open once every /chat has returned
    // (the fake counts a call until its caller closes it or it is answered).
    const modelInFlightAfterDrain = target.kind === "chat" ? fakeModel.inFlightNow() : null;
    await statsAtStart;
    const serverStats = await statsAtEnd;
    const summary = summarizeLevel({ results, wallMs });
    const nodeStatements = nodeMarks
      ? {
          ...describeNodeLevel({ end: await nodeAtEnd, requests: summary.requests, start: await nodeAtStart }),
          ...(lagSampler ? { lag: lagSampler.describe() } : {}),
        }
      : null;
    const host = hostSampler ? hostSampler.diff(await hostAtStart, await hostAtEnd, { units: summary.requests }) : null;
    // Exactly `requests` requests return inside the window (runClosedLoop), so
    // counters read over it divide by that.
    const perRequest = (value) => (summary.requests > 0 ? round(value / summary.requests, 2) : null);
    const combined = combineServerStats(serverStats, summary.requests, { idle });
    const perInstance = summarizeByInstance(results, apps.length);
    const tiers = summarizeTierStats({ idle, processTiers, stats: serverStats, units: summary.requests });
    const busiestTier = pickBusiestTier(tiers);

    levels.push({
      concurrency,
      ...(repeat > 1 ? { repeat: run } : {}),
      warmupRequests: warmup,
      cooldownRequests,
      windowCompletions,
      ...summary,
      ...(Number.isInteger(options.agentRequestTimeoutMs) && target.kind === "chat"
        ? { failedLatencyMs: summarizeLatencies(results.filter((result) => result && !isSuccess(result)).map((result) => result.latencyMs)) }
        : {}),
      ...(nodeStatements ? { nodeStatements } : {}),
      littleLawMeanMs: littleLawMeanMs(concurrency, summary.throughputRps),
      model: {
        ...(modelInFlightAfterDrain ? { inFlightAfterDrain: modelInFlightAfterDrain } : {}),
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
        ...(split ? { directCalls: countDirectModelCalls(model.byCaller) } : {}),
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
      tiers,
      busiestTier,
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
    const tierCpu = split
      ? `  cores busy per tier ${Object.entries(tiers)
          .map(([tier, entry]) => `${tier} ${cell(entry.coresBusy)} (max ${cell(entry.maxProcessCoresBusy)})`)
          .join(" / ")}; busiest ${busiestTier?.tier ?? "-"}`
      : "";
    console.log(
      `  ${target.label.padEnd(26)} c=${String(concurrency).padStart(3)}${repeat > 1 ? ` #${run}` : ""}  ${String(summary.throughputRps).padStart(8)} req/s  mean ${summary.latencyMs.mean} ms  p50 ${summary.latencyMs.p50} ms  p95 ${summary.latencyMs.p95} ms  p99 ${summary.latencyMs.p99} ms (n=${summary.latencyMs.count})  errors ${summary.errors}/${summary.requests}${target.kind === "chat" ? `  peak model in flight ${model.chat.peakInFlight}` : ""}${spread}${tierCpu}`
    );
    if (nodeStatements?.perRequest) {
      console.log(
        `    statements per request: primary ${nodeStatements.perRequest.primary} (net of monitor ${nodeStatements.perRequest.primaryNetOfMonitor}), replica ${cell(nodeStatements.perRequest.replica)}; replica read share ${cell(nodeStatements.replicaReadShare)}${nodeStatements.lag ? `; max lag ${cell(nodeStatements.lag.maxLagMs)} ms` : ""}`
      );
    }
  }

  return {
    endpoint: target.kind === "chat" ? "POST /chat" : `GET ${target.path}`,
    kind: target.kind,
    levels,
    ...(repeat > 1 ? { repeats: summarizeLevelRepeats(levels) } : {}),
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

const runIngestScenario = async ({ apps, baseUrls, corpus, fakeModel, headers, hostSampler, idle, instances, options, profile, runId, workerLoops, workerProcesses = [], workers }) => {
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
    // --crash-worker-mid-embed: worker 0 is killed during its first
    // embeddings request of the window (createCrashInjection).
    const crash = options.crashWorkerMidEmbed
      ? await createCrashInjection({
          databaseUrl: options.databaseUrl,
          fakeModel,
          victim: workers[0],
          victimCaller: "load-test-worker-0",
          victimWorkerId: workerProcesses[0]?.workerId ?? null,
        })
      : null;
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
          crash?.arm();
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
    const crashReport = crash ? await crash.finish() : null;
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
            perProcess: workerStats.map((entry, index) => {
              if (!entry) return { index, killed: true };
              const { type: _type, ...stats } = entry;
              return { index, ...stats };
            }),
          }
        : null,
      // The dedicated workers' own embeddings requests (their API keys): the
      // documents' embeddings only, no chat or probe query embeddings.
      documentEmbeddings: describeWorkerEmbeddings({ byCaller: model.byCaller, documents: ingest.searchable }),
      ...(crashReport ? { crash: crashReport } : {}),
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
      `  POST /upload (${options.ingestMode}) c=${String(uploadConcurrency).padStart(3)} r${repeatIndex + 1}  ${ingest.searchable}/${ingest.uploads} searchable${ingest.comparable ? "" : " (not comparable)"}  from offer: indexed p50 ${ingest.offeredToIndexedMs.p50} ms, searchable p50 ${ingest.offeredToSearchableMs.p50} ms  ${ingest.indexedDocsPerSecond} docs/s  uploads per instance ${level.uploadSplit.perInstance.join("/")}${level.uploadSplit.imbalanced ? " (imbalanced)" : ""}${options.ingestMode === "async" ? `  queue wait p50 ${ingest.queueWaitMs.p50} ms  processing p50 ${ingest.processingMs.p50} ms` : ""}  polling ${pollingSummary.requestsPerSecond} req/s  chat p95 ${chatDuring?.latencyMs.p95 ?? "-"} ms (idle ${baselineBefore?.latencyMs.p95 ?? "-"}/${baselineAfter?.latencyMs.p95 ?? "-"})${
        level.documentEmbeddings ? `  worker embeddings ${level.documentEmbeddings.requests} req (${level.documentEmbeddings.requestsPerDocument}/doc, ${level.documentEmbeddings.inputsPerRequest} inputs/req)` : ""
      }${
        crashReport?.killed
          ? `  crash: ${crashReport.strandedAtKill} job(s) stranded, ${crashReport.resumed} resumed, ${crashReport.resumedAtStageOfCrash} at the stage of the crash, ${crashReport.resumedWithoutEarlierStage} without re-running an earlier stage`
          : crash
            ? "  crash: worker 0 sent no embeddings request, nothing was killed"
            : ""
      }`
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
// Index switch scenario (--scenario index-switch)
//
// Two or more API instances serve a continuous closed-loop /chat load while
// `npm run vector:index` builds a new pgvector index version under another
// embedding model and width (load-test-embedding-<--switch-dimensions>),
// activates it, and rolls back to the original. Each lifecycle command runs
// as its own process (vector-index.mjs, what an operator runs), against the
// same database and fake model. Every /chat request is kept with the time it
// was sent, so the report splits latency and errors by phase: before, during
// the build, while the activation gate runs, with the new version active,
// during the rollback, and after it.
//
// When a switch is visible: the harness reads the pointer row on a connection
// of its own every few milliseconds while the command runs; the first read
// that shows a new generation is when the switch committed (within one poll).
// When each instance followed: each app process records which chunk table its
// dense retrieval statements read (every version is its own table), so the
// first dense search on the new table after the switch is when that instance
// started serving from it, measured in the process itself.

export const VECTOR_INDEX_ENTRY = path.join(serverDirectory, "vector-index.mjs");
// The app's defaults, unless the harness's own environment names others (the
// app processes inherit these two names).
const indexVersionsTable = () => (process.env.INDEX_VERSIONS_POSTGRES_TABLE || "rag_index_versions").trim();
const ingestJobsTable = () => (process.env.INGEST_JOBS_POSTGRES_TABLE || "rag_ingest_jobs").trim();
const POINTER_POLL_MS = 5;
// A switch shows in the report's own window: the pointer TTL plus this margin.
const SWITCHOVER_MARGIN_MS = 1000;

/** Runs `node vector-index.mjs <args> --json` and resolves with its outcome (never rejects). */
const runIndexCommand = ({ args, environment }) =>
  new Promise((resolve) => {
    const startedAt = performance.now();
    execFile(
      process.execPath,
      [VECTOR_INDEX_ENTRY, ...args, "--json"],
      { cwd: serverDirectory, env: environment, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let result = null;
        try {
          result = JSON.parse(String(stdout));
        } catch {
          result = null;
        }
        resolve({
          args,
          endedAt: performance.now(),
          exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
          result,
          startedAt,
          stderrTail: String(stderr ?? "").split("\n").filter(Boolean).slice(-12),
        });
      }
    );
  });

/** A connection of the harness's own (the database owner) for the registry and queue reads. */
const openHarnessDatabase = async (databaseUrl) => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  return {
    close: () => client.end().catch(() => {}),
    query: (text, values) => client.query(text, values),
    readPointer: async () => {
      const result = await client.query(
        `SELECT active_version_id, previous_version_id, generation::text AS generation,
                (EXTRACT(EPOCH FROM switched_at) * 1000)::float8 AS switched_ms
         FROM ${indexVersionsTable()}_pointer WHERE singleton`
      );
      const row = result.rows[0] ?? {};
      return {
        activeVersionId: Number(row.active_version_id),
        generation: String(row.generation ?? ""),
        previousVersionId: row.previous_version_id === null ? null : Number(row.previous_version_id),
        switchedAt: Number(row.switched_ms) || null,
      };
    },
    readVersions: async () => {
      const result = await client.query(
        `SELECT version_id, status, chunk_table, embedding_model, embedding_dimensions,
                chunk_count::int AS chunk_count, document_count, build_documents_done, build_documents_failed,
                (EXTRACT(EPOCH FROM build_started_at) * 1000)::float8 AS build_started_ms,
                (EXTRACT(EPOCH FROM build_completed_at) * 1000)::float8 AS build_completed_ms,
                dual_write_until IS NOT NULL AND dual_write_until > NOW() AS in_dual_write_window
         FROM ${indexVersionsTable()} ORDER BY version_id`
      );
      return result.rows.map((row) => ({
        buildCompletedAt: Number(row.build_completed_ms) || null,
        buildDocumentsDone: row.build_documents_done,
        buildDocumentsFailed: row.build_documents_failed,
        buildStartedAt: Number(row.build_started_ms) || null,
        chunkCount: row.chunk_count,
        chunkTable: row.chunk_table,
        documentCount: row.document_count,
        embeddingDimensions: row.embedding_dimensions,
        embeddingModel: row.embedding_model,
        inDualWriteWindow: row.in_dual_write_window === true,
        status: row.status,
        versionId: row.version_id,
      }));
    },
  };
};

/**
 * Runs a pointer-switching command (activate, rollback) while reading the
 * pointer every POINTER_POLL_MS: `visible` is the first read that shows a new
 * generation (epoch ms), `lastUnchangedAt` the read before it, so the commit
 * happened between the two. `onVisible` runs as soon as it is seen.
 */
const runPointerSwitch = async ({ args, database, environment, onVisible = null }) => {
  const before = await database.readPointer();
  let finished = null;
  const command = runIndexCommand({ args, environment }).then((outcome) => {
    finished = outcome;
    return outcome;
  });
  let lastUnchangedAt = Date.now();
  let visible = null;

  for (;;) {
    const commandDone = finished !== null;
    const pointer = await database.readPointer();
    const readAt = Date.now();
    if (pointer.generation !== before.generation) {
      visible = { ...pointer, observedAt: readAt, observedAtPerf: performance.now() };
      onVisible?.(visible);
      break;
    }
    lastUnchangedAt = readAt;
    if (commandDone) break;
    await sleep(POINTER_POLL_MS);
  }

  const outcome = await command;
  return { ...outcome, before, lastUnchangedAt, visible };
};

/**
 * When each instance followed a switch to `toTable`, from its search record
 * (createSearchTableTracker snapshots): the first dense search on `toTable`
 * after `afterEpochMs` (the last pointer read that did not show the switch),
 * and the last dense search on `fromTable`. Times are ms after the switch was
 * first seen (`visibleAt`), so a value can be a few ms below 0 when an
 * instance followed within one pointer poll.
 */
export const computeSwitchPropagation = ({ afterEpochMs, fromTable, snapshots = [], toTable, visibleAt }) =>
  snapshots.map((snapshot, instance) => {
    const firstOnNew = (snapshot?.transitions ?? []).find((entry) => entry.to === toTable && entry.at > afterEpochMs);
    const lastOnOld = snapshot?.tables?.[`dense:${fromTable}`]?.lastAt ?? null;
    const flips = (snapshot?.transitions ?? []).filter((entry) => entry.at > afterEpochMs).length;

    return {
      firstSearchOnNewMs: firstOnNew ? round(firstOnNew.at - visibleAt) : null,
      instance,
      lastSearchOnOldMs: Number.isFinite(lastOnOld) && lastOnOld > afterEpochMs ? round(lastOnOld - visibleAt) : null,
      tableChangesAfterSwitch: flips,
    };
  });

/** The slowest instance's first search on the new table: when every instance had followed. */
export const summarizePropagation = (perInstance = []) => {
  const values = perInstance.map((entry) => entry.firstSearchOnNewMs);
  return {
    allInstancesMs: values.length > 0 && values.every(Number.isFinite) ? Math.max(...values) : null,
    perInstance,
  };
};

/**
 * Splits the continuous load by phase: each request belongs to the phase it
 * was sent in. `phases` are { name, startedAt, endedAt, model } in
 * performance.now() time; `windows` are extra rows (the switchover windows).
 */
export const summarizeSwitchPhases = ({ instanceCount = 1, phases = [], results = [], windows = [] }) =>
  [...phases, ...windows].map((phase) => {
    const inPhase = results.filter(
      (result) => result && Number.isFinite(result.sentAt) && result.sentAt >= phase.startedAt && result.sentAt < phase.endedAt
    );
    const wallMs = Math.max(0, phase.endedAt - phase.startedAt);

    return {
      kind: phase.kind ?? "phase",
      name: phase.name,
      durationMs: round(wallMs),
      ...summarizeLevel({ results: inPhase, wallMs }),
      perInstance: summarizeByInstance(inPhase, instanceCount),
      ...(phase.model
        ? {
            model: {
              chatRequests: phase.model.chat.requests,
              embeddingRequests: phase.model.embeddings.requests,
              embeddingRequestsPerChat: inPhase.length > 0 ? round(phase.model.embeddings.requests / inPhase.length, 3) : null,
              embeddingsByCaller: phase.model.byCaller,
              embeddingsByModel: phase.model.embeddingsByModel,
            },
          }
        : {}),
    };
  });

const firstFailures = (results = [], phases = [], limit = 10) =>
  results
    .filter((result) => result && !isSuccess(result))
    .slice(0, limit)
    .map((result) => ({
      error: result.error ?? null,
      instance: result.instance ?? null,
      phase: phases.find((phase) => result.sentAt >= phase.startedAt && result.sentAt < phase.endedAt)?.name ?? null,
      status: result.status,
    }));

const runIndexSwitchScenario = async ({ apps, baseUrls, corpus, environmentFor, fakeModel, headers, options, runId }) => {
  const database = await openHarnessDatabase(options.databaseUrl);
  const cliEnvironment = environmentFor("cli", "cli");
  const newModel = switchEmbeddingModel(options.switchDimensions);
  const balancer = createInstanceBalancer({ count: baseUrls.length, mode: options.balance });
  const picker = createQuestionPicker({ instanceCount: baseUrls.length, questions: corpus.questions });
  const agent = new http.Agent({ keepAlive: true, maxSockets: options.switchConcurrency + 8 });
  const pointerTtlMs = options.indexPointerTtlMs ?? 2000;
  const phases = [];
  const mark = (name) => {
    const at = performance.now();
    const previous = phases.at(-1);
    if (previous && previous.endedAt === undefined) {
      previous.endedAt = at;
      previous.model = fakeModel.snapshot();
    }
    fakeModel.resetStats();
    if (name) phases.push({ name, startedAt: at });
    return at;
  };
  const baseSend = createChatSender({ agent, balancer, baseUrls, headers, options, picker, sessionTag: `load-${runId}-switch` });
  const send = async (args) => {
    const sentAt = performance.now();
    return { ...(await baseSend(args)), sentAt };
  };
  const initialPointer = await database.readPointer();
  const [initialVersion] = await database.readVersions();
  const fromTable = initialVersion?.chunkTable ?? "rag_document_chunks";
  let stop = false;
  let loadResult = null;
  const record = { build: null, activation: null, rollback: null };
  let versionsAfterBuild = [];
  let searchesAfterActivation = [];
  let searchesAtEnd = [];

  mark("before");
  const load = runClosedLoopUntil({ concurrency: options.switchConcurrency, send, shouldStop: () => stop });

  try {
    await sleep(options.switchPhaseMs);
    mark("build");
    console.log(`  building a version under ${newModel} (${options.switchDimensions} dimensions) while /chat runs...`);
    record.build = await runIndexCommand({
      args: [
        "build",
        "--model",
        newModel,
        "--dimensions",
        String(options.switchDimensions),
        ...(options.switchBuildBatchSize ? ["--batch-size", String(options.switchBuildBatchSize)] : []),
        // Only when asked: a tree whose CLI predates --concurrency still builds.
        ...(options.switchBuildConcurrency ? ["--concurrency", String(options.switchBuildConcurrency)] : []),
      ],
      environment: cliEnvironment,
    });
    if (record.build.exitCode !== 0 || !Number.isInteger(record.build.result?.versionId)) {
      throw new Error(`vector-index build failed (exit ${record.build.exitCode}): ${record.build.stderrTail.join(" | ")}`);
    }
    const versionId = record.build.result.versionId;
    versionsAfterBuild = await database.readVersions();
    const newTable = versionsAfterBuild.find((version) => version.versionId === versionId)?.chunkTable;

    mark("activating");
    console.log(`  activating version ${versionId}...`);
    // With the query cache on, the steady phase after the switch is measured
    // with the cache state "before" had: once every instance follows the
    // pointer, every question is asked once on every instance (discarded,
    // like the warm-up before the first level), so whatever the app caches
    // for the new version's space is warm.
    const warmNewSpace = options.embeddingCache !== false;
    record.activation = await runPointerSwitch({
      args: ["activate", String(versionId)],
      database,
      environment: cliEnvironment,
      onVisible: () => mark(warmNewSpace ? "new version, cache warming" : "new version active"),
    });
    if (record.activation.exitCode !== 0 || !record.activation.visible) {
      throw new Error(`vector-index activate failed (exit ${record.activation.exitCode}): ${record.activation.stderrTail.join(" | ")}`);
    }
    if (warmNewSpace) {
      await sleep(pointerTtlMs + SWITCHOVER_MARGIN_MS);
      console.log("  warming every instance's query cache under the new version...");
      const warmStartedAt = performance.now();
      record.newSpaceWarmup = {
        failures: await warmQueryCaches({
          baseUrls,
          concurrency: options.switchConcurrency,
          headers,
          options,
          questions: corpus.questions,
          sessionTag: `load-${runId}-switch-warm`,
        }),
      };
      record.newSpaceWarmup.durationMs = round(performance.now() - warmStartedAt);
      mark("new version active");
      await sleep(options.switchPhaseMs);
    } else {
      await sleep(Math.max(options.switchPhaseMs, pointerTtlMs + SWITCHOVER_MARGIN_MS));
    }
    searchesAfterActivation = await Promise.all(apps.map((app) => app.searchTables()));

    mark("rolling back");
    console.log("  rolling back...");
    record.rollback = await runPointerSwitch({
      args: ["rollback"],
      database,
      environment: cliEnvironment,
      onVisible: () => mark("rolled back"),
    });
    if (record.rollback.exitCode !== 0 || !record.rollback.visible) {
      throw new Error(`vector-index rollback failed (exit ${record.rollback.exitCode}): ${record.rollback.stderrTail.join(" | ")}`);
    }
    await sleep(Math.max(options.switchPhaseMs, pointerTtlMs + SWITCHOVER_MARGIN_MS));
    record.newTable = newTable;
    record.versionId = versionId;
  } finally {
    stop = true;
    loadResult = await load;
    mark(null);
    searchesAtEnd = await Promise.all(apps.map((app) => app.searchTables().catch(() => null)));
    agent.destroy();
  }

  const versionsAtEnd = await database.readVersions();
  const pointerAtEnd = await database.readPointer();
  await database.close();

  const results = loadResult?.results ?? [];
  const windows = [record.activation, record.rollback].map((entry, index) => ({
    endedAt: entry.visible.observedAtPerf + pointerTtlMs + SWITCHOVER_MARGIN_MS,
    kind: "window",
    name: `${index === 0 ? "activation" : "rollback"} switchover (first ${pointerTtlMs + SWITCHOVER_MARGIN_MS} ms)`,
    startedAt: entry.visible.observedAtPerf,
  }));
  const built = versionsAfterBuild.find((version) => version.versionId === record.versionId) ?? {};
  const buildMs = built.buildCompletedAt && built.buildStartedAt ? built.buildCompletedAt - built.buildStartedAt : null;
  const indexed = record.build.result?.indexed ?? null;
  const buildPhase = phases.find((phase) => phase.name === "build");
  const firstEmbeddingAt = fakeModel.firstEmbeddingAt();
  const newSpaceQueryEmbedding = (visibleAt) =>
    apps.map((_, instance) => {
      const at = firstEmbeddingAt[`load-test-api-${instance}|${newModel}`];
      return Number.isFinite(at) ? round(at - visibleAt) : null;
    });
  const describeSwitch = (entry, { fromTable: from, toTable: to, snapshots }) => ({
    commandWallMs: round(entry.endedAt - entry.startedAt),
    exitCode: entry.exitCode,
    fromVersionId: entry.before.activeVersionId,
    generation: entry.visible.generation,
    pointerPollResolutionMs: round(entry.visible.observedAt - entry.lastUnchangedAt),
    propagation: summarizePropagation(
      computeSwitchPropagation({ afterEpochMs: entry.lastUnchangedAt, fromTable: from, snapshots, toTable: to, visibleAt: entry.visible.observedAt })
    ),
    toVersionId: entry.visible.activeVersionId,
    validation: entry.result?.validation
      ? {
          mismatchedDocuments: entry.result.validation.mismatchedDocuments ?? null,
          ok: entry.result.validation.ok,
          reasons: entry.result.validation.reasons ?? [],
          totals: entry.result.validation.totals ?? null,
        }
      : null,
    // Validation gate plus the switch, until the new pointer was seen.
    visibleAfterCommandStartMs: round(entry.visible.observedAtPerf - entry.startedAt),
  });

  return {
    build: {
      chunkCount: built.chunkCount ?? null,
      // Documents in flight in the builder: --switch-build-concurrency, or the CLI's default.
      concurrency: options.switchBuildConcurrency ?? null,
      cliWallMs: round(record.build.endedAt - record.build.startedAt),
      docsPerSecond: Number.isFinite(buildMs) && buildMs > 0 && Number.isFinite(indexed) ? round(indexed / (buildMs / 1000), 2) : null,
      docsPerSecondIncludingCli:
        Number.isFinite(indexed) ? round(indexed / ((record.build.endedAt - record.build.startedAt) / 1000), 2) : null,
      embeddingRequests: buildPhase?.model?.byCaller?.["load-test-cli"]?.embeddings ?? null,
      embeddingInputs: buildPhase?.model?.byCaller?.["load-test-cli"]?.embeddingInputs ?? null,
      failed: record.build.result?.failed ?? null,
      indexed,
      model: newModel,
      dimensions: options.switchDimensions,
      registryBuildMs: Number.isFinite(buildMs) ? round(buildMs) : null,
      skippedDeleted: record.build.result?.skippedDeleted ?? null,
      versionId: record.versionId,
    },
    activation: {
      ...describeSwitch(record.activation, { fromTable, snapshots: searchesAfterActivation, toTable: record.newTable }),
      firstNewSpaceQueryEmbeddingMs: newSpaceQueryEmbedding(record.activation.visible.observedAt),
      newSpaceWarmup: record.newSpaceWarmup ?? null,
    },
    rollback: describeSwitch(record.rollback, { fromTable: record.newTable, snapshots: searchesAtEnd, toTable: fromTable }),
    chatConcurrency: options.switchConcurrency,
    embeddingDimensions: options.embeddingDimensions,
    endpoint: "POST /chat during build, activate and rollback",
    errors: firstFailures(results, phases),
    initialPointer,
    kind: "index-switch",
    phases: summarizeSwitchPhases({ instanceCount: baseUrls.length, phases, results, windows }),
    pointerAtEnd,
    pointerTtlMs,
    requests: results.length,
    searchesAtEnd: searchesAtEnd.map((snapshot) => snapshot?.tables ?? null),
    totalErrors: results.filter((result) => result && !isSuccess(result)).length,
    versions: versionsAtEnd,
  };
};

// ---------------------------------------------------------------------------
// Crash injection (--scenario ingest --crash-worker-mid-embed)
//
// Dedicated worker 0's first embeddings request of the measured window is
// held unanswered by the fake model and the process is killed (SIGKILL) while
// it waits: mid-embed, with nothing flushed. Its jobs stay `running` under a
// lease nobody renews; once it expires another worker claims them. A poller
// on a connection of the harness's own records every change of every job of
// the window (status, stage, attempt, claimant, whether the upload bytes are
// still on the row, and when each stage output was written), so the report
// can say, per job, which stage the next attempt started at and whether an
// earlier stage ran again.

const JOB_POLL_MS = 25;

const readJobStates = (database, sinceEpochMs) =>
  database.query(
    `SELECT j.job_id, j.file_name, j.status, j.stage, j.attempt_count, j.stage_attempts, j.claimed_by,
            (j.file_bytes IS NOT NULL) AS holds_upload,
            (SELECT json_object_agg(o.output, (EXTRACT(EPOCH FROM o.created_at) * 1000)::float8)
               FROM ${ingestJobsTable()}_outputs o WHERE o.job_id = j.job_id) AS outputs
     FROM ${ingestJobsTable()} j
     WHERE j.created_at >= to_timestamp($1::float8 / 1000.0)`,
    [sinceEpochMs]
  );

const jobStateKey = (state) =>
  JSON.stringify([state.status, state.stage, state.attemptCount, state.stageAttempts, state.claimedBy, state.holdsUpload, state.outputs]);

/**
 * Per job of a crash run: `history` is the job's observed states in order,
 * `victimWorkerId` the killed worker's id, `killedAt` when the kill was
 * issued. A job the victim held when it died is `resumed` once another
 * worker's claim of a later attempt is seen; the report says the stage it
 * died in, the stage the next attempt started at, whether any earlier stage
 * was observed again (re-run), and whether the earlier stages' outputs kept
 * their write time.
 */
export const analyzeCrashedJobs = ({ histories = {}, killedAt, victimWorkerId }) => {
  const stageOrder = ["parse", "chunk", "embed", "index"];
  const jobs = [];

  for (const [jobId, history] of Object.entries(histories)) {
    const victimStates = history.filter((state) => state.claimedBy === victimWorkerId && state.at <= killedAt);
    if (victimStates.length === 0) continue;
    const lastVictim = victimStates.at(-1);
    const final = history.at(-1);

    if (lastVictim.status !== "running") {
      jobs.push({ fileName: lastVictim.fileName, finalStatus: final.status, jobId, outcome: "finished_before_kill" });
      continue;
    }

    const resumedIndex = history.findIndex(
      (state) => state.claimedBy && state.claimedBy !== victimWorkerId && state.attemptCount > lastVictim.attemptCount
    );
    const resumed = resumedIndex >= 0 ? history[resumedIndex] : null;
    const after = resumed ? history.slice(resumedIndex) : [];
    const stagesAfter = [...new Set(after.map((state) => state.stage))];
    const earlierStages = stageOrder.slice(0, stageOrder.indexOf(lastVictim.stage));
    const outputsBefore = lastVictim.outputs ?? {};
    const rewritten = Object.keys(outputsBefore).filter((name) =>
      after.some((state) => state.outputs?.[name] !== undefined && state.outputs[name] !== outputsBefore[name])
    );

    const finishedState = after.find((state) => state.status === "succeeded" || state.status === "failed" || state.status === "dead_letter");

    jobs.push({
      earlierStagesRerun: stagesAfter.filter((stage) => earlierStages.includes(stage)),
      fileName: lastVictim.fileName,
      finalStatus: final.status,
      // First observed finish after the resume, from the kill (the poller's resolution).
      finishedAfterKillMs: finishedState ? round(finishedState.at - killedAt) : null,
      jobId,
      leaseWaitMs: resumed ? round(resumed.at - killedAt) : null,
      outcome: resumed ? "resumed" : "not_resumed",
      outputsAtKill: Object.keys(outputsBefore).sort(),
      outputsRewrittenAfterResume: rewritten,
      resumedAttempt: resumed?.attemptCount ?? null,
      resumedAtStage: resumed?.stage ?? null,
      resumedBy: resumed?.claimedBy ?? null,
      stageAtKill: lastVictim.stage,
      uploadBytesOnRowAtResume: resumed ? resumed.holdsUpload : null,
    });
  }

  const resumed = jobs.filter((job) => job.outcome === "resumed");
  const finishedAfterKill = resumed.map((job) => job.finishedAfterKillMs).filter(Number.isFinite);

  return {
    jobs,
    lastResumedFinishedAfterKillMs: finishedAfterKill.length > 0 ? Math.max(...finishedAfterKill) : null,
    resumed: resumed.length,
    resumedAtStageOfCrash: resumed.filter((job) => job.resumedAtStage === job.stageAtKill).length,
    resumedWithoutEarlierStage: resumed.filter((job) => job.earlierStagesRerun.length === 0 && job.outputsRewrittenAfterResume.length === 0).length,
    strandedAtKill: jobs.filter((job) => job.outcome !== "finished_before_kill").length,
  };
};

const createCrashInjection = async ({ databaseUrl, fakeModel, victim, victimCaller, victimWorkerId }) => {
  const database = await openHarnessDatabase(databaseUrl);
  const histories = {};
  let poller = null;
  let polling = Promise.resolve();
  let since = null;
  let held = null;
  let killedAt = null;
  let killCompletedAt = null;
  let killing = Promise.resolve();

  const poll = async () => {
    const result = await readJobStates(database, since);
    const at = Date.now();
    for (const row of result.rows) {
      const state = {
        at,
        attemptCount: row.attempt_count,
        claimedBy: row.claimed_by ?? null,
        fileName: row.file_name,
        holdsUpload: row.holds_upload === true,
        outputs: row.outputs ?? {},
        stage: row.stage,
        stageAttempts: row.stage_attempts,
        status: row.status,
      };
      const history = (histories[row.job_id] ??= []);
      if (history.length === 0 || jobStateKey(history.at(-1)) !== jobStateKey(state)) history.push(state);
    }
  };

  return {
    arm: () => {
      since = Date.now() - 1000;
      poller = setInterval(() => {
        polling = polling.then(poll).catch((error) => console.warn(`[crash] job poll failed: ${error?.message ?? error}`));
      }, JOB_POLL_MS);
      killing = fakeModel.holdNextEmbedding({ caller: victimCaller }).then(async (request) => {
        held = request;
        killedAt = Date.now();
        // One last look at the jobs as the victim left them.
        await polling.catch(() => {});
        await victim.kill();
        killCompletedAt = Date.now();
        console.log(
          `  crash: killed worker 0 (${victimWorkerId}) with an embeddings request of ${request.inputs} text(s) from ${request.documents.length} document(s) in flight`
        );
      });
    },
    finish: async () => {
      clearInterval(poller);
      await polling.catch(() => {});
      await poll().catch(() => {});
      await database.close();
      if (!killedAt) return { killed: false };
      await killing;

      return {
        heldRequest: held,
        killed: true,
        killedAt,
        killTookMs: round(killCompletedAt - killedAt),
        victimWorkerId,
        ...analyzeCrashedJobs({ histories, killedAt, victimWorkerId }),
      };
    },
    get killed() {
      return killedAt !== null;
    },
  };
};

/** Document embeddings from the dedicated workers' own requests (their API keys), per searchable document. */
export const describeWorkerEmbeddings = ({ byCaller = {}, documents = 0, prefix = "load-test-worker-" } = {}) => {
  const entries = Object.entries(byCaller).filter(([caller]) => caller.startsWith(prefix));
  if (entries.length === 0) return null;
  const requests = entries.reduce((total, [, entry]) => total + (entry.embeddings ?? 0), 0);
  const inputs = entries.reduce((total, [, entry]) => total + (entry.embeddingInputs ?? 0), 0);

  return {
    inputs,
    inputsPerRequest: requests > 0 ? round(inputs / requests, 2) : null,
    perWorker: Object.fromEntries(entries.map(([caller, entry]) => [caller, { inputs: entry.embeddingInputs, requests: entry.embeddings }])),
    requests,
    requestsPerDocument: documents > 0 ? round(requests / documents, 3) : null,
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

  const embeddingLevels = scenario.levels.filter((level) => level.documentEmbeddings);
  if (embeddingLevels.length > 0) {
    lines.push(
      "",
      "Document embeddings (the dedicated workers' own requests, by their API keys: no chat or probe query embeddings):",
      "",
      "| Upload concurrency | Embedding requests | Inputs | Requests per document | Inputs per request | Per worker (requests/inputs) |",
      "| ---: | ---: | ---: | ---: | ---: | --- |"
    );
    for (const level of embeddingLevels) {
      const embeddings = level.documentEmbeddings;
      lines.push(
        `| ${levelKey(level)} | ${cell(embeddings.requests)} | ${cell(embeddings.inputs)} | ${cell(embeddings.requestsPerDocument)} | ${cell(embeddings.inputsPerRequest)} | ${Object.entries(embeddings.perWorker)
          .map(([caller, entry]) => `${caller.replace(/^load-test-/, "")} ${entry.requests}/${entry.inputs}`)
          .join(", ")} |`
      );
    }
  }

  for (const level of scenario.levels.filter((entry) => entry.crash)) {
    formatCrashReport(lines, level, levelKey(level));
  }
};

export const formatCrashReport = (lines, level, key) => {
  const crash = level.crash;
  lines.push("", `Crash injection (upload concurrency ${key}):`, "");
  if (!crash.killed) {
    lines.push("Worker 0 sent no embeddings request during the window, so nothing was killed.");
    return;
  }
  lines.push(
    `Worker 0 (${crash.victimWorkerId}) was killed with SIGKILL while its embeddings request of ${crash.heldRequest.inputs} text(s) from ${crash.heldRequest.documents.length} document(s) (${crash.heldRequest.documents.join(", ")}) was in flight (the fake never answered it); the kill took ${cell(crash.killTookMs)} ms. ${crash.strandedAtKill} job(s) were running under it; ${crash.resumed} were resumed by another worker, ${crash.resumedAtStageOfCrash} at the stage they died in, ${crash.resumedWithoutEarlierStage} without any earlier stage running again or rewriting its output; the last of them finished ${cell(crash.lastResumedFinishedAfterKillMs)} ms after the kill.`,
    "",
    "| Job file | Stage at kill | Outputs at kill | Resumed at stage | Attempt | Upload bytes still on the row | Earlier stage re-run | Outputs rewritten | Lease wait ms | Finished ms after the kill | Final status |",
    "| --- | --- | --- | --- | ---: | --- | --- | --- | ---: | ---: | --- |"
  );
  for (const job of crash.jobs.filter((entry) => entry.outcome !== "finished_before_kill")) {
    lines.push(
      `| ${job.fileName} | ${job.stageAtKill} | ${job.outputsAtKill.join(", ") || "-"} | ${cell(job.resumedAtStage)} | ${cell(job.resumedAttempt)} | ${job.uploadBytesOnRowAtResume === null ? "-" : job.uploadBytesOnRowAtResume ? "yes" : "no"} | ${job.earlierStagesRerun?.join(", ") || "none"} | ${job.outputsRewrittenAfterResume?.join(", ") || "none"} | ${cell(job.leaseWaitMs)} | ${cell(job.finishedAfterKillMs)} | ${job.finalStatus} |`
    );
  }
};

const formatIndexSwitchScenario = (lines, scenario) => {
  const build = scenario.build;
  const describePropagation = (label, entry) => {
    const perInstance = entry.propagation.perInstance
      .map(
        (instance) =>
          `instance ${instance.instance}: first search on version ${entry.toVersionId} ${cell(instance.firstSearchOnNewMs)} ms, last on version ${entry.fromVersionId} ${cell(instance.lastSearchOnOldMs)} ms, ${instance.tableChangesAfterSwitch} table change(s)`
      )
      .join("; ");
    return `${label}: version ${entry.fromVersionId} -> ${entry.toVersionId} (generation ${entry.generation}); the command took ${entry.commandWallMs} ms and the new pointer was visible ${entry.visibleAfterCommandStartMs} ms after it started (pointer read every ${POINTER_POLL_MS} ms; the commit was at most ${entry.pointerPollResolutionMs} ms before it was seen). Every instance searched version ${entry.toVersionId} ${cell(entry.propagation.allInstancesMs)} ms after the switch was seen (${perInstance}).${
      entry.validation ? ` Validation gate: ${entry.validation.ok ? "passed" : "FAILED"}${entry.validation.totals ? ` (${entry.validation.totals.documents} documents, ${entry.validation.totals.activeChunks} chunks in the active version, ${entry.validation.totals.targetChunks} in the target)` : ""}.` : ""
    }`;
  };

  lines.push(
    `Build of version ${build.versionId} (${build.model}, ${build.dimensions} dimensions${
      build.concurrency ? `, ${build.concurrency} document(s) in flight` : ""
    }) under /chat load: ${cell(build.indexed)} documents indexed, ${cell(build.failed)} failed, ${cell(build.chunkCount)} chunks; ${cell(build.registryBuildMs)} ms by the registry's build timestamps (${cell(build.docsPerSecond)} documents/s), ${cell(build.cliWallMs)} ms for the whole command including its start-up (${cell(build.docsPerSecondIncludingCli)} documents/s); ${cell(build.embeddingRequests)} embeddings requests (${cell(build.embeddingInputs)} inputs) from the builder.`,
    "",
    `${describePropagation("Activation", scenario.activation)} First query embedding in the new space per instance: ${scenario.activation.firstNewSpaceQueryEmbeddingMs.map((value, index) => `instance ${index} ${cell(value)} ms`).join(", ")} after the switch was seen.${
      scenario.activation.newSpaceWarmup
        ? ` Cache warm-up under the new version (every question once per instance, discarded): ${cell(scenario.activation.newSpaceWarmup.durationMs)} ms, ${scenario.activation.newSpaceWarmup.failures} non-2xx.`
        : ""
    }`,
    "",
    describePropagation("Rollback", scenario.rollback),
    "",
    `Pointer TTL ${scenario.pointerTtlMs} ms. /chat requests: ${scenario.requests}, errors: ${scenario.totalErrors}.`,
    "",
    `| Phase | Duration ms | Requests | Errors | Req/s | ${LATENCY_HEADER} | Grounded answers | Embedding requests (per /chat) | Embeddings by model |`,
    `| --- | ---: | ---: | ---: | ---: | ${LATENCY_RULE} | ---: | ---: | --- |`
  );
  for (const phase of scenario.phases) {
    lines.push(
      `| ${phase.kind === "window" ? `_${phase.name}_` : phase.name} | ${cell(phase.durationMs)} | ${phase.requests} | ${phase.errors} | ${cell(phase.throughputRps)} | ${latencyCells(phase.latencyMs)} | ${cell(phase.groundedAnswers)} | ${
        phase.model ? `${phase.model.embeddingRequests} (${cell(phase.model.embeddingRequestsPerChat)})` : "-"
      } | ${
        phase.model
          ? Object.entries(phase.model.embeddingsByModel)
              .map(([model, entry]) => `${model} ${entry.requests}`)
              .join(", ") || "-"
          : "-"
      } |`
    );
  }
  lines.push(
    "",
    "Per instance and phase:",
    "",
    `| Phase | Instance | Requests | Errors | ${LATENCY_HEADER} |`,
    `| --- | ---: | ---: | ---: | ${LATENCY_RULE} |`
  );
  for (const phase of scenario.phases.filter((entry) => entry.kind !== "window")) {
    phase.perInstance.forEach((instance, index) => {
      lines.push(`| ${phase.name} | ${index} | ${instance.requests} | ${instance.errors} | ${latencyCells(instance.latencyMs)} |`);
    });
  }
  if (scenario.errors.length > 0) {
    lines.push("", "First errors:");
    for (const error of scenario.errors) {
      lines.push(`- ${error.phase ?? "?"}, instance ${cell(error.instance)}: ${error.error ?? `HTTP ${error.status}`}`);
    }
  }
  lines.push(
    "",
    `Versions at the end: ${scenario.versions
      .map((version) => `${version.versionId} ${version.status} (${version.chunkTable}, ${version.embeddingModel || "configured model"}/${version.embeddingDimensions}, ${cell(version.chunkCount)} chunks${version.inDualWriteWindow ? ", still dual-written" : ""})`)
      .join("; ")}. Active: ${scenario.pointerAtEnd.activeVersionId}.`
  );
};

/** A level's row key: its concurrency, and its run with --repeat ("16 #2"). */
export const levelLabel = (level) => (Number.isInteger(level?.repeat) ? `${level.concurrency} #${level.repeat}` : String(level?.concurrency));

const formatRange = (range, digits = null) => {
  if (!range) return "-";
  const show = (value) => (digits === null ? String(value) : String(round(value, digits)));
  return range.min === range.max ? show(range.min) : `${show(range.min)} - ${show(range.max)}`;
};

/**
 * Split topology: per level, each tier's CPU per request, cores busy (the
 * tier's and its busiest process's), share of the app processes' CPU, queries
 * and event-loop delay, then the busiest tier per level and the model calls
 * that did not come through a gateway.
 */
export const formatTierRows = (lines, levels = []) => {
  const withTiers = levels.filter((level) => level.tiers && Object.keys(level.tiers).length > 0);
  if (withTiers.length === 0) return;

  lines.push(
    "",
    "Per tier (every process of the tier summed; busiest process = the replica with the most cores busy, the saturation signal: a Node process runs its JavaScript on one thread):",
    "",
    "| Concurrency | Tier | Processes | CPU ms/req | CPU ms/req net of idle | Cores busy | Busiest process cores | Share of app CPU | DB queries/req | Event-loop p99 ms | RSS MB |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const level of withTiers) {
    for (const [tier, entry] of Object.entries(level.tiers)) {
      lines.push(
        `| ${levelLabel(level)} | ${tier} | ${cell(entry.processes)}${entry.reporting !== entry.processes ? ` (${cell(entry.reporting)} reported)` : ""} | ${cell(entry.cpuMsPerRequest)} | ${cell(entry.cpuMsPerRequestNetOfIdle)} | ${cell(entry.coresBusy)} | ${cell(entry.maxProcessCoresBusy)} | ${cell(entry.shareOfCpu)} | ${cell(entry.dbQueriesPerRequest)} | ${cell(entry.eventLoopDelayP99Ms)} | ${cell(entry.rssMb)} |`
      );
    }
  }
  lines.push(
    "",
    `Busiest tier per level: ${withTiers
      .map((level) => `c=${levelLabel(level)} ${level.busiestTier ? `${level.busiestTier.tier} (${cell(level.busiestTier.maxProcessCoresBusy)} cores)` : "-"}`)
      .join("; ")}.`
  );
  const direct = withTiers.filter((level) => Number.isFinite(level.model?.directCalls));
  if (direct.length > 0) {
    const bypassed = direct.filter((level) => level.model.directCalls > 0);
    lines.push(
      bypassed.length === 0
        ? "Model calls from any process but a gateway: 0 at every level (every tier reached the model through the gateway)."
        : `Model calls from a process other than a gateway: ${bypassed.map((level) => `c=${levelLabel(level)} ${level.model.directCalls}`).join("; ")} (see model.byCaller in the JSON report).`
    );
  }
};

/** --repeat: the range (min - max) of each level's numbers over its runs. */
export const formatRepeatRanges = (lines, repeats = []) => {
  if (!Array.isArray(repeats) || repeats.length === 0) return;
  const tierNames = [...new Set(repeats.flatMap((row) => Object.keys(row.tiers ?? {})))];
  const showTiers = tierNames.length > 1;

  lines.push(
    "",
    "Range over the repeats of each level (min - max; one value when they agree):",
    "",
    `| Concurrency | Runs | Errors | Req/s | Mean ms | p50 ms | p95 ms | p99 ms | CPU ms/req |${showTiers ? `${tierNames.map((tier) => ` ${tier} CPU ms/req |`).join("")} Busiest tier (runs) |` : ""}`,
    `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |${showTiers ? `${tierNames.map(() => " ---: |").join("")} --- |` : ""}`
  );
  for (const row of repeats) {
    const tierCells = showTiers
      ? `${tierNames.map((tier) => ` ${formatRange(row.tiers?.[tier]?.cpuMsPerRequest)} |`).join("")} ${
          Object.entries(row.busiestTiers ?? {})
            .map(([tier, count]) => `${tier} ${count}`)
            .join(", ") || "-"
        } |`
      : "";
    lines.push(
      `| ${row.concurrency} | ${row.runs} | ${row.errors} | ${formatRange(row.throughputRps)} | ${formatRange(row.latencyMeanMs)} | ${formatRange(row.latencyP50Ms)} | ${formatRange(row.latencyP95Ms)} | ${formatRange(row.latencyP99Ms)} | ${formatRange(row.cpuMsPerRequest)} |${tierCells}`
    );
  }
};

const formatRequestScenario = (lines, scenario, multiInstance, balance, { split = false } = {}) => {
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
      `| ${levelLabel(level)} | ${level.requests} | ${level.errors} | ${cell(level.throughputRps)} | ${latencyCells(level.latencyMs)} |${chatCells} ${cell(level.server?.cpuMsPerRequest)} | ${cell(level.server?.cpuMsPerRequestNetOfIdle)} | ${cell(level.server?.coresBusy)} | ${cell(level.server?.dbQueriesPerRequest)} | ${cell(level.server?.eventLoopDelayP99Ms)} |${chat ? ` ${modes || "-"} |` : ""}`
    );
  }

  formatRepeatRanges(lines, scenario.repeats);
  if (split) formatTierRows(lines, scenario.levels);

  formatHostRows(
    lines,
    scenario.levels.map((level) => ({ host: level.host, key: levelLabel(level) })),
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
        `| ${levelLabel(level)} | ${cell(limiter.acquireCalls)} | ${cell(limiter.acquireCallsPerSecond)} | ${cell(limiter.slotsAcquired)} | ${cell(limiter.acquireCallsPerSlot)} |`
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
          `| ${levelLabel(level)} | ${instance.index} | ${cell(instance.requests)} | ${cell(instance.errors)} | ${latencyCells(instance.latencyMs)} | ${cell(instance.cpuMsPerRequest)} | ${cell(instance.cpuMsPerRequestNetOfIdle)} | ${cell(instance.coresBusy)} | ${cell(instance.dbQueries)} |`
        );
      }
    }
  }

  const errorLevels = scenario.levels.filter((level) => level.errors > 0);
  if (errorLevels.length > 0) {
    lines.push("", "Errors:");
    for (const level of errorLevels) {
      lines.push(`- c=${levelLabel(level)}: ${formatErrorCounts(level.errorCounts)}`);
    }
  }
};

const formatIdle = (run) => {
  if (!Array.isArray(run.idle) || run.idle.length === 0) return null;
  const labels =
    run.topology?.topology === "split" && Array.isArray(run.topology.processes)
      ? run.topology.processes.map((entry) => `${entry.tier} #${entry.index}`)
      : [
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

/**
 * How the report names the run's topology; a report written before
 * --topology existed is a monolith.
 */
export const formatTopologyConfig = (config = {}) => {
  const replicas = config.tierReplicas ?? {};
  const total = config.totalProcesses ?? Object.values(replicas).reduce((sum, count) => sum + count, 0);

  if (config.topology === "split") {
    return `split, ${total} processes: ${TIER_REPORT_ORDER.map((tier) => `${tier} x${replicas[tier] ?? 1}`).join(", ")} (each tier its own process through the role start-up, ARCHIVE_RAG_ROLE per process; wired by replica lists and one internal key generated for the run; the fake model behind the gateway)`;
  }

  const instances = replicas[MONOLITH_TIER] ?? config.instances ?? 1;
  const workers = replicas["ingest-worker"] ?? 0;
  return `monolith: ${instances} process(es) of role all${workers > 0 ? ` and ${workers} dedicated ingest worker(s)` : ""}`;
};

/** A run's whole-life CPU per tier, one line; null without totals. */
export const formatLifetimeCpu = (topology) => {
  const byTier = topology?.lifetime?.byTier;
  if (!byTier || Object.keys(byTier).length === 0) return null;

  return `Whole-run CPU per tier (start-up, seed ingest, warm-up and every level; read from each process before it stopped): ${Object.entries(
    byTier
  )
    .map(
      ([tier, entry]) =>
        `${tier} ${cell(entry.cpuMs)} ms over ${entry.processes} process(es)${entry.reporting !== entry.processes ? ` (${entry.reporting} reported)` : ""}${Number.isFinite(entry.shareOfCpu) ? `, ${round(entry.shareOfCpu * 100)}%` : ""}`
    )
    .join("; ")}.`;
};

/** Markdown report: config, then the tables of every storage mode and scenario. */
export const formatLoadTestMarkdown = (report) => {
  const { config } = report;
  const scenarioKind = config.scenario ?? "chat";
  const instanceCount = config.instances ?? 1;
  const multiInstance = instanceCount > 1;
  const split = config.topology === "split";
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
    `| Topology | ${formatTopologyConfig(config)} |`,
    split
      ? `| App instances | ${instanceCount} api replica(s)${multiInstance ? ` (client-side ${config.balance ?? "round-robin"} balancing over the edge)` : ""}; agent, retrieval and gateway replicas are picked by each tier's service client; one database |`
      : `| App instances | ${instanceCount}${multiInstance ? ` (client-side ${config.balance ?? "round-robin"} balancing, one database)` : ""} |`,
    split
      ? `| Shared state (model call guard) | ${config.sharedState ?? "memory"}${config.sharedState === "redis" ? " (RAG_LLM_MAX_CONCURRENCY is one cap for all gateway processes)" : " (RAG_LLM_MAX_CONCURRENCY applies per gateway process; callers of the gateway run no guard)"} |`
      : `| Shared state (model call guard) | ${config.sharedState ?? "memory"}${config.sharedState === "redis" ? " (RAG_LLM_MAX_CONCURRENCY is one cap for all instances)" : multiInstance ? " (RAG_LLM_MAX_CONCURRENCY applies per instance)" : ""} |`,
    `| Model latency profiles (chat completion) | ${config.modelLatencyMs.map((ms) => `${ms} ms`).join(", ")} |`,
    `| Embedding latency | ${config.embeddingLatencyMs} ms per request${config.embeddingLatencyPerInputMs ? ` + ${config.embeddingLatencyPerInputMs} ms per input` : ""} |`,
    `| RAG_LLM_MAX_CONCURRENCY | ${config.llmMaxConcurrency} |`,
  ];

  if (scenarioKind === "index-switch") {
    lines.push(
      `| /chat load | closed loop, concurrency ${cell(config.switchConcurrency)}, for the whole run; seed corpus ${config.documents} documents x ${config.pages} pages (uploaded as PDFs), ${config.questions} questions |`,
      `| Index versions | seed version at ${config.embeddingDimensions} dimensions; new version ${switchEmbeddingModel(config.switchDimensions)} at ${config.switchDimensions} dimensions${
        config.switchBuildBatchSize ? `, build batches of ${config.switchBuildBatchSize}` : ""
      }${config.switchBuildConcurrency ? `, ${config.switchBuildConcurrency} build document(s) in flight` : ""} |`,
      `| Steady phases | ${config.switchPhaseMs} ms before the build, after the activation and after the rollback |`,
      `| RAG_INDEX_VERSION_POINTER_TTL_MS | ${config.indexPointerTtlMs ?? "app default (2000)"} |`
    );
  } else if (scenarioKind === "ingest") {
    const workerSettings = [
      Number.isInteger(config.ingestWorkerConcurrency) ? `RAG_INGEST_WORKER_CONCURRENCY=${config.ingestWorkerConcurrency}` : null,
      Number.isInteger(config.ingestWorkerPollMs) ? `RAG_INGEST_WORKER_POLL_MS=${config.ingestWorkerPollMs}` : null,
      Number.isInteger(config.ingestMaxPendingJobs)
        ? `RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT=${config.ingestMaxPendingJobs}`
        : null,
      config.embedBatching ? `RAG_INGEST_EMBED_BATCHING=${config.embedBatching === "on" ? "true" : "false"}` : null,
      Number.isInteger(config.embedBatchLingerMs) ? `RAG_INGEST_EMBED_BATCH_LINGER_MS=${config.embedBatchLingerMs}` : null,
      Number.isInteger(config.ingestJobLeaseMs) ? `RAG_INGEST_JOB_LEASE_MS=${config.ingestJobLeaseMs}` : null,
      config.crashWorkerMidEmbed ? "crash injection: worker 0 killed mid-embed" : null,
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
      `| Corpus | ${config.documents} documents x ${config.pages} pages, ${config.questions} questions |`,
      ...((config.repeat ?? 1) > 1 ? [`| Runs per level | ${config.repeat}, in a row on the same processes |`] : [])
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
          `| Read replica | ${config.readReplica ? "one streaming replica; tenant searches may run there (POSTGRES_READ_REPLICA_URLS)" : "none"} |`,
        ]
      : []),
    `| Embedding dimensions / query embedding cache | ${config.embeddingDimensions} / ${
      config.embeddingCache
        ? `on, warmed on every ${split ? "retrieval replica (the tier that embeds queries)" : "instance"} before the first measured level${
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
    if (run.topology?.topology === "split" && Array.isArray(run.topology.processes)) {
      lines.push(
        `Processes: ${TIER_REPORT_ORDER.map((tier) => {
          const ports = run.topology.processes.filter((entry) => entry.tier === tier).map((entry) => entry.port);
          return `${tier} on port${ports.length > 1 ? "s" : ""} ${ports.join(", ")}`;
        }).join("; ")}.`
      );
      if (run.topology.warmUp) {
        lines.push(
          `Query cache warm-up: ${run.topology.warmUp.passes} pass(es) over the question pool (at most ${cell(run.topology.warmUp.maxPasses)}); the last sent ${cell(run.topology.warmUp.lastPassEmbeddingRequests)} embeddings request(s).`
        );
      }
    } else if (Array.isArray(run.instances) && (run.instances.length > 1 || run.ingestWorkers > 0)) {
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
    const lifetime = formatLifetimeCpu(run.topology);
    if (lifetime) lines.push(lifetime);
    lines.push(...formatReadReplica(run.readReplica));
    lines.push("");

    for (const scenario of run.scenarios) {
      const heading =
        scenario.kind === "index-switch"
          ? `### ${scenario.endpoint}, chat model latency ${scenario.modelLatencyMs} ms, embedding latency ${scenario.embeddingLatencyMs} ms`
          : scenario.kind === "ingest"
          ? `### ${scenario.endpoint} (${scenario.ingestMode} ingest), chat model latency ${scenario.modelLatencyMs} ms, embedding latency ${scenario.embeddingLatencyMs} ms`
          : scenario.kind === "chat"
            ? `### ${scenario.endpoint}, model latency ${scenario.modelLatencyMs} ms`
            : `### ${scenario.endpoint}`;
      lines.push(heading, "");

      if (scenario.kind === "ingest") formatIngestScenario(lines, scenario, multiInstance);
      else if (scenario.kind === "index-switch") formatIndexSwitchScenario(lines, scenario);
      else formatRequestScenario(lines, scenario, multiInstance, config.balance, { split });
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

export const INDEX_SWITCH_NOTES = Object.freeze([
  "Index switch scenario: the seed corpus is uploaded as PDFs so the registry holds bytes a build can parse again. A closed-loop /chat load runs for the whole run; each request belongs to the phase it was sent in. The lifecycle commands are separate processes (node vector-index.mjs build / activate / rollback --json) on the same database and fake model: build creates version 2 under load-test-embedding-<width> (the fake answers that model at that width) and re-embeds every document from its stored PDF; activate runs the activation gate (per-document chunk counts) and switches the pointer; rollback switches back to version 1 while version 2 is inside its dual-write grace period.",
  "Switch visibility: the harness reads the pointer row on its own connection every few ms while activate/rollback runs; the first read with a new generation is when the switch is taken as committed (the commit happened after the previous read). Propagation per instance: every app process records which chunk table each of its dense retrieval statements read (each version is its own table), so the first dense search on the new table after the switch is when that instance started serving the new version, measured inside the process; its last search on the old table is when it stopped. A request that read the pointer just before the switch may still search the old table afterwards; that version keeps receiving writes for its grace period, so such a search is still complete.",
  "Query embeddings after the switch: the instances keep their configured embedding model (the configuration is not changed), so the new version is pinned to another model than the one they are configured for; the embeddings columns show each phase's query embedding calls per model. With the query cache on, the harness sizes RAG_EMBEDDING_CACHE_MAX to hold every retrieval query of the question pool (config table; the app default is 256) and, once every instance follows the new pointer, asks every question once on every instance (phase 'new version, cache warming', discarded like the warm-up before the first level). 'new version active' then serves from a cache holding the whole pool, like 'before': it shows what a cache that size saves, not how many embeddings a query costs. With --no-embedding-cache there is no warm-up, and each phase's embeddings per /chat, per model, are what every query pays.",
  "The fake embedding model answers each request after a flat latency (plus --embedding-latency-per-input-ms per input), in parallel and without a rate limit, and each process -- the build CLI included -- has its own RAG_LLM_MAX_CONCURRENCY guard unless --shared-state redis (keyed by model, so the build's model and /chat's configured model never share one). The build's requests therefore never compete with /chat for a provider limit here: /chat during the build measures database and host contention only, and the build's documents/s is a flat-latency, embedding-bound best case.",
]);

export const buildCrashNotes = () => [
  "Crash injection: the fake model holds dedicated worker 0's first embeddings request of the window unanswered and the harness kills that process (SIGKILL) while it waits, so the kill lands mid-embed with nothing flushed. The jobs it held stay running until their lease (RAG_INGEST_JOB_LEASE_MS) expires; the surviving worker then claims each one (running a job whose previous attempt died alone). A poller on the harness's own connection records every change of every job of the window every 25 ms: status, stage, attempt, claimant, whether the upload bytes are still on the job row, and when each stage output was written. A job resumed at the stage it died in, with no earlier stage observed again and no earlier output rewritten, did not re-parse. Times and docs/s of this level include the lease wait and the loss of one of the two workers.",
];

/** Split topology: how the tiers are wired, how each is measured, and what the model cap means there. */
export const buildTopologyNotes = ({ balance = "least-outstanding", sharedState = "memory" } = {}) => [
  "Split topology: every tier runs in its own process, started through the role start-up a deployment uses (rag/agent-service/role-server.js startServiceRole with ARCHIVE_RAG_ROLE set; topology validation included), on one host and one PostgreSQL database. The tiers are wired by replica lists (AGENT_SERVICE_URL on the api replicas, RETRIEVAL_SERVICE_URL on the agents, MODEL_GATEWAY_URL on api, agent and retrieval) and one internal HS256 key generated for the run (INTERNAL_SERVICE_KEYS; not written to the report). The fake model is the gateway's only chat and embedding upstream; every process keeps its own model API key, so a call that bypassed the gateway would appear in the fake's per-caller counts, and the report counts such calls per level (expected 0).",
  `Balancing: the load generator balances over the api replicas (${balance}, client-side, no proxy); each tier's service client picks among the next tier's replicas itself (fewest requests in flight from that process, ties in rotation), so a request crosses api -> agent -> retrieval -> model gateway and agent -> model gateway, each hop an HTTP call with a signed identity.`,
  "CPU per tier: each process reports its own CPU (process.cpuUsage), PostgreSQL round trips, memory and event-loop delay over the measured window, and the per-tier table sums the replicas of each tier; the level's CPU ms/req sums every tier, so it includes the serialization and HTTP hops between tiers that a monolith does not pay. The busiest process's cores busy is the saturation signal: a Node process runs its JavaScript on one thread, so a tier whose busiest process nears one core busy, with its event-loop delay rising, limits throughput; the busiest tier is named per level. Whole-run CPU per process (start-up and seed ingest included) is read before each process stops.",
  sharedState === "redis"
    ? "Model concurrency: RAG_LLM_MAX_CONCURRENCY is enforced by the model gateway (callers of the gateway run no guard); with shared state redis it is one cap for all gateway processes."
    : "Model concurrency: RAG_LLM_MAX_CONCURRENCY is enforced by the model gateway, per gateway process and upstream (callers of the gateway run no guard); with shared state memory N gateway replicas allow N times the cap, so where the cap binds (model latency above 0 at high concurrency) more gateways raise throughput through the cap, not through CPU. --shared-state redis makes it one cap.",
  "Query cache warm-up: query embeddings run in the retrieval tier, one cache per replica, and the agent tier picks the replica, so the warm-up repeats the question pool on every api replica until a pass sends no embeddings request (bounded; the run records the passes); Embedding calls/req shows any query still embedded during a level.",
];

/** --repeat for the request scenarios. */
export const REPEAT_NOTE =
  "Repeats: each level runs --repeat times in a row on the same processes and database, and the range table gives min - max per concurrency. Runs do not start from a fresh database (every /chat writes an agent run and session memory), so a trend across the runs of a level is drift, not noise; compare configurations by their ranges, and do not rank two whose ranges overlap.";

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
    ...(options.topology === "split"
      ? buildTopologyNotes({ balance: options.balance, sharedState: options.sharedState })
      : (options.instances ?? 1) > 1 || (options.ingestWorkers ?? 0) > 0
        ? buildMultiInstanceNotes({ balance: options.balance, sharedState: options.sharedState })
        : []),
    ...(scenario === "chat" && (options.repeat ?? 1) > 1 ? [REPEAT_NOTE] : []),
    ...(scenario === "ingest"
      ? buildIngestNotes({ ingestMode: options.ingestMode, pollIntervalMs: options.pollIntervalMs })
      : []),
    ...(scenario === "ingest" && options.embedBatching
      ? [
          `Embedding batching ${options.embedBatching}: RAG_INGEST_EMBED_BATCHING=${options.embedBatching === "on" ? "true" : "false"}. On, the embed stages of concurrent jobs in one worker process share embeddings requests (the cross-document batcher); off, each job sends its chunks as its own request, as a synchronous upload does. The fake's embeddings latency is ${options.embeddingLatencyMs} ms per request${options.embeddingLatencyPerInputMs ? ` plus ${options.embeddingLatencyPerInputMs} ms per input` : " whatever the request's size, which favours batching: a real provider takes longer for a larger batch"}.`,
        ]
      : []),
    ...(scenario === "ingest" && options.crashWorkerMidEmbed ? buildCrashNotes() : []),
    ...(scenario === "index-switch" ? INDEX_SWITCH_NOTES : []),
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
    const app = await startAppProcess({ environment: environmentFor("api", `api-${index}`), verbose: options.verbose });
    apps.push(app);
    const ready = await app.start(index === 0 ? corpus.documents : [], {
      primary: index === 0,
      seedFormat: options.scenario === "index-switch" ? "pdf" : "text",
    });
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

/**
 * Starts the split topology's processes one at a time, in SPLIT_TIERS order
 * (each tier once every tier it calls is listening, so its replica lists are
 * complete): the gateways, the retrieval replicas (replica 0 checks that the
 * database is fresh and its start-up migrates it), the agents, then the api
 * replicas (replica 0 ingests the seed corpus). Api replicas are pushed into
 * `apps` and the others into `tierApps` as they start, so the caller can stop
 * the ones already running when a later one fails. Returns the api instances
 * (as startInstances does) and every process with its tier, api replicas first.
 */
const startSplitTopology = async ({ apps, corpus, environmentForTier, options, storage, tierApps }) => {
  const urls = Object.fromEntries(SPLIT_TIERS.map((tier) => [tier, []]));
  const started = Object.fromEntries(SPLIT_TIERS.map((tier) => [tier, []]));

  for (const tier of SPLIT_TIERS) {
    for (let index = 0; index < options.tierReplicas[tier]; index += 1) {
      const child = await startAppProcess({
        environment: environmentForTier(tier, index, urls),
        role: "tier",
        verbose: options.verbose,
      });
      (tier === "api" ? apps : tierApps).push(child);
      const primary = tier === "api" && index === 0;
      const ready = await child.start(primary ? corpus.documents : [], {
        assertFresh: tier === "retrieval" && index === 0,
        primary,
        seedFormat: "text",
      });
      started[tier].push({ child, ready: { ...ready, index, tier } });
      urls[tier].push(`http://127.0.0.1:${ready.port}`);
      console.log(
        primary
          ? `[${storage}] ${tier} #${index}: on port ${ready.port}; ${ready.chunkCount} chunks ingested in ${ready.ingestMs} ms`
          : `[${storage}] ${tier} #${index}: on port ${ready.port}`
      );
    }
  }

  // The load generator's view (api replicas first), then the tiers behind.
  const all = TIER_REPORT_ORDER.flatMap((tier) => started[tier]);

  return {
    instances: started.api.map(({ ready }) => ready),
    processes: all.map(({ child }) => child),
    processList: all.map(({ child, ready }) => ({ index: ready.index, pid: child.pid, port: ready.port, tier: ready.tier })),
  };
};

/**
 * The split topology's query cache warm-up: warmQueryCaches passes (every
 * question once on every api replica) until one sends no embeddings request
 * to the fake model, at most `maxPasses`; with the cache off there is nothing
 * to warm beyond one pass. Returns the passes made, the last pass's
 * embeddings requests and the non-2xx count.
 */
const warmSplitQueryCaches = async ({ fakeModel, maxPasses, options, ...warm }) => {
  let failures = 0;
  let passes = 0;
  let lastPassEmbeddingRequests = null;

  while (passes < (options.embeddingCache ? maxPasses : 1)) {
    fakeModel.resetStats();
    failures += await warmQueryCaches({ ...warm, options });
    passes += 1;
    lastPassEmbeddingRequests = fakeModel.snapshot().embeddings.requests;
    if (lastPassEmbeddingRequests === 0) break;
  }

  return { failures, lastPassEmbeddingRequests, maxPasses, passes };
};

// A process that exited reports nothing (null).
const collectTotals = (processes) =>
  Promise.all(processes.map((child) => (child.exited ? null : child.totals().catch(() => null))));

const startIngestWorkers = async ({ environmentFor, options, storage, workers }) => {
  const ready = [];

  for (let index = 0; index < options.ingestWorkers; index += 1) {
    const worker = await startAppProcess({
      environment: environmentFor("worker", `worker-${index}`),
      role: "worker",
      verbose: options.verbose,
    });
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

  return ready.map((entry) => ({ ingestWorker: entry.ingestWorker ?? null, pid: entry.pid, workerId: entry.workerId ?? null }));
};

/** Claim loops across every process that runs an ingest worker. */
export const countIngestWorkerLoops = (processes = []) =>
  processes.reduce((total, entry) => total + (Number.isInteger(entry?.ingestWorker?.concurrency) ? entry.ingestWorker.concurrency : 0), 0);

// Families kept from each process's last scrape (--metrics): the ones a
// before/after or a deadline run reads. Sample lines only.
export const KEPT_METRIC_FAMILIES = Object.freeze([
  "archive_rag_agent_runs_total",
  "archive_rag_http_requests_total",
  "archive_rag_model_calls_total",
  "archive_rag_model_guard_in_flight",
  "archive_rag_model_guard_waiting",
  "archive_rag_postgres_reads_total",
  "archive_rag_postgres_replica_fallbacks_total",
]);

export const keepMetricSamples = (text = "") =>
  String(text)
    .split("\n")
    .filter((line) => line && !line.startsWith("#") && KEPT_METRIC_FAMILIES.some((family) => line.startsWith(family)));

const scrapeMetrics = ({ port, token }) =>
  new Promise((resolve) => {
    const startedAt = performance.now();
    const request = http.get(
      { headers: token ? { authorization: `Bearer ${token}` } : {}, host: "127.0.0.1", path: "/metrics", port, timeout: 10000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ body, ms: performance.now() - startedAt, status: response.statusCode }));
        response.on("error", () => resolve({ body: "", ms: performance.now() - startedAt, status: 0 }));
      }
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => resolve({ body: "", ms: performance.now() - startedAt, status: 0 }));
  });

/**
 * --metrics: scrapes every instance's /metrics every `intervalMs` (0: never)
 * from start() until finish(), as a Prometheus server would, and once more at
 * finish() to keep KEPT_METRIC_FAMILIES of each process.
 */
const createMetricsScraper = ({ intervalMs, ports, token }) => {
  const totals = { bytes: 0, failures: 0, ms: 0, scrapes: 0 };
  let timer = null;
  const scrapeAll = () =>
    Promise.all(
      ports.map(async (port) => {
        const result = await scrapeMetrics({ port, token });
        totals.scrapes += 1;
        totals.ms += result.ms;
        totals.bytes += result.body.length;
        if (result.status !== 200) totals.failures += 1;
        return result;
      })
    );

  return {
    finish: async () => {
      clearInterval(timer);
      timer = null;
      const last = await scrapeAll();
      return {
        intervalMs,
        meanBytes: totals.scrapes > 0 ? Math.round(totals.bytes / totals.scrapes) : null,
        meanScrapeMs: totals.scrapes > 0 ? round(totals.ms / totals.scrapes) : null,
        processes: last.map((result, index) => ({ index, samples: keepMetricSamples(result.body), status: result.status })),
        scrapeFailures: totals.failures,
        scrapes: totals.scrapes,
      };
    },
    start: () => {
      if (intervalMs > 0 && ports.length > 0) timer = setInterval(scrapeAll, intervalMs);
    },
    stop: () => {
      clearInterval(timer);
      timer = null;
    },
  };
};

// The run's agent runs by status and error code/reason, as the owner (the
// --agent-request-timeout-ms evidence: how many runs ended on the deadline).
const readAgentRunOutcomes = (databaseUrl) =>
  withNodeClient(databaseUrl, async (client) =>
    (
      await client.query(
        `SELECT status, error->>'code' AS code, error->>'reason' AS reason, count(*)::int AS runs
         FROM rag_agent_runs GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`
      )
    ).rows
  ).catch((error) => ({ error: error?.code ?? error?.message ?? "error" }));

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
  if (options.serveTier) {
    await serveTier();
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
  if (options.readReplicaUrl) await assertReadReplica(options.readReplicaUrl);
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
  // --metrics: the scrape token, handed to the app processes only.
  const metricsToken = options.metrics ? randomBytes(16).toString("hex") : "";
  const headers = buildRequestHeaders({ authToken, options });
  const split = options.topology === "split";
  // The split topology's internal signing key: generated here, handed to its
  // processes only, never logged or reported.
  const serviceKeys = split ? createRunServiceKeys({ runId }) : "";
  const topologyConfig = describeTopologyConfig(options);
  const fakeModel = await startFakeModelServer({ dimensions: options.embeddingDimensions });
  const runs = [];

  console.log(
    options.scenario === "index-switch"
      ? `Load test (index switch): ${options.instances} instance(s), ${options.balance} balancing; /chat concurrency ${options.switchConcurrency}; seed ${options.documents} x ${options.pages} pages at ${options.embeddingDimensions} dimensions; new version ${switchEmbeddingModel(options.switchDimensions)}; phases of ${options.switchPhaseMs} ms`
      : split
      ? `Load test (split topology): ${TIER_REPORT_ORDER.map((tier) => `${tier} x${options.tierReplicas[tier]}`).join(", ")} (${topologyConfig.totalProcesses} processes), ${options.balance} balancing over the api replicas; concurrency ${options.concurrency.join(", ")}; model latency ${options.modelLatencyMs.join(", ")} ms; RAG_LLM_MAX_CONCURRENCY=${options.llmMaxConcurrency} per gateway process; shared state ${options.sharedState}${options.repeat > 1 ? `; each level ${options.repeat} times` : ""}`
      : options.scenario === "ingest"
      ? `Load test (ingest, ${options.ingestMode}): storage ${options.storage.join(", ")}; ${options.instances} instance(s), ${options.ingestWorkers} worker process(es), ${options.balance} balancing; upload concurrency ${options.uploadConcurrency.join(", ")}; ${options.uploads} uploads per level; embedding latency ${options.embeddingLatencyMs} ms; shared state ${options.sharedState}`
      : `Load test: storage ${options.storage.join(", ")}; ${options.instances} instance(s), ${options.balance} balancing; concurrency ${options.concurrency.join(", ")}; model latency ${options.modelLatencyMs.join(", ")} ms; RAG_LLM_MAX_CONCURRENCY=${options.llmMaxConcurrency}; shared state ${options.sharedState}`
  );

  try {
    for (const storage of options.storage) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), `load-test-${storage}-`));
      await writeFile(path.join(tempRoot, "empty.env"), "");
      // Every process of the run shares the temp root: data, uploads and
      // upload-session directories are the same, as on one host.
      const environmentFor = (role, callerTag = "") =>
        buildAppEnvironment({
          authToken,
          callerTag,
          databaseUrl: options.databaseUrl,
          metricsToken,
          modelBaseUrl: fakeModel.baseUrl,
          options,
          role,
          runId,
          storage,
          tempRoot,
        });
      const environmentForTier = (tier, index, urls) =>
        buildTierEnvironment({
          authToken,
          databaseUrl: options.databaseUrl,
          index,
          modelBaseUrl: fakeModel.baseUrl,
          options,
          runId,
          serviceKeys,
          storage,
          tempRoot,
          tier,
          urls,
        });
      const apps = [];
      const workers = [];
      // The split topology's agent, retrieval and gateway processes.
      const tierApps = [];
      let metricsScraper = null;
      // The cluster's CPU belongs to the pgvector run only.
      const hostSampler = createHostSampler({ postmasterPid: storage === "pgvector" ? postmasterPid : null });

      try {
        fakeModel.setLatency({ chatMs: 0, embeddingMs: 0, embeddingPerInputMs: 0 });
        console.log(
          split
            ? `[${storage}] starting ${topologyConfig.totalProcesses} tier processes and ingesting ${corpus.documents.length} documents...`
            : `[${storage}] starting ${options.instances} app instance(s) and ingesting ${corpus.documents.length} documents...`
        );
        const splitTopology = split
          ? await startSplitTopology({ apps, corpus, environmentForTier, options, storage, tierApps })
          : null;
        const instances = splitTopology
          ? splitTopology.instances
          : await startInstances({ apps, corpus, environmentFor, options, storage });
        // Every app process a level reads, with its tier (api replicas first).
        const processes = splitTopology ? splitTopology.processes : apps;
        const processList = splitTopology
          ? splitTopology.processList
          : instances.map((instance, index) => ({ index, pid: apps[index].pid, port: instance.port, tier: MONOLITH_TIER }));
        const processTiers = processList.map((entry) => entry.tier);
        let warmUp = null;
        const workerProcesses = await startIngestWorkers({ environmentFor, options, storage, workers });
        const workerLoops = countIngestWorkerLoops([...instances, ...workerProcesses]);
        const baseUrls = instances.map((instance) => `http://127.0.0.1:${instance.port}`);
        const primary = instances[0];
        const scenarios = [];
        let databaseAnalyzeMs = null;
        let idle = null;
        // --read-replica-url: per-node statements and routing counters of the
        // chat scenario's measured levels.
        let readReplica = null;
        metricsScraper = options.metrics
          ? createMetricsScraper({
              intervalMs: options.metricsScrapeMs,
              ports: instances.map((instance) => instance.metricsPort).filter(Number.isInteger),
              token: metricsToken,
            })
          : null;
        metricsScraper?.start();

        if (options.scenario === "ingest") {
          if (options.warmup > 0) {
            await warmUpIngestScenario({ baseUrls, headers, options, questions: corpus.questions, runId });
          }
          databaseAnalyzeMs = await analyzeDatabase({ options, primary: apps[0], storage });
          idle = await measureIdle({ idleMs: options.idleMs, processes: [...apps, ...workers] });
          for (const profile of options.modelLatencyMs) {
            fakeModel.setLatency({
              chatMs: profile,
              embeddingMs: options.embeddingLatencyMs,
              embeddingPerInputMs: options.embeddingLatencyPerInputMs,
            });
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
                workerProcesses,
                workers,
              })
            );
          }
        } else if (options.scenario === "index-switch") {
          if (options.warmup > 0) {
            const failures = await warmQueryCaches({
              baseUrls,
              concurrency: Math.min(8, options.switchConcurrency),
              headers,
              options,
              questions: corpus.questions,
              sessionTag: `load-${runId}-switch-warm`,
            });
            if (failures > 0) console.warn(`[${storage}] query cache warm-up: ${failures} request(s) failed`);
          }
          databaseAnalyzeMs = await analyzeDatabase({ options, primary: apps[0], storage });
          const profile = options.modelLatencyMs[0] ?? 0;
          fakeModel.setLatency({
            chatMs: profile,
            embeddingMs: options.embeddingLatencyMs,
            embeddingPerInputMs: options.embeddingLatencyPerInputMs,
          });
          scenarios.push({
            ...(await runIndexSwitchScenario({
              apps,
              baseUrls,
              corpus,
              environmentFor,
              fakeModel,
              headers,
              options,
              runId,
            })),
            embeddingLatencyMs: options.embeddingLatencyMs,
            modelLatencyMs: profile,
          });
        } else {
          if (options.warmup > 0 && split) {
            // Every retrieval replica's query embedding cache (the tier that
            // embeds queries), before any measured level.
            warmUp = await warmSplitQueryCaches({
              baseUrls,
              concurrency: Math.min(8, Math.max(...options.concurrency)),
              fakeModel,
              headers,
              maxPasses: splitWarmUpPassLimit(options.tierReplicas.retrieval),
              options,
              questions: corpus.questions,
              sessionTag: `load-${runId}-chat-warm`,
            });
            console.log(
              `[${storage}] query cache warm-up: ${warmUp.passes} pass(es), the last sent ${warmUp.lastPassEmbeddingRequests} embeddings request(s)`
            );
            if (warmUp.failures > 0) console.warn(`[${storage}] query cache warm-up: ${warmUp.failures} request(s) failed`);
          } else if (options.warmup > 0) {
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
          idle = await measureIdle({ idleMs: options.idleMs, processes });
          const replicaMark =
            options.readReplicaUrl && storage === "pgvector" ? await readReplicaStatementMark({ options, processes }) : null;
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
              processes,
              processTiers,
              profile: null,
              runId,
              target: { kind: "cheap", label: `GET ${options.cheapPath}`, path: options.cheapPath },
            })
          );

          for (const profile of options.modelLatencyMs) {
            fakeModel.setLatency({
              chatMs: profile,
              embeddingMs: options.embeddingLatencyMs,
              embeddingPerInputMs: options.embeddingLatencyPerInputMs,
            });
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
                processes,
                processTiers,
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
          if (replicaMark) readReplica = await collectReadReplicaReport({ before: replicaMark, options, processes });
        }

        const metrics = metricsScraper ? await metricsScraper.finish() : null;
        const agentRunOutcomes =
          Number.isInteger(options.agentRequestTimeoutMs) && storage === "pgvector"
            ? await readAgentRunOutcomes(options.databaseUrl)
            : null;
        if (agentRunOutcomes) console.log(`[${storage}] agent runs by outcome: ${JSON.stringify(agentRunOutcomes)}`);

        // Whole-run CPU of every process, read before any of them stops.
        const lifetime = summarizeProcessTotals({
          processes: [
            ...processList,
            ...workerProcesses.map((worker, index) => ({ index, pid: worker.pid, port: null, tier: "ingest-worker" })),
          ],
          totals: await collectTotals([...processes, ...workers]),
        });

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
          ...(metrics ? { metrics } : {}),
          ...(agentRunOutcomes ? { agentRunOutcomes } : {}),
          readReplica,
          scenarios,
          sharedState: options.sharedState,
          storage,
          topology: {
            ...topologyConfig,
            processes: processList,
            lifetime,
            ...(warmUp ? { warmUp } : {}),
          },
          workerProcesses,
        });
      } catch (error) {
        for (const [index, child] of [...apps, ...tierApps, ...workers].entries()) {
          if (!options.verbose && child.logTail.length > 0) {
            console.error(`[${storage}] last log lines of process ${index}:\n${child.logTail.join("\n")}`);
          }
        }
        throw error;
      } finally {
        metricsScraper?.stop();
        await Promise.all([...workers, ...apps, ...tierApps].map((child) => child.stop()));
        await rm(tempRoot, { force: true, recursive: true });
      }
    }
  } finally {
    await fakeModel.close();
  }

  const cpus = os.cpus();
  const ingest = options.scenario === "ingest";
  const indexSwitch = options.scenario === "index-switch";
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
      embeddingLatencyPerInputMs: options.embeddingLatencyPerInputMs,
      embedBatching: ingest ? options.embedBatching : null,
      embedBatchLingerMs: ingest ? options.embedBatchLingerMs : null,
      crashWorkerMidEmbed: ingest ? options.crashWorkerMidEmbed : false,
      ingestJobLeaseMs: ingest ? options.ingestJobLeaseMs : null,
      indexPointerTtlMs: indexSwitch ? options.indexPointerTtlMs : null,
      switchBuildBatchSize: indexSwitch ? options.switchBuildBatchSize : null,
      switchBuildConcurrency: indexSwitch ? options.switchBuildConcurrency : null,
      switchConcurrency: indexSwitch ? options.switchConcurrency : null,
      switchDimensions: indexSwitch ? options.switchDimensions : null,
      switchPhaseMs: indexSwitch ? options.switchPhaseMs : null,
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
      ...(options.metrics ? { metrics: true, metricsScrapeMs: options.metricsScrapeMs } : {}),
      ...(Number.isInteger(options.agentRequestTimeoutMs) ? { agentRequestTimeoutMs: options.agentRequestTimeoutMs } : {}),
      ...(Number.isInteger(options.llmCircuitFailureThreshold)
        ? { llmCircuitFailureThreshold: options.llmCircuitFailureThreshold }
        : {}),
      ...(options.nodeStatements ? { nodeStatements: true } : {}),
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
      readReplica: Boolean(options.readReplicaUrl),
      repeat: indexSwitch ? null : options.repeat,
      requestTimeoutMs: options.requestTimeoutMs,
      requests: options.requests,
      scenario: options.scenario,
      searchableTimeoutMs: ingest ? options.searchableTimeoutMs : null,
      sharedState: options.sharedState,
      storage: options.storage,
      ...topologyConfig,
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
