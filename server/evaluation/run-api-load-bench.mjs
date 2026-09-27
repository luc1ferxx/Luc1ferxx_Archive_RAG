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
// Usage:
//   node evaluation/run-api-load-bench.mjs
//     [--storage local|pgvector|local,pgvector]  default: local, or
//                                   pgvector,local when --database-url is given
//     [--database-url <disposable pgvector PostgreSQL URL>]
//     [--concurrency 1,4,16,32] [--requests 128] [--cheap-requests 1000]
//     [--warmup 8] [--model-latency-ms 0,800] [--embedding-latency-ms 0]
//     [--llm-max-concurrency 8] [--embedding-dimensions 1536]
//     [--documents 20] [--pages 4] [--cheap-path /documents]
//     [--request-timeout-ms 120000] [--planner deterministic|llm]
//     [--auth] [--rate-limit] [--no-embedding-cache]
//     [--latest-name latest-load-test] [--verbose]
//
// Full run against a throwaway PostgreSQL (created and removed by the script):
//   bash scripts/run-load-test-pgvector.sh [extra flags]

import { execFileSync, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");
const resultsDirectory = path.join(__dirname, "results");

export const LOAD_TEST_REPORT_TYPE = "load-test";
export const LOAD_TEST_REPORT_VERSION = "1.0.0";
export const PERCENTILE_METHOD = "nearest-rank";

const FAKE_CHAT_MODEL = "load-test-chat";
const FAKE_EMBEDDING_MODEL = "text-embedding-3-small";

export const DEFAULT_LOAD_TEST_OPTIONS = Object.freeze({
  auth: false,
  cheapPath: "/documents",
  cheapRequests: 1000,
  concurrency: Object.freeze([1, 4, 16, 32]),
  databaseUrl: "",
  documents: 20,
  embeddingCache: true,
  embeddingDimensions: 1536,
  embeddingLatencyMs: 0,
  latestName: "latest-load-test",
  llmMaxConcurrency: 8,
  modelLatencyMs: Object.freeze([0, 800]),
  pages: 4,
  planner: "deterministic",
  rateLimit: false,
  requestTimeoutMs: 120000,
  requests: 128,
  storage: null,
  verbose: false,
  warmup: 8,
});

const STORAGE_MODES = new Set(["local", "pgvector"]);
const PLANNER_MODES = new Set(["deterministic", "llm"]);

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
  const flags = new Set(["auth", "no-embedding-cache", "rate-limit", "verbose", "serve"]);

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
    "cheap-path",
    "cheap-requests",
    "concurrency",
    "database-url",
    "documents",
    "embedding-dimensions",
    "embedding-latency-ms",
    "latest-name",
    "llm-max-concurrency",
    "model-latency-ms",
    "pages",
    "planner",
    "request-timeout-ms",
    "requests",
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

  const storage = raw.storage
    ? String(raw.storage)
        .split(",")
        .map((mode) => mode.trim())
        .filter(Boolean)
    : options.databaseUrl
      ? ["pgvector", "local"]
      : ["local"];

  for (const mode of storage) {
    if (!STORAGE_MODES.has(mode)) throw new Error(`--storage accepts local and pgvector, got "${mode}".`);
  }
  if (storage.includes("pgvector") && !options.databaseUrl) {
    throw new Error(
      "--storage pgvector needs --database-url pointing at a disposable pgvector PostgreSQL (scripts/run-load-test-pgvector.sh creates one)."
    );
  }

  options.storage = [...new Set(storage)];
  options.serve = Boolean(raw.serve);

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
}) => {
  const environment = { ...baseEnvironment };

  // Anything that could point the app at another database, model or cache.
  for (const name of Object.keys(environment)) {
    if (
      /^(OPENAI_|POSTGRES_|LONG_MEMORY_|PGVECTOR_|QDRANT_|REDIS_|RAG_|AGENT_|API_AUTH|RATE_LIMIT|OTEL_|DOCCOMPARE_|VECTOR_STORE_|DOCUMENT_STORE_|SESSION_MEMORY_STORE_|TASK_STORE_|WORKSPACE_ARTIFACT_STORE_|ADMIN_AUDIT_STORE_|AGENT_RUN_STORE_|UPLOADS_DIRECTORY|FRONTEND_BUILD_DIRECTORY|ALLOWED_ORIGINS|SERPAPI_|PG)/.test(
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
  });

  if (options.auth) environment.API_AUTH_TOKEN = authToken;

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

const startAppProcess = async ({ environment, verbose }) => {
  const child = fork(__filename, ["--serve"], {
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
    start: (documents) => request({ documents, type: "start" }, "ready"),
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

// Child side: build the app like server.js, ingest, listen, report stats.
const serve = async () => {
  const tempRoot = process.env.LOAD_TEST_TEMP_ROOT;
  const storage = process.env.LOAD_TEST_STORAGE;
  const loopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_SAMPLING_MS });
  let cpuMark = process.cpuUsage();
  let server = null;

  const fail = (error) => {
    process.send?.({ message: String(error?.stack ?? error), type: "error" });
    process.exit(1);
  };

  process.on("message", async (message) => {
    try {
      if (message?.type === "start") {
        if (storage === "local") {
          const { applyStandaloneProfile } = await import("../standalone-profile.js");
          applyStandaloneProfile();
        } else {
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
        if (storage === "pgvector") {
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

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        loopDelay.enable();
        cpuMark = process.cpuUsage();
        process.send({
          chunkCount,
          databaseChunkRows,
          documentCount: message.documents.length,
          ingestMs: round(ingestMs),
          port: server.address().port,
          type: "ready",
          vectorStore: describeVectorStoreRuntime(),
        });
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
        server?.closeAllConnections?.();
        server?.close();
        process.exit(0);
      }
    } catch (error) {
      fail(error);
    }
  });
  process.on("disconnect", () => process.exit(0));
};

// ---------------------------------------------------------------------------
// Load generation

const sendHttpRequest = ({ agent, baseUrl, body = null, headers = {}, method, path: requestPath, parse, timeoutMs }) =>
  new Promise((resolve) => {
    const payload = body === null ? null : JSON.stringify(body);
    const request = http.request(
      `${baseUrl}${requestPath}`,
      {
        agent,
        headers: {
          ...headers,
          ...(payload ? { "content-length": Buffer.byteLength(payload), "content-type": "application/json" } : {}),
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

const runLevel = async ({ baseUrl, concurrency, headers, options, requests, target, sessionTag }) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const send =
    target.kind === "chat"
      ? ({ index, workerIndex }) => {
          const question = target.questions[(target.offset + index) % target.questions.length];
          return sendHttpRequest({
            agent,
            baseUrl,
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
        }
      : () =>
          sendHttpRequest({
            agent,
            baseUrl,
            headers,
            method: "GET",
            path: target.path,
            timeoutMs: options.requestTimeoutMs,
          });

  try {
    return await runClosedLoop({ concurrency, requests, send });
  } finally {
    agent.destroy();
  }
};

const runScenario = async ({ app, baseUrl, fakeModel, headers, options, profile, runId, target }) => {
  const levels = [];

  for (const concurrency of options.concurrency) {
    const requests = target.kind === "chat" ? options.requests : options.cheapRequests;
    const sessionTag = `load-${runId}-${target.kind}-${profile ?? "na"}-c${concurrency}`;
    const warmupRequests = options.warmup > 0 ? Math.max(options.warmup, concurrency) : 0;

    if (warmupRequests > 0) {
      await runLevel({ baseUrl, concurrency, headers, options, requests: warmupRequests, sessionTag: `${sessionTag}-warm`, target });
      target.offset += warmupRequests;
    }

    fakeModel.resetStats();
    await app.stats();
    const { results, wallMs } = await runLevel({ baseUrl, concurrency, headers, options, requests, sessionTag, target });
    target.offset += requests;
    const serverStats = await app.stats();
    const model = fakeModel.snapshot();
    const summary = summarizeLevel({ results, wallMs });
    const perRequest = (value) => (summary.requests > 0 ? round(value / summary.requests, 2) : null);
    const { type: _type, ...serverFields } = serverStats;

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
      server: {
        ...serverFields,
        cpuMsPerRequest: perRequest((serverStats.cpuUserMs ?? 0) + (serverStats.cpuSystemMs ?? 0)),
      },
    });

    console.log(
      `  ${target.label.padEnd(26)} c=${String(concurrency).padStart(3)}  ${String(summary.throughputRps).padStart(8)} req/s  p50 ${summary.latencyMs.p50} ms  p95 ${summary.latencyMs.p95} ms  p99 ${summary.latencyMs.p99} ms  errors ${summary.errors}/${summary.requests}${target.kind === "chat" ? `  peak model in flight ${model.chat.peakInFlight}` : ""}`
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

/** Markdown report: config, then one table per storage mode and scenario. */
export const formatLoadTestMarkdown = (report) => {
  const { config } = report;
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
    `| Model latency profiles (chat completion) | ${config.modelLatencyMs.map((ms) => `${ms} ms`).join(", ")} |`,
    `| Embedding latency | ${config.embeddingLatencyMs} ms |`,
    `| RAG_LLM_MAX_CONCURRENCY | ${config.llmMaxConcurrency} |`,
    `| Concurrency levels | ${config.concurrency.join(", ")} |`,
    `| Requests per level | /chat ${config.requests}, ${config.cheapPath} ${config.cheapRequests} (after a warm-up of max(${config.warmup}, concurrency)) |`,
    `| Corpus | ${config.documents} documents x ${config.pages} pages, ${config.questions} questions |`,
    `| Planner | ${config.planner} |`,
    `| Auth / rate limit | ${config.auth ? "enabled" : "disabled"} / ${config.rateLimit ? "enabled" : "disabled"} |`,
    `| Embedding dimensions / query embedding cache | ${config.embeddingDimensions} / ${config.embeddingCache ? "on" : "off"} |`,
    "",
    `Percentiles: ${report.method.percentile}. ${report.method.notes.join(" ")}`,
    "",
  ];

  for (const run of report.runs) {
    lines.push(
      `## Storage: ${run.storage}`,
      "",
      `Ingest: ${run.ingest.documentCount} documents, ${run.ingest.chunkCount} chunks in ${run.ingest.ingestMs} ms.`,
      `Vector store in the app process: ${formatVectorStore(run.ingest.vectorStore)}${
        Number.isInteger(run.ingest.databaseChunkRows)
          ? `; ${run.ingest.databaseChunkRows} chunk rows counted in PostgreSQL after ingest`
          : ""
      }.`,
      ""
    );

    for (const scenario of run.scenarios) {
      const heading =
        scenario.kind === "chat"
          ? `### ${scenario.endpoint}, model latency ${scenario.modelLatencyMs} ms`
          : `### ${scenario.endpoint}`;
      lines.push(heading, "");

      if (scenario.kind === "chat") {
        lines.push(
          "| Concurrency | Requests | Errors | Error rate | Req/s | p50 ms | p95 ms | p99 ms | Max ms | Chat calls/req | Embedding calls/req | Peak chat in flight | Server CPU ms/req | Event-loop p99 ms | Answers (mode, cited) |",
          "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"
        );
        for (const level of scenario.levels) {
          const modes = [
            ...Object.entries(level.agentModes ?? {}).map(([mode, count]) => `${mode} ${count}`),
            ...(Number.isInteger(level.groundedAnswers) ? [`cited ${level.groundedAnswers}`] : []),
          ].join(", ");
          lines.push(
            `| ${level.concurrency} | ${level.requests} | ${level.errors} | ${cell(level.errorRate)} | ${cell(level.throughputRps)} | ${cell(level.latencyMs.p50)} | ${cell(level.latencyMs.p95)} | ${cell(level.latencyMs.p99)} | ${cell(level.latencyMs.max)} | ${cell(level.model.chatCompletionsPerRequest)} | ${cell(level.model.embeddingRequestsPerRequest)} | ${cell(level.model.peakChatInFlight)} | ${cell(level.server.cpuMsPerRequest)} | ${cell(level.server.eventLoopDelayP99Ms)} | ${modes || "-"} |`
          );
        }
      } else {
        lines.push(
          "| Concurrency | Requests | Errors | Error rate | Req/s | p50 ms | p95 ms | p99 ms | Max ms | Server CPU ms/req | Event-loop p99 ms |",
          "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
        );
        for (const level of scenario.levels) {
          lines.push(
            `| ${level.concurrency} | ${level.requests} | ${level.errors} | ${cell(level.errorRate)} | ${cell(level.throughputRps)} | ${cell(level.latencyMs.p50)} | ${cell(level.latencyMs.p95)} | ${cell(level.latencyMs.p99)} | ${cell(level.latencyMs.max)} | ${cell(level.server.cpuMsPerRequest)} | ${cell(level.server.eventLoopDelayP99Ms)} |`
          );
        }
      }

      const errorLevels = scenario.levels.filter((level) => level.errors > 0);
      if (errorLevels.length > 0) {
        lines.push("", "Errors:");
        for (const level of errorLevels) {
          lines.push(`- c=${level.concurrency}: ${Object.entries(level.errorCounts).map(([reason, count]) => `${reason} x${count}`).join(", ")}`);
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
  "GET /documents lists the app's in-process document registry and sends no database query in either storage mode; it measures the HTTP stack, auth and scope filtering, not storage.",
  "Load generator, fake model and app run on one host; the app runs in its own process.",
  `Event-loop p99 is the app process's delay beyond the ${EVENT_LOOP_SAMPLING_MS} ms sampling interval of monitorEventLoopDelay (an idle loop shows about 0); stalls shorter than the interval can be missed.`,
  "Server CPU ms/req is the app process's user+system CPU over the level divided by its requests; it counts everything the process did during the level (timers and GC included), not request handling alone.",
]);

const main = async () => {
  const options = parseLoadTestArgs(process.argv.slice(2));

  if (options.serve) {
    await serve();
    return;
  }

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
    `Load test: storage ${options.storage.join(", ")}; concurrency ${options.concurrency.join(", ")}; model latency ${options.modelLatencyMs.join(", ")} ms; RAG_LLM_MAX_CONCURRENCY=${options.llmMaxConcurrency}`
  );

  try {
    for (const storage of options.storage) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), `load-test-${storage}-`));
      const environment = buildAppEnvironment({
        authToken,
        databaseUrl: options.databaseUrl,
        modelBaseUrl: fakeModel.baseUrl,
        options,
        storage,
        tempRoot,
      });
      const app = await startAppProcess({ environment, verbose: options.verbose });

      try {
        fakeModel.setLatency({ chatMs: 0, embeddingMs: 0 });
        console.log(`[${storage}] starting app and ingesting ${corpus.documents.length} documents...`);
        const ready = await app.start(corpus.documents);
        const baseUrl = `http://127.0.0.1:${ready.port}`;
        console.log(`[${storage}] ${ready.chunkCount} chunks ingested in ${ready.ingestMs} ms; app on ${baseUrl}`);
        const scenarios = [];

        scenarios.push(
          await runScenario({
            app,
            baseUrl,
            fakeModel,
            headers,
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
              app,
              baseUrl,
              fakeModel,
              headers,
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

        runs.push({
          ingest: {
            chunkCount: ready.chunkCount,
            databaseChunkRows: ready.databaseChunkRows,
            documentCount: ready.documentCount,
            ingestMs: ready.ingestMs,
            vectorStore: ready.vectorStore,
          },
          scenarios,
          storage,
        });
      } catch (error) {
        if (!options.verbose && app.logTail.length > 0) {
          console.error(`[${storage}] last app log lines:\n${app.logTail.join("\n")}`);
        }
        throw error;
      } finally {
        await app.stop();
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
      llmMaxConcurrency: options.llmMaxConcurrency,
      modelLatencyMs: options.modelLatencyMs,
      nodeVersion: process.version,
      pages: options.pages,
      planner: options.planner,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      questions: corpus.questions.length,
      rateLimit: options.rateLimit,
      requestTimeoutMs: options.requestTimeoutMs,
      requests: options.requests,
      storage: options.storage,
      totalMemoryGb: round(os.totalmem() / 1024 ** 3),
      warmup: options.warmup,
    },
    method: { notes: LOAD_TEST_METHOD_NOTES, percentile: PERCENTILE_METHOD },
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
