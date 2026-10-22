import { isIP } from "node:net";

const hasEnvValue = (rawValue) =>
  typeof rawValue === "string" && rawValue.trim() !== "";

// Number("") and Number("   ") are 0, so without this an empty line in .env
// (VAR=) would silently replace a default, and for many settings 0 means "off"
// or "no limit". An empty or whitespace-only value counts as unset; a number
// passed directly is used as is.
const parseEnvNumber = (rawValue) => {
  if (typeof rawValue === "number") {
    return rawValue;
  }

  return hasEnvValue(rawValue) ? Number(rawValue) : Number.NaN;
};

const toPositiveNumber = (rawValue, fallbackValue) => {
  const parsedValue = parseEnvNumber(rawValue);

  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallbackValue;
};

const toNonNegativeNumber = (rawValue, fallbackValue) => {
  const parsedValue = parseEnvNumber(rawValue);

  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? parsedValue
    : fallbackValue;
};

const toBoolean = (rawValue, fallbackValue = false) => {
  if (typeof rawValue !== "string") {
    return fallbackValue;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  return fallbackValue;
};

const toChoice = (rawValue, fallbackValue, allowedValues) => {
  if (typeof rawValue !== "string") {
    return fallbackValue;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  return allowedValues.includes(normalizedValue) ? normalizedValue : fallbackValue;
};

export const getEmbeddingModel = () =>
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

// PDF text extraction. `pdfjs` (default) reads the content stream in-process;
// `docling` sends the file to a docling-serve instance for layout-aware
// parsing (reading order across columns, tables as cell grids; see
// docling-parser.js); `auto` parses every page with pdf.js and sends only the
// pages that need it (tables, scans, a garbled text layer) to docling-serve
// (pdf-auto-parser.js, pdf-page-router.js). Any other value fails at ingest
// rather than silently parsing with something else.
export const PDF_PARSERS = Object.freeze(["pdfjs", "docling", "auto"]);

export const getPdfParser = () => {
  const value = String(process.env.PDF_PARSER ?? "pdfjs").trim().toLowerCase() || "pdfjs";

  if (!PDF_PARSERS.includes(value)) {
    throw new Error(`PDF_PARSER must be one of ${PDF_PARSERS.join(", ")}; got "${process.env.PDF_PARSER}".`);
  }

  return value;
};

// pdf.js only: rebuild paragraphs from line geometry (pdf-paragraphs.js), so a
// soft-wrapped paragraph reaches the chunker as one unit instead of one unit
// per visual line. On by default since the QASPER pdfjs vs pdfjs-paragraphs
// run met the pre-declared non-inferiority rule (docs/evaluation.md); false
// keeps the legacy page text byte for byte. Docling output is never touched.
export const isPdfParagraphDetectionEnabled = () =>
  toBoolean(process.env.PDF_PARAGRAPH_DETECTION, true);

// pdf.js on a pool of worker_threads (pdf-parse-pool.js). 0 (default) parses
// in the calling thread exactly as before; N > 0 splits a document into page
// ranges of PDF_PARSE_PAGES_PER_TASK pages that up to N workers parse at once,
// with the same page text byte for byte. Each worker holds its own pdf.js, so
// N workers cost N times its memory.
export const MAX_PDF_PARSE_WORKERS = 64;

export const getPdfParseWorkers = () =>
  Math.min(MAX_PDF_PARSE_WORKERS, Math.floor(toNonNegativeNumber(process.env.PDF_PARSE_WORKERS, 0)));

export const getPdfParsePagesPerTask = () =>
  Math.max(1, Math.floor(toPositiveNumber(process.env.PDF_PARSE_PAGES_PER_TASK, 32)));

// Bounds one worker task (a page range); 0 = none. A task over the limit
// terminates its worker. The in-process path has no timeout.
const MAX_PDF_PARSE_TIMEOUT_MS = 2_147_483_647;

export const getPdfParseTimeoutMs = () =>
  Math.min(MAX_PDF_PARSE_TIMEOUT_MS, Math.floor(toNonNegativeNumber(process.env.PDF_PARSE_TIMEOUT_MS, 0)));

// V8 old-space limit of each worker (resourceLimits.maxOldGenerationSizeMb);
// 0 = Node's default. A worker over it fails its task and is replaced.
export const getPdfParseWorkerMaxOldGenerationMb = () =>
  Math.floor(toNonNegativeNumber(process.env.PDF_PARSE_WORKER_MAX_OLD_GENERATION_MB, 0));

// docling-serve listens on 5001 inside its container, the backend's own
// default port, so the documented local mapping is 5010.
export const getDoclingServeUrl = () =>
  String(process.env.DOCLING_SERVE_URL || "http://127.0.0.1:5010").replace(/\/+$/, "");

// Bounds one docling-serve request (a whole document, or one page range under
// DOCLING_PAGE_BATCH_SIZE or auto) from the moment it has a
// DOCLING_MAX_CONCURRENCY slot; the wait for the slot does not count.
export const getDoclingTimeoutMs = () =>
  Math.floor(toPositiveNumber(process.env.DOCLING_TIMEOUT_MS, 300000));

// Born-digital PDFs carry their text; OCR is for scans and costs minutes.
export const isDoclingOcrEnabled = () => toBoolean(process.env.DOCLING_OCR, false);

// When docling-serve fails: `pdfjs` (default) parses the file in-process and
// logs why; `none` fails the upload.
export const getDoclingFallback = () =>
  String(process.env.DOCLING_FALLBACK ?? "pdfjs").trim().toLowerCase() === "none" ? "none" : "pdfjs";

// docling-serve runs 2 local workers by default (DOCLING_SERVE_ENG_LOC_NUM_WORKERS);
// a request beyond that only queues inside docling-serve while its
// DOCLING_TIMEOUT_MS runs. Per process: every conversion (PDF_PARSER=docling
// and auto alike) waits for one of these slots, first come first served, and
// its timeout starts once it has one.
export const getDoclingMaxConcurrency = () =>
  Math.max(1, Math.floor(toPositiveNumber(process.env.DOCLING_MAX_CONCURRENCY, 2)));

// Pages per docling-serve request. 0 (default) = no limit: one request per
// document under PDF_PARSER=docling, one per contiguous run of routed pages
// under auto. A limit splits a long document into page ranges converted
// concurrently (within DOCLING_MAX_CONCURRENCY), so one request's timeout
// covers at most this many pages.
export const getDoclingPageBatchSize = () =>
  Math.floor(toNonNegativeNumber(process.env.DOCLING_PAGE_BATCH_SIZE, 0));

// PDF_PARSER=auto: two runs of pages on the same Docling route at most this
// many text pages apart go as one request (every docling-serve request
// uploads the whole file and pays a fixed cost); the gap pages are converted
// but keep their pdf.js text. 0 (default) = one request per contiguous run.
// On 30 QASPER papers 2 cut the requests from 55 to 34: 4.5% faster at
// DOCLING_MAX_CONCURRENCY=1, but about 6% slower at the default 2, where
// smaller requests overlap better (docs/evaluation.md "真实 docling-serve 上的验证").
export const getDoclingMergeGapPages = () =>
  Math.floor(toNonNegativeNumber(process.env.DOCLING_MERGE_GAP_PAGES, 0));

// PDF_PARSER=auto: which Docling routes pdf-page-router.js may pick. `layout`
// sends table pages to docling-serve without OCR, `ocr` sends scanned,
// image-only and garbled pages with OCR forced. `none` routes nothing (every
// page keeps its pdf.js text; the routing report still says what would have
// been routed). Any other token fails, like PDF_PARSER.
export const PDF_AUTO_ROUTES = Object.freeze(["layout", "ocr"]);

export const getPdfAutoRoutes = () => {
  const rawValue = process.env.PDF_AUTO_ROUTES;

  if (!hasEnvValue(rawValue)) {
    return PDF_AUTO_ROUTES;
  }

  const tokens = rawValue
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 1 && tokens[0] === "none") {
    return Object.freeze([]);
  }

  const unknown = tokens.filter((token) => !PDF_AUTO_ROUTES.includes(token));

  if (tokens.length === 0 || unknown.length > 0) {
    throw new Error(
      `PDF_AUTO_ROUTES must be a comma list of ${PDF_AUTO_ROUTES.join(", ")}, or none; got "${rawValue}".`
    );
  }

  return Object.freeze(PDF_AUTO_ROUTES.filter((route) => tokens.includes(route)));
};

// The auto router's thresholds. Unset or empty is the default; a value out of
// range fails (ingest and the health report name the variable) instead of
// routing pages by some other bar.
const readPdfAutoThreshold = (name, fallbackValue, { describe, isValid }) => {
  const rawValue = process.env[name];

  if (!hasEnvValue(rawValue)) {
    return fallbackValue;
  }

  const value = toNonNegativeNumber(rawValue, Number.NaN);

  if (!isValid(value)) {
    throw new Error(`${name} must be ${describe}; got "${rawValue}".`);
  }

  return value;
};

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const isUnitRatio = (value) => Number.isFinite(value) && value > 0 && value <= 1;

// Tabular lines (pdf-paragraphs.js: ink runs a blank stretch apart) a page
// needs before it counts as a table page; with a "Table N" caption 2 suffice.
export const getPdfAutoTableMinRows = () =>
  readPdfAutoThreshold("PDF_AUTO_TABLE_MIN_ROWS", 4, {
    describe: "a positive integer",
    isValid: isPositiveInteger,
  });

// Fewer non-whitespace characters than this, on a page mostly covered by
// images, is a scan or an image-only page.
export const getPdfAutoMinTextChars = () =>
  readPdfAutoThreshold("PDF_AUTO_MIN_TEXT_CHARS", 200, {
    describe: "a non-negative integer",
    isValid: isNonNegativeInteger,
  });

// Share of the page box painted with images (0..1) that, with too little
// text, makes a page an OCR page.
export const getPdfAutoImageCoverage = () =>
  readPdfAutoThreshold("PDF_AUTO_IMAGE_COVERAGE", 0.3, {
    describe: "a number in (0, 1]",
    isValid: isUnitRatio,
  });

// Share of a page's characters that are U+FFFD, private-use or control
// characters (a font without a usable ToUnicode map) that makes its text
// layer unusable, so the page is OCRed instead.
export const getPdfAutoGarbledRatio = () =>
  readPdfAutoThreshold("PDF_AUTO_GARBLED_RATIO", 0.3, {
    describe: "a number in (0, 1]",
    isValid: isUnitRatio,
  });

// Task prefixes some embedding models are trained with and documented as
// required. They are part of the model's input contract, so they apply to the
// real embedding client only, never to a configured stand-in provider. On
// QASPER, nomic-embed-text with its prefixes put the evidence paragraph among
// the QA candidates for 6 more questions in 100 (docs/evaluation.md).
// RAG_EMBEDDING_QUERY_PREFIX / RAG_EMBEDDING_DOCUMENT_PREFIX override the
// table; an empty value turns a prefix off.
const EMBEDDING_TASK_PREFIXES = Object.freeze([
  { document: "search_document: ", pattern: /nomic-embed-text/i, query: "search_query: " },
]);

const findEmbeddingTaskPrefixes = () =>
  EMBEDDING_TASK_PREFIXES.find((entry) => entry.pattern.test(getEmbeddingModel())) ?? null;

export const getEmbeddingQueryPrefix = () =>
  process.env.RAG_EMBEDDING_QUERY_PREFIX ?? findEmbeddingTaskPrefixes()?.query ?? "";

export const getEmbeddingDocumentPrefix = () =>
  process.env.RAG_EMBEDDING_DOCUMENT_PREFIX ?? findEmbeddingTaskPrefixes()?.document ?? "";

// What a stored vector was embedded under: the model, plus the document
// prefix when there is one ("nomic-embed-text#search_document:"). Stores
// record it with each chunk and refuse to rank chunks from another identity,
// the same way they treat another model.
export const getEmbeddingIndexIdentity = () => {
  const prefix = getEmbeddingDocumentPrefix().trim();

  return prefix ? `${getEmbeddingModel()}#${prefix}` : getEmbeddingModel();
};

// A chunk stored before identities were recorded has none; it was embedded
// without a prefix, so it is current only while no prefix applies.
export const isEmbeddingIdentityCurrent = (storedIdentity) =>
  typeof storedIdentity === "string" && storedIdentity
    ? storedIdentity === getEmbeddingIndexIdentity()
    : getEmbeddingIndexIdentity() === getEmbeddingModel();

export const getChatModel = () => process.env.OPENAI_CHAT_MODEL || "gpt-5";

// A second chat model the chat and planner routes fail over to when the primary
// keeps failing with a retriable error. Unset means no failover.
export const getChatFallbackModel = () =>
  String(process.env.OPENAI_CHAT_FALLBACK_MODEL ?? "").trim();

// Per-request timeout for model calls. A timed-out request is retried like a 5xx.
export const getLlmRequestTimeoutMs = () => {
  const parsed = Number(process.env.RAG_LLM_REQUEST_TIMEOUT_MS);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120000;
};

// Client-side protection per model endpoint (see model-call-guard.js).
// Requests in flight per endpoint and model; 0 means no cap.
export const getLlmMaxConcurrency = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_LLM_MAX_CONCURRENCY, 8));

// Document (batch) embeddings -- ingest, index-version builds, reindex. Unset,
// they share the endpoint and model's one guard (one RAG_LLM_MAX_CONCURRENCY
// cap, one circuit; the per-tenant fair queue still keeps a query from waiting
// behind the whole backlog). Set to a number >= 0 they get their own guard lane
// with this cap and its own circuit, so a large ingest cannot take the slots
// query embeddings wait for, and the endpoint may then see both caps in flight
// at once; 0 means no cap for the lane. See resolveModelCallLane.
export const getLlmIngestMaxConcurrency = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_LLM_INGEST_MAX_CONCURRENCY, getLlmMaxConcurrency())
  );

// The most calls one tenant (or the shared system queue) may have waiting for a
// slot of one guard; one more is refused with 429 MODEL_CALL_QUEUE_FULL. 0 (the
// default) leaves the wait queue unbounded.
export const getLlmMaxQueue = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_LLM_MAX_QUEUE, 0));

// Consecutive unavailable errors (5xx, timeouts, connection failures) that open
// the circuit; 0 turns the breaker off.
export const getLlmCircuitFailureThreshold = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_LLM_CIRCUIT_FAILURE_THRESHOLD, 5));

export const getLlmCircuitCooldownMs = () =>
  toPositiveNumber(process.env.RAG_LLM_CIRCUIT_COOLDOWN_MS, 30000);

// Where the circuit breakers, the model concurrency cap and the claim-judge
// cache keep their state. "memory" is per process, right for one instance;
// "redis" shares it across every instance that points at the same REDIS_URL.
export const getSharedStateProvider = () =>
  toChoice(process.env.RAG_SHARED_STATE, "memory", ["memory", "redis"]);

export const getRedisUrl = () =>
  String(process.env.REDIS_URL ?? "").trim() || "redis://127.0.0.1:6379";

// Namespaces the keys so several deployments (or test runs) can share one Redis.
export const getSharedStatePrefix = () =>
  String(process.env.RAG_SHARED_STATE_PREFIX ?? "").trim() || "archive_rag:";

// Per-run ceilings on model usage (see run-usage.js). 0 turns one off; an empty
// value keeps the default, so a blank line in .env cannot silently remove it.
const readRunLimit = (name, fallbackValue) => {
  const rawValue = process.env[name];

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return fallbackValue;
  }

  return toNonNegativeNumber(rawValue, fallbackValue);
};

export const getAgentRunMaxTokens = () =>
  Math.floor(readRunLimit("AGENT_RUN_MAX_TOKENS", 100000));

export const getAgentRunMaxCostUsd = () =>
  readRunLimit("AGENT_RUN_MAX_COST_USD", 0.5);

export const getAgentRunMaxDurationMs = () =>
  Math.floor(readRunLimit("AGENT_RUN_MAX_DURATION_MS", 300000));

// Second opinion on claims the lexical claim check rejects (see
// self-check/claim-judge.js). `off` keeps the lexical verdict alone; `llm` asks
// the chat model, behind deterministic citation and number guards.
// The deterministic prompt-injection screen over retrieved text, file names
// and web results (rag/prompt-injection-screen.js). "off" is a kill switch for
// a false positive in production; an unrecognized value keeps it on.
export const getPromptInjectionScreenMode = () =>
  toChoice(process.env.RAG_INJECTION_SCREEN, "on", ["off", "on"]);

export const getClaimJudgeMode = () =>
  toChoice(process.env.RAG_CLAIM_JUDGE, "off", ["llm", "off"]);

// Planner calls send a JSON Schema response_format. Turn it off only for an
// OpenAI-compatible endpoint that rejects the parameter; the planners then fall
// back to prompt-only JSON and their tolerant parsers.
export const isStructuredOutputEnabled = () =>
  toBoolean(process.env.RAG_STRUCTURED_OUTPUT_ENABLED, true);

export const getPromptVersion = () =>
  toChoice(process.env.RAG_PROMPT_VERSION, "v3", ["v1", "v2", "v3"]);

export const getAgentPlannerRollout = () =>
  toChoice(process.env.AGENT_PLANNER_ROLLOUT, "llm", [
    "configured",
    "deterministic",
    "guarded_llm",
    "llm",
    "shadow",
  ]);

export const getAgentExecutionPlanner = () =>
  toChoice(process.env.AGENT_EXECUTION_PLANNER, "llm", [
    "deterministic",
    "llm",
  ]);

export const getAgentIntentPlanner = () =>
  toChoice(process.env.AGENT_INTENT_PLANNER, "llm", [
    "deterministic",
    "llm",
  ]);

// Which executor runs the custom_skills stage. The typed DAG (`guarded`) is the
// default; the V1 chain stays as the fallback for a graph rejected before any
// node ran, and as an explicit operator opt-out (`off`). Who plans the graph is
// a separate dial: the DAG planner follows AGENT_EXECUTION_PLANNER, and a failed
// LLM plan falls back to the deterministic graph rather than straight to the
// chain.
//
// An unrecognized value resolves to `off`, not to the default: an operator who
// touched this dial and mistyped it was most likely trying to leave the graph,
// and the chain is the narrower path.
export const getAgentSkillGraphRollout = () => {
  const rawValue = process.env.AGENT_SKILL_GRAPH_ROLLOUT;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "guarded";
  }

  return toChoice(rawValue, "off", ["guarded", "off", "shadow"]);
};

// AGENT_RUNTIME used to pick who schedules a guarded custom-Skill graph and a
// guarded v3 unified graph: LangGraph (the default since phase 4 of
// docs/adr/0001-langgraph-runtime.md) or the native scheduler kept as the
// rollback. Phase 6 deleted the native scheduler, so both graphs always run on
// LangGraph and nothing reads this variable to decide anything. It is still
// checked: when a process starts (server.js, and startServiceRole in
// agent-service/role-server.js), when the app services are built
// (createAppServices in app-services.js, so every in-process app refuses,
// evaluation runners that build createApp included), and at every entry that
// schedules a graph on LangGraph (the custom-Skill stage, the v3 unified
// graph's entries and stage, and runExecutionGraphOnLangGraph), which covers
// in-process callers of runAgentRag that build no app, such as the
// evaluation runners. Unset, empty, whitespace or `langgraph` (trimmed, any
// case) pass; any other value -- `native` above all, but also a typo such as
// "lang-graph" -- refuses, because an operator who set it was asking for a
// scheduler that no longer exists, and running LangGraph instead would ignore
// that silently.
export const AGENT_RUNTIME_REMOVED_CODE = "AGENT_RUNTIME_REMOVED";

export const assertAgentRuntimeSupported = (env = process.env) => {
  const rawValue = env?.AGENT_RUNTIME;

  if (typeof rawValue !== "string") {
    return;
  }

  const value = rawValue.trim().toLowerCase();

  if (value === "" || value === "langgraph") {
    return;
  }

  const error = new Error(
    value === "native"
      ? "AGENT_RUNTIME=native was removed (ADR 0001 phase 6): the agent graphs " +
          "always run on LangGraph. Unset AGENT_RUNTIME or set it to langgraph."
      : `AGENT_RUNTIME=${JSON.stringify(rawValue)} is not a runtime: the native ` +
          "scheduler was removed (ADR 0001 phase 6) and langgraph is the only one " +
          "left. Unset AGENT_RUNTIME or set it to langgraph."
  );
  error.code = AGENT_RUNTIME_REMOVED_CODE;
  throw error;
};

// Which scheduler walks the V1 outer execution plan (agent-execution-plan-
// runner.js), and with it which /chat/stream relay the route uses. A dial of
// its own, separate from the graphs' runtime: the phase-3 load test
// (docs/adr/0001-langgraph-runtime.md) measured the outer plan as a LangGraph StateGraph at about
// +1.2 ms CPU per /chat (+29-35% CPU per request, +25% p95 at concurrency 32
// on pgvector with a 0 ms model), because LangChain core builds a RunTree per
// node call and a bare 3-5 node graph already costs 0.38-0.59 ms. The outer
// plan needs neither durable state nor interrupts (its durability is the
// run's persisted steps), so the native loop runs it, and LangGraph runs only
// the graphs that need it (the custom-Skill DAG and the v3 unified graph).
// `langgraph` (rag/langgraph/execution-plan-graph.js and the agent-stream.js
// relay) stays as an experimental opt-in. Phase 5 rewrote it on low-level
// Pregel with the inert built-in stages pruned: +0.28 ms per run in process
// instead of +1.23, but the load test still failed at concurrency 1 (four
// alternating runs: CPU per request 5.68 -> 6.68 ms median, +17.6%; p95
// +13%), so the default stays native.
//
// Anything but `langgraph` (unset, empty, whitespace, a typo) resolves to
// `native`. Phase 4 flipped only the graphs' default, never this one.
export const getAgentOuterPlanRuntime = () =>
  toChoice(process.env.AGENT_OUTER_PLAN_RUNTIME, "native", ["langgraph", "native"]);

// --- AGENT track: heterogeneous v3 unified graph rollout ---------------------
// `off` (default) keeps the V1 outer order. `shadow` plans and validates a v3
// graph beside the V1 answer without executing it. `guarded` executes an
// admitted v3 graph (document primary, evidence check, conditional follow-up,
// Web, built-in and custom Skills, and one approval-gated Capability that
// pauses the graph at its gate) on the same run store, validator/scheduler,
// budget reservation, replay matrix, and finalizer; a graph that breaks an
// admission rule (agent-unified-graph-admission.js) is rejected whole before
// any node runs and the request takes the V1 path instead. An approval
// decision continues the same graph, and startup recovery resumes or
// finalizes a v3 graph, only under `guarded`; with any other value such runs
// wait for an operator. Any unrecognized value still fails closed to `off`.
export const getAgentUnifiedGraphRollout = () =>
  toChoice(process.env.AGENT_UNIFIED_GRAPH_ROLLOUT, "off", [
    "guarded",
    "off",
    "shadow",
  ]);

// Capabilities a v3 graph may call directly (comma-separated ids, default
// none). A trusted operator allowlist, never planner input: each id must also
// be a registered Capability with an explicit graph contract, and an
// approval-gated one still pauses at its gate.
export const getAgentUnifiedGraphCapabilityIds = () =>
  String(process.env.AGENT_UNIFIED_GRAPH_CAPABILITIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
// --- end AGENT track block -------------------------------------------------

// How rag/chunker.js cuts pages into chunks: `structured` (default) keeps
// headings with their section, `simple` cuts fixed windows, `sentence` packs
// whole sentences. An empty or whitespace value is unset; any other value
// fails at ingest (and as the health report's chunking entry) instead of
// silently chunking with structured, as a typo used to.
export const CHUNK_STRATEGIES = Object.freeze(["structured", "simple", "sentence"]);

export const getChunkStrategy = () => {
  const value = String(process.env.RAG_CHUNK_STRATEGY ?? "").trim().toLowerCase() || "structured";

  if (!CHUNK_STRATEGIES.includes(value)) {
    throw new Error(
      `RAG_CHUNK_STRATEGY must be one of ${CHUNK_STRATEGIES.join(", ")}; got "${process.env.RAG_CHUNK_STRATEGY}".`
    );
  }

  return value;
};

// Document RAG runs two independent retrieval routes by default -- pgvector
// cosine search and PostgreSQL full-text search -- and fuses their ranks with
// RRF. `weighted` remains available as an explicit choice; turning hybrid off
// leaves the dense route alone, which is an opt-out, not the baseline.
export const isHybridRetrievalEnabled = () =>
  toBoolean(process.env.RAG_HYBRID_ENABLED, true);

export const getHybridFusionMethod = () =>
  toChoice(process.env.RAG_HYBRID_FUSION, "rrf", ["weighted", "rrf"]);

export const getRrfK = () =>
  toNonNegativeNumber(process.env.RAG_RRF_K, 60);

export const getRetrievalScoringMode = () =>
  (process.env.RAG_RETRIEVAL_SCORING_MODE || "combined").trim().toLowerCase();

// Retrieval route selector. The default, `hybrid`, defers to the hybrid/dense
// behaviour above so the documented production path is byte-for-byte unchanged.
// `dense` and `sparse` force a single route and exist so the evaluation harness
// can measure each arm in isolation (dense-only / sparse-only / hybrid). Unlike a
// fusion or weight knob, mislabelling the route silently corrupts a comparison
// table, so an unknown value fails closed instead of falling back to the default.
export const RETRIEVAL_ROUTE_CHOICES = Object.freeze(["hybrid", "dense", "sparse"]);

export const getRetrievalRoute = () => {
  const rawValue = process.env.RAG_RETRIEVAL_ROUTE;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "hybrid";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!RETRIEVAL_ROUTE_CHOICES.includes(normalizedValue)) {
    throw new Error(
      `RAG_RETRIEVAL_ROUTE must be one of ${RETRIEVAL_ROUTE_CHOICES.join(", ")}. ` +
        `Received "${rawValue}". Refusing to fall back to a different route.`
    );
  }

  return normalizedValue;
};

export const VECTOR_STORE_PROVIDERS = Object.freeze({
  local: "local",
  pgvector: "pgvector",
  qdrant: "qdrant",
});

export const DEFAULT_VECTOR_STORE_PROVIDER = VECTOR_STORE_PROVIDERS.pgvector;

const VECTOR_STORE_PROVIDER_ALLOWLIST = Object.freeze(
  Object.values(VECTOR_STORE_PROVIDERS)
);

/**
 * The vector store provider is a strict allowlist and fails closed. An unknown
 * value used to fall through to the local JSON index, which meant a typo in
 * production quietly moved every chunk into a file on one machine. Now it is a
 * configuration error that health, ingest and search all surface the same way.
 */
export const getVectorStoreProviderConfigStatus = () => {
  const rawValue = process.env.VECTOR_STORE_PROVIDER;
  const configured = hasEnvValue(rawValue);
  const normalizedValue = configured ? rawValue.trim().toLowerCase() : "";
  const valid = !configured || VECTOR_STORE_PROVIDER_ALLOWLIST.includes(normalizedValue);

  return {
    allowedProviders: [...VECTOR_STORE_PROVIDER_ALLOWLIST],
    configured,
    provider: valid
      ? configured
        ? normalizedValue
        : DEFAULT_VECTOR_STORE_PROVIDER
      : null,
    rawValue: configured ? rawValue.trim() : "",
    reason: !valid
      ? "invalid_provider"
      : configured
        ? "env_configured"
        : "default",
    valid,
  };
};

export class VectorStoreProviderConfigError extends Error {
  constructor(status) {
    super(
      `VECTOR_STORE_PROVIDER must be one of ${status.allowedProviders.join(
        ", "
      )}. Received "${status.rawValue}". Refusing to fall back to another provider.`
    );
    this.name = "VectorStoreProviderConfigError";
    this.code = "VECTOR_STORE_PROVIDER_INVALID";
    this.status = 500;
    this.rawValue = status.rawValue;
    this.allowedProviders = status.allowedProviders;
  }
}

export const getVectorStoreProvider = () => {
  const status = getVectorStoreProviderConfigStatus();

  if (!status.valid) {
    throw new VectorStoreProviderConfigError(status);
  }

  return status.provider;
};

export const getDocumentChunksPostgresTable = () =>
  (process.env.DOCUMENT_CHUNKS_POSTGRES_TABLE || "rag_document_chunks").trim();

const KNOWN_EMBEDDING_DIMENSIONS = Object.freeze({
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
});

export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

let embeddingDimensionsOverride = null;

/**
 * Lets an injected embedding provider declare its own dimensionality (the
 * deterministic evaluation provider embeds into 64 dimensions). It is a
 * process-level override so pgvector's fixed-width column and the migration
 * that creates it see the same number the provider actually produces.
 */
export const configureEmbeddingDimensions = (dimensions) => {
  const parsed = Number(dimensions);

  embeddingDimensionsOverride =
    Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const getEmbeddingDimensionsConfigStatus = () => {
  if (embeddingDimensionsOverride) {
    return {
      dimensions: embeddingDimensionsOverride,
      source: "provider_override",
    };
  }

  const rawValue = process.env.RAG_EMBEDDING_DIMENSIONS;

  if (hasEnvValue(rawValue)) {
    const parsed = Number(rawValue);

    if (Number.isInteger(parsed) && parsed > 0) {
      return {
        dimensions: parsed,
        source: "env",
      };
    }
  }

  const modelDimensions = KNOWN_EMBEDDING_DIMENSIONS[getEmbeddingModel()];

  return modelDimensions
    ? {
        dimensions: modelDimensions,
        source: "model",
      }
    : {
        dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
        source: "default",
      };
};

export const getEmbeddingDimensions = () =>
  getEmbeddingDimensionsConfigStatus().dimensions;

// `simple` on purpose: chunk text is pre-tokenized by the same tokenizer the
// local sparse store uses (per-character CJK, lowercase ASCII words, stop words
// removed), so a language-specific stemmer would only diverge the two routes.
export const getPgvectorTextSearchConfig = () =>
  (process.env.RAG_PGVECTOR_TEXT_SEARCH_CONFIG || "simple").trim();

// --- Sparse route scoring (pgvector BM25, migration 029) ---------------------
// `ts_rank_cd` is PostgreSQL's cover-density rank and is never called BM25;
// `bm25` is Okapi BM25 over per-version, per-scope statistics
// (rag/vector-store-pgvector-sparse.js). An unknown value fails closed rather
// than silently scoring with the other one.
export const SPARSE_SCORING_CHOICES = Object.freeze(["ts_rank_cd", "bm25"]);
export const DEFAULT_SPARSE_SCORING = "bm25";

export const getSparseScoring = () => {
  const rawValue = process.env.RAG_SPARSE_SCORING;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return DEFAULT_SPARSE_SCORING;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!SPARSE_SCORING_CHOICES.includes(normalizedValue)) {
    throw new Error(
      `RAG_SPARSE_SCORING must be one of ${SPARSE_SCORING_CHOICES.join(", ")}. Received "${rawValue}".`
    );
  }

  return normalizedValue;
};

// k1 >= 0 (0 ignores term frequency), b in [0, 1]; Robertson's defaults, the
// same the local sparse store (rag/sparse-store.js) scores with.
export const getBm25K1 = () => toNonNegativeNumber(process.env.RAG_BM25_K1, 1.2);

export const getBm25B = () => {
  const value = toNonNegativeNumber(process.env.RAG_BM25_B, 0.75);

  return value <= 1 ? value : 0.75;
};

// Common-term pruning, for either scoring, on searches whose documents hold
// more than 1000 chunks: candidates come from the query terms whose document
// frequency is at most this share of the scope's chunks, and every query term
// still scores them (migration 030). `off`, 0 or a value >= 1 scores every
// chunk that matches any term (exhaustive).
export const DEFAULT_SPARSE_PRUNE_DF_FRACTION = 0.1;

export const getSparsePruneDfFraction = () => {
  const rawValue = String(process.env.RAG_SPARSE_PRUNE_DF_FRACTION ?? "").trim().toLowerCase();

  if (rawValue === "") {
    return DEFAULT_SPARSE_PRUNE_DF_FRACTION;
  }

  if (rawValue === "off" || rawValue === "false") {
    return null;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value)) {
    return DEFAULT_SPARSE_PRUNE_DF_FRACTION;
  }

  return value > 0 && value < 1 ? value : null;
};

// With pruning, a query whose every term is common (one word, or several)
// scores at most this many candidates per pass: the chunks holding every
// common term, then those holding any, each in physical order. `off` or 0
// scores all of them (exhaustive for such a query).
export const DEFAULT_SPARSE_COMMON_TERM_CAP = 2000;

export const getSparseCommonTermCap = () => {
  const rawValue = String(process.env.RAG_SPARSE_COMMON_TERM_CAP ?? "").trim().toLowerCase();

  if (rawValue === "") {
    return DEFAULT_SPARSE_COMMON_TERM_CAP;
  }

  if (rawValue === "off" || rawValue === "false") {
    return null;
  }

  const value = Math.floor(Number(rawValue));

  if (!Number.isFinite(value)) {
    return DEFAULT_SPARSE_COMMON_TERM_CAP;
  }

  return value > 0 ? value : null;
};

export const getPgvectorIndexType = () =>
  toChoice(process.env.RAG_PGVECTOR_INDEX_TYPE, "hnsw", ["hnsw", "ivfflat"]);

// pgvector 0.8+ iterative HNSW scans. The dense route filters by document after
// the index returns its ef_search candidates, so without them a filtered query
// the planner sends through HNSW can come back with fewer than topK rows.
// relaxed_order is the mode pgvector documents for best recall; the store
// restores strict distance order itself. `off` keeps the pre-0.8 statement.
export const PGVECTOR_ITERATIVE_SCAN_MODES = Object.freeze([
  "relaxed_order",
  "strict_order",
  "off",
]);

export const getPgvectorIterativeScan = () =>
  toChoice(
    process.env.RAG_PGVECTOR_ITERATIVE_SCAN,
    "relaxed_order",
    PGVECTOR_ITERATIVE_SCAN_MODES
  );

export const getPgvectorIvfflatLists = () =>
  Math.floor(toPositiveNumber(process.env.RAG_PGVECTOR_IVFFLAT_LISTS, 100));

export const getPgvectorHnswM = () =>
  Math.floor(toPositiveNumber(process.env.RAG_PGVECTOR_HNSW_M, 16));

export const getPgvectorHnswEfConstruction = () =>
  Math.floor(toPositiveNumber(process.env.RAG_PGVECTOR_HNSW_EF_CONSTRUCTION, 64));

/**
 * The retrieval architecture as one public record, used by evaluation reports
 * and health so that "what actually ran" is written down next to the metrics.
 */
export const getRetrievalArchitectureConfig = () => {
  const providerStatus = getVectorStoreProviderConfigStatus();

  return {
    hybridEnabled: isHybridRetrievalEnabled(),
    hybridFusion: getHybridFusionMethod(),
    vectorStoreProvider: providerStatus.valid ? providerStatus.provider : null,
    vectorStoreProviderValid: providerStatus.valid,
  };
};

export const getQdrantUrl = () =>
  process.env.QDRANT_URL || "http://127.0.0.1:6333";

export const getQdrantApiKey = () => process.env.QDRANT_API_KEY || "";

export const getQdrantCollection = () =>
  process.env.QDRANT_COLLECTION || "rag_chunks";

export const getQdrantDistance = () => {
  const configuredDistance = (process.env.QDRANT_DISTANCE || "Cosine").trim();
  const normalizedDistance = configuredDistance.toLowerCase();

  if (normalizedDistance === "dot") {
    return "Dot";
  }

  if (normalizedDistance === "euclid" || normalizedDistance === "euclidean") {
    return "Euclid";
  }

  if (normalizedDistance === "manhattan") {
    return "Manhattan";
  }

  return "Cosine";
};

export const getChunkSize = () =>
  toPositiveNumber(process.env.RAG_CHUNK_SIZE, 900);

export const getChunkOverlap = () =>
  toNonNegativeNumber(process.env.RAG_CHUNK_OVERLAP, 180);

export const getRetrievalTopK = () =>
  Math.floor(toPositiveNumber(process.env.RAG_RETRIEVAL_TOP_K, 6));

export const getSparseRetrievalTopK = () =>
  Math.floor(toPositiveNumber(process.env.RAG_SPARSE_TOP_K, 8));

export const getComparisonTopKPerDoc = () =>
  Math.floor(toPositiveNumber(process.env.RAG_COMPARE_TOP_K_PER_DOC, 3));

export const isRerankEnabled = () =>
  toBoolean(process.env.RAG_RERANK_ENABLED, false);

export const getRerankProvider = () =>
  toChoice(process.env.RAG_RERANK_PROVIDER, "heuristic", [
    "heuristic",
    "custom",
    "cross-encoder",
  ]);

export const getRerankCandidateMultiplier = () =>
  Math.max(
    1,
    Math.floor(toPositiveNumber(process.env.RAG_RERANK_CANDIDATE_MULTIPLIER, 3))
  );

export const getRerankWeight = () =>
  Math.min(1, toNonNegativeNumber(process.env.RAG_RERANK_WEIGHT, 0.6));

export const getCrossEncoderEndpoint = () =>
  process.env.RAG_CROSS_ENCODER_ENDPOINT || "";

export const getCrossEncoderModel = () =>
  process.env.RAG_CROSS_ENCODER_MODEL || "";

export const getCrossEncoderTimeoutMs = () =>
  toPositiveNumber(process.env.RAG_CROSS_ENCODER_TIMEOUT_MS, 30_000);

export const getMaxComparisonSources = () =>
  Math.floor(toPositiveNumber(process.env.RAG_MAX_COMPARISON_SOURCES, 8));

export const getMinRelevanceScore = () =>
  toPositiveNumber(process.env.RAG_MIN_RELEVANCE_SCORE, 0.32);

export const getVectorWeight = () =>
  toPositiveNumber(process.env.RAG_VECTOR_WEIGHT, 0.82);

export const getHybridDenseWeight = () =>
  toNonNegativeNumber(process.env.RAG_HYBRID_DENSE_WEIGHT, 0.65);

export const getHybridSparseWeight = () =>
  toNonNegativeNumber(process.env.RAG_HYBRID_SPARSE_WEIGHT, 0.35);

export const getKeywordWeight = () =>
  toPositiveNumber(process.env.RAG_KEYWORD_WEIGHT, 0.18);

// Query-term coverage floor for comparison answers (see rag/confidence.js,
// which also lets dense similarity bypass it there).
export const getMinQueryTermCoverage = () =>
  Math.min(1, toPositiveNumber(process.env.RAG_MIN_QUERY_TERM_COVERAGE, 0.51));

// The same floor for single-document QA, split out so a deployment can set it
// on its own. On QASPER (evaluation/run-abstention-gate-analysis.mjs) it
// rejects answerable and unanswerable questions at nearly the same rate,
// because a question worded differently from the paper fails a lexical test
// whether or not the paper answers it, and lowering it to 0.2 would cut the
// expected cost there by a third. The default stays 0.51 anyway: every value
// at or below 0.5 also admits the adjacent-topic chunks the behaviour tests
// guard against ("parental leave" answered from an annual-leave clause,
// "amber ceiling" citing the cobalt one). See docs/evaluation.md.
export const DEFAULT_MIN_QA_QUERY_TERM_COVERAGE = 0.51;

export const getMinQaQueryTermCoverage = () =>
  Math.min(
    1,
    toPositiveNumber(process.env.RAG_MIN_QA_QUERY_TERM_COVERAGE, DEFAULT_MIN_QA_QUERY_TERM_COVERAGE)
  );

// The QA answer model's own abstention (answer-verdict.js): the QA prompt asks
// it to open with NOT_IN_EVIDENCE: when the evidence does not answer, and the
// reply becomes an abstention. Off by default: with qwen2.5:7b, even with the
// deeper-retrieval retry, QASPER dev caught fewer unanswerable questions (85%
// -> 70%) at flat answer F1, which fails the pre-declared cost rule. See
// docs/evaluation.md.
export const isQaAnswerVerdictEnabled = () =>
  toBoolean(process.env.RAG_QA_ANSWER_VERDICT, false);

// RAG_QA_VERDICT_OVERRIDE (off | supported; default off; only read while
// RAG_QA_ANSWER_VERDICT is on). With "supported", a reply that opens with
// NOT_IN_EVIDENCE: is still answered when the text after the marker, with its
// evidence-absence hedges removed, holds at least one cited factual claim and
// every factual claim passes the lexical claim check; the claims must name
// every anchor and name of the question, one claim must carry the answer,
// and neither they nor the evidence they cite may swap a query word for a
// rival; a question the decomposer split into parts is never overridden
// (answer-verdict-override.js). The LLM claim judge is never asked. Any other
// value is off.
export const QA_VERDICT_OVERRIDE_MODES = Object.freeze(["off", "supported"]);

export const getQaVerdictOverrideMode = () =>
  String(process.env.RAG_QA_VERDICT_OVERRIDE ?? "").trim().toLowerCase() === "supported"
    ? "supported"
    : "off";

// ---------------------------------------------------------------------------
// Answer-rate flags. Each is off by default and changes one thing, so an
// evaluation can turn them on one at a time and together.
//
// AGENT_FOLLOW_UP_ORIGINAL_QUESTION: the agent's follow-up retrieval asks the
// answer model the primary call's resolved question instead of the
// "Re-check the uploaded documents..." meta text; the evidence gaps go only into
// the follow-up retrieval queries; the follow-up call skips the session-memory
// rewrite; and its QA gate measures query-term coverage against that question
// rather than against whichever retrieval query a candidate came from.
export const isAgentFollowUpOriginalQuestionEnabled = () =>
  toBoolean(process.env.AGENT_FOLLOW_UP_ORIGINAL_QUESTION, false);

// RAG_QA_GATE_INFLECTION: the single-document QA gate also counts a query word
// as covered when the chunk has an inflected form of it ("governs" against
// "governed", "metrics" against "metric"; rag/inflection.js). Anchors and
// numbers stay exact. Comparison and the rerank gate are unchanged.
export const isQaGateInflectionEnabled = () =>
  toBoolean(process.env.RAG_QA_GATE_INFLECTION, false);

// RAG_CLAIM_INFLECTION: the lexical claim check accepts an inflected form of a
// claim word in its evidence. Numbers, anchors, polarity, modality, relation
// order and attribution checks are unchanged.
export const isClaimInflectionEnabled = () =>
  toBoolean(process.env.RAG_CLAIM_INFLECTION, false);

// RAG_CLAIM_HEADING_CONTEXT: the lexical claim check also reads each evidence
// sentence under a section heading of the cited chunk with the heading's title
// in front ("Limitation of Liability: The total liability ..."), so a claim
// that names the section it answers from can be supported. Heading numbers are
// dropped; see buildHeadingScopedSupportSentences in self-check/attribution.js.
export const isClaimHeadingContextEnabled = () =>
  toBoolean(process.env.RAG_CLAIM_HEADING_CONTEXT, false);

// RAG_CLAIM_SOURCE_INHERITANCE: an answer sentence with no [Source N] label
// takes the labels of the nearest labelled sentence in the same line (the
// next one, else the previous one) before it is checked. The check itself is
// unchanged; a sentence in a line with no label still has no source.
export const isClaimSourceInheritanceEnabled = () =>
  toBoolean(process.env.RAG_CLAIM_SOURCE_INHERITANCE, false);

// RAG_CLAIM_JUDGE_TEMPERATURE: sampling temperature sent with the claim judge's
// request. Unset (default) sends none, so the server's default applies.
export const getClaimJudgeTemperature = () => {
  const rawValue = process.env.RAG_CLAIM_JUDGE_TEMPERATURE;

  if (!hasEnvValue(rawValue)) {
    return null;
  }

  const parsedValue = Number(rawValue);

  return Number.isFinite(parsedValue) && parsedValue >= 0 && parsedValue <= 2
    ? parsedValue
    : null;
};

// AGENT_SINGLE_DOCUMENT_ROUTING: the deterministic intent rules stop sending
// single-document questions to a Skill on incidental wording (comparison words
// with one selected document and no other document named, "sequence" inside a
// hyphenated name, "this study"); see agent-intent-rules.js.
export const isAgentSingleDocumentRoutingEnabled = () =>
  toBoolean(process.env.AGENT_SINGLE_DOCUMENT_ROUTING, false);

/** The answer-rate flags as an evaluation report records them. */
export const describeAnswerRateFlags = () => ({
  agentFollowUpOriginalQuestion: isAgentFollowUpOriginalQuestionEnabled(),
  agentSingleDocumentRouting: isAgentSingleDocumentRoutingEnabled(),
  claimHeadingContext: isClaimHeadingContextEnabled(),
  claimInflection: isClaimInflectionEnabled(),
  claimJudgeTemperature: getClaimJudgeTemperature(),
  claimSourceInheritance: isClaimSourceInheritanceEnabled(),
  qaGateInflection: isQaGateInflectionEnabled(),
  qaVerdictOverride: getQaVerdictOverrideMode(),
});

// ---------------------------------------------------------------------------
// Semantic answer cache (rag/semantic-cache.js). Opt-in: RAG_SEMANTIC_CACHE=on
// serves a stored document RAG answer to a later question of the same tenant,
// doc set, document versions, index version, query adapter, prompts, chat
// model and answer mode whose query embedding clears
// RAG_SEMANTIC_CACHE_THRESHOLD and whose words match almost exactly
// (rag/semantic-cache-guard.js). Any other value keeps it off.
// ---------------------------------------------------------------------------
export const DEFAULT_SEMANTIC_CACHE_THRESHOLD = 0.97;

export const isSemanticCacheEnabled = () =>
  ["1", "true", "on", "yes", "memory"].includes(
    String(process.env.RAG_SEMANTIC_CACHE ?? "").trim().toLowerCase()
  );

// Cosine similarity of the query embeddings, in (0, 1]; anything else falls
// back to the default rather than admitting every question.
export const getSemanticCacheThreshold = () => {
  const value = Number(process.env.RAG_SEMANTIC_CACHE_THRESHOLD);

  return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_SEMANTIC_CACHE_THRESHOLD;
};

export const getSemanticCacheMaxEntries = () =>
  Math.floor(toPositiveNumber(process.env.RAG_SEMANTIC_CACHE_MAX_ENTRIES, 500)) || 500;

// Bytes of stored responses (their JSON), least recently used out first; an
// answer larger than the whole budget is not stored.
export const DEFAULT_SEMANTIC_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export const getSemanticCacheMaxBytes = () =>
  Math.floor(toPositiveNumber(process.env.RAG_SEMANTIC_CACHE_MAX_BYTES, DEFAULT_SEMANTIC_CACHE_MAX_BYTES)) ||
  DEFAULT_SEMANTIC_CACHE_MAX_BYTES;

// 0 keeps an entry until the LRU bound or an invalidation removes it.
export const getSemanticCacheTtlMs = () =>
  String(process.env.RAG_SEMANTIC_CACHE_TTL_MS ?? "").trim() === ""
    ? 60 * 60 * 1000
    : Math.floor(toNonNegativeNumber(process.env.RAG_SEMANTIC_CACHE_TTL_MS, 60 * 60 * 1000));

// With the verdict on, single-document QA also admits a chunk whose coverage
// lies between this floor and the one above, unless a query term was replaced
// in it by a rival on the same head word ("parental leave" -> "annual leave");
// see findQueryTermSubstitution in confidence.js. The band admits chunks the
// lexical gate cannot vouch for, so it opens only when the answer model can
// refuse. A value at or above the QA coverage floor turns it off.
export const DEFAULT_QA_PARTIAL_COVERAGE_FLOOR = 0.3;

// With cross-encoder reranking on, single-document QA decides whether to
// answer from the reranker's relevance probability instead of query-term
// coverage (confidence.js). "0" or "off" keeps the lexical gate. Applies only
// to results that carry a cross-encoder score, so without the reranker, or
// when a rerank failed, the lexical gate decides as before.
//
// 0.02 is what the lexical floor's pre-declared rule (a wrong answer costs
// three refusals, lowest cost within 0.01, most conservative) picked on
// QASPER train (bge-reranker-v2-m3; reranker AUC 0.64 against coverage 0.59).
// On dev it cut refused answerable questions 37.8% -> 13.9% at unchanged
// answer F1 (+0.005 [-0.039, +0.048]), but caught 45% of unanswerable
// questions instead of 80%. See docs/evaluation.md.
export const DEFAULT_QA_MIN_RERANK_PROBABILITY = 0.02;

export const getQaMinRerankProbability = () => {
  const rawValue = process.env.RAG_QA_MIN_RERANK_PROBABILITY;

  if (rawValue === undefined || String(rawValue).trim() === "") {
    return DEFAULT_QA_MIN_RERANK_PROBABILITY;
  }

  const value = Number(rawValue);

  return Number.isFinite(value) && value > 0 && value <= 1 ? value : null;
};

// What the rerank service returns: raw `logits` (this repo's endpoint, the
// sentence-transformers model output) or `probabilities` (Hugging Face TEI's
// default). The gate compares a probability.
export const getCrossEncoderScoreScale = () =>
  String(process.env.RAG_CROSS_ENCODER_SCORES ?? "").trim().toLowerCase() === "probabilities"
    ? "probabilities"
    : "logits";

// With the verdict on, a NOT_IN_EVIDENCE reply triggers one more retrieval
// this deep; the chunks the model has not seen yet that pass the gate get one
// more answer attempt. The model mostly refuses when the retrieved context
// lacks the evidence (70% of its QASPER refusals), not when the paper does.
// 0 turns the retry off.
export const DEFAULT_QA_VERDICT_RETRY_TOP_K = 18;

export const getQaVerdictRetryTopK = () => {
  const rawValue = process.env.RAG_QA_VERDICT_RETRY_TOP_K;

  return rawValue === undefined || String(rawValue).trim() === ""
    ? DEFAULT_QA_VERDICT_RETRY_TOP_K
    : Math.floor(toNonNegativeNumber(rawValue, DEFAULT_QA_VERDICT_RETRY_TOP_K));
};

export const getQaPartialCoverageFloor = () =>
  Math.min(
    1,
    toPositiveNumber(process.env.RAG_QA_PARTIAL_COVERAGE_FLOOR, DEFAULT_QA_PARTIAL_COVERAGE_FLOOR)
  );

export const isQueryDecompositionEnabled = () =>
  toBoolean(process.env.RAG_QUERY_DECOMPOSITION_ENABLED, true);

export const getMaxQueryRequirements = () =>
  Math.floor(toPositiveNumber(process.env.RAG_QUERY_DECOMPOSITION_MAX_REQUIREMENTS, 4));

export const isNearDuplicateGuardEnabled = () =>
  toBoolean(process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED, true);

// RAG_COMPARISON_STRUCTURED_OUTPUT (default off): the comparison answer model
// returns, per aspect on which the documents differ, one verbatim quote per
// document with the Source number it came from, and the server renders the
// answer from the evidence sentences those quotes resolve to (answer-writer.js).
// The comparison gate then checks the rendered answer exactly as it checks a
// prose answer. Off, the comparison call is byte-identical to before.
export const isComparisonStructuredOutputEnabled = () =>
  toBoolean(process.env.RAG_COMPARISON_STRUCTURED_OUTPUT, false);

export const isRagObservabilityEnabled = () =>
  toBoolean(process.env.RAG_OBSERVABILITY_ENABLED, false);

export const shouldIncludeRagObservabilityContext = () =>
  toBoolean(process.env.RAG_OBSERVABILITY_INCLUDE_CONTEXT, false);

const getLlmOpsMaxTokensPerEvent = () => {
  const value = toNonNegativeNumber(
    process.env.RAG_LLMOPS_MAX_TOKENS_PER_EVENT,
    null
  );

  return value === null ? null : Math.floor(value);
};

export const getLlmOpsPolicy = () => ({
  alerts: {
    budgetExceeded: toBoolean(
      process.env.RAG_LLMOPS_ALERT_BUDGET_EXCEEDED,
      true
    ),
    errorStatus: toBoolean(process.env.RAG_LLMOPS_ALERT_ERRORS, true),
    estimatedUsage: toBoolean(
      process.env.RAG_LLMOPS_ALERT_ESTIMATED_USAGE,
      false
    ),
    latencySloBreach: toBoolean(
      process.env.RAG_LLMOPS_ALERT_LATENCY_SLO,
      true
    ),
    pricingUnavailable: toBoolean(
      process.env.RAG_LLMOPS_ALERT_PRICING_UNAVAILABLE,
      false
    ),
  },
  budget: {
    maxEstimatedCostUsdPerEvent: toNonNegativeNumber(
      process.env.RAG_LLMOPS_MAX_COST_USD_PER_EVENT,
      null
    ),
    maxTotalTokensPerEvent: getLlmOpsMaxTokensPerEvent(),
  },
  enabled: toBoolean(process.env.RAG_LLMOPS_POLICY_ENABLED, true),
  enforcementMode: toChoice(process.env.RAG_LLMOPS_ENFORCEMENT_MODE, "record", [
    "block",
    "record",
  ]),
});

export const getPostgresDatabaseUrl = () =>
  process.env.POSTGRES_DATABASE_URL || process.env.LONG_MEMORY_DATABASE_URL || "";

export const isPostgresDatabaseConfigured = () =>
  Boolean(getPostgresDatabaseUrl().trim());

export const getLongMemoryConfigStatus = () => {
  const postgresConfigured = isPostgresDatabaseConfigured();
  const explicitlyConfigured = hasEnvValue(process.env.RAG_LONG_MEMORY_ENABLED);
  const enabled = toBoolean(
    process.env.RAG_LONG_MEMORY_ENABLED,
    postgresConfigured
  );

  return {
    enabled,
    explicit: explicitlyConfigured,
    postgresConfigured,
    reason: enabled
      ? explicitlyConfigured
        ? "env_enabled"
        : "postgres_configured_default"
      : explicitlyConfigured
        ? "env_disabled"
        : "postgres_not_configured",
  };
};

export const isLongMemoryEnabled = () =>
  getLongMemoryConfigStatus().enabled;

// LONG_MEMORY_SCOPE (rag/long-memory.js). `user` (default): a user's notes,
// preferences and agent experience follow the user into every workspace, as
// before migration 045. `workspace`: notes and agent experience are stored in
// and read from the active workspace only; the fixed-enum preferences (reply
// language, answer style) stay user-level. An unknown value refuses the start,
// never falls back to `user`.
export const LONG_MEMORY_SCOPES = Object.freeze(["user", "workspace"]);

export const getLongMemoryScope = () => {
  const rawValue = process.env.LONG_MEMORY_SCOPE;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "user";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!LONG_MEMORY_SCOPES.includes(normalizedValue)) {
    const error = new Error(
      `LONG_MEMORY_SCOPE must be one of ${LONG_MEMORY_SCOPES.join(", ")}. Received "${rawValue}".`
    );

    error.code = "LONG_MEMORY_SCOPE_INVALID";
    error.status = 500;
    throw error;
  }

  return normalizedValue;
};

export const isLongMemoryWorkspaceScoped = () => getLongMemoryScope() === "workspace";

export const getAgentExperienceMemoryConfigStatus = () => {
  const longMemory = getLongMemoryConfigStatus();
  const explicitlyConfigured = hasEnvValue(
    process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED
  );
  const requested = toBoolean(
    process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED,
    longMemory.enabled
  );
  const enabled = requested && longMemory.enabled;

  return {
    enabled,
    explicit: explicitlyConfigured,
    longMemoryEnabled: longMemory.enabled,
    postgresConfigured: longMemory.postgresConfigured,
    requested,
    reason: enabled
      ? explicitlyConfigured
        ? "env_enabled"
        : "postgres_configured_default"
      : explicitlyConfigured && !requested
        ? "env_disabled"
        : requested && !longMemory.enabled
          ? "long_memory_disabled"
          : longMemory.reason,
  };
};

export const isAgentExperienceMemoryEnabled = () =>
  getAgentExperienceMemoryConfigStatus().enabled;

// TLS on or off; how the certificate is checked is POSTGRES_SSL_MODE
// (rag/postgres-tls.js).
export const isPostgresSslEnabled = (env = process.env) =>
  toBoolean(
    env.POSTGRES_SSL_ENABLED,
    toBoolean(env.LONG_MEMORY_POSTGRES_SSL_ENABLED, false)
  );

// Row-level security: "enforce" runs every query issued for a scoped request or
// task under the tenant role, so PostgreSQL rejects rows outside the caller's
// user/workspace even when a query forgets its WHERE clause. "off" keeps the
// owner connection (policies stay installed but the owner bypasses them). An
// unrecognized value fails closed to "enforce".
export const getPostgresRowLevelSecurityMode = () =>
  toChoice(process.env.POSTGRES_ROW_LEVEL_SECURITY, "enforce", ["enforce", "off"]);

// What a statement does when its call chain is bound to nothing at all (no
// request middleware, task, system or tenant binding; rag/postgres-tenant.js).
// `lenient` (default) runs it as the owner, as always; `strict` refuses it
// with ARCHIVE_RAG_TENANT_CONTEXT_MISSING while row-level security is
// enforced, so a lost AsyncLocalStorage context fails closed instead of
// silently bypassing the policies. An unknown value refuses, never falls back
// to the weaker mode.
export const POSTGRES_TENANT_CONTEXT_MODES = Object.freeze(["lenient", "strict"]);

export const getPostgresTenantContextMode = () => {
  const rawValue = process.env.POSTGRES_TENANT_CONTEXT;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "lenient";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!POSTGRES_TENANT_CONTEXT_MODES.includes(normalizedValue)) {
    throw new Error(
      `POSTGRES_TENANT_CONTEXT must be one of ${POSTGRES_TENANT_CONTEXT_MODES.join(", ")}. Received "${rawValue}".`
    );
  }

  return normalizedValue;
};

// PostgreSQL keeps these in a 32-bit integer of milliseconds; a larger value
// would make set_config fail on every tenant statement, so it is clamped.
const MAX_POSTGRES_INTERVAL_MS = 2_147_483_647;

const toPostgresIntervalMs = (rawValue) =>
  Math.min(MAX_POSTGRES_INTERVAL_MS, Math.floor(toNonNegativeNumber(rawValue, 0)));

// The primary pool (rag/postgres.js). node-pg's own defaults: 10 connections,
// and no bound on the wait for one (0), which is also the wait for a pool
// slot when every connection is busy. Read replicas have their own pool
// settings (POSTGRES_READ_REPLICA_POOL_MAX, ..._CONNECT_TIMEOUT_MS).
export const getPostgresPoolMax = () =>
  Math.max(1, Math.floor(toPositiveNumber(process.env.POSTGRES_POOL_MAX, 10)));

export const getPostgresConnectionTimeoutMs = () =>
  toPostgresIntervalMs(process.env.POSTGRES_CONNECTION_TIMEOUT_MS);

// statement_timeout and idle_in_transaction_session_timeout for tenant work
// only: each tenant statement and tenant transaction sets them transaction-
// locally in the same step as the tenant settings. 0 (default) leaves the
// server's own value in force. Owner work (migrations, index builds, recovery
// scans) never gets them.
export const getPostgresStatementTimeoutMs = () =>
  toPostgresIntervalMs(process.env.POSTGRES_STATEMENT_TIMEOUT_MS);

export const getPostgresIdleInTransactionTimeoutMs = () =>
  toPostgresIntervalMs(process.env.POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS);

// The operator's acknowledgement that POSTGRES_ROW_LEVEL_SECURITY=off is meant
// while API auth separates tenants: without it the health check reports that
// combination as an error, because every scoped query then runs as the owner
// and only the stores' own WHERE clauses keep tenants apart. Only the literal
// "true" (any case) counts, so a stray "1" or "yes" cannot silence the error.
export const isPostgresRowLevelSecurityOffConfirmed = () =>
  String(process.env.POSTGRES_ROW_LEVEL_SECURITY_OFF_CONFIRMED ?? "")
    .trim()
    .toLowerCase() === "true";

const POSTGRES_ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export const getPostgresTenantRole = () => {
  const role = String(process.env.POSTGRES_TENANT_ROLE ?? "").trim() || "archive_rag_tenant";

  if (!POSTGRES_ROLE_NAME_PATTERN.test(role)) {
    throw new Error(
      `POSTGRES_TENANT_ROLE must be a lowercase PostgreSQL identifier of at most 63 bytes. Received "${role}".`
    );
  }

  return role;
};

// The database role split (tenant isolation phase 2). POSTGRES_MIGRATION_
// DATABASE_URL is an owner login: migrations and every DDL the application
// runs (index version tables, their drops, an empty table's resize) use a
// pool of their own on it. Set, it turns the split on, and POSTGRES_DATABASE_
// URL is then a runtime login that owns nothing: tenant statements switch into
// POSTGRES_TENANT_ROLE as before, system and unscoped statements into
// POSTGRES_SYSTEM_ROLE, and a statement bound to no context runs as the
// runtime login itself, which holds no table privilege and fails closed.
// Unset (the default), one pool logs in as the owner, exactly as before.
// Whitespace counts as unset.
export const getPostgresMigrationDatabaseUrl = () =>
  String(process.env.POSTGRES_MIGRATION_DATABASE_URL ?? "").trim();

export const isPostgresRoleSplitEnabled = () => Boolean(getPostgresMigrationDatabaseUrl());

// The NOLOGIN role system work runs as under the split (migration 035): every
// application table's privileges the owner path uses, and a permissive
// system_access policy (USING (true)) on every table under row-level security,
// so it sees every tenant's rows without owning anything. Migration 035 creates
// it whether or not the split is on. Validated like POSTGRES_TENANT_ROLE, and
// it must differ from it: a system statement that switched into the tenant role
// would see no row at all.
export const getPostgresSystemRole = () => {
  const role = String(process.env.POSTGRES_SYSTEM_ROLE ?? "").trim() || "archive_rag_system";

  if (!POSTGRES_ROLE_NAME_PATTERN.test(role)) {
    throw new Error(
      `POSTGRES_SYSTEM_ROLE must be a lowercase PostgreSQL identifier of at most 63 bytes. Received "${role}".`
    );
  }

  if (role === getPostgresTenantRole()) {
    throw new Error(`POSTGRES_SYSTEM_ROLE must differ from POSTGRES_TENANT_ROLE (both are "${role}").`);
  }

  return role;
};

export const getLongMemoryDatabaseUrl = () =>
  getPostgresDatabaseUrl();

export const getLongMemoryPostgresTable = () =>
  (process.env.LONG_MEMORY_POSTGRES_TABLE || "long_memory_items").trim();

export const isLongMemoryPostgresSslEnabled = () =>
  isPostgresSslEnabled();

export const getDocumentsPostgresTable = () =>
  (process.env.DOCUMENTS_POSTGRES_TABLE || "rag_documents").trim();

// Upload ingestion. `sync` (default) parses, embeds and indexes inside the
// upload request, which answers 201 with the document. `async` validates the
// upload, stores its bytes in an ingest job and answers 202; a worker claims the
// job and runs the same ingest (rag/ingest-worker.js). An unknown value keeps
// the synchronous behaviour, which the frontend handles either way.
export const RAG_INGEST_MODES = Object.freeze(["sync", "async"]);

export const getRagIngestMode = () =>
  toChoice(process.env.RAG_INGEST_MODE, "sync", RAG_INGEST_MODES);

export const isRagIngestAsync = () => getRagIngestMode() === "async";

// Every API process also runs a worker loop unless this is false, which is how
// ingestion moves to dedicated `npm run worker:ingest` processes.
export const isRagIngestWorkerEnabled = () =>
  toBoolean(process.env.RAG_INGEST_WORKER_ENABLED, true);

export const getRagIngestWorkerConcurrency = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_WORKER_CONCURRENCY, 2)) || 1;

// How long an idle worker loop sleeps before it looks at the queue again. An
// enqueue wakes idle loops at once (in this process directly, in other worker
// processes through PostgreSQL NOTIFY), so this only bounds how late a job is
// picked up when that wake-up is lost: a dropped LISTEN connection, a retry
// whose backoff has run out, a lease that expired.
export const getRagIngestWorkerPollMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_WORKER_POLL_MS, 1000)) || 1000;

// Renewed while a job runs; a worker that stops renewing loses the job to the
// next claim once the lease has expired.
export const getRagIngestJobLeaseMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_JOB_LEASE_MS, 60000)) || 60000;

export const getRagIngestJobMaxAttempts = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_JOB_MAX_ATTEMPTS, 3)) || 3;

// A 202 costs the client about a second, so without a cap one tenant could
// queue unbounded bytes. Counted over the tenant's queued and running jobs;
// an upload over either cap answers 429. 0 disables a cap.
export const getRagIngestMaxPendingJobsPerTenant = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT, 50));

export const getRagIngestMaxPendingBytesPerTenant = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_INGEST_MAX_PENDING_BYTES_PER_TENANT, 1024 * 1024 * 1024)
  );

// The same caps over a whole workspace (every user's queued and running jobs
// in it), checked in addition to the per-tenant ones for a job that names a
// workspace. 0 (default) disables a cap.
export const getRagIngestMaxPendingJobsPerWorkspace = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_INGEST_MAX_PENDING_JOBS_PER_WORKSPACE, 0));

export const getRagIngestMaxPendingBytesPerWorkspace = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_INGEST_MAX_PENDING_BYTES_PER_WORKSPACE, 0));

// Storage quotas (rag/tenant-storage-quota.js): the documents a workspace
// holds (every user's), or for a scope without a workspace the user's own
// workspace-less documents, counted and summed by stored file size. Checked
// when a document is committed (rag/index.js commitDocument) and early at
// upload time. 0 (default) means no limit.
export const getTenantMaxDocuments = () =>
  Math.floor(toNonNegativeNumber(process.env.TENANT_MAX_DOCUMENTS, 0));

export const getTenantMaxDocumentBytes = () =>
  Math.floor(toNonNegativeNumber(process.env.TENANT_MAX_DOCUMENT_BYTES, 0));

// Background agent tasks per tenant (the task's exact user and workspace
// pair, the unit the task store and its row policy use). Over the queued cap
// a new task is refused (429 TENANT_TASK_LIMITED); over the running cap a
// task stays queued until one of the tenant's tasks finishes. 0 (default)
// disables a cap.
export const getTenantMaxRunningTasks = () =>
  Math.floor(toNonNegativeNumber(process.env.TENANT_MAX_RUNNING_TASKS, 0));

export const getTenantMaxQueuedTasks = () =>
  Math.floor(toNonNegativeNumber(process.env.TENANT_MAX_QUEUED_TASKS, 0));

// The tenant usage ledger (rag/tenant-usage.js, migration 037): hourly
// aggregates per tenant, flushed asynchronously every TENANT_USAGE_FLUSH_MS,
// so it adds no statement to a request. On by default; it does nothing
// without a database. Only "off", "false", "0" and "no" turn it off.
export const isTenantUsageLedgerEnabled = () =>
  toBoolean(process.env.TENANT_USAGE_LEDGER, true);

export const getTenantUsageFlushMs = () =>
  Math.min(
    Math.floor(toPositiveNumber(process.env.TENANT_USAGE_FLUSH_MS, 60_000)) || 60_000,
    2 ** 31 - 1
  );

export const getTenantUsagePostgresTable = () =>
  String(process.env.TENANT_USAGE_POSTGRES_TABLE ?? "").trim() || "tenant_usage";

// Chunked upload sessions (upload-session-store.js) hold their chunks on disk
// until they are completed or expire (UPLOAD_SESSION_TTL_MS), so without a cap
// one tenant could open sessions until the disk is full. Counted per (user,
// workspace) over the sessions it has open, the declared fileSize summed; a
// POST /upload/init over either cap answers 429. 0 disables a cap. A session
// being resumed is never refused.
// Defaults sit well above what the workbench sends at once (it opens one
// chunked session per dropped PDF, all in parallel), so a bulk drop of a few
// dozen files still uploads while a runaway client is bounded.
export const getUploadSessionMaxPerTenant = () =>
  Math.floor(toNonNegativeNumber(process.env.UPLOAD_SESSION_MAX_PER_TENANT, 200));

export const getUploadSessionMaxBytesPerTenant = () =>
  Math.floor(
    toNonNegativeNumber(process.env.UPLOAD_SESSION_MAX_BYTES_PER_TENANT, 10 * 1024 * 1024 * 1024)
  );

// How often a running API process sweeps expired upload sessions (it also
// sweeps once at start-up). 0 keeps the start-up sweep only. Capped at the
// largest delay setInterval accepts (about 24.8 days); a larger value would
// make Node fire the timer at once and on every millisecond after.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export const getUploadSessionCleanupIntervalMs = () =>
  Math.min(
    Math.floor(toNonNegativeNumber(process.env.UPLOAD_SESSION_CLEANUP_INTERVAL_MS, 15 * 60 * 1000)),
    MAX_TIMER_DELAY_MS
  );

// /chat and /chat/stream input bounds (routes/chat.js; also checked at the
// edge of a split deployment before forwarding). The JSON body is already
// capped at 2 MB; these keep one request from carrying a question or a
// document list the rest of the pipeline was never sized for. Lengths are
// JavaScript string lengths (UTF-16 code units), measured after trimming.
// The frontend sends every active document of the workspace, so the docIds
// cap has no default in a process that retrieves itself (a large monolith
// workspace kept chatting before the cap existed); with RETRIEVAL_SERVICE_URL
// it defaults to RETRIEVAL_SERVICE_MAX_DOC_IDS' 1000, which the retrieval tier
// refuses past anyway, and so it does with AGENT_SERVICE_URL: an api edge
// forwards /chat to an agent tier whose own default (it retrieves through the
// retrieval tier) is 1000, so the edge refuses what the agent tier would, as
// a 400 of its own, instead of forwarding it. CHAT_MAX_DOC_IDS sets it
// everywhere, 0 = no limit. A request past a limit is answered 400.
export const getChatMaxQuestionChars = () =>
  Math.floor(toPositiveNumber(process.env.CHAT_MAX_QUESTION_CHARS, 8000));

export const getChatMaxDocIds = () => {
  const splitDefault =
    String(process.env.RETRIEVAL_SERVICE_URL ?? "").trim() || String(process.env.AGENT_SERVICE_URL ?? "").trim()
      ? 1000
      : 0;

  return Math.floor(toNonNegativeNumber(process.env.CHAT_MAX_DOC_IDS, splitDefault));
};

// The longest docId (each entry of docIds, or docId) and sessionId accepted.
export const getChatMaxIdChars = () =>
  Math.floor(toPositiveNumber(process.env.CHAT_MAX_ID_CHARS, 256));

// The task, trigger and agent-run routes (routes/tasks.js, checked at the edge
// too) take the question and id limits above, and bound every free-form JSON
// they persist or hand on (an action's payload, a trigger's event and input,
// an agent task's preferences) by its serialized size: at most
// TASK_MAX_PAYLOAD_BYTES UTF-8 bytes (default 256 KiB, 0 = no limit; the
// parser's 2 MB still applies). An agent task's docIds are bounded as /chat's
// are and do not count toward it.
export const getTaskMaxPayloadBytes = () =>
  Math.floor(toNonNegativeNumber(process.env.TASK_MAX_PAYLOAD_BYTES, 262144));

// --- Per-tenant HTTP limits (rag/tenant-limits.js) ---------------------------
// Counted after API auth, per tenant (the workspace, else the user, else the
// client IP for a scope naming neither) and per cost class. Off by default;
// the per-class maxima only matter once TENANT_RATE_LIMIT_ENABLED is on, and
// sit well above what one workspace's workbench sends (a chunked upload sends
// one request per 2 MB chunk). 0 turns one class's limit off.
export const isTenantRateLimitEnabled = () =>
  toBoolean(process.env.TENANT_RATE_LIMIT_ENABLED, false);

// Fixed windows: every class of every tenant restarts at the same boundary
// (multiples of the window since the epoch), on every instance.
export const getTenantRateLimitWindowMs = () =>
  Math.max(1, Math.floor(toPositiveNumber(process.env.TENANT_RATE_LIMIT_WINDOW_MS, 60 * 1000)));

export const getTenantRateLimits = () => ({
  chat: Math.floor(toNonNegativeNumber(process.env.TENANT_RATE_LIMIT_CHAT_MAX, 120)),
  default: Math.floor(toNonNegativeNumber(process.env.TENANT_RATE_LIMIT_DEFAULT_MAX, 1200)),
  destructive: Math.floor(
    toNonNegativeNumber(process.env.TENANT_RATE_LIMIT_DESTRUCTIVE_MAX, 60)
  ),
  ingest: Math.floor(toNonNegativeNumber(process.env.TENANT_RATE_LIMIT_INGEST_MAX, 600)),
});

// Concurrent agent-running requests (/chat, /chat/stream, agent-run actions)
// one tenant may have in flight in this process. 0 (the default) = no cap.
export const getTenantMaxConcurrentRuns = () =>
  Math.floor(toNonNegativeNumber(process.env.TENANT_MAX_CONCURRENT_RUNS, 0));

// TRUST_PROXY, handed to Express's `trust proxy` so req.ip (and with it the
// per-IP limiter and the per-tenant limiter's IP key) is the client behind a
// reverse proxy. Unset or empty: undefined, Express's default (no proxy is
// trusted, req.ip is the socket peer). Accepted: true / false (any case), a
// number of hops (a non-negative integer), or a comma-separated list of
// addresses, CIDR ranges (address/prefix, or an IPv4 address with a
// contiguous netmask) and the names loopback, linklocal and uniquelocal (any
// case; handed on in lower case). Anything else throws
// TRUST_PROXY_INVALID, which refuses the start (createApp reads it first).
// `true` trusts every hop: the left-most X-Forwarded-For entry, which a
// client can write itself, becomes req.ip. Prefer a hop count or a list.
const TRUST_PROXY_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);

const isContiguousIpv4Netmask = (netmask) => {
  const value =
    netmask
      .split(".")
      .reduce((total, octet) => total * 256 + Number(octet), 0) >>> 0;
  const inverted = ~value >>> 0;

  // The host bits are a run of ones at the bottom: inverted + 1 is a power of two.
  return (inverted & (inverted + 1)) === 0;
};

const isTrustProxyListEntry = (entry) => {
  if (TRUST_PROXY_PRESETS.has(entry)) {
    return true;
  }

  const slash = entry.indexOf("/");

  if (slash === -1) {
    return isIP(entry) !== 0;
  }

  const address = entry.slice(0, slash);
  const range = entry.slice(slash + 1);
  const family = isIP(address);

  if (family === 0) {
    return false;
  }

  if (/^\d{1,3}$/u.test(range)) {
    return Number(range) <= (family === 4 ? 32 : 128);
  }

  // An IPv4 netmask (255.255.255.0) is accepted for an IPv4 address only, and
  // only a contiguous one (Express refuses 255.0.255.0).
  return family === 4 && isIP(range) === 4 && isContiguousIpv4Netmask(range);
};

export const getTrustProxySetting = () => {
  const rawValue = String(process.env.TRUST_PROXY ?? "").trim();

  if (!rawValue) {
    return undefined;
  }

  const lowered = rawValue.toLowerCase();

  if (lowered === "true") {
    return true;
  }

  if (lowered === "false") {
    return false;
  }

  if (/^\d+$/u.test(rawValue) && Number.isSafeInteger(Number(rawValue))) {
    return Number(rawValue);
  }

  // The preset names are matched case-insensitively and handed to Express in
  // lower case, the only spelling it knows.
  const entries = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => (TRUST_PROXY_PRESETS.has(entry.toLowerCase()) ? entry.toLowerCase() : entry));
  const invalid = entries.filter((entry) => !entry || !isTrustProxyListEntry(entry));

  if (invalid.length > 0) {
    const error = new Error(
      `TRUST_PROXY must be true, false, a number of hops, or a comma-separated list of addresses, CIDR ranges, loopback, linklocal or uniquelocal; ${invalid.length} entr${
        invalid.length === 1 ? "y is" : "ies are"
      } not (${invalid.map((entry) => JSON.stringify(entry)).join(", ")}).`
    );

    error.code = "TRUST_PROXY_INVALID";
    throw error;
  }

  return entries;
};
// --- End per-tenant HTTP limits ----------------------------------------------

// What deleting a document also removes elsewhere (rag/document-deletion-
// cascade.js). Always: its queued, retry-waiting and dead-lettered ingest jobs
// and its chunks in every live index version table. Opt-in with
// DOCUMENT_DELETE_REDACTION=on (also true, 1, yes; anything else is off): the
// copies of its text in the deleting tenant's settled agent runs, workspace
// artifacts and answer feedback are replaced with a marker, ids kept.
export const isDocumentDeleteRedactionEnabled = () =>
  ["1", "true", "on", "yes"].includes(
    String(process.env.DOCUMENT_DELETE_REDACTION ?? "").trim().toLowerCase()
  );

// The document trash (migration 042, rag/document-trash.js). 0 (the default)
// keeps DELETE /documents/:docId and POST /documents/clear an immediate hard
// delete. Above 0 they move documents into the trash instead: out of search
// and every listing at once, bytes kept, restorable with POST
// /documents/:docId/restore, and purged by the retention sweep once they have
// been there this many whole hours. Needs VECTOR_STORE_PROVIDER=pgvector with
// the PostgreSQL document registry; anything else refuses the start
// (DOCUMENT_TRASH_UNSUPPORTED). At most ten years.
export const MAX_DOCUMENT_TRASH_RETENTION_HOURS = 87_600;

export const getDocumentTrashRetentionHours = () =>
  Math.min(
    Math.floor(toNonNegativeNumber(process.env.DOCUMENT_TRASH_RETENTION_HOURS, 0)),
    MAX_DOCUMENT_TRASH_RETENTION_HOURS
  );

export const isDocumentTrashEnabled = () => getDocumentTrashRetentionHours() > 0;

// Succeeded and failed jobs (their bytes are already gone) are deleted by the
// workers' housekeeping once they are this old. 0 keeps them forever.
export const getRagIngestJobRetentionMs = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_INGEST_JOB_RETENTION_MS, 7 * 24 * 60 * 60 * 1000)
  );

export const getIngestJobsPostgresTable = () =>
  (process.env.INGEST_JOBS_POSTGRES_TABLE || "rag_ingest_jobs").trim();

// Deliberately no "auto" and defaulting to postgres, unlike the task/agent-run
// providers. The document registry store is *injected*
// (configureDocumentRegistryStore), not selected by config, so there is nothing
// to auto-detect -- and a health check that guessed "filesystem" from the absence
// of a database URL would report a backend that nothing had actually installed.
// Only server/standalone-profile.js sets this, and it sets it alongside injecting
// the matching store, so the two cannot disagree.
export const getDocumentStoreProvider = () =>
  toChoice(process.env.DOCUMENT_STORE_PROVIDER, "postgres", [
    "filesystem",
    "postgres",
  ]);

export const getSessionMemoryPostgresTable = () =>
  (process.env.SESSION_MEMORY_POSTGRES_TABLE || "rag_session_memory").trim();

export const getSessionMemoryStoreProvider = () =>
  toChoice(process.env.SESSION_MEMORY_STORE_PROVIDER, "postgres", [
    "memory",
    "postgres",
  ]);

export const getTaskStoreProvider = () =>
  toChoice(process.env.TASK_STORE_PROVIDER, "auto", [
    "auto",
    "memory",
    "postgres",
  ]);

export const getTasksPostgresTable = () =>
  (process.env.TASKS_POSTGRES_TABLE || "rag_tasks").trim();

export const getTaskEventsPostgresTable = () =>
  (process.env.TASK_EVENTS_POSTGRES_TABLE || "rag_task_events").trim();

export const getWorkspaceArtifactStoreProvider = () =>
  toChoice(process.env.WORKSPACE_ARTIFACT_STORE_PROVIDER, "auto", [
    "auto",
    "memory",
    "postgres",
  ]);

export const getWorkspaceArtifactStoreConfigStatus = ({
  postgresConfigured = isPostgresDatabaseConfigured(),
  provider = getWorkspaceArtifactStoreProvider(),
} = {}) => {
  const backend =
    provider === "postgres" || (provider === "auto" && postgresConfigured)
      ? "postgres"
      : "memory";

  return {
    backend,
    persistent: backend === "postgres",
    postgresConfigured,
    provider,
    reason:
      provider === "postgres"
        ? "env_postgres"
        : provider === "memory"
          ? "env_memory"
          : postgresConfigured
            ? "postgres_configured_default"
            : "postgres_not_configured",
  };
};

export const getWorkspaceArtifactsPostgresTable = () =>
  (
    process.env.WORKSPACE_ARTIFACTS_POSTGRES_TABLE ||
    "rag_workspace_artifacts"
  ).trim();

export const getAgentRunStoreProvider = () =>
  toChoice(process.env.AGENT_RUN_STORE_PROVIDER, "auto", [
    "auto",
    "memory",
    "postgres",
  ]);

export const getAgentRunStoreConfigStatus = ({
  provider = getAgentRunStoreProvider(),
} = {}) => {
  const postgresConfigured = isPostgresDatabaseConfigured();
  const backend =
    provider === "postgres" || (provider === "auto" && postgresConfigured)
      ? "postgres"
      : "memory";

  return {
    backend,
    persistent: backend === "postgres",
    postgresConfigured,
    provider,
    reason:
      provider === "postgres"
        ? "env_postgres"
        : provider === "memory"
          ? "env_memory"
          : postgresConfigured
            ? "postgres_configured_default"
            : "postgres_not_configured",
  };
};

const getDefaultAgentRunRecoveryMode = () =>
  getAgentRunStoreConfigStatus().persistent ? "auto" : "manual";

export const getAgentRunRecoveryModeConfigStatus = () => {
  const explicit = hasEnvValue(process.env.AGENT_RUN_RECOVERY_MODE);
  const defaultMode = getDefaultAgentRunRecoveryMode();
  const mode = toChoice(
    process.env.AGENT_RUN_RECOVERY_MODE,
    defaultMode,
    ["auto", "manual", "off"]
  );

  return {
    agentRunStore: getAgentRunStoreConfigStatus(),
    defaultMode,
    explicit,
    mode,
    reason: explicit
      ? "env_configured"
      : mode === "auto"
        ? "postgres_agent_run_store_default"
        : "non_persistent_agent_run_store_default",
  };
};

export const getAgentRunRecoveryMode = () =>
  getAgentRunRecoveryModeConfigStatus().mode;

export const getAgentRunsPostgresTable = () =>
  (process.env.AGENT_RUNS_POSTGRES_TABLE || "rag_agent_runs").trim();

export const getAgentRunEventsPostgresTable = () =>
  (process.env.AGENT_RUN_EVENTS_POSTGRES_TABLE || "rag_agent_run_events").trim();

export const getAdminAuditStoreProvider = () =>
  toChoice(process.env.ADMIN_AUDIT_STORE_PROVIDER, "auto", [
    "auto",
    "memory",
    "postgres",
  ]);

export const getAdminAuditStoreConfigStatus = ({
  provider = getAdminAuditStoreProvider(),
} = {}) => {
  const postgresConfigured = isPostgresDatabaseConfigured();
  const backend =
    provider === "postgres" || (provider === "auto" && postgresConfigured)
      ? "postgres"
      : "memory";

  return {
    backend,
    persistent: backend === "postgres",
    postgresConfigured,
    provider,
    reason:
      provider === "postgres"
        ? "env_postgres"
        : provider === "memory"
          ? "env_memory"
          : postgresConfigured
            ? "postgres_configured_default"
            : "postgres_not_configured",
  };
};

export const getAdminAuditEventsPostgresTable = () =>
  (process.env.ADMIN_AUDIT_EVENTS_POSTGRES_TABLE || "rag_admin_audit_events").trim();

export const getAdminAuditRetentionDays = () =>
  Math.floor(toNonNegativeNumber(process.env.ADMIN_AUDIT_RETENTION_DAYS, 90));

// Data-plane audit events (rag/data-access-audit.js): document download,
// delete, clear and replace, memory and session clears, and a platform admin's
// cross-tenant reads, recorded with ids and counts only. Off by default; on,
// documents clear and document delete refuse (503 AUDIT_UNAVAILABLE) when
// their audit record cannot be written.
export const isAdminAuditDataEventsEnabled = () =>
  toBoolean(process.env.ADMIN_AUDIT_DATA_EVENTS, false);

// Retention of the other data types (rag/retention.js). Whole days, fractions
// rounded down; 0 (the default, and any value below 1) keeps the data forever,
// so nothing is ever deleted unless an operator sets one. Each type is swept
// only by the process that hosts it: agent runs and tasks by the agent tier,
// feedback and archived workspace artifacts by the API tier, the RAG
// observability files by both.
//
//   AGENT_RUN_RETENTION_DAYS           finished runs (completed, failed,
//                                      canceled), with their events and
//                                      approval snapshots, by last update
//   TASK_RETENTION_DAYS                finished tasks and their events, by
//                                      last update
//   WORKSPACE_ARTIFACT_RETENTION_DAYS  archived artifacts only, by archive time
//   FEEDBACK_RETENTION_DAYS            answer feedback in PostgreSQL, by
//                                      creation time
//   RAG_OBSERVABILITY_RETENTION_DAYS   rotated RAG observability JSONL segments
//   TENANT_USAGE_RETENTION_DAYS        usage ledger rows (refused_* included),
//                                      by the start of their hour; API tier
const readRetentionDays = (rawValue) => Math.floor(toNonNegativeNumber(rawValue, 0));

export const getAgentRunRetentionDays = () =>
  readRetentionDays(process.env.AGENT_RUN_RETENTION_DAYS);

export const getTaskRetentionDays = () => readRetentionDays(process.env.TASK_RETENTION_DAYS);

export const getWorkspaceArtifactRetentionDays = () =>
  readRetentionDays(process.env.WORKSPACE_ARTIFACT_RETENTION_DAYS);

export const getFeedbackRetentionDays = () => readRetentionDays(process.env.FEEDBACK_RETENTION_DAYS);

export const getRagObservabilityRetentionDays = () =>
  readRetentionDays(process.env.RAG_OBSERVABILITY_RETENTION_DAYS);

export const getTenantUsageRetentionDays = () =>
  readRetentionDays(process.env.TENANT_USAGE_RETENTION_DAYS);

// How often the retention sweep runs (the first sweep runs a minute after
// start-up, or after one interval when that is shorter). 0 turns the
// periodic sweep off. Capped like the upload session sweep.
export const getRetentionSweepIntervalMs = () =>
  Math.min(
    Math.floor(toNonNegativeNumber(process.env.RETENTION_SWEEP_INTERVAL_MS, 60 * 60 * 1000)),
    MAX_TIMER_DELAY_MS
  );

// Rows one retention statement deletes at most; a sweep repeats the
// statement until a batch comes back short.
export const getRetentionSweepBatchSize = () =>
  Math.min(Math.floor(toPositiveNumber(process.env.RETENTION_SWEEP_BATCH_SIZE, 500)), 10_000) || 500;

// Answer feedback (POST /feedback). Deliberately no provider setting: with a
// database the records live in PostgreSQL under row-level security (migration
// 034), and the JSONL file serves only the profile without one, so no setting
// can put a multi-tenant deployment back on one file every tenant shares.
export const getFeedbackStoreConfigStatus = ({
  postgresConfigured = isPostgresDatabaseConfigured(),
} = {}) => ({
  backend: postgresConfigured ? "postgres" : "file",
  persistent: true,
  postgresConfigured,
  reason: postgresConfigured ? "postgres_configured_default" : "postgres_not_configured",
});

export const getFeedbackPostgresTable = () =>
  (process.env.FEEDBACK_POSTGRES_TABLE || "rag_feedback").trim();

// Tenant registry (migration 036, rag/tenant-registry.js): the workspaces a
// deployment knows and who belongs to each. Like feedback, no provider
// setting: PostgreSQL whenever a database is configured, an in-process store
// otherwise.
export const getWorkspacesPostgresTable = () =>
  (process.env.WORKSPACES_POSTGRES_TABLE || "rag_workspaces").trim();

export const getWorkspaceMembersPostgresTable = () =>
  (process.env.WORKSPACE_MEMBERS_POSTGRES_TABLE || "rag_workspace_members").trim();

export const getTenantRegistryStoreConfigStatus = ({
  postgresConfigured = isPostgresDatabaseConfigured(),
} = {}) => ({
  backend: postgresConfigured ? "postgres" : "memory",
  persistent: postgresConfigured,
  postgresConfigured,
  reason: postgresConfigured ? "postgres_configured_default" : "postgres_not_configured",
});

// TENANT_MEMBERSHIP=enforce makes requireApiAuth refuse (403) an
// authenticated request whose resolved workspace is not registered, not
// active, or (when the scope names a user) has no membership for that user,
// and merges the membership's roles into the scope's workspaceRoles. `off`
// (default) changes nothing: the registry is then read only by the admin
// routes. An unknown value refuses the start, never falls back to off.
export const TENANT_MEMBERSHIP_MODES = Object.freeze(["off", "enforce"]);

export const getTenantMembershipMode = () => {
  const rawValue = process.env.TENANT_MEMBERSHIP;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "off";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!TENANT_MEMBERSHIP_MODES.includes(normalizedValue)) {
    const error = new Error(
      `TENANT_MEMBERSHIP must be one of ${TENANT_MEMBERSHIP_MODES.join(", ")}. Received "${rawValue}".`
    );

    error.code = "TENANT_MEMBERSHIP_MODE_INVALID";
    error.status = 500;
    throw error;
  }

  return normalizedValue;
};

export const isTenantMembershipEnforced = () => getTenantMembershipMode() === "enforce";

// How long one process keeps a workspace or membership lookup (found or not).
// A write through this process's registry service drops the entries it
// touches at once; other processes see it after at most this long. 0 turns
// the cache off.
export const getTenantRegistryCacheTtlMs = () =>
  Math.floor(toNonNegativeNumber(process.env.TENANT_REGISTRY_CACHE_TTL_MS, 5000));

// TENANT_REGISTRY_CACHE_SCOPE (rag/tenant-registry.js): `shared` (default)
// caches a workspace lookup once for every caller; `tenant` caches it per
// requesting user, so an authenticated non-member probing a workspace id
// neither hits nor joins a lookup another principal's request left (a hit is
// faster than a database read, and told the prober that the workspace had a
// request within the TTL). Membership lookups are per (workspace, user) under
// both. A sibling of RAG_EMBEDDING_CACHE_SCOPE; an unknown value refuses the
// start.
export const TENANT_REGISTRY_CACHE_SCOPES = Object.freeze(["shared", "tenant"]);

export const getTenantRegistryCacheScope = () => {
  const rawValue = process.env.TENANT_REGISTRY_CACHE_SCOPE;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "shared";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!TENANT_REGISTRY_CACHE_SCOPES.includes(normalizedValue)) {
    const error = new Error(
      `TENANT_REGISTRY_CACHE_SCOPE must be one of ${TENANT_REGISTRY_CACHE_SCOPES.join(", ")}. Received "${rawValue}".`
    );

    error.code = "TENANT_REGISTRY_CACHE_SCOPE_INVALID";
    error.status = 500;
    throw error;
  }

  return normalizedValue;
};

export const isApiAuthEnabled = () =>
  toBoolean(process.env.API_AUTH_ENABLED, false);

export const getApiAuthToken = () => process.env.API_AUTH_TOKEN || "";

export const getApiAuthTokens = () => process.env.API_AUTH_TOKENS || "";

export const isApiAuthJwtEnabled = () =>
  toBoolean(process.env.API_AUTH_JWT_ENABLED, false);

export const getApiAuthJwtSecret = () =>
  process.env.API_AUTH_JWT_HS256_SECRET || process.env.API_AUTH_JWT_SECRET || "";

export const getApiAuthJwtIssuer = () =>
  (process.env.API_AUTH_JWT_ISSUER || "").trim();

export const getApiAuthJwtAudience = () =>
  (process.env.API_AUTH_JWT_AUDIENCE || "").trim();

export const getApiAuthJwtUserClaim = () =>
  (process.env.API_AUTH_JWT_USER_CLAIM || "sub").trim();

export const getApiAuthJwtWorkspaceClaim = () =>
  (process.env.API_AUTH_JWT_WORKSPACE_CLAIM || "workspace_id").trim();

export const getApiAuthJwtWorkspacesClaim = () =>
  (process.env.API_AUTH_JWT_WORKSPACES_CLAIM || "workspaces").trim();

export const getApiAuthJwtRolesClaim = () =>
  (process.env.API_AUTH_JWT_ROLES_CLAIM || "roles").trim();

export const getApiAuthJwtPermissionsClaim = () =>
  (process.env.API_AUTH_JWT_PERMISSIONS_CLAIM || "permissions").trim();

export const getApiAuthRevokedTokenHashes = () =>
  (process.env.API_AUTH_REVOKED_TOKEN_HASHES || "").trim();

export const getApiAuthRevokedJtis = () =>
  (process.env.API_AUTH_REVOKED_JTIS || "").trim();

export const isApiAuthWorkspaceRequired = () =>
  toBoolean(process.env.API_AUTH_REQUIRE_WORKSPACE, false);

export const getApiAuthConfigStatus = () => {
  const enabled = isApiAuthEnabled();
  const jwtEnabled = isApiAuthJwtEnabled();
  const jwtSecretConfigured = Boolean(getApiAuthJwtSecret().trim());
  const staticTokenConfigured = Boolean(
    getApiAuthToken().trim() || getApiAuthTokens().trim()
  );
  // OIDC (end of file) adds fields only when API_AUTH_OIDC_ENABLED is on, so
  // the report keeps its shape for every existing configuration.
  const oidc = getApiAuthOidcConfigStatus();
  const status = !enabled
    ? "disabled"
    : (jwtEnabled && !jwtSecretConfigured) || oidc.status === "error"
      ? "error"
      : staticTokenConfigured ||
          (jwtEnabled && jwtSecretConfigured) ||
          oidc.status === "ok"
        ? "ok"
        : "error";

  return {
    enabled,
    jwtEnabled,
    jwtSecretConfigured,
    staticTokenConfigured,
    workspaceRequired: isApiAuthWorkspaceRequired(),
    modes: [
      ...(staticTokenConfigured ? ["static_token"] : []),
      ...(jwtEnabled ? ["jwt"] : []),
      ...(oidc.enabled ? ["oidc"] : []),
    ],
    ...(oidc.enabled
      ? {
          oidcEnabled: true,
          oidcIssuerConfigured: oidc.issuerConfigured,
          oidcAudienceConfigured: oidc.audienceConfigured,
        }
      : {}),
    status,
  };
};

export const isStartupHealthStrict = () =>
  toBoolean(process.env.STARTUP_HEALTH_STRICT, false);

// ---------------------------------------------------------------------------
// DATA track: pgvector index versions
// (rag/vector-store-pgvector-versions.js, rag/vector-store-pgvector-version-builder.js,
// vector-index.mjs). Nothing above this line belongs to this block.
// ---------------------------------------------------------------------------

// The versions registry (migration 016). Its pointer and build-progress tables
// are derived from this name (`<name>_pointer`, `<name>_build_progress`).
export const getIndexVersionsPostgresTable = () =>
  (process.env.INDEX_VERSIONS_POSTGRES_TABLE || "rag_index_versions").trim();

// How long an API process trusts the active-version pointer it read. A switch
// is picked up by every instance within this time without a restart; the old
// version keeps receiving every write for the dual-write grace period, so a
// search on a pointer read just before the switch still sees a complete index.
export const getIndexVersionPointerTtlMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_POINTER_TTL_MS, 2000)) || 2000;

// After an activation the previous version keeps receiving every ingest,
// delete and clear for this long, so a rollback inside the window loses
// nothing. The versions module never lets it drop below twice the pointer TTL.
export const getIndexVersionDualWriteGraceMs = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS, 24 * 60 * 60 * 1000)
  );

// A builder renews its lease with every document it writes; another builder
// may take over a building version only once the lease has expired.
export const getIndexVersionBuildLeaseMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_BUILD_LEASE_MS, 60000)) || 60000;

// Documents a builder reads, embeds and writes per batch.
export const getIndexVersionBuildBatchSize = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_BUILD_BATCH_SIZE, 16)) || 16;

// Documents a builder has in flight at once (read, parsed, embedded through
// the cross-document embedding batcher, written). Each is still written in its
// own transaction with its progress row, fenced on the same lease.
export const getIndexVersionBuildConcurrency = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_BUILD_CONCURRENCY, 4)) || 4;

// The per-process query embedding cache (rag/embedding-cache.js). Entries are
// keyed by embedding space and text, so a process serving an index version
// pinned to another model than its configuration caches that version's query
// vectors in the same cache, under the same size bound.
export const isQueryEmbeddingCacheEnabled = () =>
  !["0", "false", "no", "off"].includes(String(process.env.RAG_EMBEDDING_CACHE_ENABLED ?? "").trim().toLowerCase());

export const getQueryEmbeddingCacheMaxEntries = () =>
  Math.floor(toPositiveNumber(process.env.RAG_EMBEDDING_CACHE_MAX, 256)) || 256;

export const getQueryEmbeddingCacheTtlMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_EMBEDDING_CACHE_TTL_MS, 10 * 60 * 1000)) || 10 * 60 * 1000;

// RAG_EMBEDDING_CACHE_SCOPE: `shared` (default) lets every tenant of the
// process hit a vector another tenant's identical query left in the cache;
// `tenant` partitions the cached vectors the way flights already are (the
// tenant pair, or the non-tenant context), so a hit no longer tells a tenant
// that some other tenant recently asked the same text. An unknown value
// refuses the start and fails every cached embedding, never falls back.
export const QUERY_EMBEDDING_CACHE_SCOPES = Object.freeze(["shared", "tenant"]);

export const getQueryEmbeddingCacheScope = () => {
  const rawValue = process.env.RAG_EMBEDDING_CACHE_SCOPE;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "shared";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!QUERY_EMBEDDING_CACHE_SCOPES.includes(normalizedValue)) {
    const error = new Error(
      `RAG_EMBEDDING_CACHE_SCOPE must be one of ${QUERY_EMBEDDING_CACHE_SCOPES.join(", ")}. Received "${rawValue}".`
    );

    error.code = "RAG_EMBEDDING_CACHE_SCOPE_INVALID";
    error.status = 500;
    throw error;
  }

  return normalizedValue;
};

// ---------------------------------------------------------------------------
// ADAPTER track: query-side linear embedding adapter (rag/query-adapter.js).
// ---------------------------------------------------------------------------

// Path of a trained adapter file (evaluation/train-query-adapter.py); a
// relative path resolves against the working directory. Empty, "off", "none"
// or "false" (the default) leaves query vectors exactly as the model returns
// them. It is applied only where it was measured: single-document QA
// retrieval on the hybrid route, for a query the embedding model embedded in
// the space the file was trained in (rag/query-adapter.js). Anything else
// searches unadapted; checks.queryAdapter reports an unreadable file as an
// error and a space or route it would never apply to as a warning. The file
// must be readable by the server process: evaluation/generated/ is neither
// committed nor copied into the Docker image, so mount or copy it there.
export const getEmbeddingQueryAdapterPath = () => {
  const value = String(process.env.RAG_EMBEDDING_QUERY_ADAPTER ?? "").trim();

  return ["", "0", "false", "no", "off", "none"].includes(value.toLowerCase()) ? "" : value;
};

// Retire drops a version table whose foreign key points at the documents
// table, which needs an AccessExclusiveLock on documents; while that request
// waits, every new reader of documents waits behind it. Each drop attempt
// therefore waits at most RAG_INDEX_VERSION_RETIRE_LOCK_TIMEOUT_MS for the
// lock, and retire makes up to RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS of them,
// RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS apart (jittered), before it reports
// the drop as pending.
export const getIndexVersionRetireLockTimeoutMs = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_RETIRE_LOCK_TIMEOUT_MS, 200)) || 200;

export const getIndexVersionRetireDropAttempts = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS, 25)) || 25;

export const getIndexVersionRetireRetryDelayMs = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS, 400));

// The task prefixes and the known width of an arbitrary model, for a version
// built under another model than the configured one. The environment overrides
// (RAG_EMBEDDING_*_PREFIX, RAG_EMBEDDING_DIMENSIONS) describe the configured
// model only, so they do not apply here.
export const getEmbeddingTaskPrefixesForModel = (model) => {
  const entry = EMBEDDING_TASK_PREFIXES.find((candidate) => candidate.pattern.test(String(model ?? "")));

  return { document: entry?.document ?? "", query: entry?.query ?? "" };
};

export const getKnownEmbeddingDimensionsForModel = (model) =>
  KNOWN_EMBEDDING_DIMENSIONS[String(model ?? "")] ?? null;

// The same identity rule as getEmbeddingIndexIdentity, for any model/prefix.
export const buildEmbeddingIndexIdentity = ({ model, documentPrefix = "" } = {}) => {
  const prefix = String(documentPrefix ?? "").trim();
  const modelName = String(model ?? "").trim();

  return prefix ? `${modelName}#${prefix}` : modelName;
};

// ---------------------------------------------------------------------------
// DATA track: staged ingestion pipeline
// (rag/ingest-pipeline.js, rag/ingest-embedding-batcher.js,
// rag/ingest-job-store.js, rag/ingest-worker.js, ingest-jobs.mjs).
// ---------------------------------------------------------------------------

// The stages an async ingest job runs, in order. Each stage persists its
// output before the next one starts, so a retry resumes where it failed.
export const RAG_INGEST_STAGES = Object.freeze(["parse", "chunk", "embed", "index"]);

// Default retry backoff of every stage (the one-step job's backoff before the
// pipeline was staged).
const INGEST_STAGE_RETRY_BASE_MS = 5000;
const INGEST_STAGE_RETRY_MAX_MS = 5 * 60 * 1000;

const readIngestStageSetting = (stage, suffix) =>
  process.env[`RAG_INGEST_${String(stage).toUpperCase()}_${suffix}`];

/**
 * Attempts and backoff of one stage. RAG_INGEST_<STAGE>_MAX_ATTEMPTS,
 * RAG_INGEST_<STAGE>_RETRY_BASE_MS and RAG_INGEST_<STAGE>_RETRY_MAX_MS
 * (STAGE = PARSE, CHUNK, EMBED or INDEX) override the defaults, which are the
 * job's RAG_INGEST_JOB_MAX_ATTEMPTS and the 5 s doubling backoff up to 5 min
 * every job had before. A stage that exhausts its attempts moves the job to
 * dead_letter.
 */
export const getRagIngestStageRetryPolicy = (stage) => {
  const maxAttempts =
    Math.floor(
      toPositiveNumber(readIngestStageSetting(stage, "MAX_ATTEMPTS"), getRagIngestJobMaxAttempts())
    ) || getRagIngestJobMaxAttempts();
  const baseDelayMs = Math.floor(
    toNonNegativeNumber(readIngestStageSetting(stage, "RETRY_BASE_MS"), INGEST_STAGE_RETRY_BASE_MS)
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    Math.floor(
      toNonNegativeNumber(readIngestStageSetting(stage, "RETRY_MAX_MS"), INGEST_STAGE_RETRY_MAX_MS)
    )
  );

  return { baseDelayMs, maxAttempts, maxDelayMs };
};

// Largest serialized output (parsed pages, chunks, embeddings) one stage may
// persist. A document whose output is larger fails with a 413 instead of
// filling the jobs table; 0 disables the bound.
export const getRagIngestStageOutputMaxBytes = () =>
  Math.floor(
    toNonNegativeNumber(process.env.RAG_INGEST_STAGE_OUTPUT_MAX_BYTES, 64 * 1024 * 1024)
  );

// Cross-document embedding batcher: embed-stage work of concurrent jobs in one
// process goes out as one embeddings request of at most this many inputs and
// (estimated) tokens, after waiting at most the linger window for more work.
// 512 inputs is also the request size of rag/openai-client.js.
export const getRagIngestEmbedBatchMaxItems = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_EMBED_BATCH_MAX_ITEMS, 512)) || 512;

export const getRagIngestEmbedBatchMaxTokens = () =>
  Math.floor(toPositiveNumber(process.env.RAG_INGEST_EMBED_BATCH_MAX_TOKENS, 240000)) || 240000;

export const getRagIngestEmbedBatchLingerMs = () =>
  Math.floor(toNonNegativeNumber(process.env.RAG_INGEST_EMBED_BATCH_LINGER_MS, 25));

// RAG_INGEST_EMBED_BATCHING=false bypasses that batcher: each job's embed
// stage sends its own chunks as one request per embedding space, as a
// synchronous upload does. On by default; the switch exists so the batcher's
// effect can be measured against the unbatched path and turned off if a
// provider misbehaves on large mixed batches.
export const isRagIngestEmbedBatchingEnabled = () =>
  toBoolean(process.env.RAG_INGEST_EMBED_BATCHING, true);

// Identical bytes uploaded again by the same tenant (same owner and workspace)
// return the existing document instead of ingesting a copy. On by default;
// RAG_INGEST_DEDUP=false ingests every upload.
export const isRagIngestDedupEnabled = () => toBoolean(process.env.RAG_INGEST_DEDUP, true);

// Where each job's stage outputs live (migration 017): `<jobs table>_outputs`.
export const getIngestJobOutputsPostgresTable = () => `${getIngestJobsPostgresTable()}_outputs`;

// --- Model gateway (ARCHIVE_RAG_ROLE=model-gateway; rag/model-gateway/) ------
// Read by the gateway process, except MODEL_GATEWAY_TIMEOUT_MS, which is the
// caller's budget for one model call through the gateway.

// Port of `node model-gateway.mjs`: MODEL_GATEWAY_PORT, then PORT, then 5003.
// 0 asks the OS for a free port, as PORT=0 does for the other roles
// (role-server.js resolveRolePort); an empty or invalid value is skipped.
const toListenPort = (rawValue) => {
  const parsed = Number.parseInt(String(rawValue ?? "").trim(), 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

export const getModelGatewayPort = () =>
  toListenPort(process.env.MODEL_GATEWAY_PORT) ?? toListenPort(process.env.PORT) ?? 5003;

// Whole budget of one call through the gateway, its retries, backoff and
// failover included; sent to the gateway as the call's deadline. The default
// covers the four tries of the default 120 s request timeout plus backoff.
export const getModelGatewayTimeoutMs = () =>
  Math.floor(toPositiveNumber(process.env.MODEL_GATEWAY_TIMEOUT_MS, 600_000));

const getDefaultOpenAIBaseUrl = () =>
  String(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "").trim() ||
  "https://api.openai.com/v1";

// Upstream replicas behind the gateway, comma-separated base URLs (chat and
// embeddings, as OPENAI_BASE_URL) or full endpoints (rerank, as
// RAG_CROSS_ENCODER_ENDPOINT). Unset, each falls back to the single endpoint
// the monolith uses; an empty rerank list means the gateway serves no rerank.
export const getModelGatewayChatUpstreams = () =>
  String(process.env.MODEL_GATEWAY_CHAT_UPSTREAMS ?? "").trim() || getDefaultOpenAIBaseUrl();

export const getModelGatewayEmbeddingUpstreams = () =>
  String(process.env.MODEL_GATEWAY_EMBEDDING_UPSTREAMS ?? "").trim() || getDefaultOpenAIBaseUrl();

export const getModelGatewayRerankUpstreams = () =>
  String(process.env.MODEL_GATEWAY_RERANK_UPSTREAMS ?? "").trim() || getCrossEncoderEndpoint().trim();

// Per-workspace quotas the gateway enforces; 0 (the default) turns one off.
export const getModelGatewayQuotaLimits = () => ({
  dailyTokens: Math.floor(toNonNegativeNumber(process.env.MODEL_GATEWAY_QUOTA_DAILY_TOKENS, 0)),
  requestsPerMinute: Math.floor(
    toNonNegativeNumber(process.env.MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE, 0)
  ),
  tokensPerMinute: Math.floor(
    toNonNegativeNumber(process.env.MODEL_GATEWAY_QUOTA_TOKENS_PER_MINUTE, 0)
  ),
});

// The same per-workspace limits, enforced in this process for the model calls
// it sends itself (rag/model-call-quota.js): a monolith, or a tier that calls
// models without MODEL_GATEWAY_URL. Off by default; a call that goes to the
// model gateway is admitted there instead, never twice.
export const isModelQuotaEnabled = () => toBoolean(process.env.MODEL_QUOTA_ENABLED, false);
// --- End model gateway -------------------------------------------------------

// --- ROLES track: split-deployment edge and agent tier ----------------------
// (rag/agent-service/, server.js; the topology itself is rag/service-topology.js).
// Nothing outside this block belongs to it.

const readRoleSettingMs = (rawValue, fallbackValue, { max, min }) => {
  if (!String(rawValue ?? "").trim()) {
    return fallbackValue;
  }

  const parsedValue = Number(rawValue);

  return Number.isFinite(parsedValue)
    ? Math.min(max, Math.max(min, Math.floor(parsedValue)))
    : fallbackValue;
};

// How long the public edge waits for the agent tier to answer one forwarded
// request (/chat, a task or run action, an admin action), and how long a
// forwarded /chat/stream may run in total. Agent runs call models in loops, so
// this is longer than the INTERNAL_SERVICE_TIMEOUT_MS default the service
// client uses for everything else (which still bounds the wait for a stream's
// headers). The run itself is not cancelled when the edge gives up.
export const getAgentServiceTimeoutMs = () =>
  readRoleSettingMs(process.env.AGENT_SERVICE_TIMEOUT_MS, 300_000, {
    max: 60 * 60 * 1000,
    min: 1000,
  });

// On SIGTERM/SIGINT a split-role process (ARCHIVE_RAG_ROLE other than all)
// stops accepting connections and gives in-flight requests this long to
// finish before it closes what is left and exits. The default stays under the
// 30 s a container orchestrator usually waits before SIGKILL.
export const getServiceShutdownGraceMs = () =>
  readRoleSettingMs(process.env.SERVICE_SHUTDOWN_GRACE_MS, 25_000, {
    max: 10 * 60 * 1000,
    min: 0,
  });
// --- End ROLES track ---------------------------------------------------------

// --- RETRIEVAL track: retrieval tier (retrieval-service.mjs) ----------------
// Bounds the retrieval service enforces on one request (a request past one is
// answered 400 with a stable code before any work), and the budget of one
// remote retrieval call made by a process whose retrieval runs remotely.
// RETRIEVAL_SERVICE_TIMEOUT_MS unset (0) means INTERNAL_SERVICE_TIMEOUT_MS.
export const getRetrievalServiceMaxDocIds = () =>
  Math.floor(toPositiveNumber(process.env.RETRIEVAL_SERVICE_MAX_DOC_IDS, 1000));

export const getRetrievalServiceMaxQueries = () =>
  Math.floor(toPositiveNumber(process.env.RETRIEVAL_SERVICE_MAX_QUERIES, 32));

export const getRetrievalServiceMaxQueryChars = () =>
  Math.floor(toPositiveNumber(process.env.RETRIEVAL_SERVICE_MAX_QUERY_CHARS, 32000));

export const getRetrievalServiceMaxTopK = () =>
  Math.floor(toPositiveNumber(process.env.RETRIEVAL_SERVICE_MAX_TOP_K, 500));

export const getRetrievalServiceTimeoutMs = () =>
  Math.floor(toNonNegativeNumber(process.env.RETRIEVAL_SERVICE_TIMEOUT_MS, 0));
// --- End RETRIEVAL track -----------------------------------------------------

// --- OIDC track: OpenID Connect resource server (rag/oidc.js) ---------------
// API_AUTH_OIDC_ENABLED=true makes requireApiAuth accept access tokens from
// API_AUTH_OIDC_ISSUER (Authorization: Bearer) next to static tokens and HS256
// JWTs. Unset, nothing about authentication changes.
const readOidcText = (rawValue, fallbackValue = "") =>
  (typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : fallbackValue);

export const OIDC_DEFAULT_ALGORITHMS = Object.freeze(["RS256", "PS256", "ES256", "EdDSA"]);

export const isApiAuthOidcEnabled = () =>
  toBoolean(process.env.API_AUTH_OIDC_ENABLED, false);

export const getApiAuthOidcIssuer = () => readOidcText(process.env.API_AUTH_OIDC_ISSUER);

export const getApiAuthOidcAudience = () => readOidcText(process.env.API_AUTH_OIDC_AUDIENCE);

export const getApiAuthOidcClientId = () => readOidcText(process.env.API_AUTH_OIDC_CLIENT_ID);

export const getApiAuthOidcScopes = () =>
  readOidcText(process.env.API_AUTH_OIDC_SCOPES, "openid profile email");

export const getApiAuthOidcAlgorithms = () => {
  const configured = readOidcText(process.env.API_AUTH_OIDC_ALGORITHMS)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return configured.length > 0 ? configured : [...OIDC_DEFAULT_ALGORITHMS];
};

export const getApiAuthOidcClockSkewSec = () =>
  Math.min(600, Math.floor(toNonNegativeNumber(process.env.API_AUTH_OIDC_CLOCK_SKEW_SEC, 60)));

export const getApiAuthOidcJwksTtlMs = () =>
  Math.floor(toPositiveNumber(process.env.API_AUTH_OIDC_JWKS_TTL_MS, 10 * 60 * 1000));

export const getApiAuthOidcJwksMinRefreshMs = () =>
  Math.floor(toNonNegativeNumber(process.env.API_AUTH_OIDC_JWKS_MIN_REFRESH_MS, 30 * 1000));

export const getApiAuthOidcHttpTimeoutMs = () =>
  Math.floor(toPositiveNumber(process.env.API_AUTH_OIDC_HTTP_TIMEOUT_MS, 5000));

export const isApiAuthOidcTypRequired = () =>
  toBoolean(process.env.API_AUTH_OIDC_REQUIRE_TYP, false);

// false: admin.* roles and admin permissions from an OIDC token (the roles and
// permissions claims and API_AUTH_OIDC_GROUP_ROLE_MAP) are dropped, so the
// identity provider can grant workspace roles but no platform role.
export const isApiAuthOidcPlatformRolesAllowed = () =>
  toBoolean(process.env.API_AUTH_OIDC_ALLOW_PLATFORM_ROLES, true);

export const getApiAuthOidcUserClaim = () =>
  readOidcText(process.env.API_AUTH_OIDC_USER_CLAIM, "sub");

export const getApiAuthOidcWorkspaceClaim = () =>
  readOidcText(process.env.API_AUTH_OIDC_WORKSPACE_CLAIM, "workspace_id");

export const getApiAuthOidcWorkspacesClaim = () =>
  readOidcText(process.env.API_AUTH_OIDC_WORKSPACES_CLAIM, "workspaces");

export const getApiAuthOidcRolesClaim = () =>
  readOidcText(process.env.API_AUTH_OIDC_ROLES_CLAIM, "roles");

export const getApiAuthOidcGroupsClaim = () =>
  readOidcText(process.env.API_AUTH_OIDC_GROUPS_CLAIM, "groups");

export const getApiAuthOidcGroupRoleMap = () =>
  readOidcText(process.env.API_AUTH_OIDC_GROUP_ROLE_MAP);

export const getApiAuthOidcPermissionsClaim = () =>
  readOidcText(process.env.API_AUTH_OIDC_PERMISSIONS_CLAIM, "permissions");

export const getApiAuthOidcWorkspaceRolesClaim = () =>
  readOidcText(process.env.API_AUTH_OIDC_WORKSPACE_ROLES_CLAIM, "workspace_roles");

export const getApiAuthOidcConfigStatus = () => {
  const enabled = isApiAuthOidcEnabled();
  const issuerConfigured = Boolean(getApiAuthOidcIssuer());
  const audienceConfigured = Boolean(getApiAuthOidcAudience());

  return {
    enabled,
    issuerConfigured,
    audienceConfigured,
    status: !enabled
      ? "disabled"
      : issuerConfigured && audienceConfigured
        ? "ok"
        : "error",
  };
};
// --- End OIDC track ----------------------------------------------------------

// --- Tenant encryption at rest (tenant isolation phase 5) -------------------
// TENANT_ENCRYPTION=on encrypts tenant file bytes when they are written
// (rag/tenant-encryption.js): the documents' and ingest jobs' file bytes, the
// ingest stage outputs, the upload session chunks, and the working files of
// one request or ingest attempt (rag/working-files.js). Reads recognise both
// forms whatever the setting, so rows written before it (or while it was off)
// stay readable. `off` (default) writes exactly what was written before. An
// unknown value refuses the start, never falls back to off.
export const TENANT_ENCRYPTION_MODES = Object.freeze(["off", "on"]);

export const getTenantEncryptionMode = () => {
  const rawValue = process.env.TENANT_ENCRYPTION;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "off";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!TENANT_ENCRYPTION_MODES.includes(normalizedValue)) {
    const error = new Error(
      `TENANT_ENCRYPTION must be one of ${TENANT_ENCRYPTION_MODES.join(", ")}. Received "${rawValue}".`
    );

    error.code = "TENANT_ENCRYPTION_MODE_INVALID";
    error.status = 500;
    throw error;
  }

  return normalizedValue;
};

export const isTenantEncryptionEnabled = () => getTenantEncryptionMode() === "on";

// The key management provider behind the envelopes (rag/kms/). Only `local`
// exists: demo-grade key files on this machine (rag/kms/local-provider.js).
export const TENANT_KMS_PROVIDERS = Object.freeze(["local"]);

export const getTenantKmsProviderId = () => {
  const rawValue = process.env.TENANT_KMS_PROVIDER;

  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return "local";
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (!TENANT_KMS_PROVIDERS.includes(normalizedValue)) {
    const error = new Error(
      `TENANT_KMS_PROVIDER must be one of ${TENANT_KMS_PROVIDERS.join(", ")}. Received "${rawValue}".`
    );

    error.code = "TENANT_KMS_PROVIDER_INVALID";
    error.status = 500;
    throw error;
  }

  return normalizedValue;
};

// The local provider's paths as configured, or null when unset: the provider
// derives the defaults from the data directory (rag/kms/local-provider.js).
export const getTenantKeystoreDirectorySetting = () =>
  String(process.env.TENANT_KEYSTORE_DIR ?? "").trim() || null;

export const getTenantKmsMasterKeyFileSetting = () =>
  String(process.env.TENANT_KMS_MASTER_KEY_FILE ?? "").trim() || null;
